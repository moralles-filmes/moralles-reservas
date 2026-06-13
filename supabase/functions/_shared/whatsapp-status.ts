// Parser de CALLBACK DE STATUS de mensagem (entregue/lido/falhou) — distinto da
// mensagem inbound do cliente (esse é o `parseInbound` em whatsapp-providers.ts).
//
// Os provedores mandam, no MESMO webhook, eventos de status DAS NOSSAS mensagens
// enviadas. Antes caíam em `ignored_non_text` e sumiam. Aqui detectamos e
// normalizamos pra o webhook atualizar `notifications_sent` (correlação por
// provider_message_id). Tolerante a variações de payload entre versões.

import type { WhatsAppProvider } from "./whatsapp-providers.ts";

export type DeliveryStatus = "sent" | "delivered" | "read" | "failed";

export interface StatusUpdate {
  providerMessageId: string;
  status: DeliveryStatus;
}

// deno-lint-ignore no-explicit-any
export function parseStatusCallback(provider: WhatsAppProvider, payload: any): StatusUpdate[] | null {
  try {
    if (provider === "zapi") return parseZApiStatus(payload);
    if (provider === "waha") return parseWahaStatus(payload);
    if (provider === "official") return parseOfficialStatus(payload);
    return null;
  } catch {
    return null;
  }
}

// ── Z-API ────────────────────────────────────────────────────────────────────
// { type:"MessageStatusCallback", status:"SENT|RECEIVED|READ|READ_BY_ME|PLAYED",
//   ids:["<messageId>"], phone:"55..." }
// deno-lint-ignore no-explicit-any
function parseZApiStatus(p: any): StatusUpdate[] | null {
  const type = String(p?.type ?? "");
  if (type !== "MessageStatusCallback" && type !== "DeliveryCallback") return null;
  const status = mapZApiStatus(String(p?.status ?? ""));
  if (!status) return null;
  const ids: string[] = Array.isArray(p?.ids)
    ? p.ids.filter((x: unknown): x is string => typeof x === "string" && !!x)
    : typeof p?.messageId === "string" && p.messageId
      ? [p.messageId]
      : [];
  if (!ids.length) return null;
  return ids.map((id) => ({ providerMessageId: id, status }));
}

function mapZApiStatus(s: string): DeliveryStatus | null {
  const u = s.toUpperCase();
  if (u === "RECEIVED") return "delivered";
  if (u === "READ" || u === "PLAYED") return "read";
  if (u === "SENT") return "sent";
  if (u.includes("FAIL") || u.includes("ERROR")) return "failed";
  return null; // READ_BY_ME e afins (leitura de mensagem RECEBIDA) → ignora
}

// ── WAHA ─────────────────────────────────────────────────────────────────────
// { event:"message.ack", payload:{ id:{_serialized}|string, ack:1|2|3, ackName } }
// ack: 1=server(sent) 2=device(delivered) 3=read 4=played -1=error
// deno-lint-ignore no-explicit-any
function parseWahaStatus(p: any): StatusUpdate[] | null {
  const event = String(p?.event ?? "");
  if (!event.includes("ack")) return null;
  const payload = p?.payload ?? {};
  const rawId = payload?.id?._serialized ?? payload?.id;
  const id = typeof rawId === "string" ? rawId : null;
  if (!id) return null;
  const status = mapWahaAck(
    typeof payload?.ack === "number" ? payload.ack : null,
    String(payload?.ackName ?? ""),
  );
  if (!status) return null;
  return [{ providerMessageId: id, status }];
}

function mapWahaAck(ack: number | null, ackName: string): DeliveryStatus | null {
  const n = ackName.toUpperCase();
  if (n === "ERROR") return "failed";
  if (n === "READ" || n === "PLAYED") return "read";
  if (n === "DEVICE") return "delivered";
  if (n === "SERVER") return "sent";
  if (ack === -1) return "failed";
  if (ack === 3 || ack === 4) return "read";
  if (ack === 2) return "delivered";
  if (ack === 1) return "sent";
  return null;
}

// ── Meta Cloud API (official) ────────────────────────────────────────────────
// { entry:[{ changes:[{ value:{ statuses:[{ id, status:"sent|delivered|read|failed" }] } }] }] }
// deno-lint-ignore no-explicit-any
function parseOfficialStatus(p: any): StatusUpdate[] | null {
  const statuses = p?.entry?.[0]?.changes?.[0]?.value?.statuses;
  if (!Array.isArray(statuses) || !statuses.length) return null;
  const out: StatusUpdate[] = [];
  for (const s of statuses) {
    const id = s?.id;
    const status = mapOfficialStatus(String(s?.status ?? ""));
    if (typeof id === "string" && id && status) out.push({ providerMessageId: id, status });
  }
  return out.length ? out : null;
}

function mapOfficialStatus(s: string): DeliveryStatus | null {
  const u = s.toLowerCase();
  if (u === "sent") return "sent";
  if (u === "delivered") return "delivered";
  if (u === "read") return "read";
  if (u === "failed") return "failed";
  return null;
}
