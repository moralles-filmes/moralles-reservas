import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createTemplateEventService, type EventCatalogIdentity } from './whatsapp-template-events-core.ts';
type DatabaseRow = Record<string, unknown>;
function isRow(value: unknown): value is DatabaseRow {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function stringColumn(row: DatabaseRow, key: string): string {
  if (typeof row[key] !== 'string' || !row[key]) throw new Error('template_binding_unavailable');
  return row[key];
}
function revisionColumn(row: DatabaseRow, key: string): number {
  if (typeof row[key] !== 'number' || !Number.isSafeInteger(row[key]) || row[key] < 0) throw new Error('template_binding_unavailable');
  return row[key];
}
/** Runtime wiring has no import-time I/O and no provider/flag/CRM dependencies. */
export function createTemplateEventRuntime(db: SupabaseClient) {
  return createTemplateEventService({
    async loadAuthority(channel) {
      const { data: binding, error: be } = await db.from('whatsapp_template_bindings')
        .select('id,generation,account_id,channel_id,unit_id,provider,verified_at,channel_credential_revision')
        .eq('channel_id', channel.id).eq('unit_id', channel.unit_id).maybeSingle();
      if (be) throw new Error('template_binding_unavailable');
      if (!isRow(binding) || !binding.account_id) return null;
      const [{ data: account, error: ae }, { data: unit, error: ue }, { data: current, error: ce }] = await Promise.all([
        db.from('whatsapp_template_accounts').select('id,waba_id,organization_id,binding_generation').eq('id', stringColumn(binding, 'account_id')).maybeSingle(),
        db.from('units').select('organization_id').eq('id', channel.unit_id).maybeSingle(),
        db.from('whatsapp_channels').select('id,unit_id,provider,credentials,template_credential_revision')
          .eq('id', channel.id).eq('unit_id', channel.unit_id).eq('provider', channel.provider).maybeSingle(),
      ]);
      if (ae || ue || ce) throw new Error('template_binding_unavailable');
      if (!isRow(account) || !isRow(unit) || !isRow(current)) return null;
      const credentials = current.credentials;
      if (!credentials || typeof credentials !== 'object' || !('phone_number_id' in credentials)
        || typeof credentials.phone_number_id !== 'string') return null;
      return { bindingId: stringColumn(binding, 'id'), bindingGeneration: revisionColumn(binding, 'generation'),
        accountGeneration: revisionColumn(account, 'binding_generation'), accountId: stringColumn(account, 'id'), wabaId: stringColumn(account, 'waba_id'),
        organizationId: stringColumn(account, 'organization_id'), unitOrganizationId: stringColumn(unit, 'organization_id'),
        channelId: stringColumn(binding, 'channel_id'), unitId: stringColumn(binding, 'unit_id'),
        provider: stringColumn(binding, 'provider'), phoneNumberId: credentials.phone_number_id,
        verifiedAt: binding.verified_at === null ? null : stringColumn(binding, 'verified_at'),
        credentialRevision: revisionColumn(current, 'template_credential_revision'),
        bindingCredentialRevision: revisionColumn(binding, 'channel_credential_revision') };
    },
    async loadCatalog(accountId) {
      const catalog: EventCatalogIdentity[] = [];
      for (let start = 0; ; start += 500) {
        const { data, error } = await db.from('whatsapp_remote_templates').select('remote_id,name,language')
          .eq('account_id', accountId).order('id').range(start, start + 499);
        if (error || !Array.isArray(data) || !data.every(isRow)) throw new Error('template_catalog_unavailable');
        for (const row of data) {
          catalog.push({ remote_id: row.remote_id === null ? null : stringColumn(row, 'remote_id'),
            name: stringColumn(row, 'name'), language: stringColumn(row, 'language') });
        }
        if (data.length < 500) return catalog;
      }
    },
    async persistTemplateEvents({ capture, events }) {
      const { data, error } = await db.rpc('record_whatsapp_template_events_fenced', { p_capture: capture, p_events: events });
      if (error || typeof data !== 'number' || !Number.isInteger(data) || data < 0 || data > events.length) throw new Error('template_events_unavailable');
    },
  });
}
