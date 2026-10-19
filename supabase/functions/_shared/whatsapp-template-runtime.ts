import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getWhatsAppProvider } from './whatsapp-providers.ts';
import { clearWhatsAppGateCache, resolveWhatsAppGateByUnit } from './whatsapp-service-gate.ts';
import { createTemplateAccountService, type TemplateChannel } from './whatsapp-template-account.ts';
import { createTemplateSyncService, selectTemplateBindings, type TemplateBindingCandidate, type TemplateSyncContext, type TemplateSyncEpoch, type TemplateProvisionJob, type StoredTemplate } from './whatsapp-template-sync.ts';
import { createTemplateWorker, createTemplateAlertSender, type TemplateWorkerJob, type TemplatePipelineHealth } from './whatsapp-template-worker.ts';
import { catalogHash } from './whatsapp-template-catalog-core.ts';
import { jsonLog, requireInternalAuth } from './security.ts';
import { readCurrentBooleanFlag } from './platform-flags.ts';
import { createTemplatePreparationService, type TemplatePreparationClaim, type TemplatePreparationChannel,
  type TemplatePreparationSnapshot, type TemplatePreparationBinding } from './whatsapp-template-preparation.ts';
import { refreshVerifiedDatafyTemplateHealth } from './whatsapp-template-health.ts';

/** Thin I/O wiring. All orchestration/decisions are the same factories imported by tests. */
export function createTemplateRuntime(db: SupabaseClient) {
  async function rpc<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const { data, error } = await db.rpc(name, args);
    if (error) throw new Error('template_database_failed');
    return data as T;
  }
  async function flag(): Promise<boolean> {
    const result = await readCurrentBooleanFlag(db, 'whatsapp_template_catalog');
    if (result.readFailed) throw new Error('template_flag_failed');
    return result.enabled;
  }
  async function loadChannel(channelId: string): Promise<TemplateChannel | null> {
    const { data, error } = await db.from('whatsapp_channels')
      .select('id,unit_id,provider,credentials,template_credential_revision,status,is_active,last_health_check_at')
      .eq('id', channelId).maybeSingle();
    if (error) throw new Error('template_channel_failed');
    return data;
  }
  const accounts = createTemplateAccountService({ loadChannel, getProvider: getWhatsAppProvider,
    bind: input => rpc('bind_whatsapp_template_account', { p_channel_id: input.channelId, p_unit_id: input.unitId,
      p_provider: input.provider, p_credential_revision: input.credentialRevision, p_phone_number_id: input.phoneNumberId, p_waba_id: input.wabaId }) });

  async function load(accountId: string, bindingId?: string): Promise<TemplateSyncContext> {
    const { data: account, error: ae } = await db.from('whatsapp_template_accounts').select('id,waba_id').eq('id', accountId).single();
    const { data: bindings, error: be } = await db.from('whatsapp_template_bindings')
      .select('id,unit_id,channel_id,provider,generation,channel_credential_revision,submission_authorized_at,verified_at')
      .eq('account_id', accountId).eq('provider', 'datafy').not('verified_at', 'is', null).order('id');
    if (ae || be || !account) throw new Error('template_binding_unavailable');
    const candidates: TemplateBindingCandidate[] = [];
    for (const binding of bindings ?? []) {
      if (bindingId && binding.id !== bindingId) continue;
      const channel = await loadChannel(binding.channel_id) as TemplateBindingCandidate['channel'];
      candidates.push({ ...binding, channel });
    }
    const { chosen, provisionBindingId } = selectTemplateBindings(candidates, bindingId);
    const channel = chosen?.channel;
    if (!chosen || !channel) throw new Error('template_binding_unavailable');
    const templates: StoredTemplate[] = [];
    const jobs: TemplateProvisionJob[] = [];
    for (let start = 0; ; start += 500) {
      const { data, error } = await db.from('whatsapp_remote_templates').select('*').eq('account_id', accountId).order('id').range(start, start + 499);
      if (error) throw new Error('template_load_failed');
      templates.push(...(data ?? [])); if ((data ?? []).length < 500) break;
    }
    for (let start = 0; ; start += 500) {
      const { data, error } = await db.from('whatsapp_template_jobs').select('id,target_key,state,claim_token,binding_id,binding_generation,posting_started_at')
        .eq('account_id', accountId).eq('operation', 'provision').order('id').range(start, start + 499);
      if (error) throw new Error('template_load_failed');
      jobs.push(...(data ?? [])); if ((data ?? []).length < 500) break;
    }
    return { accountId, wabaId: account.waba_id, bindingId: chosen.id, generation: chosen.generation,
      unitId: chosen.unit_id, channelId: chosen.channel_id, credentialRevision: chosen.channel_credential_revision,
      credentials: channel.credentials, catalogEnabled: await flag(), submissionAuthorized: !!chosen.submission_authorized_at, provisionBindingId, templates, jobs };
  }
  const sync = createTemplateSyncService({ load,
    getTransport: () => {
      const provider = getWhatsAppProvider('datafy');
      if (!provider.capabilities.templateManagement || !provider.listTemplates || !provider.createTemplate) throw new Error('template_account_unsupported');
      return { listTemplates: provider.listTemplates, createTemplate: provider.createTemplate };
    },
    seed: async (accountId, definitions) => {
      const { data: a, error } = await db.from('whatsapp_template_accounts').select('binding_generation').eq('id', accountId).single();
      if (error) throw new Error('template_seed_failed');
      const rows = await Promise.all(definitions.map(async d => ({ account_id: accountId, logical_id: d.id, name: d.name,
        version: d.version, language: d.language, desired_hash: await catalogHash(d), requested_category: d.requestedCategory,
        binding_generation: a.binding_generation })));
      const { error: insertError } = await db.from('whatsapp_remote_templates').upsert(rows, { onConflict: 'account_id,logical_id,version,language', ignoreDuplicates: true });
      if (insertError) throw new Error('template_seed_failed');
    },
    begin: accountId => rpc<TemplateSyncEpoch>('begin_whatsapp_template_sync', { p_account_id: accountId }),
    publish: (accountId, epoch, snapshot) => rpc('publish_whatsapp_template_sync', { p_account_id: accountId,
      p_account_generation: epoch.account_generation, p_epochs: epoch, p_snapshot: snapshot }),
    enqueueProvision: async (bindingId, d) => { await rpc('enqueue_whatsapp_template_job', {
      p_binding_id: bindingId, p_operation: 'provision', p_target_key: d.id, p_revision: d.version }); },
    prepare: (job, payloadHash) => rpc('prepare_whatsapp_template_provision', { p_job_id: job.id, p_fence: job.claim_token,
      p_generation: job.binding_generation, p_payload_hash: payloadHash }),
    confirm: (job, payloadHash) => rpc('confirm_whatsapp_template_post', { p_job_id: job.id, p_fence: job.claim_token,
      p_generation: job.binding_generation, p_payload_hash: payloadHash }),
    prePostCheck: (job, payloadHash) => rpc('check_whatsapp_template_submission', { p_job_id: job.id, p_fence: job.claim_token,
      p_generation: job.binding_generation, p_payload_hash: payloadHash }),
    finish: (id, fence, result) => rpc('finish_whatsapp_template_job', { p_job_id: id, p_fence: fence, p_result: result }),
    finalCheck: async context => {
      try {
        clearWhatsAppGateCache();
        const gate = await resolveWhatsAppGateByUnit(db, context.unitId);
        if (gate?.enforced.sending) return 'final_service_suspended';
        const current = await load(context.accountId, context.bindingId);
        if (current.bindingId !== context.bindingId || current.channelId !== context.channelId || current.generation !== context.generation
          || current.credentialRevision !== context.credentialRevision) return 'final_channel_changed';
        if (!current.catalogEnabled || !current.submissionAuthorized) return 'final_gate_paused';
        return null;
      } catch { return 'final_channel_changed'; }
    },
  });
  const sendAlert = createTemplateAlertSender(Deno.env.get('WHATSAPP_TEMPLATE_ALERT_URL'));
  async function preparationSnapshot(unitId: string, channelId: string): Promise<TemplatePreparationSnapshot> {
    const value = await rpc<unknown>('get_whatsapp_template_preparation', { p_unit_id: unitId, p_channel_id: channelId });
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('template_preparation_unavailable');
    const row = value as Record<string, unknown>;
    if (!['eligible', 'disabled', 'legacy', 'excluded'].includes(String(row.enrollment))
      || ![null, 'pending', 'discovering', 'ready', 'needs_review'].includes(row.state as string | null)
      || (row.onboarding_id !== null && row.onboarding_id !== undefined && typeof row.onboarding_id !== 'string')
      || (row.onboarding_state !== null && row.onboarding_state !== undefined && typeof row.onboarding_state !== 'string')
      || (row.next_attempt_at !== null && typeof row.next_attempt_at !== 'string'))
      throw new Error('template_preparation_unavailable');
    return row as unknown as TemplatePreparationSnapshot;
  }
  const preparation = createTemplatePreparationService({
    now: Date.now,
    read: preparationSnapshot,
    loadChannel: async id => await loadChannel(id) as TemplatePreparationChannel | null,
    refreshHealth: async channel => {
      const current = await loadChannel(channel.id);
      if (!current || current.unit_id !== channel.unit_id || current.provider !== 'datafy'
        || current.template_credential_revision !== channel.template_credential_revision) throw new Error('template_channel_changed');
      const adapter = getWhatsAppProvider('datafy');
      if (!adapter.cloudApiRequest) throw new Error('template_health_unsupported');
      await refreshVerifiedDatafyTemplateHealth({
        expectedPhoneNumberId: current.credentials.phone_number_id,
        requestMe: () => adapter.cloudApiRequest!(current.credentials, { method: 'GET', path: 'me' }),
        recordConnected: async () => {
          const recorded = await rpc<boolean>('record_whatsapp_template_heartbeat', {
            p_unit_id: channel.unit_id, p_channel_id: channel.id,
            p_expected_revision: current.template_credential_revision,
            p_expected_phone_number_id: current.credentials.phone_number_id,
          });
          if (!recorded) throw new Error('template_channel_changed');
        },
      });
    },
    ensureAccount: async channelId => { await accounts.ensureTemplateAccount(channelId); },
    loadBinding: async channelId => {
      const { data, error } = await db.from('whatsapp_template_bindings')
        .select('id,account_id,generation,channel_credential_revision,verified_at')
        .eq('channel_id', channelId).maybeSingle();
      if (error) throw new Error('template_binding_failed');
      return data as TemplatePreparationBinding | null;
    },
    authorize: (claim, binding) => rpc<boolean>('authorize_whatsapp_template_auto_channel', {
      p_onboarding_id: claim.onboarding_id, p_binding_id: binding.id, p_generation: binding.generation,
      p_credential_revision: claim.credential_revision }),
    requestSync: async accountId => {
      const id = await rpc<string | null>('request_whatsapp_template_sync', { p_account_id: accountId });
      if (!id) throw new Error('template_sync_unavailable');
    },
    mark: (claim, state, reason) => rpc<boolean>('mark_whatsapp_template_preparation', {
      p_onboarding_id: claim.onboarding_id, p_channel_id: claim.channel_id,
      p_state: state, p_reason_code: reason }),
  });
  const worker = createTemplateWorker({ authenticate: requireInternalAuth, now: Date.now,
    selectPreparations: async () => {
      const claims = await rpc<TemplatePreparationClaim[]>('claim_due_whatsapp_template_preparations', { p_limit: 1 });
      if (!Array.isArray(claims)) throw new Error('template_preparation_selector_failed');
      return claims;
    },
    prepareChannel: claim => preparation.prepare(claim, true),
    selectAccounts: () => rpc('select_due_whatsapp_template_accounts', { p_limit: 20 }),
    requestSync: id => rpc('request_whatsapp_template_sync', { p_account_id: id }),
    listJobs: async accountId => {
      const { data, error } = await db.from('whatsapp_template_jobs').select('id').eq('account_id', accountId)
        .in('state', ['queued', 'claimed', 'posting']).order('due_at').order('created_at').limit(20);
      if (error) throw new Error('template_jobs_failed'); return data ?? [];
    },
    claim: id => rpc<TemplateWorkerJob | null>('claim_whatsapp_template_job', { p_job_id: id }),
    sync: sync.syncTemplateAccount, provision: sync.provisionTemplate,
    complete: (job, success, reason) => rpc('complete_whatsapp_template_sync_job', { p_job_id: job.id,
      p_fence: job.claim_token, p_success: success, p_reason: reason }),
    purge: () => rpc('purge_whatsapp_template_workers'), health: () => rpc<TemplatePipelineHealth>('whatsapp_template_pipeline_health'),
    alert: async payload => {
      const result = await sendAlert(payload);
      jsonLog('error', { evt: 'WHATSAPP_TEMPLATE_PIPELINE_ALERT', ...payload, ...result });
      return result;
    },
  });

  async function refreshTemplateChannel(channelId: string, allowAutoPreparation = true): Promise<void> {
    // Credential mutation must succeed for chat even if catalog reconciliation fails.
    try {
      await rpc('reconcile_whatsapp_template_credentials', { p_channel_id: channelId });
      const channel = await loadChannel(channelId);
      if (!channel || (channel as TemplateChannel & { status: string }).status !== 'connected'
        || !getWhatsAppProvider(channel.provider).capabilities.templateManagement || !await flag()) return;
      if (channel.provider === 'datafy') {
        const snapshot = await preparationSnapshot(channel.unit_id, channelId);
        if (snapshot.enrollment === 'eligible' && snapshot.onboarding_id) {
          if (allowAutoPreparation) await preparation.prepare({ onboarding_id: snapshot.onboarding_id,
            channel_id: channelId, unit_id: channel.unit_id, credential_revision: channel.template_credential_revision });
          return;
        }
      }
      const { data: binding, error } = await db.from('whatsapp_template_bindings').select('verified_at,channel_credential_revision').eq('channel_id', channelId).maybeSingle();
      if (error) throw new Error('template_binding_failed');
      if (binding?.verified_at && binding.channel_credential_revision === channel.template_credential_revision) return;
      await accounts.ensureTemplateAccount(channelId);
    } catch { jsonLog('warn', { evt: 'template_channel_preparation_failed', channel_id: channelId }); }
  }
  /** Resolve a Datafy channel from a unit-scoped write, never from caller-supplied WABA data. */
  async function refreshTemplateConnection(unitId: string, explicitChannelId?: string): Promise<void> {
    try {
      let channelId = explicitChannelId;
      if (!channelId) {
        const { data, error } = await db.from('whatsapp_datafy_onboardings')
          .select('reserved_channel_id').eq('unit_id', unitId).in('state', ['connected', 'completed'])
          .order('created_at', { ascending: false }).limit(1).maybeSingle();
        if (error) throw new Error('template_onboarding_failed');
        channelId = data?.reserved_channel_id;
      }
      if (!channelId) return;
      const { data: owned, error } = await db.from('whatsapp_channels').select('id')
        .eq('id', channelId).eq('unit_id', unitId).eq('provider', 'datafy').eq('status', 'connected').maybeSingle();
      if (error) throw new Error('template_channel_failed');
      if (owned) await refreshTemplateChannel(owned.id);
    } catch { jsonLog('warn', { evt: 'template_connection_refresh_failed', unit_id: unitId }); }
  }
  return { ...accounts, ...sync, ...worker, refreshTemplateChannel, refreshTemplateConnection };
}
