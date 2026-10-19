import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createTemplateManagementHandler } from '../_shared/whatsapp-template-management.ts';
import { type TemplateManagementRequest, type TemplateRole, type TemplateSnapshotInput } from '../_shared/whatsapp-template-access-core.ts';

const url = Deno.env.get('SUPABASE_URL')!;
const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
const service = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
const dependency = (): never => { throw new Error('dependency_unavailable'); };
async function one(table: string, columns: string, key: string, value: string) {
  const { data, error } = await service.from(table).select(columns).eq(key, value).maybeSingle();
  if (error) return dependency();
  return data as Record<string, unknown> | null;
}
async function all(table: string, columns: string, key: string, value: string | string[]) {
  const rows: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += 500) {
    const query = service.from(table).select(columns).order('id').range(offset, offset + 499);
    const { data, error } = await (Array.isArray(value) ? query.in(key, value) : query.eq(key, value));
    if (error || !Array.isArray(data)) return dependency();
    rows.push(...data as unknown as Record<string, unknown>[]);
    if (data.length < 500) return rows;
  }
}
async function scope(request: TemplateManagementRequest): Promise<string | null> {
  if (request.action === 'configure_promotion_frequency' || request.action === 'auto_policy_snapshot' || request.action === 'set_auto_policy') return null;
  if ('unit_id' in request) {
    const unit = await one('units', 'id,organization_id', 'id', request.unit_id);
    if (!unit) return null;
    if (request.action === 'sync') {
      const channel = await one('whatsapp_channels', 'unit_id', 'id', request.channel_id);
      if (channel?.unit_id !== unit.id) return null;
    } else if (request.action === 'record_consent' || request.action === 'consent_snapshot') {
      const customer = await one('customers', 'organization_id,deleted_at', 'id', request.customer_id);
      if (!customer || customer.deleted_at !== null || customer.organization_id !== unit.organization_id) return null;
    }
    return request.unit_id;
  }
  if ('channel_id' in request) {
    const channel = await one('whatsapp_channels', 'unit_id', 'id', request.channel_id);
    return typeof channel?.unit_id === 'string' ? channel.unit_id : null;
  }
  if (request.action === 'revalidate_job' && request.target === 'catalog') {
    const job = await one('whatsapp_template_jobs', 'account_id,organization_id', 'id', request.job_id);
    if (!job) return null;
    const binding = await one('whatsapp_template_bindings', 'unit_id,account_id', 'channel_id', request.expected_channel_id);
    return binding?.account_id === job.account_id && typeof binding?.unit_id === 'string' ? binding.unit_id : null;
  }
  const job = await one('whatsapp_automation_jobs', 'unit_id', 'id', request.job_id);
  return typeof job?.unit_id === 'string' ? job.unit_id : null;
}
async function snapshot(unitId: string): Promise<TemplateSnapshotInput> {
  const channels = await all('whatsapp_channels', 'id,provider,is_active,status,created_at,template_credential_revision', 'unit_id', unitId);
  const active = channels.filter(c => c.is_active === true);
  if (active.length > 1) return dependency();
  const legacy = channels.filter(c => c.is_active === null && c.status === 'connected').sort((a, b) => Date.parse(String(a.created_at)) - Date.parse(String(b.created_at)) || String(a.id).localeCompare(String(b.id)));
  const channel = active[0] ?? legacy[0] ?? null;
  const preparation = channel?.provider === 'datafy'
    ? await service.rpc('get_whatsapp_template_preparation', { p_unit_id: unitId, p_channel_id: channel.id })
    : null;
  if (preparation?.error) return dependency();
  const binding = channel ? await one('whatsapp_template_bindings', 'id,unit_id,account_id,generation,dispatch_enabled,submission_authorized_at,submission_authorized_by', 'channel_id', String(channel.id)) : null;
  if (binding && binding.unit_id !== unitId) return dependency();
  const adoption = await one('whatsapp_automation_adoptions', 'unit_id', 'unit_id', unitId);
  const templates = binding?.account_id ? await all('whatsapp_remote_templates', 'logical_id,version,effective_category,remote_status,local_status,quality,desired_hash,observed_hash,sync_required,last_synced_at', 'account_id', String(binding.account_id)) : [];
  const jobs = (await all('whatsapp_automation_jobs', 'id,kind,state,pin_phase,channel_id,initial_catalog_key,error_code,attempts,fact_at,expires_at', 'unit_id', unitId)).map(row => ({ ...row, target: 'automation' }));
  const bindings = await all('whatsapp_template_bindings', 'id,channel_id', 'unit_id', unitId);
  const catalogJobs = bindings.length ? await all('whatsapp_template_jobs', 'id,binding_id,target_key,state,error_code,attempts,created_at,due_at', 'binding_id', bindings.map(b => String(b.id))) : [];
  return { channel, binding, preparation: preparation?.data ?? null, unitAdopted: adoption !== null, templates,
    jobs: [...jobs, ...catalogJobs.map(row => ({ ...row, target: 'catalog', channel_id: bindings.find(b => b.id === row.binding_id)?.channel_id ?? null }))], generatedAt: new Date().toISOString() };
}

/** Resolve the Datafy channel from the authenticated unit's onboarding, never from a browser ID. */
async function onboardingSnapshot(unitId: string): Promise<TemplateSnapshotInput> {
  const generatedAt = new Date().toISOString();
  const empty = (preparation: unknown = null): TemplateSnapshotInput => ({
    channel: null, binding: null, preparation, unitAdopted: false, templates: [], jobs: [], generatedAt,
  });
  const unit = await one('units', 'id,organization_id', 'id', unitId);
  if (!unit) return dependency();
  const { data: onboarding, error: onboardingError } = await service.from('whatsapp_datafy_onboardings')
    .select('id,unit_id,organization_id,reserved_channel_id,state').eq('unit_id', unitId)
    .in('state', ['open', 'channel_created', 'webhook_ready', 'connected', 'completed'])
    .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1).maybeSingle();
  if (onboardingError) return dependency();
  if (!onboarding) return empty();
  if (onboarding.unit_id !== unitId || onboarding.organization_id !== unit.organization_id
    || typeof onboarding.reserved_channel_id !== 'string') return dependency();
  const { data: preparation, error: preparationError } = await service.rpc('get_whatsapp_template_preparation', {
    p_unit_id: unitId, p_channel_id: onboarding.reserved_channel_id,
  });
  if (preparationError) return dependency();
  const channel = await one('whatsapp_channels',
    'id,unit_id,provider,status,is_active,template_credential_revision', 'id', onboarding.reserved_channel_id);
  if (!channel) return empty(preparation);
  if (channel.unit_id !== unitId || channel.provider !== 'datafy') return dependency();
  if (channel.status !== 'connected') return empty(preparation);
  const found = await one('whatsapp_template_bindings',
    'id,unit_id,channel_id,provider,account_id,generation,channel_credential_revision,verified_at,dispatch_enabled,submission_authorized_at,submission_authorized_by',
    'channel_id', onboarding.reserved_channel_id);
  if (found && (found.unit_id !== unitId || found.channel_id !== channel.id || found.provider !== 'datafy')) return dependency();
  const binding = found?.verified_at && found.channel_credential_revision === channel.template_credential_revision ? found : null;
  let templates: Record<string, unknown>[] = [];
  if (binding?.account_id) {
    const account = await one('whatsapp_template_accounts', 'id,organization_id', 'id', String(binding.account_id));
    if (!account || account.organization_id !== unit.organization_id) return dependency();
    templates = await all('whatsapp_remote_templates',
      'logical_id,version,effective_category,remote_status,local_status,quality,desired_hash,observed_hash,sync_required,last_synced_at',
      'account_id', String(binding.account_id));
  }
  return { channel, binding, preparation, unitAdopted: false, templates, jobs: [], generatedAt };
}

Deno.serve(createTemplateManagementHandler({
  authenticate: async jwt => {
    const { data, error } = await service.auth.getUser(jwt);
    if (error) { if (error.status && [400, 401, 403].includes(error.status)) return null; return dependency(); }
    return data.user ? { id: data.user.id } : null;
  },
  access: async (userId, request) => {
    const [admin, unitId] = await Promise.all([one('platform_admins', 'user_id', 'user_id', userId), scope(request)]);
    let role: TemplateRole = null;
    if (unitId !== null) {
      const { data, error } = await service.from('unit_members').select('role').eq('unit_id', unitId).eq('user_id', userId).maybeSingle();
      if (error || (data && !['owner', 'gerente', 'operador'].includes(data.role))) return dependency();
      role = data?.role ?? null;
    }
    return { role, isPlatformAdmin: admin !== null, exists: unitId !== null || request.action === 'configure_promotion_frequency'
      || request.action === 'auto_policy_snapshot' || request.action === 'set_auto_policy' };
  },
  snapshot,
  onboardingSnapshot,
  callerRpc: async (jwt, name, args) => {
    const caller = createClient(url, anon, { global: { headers: { Authorization: `Bearer ${jwt}` } }, auth: { persistSession: false, autoRefreshToken: false } });
    return await caller.rpc(name, args);
  },
}));
