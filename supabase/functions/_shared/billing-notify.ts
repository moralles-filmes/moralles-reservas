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
/**
 * Devolve `true` quando o aviso está NA FILA — inclusive por dedupe, porque
 * `23505` significa que a linha já existe e alguém vai despachá-la.
 *
 * O retorno era `void` e a falha só ia para o log. Isso basta para quem
 * enfileira e segue, mas NÃO para quem grava um "já avisei" ao lado: o worker
 * de ciclos avançava `last_reminder_at` em cima de um enfileiramento que podia
 * ter falhado, e o próximo lembrete real só sairia 30 dias depois — o pior dos
 * dois mundos, porque o ledger afirmava "lembrado".
 *
 * Ampliar `void` → `boolean` é compatível com os chamadores existentes, que
 * ignoram o retorno: uma cópia antiga em memória continua correta.
 */
export async function enqueueBillingNotification(
  supabase: SupabaseClient,
  n: { organizationId: string; eventType: string; invoiceId: string | null; recipient: string },
): Promise<boolean> {
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
    return true;
  }
  if (error) {
    jsonLog("error", {
      evt: "billing_notification_enqueue_failed",
      event_type: n.eventType,
      org: n.organizationId,
      err: error.message,
    });
    return false;
  }
  return true;
}

// Teto de VARREDURA da busca abaixo — não de destinatários. Esta função é
// chamada de dentro do caminho síncrono do asaas-webhook (sem orçamento próprio,
// diferente do I/O com o Asaas — ver ASAAS_IO_BUDGET_MS no CLAUDE.md) e faz uma
// chamada HTTP ao Auth Admin por linha VARRIDA. Como só um destinatário é
// consumido, a varredura para no primeiro e-mail utilizável (ver laço abaixo) e
// na prática gasta UMA chamada; o cap só limita o pior caso — o admin mais
// antigo sem e-mail resolvível (usuário removido, banido), em que é preciso
// andar na lista pra achar quem receba.
const PLATFORM_ADMIN_RECIPIENTS_CAP = 10;

/**
 * E-mail do administrador da PLATAFORMA mais antigo que tenha endereço
 * utilizável. Devolve array de 0 ou 1 elemento — array, e não `string | null`,
 * pra manter o contrato do caller (`recipients[0]`).
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

  // PARA no primeiro e-mail utilizável. A ordem (antiguidade) e a escolha
  // (o admin mais antigo que dê pra notificar) são exatamente as de antes — o
  // que muda é não continuar chamando o Auth Admin depois de já ter a resposta,
  // dentro da resposta do webhook e depois de até 5s já gastos no getPayment.
  const total = (admins ?? []).length;
  let scanned = 0;
  for (const row of admins ?? []) {
    scanned++;
    const { data, error: userErr } = await supabase.auth.admin.getUserById(
      row.user_id as string,
    );
    if (userErr || !data?.user) continue;
    // Usuário banido não recebe aviso operacional.
    const bannedUntil = (data.user as { banned_until?: string | null }).banned_until;
    if (bannedUntil && new Date(bannedUntil).getTime() > Date.now()) continue;
    const email = data.user.email?.trim().toLowerCase();
    if (!email) continue;

    if (total > 1) {
      // Existem outros admins e eles NÃO serão avisados (uma linha só em
      // billing_notifications — o UNIQUE deduplicaria o resto). Visível de
      // propósito: silêncio aqui lê como "avisei todo mundo".
      jsonLog("info", {
        evt: "platform_admin_recipient_chosen",
        chosen: email,
        scanned,
        total_admins: total,
      });
    }
    return [email];
  }

  jsonLog("warn", { evt: "platform_admin_recipients_empty", admins: total });
  return [];
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
