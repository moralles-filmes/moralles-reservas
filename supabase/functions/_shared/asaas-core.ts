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
 *
 * Também aceita `{ error: string }` — NÃO é shape do Asaas (a API real só
 * manda `errors[]`, nunca `error` singular), é o formato SINTÉTICO que
 * `asaas.ts` (`asaasRequest`) usa nos próprios guards: chave do ambiente
 * errado (`validateKeyForEnv` bloqueado) e falha de rede/timeout. Sem este
 * branch, essas duas mensagens específicas morrem na fronteira de cada
 * wrapper (`createAsaasCustomer` etc., que só recebem `res.data` e chamam
 * `parseAsaasError` de novo) — o caller sempre veria o fallback genérico em
 * vez do motivo real, contrariando o design de §8 ("erro duro, falha cedo com
 * mensagem clara"). `errors[0].description` (shape real do Asaas) tem
 * prioridade quando os dois vierem presentes — não deveria acontecer na
 * prática (são shapes mutuamente exclusivos), mas mantém o comportamento já
 * pinado pros erros reais da API caso algum dia coexistam.
 */
export function parseAsaasError(data: unknown, fallback: string): string {
  if (!data || typeof data !== "object" || Array.isArray(data)) return fallback;

  const obj = data as Record<string, unknown>;

  const errors = obj.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0];
    if (first && typeof first === "object") {
      const description = (first as Record<string, unknown>).description;
      if (typeof description === "string" && description.trim()) return description;
    }
  }

  const errorField = obj.error;
  if (typeof errorField === "string" && errorField.trim()) return errorField;

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

/**
 * Resultado tipado do parse de `payment.value` (payload cru do Asaas, tipo
 * `unknown` — JSON de terceiro). Ao contrário de `asaasValueToCents`, esta
 * função NUNCA lança: o caller (o aplicador de eventos Asaas) precisa decidir
 * o que fazer com um valor ausente/inválido sem `try/catch` por chamada, e
 * precisa saber a DIFERENÇA entre "o campo não veio" e "o campo veio, mas é
 * lixo" — os dois exigem o mesmo `failed` no chamador, mas merecem log e
 * observabilidade diferentes.
 */
export type AsaasAmountParse =
  | { ok: true; cents: number }
  | { ok: false; code: "MISSING_PAYMENT_AMOUNT" | "INVALID_PAYMENT_AMOUNT" };

/**
 * `payment.value` cru do Asaas → resultado tipado em centavos. Delega TODO o
 * arredondamento a `asaasValueToCents` — nenhuma segunda lógica de conversão
 * aqui, só classificação de entrada.
 *
 * Zero explícito (`value: 0`) é um resultado VÁLIDO (`{ok:true, cents:0}`) —
 * cobrança de valor zero existe (plano trial) — e tem que ficar distinguível
 * de "não veio" (`undefined`/`null`/string vazia). Colapsar os dois em zero é
 * exatamente o bug que esta função existe para impedir: um `value` ausente ou
 * corrompido virando `amount_cents: 0` cria uma fatura aparentemente válida
 * que nunca vai ser cobrada de verdade — R$ 0,00 tem significado financeiro
 * próprio, não é um "não sei".
 */
export function parseAsaasAmountCents(value: unknown): AsaasAmountParse {
  if (value === undefined || value === null || value === "") {
    return { ok: false, code: "MISSING_PAYMENT_AMOUNT" };
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return { ok: false, code: "INVALID_PAYMENT_AMOUNT" };
  }
  const cents = asaasValueToCents(value);
  // Fronteira de correção (representação segura de inteiro em JS), não regra
  // de negócio inventada: nenhum plano real chega perto disso, mas um payload
  // corrompido não pode produzir um `amount_cents` fora da precisão segura.
  if (!Number.isSafeInteger(cents)) {
    return { ok: false, code: "INVALID_PAYMENT_AMOUNT" };
  }
  return { ok: true, cents };
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

// ─────────────────────────────────────────────────────────────────────────────
// Listagem de cobranças de uma assinatura (Fase 5b Task 10) — consumida por
// _shared/asaas.ts (listAsaasSubscriptionPayments) e, indiretamente, pelo
// worker de reconciliação process-asaas-invoice-reconcile (Task 11, ainda não
// implementado — este núcleo já existe pronto pra ele). Endpoint verificado
// em §13.2 de docs/billing-asaas/03-ASAAS-API-VERIFICADO.md:
// `GET /v3/subscriptions/{id}/payments`.
// ─────────────────────────────────────────────────────────────────────────────

/** Tamanho de página usado por listAsaasSubscriptionPayments. */
export const ASAAS_PAYMENT_LIST_PAGE_SIZE = 100;

/**
 * Teto de páginas que o cliente HTTP percorre antes de desistir e devolver
 * erro. Nenhuma assinatura real chega perto disso (mesmo semanal por décadas
 * não passaria de ~30 páginas) — o teto existe só pra não deixar um loop cujo
 * `hasMore` nunca vira `false` (bug do lado do Asaas, ou resposta corrompida
 * repetindo a mesma página) rodar pra sempre consumindo o rate limit da conta
 * inteira (§10: 25k req/12h, 50 GETs concorrentes). Ao ser atingido, o
 * cliente loga o evento e devolve `ok:false` — NUNCA devolve a coleção
 * parcial como se fosse a lista completa (mesmo princípio de
 * `parseAsaasPaymentListPage` abaixo: dado incompleto não pode se passar por
 * dado completo).
 */
export const ASAAS_PAYMENT_LIST_MAX_PAGES = 100;

/**
 * Um item de `GET /subscriptions/{id}/payments` — só os campos que o
 * reconciliador (Task 11) precisa pra diferenciar cobranças já refletidas no
 * banco das que faltam.
 */
export interface AsaasPaymentSummary {
  id: string;
  status: string;
  /** Em REAIS decimais crus do Asaas (§9.1) — NÃO é amount_cents. Converter
   * com `asaasValueToCents` na fronteira antes de comparar com uma coluna
   * `_cents` do banco; nunca comparar `value` diretamente com `amount_cents`. */
  value: number;
  /** YYYY-MM-DD */
  dueDate: string;
  billingType: string | null;
  /** Presente em cobrança nascida de assinatura; OMITIDO (não `null`) em
   * cobrança avulsa (§13.6) — os dois casos normalizam pra `null` aqui. */
  subscription: string | null;
  externalReference: string | null;
}

type ParsedAsaasPaymentSummary =
  | { valid: true; payment: AsaasPaymentSummary }
  | { valid: false; reason: string };

/**
 * Guard de um item bruto da lista. `id`/`status`/`dueDate` são a chave de
 * correlação com o banco pro reconciliador — ausentes ou de tipo errado
 * tornam o item inutilizável, então falham o item inteiro.
 *
 * `value` segue a MESMA régua de `parseAsaasAmountCents` acima: nunca ganha
 * fallback `?? 0`. Um `value` ausente/inválido faz o item inteiro falhar em
 * vez de virar uma cobrança fantasma de R$ 0,00 na reconciliação — mas ao
 * contrário de `parseAsaasAmountCents`, esta função NÃO converte pra
 * centavos: devolve `value` cru em reais, mesma convenção do resto de
 * `asaas.ts` (o cliente HTTP não converte unidade monetária na própria
 * fronteira — quem compara com `amount_cents` do banco converte na hora).
 *
 * `billingType`/`subscription`/`externalReference` são secundários (não
 * servem de chave de correlação) — presentes com tipo errado ou ausentes
 * normalizam pra `null` em vez de invalidar o item, mesmo padrão de
 * `dateCreated` em `parseAsaasWebhookEnvelope` acima.
 */
function parseAsaasPaymentSummary(raw: unknown): ParsedAsaasPaymentSummary {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { valid: false, reason: "item não é objeto" };
  }
  const obj = raw as Record<string, unknown>;

  const id = obj.id;
  if (typeof id !== "string" || !id.trim()) {
    return { valid: false, reason: "campo 'id' ausente ou não é string" };
  }

  const status = obj.status;
  if (typeof status !== "string" || !status.trim()) {
    return { valid: false, reason: "campo 'status' ausente ou não é string" };
  }

  const value = obj.value;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return { valid: false, reason: "campo 'value' ausente ou inválido" };
  }

  const dueDate = obj.dueDate;
  if (typeof dueDate !== "string" || !dueDate.trim()) {
    return { valid: false, reason: "campo 'dueDate' ausente ou não é string" };
  }

  const billingType = typeof obj.billingType === "string" ? obj.billingType : null;
  const subscription = typeof obj.subscription === "string" ? obj.subscription : null;
  const externalReference = typeof obj.externalReference === "string" ? obj.externalReference : null;

  return {
    valid: true,
    payment: { id, status, value, dueDate, billingType, subscription, externalReference },
  };
}

export type ParsedAsaasPaymentListPage =
  | { valid: true; payments: AsaasPaymentSummary[]; hasMore: boolean }
  | { valid: false; reason: string };

/**
 * Parseia uma página de `GET /subscriptions/{id}/payments`: `{ data: [...],
 * hasMore: boolean }` (convenção padrão de listagem do Asaas). Duas decisões
 * deliberadamente rígidas, ambas pelo mesmo motivo — dado incompleto/duvidoso
 * não pode se passar por dado completo pro reconciliador:
 *
 * 1. Um item malformado invalida A PÁGINA INTEIRA (não "pula e segue"). Uma
 *    lista com um buraco silencioso é o mesmo defeito que uma paginação
 *    truncada — o reconciliador criaria um "diff" que não reflete a
 *    realidade sem nenhum sinal de que algo foi descartado.
 * 2. `hasMore` ausente ou de tipo errado é ERRO, não `false` por default.
 *    Se o valor default fosse `false`, uma resposta corrompida faria o
 *    cliente HTTP parar de paginar achando que já leu tudo — exatamente o
 *    "capped scan que lê como cobertura completa" que este trecho existe
 *    pra evitar.
 */
export function parseAsaasPaymentListPage(raw: unknown): ParsedAsaasPaymentListPage {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { valid: false, reason: "resposta não é objeto" };
  }
  const obj = raw as Record<string, unknown>;

  const items = obj.data;
  if (!Array.isArray(items)) {
    return { valid: false, reason: "campo 'data' ausente ou não é array" };
  }

  const payments: AsaasPaymentSummary[] = [];
  for (let i = 0; i < items.length; i++) {
    const parsed = parseAsaasPaymentSummary(items[i]);
    if (parsed.valid === false) {
      return { valid: false, reason: `item ${i}: ${parsed.reason}` };
    }
    payments.push(parsed.payment);
  }

  const hasMore = obj.hasMore;
  if (typeof hasMore !== "boolean") {
    return { valid: false, reason: "campo 'hasMore' ausente ou não é boolean" };
  }

  return { valid: true, payments, hasMore };
}
