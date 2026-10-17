import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";

export type WhatsappInstance = {
  id: string;
  organization_id: string;
  unit_id: string | null;
  channel_id: string | null;
  provider: string;
  provider_instance_ref: string | null;
  lifecycle_state: string;
  provider_cycle_anchor_day: number | null;
  current_cycle_started_on: string | null;
  current_cycle_due_on: string | null;
  cycle_source: string;
  current_monthly_cost_cents: number | null;
  cost_source: string | null;
  cost_note: string | null;
  cancellation_requested_at: string | null;
  cancellation_reason: string | null;
  provider_access_until: string | null;
  end_confirmation_required_at: string | null;
  ended_at: string | null;
  planned_provision_on: string | null;
  last_divergence_kind: string | null;
  last_divergence_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  /** Calculado pela EF: custo atual ou algum ciclo com custo. Ausente em EF antiga. */
  has_cost_history?: boolean;
};

export type WhatsappInstanceCycle = {
  id: string;
  instance_id: string;
  cycle_start: string;
  provider_due_on: string;
  status: string;
  provider_cost_cents: number | null;
  customer_revenue_cents: number | null;
  revenue_source: string | null;
  gross_margin_cents: number | null;
  cost_source: string | null;
  closed_at: string | null;
};

export type WhatsappInstanceAlert = {
  id: string;
  subject_type: string;
  subject_id: string;
  organization_id: string;
  instance_id: string | null;
  channel_id: string | null;
  alert_type: string;
  dedupe_key: string;
  status: string;
  first_detected_at: string;
  last_seen_at: string;
  occurrences: number;
  resolution_note: string | null;
  payload: Record<string, unknown>;
  dispatch_enabled_at_enqueue: boolean;
};

export type WhatsappInstanceNote = {
  id: string;
  instance_ref: string;
  instance_id: string | null;
  organization_id: string;
  action: string;
  note: string;
  created_by: string | null;
  /** Resolvido pela EF; `null` quando o lookup falhou ou passou do teto. */
  created_by_email: string | null;
  created_at: string;
};

export type PartnerSimulation = {
  simulated: true;
  instancesWithKnownCost: number;
  instancesWithUnknownCost: number;
  currentKnownCostCents: number;
  partnerMonthlyTargetCents: number;
  savingsCents: number;
  breakEvenInstances: number | null;
};

/**
 * `supabase.functions.invoke` MASCARA o corpo de erro non-2xx. Sem extrair via
 * FunctionsHttpError, o gate de provisionamento (409 com código) chegaria à UI
 * como "Edge Function returned a non-2xx status code" e o operador não saberia
 * o que fazer.
 */
async function callEf<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("manage-whatsapp-instances", { body });
  if (error) {
    let message = error.message;
    let code: string | undefined;
    let httpStatus: number | undefined;
    let parsedBody: Record<string, unknown> | null = null;
    if (error instanceof FunctionsHttpError) {
      httpStatus = error.context?.status;
      const parsed = await error.context.json().catch(() => null);
      parsedBody = parsed;
      if (parsed?.error) message = parsed.error;
      code = parsed?.code;
    }
    const e = new Error(message) as Error & {
      code?: string;
      httpStatus?: number;
      /** Corpo non-2xx completo. O 409 de unidade ocupada traz `conflicts`, que
       *  a tela precisa MOSTRAR — mensagem sozinha não diz o que já existe. */
      body?: Record<string, unknown>;
    };
    e.code = code;
    e.httpStatus = httpStatus;
    e.body = parsedBody ?? undefined;
    throw e;
  }
  return data as T;
}

export function useWhatsappInstances() {
  return useQuery({
    queryKey: ["whatsapp-instances"],
    queryFn: () =>
      callEf<{ instances: WhatsappInstance[] }>({ action: "list_instances" }).then(
        (r) => r.instances,
      ),
  });
}

export function useWhatsappInstance(id: string | null) {
  return useQuery({
    queryKey: ["whatsapp-instance", id],
    enabled: !!id,
    queryFn: () =>
      callEf<{
        instance: WhatsappInstance;
        cycles: WhatsappInstanceCycle[];
        alerts: WhatsappInstanceAlert[];
      }>({ action: "get_instance", instance_id: id }),
  });
}

export function useWhatsappInstanceAlerts(status?: string) {
  return useQuery({
    queryKey: ["whatsapp-instance-alerts", status ?? "all"],
    queryFn: () =>
      callEf<{ alerts: WhatsappInstanceAlert[] }>({ action: "list_alerts", status }).then(
        (r) => r.alerts,
      ),
  });
}

export function useWhatsappInstanceNotes(instanceId: string | null) {
  return useQuery({
    queryKey: ["whatsapp-instance-notes", instanceId],
    enabled: !!instanceId,
    queryFn: () =>
      callEf<{ notes: WhatsappInstanceNote[] }>({
        action: "list_instance_notes",
        instance_id: instanceId,
      }).then((r) => r.notes),
  });
}

export function useWhatsappInstanceAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { action: string; [k: string]: unknown }) => callEf(body),
    onSettled: () => {
      // Invalidate BROAD nas três keys: `invalidateQueries` é prefix-match e
      // as três começam com prefixos distintos — invalidar uma não pega as
      // outras.
      qc.invalidateQueries({ queryKey: ["whatsapp-instances"] });
      qc.invalidateQueries({ queryKey: ["whatsapp-instance"] });
      qc.invalidateQueries({ queryKey: ["whatsapp-instance-alerts"] });
      // QUARTA key. `invalidateQueries` é prefix-match POR ELEMENTO do array:
      // ["whatsapp-instance"] NÃO casa ["whatsapp-instance-notes", id] — são
      // strings diferentes na posição 0. Sem esta linha, o histórico só
      // atualizaria no próximo refetch e a observação recém-gravada não
      // apareceria depois da ação que a criou.
      qc.invalidateQueries({ queryKey: ["whatsapp-instance-notes"] });
    },
  });
}

/** Simulação NÃO persiste nada — por isso mutation sem invalidação. */
export function usePartnerSimulation() {
  return useMutation({
    mutationFn: (v: { organization_id?: string | null; partner_monthly_target_cents: number }) =>
      callEf<{ simulation: PartnerSimulation }>({ action: "simulate_partner", ...v }).then(
        (r) => r.simulation,
      ),
  });
}
