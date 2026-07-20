// Enfileira billing_notifications (status 'pending') para o dispatcher
// (process-billing-notifications). resolveBillingRecipient escopa o fallback de
// owner por ORG — fecha o vazamento cross-tenant que existia em
// process-billing-reminders (pegava o owner mais antigo da PLATAFORMA).
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jsonLog } from "./security.ts";
import { pickRecipient } from "./billing-delinquency-core.ts";

/** billing_email da org, ou o owner DA PRÓPRIA ORG, ou null. */
export async function resolveBillingRecipient(
  supabase: SupabaseClient,
  orgId: string,
): Promise<string | null> {
  const { data: org } = await supabase
    .from("organizations")
    .select("billing_email")
    .eq("id", orgId)
    .maybeSingle();

  let ownerEmail: string | null = null;
  if (!org?.billing_email) {
    // Escopar por org em dois passos (sem depender de filtro em recurso embutido):
    // units da org -> owners dessas units. Sem isso pegaria o owner mais antigo
    // da plataforma inteira (vazamento cross-tenant).
    const { data: units } = await supabase
      .from("units")
      .select("id")
      .eq("organization_id", orgId);
    const unitIds = (units ?? []).map((u) => u.id as string);
    if (unitIds.length > 0) {
      const { data: owner } = await supabase
        .from("unit_members")
        .select("email")
        .in("unit_id", unitIds)
        .eq("role", "owner")
        .order("created_at")
        .limit(1)
        .maybeSingle();
      ownerEmail = (owner?.email as string | undefined) ?? null;
    }
  }
  return pickRecipient(org?.billing_email as string | null | undefined, ownerEmail);
}

/**
 * INSERT ... ON CONFLICT DO NOTHING via tratamento de 23505 (padrão voucher do
 * CLAUDE.md). O UNIQUE (organization_id, event_type, invoice_id) garante 1 aviso
 * por ciclo. Best-effort: nunca lança.
 */
export async function enqueueBillingNotification(
  supabase: SupabaseClient,
  n: { organizationId: string; eventType: string; invoiceId: string | null; recipient: string },
): Promise<void> {
  const { error } = await supabase.from("billing_notifications").insert({
    organization_id: n.organizationId,
    event_type: n.eventType,
    invoice_id: n.invoiceId,
    channel: "email",
    recipient: n.recipient,
    status: "pending",
  });
  if (error && error.code === "23505") {
    jsonLog("info", {
      evt: "billing_notification_dedup",
      event_type: n.eventType,
      org: n.organizationId,
    });
  } else if (error) {
    jsonLog("error", {
      evt: "billing_notification_enqueue_failed",
      event_type: n.eventType,
      org: n.organizationId,
      err: error.message,
    });
  }
}

/**
 * true se a org tem cortesia/override de sistema ATIVO (não pode ser bloqueada
 * nem avisada por inadimplência). enabled=true = grant positivo; enabled=false é
 * bloqueio explícito e não impede escalação (a org já deve estar sem acesso).
 */
export async function hasActiveSystemOverride(
  supabase: SupabaseClient,
  orgId: string,
): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const { data } = await supabase
    .from("organization_entitlement_overrides")
    .select("id")
    .eq("organization_id", orgId)
    .eq("feature", "system")
    .eq("enabled", true)
    .is("revoked_at", null)
    .or(`ends_at.is.null,ends_at.gt.${nowIso}`)
    .limit(1);
  return (data ?? []).length > 0;
}
