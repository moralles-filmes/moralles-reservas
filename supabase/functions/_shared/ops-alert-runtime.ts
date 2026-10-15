import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { alertIntervalElapsed, decideInboundAlerts, type InboundAlertUnit, type OpsAlertPayload } from './ops-alert-core.ts';
import { createOpsAlertSender } from './ops-alert-sender.ts';
import { MAX_PENDING_BACKLOG_AGE_MS } from './whatsapp-inbound-queue-core.ts';

export function createOpsAlerts(db: SupabaseClient, endpoint: string | undefined,
  log: (event: Record<string, unknown>) => void, fetchImpl: typeof fetch = fetch) {
  const send = createOpsAlertSender(endpoint, fetchImpl);
  async function observe(unitId?: string): Promise<{ now: string; units: InboundAlertUnit[] }> {
    const { data, error } = await db.rpc('observe_whatsapp_ops_alerts', { p_unit_id: unitId ?? null });
    if (error || !data || !Number.isFinite(Date.parse(data.now)) || !Array.isArray(data.units)) throw new Error('ops_observation_failed');
    return data;
  }
  async function deliver(payload: OpsAlertPayload, watermark: string | null) {
    const delivery = await send(payload);
    if (!delivery.delivered) {
      log({ evt: 'whatsapp_ops_alert', event: payload.event, unit_id: payload.unit_id, reason: delivery.reason });
      return delivery;
    }
    try {
      const { data, error } = await db.from('whatsapp_ops_alerts').upsert({ unit_id: payload.unit_id,
        alert_type: payload.event, last_sent_at: payload.generated_at, last_watermark: watermark },
      { onConflict: 'unit_id,alert_type' }).select('unit_id');
      if (error || data?.length !== 1) throw new Error('ledger_failed');
    } catch {
      log({ evt: 'whatsapp_ops_alert', event: payload.event, unit_id: payload.unit_id, reason: 'ledger_failed' });
      return { delivered: true, reason: 'ledger_failed' };
    }
    return delivery;
  }
  return {
    async inbound() {
      try {
        const observation = await observe();
        const alerts = decideInboundAlerts({ ...observation, maxBacklogAgeMs: MAX_PENDING_BACKLOG_AGE_MS });
        const results = [];
        for (const alert of alerts) results.push(await deliver(alert.payload, alert.newWatermark));
        return { attempted: alerts.length, results };
      } catch {
        log({ evt: 'whatsapp_ops_alert', reason: 'observation_failed' });
        return { attempted: 0, reason: 'observation_failed' };
      }
    },
    async subscriptionFailure(event: { unitId: string; channelId: string }) {
      // Alert failure never changes the remotely recorded subscription fact.
      try {
        const observation = await observe(event.unitId);
        const unit = observation.units.find(u => u.unitId === event.unitId);
        if (!unit) throw new Error('ops_observation_failed');
        if (!alertIntervalElapsed(observation.now, unit.lastSent.datafy_subscription_failed)) return;
        return await deliver({ event: 'datafy_subscription_failed', unit_id: event.unitId,
          channel_id: event.channelId, generated_at: observation.now }, null);
      } catch {
        log({ evt: 'whatsapp_ops_alert', event: 'datafy_subscription_failed', reason: 'observation_failed' });
      }
    },
  };
}
