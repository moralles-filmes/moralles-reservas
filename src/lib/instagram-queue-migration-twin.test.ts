import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  INBOUND_LEASE_TTL_MS,
  INBOUND_SWEEP_INTERVAL_MS,
  PURGE_DEAD_AFTER_DAYS,
  PURGE_DONE_AFTER_DAYS,
} from "../../supabase/functions/_shared/whatsapp-inbound-queue-core";

// Gêmeos declarados: SQL não importa TypeScript. Este teste é o único ponto
// que amarra a fila de inbound do Instagram às constantes do núcleo da fila
// do WhatsApp, que o worker do Instagram (Task 4.1) reusa.
//
// TODO(4.1): a Task 4.1 cria `INSTAGRAM_PROCESSED_RETENTION_DAYS = 30` no
// núcleo do Instagram; troque este literal pelo import.
const INSTAGRAM_PROCESSED_RETENTION_DAYS = 30;

const MIGRATIONS = resolve(__dirname, "../../supabase/migrations");
const ARQUIVO = readdirSync(MIGRATIONS).find((f) => /^\d{14}_instagram_inbound_queue\.sql$/.test(f));
const SQL = ARQUIVO ? readFileSync(resolve(MIGRATIONS, ARQUIVO), "utf8") : "";

function semComentarios(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/**
 * Corpo da função, do `create or replace function public.<nome>(` até o
 * primeiro `$$;` depois dele. Um número que "existe em algum lugar do
 * arquivo" não prova nada sobre a função que o usa.
 */
function corpo(sql: string, nome: string): string {
  const limpo = semComentarios(sql);
  const inicio = limpo.indexOf(`create or replace function public.${nome}(`);
  if (inicio === -1) throw new Error(`função ${nome} não encontrada`);
  const fim = limpo.indexOf("$$;", inicio);
  if (fim === -1) throw new Error(`fim do corpo de ${nome} ($$;) não encontrado`);
  return limpo.slice(inicio, fim + 3);
}

/**
 * Segundos de TODO `make_interval(secs => N)` do corpo. Nas duas funções de
 * claim o único intervalo é o lease (no claim da mensagem ele aparece duas
 * vezes: no INSERT e na retomada), então qualquer número divergente reprova.
 */
function leases(body: string): number[] {
  const achados = [...body.matchAll(/make_interval\(\s*secs\s*=>\s*(\d+)\s*\)/gi)];
  return achados.map((m) => Number(m[1]));
}

/** Dias da perna `status = '<status>'` da purga da fila. */
function diasDaPerna(body: string, status: string): number {
  const m = body.match(
    new RegExp(`status\\s*=\\s*'${status}'\\s+and\\s+received_at\\s*<\\s*now\\(\\)\\s*-\\s*interval\\s*'(\\d+) days'`, "i"),
  );
  if (!m) throw new Error(`perna ${status} da purga não encontrada`);
  return Number(m[1]);
}

/** Dias da purga do ledger (`created_at < now() - interval 'N days'`). */
function diasDoLedger(body: string): number {
  const m = body.match(/created_at\s*<\s*now\(\)\s*-\s*interval\s*'(\d+) days'/i);
  if (!m) throw new Error("janela da purga do ledger não encontrada");
  return Number(m[1]);
}

describe("migration da fila do Instagram ⇔ núcleo da fila de inbound", () => {
  it("o arquivo existe e vem depois da 20261021120100 (conta e contato)", () => {
    expect(ARQUIVO).toBeDefined();
    expect(Number(ARQUIVO!.slice(0, 14))).toBeGreaterThan(20261021120100);
  });

  it("o lease do claim do evento é INBOUND_LEASE_TTL_MS/1000", () => {
    const l = leases(corpo(SQL, "claim_instagram_inbound_event"));
    expect(l.length).toBeGreaterThan(0);
    for (const s of l) expect(s).toBe(INBOUND_LEASE_TTL_MS / 1000);
  });

  it("o lease do claim da mensagem é INBOUND_LEASE_TTL_MS/1000 (retomada depois do mesmo lease)", () => {
    const l = leases(corpo(SQL, "claim_instagram_message"));
    expect(l.length).toBeGreaterThan(0);
    for (const s of l) expect(s).toBe(INBOUND_LEASE_TTL_MS / 1000);
  });

  it("a purga da fila usa PURGE_DONE_AFTER_DAYS e PURGE_DEAD_AFTER_DAYS", () => {
    const body = corpo(SQL, "purge_instagram_inbound_events");
    expect(diasDaPerna(body, "done")).toBe(PURGE_DONE_AFTER_DAYS);
    expect(diasDaPerna(body, "dead")).toBe(PURGE_DEAD_AFTER_DAYS);
  });

  it("a purga do ledger usa INSTAGRAM_PROCESSED_RETENTION_DAYS", () => {
    expect(diasDoLedger(corpo(SQL, "purge_instagram_processed_messages"))).toBe(INSTAGRAM_PROCESSED_RETENTION_DAYS);
  });

  it("CONTROLE POSITIVO: lease de 60s no claim do evento reprova", () => {
    const original = corpo(SQL, "claim_instagram_inbound_event");
    const sabotado = original.replace(/make_interval\(\s*secs\s*=>\s*90\s*\)/i, "make_interval(secs => 60)");
    expect(sabotado).not.toBe(original);
    expect(leases(sabotado)).not.toEqual(leases(sabotado).map(() => INBOUND_LEASE_TTL_MS / 1000));
  });

  it("CONTROLE POSITIVO: lease de 60s no claim da mensagem reprova", () => {
    const original = corpo(SQL, "claim_instagram_message");
    const sabotado = original.replace(/make_interval\(\s*secs\s*=>\s*90\s*\)/i, "make_interval(secs => 60)");
    expect(sabotado).not.toBe(original);
    expect(leases(sabotado)).not.toEqual(leases(sabotado).map(() => INBOUND_LEASE_TTL_MS / 1000));
  });

  it("CONTROLE POSITIVO: done com 5 dias e dead com 7 dias reprovam", () => {
    const original = corpo(SQL, "purge_instagram_inbound_events");
    const done = original.replace(`status = 'done' and received_at < now() - interval '7 days'`,
      `status = 'done' and received_at < now() - interval '5 days'`);
    const dead = original.replace(`status = 'dead' and received_at < now() - interval '30 days'`,
      `status = 'dead' and received_at < now() - interval '7 days'`);
    expect(done).not.toBe(original);
    expect(dead).not.toBe(original);
    expect(diasDaPerna(done, "done")).not.toBe(PURGE_DONE_AFTER_DAYS);
    expect(diasDaPerna(dead, "dead")).not.toBe(PURGE_DEAD_AFTER_DAYS);
  });

  it("CONTROLE POSITIVO: ledger com 28 dias reprova", () => {
    const original = corpo(SQL, "purge_instagram_processed_messages");
    const sabotado = original.replace("interval '30 days'", "interval '28 days'");
    expect(sabotado).not.toBe(original);
    expect(diasDoLedger(sabotado)).not.toBe(INSTAGRAM_PROCESSED_RETENTION_DAYS);
  });

  it("CONTROLE POSITIVO: número só em comentário não conta", () => {
    const sabotado = SQL.replace(
      "create or replace function public.purge_instagram_processed_messages(",
      "-- created_at < now() - interval '30 days'\ncreate or replace function public.purge_instagram_processed_messages_x(",
    );
    expect(() => corpo(sabotado, "purge_instagram_processed_messages")).toThrow();
  });
});

// ─── Task 1.5: agendamento (20261021120500_instagram_cron.sql) ──────────────
// O harness não tem pg_cron: o arquivo de cron não roda no pré-voo 79 e é
// conferido aqui, como texto. Escopo: as chamadas `cron.schedule(...)` do SQL
// SEM comentários (o cabeçalho e o bloco de validação repetem as expressões).
const ARQUIVO_CRON = readdirSync(MIGRATIONS).find((f) => /^\d{14}_instagram_cron\.sql$/.test(f));
const SQL_CRON = ARQUIVO_CRON ? readFileSync(resolve(MIGRATIONS, ARQUIVO_CRON), "utf8") : "";

type Agendamento = { nome: string; expr: string; comando: string; posicao: number };

/** Toda chamada `select cron.schedule('nome', 'expr', $$comando$$)` do SQL sem comentários. */
function agendamentos(sql: string): Agendamento[] {
  const limpo = semComentarios(sql);
  const re = /select\s+cron\.schedule\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*\$\$([\s\S]*?)\$\$\s*\)/gi;
  return [...limpo.matchAll(re)].map((m) => ({ nome: m[1], expr: m[2], comando: m[3].trim(), posicao: m.index ?? -1 }));
}

/** Posição do `perform cron.unschedule(jobid) from cron.job where jobname = '<nome>'` (defensivo, por jobid). */
function posicaoDoUnschedule(sql: string, nome: string): number {
  const limpo = semComentarios(sql);
  const re = new RegExp(
    `perform\\s+cron\\.unschedule\\(\\s*jobid\\s*\\)\\s+from\\s+cron\\.job\\s+where\\s+jobname\\s*=\\s*'${nome}'`,
    "i",
  );
  return limpo.match(re)?.index ?? -1;
}

/** Expressão cron "a cada N minutos" derivada do intervalo da varredura. */
function exprDaVarredura(ms: number): string {
  const minutos = ms / 60_000;
  if (!Number.isInteger(minutos) || minutos < 1) throw new Error(`intervalo ${ms}ms não é minuto inteiro`);
  // Montado por interpolação: a sequência asterisco-barra fecharia um comentário de bloco.
  return `*${"/"}${minutos} * * * *`;
}

const ESPERADOS: Record<string, { expr: string; comando: string }> = {
  "instagram-inbound-sweep": {
    expr: exprDaVarredura(INBOUND_SWEEP_INTERVAL_MS),
    comando: "select public.trigger_instagram_inbound_sweep();",
  },
  "instagram-token-refresh": { expr: "40 9 * * *", comando: "select public.trigger_instagram_token_refresh();" },
  "instagram-inbound-purge": {
    expr: "17 4 * * *",
    comando: "select public.purge_instagram_inbound_events(), public.purge_instagram_processed_messages();",
  },
};

/** Lista de divergências do arquivo de cron contra ESPERADOS (vazia = confere). */
function conferir(sql: string): string[] {
  const erros: string[] = [];
  const ags = agendamentos(sql);
  const nomes = ags.map((a) => a.nome).sort();
  if (JSON.stringify(nomes) !== JSON.stringify(Object.keys(ESPERADOS).sort())) erros.push(`jobs=${nomes.join(",")}`);
  for (const a of ags) {
    const e = ESPERADOS[a.nome];
    if (!e) continue;
    if (a.expr !== e.expr) erros.push(`${a.nome}: expr ${a.expr} != ${e.expr}`);
    if (a.comando.replace(/\s+/g, " ") !== e.comando) erros.push(`${a.nome}: comando ${a.comando}`);
    const u = posicaoDoUnschedule(sql, a.nome);
    if (u === -1 || u > a.posicao) erros.push(`${a.nome}: sem unschedule defensivo antes do schedule`);
  }
  return erros;
}

describe("migration de cron do Instagram ⇔ núcleo da fila de inbound", () => {
  it("o arquivo existe e vem depois da 20261021120400 (origem da reserva)", () => {
    expect(ARQUIVO_CRON).toBeDefined();
    expect(Number(ARQUIVO_CRON!.slice(0, 14))).toBeGreaterThan(20261021120400);
  });

  it("a varredura roda a cada INBOUND_SWEEP_INTERVAL_MS (60_000 → a cada minuto)", () => {
    const sweep = agendamentos(SQL_CRON).find((a) => a.nome === "instagram-inbound-sweep");
    expect(sweep, "cron.schedule de instagram-inbound-sweep não encontrado").toBeDefined();
    expect(sweep!.expr).toBe(exprDaVarredura(INBOUND_SWEEP_INTERVAL_MS));
  });

  it("três jobs, com nome, expressão e comando do plano, cada um desagendado (por jobid) antes", () => {
    expect(conferir(SQL_CRON)).toEqual([]);
  });

  it("os wrappers e as purgas agendados existem na migration da fila (Task 1.3)", () => {
    for (const nome of [
      "trigger_instagram_inbound_sweep",
      "trigger_instagram_token_refresh",
      "purge_instagram_inbound_events",
      "purge_instagram_processed_messages",
    ]) {
      expect(() => corpo(SQL, nome)).not.toThrow();
    }
  });

  it("CONTROLE POSITIVO: varredura a cada 5 minutos reprova", () => {
    const sabotado = SQL_CRON.replace(`'${exprDaVarredura(60_000)}'`, `'${exprDaVarredura(300_000)}'`);
    expect(sabotado).not.toBe(SQL_CRON);
    expect(conferir(sabotado).some((e) => e.startsWith("instagram-inbound-sweep: expr"))).toBe(true);
  });

  it("CONTROLE POSITIVO: job sem o unschedule defensivo reprova", () => {
    const sabotado = SQL_CRON.replace(
      /perform\s+cron\.unschedule\(jobid\)\s+from\s+cron\.job\s+where\s+jobname\s*=\s*'instagram-token-refresh';/i,
      "",
    );
    expect(sabotado).not.toBe(SQL_CRON);
    expect(conferir(sabotado)).toContain("instagram-token-refresh: sem unschedule defensivo antes do schedule");
  });

  it("CONTROLE POSITIVO: purga chamando só uma das duas funções reprova", () => {
    const sabotado = SQL_CRON.replace(", public.purge_instagram_processed_messages()", "");
    expect(sabotado).not.toBe(SQL_CRON);
    expect(conferir(sabotado).some((e) => e.startsWith("instagram-inbound-purge: comando"))).toBe(true);
  });

  it("CONTROLE POSITIVO: agendamento só em comentário não conta", () => {
    const sabotado = SQL_CRON.replace(
      /select\s+cron\.schedule\(\s*'instagram-inbound-purge'/i,
      "-- select cron.schedule('instagram-inbound-purge'",
    );
    expect(sabotado).not.toBe(SQL_CRON);
    expect(conferir(sabotado).some((e) => e.startsWith("jobs="))).toBe(true);
  });
});
