import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { WHATSAPP_PROVIDER_NAMES } from "../../supabase/functions/_shared/whatsapp-provider-core";

const SQL = readFileSync(
  resolve(__dirname, "../../supabase/migrations/20260922170000_110_datafy_provider.sql"),
  "utf8",
);

const CONSTRAINTS = [
  "organizations_default_whatsapp_provider_check",
  "whatsapp_channels_provider_check",
  "whatsapp_instances_provider_check",
  "processed_messages_provider_check",
  "notifications_sent_whatsapp_provider_check",
  "whatsapp_channel_lifecycle_events_provider_check",
  "whatsapp_channel_lifecycle_events_previous_provider_check",
];

// Os dois corpos de função: um ALTER ... CHECK nunca os alcança.
const FUNCOES = [
  "public.claim_processed_whatsapp_message",
  "public.set_organization_default_whatsapp_provider",
];

// Uma expressão de lista por constraint, mais uma por corpo de função.
const LISTAS_ESPERADAS = CONSTRAINTS.length + FUNCOES.length;

describe("migration 110 — datafy nos CHECKs de provider", () => {
  it("o registry declara datafy", () => {
    expect(WHATSAPP_PROVIDER_NAMES).toContain("datafy");
  });

  it("dropa e recria cada CHECK de forma idempotente", () => {
    for (const constraint of CONSTRAINTS) {
      expect(SQL).toContain(`drop constraint if exists ${constraint}`);
      expect(SQL).toContain(`add constraint ${constraint}`);
    }
  });

  // O defeito que este teste existe para pegar: liberar o CHECK da tabela e
  // esquecer a guarda DENTRO da RPC de idempotência, por onde passa todo inbound.
  it("reescreve os dois corpos de função que guardam o nome do provider", () => {
    for (const fn of FUNCOES) {
      expect(SQL).toContain(`create or replace function ${fn}`);
    }
  });

  it("cada lista recriada inclui TODOS os providers do registry", () => {
    for (const provider of WHATSAPP_PROVIDER_NAMES) {
      const ocorrencias = SQL.split(`'${provider}'`).length - 1;
      expect(
        ocorrencias,
        `provider ${provider} aparece ${ocorrencias}x; esperado ao menos ${LISTAS_ESPERADAS} (um por CHECK e por corpo de função)`,
      ).toBeGreaterThanOrEqual(LISTAS_ESPERADAS);
    }
  });

  // CONTROLE POSITIVO: o teste acima só vale se detectar a omissão.
  it("detectaria um provider ausente do SQL", () => {
    const sqlIncompleto = "check (provider in ('zapi','waha','official'))";
    expect(sqlIncompleto.split("'uazapi'").length - 1).toBe(0);
  });

  it("não embute segredo nem a URL do projeto Supabase", () => {
    expect(SQL).not.toMatch(/supabase\.co/i);
    // "service_role" propositalmente FORA desta lista: é o nome do papel do
    // Postgres usado em `grant execute ... to service_role;` — exigido pelo
    // Global Constraint de ACL desta própria migration (reafirmar revoke/grant
    // depois de cada `create or replace function`) e usado em toda migration
    // do repo que expõe RPC privilegiada. Não é forma de segredo: o guardrail
    // real do repo, scripts/migration-static-guard.test.ts (SECRET_SHAPES),
    // também não o inclui. Um valor de chave de fato vazado já cai em `eyJ`
    // (toda service_role key da Supabase é um JWT).
    expect(SQL).not.toMatch(/sk_live_|whsec_|eyJ/);
  });
});
