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
 * Cria Stripe Checkout Session (mode=subscription | setup) e redireciona o
 * navegador pra `data.url`. Aceita o caller ser owner/gerente da org OU
 * platform_admin (backend valida).
 */
export function useCreateBillingCheckout() {
  return useMutation({
    mutationFn: async (params: {
      organization_id: string;
      plan_id?: string;
      mode?: "subscription" | "setup";
    }) => {
      const { data, error } = await supabase.functions.invoke("create-billing-checkout", { body: params });
      if (error) {
        const message = (data as { error?: string } | null)?.error ?? error.message;
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
