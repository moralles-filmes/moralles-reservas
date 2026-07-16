/**
 * Núcleo PURO Asaas: ambiente/base URL/validação de chave (§8) + parsing de
 * erro e de rate limit (§10) das respostas HTTP + classificação de evento e
 * parsing do envelope de webhook (§3/§4).
 *
 * ZERO dependências (sem imports, sem `Deno.*`) — importável tanto por
 * _shared/asaas-config.ts / _shared/asaas.ts (Edge Functions, Deno) quanto
 * pelo vitest do frontend (src/lib/asaas-core.test.ts, roda em jsdom sem
 * Deno). Mesmo padrão de entitlements-core.ts.
 *
 * Consumido hoje via asaas-config.ts por manage-platform-secrets (Fase 2:
 * só a limpeza de cache no upsert/delete de secret), via asaas.ts (cliente
 * HTTP, Fase 2 — ainda sem EF consumidora) e diretamente por
 * supabase/functions/asaas-webhook/index.ts (classificação known/unknown +
 * parse do envelope) e supabase/functions/process-asaas-reconcile/index.ts
 * (reclassificação known/unknown das linhas presas). Nenhuma flag é lida
 * neste módulo. Fatos abaixo vêm de docs/billing-asaas/03-ASAAS-API-VERIFICADO.md
 * (§3/§4/§8/§10) — não alterar sem reconferir a doc oficial do Asaas.
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

// ─────────────────────────────────────────────────────────────────────────────
// Conversão monetária — a fronteira mais perigosa da integração (§9.1)
//
// Nosso código inteiro fala `amountCents` (inteiro). O Asaas fala `value` em
// REAIS DECIMAIS (`"value": 19.90` = R$ 19,90 — não `1990`). Mandar centavos
// crus (`44900`) cobraria R$ 44.900,00 em vez de R$ 449,00: 100x. Estas duas
// funções são a ÚNICA fronteira de conversão — AsaasBillingProvider
// (_shared/billing-provider.ts) chama-as em vez de dividir/multiplicar por
// 100 solto no meio do adapter.
//
// Ambas erram pro lado seguro: entrada inválida LANÇA em vez de tentar
// adivinhar um valor — cobrar um número errado silenciosamente é pior do que
// a operação falhar alto e o caller (AsaasBillingProvider) traduzir pra um
// ProviderResult{ok:false} antes de expor ao resto do sistema.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Centavos (inteiro) → `value` do Asaas (reais decimais). Ver §9.1.
 * Lança se `amountCents` não for inteiro finito ≥ 0 — fração de centavo não
 * existe (não há como "arredondar" isso sem mascarar um bug de chamador).
 * Zero é válido (plano trial R$ 0, seed `trial-padrao` do FASE 3).
 */
export function centsToAsaasValue(amountCents: number): number {
  if (!Number.isInteger(amountCents) || amountCents < 0) {
    throw new RangeError(
      `centsToAsaasValue: amountCents inválido (${amountCents}) — precisa ser inteiro ≥ 0.`,
    );
  }
  return amountCents / 100;
}

/**
 * `value` do Asaas (reais decimais) → centavos (inteiro). Ver §9.1.
 * O `Math.round` NÃO é decorativo: `19.90 * 100 === 1989.9999999999998` em
 * IEEE 754 — sem arredondar, `Math.trunc`/cast direto cortaria pra `1989`
 * (R$ 0,01 a menos por cobrança, de forma silenciosa). Lança em
 * NaN/Infinity/negativo: um `value` corrompido vindo da API não deve virar
 * um número de centavos qualquer.
 */
export function asaasValueToCents(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(
      `asaasValueToCents: value inválido (${value}) — precisa ser finito e ≥ 0.`,
    );
  }
  return Math.round(value * 100);
}

// ─────────────────────────────────────────────────────────────────────────────
// Webhook — classificação de evento + parsing do envelope (§3/§4 da doc,
// Fase 2 Task 4). Consumido por supabase/functions/asaas-webhook/index.ts e
// supabase/functions/process-asaas-reconcile/index.ts (Task 5, só reclassifica
// — parseAsaasWebhookEnvelope segue exclusivo do webhook).
// Escopo estritamente limitado a "persistir + classificar known/unknown" —
// NENHUMA lógica de negócio por evento (ativar assinatura, creditar saldo,
// mudar billing_status) mora aqui. Isso é Fase 4.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Nomes exatos copiados de docs/billing-asaas/03-ASAAS-API-VERIFICADO.md (§4)
 * — não repetir de memória, reconferir a doc se a lista precisar mudar.
 * Comparação é SEMPRE por igualdade de string inteira contra este set —
 * NUNCA por prefixo. `PAYMENT_AWAITING_CHARGEBACK_REVERSAL` existe e começa
 * com `PAYMENT_` mas NÃO com `PAYMENT_CHARGEBACK_`; um matcher por prefixo
 * (`event.startsWith("PAYMENT_CHARGEBACK_")`) erraria esse evento. Um Set de
 * literais evita a armadilha por construção.
 */
export const ASAAS_PAYMENT_EVENTS: ReadonlySet<string> = new Set([
  "PAYMENT_CREATED",
  "PAYMENT_AWAITING_RISK_ANALYSIS",
  "PAYMENT_APPROVED_BY_RISK_ANALYSIS",
  "PAYMENT_REPROVED_BY_RISK_ANALYSIS",
  "PAYMENT_AUTHORIZED",
  "PAYMENT_UPDATED",
  "PAYMENT_CONFIRMED",
  "PAYMENT_RECEIVED",
  "PAYMENT_CREDIT_CARD_CAPTURE_REFUSED",
  "PAYMENT_ANTICIPATED",
  "PAYMENT_OVERDUE",
  "PAYMENT_DELETED",
  "PAYMENT_RESTORED",
  "PAYMENT_REFUNDED",
  "PAYMENT_PARTIALLY_REFUNDED",
  "PAYMENT_REFUND_IN_PROGRESS",
  "PAYMENT_REFUND_DENIED",
  "PAYMENT_RECEIVED_IN_CASH_UNDONE",
  "PAYMENT_CHARGEBACK_REQUESTED",
  "PAYMENT_CHARGEBACK_DISPUTE",
  "PAYMENT_AWAITING_CHARGEBACK_REVERSAL",
  "PAYMENT_DUNNING_RECEIVED",
  "PAYMENT_BANK_SLIP_CANCELLED",
  "PAYMENT_DUNNING_REQUESTED",
  "PAYMENT_BANK_SLIP_VIEWED",
  "PAYMENT_CHECKOUT_VIEWED",
  "PAYMENT_SPLIT_CANCELLED",
  "PAYMENT_SPLIT_DIVERGENCE_BLOCK",
  "PAYMENT_SPLIT_DIVERGENCE_BLOCK_FINISHED",
]);

/**
 * Não existe `SUBSCRIPTION_CANCELED` na API (§4) — cancelamento chega como
 * `SUBSCRIPTION_DELETED` ou `SUBSCRIPTION_INACTIVATED`. Não adicionar
 * `SUBSCRIPTION_CANCELED` aqui "pra garantir": o nome não existe de fato, e
 * o teste correspondente prova que ele classifica como desconhecido.
 */
export const ASAAS_SUBSCRIPTION_EVENTS: ReadonlySet<string> = new Set([
  "SUBSCRIPTION_CREATED",
  "SUBSCRIPTION_UPDATED",
  "SUBSCRIPTION_INACTIVATED",
  "SUBSCRIPTION_DELETED",
  "SUBSCRIPTION_SPLIT_DISABLED",
  "SUBSCRIPTION_SPLIT_DIVERGENCE_BLOCK",
  "SUBSCRIPTION_SPLIT_DIVERGENCE_BLOCK_FINISHED",
]);

export const ASAAS_CHECKOUT_EVENTS: ReadonlySet<string> = new Set([
  "CHECKOUT_CREATED",
  "CHECKOUT_CANCELED",
  "CHECKOUT_EXPIRED",
  "CHECKOUT_PAID",
]);

export type AsaasEventClassification = "known" | "unknown";

/**
 * Classifica o `event` do envelope. "known" vira `processing_status='processed'`
 * no webhook; "unknown" vira 'ignored' — NUNCA erro (evento novo ou fora do
 * escopo da Fase 2 não pode derrubar a fila do Asaas, doc §2).
 */
export function classifyAsaasEvent(event: string): AsaasEventClassification {
  if (
    ASAAS_PAYMENT_EVENTS.has(event) ||
    ASAAS_SUBSCRIPTION_EVENTS.has(event) ||
    ASAAS_CHECKOUT_EVENTS.has(event)
  ) {
    return "known";
  }
  return "unknown";
}

/**
 * Resultado discriminado do parse do envelope do webhook — nunca lança.
 * `valid:false` sempre vem com `reason` (vai pro log, nunca é exposto ao
 * Asaas na resposta).
 */
export type ParsedAsaasWebhook =
  | { valid: true; id: string; event: string; dateCreated: string | null }
  | { valid: false; reason: string };

/**
 * Valida só o envelope (`id`/`event`), à prova de body nulo, array, string
 * solta, ou objeto sem os campos — §3 avisa que o miolo (chave `payment`/
 * `subscription`/`checkout`) NÃO tem shape uniforme entre categorias, então
 * validar além do envelope acoplaria a uma categoria específica sem
 * necessidade (o caller só precisa de id/event pra persistir e classificar).
 *
 * `dateCreated` é repassado cru como string quando presente: formato Asaas é
 * "YYYY-MM-DD HH:mm:ss" SEM timezone (não é ISO) — não converter pra Date
 * aqui, isso fingiria uma garantia (UTC) que o dado não tem. Ninguém consome
 * esse campo ainda nesta fase.
 */
export function parseAsaasWebhookEnvelope(body: unknown): ParsedAsaasWebhook {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { valid: false, reason: "body ausente, nulo ou não é objeto" };
  }

  const obj = body as Record<string, unknown>;

  const id = obj.id;
  if (typeof id !== "string" || !id.trim()) {
    return { valid: false, reason: "campo 'id' ausente ou não é string" };
  }

  const event = obj.event;
  if (typeof event !== "string" || !event.trim()) {
    return { valid: false, reason: "campo 'event' ausente ou não é string" };
  }

  const dateCreated = typeof obj.dateCreated === "string" ? obj.dateCreated : null;

  return { valid: true, id, event, dateCreated };
}
