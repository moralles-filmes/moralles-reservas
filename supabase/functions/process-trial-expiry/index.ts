// Edge Function: process-trial-expiry
// Worker pg_cron diário às 03:00 UTC (00:00 BRT).
//
// Move orgs com trial vencido (billing_status='trialing' + trial_ends_at < now())
// pra billing_status='blocked', desde que:
//   - NÃO tenham subscription ativa (sub != canceled) — admin pode ter criado plano manual durante o trial
//   - NÃO tenham override grant_access ativo — admin pode ter dado cortesia
//
// Cliente bloqueado por trial vai cair na tela de Cobrança (whitelist do
// BillingGuard) onde pode escolher um plano pago e reativar.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireInternalAuth, genRequestId, jsonLog } from "../_shared/security.ts";
import { SYSTEM_CATEGORY } from "../_shared/billing-category.ts";
import { hasActiveSystemOverride } from "../_shared/billing-notify.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const BLOCKED_REASON = "Trial expirado — escolha um plano para continuar usando.";

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  if (!requireInternalAuth(req)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const reqId = genRequestId();

  try {
    // 1) Busca orgs em trial vencido
    const { data: candidates, error: selErr } = await supabase
      .from("organizations")
      .select("id, name, slug, billing_status, trial_ends_at")
      .eq("billing_status", "trialing")
      .lt("trial_ends_at", new Date().toISOString());

    if (selErr) {
      jsonLog("error", { reqId, evt: "trial_expiry_select_error", err: selErr.message });
      return new Response(JSON.stringify({ error: "Falha ao listar trials." }), { status: 500 });
    }

    if (!candidates || candidates.length === 0) {
      jsonLog("info", { reqId, evt: "trial_expiry_no_candidates" });
      return new Response(JSON.stringify({ success: true, blocked: 0, skipped: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const orgIds = candidates.map((o) => o.id);

    // 2) Filtra orgs que JÁ têm subscription de SISTEMA (admin criou plano
    //    manual durante o trial). Uma assinatura de instância de WhatsApp NÃO
    //    conta: ela não dá acesso ao sistema, e considerá-la aqui faria o trial
    //    nunca expirar para quem contratou só a automação.
    const { data: activeSubs } = await supabase
      .from("billing_subscriptions")
      .select("organization_id, billing_plans!inner(category)")
      .in("organization_id", orgIds)
      .neq("status", "canceled")
      .eq("billing_plans.category", SYSTEM_CATEGORY);
    const orgsWithActiveSub = new Set((activeSubs ?? []).map((s) => s.organization_id as string));

    // 3) Filtra orgs com override grant_access ativo
    const { data: grants } = await supabase
      .from("billing_access_overrides")
      .select("organization_id")
      .in("organization_id", orgIds)
      .eq("override_type", "grant_access")
      .eq("active", true);
    const orgsWithGrant = new Set((grants ?? []).map((g) => g.organization_id as string));

    let blocked = 0;
    let skipped = 0;

    for (const org of candidates) {
      if (orgsWithActiveSub.has(org.id)) {
        skipped++;
        jsonLog("info", { reqId, evt: "trial_expiry_skip_has_sub", orgId: org.id, slug: org.slug });
        continue;
      }
      if (orgsWithGrant.has(org.id)) {
        skipped++;
        jsonLog("info", { reqId, evt: "trial_expiry_skip_grant_override", orgId: org.id, slug: org.slug });
        continue;
      }

      // N4 (review final fase 5a): esta fase estreitou o skip de "qualquer
      // assinatura viva" pra só a de categoria de sistema (passo 2 acima) —
      // mas isso tirou a rede que cobria cortesia vitalícia. Espelha o mesmo
      // skip de process-billing-overdue/process-billing-reminders: cortesia
      // registrada em organization_entitlement_overrides (feature "system")
      // nunca pode ser bloqueada por este cron, mesmo sem grant_access legado
      // em billing_access_overrides.
      if (await hasActiveSystemOverride(supabase, org.id)) {
        skipped++;
        jsonLog("info", { reqId, evt: "trial_expiry_skip_system_override", orgId: org.id, slug: org.slug });
        continue;
      }

      const { error: updErr } = await supabase
        .from("organizations")
        .update({
          billing_status: "blocked",
          blocked_at: new Date().toISOString(),
          blocked_reason: BLOCKED_REASON,
        })
        .eq("id", org.id)
        .eq("billing_status", "trialing"); // guard contra race condition

      if (updErr) {
        jsonLog("error", { reqId, evt: "trial_expiry_update_error", orgId: org.id, err: updErr.message });
        continue;
      }

      // Log em billing_notifications pra auditoria
      await supabase.from("billing_notifications").insert({
        organization_id: org.id,
        event_type: "trial_expired_blocked",
        channel: "app",
        recipient: org.slug,
        status: "logged",
      });

      blocked++;
      jsonLog("info", { reqId, evt: "trial_expiry_blocked", orgId: org.id, slug: org.slug, trialEndsAt: org.trial_ends_at });
    }

    jsonLog("info", { reqId, evt: "trial_expiry_done", candidates: candidates.length, blocked, skipped });

    return new Response(JSON.stringify({ success: true, blocked, skipped, total: candidates.length }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    jsonLog("error", { reqId, evt: "trial_expiry_unexpected", err: err instanceof Error ? err.message : String(err) });
    return new Response("Internal error", { status: 500 });
  }
});
