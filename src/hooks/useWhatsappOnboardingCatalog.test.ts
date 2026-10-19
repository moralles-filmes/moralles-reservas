import { beforeEach, expect, it, vi } from 'vitest';
import { TEMPLATE_CATALOG } from '../../supabase/functions/_shared/whatsapp-template-catalog-core';
import { TEMPLATE_V2_CATALOG } from '../../supabase/functions/_shared/whatsapp-template-catalog-v2';
import { readOnboardingTemplateCatalog } from './useWhatsappOnboardingCatalog';

const io = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ supabase: { functions: { invoke: io.invoke } } }));
const unitId = '10000000-0000-4000-8000-000000000001';
const definitions = [...Object.values(TEMPLATE_CATALOG), ...Object.values(TEMPLATE_V2_CATALOG)];
const templates = definitions.map(template => ({
  logicalId: template.id, version: template.version, name: template.name, body: template.body,
  footer: template.footer, requestedCategory: template.requestedCategory, effectiveCategory: null,
  remoteStatus: 'UNKNOWN', localStatus: 'awaiting_connection', quality: 'UNKNOWN',
  hashMatches: false, syncRequired: false, lastSyncedAt: null,
}));
const snapshot = () => ({
  channelId: '30000000-0000-4000-8000-000000000001', templatePreparation: null,
  templates, generatedAt: '2026-10-19T13:00:00Z',
});
beforeEach(() => { io.invoke.mockReset(); });

it('accepts historical v1/v2 states and the canonical body without needing new DTO fields', async () => {
  io.invoke.mockResolvedValue({ data: snapshot(), error: null });
  expect((await readOnboardingTemplateCatalog(unitId)).templates).toHaveLength(18);
});

it('keeps the canonical history and stale-policy diagnostic through onboarding_catalog_snapshot_v2', async () => {
  const templatePreparation = { enrollment: 'stale', state: 'needs_review', reason: 'policy_changed', updatedAt: '2026-10-19T13:00:00Z', version: 2, origin: 'auto' };
  const current = { ...snapshot(), templatePreparation, catalogSelection: { state: 'paused', version: null, digest: null } };
  io.invoke.mockResolvedValue({ data: current, error: null });
  const result = await readOnboardingTemplateCatalog(unitId);
  expect(io.invoke).toHaveBeenCalledWith('manage-whatsapp-templates', { body: { action: 'onboarding_catalog_snapshot_v2', unit_id: unitId } });
  expect(result.templatePreparation).toEqual(templatePreparation);
  expect(result.templates).toEqual(templates);
  expect(result.catalogSelection).toEqual(current.catalogSelection);
  io.invoke.mockResolvedValue({ data: { ...current, templatePreparation: { ...templatePreparation, grant_binding_id: 'private' } }, error: null });
  await expect(readOnboardingTemplateCatalog(unitId)).rejects.toThrow('dependency_unavailable');
});

it.each(['duplicate', 'incorrect_version', 'no_channel', 'unknown_body'])('closes an invalid %s onboarding projection', async fault => {
  const current = snapshot();
  if (fault === 'duplicate') current.templates = [templates[9], templates[9]];
  if (fault === 'incorrect_version') current.templates = [{ ...templates[9], version: 1 }];
  if (fault === 'no_channel') current.channelId = null;
  if (fault === 'unknown_body') current.templates = [{ ...templates[9], body: 'texto editado' }];
  io.invoke.mockResolvedValue({ data: current, error: null });
  await expect(readOnboardingTemplateCatalog(unitId)).rejects.toThrow('dependency_unavailable');
});
