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
  if (!org?.billing_email?.trim()) {
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
 * por ciclo (índice é PARCIAL: where invoice_id is not null, logo chamadas com
 * invoiceId: null não são deduplicadas). Best-effort: nunca lança.
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

// Teto da consulta abaixo: esta função é chamada de dentro do caminho síncrono
// do asaas-webhook (sem orçamento próprio, diferente do I/O com o Asaas — ver
// ASAAS_IO_BUDGET_MS no CLAUDE.md) e faz UMA chamada HTTP ao Auth Admin por
// linha, embora só `recipients[0]` seja usado de fato. Sem teto, uma lista de
// platform_admins que cresça vira N chamadas sequenciais ao GoTrue dentro dos
// 10s que o Asaas concede pra resposta — o mesmo acidente que o orçamento do
// Asaas evita, só que sem orçamento nenhum aqui.
const PLATFORM_ADMIN_RECIPIENTS_CAP = 10;

/**
 * E-mails dos administradores da PLATAFORMA, ordenados por antiguidade.
 *
 * NÃO reusa resolveBillingRecipient, que é org-scoped de propósito (o fix do
 * vazamento cross-tenant da Fase 4b). Aqui o destinatário é a própria Moralles:
 * "o cliente X pagou a implantação" é aviso interno, não do cliente.
 *
 * Best-effort: devolve [] em qualquer falha e loga. NUNCA pode derrubar a
 * confirmação financeira que a chamou.
 */
export async function resolvePlatformAdminRecipients(
  supabase: SupabaseClient,
): Promise<string[]> {
  const { data: admins, error } = await supabase
    .from("platform_admins")
    .select("user_id")
    .order("created_at", { ascending: true })
    .limit(PLATFORM_ADMIN_RECIPIENTS_CAP);

  if (error) {
    jsonLog("error", { evt: "platform_admin_recipients_read_failed", err: error.message });
    return [];
  }

  if ((admins ?? []).length === PLATFORM_ADMIN_RECIPIENTS_CAP) {
    // Cap atingido: pode haver mais platform_admins não lidos aqui. Loga pra
    // não parecer silenciosamente "cobri todo mundo" — cap silencioso lê como
    // cobertura completa quando não é.
    jsonLog("warn", {
      evt: "platform_admin_recipients_capped",
      cap: PLATFORM_ADMIN_RECIPIENTS_CAP,
      count: admins!.length,
    });
  }

  const emails: string[] = [];
  const seen = new Set<string>();
  for (const row of admins ?? []) {
    const { data, error: userErr } = await supabase.auth.admin.getUserById(
      row.user_id as string,
    );
    if (userErr || !data?.user) continue;
    // Usuário banido não recebe aviso operacional.
    const bannedUntil = (data.user as { banned_until?: string | null }).banned_until;
    if (bannedUntil && new Date(bannedUntil).getTime() > Date.now()) continue;
    const email = data.user.email?.trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    emails.push(email);
  }

  if (emails.length === 0) {
    jsonLog("warn", { evt: "platform_admin_recipients_empty", admins: (admins ?? []).length });
  }
  return emails;
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
    .lte("starts_at", nowIso)
    .or(`ends_at.is.null,ends_at.gt.${nowIso}`)
    .limit(1);
  return (data ?? []).length > 0;
}
