import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";

export interface StripeAccount {
  id: string;
  unit_id: string;
  stripe_account_id: string;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  onboarding_complete: boolean;
  display_name: string | null;
  livemode: boolean;
  created_at: string;
  updated_at: string;
}

async function invokeManageStripeAccounts(body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke("manage-stripe-accounts", { body });
  if (error) {
    const message =
      (data as { error?: string } | null)?.error ?? error.message ?? "Erro inesperado.";
    throw new Error(message);
  }
  if (data && typeof data === "object" && "error" in data && data.error) {
    throw new Error(String(data.error));
  }
  return data;
}

export function useStripeAccount(unitId: string) {
  return useQuery({
    queryKey: ["stripe-account", unitId],
    queryFn: async () => {
      const data = await invokeManageStripeAccounts({ action: "list", unit_id: unitId });
      return (data as { account?: StripeAccount | null })?.account ?? null;
    },
    enabled: !!unitId,
  });
}

export function useConnectStripe(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ unitSlug }: { unitSlug: string }) => {
      const data = await invokeManageStripeAccounts({
        action: "create_onboarding_link",
        unit_id: unitId,
        unit_slug: unitSlug,
      });
      return data as { url: string; stripe_account_id: string };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["stripe-account", unitId] });
      window.location.href = data.url;
    },
    onError: (err: Error) => toast.error(err.message),
  });
}

export function useCheckStripeStatus(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      return invokeManageStripeAccounts({ action: "check_status", unit_id: unitId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["stripe-account", unitId] });
      toast.success("Status atualizado.");
    },
    onError: (err: Error) => toast.error(err.message),
  });
}

export function useDisconnectStripe(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      return invokeManageStripeAccounts({ action: "disconnect", unit_id: unitId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["stripe-account", unitId] });
      toast.success("Conta Stripe desconectada.");
    },
    onError: (err: Error) => toast.error(err.message),
  });
}
