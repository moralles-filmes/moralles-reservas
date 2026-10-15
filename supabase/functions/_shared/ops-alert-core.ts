export type AlertType = 'inbound_dead_letter' | 'inbound_backlog_stalled' | 'datafy_subscription_failed';
export type OpsAlertPayload = {
  event: AlertType; unit_id: string; channel_id: string | null;
  count?: number; oldest_age_seconds?: number; generated_at: string;
};
export const OPS_ALERT_MIN_INTERVAL_MS = 30 * 60_000;
export interface InboundAlertUnit {
  unitId: string; channelId: string | null; newDeadSince: number;
  deadWatermark: string | null; oldestNonTerminalAt: string | null;
  lastSent: Partial<Record<AlertType, string>>;
}
export function alertIntervalElapsed(now: string, last: string | undefined, interval = OPS_ALERT_MIN_INTERVAL_MS) {
  const time = Date.parse(now);
  return Number.isFinite(time) && (last === undefined || time - Date.parse(last) >= interval);
}
export function decideInboundAlerts(input: {
  now: string; units: InboundAlertUnit[]; maxBacklogAgeMs: number; minIntervalMs?: number;
}) {
  const alerts: { unitId: string; type: AlertType; payload: OpsAlertPayload; newWatermark: string | null }[] = [];
  for (const unit of input.units) {
    const base = { unit_id: unit.unitId, channel_id: unit.channelId, generated_at: input.now };
    if (Number.isFinite(unit.newDeadSince) && unit.newDeadSince > 0 && unit.deadWatermark
      && alertIntervalElapsed(input.now, unit.lastSent.inbound_dead_letter, input.minIntervalMs)) {
      alerts.push({ unitId: unit.unitId, type: 'inbound_dead_letter', newWatermark: unit.deadWatermark,
        payload: { ...base, event: 'inbound_dead_letter', count: unit.newDeadSince } });
    }
    const age = Date.parse(input.now) - Date.parse(unit.oldestNonTerminalAt ?? '');
    if (Number.isFinite(age) && age > input.maxBacklogAgeMs
      && alertIntervalElapsed(input.now, unit.lastSent.inbound_backlog_stalled, input.minIntervalMs)) {
      alerts.push({ unitId: unit.unitId, type: 'inbound_backlog_stalled', newWatermark: null,
        payload: { ...base, event: 'inbound_backlog_stalled', oldest_age_seconds: Math.floor(age / 1000) } });
    }
  }
  return alerts;
}
