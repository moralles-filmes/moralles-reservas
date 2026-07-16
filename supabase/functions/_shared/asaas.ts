/**
 * Cliente HTTP do Asaas (Fase 2 billing-asaas). Espelha o formato de retorno
 * de stripe-billing.ts (`{ ok, status, data }`, nunca lança em não-2xx) mas
 * NÃO copia o encoding: JSON + header `access_token` cru, nada de
 * `URLSearchParams`/`Bearer` (§8 de docs/billing-asaas/03-ASAAS-API-VERIFICADO.md).
 *
 * Fase 2 — nenhuma EF importa este módulo ainda (chega na Fase 3, via
 * AsaasBillingProvider em _shared/billing-provider.ts). Este arquivo NÃO lê
 * platform_flags — `asaas_enabled` existe na tabela mas quem decide se o
 * provider Asaas é chamado é a camada acima (Task 3+), não este cliente HTTP.
 *
 * Ao importar este módulo numa EF nova, adicionar ao checklist de redeploy
 * do CLAUDE.md (mesma seção de stripe-config.ts/stripe-billing.ts).
 */

import { genRequestId, jsonLog } from "./security.ts";
import { getAsaasApiKey, getAsaasBaseUrl, getAsaasEnv } from "./asaas-config.ts";
import { parseAsaasError, parseRateLimitReset, validateKeyForEnv } from "./asaas-core.ts";

// Identifica a aplicação nas chamadas — obrigatório em contas Asaas criadas a
// partir de 13/06/2024 (§8); o fetch do Deno não manda User-Agent por padrão.
const ASAAS_USER_AGENT = "moralles-reservas";

// Timeout por tentativa individual de rede (não é orçamento acumulado do GET
// com retry — cada `fetch` isolado aborta sozinho nesse teto).
const ASAAS_REQUEST_TIMEOUT_MS = 15_000;

function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
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
// ─────────────────────────────────────────────────────────────────────────────

const GET_MAX_RETRIES = 2;
const GET_BACKOFF_BASE_MS = 1000;
const GET_RETRYABLE_STATUS = (status: number) => status >= 500 || status === 429;

async function fetchAsaasGet(url: string, init: RequestInit, reqId: string, path: string): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= GET_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: timeoutSignal(ASAAS_REQUEST_TIMEOUT_MS) });
      if (!GET_RETRYABLE_STATUS(res.status) || attempt === GET_MAX_RETRIES) return res;
      const delayMs = GET_BACKOFF_BASE_MS * 2 ** attempt + Math.random() * GET_BACKOFF_BASE_MS;
      jsonLog("warn", { evt: "asaas_get_retry", reqId, path, attempt: attempt + 1, status: res.status, delay_ms: Math.round(delayMs) });
      await sleep(delayMs);
    } catch (err) {
      lastError = err;
      if (attempt === GET_MAX_RETRIES) throw err;
      const delayMs = GET_BACKOFF_BASE_MS * 2 ** attempt + Math.random() * GET_BACKOFF_BASE_MS;
      jsonLog("warn", { evt: "asaas_get_retry", reqId, path, attempt: attempt + 1, error: String(err), delay_ms: Math.round(delayMs) });
      await sleep(delayMs);
    }
  }
  // Inalcançável: o loop sempre retorna ou lança no último attempt acima.
  throw lastError ?? new Error("fetchAsaasGet: esgotou tentativas sem resposta");
}

const MUTATION_RATE_LIMIT_RETRIES = 3;
const MUTATION_BACKOFF_BASE_MS = 1000;
const MUTATION_BACKOFF_CAP_MS = 30_000;

async function fetchAsaasMutation(url: string, init: RequestInit, reqId: string, path: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    // Erro de rede/timeout aqui propaga (throw) direto pro caller — nunca
    // capturado/reentrado. Ver comentário da política de retry acima.
    const res = await fetch(url, { ...init, signal: timeoutSignal(ASAAS_REQUEST_TIMEOUT_MS) });
    if (res.status !== 429 || attempt >= MUTATION_RATE_LIMIT_RETRIES) return res;

    const resetSeconds = parseRateLimitReset(res.headers.get("RateLimit-Reset"));
    const delayMs = resetSeconds !== null
      ? resetSeconds * 1000
      : Math.min(MUTATION_BACKOFF_BASE_MS * 2 ** attempt, MUTATION_BACKOFF_CAP_MS);
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
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const reqId = genRequestId();
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
      ? await fetchAsaasGet(url, init, reqId, path)
      : await fetchAsaasMutation(url, init, reqId, path);
  } catch (err) {
    jsonLog("error", { evt: "asaas_request_network_error", reqId, method, path, error: String(err) });
    return { ok: false, status: 0, data: { error: "Falha de conexão com o Asaas." } };
  }

  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
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
  /** Valor no formato nativo do Asaas — unidade (reais decimais vs. centavos)
   * não confirmada em 03-ASAAS-API-VERIFICADO.md; conversão a partir de
   * amountCents (centavos, convenção interna) é responsabilidade de quem
   * chama (AsaasBillingProvider, Fase 3) — validar no sandbox antes de usar. */
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

export async function getAsaasPayment(
  paymentId: string,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  return asaasRequest(`/payments/${paymentId}`, "GET");
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
