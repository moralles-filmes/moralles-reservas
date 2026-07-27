import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { WhatsappServiceStatus } from "@/types/billing";

/**
 * `functions.invoke` mascara o corpo de erro non-2xx — a mensagem PT-BR do
 * backend só existe em `error.context`. Mesmo padrão de useSendManualMessage.
 */
async function invokeWhatsappImplementations(body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke(
    "manage-whatsapp-implementations",
    { body },
  );
  if (error) {
    let message = error.message ?? "Erro inesperado.";
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === "function") {
      try {
        const parsed = await ctx.json();
        if (parsed?.error) message = String(parsed.error);
      } catch {
        // corpo não-JSON — mantém error.message
      }
    }
    throw new Error(message);
  }
  if (data && typeof data === "object" && "error" in data && data.error) {
    throw new Error(String(data.error));
  }
  return data;
}

export function useWhatsappServiceStatus(organizationId: string | undefined) {
  return useQuery<WhatsappServiceStatus>({
    queryKey: ["whatsapp-service-status", organizationId],
    enabled: !!organizationId,
    queryFn: async () => {
      const res = await invokeWhatsappImplementations({
        action: "get_service_status",
        organization_id: organizationId,
      });
      return res as WhatsappServiceStatus;
    },
  });
}

// ── Admin ────────────────────────────────────────────────────────────────────

export function useImplementations(filters: {
  status?: string;
  organization_id?: string;
  page?: number;
  page_size?: number;
}) {
  return useQuery({
    queryKey: ["whatsapp-implementations", filters],
    queryFn: async () => {
      const res = await invokeWhatsappImplementations({ action: "list", ...filters });
      return res as { implementations: Record<string, unknown>[]; total: number | null };
    },
  });
}

/**
 * Invalida status do cliente, lista do admin E a lista de overrides — as três
 * podem ler a mesma linha/mudança. `whatsapp-overrides` (Rodada de correção 1,
 * I5) faltava: é ela que `useGrantWhatsappOverride`/`useRevokeWhatsappOverride`
 * passam por este helper, e sem a invalidação a lista de cortesias concedidas
 * ficava congelada até um refresh manual.
 */
function useImplementationMutation<TVars>(build: (v: TVars) => Record<string, unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: TVars) => invokeWhatsappImplementations(build(vars)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["whatsapp-implementations"] });
      qc.invalidateQueries({ queryKey: ["whatsapp-service-status"] });
      qc.invalidateQueries({ queryKey: ["whatsapp-overrides"] });
      qc.invalidateQueries({ queryKey: ["org-entitlements"] });
    },
  });
}

export const useCreateImplementation = () =>
  useImplementationMutation<Record<string, unknown>>((v) => ({ action: "create", ...v }));

export const useRegisterExternalPayment = () =>
  useImplementationMutation<Record<string, unknown>>((v) => ({
    action: "register_external_payment", ...v,
  }));

export const useSetOperationalStatus = () =>
  useImplementationMutation<{
    id: string; operational_status: string; scheduled_for?: string | null;
    owner_admin_id?: string | null; notes?: string | null;
  }>((v) => ({ action: "set_operational_status", ...v }));

export const useCancelImplementation = () =>
  useImplementationMutation<{ id: string; cancel_reason: string }>((v) => ({
    action: "cancel", ...v,
  }));

export const useGrantWhatsappOverride = () =>
  useImplementationMutation<{
    organization_id: string; grant_type: string; reason: string; ends_at?: string | null;
  }>((v) => ({ action: "grant_whatsapp_override", ...v }));

export const useRevokeWhatsappOverride = () =>
  useImplementationMutation<{ organization_id: string; override_id: string }>((v) => ({
    action: "revoke_whatsapp_override", ...v,
  }));

export function useWhatsappOverrides(organizationId: string | undefined) {
  return useQuery({
    queryKey: ["whatsapp-overrides", organizationId],
    enabled: !!organizationId,
    queryFn: async () => {
      const res = await invokeWhatsappImplementations({
        action: "list_whatsapp_overrides",
        organization_id: organizationId,
      });
      return (res as { overrides: Record<string, unknown>[] }).overrides;
    },
  });
}

/** Abre o checkout da implantação e redireciona. O `purpose` vai explícito — o
 *  servidor resolve produto e preço; o navegador não escolhe nenhum dos dois. */
export function useCreateImplementationCheckout() {
  return useMutation({
    mutationFn: async (params: { organization_id: string; plan_id: string }) => {
      const { data, error } = await supabase.functions.invoke("create-billing-checkout", {
        body: { ...params, purpose: "implementation" },
      });
      if (error) {
        let message = error.message ?? "Erro inesperado.";
        const ctx = (error as { context?: Response }).context;
        if (ctx && typeof ctx.json === "function") {
          try {
            const parsed = await ctx.json();
            if (parsed?.error) message = String(parsed.error);
          } catch { /* corpo não-JSON */ }
        }
        throw new Error(message);
      }
      return data as { success: true; url: string; session_id: string };
    },
    onSuccess: (data) => {
      if (data?.url) window.location.href = data.url;
    },
  });
}
