import { expect, it } from 'vitest';
import type { OfficialTemplateView } from '@/hooks/useWhatsappTemplates';
import { TEMPLATE_CATALOG } from '../../../supabase/functions/_shared/whatsapp-template-catalog-core';
import { TEMPLATE_V2_CATALOG } from '../../../supabase/functions/_shared/whatsapp-template-catalog-v2';
import { storeTemplateStatus } from './template-status';

const localStates: OfficialTemplateView['localStatus'][] = [
  'awaiting_connection', 'queued', 'submitting', 'pending', 'usable', 'rejected',
  'paused', 'disabled', 'conflict', 'sync_error', 'unsupported',
];
const remoteStates = [
  ['REJECTED', 'Recusado pela Meta'],
  ['PENDING', 'Em análise na Meta'],
  ['UNKNOWN', 'Estado remoto ainda não confirmado'],
  ['IN_APPEAL', 'Recurso em análise na Meta'],
  ['PAUSED', 'Pausado pela Meta'],
  ['DISABLED', 'Desativado pela Meta'],
  ['PENDING_DELETION', 'Remoção pendente na Meta'],
  ['DELETED', 'Removido da Meta'],
  ['LIMIT_EXCEEDED', 'Limite de modelos atingido na Meta'],
] as const;

for (const definition of [TEMPLATE_CATALOG.res_lembrete_dia_v1, TEMPLATE_V2_CATALOG.res_lembrete_dia_v2]) {
  it.each(localStates)(`uses the distinct remote state for ${definition.id} despite local %s`, localStatus => {
    for (const [remoteStatus, expected] of remoteStates) {
      const template: OfficialTemplateView = {
        logicalId: definition.id, version: definition.version, name: definition.name, body: definition.body,
        footer: definition.footer, requestedCategory: definition.requestedCategory,
        effectiveCategory: definition.requestedCategory, remoteStatus, localStatus,
        quality: 'UNKNOWN', hashMatches: true, syncRequired: false, lastSyncedAt: null,
      };
      expect(storeTemplateStatus(template)).toBe(expected);
      expect(storeTemplateStatus(template)).not.toMatch(/disponível|habilitado|aprovado/i);
    }
  });
}

it('keeps historical v1 utility quality factual while v1 marketing and all v2 RED remain blocked', () => {
  const example = (definition: typeof TEMPLATE_CATALOG.res_confirmacao_v1 | typeof TEMPLATE_CATALOG.mkt_voucher_programado_v1 | typeof TEMPLATE_V2_CATALOG.res_confirmacao_v2): OfficialTemplateView => ({
    logicalId: definition.id, version: definition.version, name: definition.name, body: definition.body,
    footer: definition.footer, requestedCategory: definition.requestedCategory,
    effectiveCategory: definition.requestedCategory, remoteStatus: 'APPROVED', localStatus: 'usable',
    quality: 'RED', hashMatches: true, syncRequired: false, lastSyncedAt: null,
  });
  expect(storeTemplateStatus(example(TEMPLATE_CATALOG.res_confirmacao_v1))).toBe('Aprovado pela Meta');
  expect(storeTemplateStatus(example(TEMPLATE_CATALOG.mkt_voucher_programado_v1))).toBe('Qualidade do modelo impede o envio');
  expect(storeTemplateStatus(example(TEMPLATE_V2_CATALOG.res_confirmacao_v2))).toBe('Qualidade do modelo impede o envio');
});
