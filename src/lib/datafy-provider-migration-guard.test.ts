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

// Assinaturas COMPLETAS — uma assinatura parcial num `revoke` é no-op silencioso.
// Conferidas contra o arquivo real da migration (linhas 148 e 215).
const ACL = [
  "revoke all on function public.claim_processed_whatsapp_message(text, text, uuid, integer)",
  "revoke all on function public.set_organization_default_whatsapp_provider(uuid, text, uuid, text)",
];

// As nove listas de provider no arquivo têm forma idêntica —
// `in ('zapi', 'uazapi', 'waha', 'official', 'datafy')` — e são as únicas
// ocorrências de `in (` no arquivo (conferido com grep: 9 matches, mesma forma).
// Extração estrutural: imune a comentário em prosa contendo o nome do
// provider entre aspas, e falha nomeando a lista culpada em vez de um total
// agregado.
function assertListasCompletas(sql: string) {
  const listas = [...sql.matchAll(/in \(((?:\s*'[a-z_]+'\s*,?)+)\)/g)].map((m) => m[1]);
  expect(listas).toHaveLength(LISTAS_ESPERADAS);
  for (const [i, lista] of listas.entries()) {
    for (const provider of WHATSAPP_PROVIDER_NAMES) {
      expect(lista, `lista #${i + 1} não contém '${provider}': ${lista}`).toContain(`'${provider}'`);
    }
  }
}

describe("migration 110 — datafy nos CHECKs de provider", () => {
  it("o registry declara datafy", () => {
    expect(WHATSAPP_PROVIDER_NAMES).toContain("datafy");
  });

  it("dropa e recria cada CHECK de forma idempotente, drop antes de add", () => {
    for (const constraint of CONSTRAINTS) {
      expect(SQL).toContain(`drop constraint if exists ${constraint}`);
      expect(SQL).toContain(`add constraint ${constraint}`);
      // Cego a ordem não basta: numa reaplicação, `add` antes de `drop`
      // apagaria a constraint recém-criada.
      expect(
        SQL.indexOf(`drop constraint if exists ${constraint}`),
        `${constraint}: o drop precisa vir antes do add`,
      ).toBeLessThan(SQL.indexOf(`add constraint ${constraint}`));
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
    assertListasCompletas(SQL);
  });

  // CONTROLE POSITIVO: muta o SQL REAL (não uma cópia inventada) e chama a
  // MESMA função que a asserção real usa — é isso que faz o controle
  // controlar o mecanismo real, e não uma tautologia sobre String.split.
  it("detectaria a omissão na guarda da RPC de idempotência", () => {
    const mutante = SQL.replace(
      "if p_provider not in ('zapi', 'uazapi', 'waha', 'official', 'datafy')",
      "if p_provider not in ('zapi', 'uazapi', 'waha', 'official')",
    );
    expect(mutante).not.toBe(SQL); // a mutação de fato aplicou
    expect(() => assertListasCompletas(mutante)).toThrow();
  });

  it("reafirma a ACL das duas funções com assinatura completa e search_path vazio", () => {
    for (const revoke of ACL) {
      expect(SQL).toContain(revoke);
    }
    expect(SQL.split("set search_path = ''").length - 1).toBe(FUNCOES.length);
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
