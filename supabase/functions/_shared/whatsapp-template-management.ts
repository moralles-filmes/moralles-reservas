import { corsHeadersFor } from './cors.ts';
import { canManageTemplateRequest, decodeConsentState, decodeSyncResult, isManagementUuid,
  managementPositiveInteger, parseTemplateManagementRequest, projectTemplateSnapshot,
  type TemplateManagementRequest, type TemplateRole, type TemplateSnapshotInput } from './whatsapp-template-access-core.ts';

export interface TemplateManagementDependencies {
  authenticate(jwt: string): Promise<{ id: string } | null>;
  access(userId: string, request: TemplateManagementRequest): Promise<{ role: TemplateRole; isPlatformAdmin: boolean; exists: boolean }>;
  snapshot(unitId: string): Promise<TemplateSnapshotInput>;
  /** The original user's JWT, never a service client or actor parameter. */
  callerRpc(jwt: string, name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { code?: string; message?: string } | null }>;
}
function rpcCall(request: Exclude<TemplateManagementRequest, { action: 'snapshot' }>): [string, Record<string, unknown>] {
  switch (request.action) {
    case 'sync': return ['request_whatsapp_template_sync_for_channel', { p_channel_id: request.channel_id, p_expected_binding_generation: request.expected_binding_generation }];
    case 'initialize_job': case 'revalidate_job': return [request.action === 'initialize_job' ? 'initialize_whatsapp_automation_job' : request.target === 'catalog' ? 'revalidate_whatsapp_template_job' : 'revalidate_whatsapp_automation_job', { p_job_id: request.job_id, p_expected_channel_id: request.expected_channel_id, p_expected_binding_generation: request.expected_binding_generation }];
    case 'consent_snapshot': return ['get_whatsapp_message_consent_state', { p_unit_id: request.unit_id, p_customer_id: request.customer_id, p_purpose: request.purpose }];
    case 'record_consent': return ['record_whatsapp_message_consent', { p_unit_id: request.unit_id, p_customer_id: request.customer_id, p_purpose: request.purpose, p_decision: request.decision, p_source_code: request.source_code, p_observed_at: request.observed_at, p_evidence_reference: request.evidence_reference }];
    case 'release_channel': return ['release_whatsapp_template_channel', { p_channel_id: request.channel_id, p_scope: request.scope, p_enabled: request.enabled, p_expected_credential_revision: request.expected_credential_revision, p_expected_binding_generation: request.expected_binding_generation }];
    case 'authorize_marketing_cost': return ['authorize_whatsapp_marketing_cost', { p_channel_id: request.channel_id, p_expected_binding_generation: request.expected_binding_generation, p_category: request.category, p_valid_from: request.valid_from, p_valid_until: request.valid_until }];
    case 'configure_promotion_frequency': return ['configure_whatsapp_promotion_frequency', { p_window_days: request.window_days }];
  }
}
export function createTemplateManagementHandler(deps: TemplateManagementDependencies) {
  return async (req: Request): Promise<Response> => {
    const headers = { ...corsHeadersFor(req), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (req.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);
    const authorization = req.headers.get('authorization');
    if (!authorization?.startsWith('Bearer ') || authorization.length <= 7) return reply({ error: 'unauthorized' }, 401);
    const jwt = authorization.slice(7);
    try {
      const user = await deps.authenticate(jwt);
      if (!user || !isManagementUuid(user.id)) return reply({ error: 'unauthorized' }, 401);
      let body: unknown;
      try { const raw = await req.text(); if (raw.length > 8192) return reply({ error: 'invalid_request' }, 400); body = JSON.parse(raw); }
      catch { return reply({ error: 'invalid_request' }, 400); }
      const input = parseTemplateManagementRequest(body);
      if (!input) return reply({ error: 'invalid_request' }, 400);
      const access = await deps.access(user.id, input);
      if (!access.exists || !canManageTemplateRequest(access.role, input, access.isPlatformAdmin)) return reply({ error: 'forbidden' }, 403);
      if (input.action === 'snapshot') return reply(projectTemplateSnapshot(await deps.snapshot(input.unit_id)));
      const [name, args] = rpcCall(input);
      const { data, error } = await deps.callerRpc(jwt, name, args);
      if (error) {
        if (error.code === '42501' || error.code === 'P0A15') return reply({ error: 'forbidden' }, 403);
        if (error.code === '22023') return reply({ error: 'invalid_request' }, 400);
        if (error.code === 'PT409') return reply({ error: 'configuration_changed' }, 409);
        return reply({ error: 'dependency_unavailable' }, 503);
      }
      if (input.action === 'sync') return reply(decodeSyncResult(data));
      if (input.action === 'consent_snapshot') return reply(decodeConsentState(data, input.purpose));
      if (input.action === 'record_consent') return reply({ revision: managementPositiveInteger(data), purpose: input.purpose, decision: input.decision });
      if (input.action === 'configure_promotion_frequency') {
        if (data !== input.window_days) throw new Error('dependency_unavailable');
        return reply({ windowDays: managementPositiveInteger(data) });
      }
      if (input.action === 'authorize_marketing_cost') {
        if (!isManagementUuid(data)) throw new Error('dependency_unavailable');
        return reply({ authorizationId: data });
      }
      if (data === false) return reply({ error: 'not_eligible' }, 409);
      if (data !== true) throw new Error('dependency_unavailable');
      return reply({ status: 'updated' });
    } catch { return reply({ error: 'dependency_unavailable' }, 503); }
  };
}
