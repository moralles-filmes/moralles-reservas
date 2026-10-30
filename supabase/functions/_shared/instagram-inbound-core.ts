/**
 * Núcleo puro do worker do Direct (`process-instagram-inbound`, Task 4.1).
 * Sem Deno, sem rede, sem Supabase: o Vitest importa direto. O `index.ts` da
 * EF é o adapter de I/O; as decisões ficam aqui.
 *
 * - `extractAccountItems`: itens do corpo guardado na fila, só das entradas da
 *   conta da linha (`entry.id === ig_user_id`), ordenados por `timestamp`. O
 *   corpo inteiro traz entradas de outras contas (e de outras lojas): elas
 *   nunca viram item aqui.
 * - `isEchoOwn`: eco cujo `mid` saiu por nós (está em `provider_message_ids`
 *   de uma mensagem `assistant`/`human` da conversa do contato).
 * - `sendInstagramParts`: envio dividido por bytes que NUNCA lança.
 * - `mapContactReservationRpc`: retorno da RPC atômica de reserva → hook do
 *   `reserveSlot`.
 */
import type { GraphResult } from "./instagram-graph.ts";
import { isGraphOutcomeUnknown } from "./instagram-graph-core.ts";
import { splitInstagramText } from "./instagram-format.ts";
import type { ChannelSendResult } from "./agent/channel-context.ts";

/** Retenção do ledger `instagram_processed_messages` (gêmeo da purga na migration da fila). */
export const INSTAGRAM_PROCESSED_RETENTION_DAYS = 30;

/** Rate limit por contato do Direct (`check_rate_limit('ig:'||igsid, 60, 10, unit_id)`). */
export const INSTAGRAM_CONTACT_RATE_LIMIT = { windowSeconds: 60, max: 10 } as const;

export function instagramRateLimitKey(igsid: string): string {
  return `ig:${igsid}`;
}

export type InstagramIgnoredReason = "deleted" | "unsupported" | "non_message" | "self" | "malformed";

export type InstagramItem =
  | { kind: "text"; mid: string; igsid: string; text: string; timestamp: number }
  | { kind: "media"; mid: string; igsid: string; timestamp: number }
  | { kind: "story_mention"; mid: string; igsid: string; timestamp: number }
  | { kind: "echo"; mid: string; igsid: string; timestamp: number }
  | { kind: "ignored"; mid: string | null; reason: InstagramIgnoredReason };

/** Desfecho gravado para item ignorado (casa com o CHECK `^[a-z0-9_]{1,64}$`). */
export function ignoredOutcome(reason: InstagramIgnoredReason): string {
  return `ignored_${reason}`;
}

export const STORY_MENTION_OUTCOME = "ignored_story_mention";

const IG_ID = /^[0-9]{1,64}$/;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Id do IG como string; número só se for inteiro seguro (17 dígitos perdem precisão). */
function igId(v: unknown): string | null {
  if (typeof v === "string") {
    const t = v.trim();
    return IG_ID.test(t) ? t : null;
  }
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return String(v);
  return null;
}

function midOf(v: unknown): string | null {
  return typeof v === "string" && v.length >= 1 && v.length <= 512 ? v : null;
}

function classify(m: Record<string, unknown>, igUserId: string): InstagramItem {
  const message = m.message;
  if (!isObj(message)) {
    // Leitura, reação, postback, referral: nada a responder.
    return { kind: "ignored", mid: null, reason: "non_message" };
  }
  const mid = midOf(message.mid);
  if (mid === null) return { kind: "ignored", mid: null, reason: "malformed" };
  if (message.is_deleted === true) return { kind: "ignored", mid, reason: "deleted" };
  if (message.is_unsupported === true) return { kind: "ignored", mid, reason: "unsupported" };

  const ts = typeof m.timestamp === "number" && Number.isFinite(m.timestamp) ? m.timestamp : 0;
  const sender = igId(isObj(m.sender) ? m.sender.id : null);
  const recipient = igId(isObj(m.recipient) ? m.recipient.id : null);

  if (message.is_echo === true) {
    // Eco: a conta enviou; o contato é o destinatário.
    if (recipient === null) return { kind: "ignored", mid, reason: "malformed" };
    return { kind: "echo", mid, igsid: recipient, timestamp: ts };
  }
  if (sender === null) return { kind: "ignored", mid, reason: "malformed" };
  if (sender === igUserId) return { kind: "ignored", mid, reason: "self" };

  if (typeof message.text === "string" && message.text.trim() !== "") {
    // Com ou sem `reply_to` (resposta a story com texto é texto, S7).
    return { kind: "text", mid, igsid: sender, text: message.text, timestamp: ts };
  }
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  if (attachments.length > 0) {
    const allStory = attachments.every((a) => isObj(a) && a.type === "story_mention");
    return allStory
      ? { kind: "story_mention", mid, igsid: sender, timestamp: ts }
      : { kind: "media", mid, igsid: sender, timestamp: ts };
  }
  return { kind: "ignored", mid, reason: "unsupported" };
}

/**
 * Itens da conta `igUserId` no corpo, ordenados por `timestamp` (estável).
 * Corpo malformado, de outro `object` ou sem entrada da conta devolve `[]`;
 * nunca lança. Item sem `timestamp` legível ordena como 0.
 */
export function extractAccountItems(body: unknown, igUserId: string): InstagramItem[] {
  try {
    if (!isObj(body) || body.object !== "instagram" || !Array.isArray(body.entry)) return [];
    const out: { item: InstagramItem; ts: number; seq: number }[] = [];
    let seq = 0;
    for (const entry of body.entry) {
      if (!isObj(entry) || igId(entry.id) !== igUserId) continue;
      if (!Array.isArray(entry.messaging)) continue;
      for (const m of entry.messaging) {
        if (!isObj(m)) continue;
        const ts = typeof m.timestamp === "number" && Number.isFinite(m.timestamp) ? m.timestamp : 0;
        out.push({ item: classify(m, igUserId), ts, seq: seq++ });
      }
    }
    return out.sort((a, b) => a.ts - b.ts || a.seq - b.seq).map((x) => x.item);
  } catch {
    return [];
  }
}

/** O eco tem o `mid` de uma mensagem que nós (IA, automação ou atendente pelo painel) enviamos. */
export function isEchoOwn(messages: unknown, mid: string): boolean {
  if (!Array.isArray(messages)) return false;
  return messages.some((m) =>
    isObj(m) &&
    (m.role === "assistant" || m.role === "human") &&
    Array.isArray(m.provider_message_ids) &&
    m.provider_message_ids.includes(mid)
  );
}

export interface InstagramSendOutcome {
  result: ChannelSendResult;
  /** `messageId` das partes que saíram, na ordem. */
  messageIds: string[];
  /** O Graph respondeu `reauth_required` (código 190): o adapter marca a conta. */
  reauthRequired: boolean;
}

/**
 * Divide com `splitInstagramText`, envia na ordem e para na primeira falha
 * (`ok` só com todas). NUNCA lança: exceção do envio vira
 * `provider_transport_error`.
 *
 * Desfecho desconhecido (`isGraphOutcomeUnknown`: 2xx ilegível, sem HTTP ou
 * `transient` em POST) vira `error: "provider_timeout"`, o rótulo de timeout
 * do núcleo: a parte pode ter saído, então não se reenvia, e o núcleo não
 * devolve a janela do lembrete de handoff (que reenviaria).
 */
export async function sendInstagramParts(
  text: string,
  sendPart: (part: string) => Promise<GraphResult<{ messageId: string }>>,
): Promise<InstagramSendOutcome> {
  const messageIds: string[] = [];
  try {
    const parts = splitInstagramText(text);
    if (parts.length === 0) return { result: { ok: false, error: "empty_text" }, messageIds, reauthRequired: false };
    for (const part of parts) {
      const r = await sendPart(part);
      if (r.ok === true) {
        messageIds.push(r.value.messageId);
        continue;
      }
      if (isGraphOutcomeUnknown(r, "POST")) {
        return {
          result: { ok: false, error: "provider_timeout", ...(typeof r.httpStatus === "number" ? { status: r.httpStatus } : {}) },
          messageIds,
          reauthRequired: false,
        };
      }
      return {
        result: { ok: false, error: r.errorClass, ...(typeof r.httpStatus === "number" ? { status: r.httpStatus } : {}) },
        messageIds,
        reauthRequired: r.errorClass === "reauth_required",
      };
    }
    return { result: { ok: true, status: 200 }, messageIds, reauthRequired: false };
  } catch {
    return { result: { ok: false, error: "provider_transport_error" }, messageIds, reauthRequired: false };
  }
}

/**
 * Código que o hook da porta devolve quando a RPC recusa pelo teto de reservas
 * ativas do contato (`P0001 instagram_contact_reservation_limit`). O núcleo
 * (`tools.ts`) o reconhece e devolve ao LLM uma mensagem fixa própria.
 */
export const RESERVATION_LIMIT_ERROR_CODE = "instagram_contact_reservation_limit";

/**
 * Retorno de `create_instagram_contact_reservation` → contrato do hook
 * `insertReservation`. Só o `code` do Postgres atravessa (23505 dispara o
 * retry de mesa do `reserveSlot`); a mensagem só serve para reconhecer o teto.
 */
export function mapContactReservationRpc(
  data: unknown,
  error: { code?: unknown; message?: unknown } | null | undefined,
): { data: { id: string; status: string; payment_status: string | null } | null; error: { code?: string } | null } {
  if (error) {
    const code = typeof error.code === "string" ? error.code : undefined;
    if (code === "P0001" && typeof error.message === "string" && error.message.includes("instagram_contact_reservation_limit")) {
      return { data: null, error: { code: RESERVATION_LIMIT_ERROR_CODE } };
    }
    return { data: null, error: code ? { code } : {} };
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (
    isObj(row) && typeof row.id === "string" && typeof row.status === "string" &&
    (row.payment_status === null || typeof row.payment_status === "string")
  ) {
    return { data: { id: row.id, status: row.status, payment_status: row.payment_status as string | null }, error: null };
  }
  return { data: null, error: { code: "no_row" } };
}
