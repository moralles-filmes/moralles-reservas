import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  INBOUND_LEASE_TTL_MS,
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
  it("o arquivo existe e vem depois da 20261020120100 (conta e contato)", () => {
    expect(ARQUIVO).toBeDefined();
    expect(Number(ARQUIVO!.slice(0, 14))).toBeGreaterThan(20261020120100);
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
