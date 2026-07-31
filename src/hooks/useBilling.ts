import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type {
  BillingPlan,
  OrgBillingRow,
  OrgBillingDetail,
  BillingInvoice,
  PlanChangePreview,
} from "@/types/billing";

async function invokeManageBilling(body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke("manage-billing", { body });
  if (error) {
    const message = (data as { error?: string } | null)?.error ?? error.message;
    throw new Error(message);
  }
  if (data && typeof data === "object" && "error" in data && data.error) {
    throw new Error(String(data.error));
  }
  return data;
}

// ── Plans ────────────────────────────────────────────────────────────────────

export function useBillingPlans() {
  return useQuery<BillingPlan[]>({
    queryKey: ["billing-plans"],
    queryFn: async () => {
      const res = await invokeManageBilling({ action: "list_plans" });
      return res.plans;
    },
  });
}

export function useCreatePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: Record<string, unknown>) =>
      invokeManageBilling({ action: "create_plan", ...params }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["billing-plans"] }),
  });
}

export function useUpdatePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: Record<string, unknown>) =>
      invokeManageBilling({ action: "update_plan", ...params }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["billing-plans"] }),
  });
}

export function useDeactivatePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (planId: string) =>
      invokeManageBilling({ action: "deactivate_plan", plan_id: planId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["billing-plans"] }),
  });
}

// ── Organizations Billing List ───────────────────────────────────────────────

export function useOrganizationsBilling(filters: {
  status?: string;
  plan_id?: string;
  search?: string;
  page?: number;
  page_size?: number;
}) {
  return useQuery<{ organizations: OrgBillingRow[]; total: number | null }>({
    queryKey: ["billing-orgs", filters],
    queryFn: async () => {
      const res = await invokeManageBilling({
        action: "list_organizations_billing",
        ...filters,
      });
      return { organizations: res.organizations, total: res.total };
    },
  });
}

// ── Organization Billing Detail ──────────────────────────────────────────────

export function useOrgBillingDetail(organizationId: string | undefined) {
  return useQuery<OrgBillingDetail>({
    queryKey: ["billing-detail", organizationId],
    queryFn: async () => {
      const res = await invokeManageBilling({
        action: "get_organization_billing",
        organization_id: organizationId,
      });
      return res as OrgBillingDetail;
    },
    enabled: !!organizationId,
  });
}

// ── Customer ─────────────────────────────────────────────────────────────────

export function useCreateBillingCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: { organization_id: string; email?: string; name?: string; tax_id?: string }) =>
      invokeManageBilling({ action: "create_or_get_billing_customer", ...params }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["billing-detail", vars.organization_id] });
      qc.invalidateQueries({ queryKey: ["billing-orgs"] });
    },
  });
}

// ── Subscription ─────────────────────────────────────────────────────────────

export function useCreateSubscription() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      organization_id: string;
      plan_id: string;
      payment_method?: string;
      trial_days?: number;
    }) => invokeManageBilling({ action: "create_subscription", ...params }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["billing-detail", vars.organization_id] });
      qc.invalidateQueries({ queryKey: ["billing-orgs"] });
    },
  });
}

export function useCancelSubscription() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: { subscription_id: string; at_period_end?: boolean }) =>
      invokeManageBilling({ action: "cancel_subscription", ...params }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["billing-detail"] });
      qc.invalidateQueries({ queryKey: ["billing-orgs"] });
    },
  });
}

// ── Invoices ─────────────────────────────────────────────────────────────────

export function useBillingInvoices(filters: {
  organization_id?: string;
  status?: string;
  page?: number;
  page_size?: number;
}) {
  return useQuery<{ invoices: BillingInvoice[]; total: number | null }>({
    queryKey: ["billing-invoices", filters],
    queryFn: async () => {
      const res = await invokeManageBilling({ action: "list_invoices", ...filters });
      return { invoices: res.invoices, total: res.total };
    },
    enabled: !!filters.organization_id,
  });
}

/**
 * Faturas retidas para revisão administrativa (migration 077, Task 20).
 * `page_size` alto — painel de auditoria, não lista paginada de rotina; o
 * volume esperado é baixo (retenção é exceção, não regra, ver o header da
 * migration).
 */
export function useHeldInvoices() {
  return useQuery<{ invoices: BillingInvoice[]; total: number | null }>({
    queryKey: ["billing-invoices-held"],
    queryFn: async () => {
      const res = await invokeManageBilling({
        action: "list_invoices",
        enforcement_hold: true,
        page_size: 200,
      });
      return { invoices: res.invoices, total: res.total };
    },
  });
}

export function useReleaseInvoiceEnforcementHold() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: { invoice_id: string; reason: string }) =>
      invokeManageBilling({ action: "release_invoice_enforcement_hold", ...params }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["billing-invoices-held"] });
      qc.invalidateQueries({ queryKey: ["billing-invoices"] });
      qc.invalidateQueries({ queryKey: ["billing-detail"] });
    },
  });
}

export function useCreateManualInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      organization_id: string;
      amount_cents: number;
      description?: string;
      payment_method?: string;
      days_until_due?: number;
    }) => invokeManageBilling({ action: "create_manual_invoice", ...params }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["billing-detail", vars.organization_id] });
      qc.invalidateQueries({ queryKey: ["billing-invoices"] });
    },
  });
}

// ── Overrides ────────────────────────────────────────────────────────────────

export function useCreateOverride() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      organization_id: string;
      override_type: string;
      reason: string;
      valid_until?: string;
    }) => invokeManageBilling({ action: "create_override", ...params }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["billing-detail", vars.organization_id] });
      qc.invalidateQueries({ queryKey: ["billing-orgs"] });
    },
  });
}

export function useDeactivateOverride() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (overrideId: string) =>
      invokeManageBilling({ action: "deactivate_override", override_id: overrideId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["billing-detail"] });
    },
  });
}

// ── Block / Unblock ──────────────────────────────────────────────────────────

export function useBlockOrganization() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: { organization_id: string; reason: string }) =>
      invokeManageBilling({ action: "block_organization_manual", ...params }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["billing-detail", vars.organization_id] });
      qc.invalidateQueries({ queryKey: ["billing-orgs"] });
    },
  });
}

export function useUnblockOrganization() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (organizationId: string) =>
      invokeManageBilling({ action: "unblock_organization_manual", organization_id: organizationId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["billing-detail"] });
      qc.invalidateQueries({ queryKey: ["billing-orgs"] });
    },
  });
}

// ── Trial ────────────────────────────────────────────────────────────────────

export function useExtendTrial() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: { organization_id: string; trial_days: number; reason?: string }) =>
      invokeManageBilling({ action: "extend_trial", ...params }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["billing-detail", vars.organization_id] });
      qc.invalidateQueries({ queryKey: ["billing-orgs"] });
    },
  });
}

// ── Self-service (cliente) ───────────────────────────────────────────────────

/**
 * Abre o checkout hospedado (mode=subscription | setup) e redireciona o
 * navegador pra `data.url`. O provedor (Stripe ou Asaas) é decidido
 * server-side — o frontend não sabe nem escolhe. Aceita o caller ser
 * owner/gerente da org OU platform_admin (backend valida).
 */
export function useCreateBillingCheckout() {
  return useMutation({
    mutationFn: async (params: {
      organization_id: string;
      plan_id?: string;
      /** `mode` saiu do contrato na Fase 5a. A EF ainda aceita o campo legado
       *  por uma release; o frontend já manda `purpose`. */
      purpose?: "subscription" | "payment_method_update";
    }) => {
      const { data, error } = await supabase.functions.invoke("create-billing-checkout", { body: params });
      if (error) {
        // supabase-js zera `data` em erro HTTP — a mensagem do backend só
        // existe no corpo da resposta, acessível via error.context. Mesmo
        // padrão de useOrganizations.ts.
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
      return data as { success: true; url: string; session_id: string };
    },
    onSuccess: (data) => {
      if (data?.url) window.location.href = data.url;
    },
  });
}

export function usePreviewPlanChange() {
  return useMutation<PlanChangePreview, Error, { subscription_id: string; new_plan_id: string; organization_id: string }>({
    mutationFn: async (params) => {
      const res = await invokeManageBilling({ action: "preview_plan_change", ...params });
      return res as PlanChangePreview;
    },
  });
}

export function useChangePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: { subscription_id: string; new_plan_id: string; organization_id: string }) =>
      invokeManageBilling({ action: "change_plan", ...params }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["billing-detail", vars.organization_id] });
      qc.invalidateQueries({ queryKey: ["billing-orgs"] });
      qc.invalidateQueries({ queryKey: ["org-billing-status"] });
    },
  });
}

export function useCancelByOwner() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: { subscription_id: string; organization_id: string }) =>
      invokeManageBilling({ action: "cancel_subscription_by_owner", ...params }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["billing-detail", vars.organization_id] });
      qc.invalidateQueries({ queryKey: ["billing-orgs"] });
      qc.invalidateQueries({ queryKey: ["org-billing-status"] });
    },
  });
}

// ── Sync ─────────────────────────────────────────────────────────────────────

export function useSyncFromStripe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (organizationId: string) =>
      invokeManageBilling({ action: "sync_organization_from_stripe", organization_id: organizationId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["billing-detail"] });
      qc.invalidateQueries({ queryKey: ["billing-orgs"] });
    },
  });
}

// ── Entitlements (leitura, Fase 4a — nada aqui bloqueia) ────────────────────

export interface FeatureEntitlementView {
  allowed: boolean;
  source: "admin_block" | "override" | "subscription" | "trial" | "wallet" | "legacy" | "none";
  status: string;
  expires_at: string | null;
}

export interface OrgEntitlementsView {
  system: FeatureEntitlementView;
  whatsapp: FeatureEntitlementView;
  ai: FeatureEntitlementView;
}

export function useOrgEntitlements(organizationId: string | null) {
  return useQuery<OrgEntitlementsView>({
    queryKey: ["org-entitlements", organizationId],
    enabled: !!organizationId,
    queryFn: async () => {
      const res = await invokeManageBilling({
        action: "get_org_entitlements",
        organization_id: organizationId,
      });
      return (res as { entitlements: OrgEntitlementsView }).entitlements;
    },
  });
}
