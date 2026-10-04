import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getWhatsAppProvider } from './whatsapp-providers.ts';
import { clearWhatsAppGateCache, resolveWhatsAppGateByUnit } from './whatsapp-service-gate.ts';
import { createTemplateAccountService, type TemplateChannel } from './whatsapp-template-account.ts';
import { createTemplateSyncService, type TemplateSyncContext, type TemplateSyncEpoch, type TemplateProvisionJob, type StoredTemplate } from './whatsapp-template-sync.ts';
import { createTemplateWorker, createTemplateAlertSender, type TemplateWorkerJob, type TemplatePipelineHealth } from './whatsapp-template-worker.ts';
import { catalogHash } from './whatsapp-template-catalog-core.ts';
import { jsonLog, requireInternalAuth } from './security.ts';
import { readCurrentBooleanFlag } from './platform-flags.ts';

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
      .select('id,unit_id,provider,credentials,template_credential_revision,status,last_health_check_at')
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
    let chosen: (typeof bindings extends (infer B)[] | null ? B : never) | undefined;
    let channel: TemplateChannel | null = null;
    for (const binding of bindings ?? []) {
      if (bindingId && binding.id !== bindingId) continue;
      const candidate = await loadChannel(binding.channel_id);
      if (candidate && candidate.template_credential_revision === binding.channel_credential_revision
        && (candidate as TemplateChannel & { status: string }).status === 'connected') { chosen = binding; channel = candidate; break; }
    }
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
      credentials: channel.credentials, catalogEnabled: await flag(), submissionAuthorized: !!chosen.submission_authorized_at, templates, jobs };
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
    prepare: job => rpc('prepare_whatsapp_template_provision', { p_job_id: job.id, p_fence: job.claim_token, p_generation: job.binding_generation }),
    confirm: job => rpc('confirm_whatsapp_template_post', { p_job_id: job.id, p_fence: job.claim_token, p_generation: job.binding_generation }),
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
  const worker = createTemplateWorker({ authenticate: requireInternalAuth, now: Date.now,
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

  async function refreshTemplateChannel(channelId: string): Promise<void> {
    // Credential mutation must succeed for chat even if catalog reconciliation fails.
    try {
      await rpc('reconcile_whatsapp_template_credentials', { p_channel_id: channelId });
      const channel = await loadChannel(channelId);
      if (!channel || (channel as TemplateChannel & { status: string }).status !== 'connected'
        || !getWhatsAppProvider(channel.provider).capabilities.templateManagement || !await flag()) return;
      const { data: binding, error } = await db.from('whatsapp_template_bindings').select('verified_at,channel_credential_revision').eq('channel_id', channelId).maybeSingle();
      if (error) throw new Error('template_binding_failed');
      if (binding?.verified_at && binding.channel_credential_revision === channel.template_credential_revision) return;
      await accounts.ensureTemplateAccount(channelId);
    } catch { jsonLog('warn', { evt: 'template_channel_preparation_failed', channel_id: channelId }); }
  }
  return { ...accounts, ...sync, ...worker, refreshTemplateChannel };
}
