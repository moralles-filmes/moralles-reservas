import { useQuery } from '@tanstack/react-query';
import { requestManagement } from './useWhatsappTemplates';
import { storeDispatchStatusSchema } from '@/features/whatsapp/template-dispatch-versions';

export function useWhatsappDispatchStatus(unitId: string, enabled = true) {
  return useQuery({
    queryKey: ['whatsapp-dispatch-status', unitId], enabled: enabled && !!unitId,
    retry: false, refetchOnWindowFocus: false, refetchInterval: () => document.hidden ? false : 180_000,
    queryFn: async () => {
      const parsed = storeDispatchStatusSchema.safeParse(await requestManagement({ action: 'dispatch_status', unit_id: unitId }));
      if (!parsed.success) throw new Error('dependency_unavailable');
      return parsed.data;
    },
  });
}
