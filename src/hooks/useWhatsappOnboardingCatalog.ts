import { useQuery } from '@tanstack/react-query';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { z } from 'zod';
import { supabase } from '@/lib/supabase';
import { templateCatalogSelectionSchema, templatePreparationSchema } from '@/features/whatsapp/template-preparation';
import { templateCatalogSchema } from '@/hooks/useWhatsappTemplates';

const uuid = z.uuid();
const catalogSchema = z.object({
  channelId: uuid.nullable(),
  templatePreparation: templatePreparationSchema.nullable(),
  catalogSelection: templateCatalogSelectionSchema.nullable().optional(),
  templates: templateCatalogSchema,
  generatedAt: z.iso.datetime({ offset: true }),
}).strict().refine(value => value.channelId !== null || (value.templates.length === 0 && value.catalogSelection == null));

export type OnboardingTemplateCatalog = z.infer<typeof catalogSchema>;

export async function readOnboardingTemplateCatalog(unitId: string): Promise<OnboardingTemplateCatalog> {
  if (!uuid.safeParse(unitId).success) throw new Error('invalid_request');
  try {
    const { data, error } = await supabase.functions.invoke('manage-whatsapp-templates', { body: { action: 'onboarding_catalog_snapshot_v2', unit_id: unitId } });
    if (error) {
      if (error instanceof FunctionsHttpError) {
        const body = await error.context.json().catch(() => null);
        if (body?.error === 'forbidden' || body?.error === 'unauthorized') throw new Error(body.error);
      }
      throw new Error('dependency_unavailable');
    }
    const parsed = catalogSchema.safeParse(data);
    if (!parsed.success) throw new Error('dependency_unavailable');
    return parsed.data;
  } catch (error) {
    if (error instanceof Error && ['forbidden', 'unauthorized'].includes(error.message)) throw error;
    throw new Error('dependency_unavailable');
  }
}

export function useWhatsappOnboardingCatalog(unitId: string) {
  return useQuery({
    queryKey: ['whatsapp-onboarding-catalog', unitId],
    queryFn: () => readOnboardingTemplateCatalog(unitId),
    enabled: !!unitId,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: () => document.hidden ? false : 30_000,
  });
}
