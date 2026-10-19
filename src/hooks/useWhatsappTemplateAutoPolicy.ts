import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { z } from 'zod';
import { supabase } from '@/lib/supabase';

const policySchema = z.object({
  enabled: z.boolean(),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  catalogDigest: z.string().regex(/^[0-9a-f]{64}$/),
  updatedAt: z.iso.datetime({ offset: true }).nullable(),
}).strict();
export type TemplateAutoPolicy = z.infer<typeof policySchema>;
export type TemplateAutoPolicyPin = Pick<TemplateAutoPolicy, 'enabled' | 'revision' | 'catalogDigest'>;

const key = ['whatsapp-template-auto-policy'] as const;
const policyErrors = {
  forbidden: 'Apenas a administração da plataforma pode alterar esta política.',
  configuration_changed: 'A política mudou. Atualize os dados antes de confirmar.',
  dependency_unavailable: 'Não foi possível consultar a política. Atualize os dados.',
} as const;
export function autoPolicyErrorMessage(error: unknown) {
  return error instanceof Error && Object.prototype.hasOwnProperty.call(policyErrors, error.message)
    ? policyErrors[error.message as keyof typeof policyErrors] : policyErrors.dependency_unavailable;
}
function closedError(code: unknown): Error {
  return new Error(typeof code === 'string' && Object.prototype.hasOwnProperty.call(policyErrors, code) ? code : 'dependency_unavailable');
}
async function invokePolicy(body: { action: 'auto_policy_snapshot' } | { action: 'set_auto_policy'; enabled: boolean; expected_revision: number }): Promise<TemplateAutoPolicy> {
  try {
    const { data, error } = await supabase.functions.invoke('manage-whatsapp-templates', { body });
    if (error) {
      if (error instanceof FunctionsHttpError) {
        const response = await error.context.json().catch(() => null);
        throw closedError(response?.error);
      }
      throw closedError(null);
    }
    const parsed = policySchema.safeParse(data);
    if (!parsed.success) throw closedError(null);
    return parsed.data;
  } catch (error) { throw closedError(error instanceof Error ? error.message : null); }
}
export function autoPolicyMatches(policy: TemplateAutoPolicy | undefined, pin: TemplateAutoPolicyPin): boolean {
  return policy?.enabled === pin.enabled && policy.revision === pin.revision && policy.catalogDigest === pin.catalogDigest;
}
export function useWhatsappTemplateAutoPolicy() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: key, queryFn: () => invokePolicy({ action: 'auto_policy_snapshot' }), retry: false, refetchOnWindowFocus: false });
  const change = useMutation({
    mutationFn: async (pin: TemplateAutoPolicyPin) => {
      if (query.isError || query.isFetching || !autoPolicyMatches(query.data, pin)) throw closedError('configuration_changed');
      const updated = await invokePolicy({ action: 'set_auto_policy', enabled: !pin.enabled, expected_revision: pin.revision });
      if (updated.enabled === pin.enabled || updated.revision <= pin.revision || updated.catalogDigest !== pin.catalogDigest) throw closedError('configuration_changed');
      return updated;
    },
    onSettled: () => client.invalidateQueries({ queryKey: key, exact: true }),
  });
  return { query, change };
}
