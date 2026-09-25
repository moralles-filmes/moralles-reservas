/**
 * Núcleo puro da ingestão assíncrona (Fase C).
 *
 * TODA decisão que a Fase C inventa mora aqui, e não no `index.ts` do
 * `webhook-whatsapp`: o vitest não importa aquela Edge Function (`serve()` no
 * carregamento + imports de `deno.land`), e regra que só se confere por
 * leitura já passou defeito duas vezes neste repo.
 *
 * Sem I/O, sem `Deno`, sem cliente Supabase. Só decisão.
 */

import { DATAFY_SIGNATURE_HEADER } from "./datafy-signature-core.ts";
import type { WebhookSignatureScheme } from "./whatsapp-provider-core.ts";

/** De onde veio a invocação. NÃO é o provider — é a porta de entrada. */
export type IngestionSource = "provider" | "queue" | "sweep";

/**
 * `unknown` NÃO é "não sei, então OFF". É "não consigo afirmar", e o caller
 * traduz em 503. Tratar leitura falha de gate como OFF processaria síncrono e
 * estouraria o orçamento do provider sem deixar rastro.
 */
export type IngestionMode = "async" | "sync" | "unknown";

export type InsertOutcome = "inserted" | "duplicate" | "failed" | "skipped";

export type AckVerdict =
  | { kind: "passthrough" }
  | { kind: "ack"; status: 200; outcome: string }
  | { kind: "retry"; status: 503; outcome: string };

/** Escada de retentativa da fila. Curta e rasa de propósito — ver header. */
export const INBOUND_RETRY_DELAYS_MS = [30_000, 120_000, 300_000] as const;
export const INBOUND_MAX_ATTEMPTS = INBOUND_RETRY_DELAYS_MS.length;

/** TTL do lease da linha. Espelha o takeover de `processed_messages`. */
export const INBOUND_LEASE_TTL_MS = 90_000;

/** Orçamento do deadline suave, contado do início do PROCESSAMENTO. */
export const AGENT_SOFT_DEADLINE_MS = 30_000;
/** Pior turno único medido: Gemini primary (12s+backoff) + fallback (12s+backoff). */
export const WORST_SINGLE_TURN_MS = 31_000;
/** Folga para sanitização, envio e append depois do loop. */
export const POST_LOOP_SEND_MS = 5_000;

export const PURGE_DONE_AFTER_DAYS = 7;
export const PURGE_DEAD_AFTER_DAYS = 30;

/** Espelha o CHECK de `delivery_id` da migration 111 (`length(btrim(delivery_id)) between 1 and 512`) — mudar um dos dois sem o outro é o começo do drift. */
const MAX_DELIVERY_ID_LEN = 512;

/**
 * As DUAS pernas do gate, mais a guarda anti-laço.
 *
 * `source !== "provider"` é a única coisa que impede a re-entrada a partir da
 * fila de persistir o evento de novo — laço infinito, o defeito mais perigoso
 * disponível neste desenho. Ele vive aqui, e não como um `if` solto no
 * handler, justamente para ter teste com controle positivo.
 *
 * As duas pernas são deliberadamente ASSIMÉTRICAS quanto a sinal de falha de
 * leitura, e isso não é descuido:
 *
 * - A perna da FLAG precisa de `flagReadFailed` porque `checkFlagEnabled`
 *   devolve `{ enabled, readFailed }`, e no call site uma leitura falha da
 *   flag é indistinguível de "a flag existe e está OFF" — sem o campo
 *   separado, as duas colapsam no mesmo `false`.
 * - A perna do CANAL não tem sinal equivalente porque uma leitura falha do
 *   canal já é TERMINAL rio acima de onde este gate é chamado: em
 *   `webhook-whatsapp/index.ts:1587`, `if (channelErr || !channel)` devolve
 *   404 antes de qualquer código chegar perto da resolução do gate (~linha
 *   1728). Fora isso, a coluna é `not null default false` — o banco
 *   fisicamente não devolve `null`. Logo `channelEnabled: null | undefined`
 *   só pode significar UMA coisa: o SELECT do caller não pediu a coluna, um
 *   defeito diferente (já rastreado à parte), não uma falha de leitura em
 *   trânsito.
 *
 * Consequência explícita: se algum dia este gate for movido para ANTES da
 * resolução do canal, ou a coluna virar nullable, a perna do canal passa a
 * ter um modo de falha genuíno e esta função precisa ganhar um parâmetro
 * `channelReadFailed`, no mesmo molde de `flagReadFailed`. Até lá, adicionar
 * esse parâmetro criaria um branch inalcançável e uma falsa sensação de
 * cobertura.
 */
export function decideIngestionMode(input: {
  source: IngestionSource;
  flagEnabled: boolean;
  flagReadFailed: boolean;
  channelEnabled: boolean | null | undefined;
}): IngestionMode {
  if (input.source !== "provider") return "sync";
  if (input.flagReadFailed) return "unknown";
  if (!input.flagEnabled) return "sync";
  if (input.channelEnabled !== true) return "sync";
  return "async";
}

/**
 * Régua herdada do `asaas-webhook`, adaptada ao contrato da Datafy:
 * 200 = já está durável ou foi descartado de propósito;
 * não-200 = não consegui guardar, reentrega.
 */
export function decideAckVerdict(input: {
  mode: IngestionMode;
  insert: InsertOutcome;
}): AckVerdict {
  if (input.mode === "unknown") {
    return { kind: "retry", status: 503, outcome: "queue_gate_unreadable" };
  }
  if (input.mode === "sync") return { kind: "passthrough" };
  if (input.insert === "inserted") {
    return { kind: "ack", status: 200, outcome: "queued" };
  }
  if (input.insert === "duplicate") {
    return { kind: "ack", status: 200, outcome: "queue_duplicate_delivery" };
  }
  return { kind: "retry", status: 503, outcome: "queue_insert_failed" };
}

/**
 * String vazia NÃO pode virar chave de dedupe: o unique é parcial
 * (`where delivery_id is not null`) e `''` não é null, então duas entregas
 * distintas com header vazio colidiriam e a segunda sumiria como "duplicata".
 */
export function normalizeDeliveryId(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_DELIVERY_ID_LEN) return null;
  return trimmed;
}

/**
 * Header do id de entrega da Datafy. Constante exportada porque o webhook
 * também o instrumenta (FORMA, nunca valor) — duas digitações do mesmo nome de
 * header em arquivos diferentes é o começo do drift.
 */
export const DATAFY_DELIVERY_ID_HEADER = "x-datafy-delivery-id";

/**
 * Só a Datafy declara id de entrega hoje. Providers legados não têm, e para
 * eles `processed_messages (provider, message_id)` segue sendo a autoridade
 * de idempotência — exatamente como já é.
 */
export function deliveryDedupeKey(
  provider: string,
  headerGet: (name: string) => string | null,
): string | null {
  if (provider !== "datafy") return null;
  return normalizeDeliveryId(headerGet(DATAFY_DELIVERY_ID_HEADER));
}

/**
 * Header que carrega a assinatura, por ESQUEMA — não por provider.
 *
 * Existe para preencher `whatsapp_inbound_events.signature_header`, que é
 * AUDITORIA e não autoridade: nada decide nada a partir dele. Fica chaveado
 * pelo tipo `WebhookSignatureScheme` (e não por `Record<string, string>`)
 * porque assim um esquema novo sem entrada aqui reprova no `tsc -b` que
 * alcança este arquivo pelo teste em `src/lib/` — enquanto o `index.ts` do
 * webhook, onde este mapa nasceria, não é alcançado por compilador nenhum.
 *
 * A entrada da Datafy vem da constante canônica de `datafy-signature-core.ts`,
 * que é quem VALIDA esse header: uma fonte só. As outras duas são literais
 * porque não existe constante equivalente — `x-hub-signature-256` está inline
 * em `validateMetaSignature` e `x-webhook-secret` em `validateChannelSecret`
 * (`_shared/whatsapp-providers.ts`). Extrair as duas agora obrigaria redeploy
 * de nove Edge Functions por causa de um campo de auditoria; o teste deste
 * núcleo pina os três valores no lugar disso.
 *
 * `channel_secret` também aceita `?secret=` na querystring. Nesse caso o header
 * é ausente e a coluna fica `null`, de propósito: guardar o valor da
 * querystring persistiria uma credencial VIVA numa linha de tabela.
 */
export const SIGNATURE_HEADER_BY_SCHEME: Readonly<Record<WebhookSignatureScheme, string>> = {
  meta_app_secret: "x-hub-signature-256",
  datafy_whsec: DATAFY_SIGNATURE_HEADER,
  channel_secret: "x-webhook-secret",
};

/**
 * Corpo cru → literal `bytea` do Postgres.
 *
 * `bytea` e não `text` porque Postgres recusa `\u0000` em `text` (22021), e um
 * único inbound com NUL faria o INSERT falhar, virar 503, e o provider
 * reentregar até desistir. A revalidação de assinatura exige o byte exato, e
 * é por isso que o corpo nunca é re-serializado por `JSON.parse`/`stringify`
 * em lugar nenhum deste caminho.
 */
export function encodeRawBodyHex(bodyText: string): string {
  const bytes = new TextEncoder().encode(bodyText);
  let hex = "\\x";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/**
 * Inverso de `encodeRawBodyHex`, para a re-entrada a partir da fila. Aceita com
 * e sem o prefixo `\x` porque quem devolve o valor é o PostgREST, não nós.
 *
 * Hex de comprimento ímpar faz `new Uint8Array` estourar `RangeError`, e isso é
 * DESEJADO: corpo truncado não pode virar payload silenciosamente diferente do
 * que o provider assinou. Quem chama está dentro de um `try/catch` que
 * transforma a exceção em retentativa da linha.
 */
export function decodeRawBodyHex(hex: string): string {
  const clean = hex.startsWith("\\x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return new TextDecoder().decode(bytes);
}

/** `null` significa: esgotou, promove para `dead`. */
export function nextAttemptDelayMs(attempts: number): number | null {
  if (!Number.isFinite(attempts) || attempts < 0) return null;
  if (attempts >= INBOUND_MAX_ATTEMPTS) return null;
  return INBOUND_RETRY_DELAYS_MS[attempts];
}

/**
 * Suave: impede COMEÇAR nova rodada de ferramenta, nunca aborta a em curso.
 * Abortar depois de `create_reservation` deixaria reserva criada e cliente sem
 * resposta — o risco que o `mutatingToolUsed` de hoje já tenta cobrir.
 */
export function agentDeadlineVerdict(input: {
  startedAt: number;
  now: number;
  budgetMs?: number;
}): "continue" | "stop_new_rounds" {
  const budget = input.budgetMs ?? AGENT_SOFT_DEADLINE_MS;
  const elapsed = input.now - input.startedAt;
  if (!Number.isFinite(elapsed) || elapsed < 0) return "continue";
  return elapsed >= budget ? "stop_new_rounds" : "continue";
}

/**
 * O TTL do lock de conversa deixa de ser adivinhado.
 *
 * `AI_LOCK_TTL_SECONDS = 90` foi dimensionado contra "~51s de pior caso do
 * runOnce" — que era pior caso de UM turno, não do loop de até 12. Esta função
 * existe para que um teste reprove quem subir o orçamento sem subir o TTL.
 */
export function lockTtlSecondsRequired(input?: { budgetMs?: number }): number {
  const budget = input?.budgetMs ?? AGENT_SOFT_DEADLINE_MS;
  return Math.ceil((budget + WORST_SINGLE_TURN_MS + POST_LOOP_SEND_MS) / 1000);
}
