// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createTemplateDispatchFixture } from '../test/fixtures/whatsapp-automation-fixtures';
import { automationDeadline, parseAutomationLedger, type ScheduledKind } from '../../supabase/functions/_shared/whatsapp-automation-core';
import { pinScheduledTemplate, renderScheduledTemplate, renderScheduledText } from '../../supabase/functions/_shared/whatsapp-automation-resources';
import { TEMPLATE_V2_CATALOG, type TemplateV2Id } from '../../supabase/functions/_shared/whatsapp-template-catalog-v2';
import { catalogHash } from '../../supabase/functions/_shared/whatsapp-template-catalog-core';
import { APPROVED_CATALOG_DIGESTS } from '../../supabase/functions/_shared/whatsapp-template-cohort';

const names: Record<ScheduledKind, TemplateV2Id> = { confirmation: 'res_confirmacao_v2', reminder_d1: 'res_lembrete_dia_v2',
  survey_d1: 'res_pesquisa_reserva_v2', cancellation: 'res_cancelada_v2', waitlist_entered: 'fila_entrada_v2',
  waitlist_feedback: 'fila_feedback_v2', waitlist_table_ready: 'fila_mesa_pronta_v2', voucher_issued: 'mkt_voucher_programado_v2' };
async function fixture(kind: ScheduledKind = 'confirmation', discounted = false) {
  const f = await createTemplateDispatchFixture(kind === 'waitlist_feedback');
  const id = discounted ? 'res_confirmacao_desconto_v2' : names[kind];
  Object.assign(f.row, { kind, initial_catalog_key: id, template_version: 2, initial_template_version: 2,
    initial_selection_source: 'admin', initial_selection_revision: 1, initial_enrollment_id: null,
    initial_catalog_digest: APPROVED_CATALOG_DIGESTS[2] });
  if (discounted) f.rows.reservations[0].applied_discount_percent = 15;
  if (kind === 'cancellation') {
    f.row.fact_at = f.nowISO; f.rows.reservations[0].status = 'cancelled'; f.rows.reservations[0].cancelled_at = f.nowISO;
  } else if (kind === 'survey_d1') {
    f.rows.reservations[0].date = '2026-10-04'; f.row.fact_at = '2026-10-04T23:59:00-03:00';
  } else if (['waitlist_entered', 'waitlist_table_ready'].includes(kind)) {
    Object.assign(f.row, { reservation_id: null, waitlist_id: f.ids.reservation, fact_at: f.nowISO });
    f.rows.waitlist.push({ id: f.ids.reservation, unit_id: f.ids.unit, customer_id: f.ids.customer, customer_name: 'Marina',
      customer_phone: '55912345678', party_size: 4, code: 12, status: kind === 'waitlist_table_ready' ? 'notified' : 'waiting',
      created_at: f.nowISO, seated_at: null, notified_at: kind === 'waitlist_table_ready' ? f.nowISO : null,
      notified_server_at: kind === 'waitlist_table_ready' ? f.nowISO : null });
  } else if (kind === 'voucher_issued') {
    const rule = 'aaaaaaaa-0000-4000-8000-000000000005';
    Object.assign(f.row, { reservation_id: null, voucher_id: f.ids.reservation, fact_at: f.nowISO });
    f.rows.voucher_rules.push({ id: rule, unit_id: f.ids.unit, trigger_type: 'birthday' });
    f.rows.vouchers.push({ id: f.ids.reservation, unit_id: f.ids.unit, customer_id: f.ids.customer, rule_id: rule,
      code: 'VCH12345', discount_percent: 15, status: 'active', issued_at: f.nowISO, created_at: f.nowISO, expires_at: '2026-10-15T23:59:59-03:00' });
    f.consentEvents.push({ unit_id: f.ids.unit, customer_id: f.ids.customer, purpose: 'promotional', decision: 'opt_in', revision: 1 });
  }
  f.row.expires_at = automationDeadline(kind, String(f.row.fact_at));
  const hash = await catalogHash(TEMPLATE_V2_CATALOG[id]);
  Object.assign(f.template, { logical_id: id, name: id, version: 2, desired_hash: hash, observed_hash: hash,
    requested_category: TEMPLATE_V2_CATALOG[id].requestedCategory, effective_category: TEMPLATE_V2_CATALOG[id].requestedCategory });
  return f;
}

describe('pinned versioned runtime, with explicit SQL port replies (not a SQL authority model)', () => {
  it.each(Object.keys(names) as ScheduledKind[])('sends the canonical v2 %s exactly once through the real dispatcher', async kind => {
    const f = await fixture(kind);
    expect((await f.dispatch()).state).toBe('reconciled');
    expect(f.calls.post).toBe(1); expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({ name: names[kind], language: 'pt_BR' });
    expect(f.calls.resourceConfirms[0].p_expected).toMatchObject({ version: 1, kind });
    await f.dispatch(); expect(f.calls.post).toBe(1);
    expect(f.calls.operations.indexOf('confirm_whatsapp_automation_resource_post')).toBeLessThan(f.calls.operations.indexOf('adapter'));
  });
  it('pins the discounted confirmation variant and preserves approved paragraphs and emoji', async () => {
    const f = await fixture('confirmation', true);
    const loaded = await f.resources.loadScheduledResource({ ...f.intent });
    if (loaded.ok === false) throw new Error('fixture');
    const job = parseAutomationLedger(f.row);
    const resource = pinScheduledTemplate(loaded.resource, job.selection, job.pins.initialCatalogKey);
    const rendered = renderScheduledTemplate(resource, 'https://example.com', ['https://example.com']);
    expect(rendered.body).toContain('🍽️\n\n'); expect(rendered.body).toContain('15%');
    await f.dispatch(); expect(f.sent[0].name).toBe('res_confirmacao_desconto_v2');
    await expect(renderScheduledText(resource, f.io)).rejects.toThrow('render_invalid');
  });
  it.each([
    { initial_template_version: 1 }, { template_version: 1 }, { initial_catalog_key: 'res_confirmacao_v1' },
    { initial_selection_source: 'unknown' }, { initial_selection_revision: 0 }, { initial_catalog_digest: null },
    { initial_enrollment_id: 'unknown' }, { initial_catalog_digest: APPROVED_CATALOG_DIGESTS[1] },
  ])('fails closed for inconsistent initial pins %j', async patch => {
    const f = await fixture(); Object.assign(f.row, patch);
    expect(() => parseAutomationLedger(f.row)).toThrow('automation_ledger_invalid');
    await f.dispatch(); expect(f.calls.post).toBe(0);
  });
  it('accepts proven automatic v2 preconfiguration without inventing a bound template or v1 fallback', async () => {
    const f = await fixture();
    Object.assign(f.row, { pin_phase: 'preconfiguration', state: 'blocked', error_code: 'channel_unconfigured',
      initial_selection_source: 'auto', initial_enrollment_id: f.ids.reservation,
      channel_id: null, provider: null, transport: null, binding_id: null, binding_generation: null, initial_credential_revision: null,
      account_id: null, remote_template_id: null, template_version: null, sync_epoch: null });
    expect(parseAutomationLedger(f.row)).toMatchObject({ selection: { version: 2, source: 'auto' }, pins: { initialCatalogKey: 'res_confirmacao_v2' } });
    expect(await f.dispatch()).toMatchObject({ pinPhase: 'preconfiguration', state: 'blocked' }); expect(f.calls.post).toBe(0);
    delete f.row.initial_enrollment_id; expect(() => parseAutomationLedger(f.row)).toThrow();
  });
  it.each(['name', 'version', 'desired_hash', 'observed_hash', 'effective_category', 'remote_status', 'local_status', 'sync_required', 'quality'])('does not substitute another version after v2 template %s drift', async field => {
    const f = await fixture('confirmation');
    const patches = { name: 'res_confirmacao_v1', version: 1, desired_hash: 'bad', observed_hash: 'bad', effective_category: 'AUTHENTICATION',
      remote_status: 'REJECTED', local_status: 'pending', sync_required: true, quality: 'RED' };
    f.template[field] = patches[field as keyof typeof patches];
    if (field === 'sync_required') f.templateControls.syncFails = true;
    await f.dispatch(); expect(f.calls.post).toBe(0); expect(f.sent).toEqual([]);
  });
  it('honors SQL refusal of v2 cost/authority without a POST or v1 fallback', async () => {
    const f = await fixture('voucher_issued'); f.templateControls.prepareResult = false;
    await f.dispatch(); expect(f.calls.post).toBe(0); expect(f.sent).toEqual([]);
  });
  it('honors a final SQL refusal after selection is deselected without a POST', async () => {
    const f = await fixture(); f.controls.resourceConfirm = { allowed: false, reason: 'authority_changed' };
    await f.dispatch(); expect(f.calls.post).toBe(0);
  });
  it('keeps an ambiguous v2 provider outcome one-use and never retries as v1', async () => {
    const f = await fixture(); f.templateControls.outcome = { state: 'uncertain', error: 'synthetic ambiguous', errorCode: 'TIMEOUT' };
    expect((await f.dispatch()).state).toBe('uncertain'); await f.dispatch();
    expect(f.calls.post).toBe(1); expect(f.sent[0].name).toBe('res_confirmacao_v2');
  });
});
