/** Janela de atendimento da Meta: somente inbound do cliente abre 24 horas. */
export const MANUAL_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
const TIMESTAMP_WITH_ZONE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

function validTimestamp(value: string): boolean {
  const parts = value.match(TIMESTAMP_WITH_ZONE);
  if (!parts) return false;
  const [, year, month, day, hour, minute, second, zoneHour, zoneMinute] = parts;
  if (+hour > 23 || +minute > 59 || +second > 59 || +(zoneHour ?? 0) > 23 || +(zoneMinute ?? 0) > 59) return false;
  const calendar = new Date(0);
  calendar.setUTCFullYear(+year, +month - 1, +day);
  return calendar.getUTCFullYear() === +year && calendar.getUTCMonth() + 1 === +month && calendar.getUTCDate() === +day;
}

export interface ManualServiceWindow {
  open: boolean;
  lastInboundAt: string | null;
  closesAt: string | null;
}

export function evaluateManualServiceWindow(messages: unknown, nowMs: number): ManualServiceWindow {
  const closed: ManualServiceWindow = { open: false, lastInboundAt: null, closesAt: null };
  if (!Array.isArray(messages) || !Number.isFinite(nowMs)) return closed;

  let latest = Number.NEGATIVE_INFINITY;
  for (const item of messages) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const message = item as Record<string, unknown>;
    if (message.role !== "user" || typeof message.timestamp !== "string"
      || !validTimestamp(message.timestamp)) continue;
    // JSONB can contain malformed or future timestamps. Neither is proof of
    // a customer contact at the server's current time.
    const at = Date.parse(message.timestamp);
    if (!Number.isFinite(at) || at > nowMs) continue;
    latest = Math.max(latest, at);
  }

  if (!Number.isFinite(latest)) return closed;
  const closesAt = latest + MANUAL_SERVICE_WINDOW_MS;
  return {
    open: nowMs < closesAt,
    lastInboundAt: new Date(latest).toISOString(),
    closesAt: new Date(closesAt).toISOString(),
  };
}
