/**
 * Núcleo PURO de configuração Asaas (ambiente, base URL, validação de chave).
 *
 * ZERO dependências (sem imports, sem `Deno.*`) — importável tanto por
 * _shared/asaas-config.ts (Edge Functions, Deno) quanto pelo vitest do
 * frontend (src/lib/asaas-core.test.ts, roda em jsdom sem Deno). Mesmo
 * padrão de entitlements-core.ts.
 *
 * Fase 2 billing-asaas: sem consumidor ainda, atrás da flag `asaas_enabled`
 * (OFF). Fatos abaixo vêm de docs/billing-asaas/03-ASAAS-API-VERIFICADO.md
 * (§8) — não alterar sem reconferir a doc oficial do Asaas.
 */

export type AsaasEnv = "sandbox" | "production";

export const ASAAS_SANDBOX_BASE_URL = "https://api-sandbox.asaas.com/v3";
export const ASAAS_PRODUCTION_BASE_URL = "https://api.asaas.com/v3";

const SANDBOX_KEY_PREFIX = "$aact_hmlg_";
const PRODUCTION_KEY_PREFIX = "$aact_prod_";

/** Normaliza o valor cru de ASAAS_ENV. Default seguro = "sandbox". */
export function parseAsaasEnv(raw: string | undefined | null): AsaasEnv {
  const normalized = (raw ?? "").trim().toLowerCase();
  if (normalized === "production" || normalized === "prod") return "production";
  return "sandbox";
}

/** Resolve a base URL. `override` (ASAAS_BASE_URL) vence quando não-vazio. Remove barra final. */
export function resolveAsaasBaseUrl(env: AsaasEnv, override?: string | null): string {
  const trimmedOverride = (override ?? "").trim();
  if (trimmedOverride) {
    return trimmedOverride.replace(/\/+$/, "");
  }
  return env === "production" ? ASAAS_PRODUCTION_BASE_URL : ASAAS_SANDBOX_BASE_URL;
}

/** Descobre o ambiente a que a chave pertence pelo prefixo. null = prefixo desconhecido. */
export function detectKeyEnv(apiKey: string): AsaasEnv | null {
  if (apiKey.startsWith(SANDBOX_KEY_PREFIX)) return "sandbox";
  if (apiKey.startsWith(PRODUCTION_KEY_PREFIX)) return "production";
  return null;
}

/**
 * Guard de configuração: a chave pertence ao ambiente em que vamos usá-la?
 * Nunca inclui o valor da chave na mensagem de erro — mensagens vão pra log.
 */
export function validateKeyForEnv(
  apiKey: string,
  env: AsaasEnv,
): { ok: boolean; error?: string } {
  if (!apiKey.trim()) {
    return { ok: false, error: "Chave da API Asaas não está configurada." };
  }

  const keyEnv = detectKeyEnv(apiKey);
  if (keyEnv === null) {
    return {
      ok: false,
      error: "Chave da API Asaas com prefixo desconhecido (não é sandbox nem produção).",
    };
  }

  if (keyEnv !== env) {
    const label = (e: AsaasEnv) => (e === "production" ? "produção" : "sandbox");
    return {
      ok: false,
      error: `Chave de ${label(keyEnv)} configurada mas ASAAS_ENV=${label(env)}.`,
    };
  }

  return { ok: true };
}
