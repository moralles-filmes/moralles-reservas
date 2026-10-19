import { z } from 'zod';

// The server projects this from a durable channel enrollment. Never infer eligibility from a global flag.
export const templatePreparationSchema = z.object({
  enrollment: z.enum(['eligible', 'disabled', 'legacy', 'excluded', 'stale']),
  state: z.enum(['pending', 'discovering', 'ready', 'needs_review']).nullable(),
  reason: z.enum(['connection_pending', 'health_stale', 'binding_pending', 'provider_unavailable', 'policy_changed', 'manual_review']).nullable(),
  updatedAt: z.iso.datetime({ offset: true }).nullable(),
  version: z.union([z.literal(1), z.literal(2)]).optional(),
  origin: z.enum(['auto', 'manual']).optional(),
}).strict();

export const templateCatalogSelectionSchema = z.object({
  state: z.enum(['v1', 'pending', 'ready', 'paused']),
  version: z.union([z.literal(1), z.literal(2)]).nullable(),
  digest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
}).strict().refine(selection => selection.state === 'v1' ? selection.version === 1 && selection.digest !== null
  : selection.state === 'ready' ? selection.version === 2 && selection.digest !== null
    : selection.version === null && selection.digest === null);

export type TemplatePreparation = z.infer<typeof templatePreparationSchema>;

export function readTemplatePreparation(value: unknown): TemplatePreparation | null {
  const parsed = templatePreparationSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function templatePreparationMessage(preparation: TemplatePreparation | null): string {
  if (!preparation) return 'Não foi possível confirmar a preparação automática dos modelos para esta conexão.';
  if (preparation.enrollment === 'stale') return 'A política de preparação dos modelos mudou. Esta conexão precisa de revisão antes de novas submissões.';
  if (preparation.enrollment !== 'eligible') return 'A preparação automática dos modelos não está habilitada para esta conexão.';
  switch (preparation.state) {
    case 'pending': return 'A preparação dos nove modelos está na fila. Nenhuma automação passa a enviar mensagens por isso.';
    case 'discovering': return 'A conta de modelos está sendo verificada. Nenhuma automação passa a enviar mensagens por isso.';
    case 'ready': return 'O vínculo da conta de modelos está preparado. Confira cada modelo; este estado não comprova as nove submissões nem aprovação pela Meta.';
    case 'needs_review': return 'A preparação dos modelos precisa de revisão pela equipe. Nenhuma nova submissão será presumida.';
    default: return 'A preparação dos modelos ainda não tem estado confirmado.';
  }
}

export function templatePreparationReasonMessage(preparation: TemplatePreparation | null): string | null {
  if (preparation?.enrollment === 'stale') return 'A preparação está desatualizada; confira a liberação atual. O histórico dos modelos permanece disponível.';
  if (!preparation || preparation.enrollment !== 'eligible' || preparation.reason === null) return null;
  if (preparation.state === 'ready') {
    if (preparation.reason === 'health_stale') return 'A saúde do canal está vencida; o sistema tentará verificar novamente. O vínculo dos modelos continua registrado.';
    if (preparation.reason === 'provider_unavailable') return 'Não foi possível consultar a Datafy agora; o sistema tentará novamente. O vínculo dos modelos continua registrado.';
    return 'Há um diagnóstico pendente para este canal. Confira a saúde atual antes de usar os modelos.';
  }
  if (preparation.state !== 'needs_review') return null;
  switch (preparation.reason) {
    case 'health_stale': return 'A saúde do canal precisa ser verificada novamente.';
    case 'binding_pending': return 'O vínculo da conta de modelos precisa ser conferido.';
    case 'provider_unavailable': return 'Não foi possível consultar a Datafy. A equipe deve conferir antes de tentar novamente.';
    case 'policy_changed': return 'A política mudou durante a preparação. A equipe deve revisar esta conexão.';
    case 'connection_pending': return 'A conexão ainda precisa ser concluída.';
    default: return 'A equipe deve conferir o canal e os modelos antes de continuar.';
  }
}

export const AUTOMATIC_SUBMISSION_COPY = 'A conexão envia nove modelos para análise da Meta; nenhuma automação passa a enviar mensagens por isso.';
