import { expect, it } from 'vitest';
import { readTemplatePreparation, templatePreparationMessage, templatePreparationReasonMessage } from './template-preparation';

it('fails closed when the preparation DTO is absent or malformed', () => {
  expect(readTemplatePreparation(undefined)).toBeNull();
  expect(readTemplatePreparation({ enrollment: 'eligible', state: 'ready', reason: 'raw-provider-error', updatedAt: null })).toBeNull();
  expect(readTemplatePreparation({ enrollment: 'eligible', state: 'ready', reason: null, updatedAt: null, phone: 'secret' })).toBeNull();
  expect(templatePreparationMessage(null)).toContain('Não foi possível confirmar');
});

it('distinguishes local preparation from Meta approval and uses only safe reason copy', () => {
  const ready = readTemplatePreparation({ enrollment: 'eligible', state: 'ready', reason: null, updatedAt: '2026-10-17T19:00:00Z' });
  expect(templatePreparationMessage(ready)).toContain('não comprova as nove submissões nem aprovação pela Meta');
  const review = readTemplatePreparation({ enrollment: 'eligible', state: 'needs_review', reason: 'provider_unavailable', updatedAt: null });
  expect(templatePreparationReasonMessage(review)).toContain('Datafy');
  expect(templatePreparationReasonMessage(review)).not.toContain('provider_unavailable');
});

it('keeps a ready binding visible while reporting and clearing a health failure', () => {
  const stale = readTemplatePreparation({ enrollment: 'eligible', state: 'ready', reason: 'health_stale', updatedAt: '2026-10-17T19:00:00Z' });
  expect(templatePreparationMessage(stale)).toContain('vínculo da conta de modelos está preparado');
  expect(templatePreparationReasonMessage(stale)).toContain('saúde do canal está vencida');
  expect(templatePreparationReasonMessage(stale)).toContain('vínculo dos modelos continua registrado');
  const recovered = readTemplatePreparation({ enrollment: 'eligible', state: 'ready', reason: null, updatedAt: '2026-10-17T19:05:00Z' });
  expect(templatePreparationReasonMessage(recovered)).toBeNull();
});
