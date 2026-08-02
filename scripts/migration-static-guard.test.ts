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
  // Header de autenticação com valor LITERAL. Nasceu do incidente de
  // 2026-08-02: a `INTERNAL_API_KEY` estava em claro num header montado dentro
  // de `create trigger ... supabase_functions.http_request(...)` na 022, e
  // nenhuma das formas acima casa com um hex de 64 — a chave atravessou o CI
  // sem ser vista. Detecta só valor literal: o padrão CORRETO monta o header
  // por concatenação a partir do Vault (`'...' || v_key || '...'`), e a classe
  // negada `[^"']` faz a concatenação não casar.
  {
    name: "header de auth com valor literal",
    re: /["'](?:x-internal-key|authorization|apikey|x-api-key)["']\s*:\s*["'][^"']{16,}["']/i,
  },
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

    // O padrão CORRETO — header montado do Vault por concatenação — não casa.
    // Sem esta asserção, apertar o regex quebraria os 15 wrappers de pg_cron.
    expect(
      shape.re.test(`'{"Content-type":"application/json","x-internal-key":"' || v_key || '"}'`),
    ).toBe(false);
    expect(shape.re.test(`format('{"x-internal-key":"%s"}', v_key)`)).toBe(false);
  });
});
