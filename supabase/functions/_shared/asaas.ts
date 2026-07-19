/**
 * Cliente HTTP do Asaas (Fase 2 billing-asaas). Espelha o formato de retorno
 * de stripe-billing.ts (`{ ok, status, data }`, nunca lança em não-2xx) mas
 * NÃO copia o encoding: JSON + header `access_token` cru, nada de
 * `URLSearchParams`/`Bearer` (§8 de docs/billing-asaas/03-ASAAS-API-VERIFICADO.md).
 *
 * Fase 2 — nenhuma EF importa este módulo ainda diretamente; é consumido por
 * AsaasBillingProvider (_shared/billing-provider.ts, também Fase 2) — chega
 * numa EF de fato quando `asaas-webhook`/`process-asaas-reconcile` (Fase 2)
 * forem implementadas. Este arquivo NÃO lê platform_flags — `asaas_enabled`
 * existe na tabela mas quem decide se o provider Asaas é chamado é a camada
 * acima (Task 3+), não este cliente HTTP.
 *
 * Ao importar este módulo numa EF nova, adicionar ao checklist de redeploy
 * do CLAUDE.md (mesma seção de stripe-config.ts/stripe-billing.ts).
 */

import { genRequestId, jsonLog } from "./security.ts";
import { getAsaasApiKey, getAsaasBaseUrl, getAsaasEnv } from "./asaas-config.ts";
import {
  GET_MAX_RETRIES,
  parseAsaasError,
  parseRateLimitReset,
  shouldRetryGet,
  shouldRetryMutation,
  validateKeyForEnv,
} from "./asaas-core.ts";

// Identifica a aplicação nas chamadas — obrigatório em contas Asaas criadas a
// partir de 13/06/2024 (§8); o fetch do Deno não manda User-Agent por padrão.
const ASAAS_USER_AGENT = "moralles-reservas";

// Timeout por tentativa individual de rede (não é orçamento acumulado do GET
// com retry — cada `fetch` isolado aborta sozinho nesse teto). Quando o caller
// passa `budgetMs` (ver AsaasRequestOptions) este teto vira o LIMITE SUPERIOR:
// a tentativa é capada pelo que sobra do orçamento.
const ASAAS_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Opções por chamada. `budgetMs` é o orçamento de wall-clock TOTAL que o
 * CALLER tolera gastar nesta requisição — tentativa inicial, retries e sleeps
 * de rate limit somados.
 *
 * Existe porque o orçamento é do caller, não do cliente HTTP: o `asaas-webhook`
 * precisa responder dentro dos 10s que o Asaas concede (§2 de
 * docs/billing-asaas/03-ASAAS-API-VERIFICADO.md) — estourar conta como FALHA de
 * entrega, e 15 seguidas INTERROMPEM a fila de eventos de todos os clientes,
 * que é apagada em 14 dias. Sem orçamento, um único GET lento (15s por
 * tentativa × 3 tentativas + backoff + até 30s honrando `RateLimit-Reset`)
 * arrasta a resposta muito além disso, e sob rajada o efeito é
 * auto-amplificante (§10 limita 50 GETs concorrentes; o 429 faz todo mundo
 * dormir junto).
 *
 * Já os workers de cron (`process-asaas-reconcile`) NÃO passam `budgetMs`:
 * rodam sem cliente esperando e devem manter os retries completos.
 *
 * Só o caminho GET honra o orçamento. O caminho mutante é deixado de fora de
 * propósito: o Asaas não tem `Idempotency-Key` (§11), então abortar um
 * POST/PUT/DELETE no meio deixaria o outcome desconhecido — e nenhum caminho
 * com orçamento apertado é mutante hoje.
 */
export interface AsaasRequestOptions {
  budgetMs?: number;
}

// Devolve o signal JUNTO com `clear` — o caller precisa desarmar o timer
// assim que o `fetch` resolver (headers recebidos). Sem isso o timer segue
// armado contra o MESMO controller enquanto o body é lido (`res.json()`
// alhures); se a leitura cruzar os `ms` restantes, o parse aborta em vez de
// completar (ver uso em fetchAsaasGet/fetchAsaasMutation).
function timeoutSignal(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// Política de retry — LER ANTES DE "SIMPLIFICAR" ISTO PRA UM RETRY SÓ
//
// O Asaas NÃO tem Idempotency-Key (§11 da doc verificada) — diferente da
// Stripe. Um retry cego de POST/PUT/DELETE que sofreu timeout pode ter sido
// processado do lado do Asaas mesmo assim (ex.: cobrança criada, mas a
// resposta não chegou a tempo); repetir cegamente pode DUPLICAR uma cobrança
// real. `_shared/retry.ts` (fetchWithRetry) não serve pro caminho mutante:
// seu catch de erro de rede reentra incondicionalmente, sem passar pelo
// `retryOn` (ver o arquivo) — por isso o caminho mutante abaixo é
// implementado à parte, sem importar fetchWithRetry, em vez de forçar ou
// deformar o retry.ts (outros consumidores dependem dele).
//
// - GET é idempotente por natureza → retry normal em 5xx/429/erro de rede.
// - POST/PUT/DELETE → NUNCA retry em 5xx nem em timeout/erro de rede (outcome
//   desconhecido = trata como falha, não repete). A ÚNICA reentrada permitida
//   é em 429: rate limit rejeitou a requisição ANTES de processar nada, então
//   repetir é seguro. Espera por `RateLimit-Reset` quando o header vier,
//   senão backoff exponencial com teto.
//
// A decisão de QUAL status entra em retry (por status+attempt, sem I/O) vive
// em shouldRetryMutation/shouldRetryGet (./asaas-core.ts) — pinada por teste
// puro em src/lib/asaas-core.test.ts. É o invariante de dinheiro desta
// integração: um catch que engolisse o fetch mutante não seria pego por esse
// teste (é estrutural, ver comentário no loop abaixo), só por revisão manual.
//
// A espera por `RateLimit-Reset` (429) tem teto (RATE_LIMIT_WAIT_CAP_MS):
// acima dele o reset informado pelo servidor levaria o sleep além da vida do
// isolate da Edge Function, que seria matado no meio da espera de qualquer
// jeito — sem responder ao caller e sem reconciliar nada no banco. Nesse caso
// desiste e devolve o 429 pro caller em vez de dormir. Não há risco de
// duplicar cobrança em nenhum dos dois casos — 429 nunca processou nada.
// ─────────────────────────────────────────────────────────────────────────────

const GET_BACKOFF_BASE_MS = 1000;
const MUTATION_BACKOFF_BASE_MS = 1000;

// Teto compartilhado de quanto este cliente tolera dormir esperando um
// `RateLimit-Reset` do Asaas (mutação E get) — acima disso o isolate da Edge
// Function pode morrer no meio do sleep (limite de wall-clock da plataforma)
// antes do reset acontecer. Também serve de teto pro backoff exponencial
// puro do caminho mutante (fallback quando o header não vem).
const RATE_LIMIT_WAIT_CAP_MS = 30_000;

type RateLimitWait =
  | { kind: "none" }
  | { kind: "wait"; ms: number }
  | { kind: "give_up"; resetSeconds: number };

/**
 * Traduz `RateLimit-Reset` (§10) num veredito: sem header → "none" (caller
 * usa seu próprio backoff); dentro do teto → "wait" com o delay exato; acima
 * do teto → "give_up" — dormir isso mataria o isolate no meio do sleep sem
 * chegar a reentrar. Nenhum dos casos arrisca duplicar cobrança: 429
 * significa que nada foi processado do lado do Asaas.
 */
function resolveRateLimitWait(headerValue: string | null): RateLimitWait {
  const resetSeconds = parseRateLimitReset(headerValue);
  if (resetSeconds === null) return { kind: "none" };
  const ms = resetSeconds * 1000;
  return ms > RATE_LIMIT_WAIT_CAP_MS ? { kind: "give_up", resetSeconds } : { kind: "wait", ms };
}

/**
 * `deadlineAt` é o instante (epoch ms) em que o orçamento do caller acaba, ou
 * `null` quando não há orçamento (comportamento histórico: retries completos).
 * É FALHA RÁPIDA de propósito, nunca trabalho em background: quem pediu o GET
 * precisa saber que ele não aconteceu para degradar o resultado (no webhook,
 * virar `failed` e deixar o reconcile retentar). Uma continuação depois da
 * resposta poderia ser morta com o isolate, trocando uma falha visível por uma
 * silenciosa.
 */
async function fetchAsaasGet(
  url: string,
  init: RequestInit,
  reqId: string,
  path: string,
  deadlineAt: number | null,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= GET_MAX_RETRIES; attempt++) {
    // Cada tentativa é capada pelo que SOBRA do orçamento — o teto de 15s só
    // vale integralmente quando não há orçamento. Sem esse `min`, uma única
    // tentativa lenta já estouraria sozinha o limite do caller.
    const budgetLeftMs = deadlineAt === null ? null : deadlineAt - Date.now();
    if (budgetLeftMs !== null && budgetLeftMs <= 0) {
      jsonLog("warn", { evt: "asaas_get_budget_exhausted", reqId, path, attempt: attempt + 1, phase: "before_fetch" });
      throw lastError ?? new Error("Orçamento de tempo esgotado antes da chamada ao Asaas.");
    }
    const attemptTimeoutMs = budgetLeftMs === null
      ? ASAAS_REQUEST_TIMEOUT_MS
      : Math.min(ASAAS_REQUEST_TIMEOUT_MS, budgetLeftMs);

    const { signal, clear } = timeoutSignal(attemptTimeoutMs);
    try {
      const res = await fetch(url, { ...init, signal });
      clear();
      if (!shouldRetryGet(res.status, attempt)) return res;

      let delayMs = GET_BACKOFF_BASE_MS * 2 ** attempt + Math.random() * GET_BACKOFF_BASE_MS;
      if (res.status === 429) {
        // 429 é o único status com um sinal de espera real do servidor
        // (§10) — honrar em vez de backoff cego evita queimar tentativas
        // contra uma janela que só reseta bem depois.
        const wait = resolveRateLimitWait(res.headers.get("RateLimit-Reset"));
        if (wait.kind === "give_up") {
          jsonLog("warn", { evt: "asaas_get_rate_limit_exceeds_cap", reqId, path, attempt: attempt + 1, reset_seconds: wait.resetSeconds });
          return res;
        }
        if (wait.kind === "wait") delayMs = wait.ms;
      }
      // Dormir além do orçamento é EXATAMENTE o cenário auto-amplificante que
      // o `budgetMs` existe pra cortar: numa rajada, todas as invocações levam
      // 429 e honram o mesmo `RateLimit-Reset` juntas, todas passam dos 10s do
      // Asaas e a fila é interrompida. Devolve a resposta que já temos e deixa
      // o caller degradar.
      if (deadlineAt !== null && Date.now() + delayMs >= deadlineAt) {
        jsonLog("warn", { evt: "asaas_get_budget_exhausted", reqId, path, attempt: attempt + 1, status: res.status, phase: "before_retry_sleep" });
        return res;
      }
      jsonLog("warn", { evt: "asaas_get_retry", reqId, path, attempt: attempt + 1, status: res.status, delay_ms: Math.round(delayMs) });
      await sleep(delayMs);
    } catch (err) {
      clear();
      lastError = err;
      if (attempt === GET_MAX_RETRIES) throw err;
      const delayMs = GET_BACKOFF_BASE_MS * 2 ** attempt + Math.random() * GET_BACKOFF_BASE_MS;
      // Mesmo motivo do branch acima — aqui o erro (inclusive o AbortError do
      // timeout capado) precisa propagar pro caller em vez de virar mais um
      // sleep dentro de um orçamento que já acabou.
      if (deadlineAt !== null && Date.now() + delayMs >= deadlineAt) {
        jsonLog("warn", { evt: "asaas_get_budget_exhausted", reqId, path, attempt: attempt + 1, error: String(err), phase: "before_retry_sleep" });
        throw err;
      }
      jsonLog("warn", { evt: "asaas_get_retry", reqId, path, attempt: attempt + 1, error: String(err), delay_ms: Math.round(delayMs) });
      await sleep(delayMs);
    }
  }
  // Inalcançável: o loop sempre retorna ou lança no último attempt acima.
  throw lastError ?? new Error("fetchAsaasGet: esgotou tentativas sem resposta");
}

async function fetchAsaasMutation(url: string, init: RequestInit, reqId: string, path: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    // Erro de rede/timeout aqui propaga (throw) direto pro caller — nunca
    // capturado/reentrado. Ver comentário da política de retry acima.
    const { signal, clear } = timeoutSignal(ASAAS_REQUEST_TIMEOUT_MS);
    const res = await fetch(url, { ...init, signal });
    clear();
    if (!shouldRetryMutation(res.status, attempt)) return res;

    const wait = resolveRateLimitWait(res.headers.get("RateLimit-Reset"));
    if (wait.kind === "give_up") {
      // Reset reportado (ex.: 12h, dentro da janela de 25k req/12h do §10)
      // excede o teto que o isolate aguenta esperar vivo — dormir até lá
      // mataria a invocação no meio do sleep, sem resposta amigável pro
      // caller e sem reconciliação no banco. Desiste e devolve o 429 pro
      // caller decidir; sem risco de duplicar cobrança (429 não processou
      // nada do lado do Asaas).
      jsonLog("warn", { evt: "asaas_mutation_rate_limit_exceeds_cap", reqId, path, attempt: attempt + 1, reset_seconds: wait.resetSeconds });
      return res;
    }
    const delayMs = wait.kind === "wait" ? wait.ms : Math.min(MUTATION_BACKOFF_BASE_MS * 2 ** attempt, RATE_LIMIT_WAIT_CAP_MS);
    jsonLog("warn", { evt: "asaas_mutation_rate_limited", reqId, path, attempt: attempt + 1, delay_ms: Math.round(delayMs) });
    await sleep(delayMs);
  }
}

/**
 * Request helper central. Nunca lança em resposta não-2xx — quem chama olha
 * `.ok`. Chave ausente/mal configurada não lança: o guard `blocked` abaixo já
 * devolve `ok:false` cedo. Erro de rede real também é capturado e traduzido
 * pra `{ok:false, status:0}` — este helper nunca lança pro caller.
 */
export async function asaasRequest(
  path: string,
  method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
  body?: Record<string, unknown>,
  opts?: AsaasRequestOptions,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const reqId = genRequestId();
  // Deadline fixado ANTES da resolução da chave: `getAsaasApiKey` lê
  // `platform_secrets` (com cache) e um miss de cache também gasta tempo do
  // orçamento do caller — deixá-lo de fora subestimaria o custo real.
  const deadlineAt = opts?.budgetMs !== undefined ? Date.now() + opts.budgetMs : null;
  const env = getAsaasEnv();
  const apiKey = await getAsaasApiKey();

  const validation = validateKeyForEnv(apiKey, env);
  if (validation.status === "blocked") {
    jsonLog("error", { evt: "asaas_request_blocked", reqId, method, path, error: validation.error });
    return { ok: false, status: 0, data: { error: validation.error } };
  }
  if (validation.status === "inconclusive") {
    jsonLog("warn", { evt: "asaas_key_env_inconclusive", reqId, method, path, warning: validation.warning });
  }

  const url = `${getAsaasBaseUrl()}${path}`;
  const init: RequestInit = {
    method,
    headers: {
      access_token: apiKey,
      "Content-Type": "application/json",
      "User-Agent": ASAAS_USER_AGENT,
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  let res: Response;
  try {
    res = method === "GET"
      // Só o GET recebe o deadline — ver AsaasRequestOptions: abortar mutação
      // sem `Idempotency-Key` deixaria o outcome desconhecido.
      ? await fetchAsaasGet(url, init, reqId, path, deadlineAt)
      : await fetchAsaasMutation(url, init, reqId, path);
  } catch (err) {
    jsonLog("error", { evt: "asaas_request_network_error", reqId, method, path, error: String(err) });
    return { ok: false, status: 0, data: { error: "Falha de conexão com o Asaas." } };
  }

  const data = (await res.json().catch((err) => {
    // Nunca deixar o parse falhar em silêncio: sem log aqui, um POST que
    // criou a cobrança de verdade mas cujo body não deu tempo de ser lido
    // (signal já cancelado, ver timeoutSignal) devolveria {ok:true,
    // paymentId:undefined} sem nenhum rastro do id perdido.
    jsonLog("error", { evt: "asaas_response_parse_error", reqId, method, path, status: res.status, error: String(err) });
    return {};
  })) as Record<string, unknown>;
  if (!res.ok) {
    const message = parseAsaasError(data, `Erro Asaas (status ${res.status}).`);
    jsonLog("error", { evt: "asaas_request_error", reqId, method, path, status: res.status, error: message });
  } else {
    jsonLog("info", { evt: "asaas_request_ok", reqId, method, path, status: res.status });
  }

  return { ok: res.ok, status: res.status, data };
}

// ── Customers (§9) ───────────────────────────────────────────────────────────
// `name`/`cpfCnpj` obrigatórios no Asaas — tipados como required aqui de
// propósito. Validar presença com mensagem PT-BR pro usuário é responsabilidade
// do AsaasBillingProvider (Fase 3): este cliente só encaminha pro Asaas.

export interface AsaasCustomerParams {
  name: string;
  cpfCnpj: string;
  email?: string;
  externalReference?: string;
}

export async function createAsaasCustomer(
  params: AsaasCustomerParams,
): Promise<{ ok: boolean; customerId?: string; error?: string }> {
  const res = await asaasRequest("/customers", "POST", { ...params });
  if (!res.ok) return { ok: false, error: parseAsaasError(res.data, "Falha ao criar cliente no Asaas.") };
  return { ok: true, customerId: res.data.id as string };
}

export async function getAsaasCustomer(
  customerId: string,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  return asaasRequest(`/customers/${customerId}`, "GET");
}

export async function updateAsaasCustomer(
  customerId: string,
  params: Partial<AsaasCustomerParams>,
): Promise<{ ok: boolean; error?: string }> {
  const res = await asaasRequest(`/customers/${customerId}`, "PUT", { ...params });
  if (!res.ok) return { ok: false, error: parseAsaasError(res.data, "Falha ao atualizar cliente no Asaas.") };
  return { ok: true };
}

// ── Payments (§9) ────────────────────────────────────────────────────────────

export type AsaasBillingType = "UNDEFINED" | "BOLETO" | "CREDIT_CARD" | "PIX";

export interface AsaasPaymentParams {
  customer: string;
  billingType: AsaasBillingType;
  /** Reais decimais (ex.: `19.90` = R$ 19,90), NÃO centavos — CONFIRMADO em
   * §9.1 de 03-ASAAS-API-VERIFICADO.md. Quem chama (AsaasBillingProvider,
   * Fase 3) converte na fronteira: enviando, `value = amountCents / 100`;
   * lendo de volta, `amountCents = Math.round(value * 100)` (o `Math.round`
   * evita drift de float). Este cliente passa `value` cru de propósito — não
   * converte aqui. */
  value: number;
  /** YYYY-MM-DD */
  dueDate: string;
  description?: string;
  externalReference?: string;
}

export async function createAsaasPayment(params: AsaasPaymentParams): Promise<{
  ok: boolean;
  paymentId?: string;
  status?: string;
  invoiceUrl?: string;
  bankSlipUrl?: string;
  error?: string;
}> {
  const res = await asaasRequest("/payments", "POST", { ...params });
  if (!res.ok) return { ok: false, error: parseAsaasError(res.data, "Falha ao criar cobrança no Asaas.") };
  return {
    ok: true,
    paymentId: res.data.id as string,
    status: res.data.status as string | undefined,
    invoiceUrl: res.data.invoiceUrl as string | undefined,
    bankSlipUrl: res.data.bankSlipUrl as string | undefined,
  };
}

/**
 * `opts.budgetMs` existe pro caminho do `asaas-webhook`, que tem 10s de teto
 * do Asaas pra responder — ver AsaasRequestOptions. Workers de cron chamam sem
 * `opts` e mantêm os retries completos.
 */
export async function getAsaasPayment(
  paymentId: string,
  opts?: AsaasRequestOptions,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  return asaasRequest(`/payments/${paymentId}`, "GET", undefined, opts);
}

export async function refundAsaasPayment(
  paymentId: string,
  params?: { value?: number; description?: string },
): Promise<{ ok: boolean; error?: string }> {
  const res = await asaasRequest(`/payments/${paymentId}/refund`, "POST", params ? { ...params } : undefined);
  if (!res.ok) return { ok: false, error: parseAsaasError(res.data, "Falha ao estornar cobrança no Asaas.") };
  return { ok: true };
}

export async function getAsaasPixQrCode(paymentId: string): Promise<{
  ok: boolean;
  encodedImage?: string;
  payload?: string;
  expirationDate?: string;
  error?: string;
}> {
  const res = await asaasRequest(`/payments/${paymentId}/pixQrCode`, "GET");
  if (!res.ok) return { ok: false, error: parseAsaasError(res.data, "Falha ao obter QR code Pix.") };
  return {
    ok: true,
    encodedImage: res.data.encodedImage as string | undefined,
    payload: res.data.payload as string | undefined,
    expirationDate: res.data.expirationDate as string | undefined,
  };
}

// ── Subscriptions (§9) ───────────────────────────────────────────────────────
// status só tem 3 valores (ACTIVE/EXPIRED/INACTIVE) — não existe
// cancel_at_period_end no Asaas; mapeamento fica no AsaasBillingProvider (Fase 3).

export type AsaasCycle =
  | "WEEKLY"
  | "BIWEEKLY"
  | "MONTHLY"
  | "BIMONTHLY"
  | "QUARTERLY"
  | "SEMIANNUALLY"
  | "YEARLY";

export interface AsaasSubscriptionParams {
  customer: string;
  billingType: AsaasBillingType;
  /** Reais decimais (ex.: `19.90` = R$ 19,90), NÃO centavos — CONFIRMADO em
   * §9.1 de 03-ASAAS-API-VERIFICADO.md. Mesma conversão de
   * AsaasPaymentParams.value: enviando, `value = amountCents / 100`; lendo de
   * volta, `amountCents = Math.round(value * 100)`. Cliente passa cru, sem
   * converter. */
  value: number;
  /** YYYY-MM-DD */
  nextDueDate: string;
  cycle: AsaasCycle;
  description?: string;
  externalReference?: string;
}

export async function createAsaasSubscription(
  params: AsaasSubscriptionParams,
): Promise<{ ok: boolean; subscriptionId?: string; error?: string }> {
  const res = await asaasRequest("/subscriptions", "POST", { ...params });
  if (!res.ok) return { ok: false, error: parseAsaasError(res.data, "Falha ao criar assinatura no Asaas.") };
  return { ok: true, subscriptionId: res.data.id as string };
}

export async function getAsaasSubscription(
  subscriptionId: string,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  return asaasRequest(`/subscriptions/${subscriptionId}`, "GET");
}

export async function updateAsaasSubscription(
  subscriptionId: string,
  params: Partial<Pick<AsaasSubscriptionParams, "value" | "nextDueDate" | "billingType" | "description">> & {
    status?: "ACTIVE" | "INACTIVE";
  },
): Promise<{ ok: boolean; error?: string }> {
  const res = await asaasRequest(`/subscriptions/${subscriptionId}`, "PUT", { ...params });
  if (!res.ok) return { ok: false, error: parseAsaasError(res.data, "Falha ao atualizar assinatura no Asaas.") };
  return { ok: true };
}

export async function deleteAsaasSubscription(
  subscriptionId: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await asaasRequest(`/subscriptions/${subscriptionId}`, "DELETE");
  if (!res.ok) return { ok: false, error: parseAsaasError(res.data, "Falha ao remover assinatura no Asaas.") };
  return { ok: true };
}

// ── Checkout (§9) ────────────────────────────────────────────────────────────
// Página hospedada (não paymentLinks). billingTypes só aceita CREDIT_CARD/PIX.

export interface AsaasCheckoutItem {
  /** máx 30 chars */
  name: string;
  quantity: number;
  /** Reais decimais, NÃO centavos — mesma convenção CONFIRMADA dos demais
   * `value` da API (§9.1 de 03-ASAAS-API-VERIFICADO.md), mas ESTE campo
   * específico (`items[].value` do checkout) segue sem prova decisiva: a doc
   * só mostra `"value": 100` sem casa decimal — §9.1 marca como NÃO
   * VERIFICADO, testar `19.90` no sandbox antes da Fase 4. Mesma conversão
   * dos demais: `value = amountCents / 100` / `amountCents = Math.round(value
   * * 100)`. */
  value: number;
  /** máx 150 chars */
  description?: string;
  /** OpenAPI do Asaas lista como obrigatório no array `items` — NÃO VERIFICADO
   * em runtime (§9/§13 da doc). Opcional aqui; confirmar no sandbox antes da
   * Fase 4 antes de assumir que pode ser omitido. */
  imageBase64?: string;
}

export interface AsaasCheckoutCallback {
  successUrl: string;
  cancelUrl: string;
  expiredUrl?: string;
}

export interface AsaasCheckoutParams {
  billingTypes: Array<"CREDIT_CARD" | "PIX">;
  chargeTypes: Array<"DETACHED" | "RECURRENT" | "INSTALLMENT">;
  callback: AsaasCheckoutCallback;
  items: AsaasCheckoutItem[];
  /** Id do cliente Asaas (`cus_...`) que este checkout deve amarrar. INFERIDO
   * do shape de resposta da sonda de 2026-07-19 ao POST /v3/checkouts, que
   * devolveu `"customer": null` e `"customerData": null` no corpo — os campos
   * existem no recurso, faltava modelá-los aqui. Sem enviá-lo, o Asaas cria um
   * cliente próprio a partir do que o pagador digitar e o `asaas_customer_id`
   * que gravamos vira órfão, matando o fallback de correlação do webhook
   * (`_shared/asaas-billing-events-apply.ts`, `.eq("asaas_customer_id", ...)`).
   * Confirmação ao vivo fica pra Task 13. */
  customer?: string;
  /** Obrigatório quando chargeTypes inclui RECURRENT (§9) — shape exato não
   * detalhado em 03-ASAAS-API-VERIFICADO.md. */
  subscription?: Record<string, unknown>;
  /** 10–1440 */
  minutesToExpire?: number;
  /** máx 200 */
  externalReference?: string;
}

export async function createAsaasCheckout(params: AsaasCheckoutParams): Promise<{
  ok: boolean;
  checkoutId?: string;
  link?: string;
  status?: string;
  error?: string;
}> {
  const res = await asaasRequest("/checkouts", "POST", { ...params });
  if (!res.ok) return { ok: false, error: parseAsaasError(res.data, "Falha ao criar checkout no Asaas.") };
  return {
    ok: true,
    checkoutId: res.data.id as string | undefined,
    link: res.data.link as string | undefined,
    status: res.data.status as string | undefined,
  };
}
