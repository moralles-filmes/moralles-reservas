import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";
import type { PaymentMethodSummary } from "@/types/billing";

async function invokeManagePaymentMethods(body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke("manage-payment-methods", { body });
  if (error) {
    const message = (data as { error?: string } | null)?.error ?? error.message ?? "Erro inesperado.";
    throw new Error(message);
  }
  if (data && typeof data === "object" && "error" in data && data.error) {
    throw new Error(String(data.error));
  }
  return data;
}

export function usePaymentMethods(organizationId: string | undefined) {
  return useQuery<{ payment_methods: PaymentMethodSummary[]; default_payment_method_id: string | null }>({
    queryKey: ["payment-methods", organizationId],
    queryFn: async () => {
      const data = await invokeManagePaymentMethods({ action: "list", organization_id: organizationId });
      return {
        payment_methods: ((data as { payment_methods?: PaymentMethodSummary[] }).payment_methods) ?? [],
        default_payment_method_id: ((data as { default_payment_method_id?: string | null }).default_payment_method_id) ?? null,
      };
    },
    enabled: !!organizationId,
  });
}

export function useSetDefaultPaymentMethod() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ organizationId, paymentMethodId }: { organizationId: string; paymentMethodId: string }) =>
      invokeManagePaymentMethods({
        action: "set_default",
        organization_id: organizationId,
        payment_method_id: paymentMethodId,
      }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["payment-methods", vars.organizationId] });
      toast.success("Cartão padrão atualizado.");
    },
    onError: (err: Error) => toast.error(err.message),
  });
}

/**
 * Remove cartão do Stripe. **APENAS platform_admin** consegue invocar — backend
 * retorna 403 pra qualquer outro role. Hook NÃO checa role no client: a
 * proteção é server-side em manage-payment-methods action `delete`.
 */
export function useDeletePaymentMethod() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ paymentMethodId }: { paymentMethodId: string; organizationId: string }) =>
      invokeManagePaymentMethods({ action: "delete", payment_method_id: paymentMethodId }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["payment-methods", vars.organizationId] });
      qc.invalidateQueries({ queryKey: ["billing-detail", vars.organizationId] });
      toast.success("Cartão removido.");
    },
    onError: (err: Error) => toast.error(err.message),
  });
}
