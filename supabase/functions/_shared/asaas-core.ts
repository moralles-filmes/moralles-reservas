/**
 * Núcleo PURO Asaas: ambiente/base URL/validação de chave (§8) + parsing de
 * erro e de rate limit (§10) das respostas HTTP.
 *
 * ZERO dependências (sem imports, sem `Deno.*`) — importável tanto por
 * _shared/asaas-config.ts / _shared/asaas.ts (Edge Functions, Deno) quanto
 * pelo vitest do frontend (src/lib/asaas-core.test.ts, roda em jsdom sem
 * Deno). Mesmo padrão de entitlements-core.ts.
 *
 * Consumido hoje via asaas-config.ts por manage-platform-secrets (Fase 2:
 * só a limpeza de cache no upsert/delete de secret) e via asaas.ts (cliente
 * HTTP, Fase 2 — ainda sem EF consumidora). Nenhuma flag é lida neste módulo.
 * Fatos abaixo vêm de docs/billing-asaas/03-ASAAS-API-VERIFICADO.md (§8/§10)
 * — não alterar sem reconferir a doc oficial do Asaas.
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
 * Resultado de validateKeyForEnv — 3 estados, nunca booleano puro (§8 da doc):
 * - "ok": prefixo bate com o ambiente.
 * - "blocked": prefixo conhecido mas do ambiente errado — falha cedo, `error` pro chamador.
 * - "inconclusive": prefixo não reconhecido — NÃO bloqueia (ver comentário no branch
 *   abaixo), mas `warning` deve ir pro log do chamador.
 */
export type KeyEnvValidation =
  | { status: "ok" }
  | { status: "blocked"; error: string }
  | { status: "inconclusive"; warning: string };

/**
 * Guard de configuração: a chave pertence ao ambiente em que vamos usá-la?
 * Nunca inclui o valor da chave em `error`/`warning` — essas mensagens vão pra log.
 */
export function validateKeyForEnv(apiKey: string, env: AsaasEnv): KeyEnvValidation {
  const trimmedKey = apiKey.trim();
  if (!trimmedKey) {
    return { status: "blocked", error: "Chave da API Asaas não está configurada." };
  }

  const keyEnv = detectKeyEnv(trimmedKey);
  if (keyEnv === null) {
    // Chaves geradas ANTES de 10/03/2025 não têm o segmento prod/hmlg (formato
    // legado `$aact_YTU5...`, hash direto após `$aact_`) e continuam válidas —
    // não são migradas automaticamente. Tratar como erro rejeitaria uma chave
    // legítima e antiga; quem garante o ambiente de fato é a própria API
    // (401 invalid_environment), não o prefixo.
    return {
      status: "inconclusive",
      warning:
        "Chave da API Asaas com prefixo não reconhecido (possível formato legado pré-10/03/2025) — validação de ambiente por prefixo inconclusiva.",
    };
  }

  if (keyEnv !== env) {
    const label = (e: AsaasEnv) => (e === "production" ? "produção" : "sandbox");
    // Lado esquerdo (chave) usa o rótulo PT-BR pro operador; lado direito
    // (ASAAS_ENV=) usa o literal em inglês — é o valor real da env var, não
    // texto traduzível. `parseAsaasEnv("produção")` cai pro default "sandbox",
    // então um "ASAAS_ENV=produção" no log levaria quem copia a configurar o
    // ambiente TROCADO.
    return {
      status: "blocked",
      error: `Chave de ${label(keyEnv)} configurada mas ASAAS_ENV=${env}.`,
    };
  }

  return { status: "ok" };
}

/**
 * Extrai a mensagem de erro do body do Asaas: `{ errors: [{ code, description }] }`
 * (§10 da doc verificada — a Stripe usa `error.message`, o Asaas não). À prova
 * de qualquer shape (null, array vazio, string solta, objeto sem `description`)
 * — nunca lança, sempre cai no `fallback`.
 */
export function parseAsaasError(data: unknown, fallback: string): string {
  if (!data || typeof data !== "object" || Array.isArray(data)) return fallback;

  const errors = (data as Record<string, unknown>).errors;
  if (!Array.isArray(errors) || errors.length === 0) return fallback;

  const first = errors[0];
  if (!first || typeof first !== "object") return fallback;

  const description = (first as Record<string, unknown>).description;
  if (typeof description === "string" && description.trim()) return description;

  return fallback;
}

/**
 * Segundos até o reset do rate limit, lido do header `RateLimit-Reset` (§10 —
 * não existe `Retry-After` no Asaas). `null` pra ausente/NaN/negativo. "0" É
 * válido (reset iminente, não ausência) — não tratar como falsy.
 */
export function parseRateLimitReset(headerValue: string | null): number | null {
  if (headerValue === null || headerValue.trim() === "") return null;
  const parsed = Number(headerValue);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

/**
 * Limite de tentativas de cada caminho — compartilhado entre a decisão pura
 * abaixo e o loop real em _shared/asaas.ts (fetchAsaasGet/fetchAsaasMutation)
 * pra não duplicar o número em dois lugares e divergir por refactor futuro.
 */
export const MUTATION_RATE_LIMIT_RETRIES = 3;
export const GET_MAX_RETRIES = 2;

/**
 * Decisão PURA de retry do caminho mutante (POST/PUT/DELETE) — só por
 * status+attempt, sem I/O. É o invariante de dinheiro desta integração
 * (pinado em src/lib/asaas-core.test.ts): 429 e ainda dentro do limite de
 * tentativas → true (rate limit rejeitou a requisição ANTES de processar
 * nada, repetir é seguro); qualquer outro status (200, 4xx, 5xx) → false —
 * 5xx NUNCA repete aqui, outcome desconhecido arrisca duplicar uma cobrança
 * real (Asaas não tem Idempotency-Key, §11). Erro de rede/timeout não passa
 * por esta função — é estrutural em asaas.ts (fetch não é capturado nesse
 * caminho de propósito), não dá pra expressar como predicado de status.
 */
export function shouldRetryMutation(status: number, attempt: number): boolean {
  return status === 429 && attempt < MUTATION_RATE_LIMIT_RETRIES;
}

/**
 * Decisão PURA de retry do caminho GET — GET é idempotente por natureza,
 * então 5xx E 429 repetem normalmente até o limite de tentativas.
 */
export function shouldRetryGet(status: number, attempt: number): boolean {
  return (status >= 500 || status === 429) && attempt < GET_MAX_RETRIES;
}
