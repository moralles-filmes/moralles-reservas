/**
 * Guardrail estático de migrations — BLOQUEANTE no CI.
 *
 * Motivo (spec da Fase 6b §11.0): treze migrations legadas embutem a URL do
 * projeto de PRODUÇÃO dentro dos wrappers de pg_cron. Um banco reconstruído a
 * partir desse histórico, com pg_cron ativo, agenda jobs que fazem POST nas
 * Edge Functions de produção.
 *
 * Consertar as treze é frente estrutural separada
 * (BASELINE_REPRODUCIBLE_DATABASE_ENVIRONMENT), junto do replay que hoje
 * estoura em `42P13 — cannot change return type of existing function`
 * (docs/hotfix-acl/03-ENSAIO-ORDEM-REAL.md §1). O que este guardrail garante é
 * mais modesto e imediato: **nenhuma migration NOVA repete o padrão**.
 *
 * A allowlist abaixo é HISTÓRICA E FECHADA: ela nunca cresce. Arquivo novo com
 * URL de projeto é falha, não pedido de allowlist.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(__dirname, "..", "supabase", "migrations");

/** Os 13 arquivos que JÁ estavam aplicados quando a regra nasceu. Fechada. */
const LEGACY_HARDCODED_URL = new Set([
  "20260506181440_022_reservation_source.sql",
  "20260507153701_029_outbox_cron.sql",
  "20260508161319_043_giftback_cron.sql",
  "20260508211157_045_reservation_automation_cron.sql",
  "20260514181701_048_waitlist_automation.sql",
  "20260520000000_storage_orphan_cleanup_cron.sql",
  "20260527140001_stripe_expire_payments_cron.sql",
  "20260528010000_billing_crons.sql",
  "20260528030000_billing_trial_auto.sql",
  "20260716140000_064_process_asaas_reconcile_cron.sql",
  "20260719151000_069_process_billing_notifications_cron.sql",
  "20260727100400_082_cron_asaas_invoice_reconcile.sql",
  "20260727100500_083_cron_whatsapp_enforcement.sql",
]);

const PROJECT_URL = /https:\/\/[a-z0-9]{20}\.supabase\.co/i;

const SECRET_SHAPES: { name: string; re: RegExp }[] = [
  { name: "OpenAI", re: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { name: "Anthropic", re: /\bsk-ant-[A-Za-z0-9_-]{16,}/ },
  { name: "xAI", re: /\bxai-[A-Za-z0-9_-]{16,}/ },
  { name: "Resend", re: /\bre_[A-Za-z0-9_-]{16,}/ },
  { name: "JWT", re: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/ },
  { name: "URL com credencial", re: /postgres(?:ql)?:\/\/[^\s:'"]+:[^\s@'"]+@/i },
  // As três formas abaixo nasceram do incidente de 2026-08-02: a
  // `INTERNAL_API_KEY` estava em claro num header montado dentro de
  // `create trigger ... supabase_functions.http_request(...)` na 022, e
  // nenhuma das formas acima casa com um hex de 64 sem prefixo — a chave
  // atravessou o CI sem ser vista.
  //
  // A primeira versão desta regra cobria só a FORMA exata do incidente. Isso
  // fecha a instância e deixa a CLASSE aberta: um `Client-Token` da Z-API em
  // `jsonb_build_object`, ou um segredo atribuído a variável, passariam verde
  // pelo mesmo caminho. As três juntas cobrem a classe.
  //
  // Todas detectam só valor LITERAL. O padrão CORRETO monta o header a partir
  // do Vault (`jsonb_build_object('x-internal-key', v_key)` ou
  // `'...' || v_key || '...'`), e a classe negada `[^"']` faz a variável não
  // casar.
  {
    name: "header de auth com valor literal",
    re: /["'](?:authorization|apikey|client-token|x-[a-z-]*(?:key|token|secret|signature))["']\s*[:,]\s*["'][^"']{16,}["']/i,
  },
  // Segredo atribuído a variável ou parâmetro — a forma que escapa de qualquer
  // regra baseada em nome de header.
  {
    name: "segredo literal atribuído a variável",
    // `[a-z_]*` nos DOIS lados de propósito: sem o prefixo, `v_api_key` não
    // casa — `_` é caractere de palavra, então não há `\b` entre `v_` e `api`.
    re: /[a-z_]*(?:secret|token|api[_-]?key|client[_-]?token|password|senha)[a-z_]*\s*(?:text\s*)?:?=\s*'[A-Za-z0-9_\-./+]{20,}'/i,
  },
  { name: "Stripe", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|\bwhsec_[A-Za-z0-9]{16,}/ },
  { name: "Google AI", re: /\bAIza[0-9A-Za-z_-]{20,}/ },
  { name: "AWS", re: /\bAKIA[0-9A-Z]{16}\b/ },
];

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
}

function read(file: string): string {
  return readFileSync(join(MIGRATIONS_DIR, file), "utf8");
}

describe("guardrail estático de migrations", () => {
  it("nenhuma migration NOVA embute URL de projeto Supabase", () => {
    const offenders = migrationFiles().filter(
      (f) => !LEGACY_HARDCODED_URL.has(f) && PROJECT_URL.test(read(f)),
    );
    expect(
      offenders,
      `URL de projeto hardcoded em: ${offenders.join(", ")}. Leia a configuração do ambiente (Vault), não embuta o host — senão um banco reconstruído aponta cron para produção.`,
    ).toEqual([]);
  });

  it("nenhuma migration embute segredo", () => {
    const offenders: string[] = [];
    for (const f of migrationFiles()) {
      const sql = read(f);
      for (const s of SECRET_SHAPES) {
        if (s.re.test(sql)) offenders.push(`${f} (${s.name})`);
      }
    }
    expect(offenders, `Possível segredo em: ${offenders.join(", ")}`).toEqual([]);
  });

  it("a allowlist legada não cresce — ela é histórica e fechada", () => {
    expect(LEGACY_HARDCODED_URL.size).toBe(13);
  });

  it("todo arquivo da allowlist ainda existe — entrada órfã esconde regressão", () => {
    const present = new Set(migrationFiles());
    const missing = [...LEGACY_HARDCODED_URL].filter((f) => !present.has(f));
    expect(missing, `Allowlist cita arquivo inexistente: ${missing.join(", ")}`).toEqual([]);
  });

  it("controle positivo: o guardrail realmente detecta o padrão", () => {
    // Sem isto, um regex quebrado passaria como "nada encontrado" — que é
    // exatamente o modo de falha que um teste negativo tem de excluir.
    expect(PROJECT_URL.test("project_url text := 'https://gbabxcrntkwgblgqsiit.supabase.co';")).toBe(
      true,
    );
    expect(PROJECT_URL.test("url := project_url || '/functions/v1/x'")).toBe(false);
    expect(SECRET_SHAPES[4].re.test("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdefghij")).toBe(true);
  });

  it("controle positivo e negativo: header de auth com valor literal", () => {
    const shape = SECRET_SHAPES.find((s) => s.name === "header de auth com valor literal")!;
    const fakeHex = "f".repeat(64);

    // A FORMA do incidente de 2026-08-02 (valor fictício, nunca o real).
    expect(shape.re.test(`'{"Content-type":"application/json","X-Internal-Key":"${fakeHex}"}'`)).toBe(
      true,
    );
    expect(shape.re.test(`'{"Authorization":"Bearer ${fakeHex}"}'`)).toBe(true);

    // A CLASSE, não só a instância: outros nomes de header e a sintaxe de
    // jsonb_build_object (vírgula no lugar de dois-pontos).
    expect(shape.re.test(`jsonb_build_object('Client-Token', '${fakeHex}')`)).toBe(true);
    expect(shape.re.test(`jsonb_build_object('x-webhook-secret', '${fakeHex}')`)).toBe(true);
    expect(shape.re.test(`'{"X-Hub-Signature":"${fakeHex}"}'`)).toBe(true);

    // O padrão CORRETO — header montado do Vault — não casa em NENHUMA das
    // duas sintaxes. Sem estas asserções, apertar o regex quebraria os 15
    // wrappers de pg_cron.
    expect(
      shape.re.test(`'{"Content-type":"application/json","x-internal-key":"' || v_key || '"}'`),
    ).toBe(false);
    expect(shape.re.test(`format('{"x-internal-key":"%s"}', v_key)`)).toBe(false);
    expect(shape.re.test(`jsonb_build_object('x-internal-key', api_key)`)).toBe(false);
    expect(shape.re.test(`jsonb_build_object('Content-Type', 'application/json')`)).toBe(false);
  });

  it("controle positivo e negativo: segredo literal atribuído a variável", () => {
    const shape = SECRET_SHAPES.find((s) => s.name === "segredo literal atribuído a variável")!;
    const fakeHex = "f".repeat(64);

    expect(shape.re.test(`  v_api_key text := '${fakeHex}';`)).toBe(true);
    expect(shape.re.test(`  client_token := '${fakeHex}';`)).toBe(true);
    expect(shape.re.test(`  webhook_secret text := '${fakeHex}';`)).toBe(true);

    // Leitura do Vault e comparação por NOME do segredo não casam — é
    // exatamente o que as 15 migrations de wrapper fazem.
    expect(shape.re.test(`where name = 'internal_api_key' limit 1`)).toBe(false);
    expect(shape.re.test(`select decrypted_secret into api_key from vault.decrypted_secrets`)).toBe(
      false,
    );
    expect(shape.re.test(`  api_key text;`)).toBe(false);
  });
});
