// Worker: desbloqueia orgs que têm invoice paga recente.
// Roda a cada 5 minutos via pg_cron. Defesa dupla: webhook invoice.paid
// já desbloqueia, mas este worker pega casos onde webhook falhou/atrasou.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireInternalAuth, genRequestId, jsonLog } from "../_shared/security.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

serve(async (req) => {
  if (!requireInternalAuth(req)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  const reqId = genRequestId();

  try {
    // Buscar orgs bloqueadas/vencidas
    const { data: blockedOrgs } = await supabase
      .from("organizations")
      .select("id, billing_status")
      .in("billing_status", ["blocked", "past_due", "grace_period", "pending_payment"]);

    let unblocked = 0;
    for (const org of blockedOrgs ?? []) {
      // Verificar se tem alguma invoice paga nos últimos 7 dias
      const since = new Date(Date.now() - 7 * 86400000).toISOString();
      const { data: paidInvoice } = await supabase
        .from("billing_invoices")
        .select("id")
        .eq("organization_id", org.id)
        .eq("status", "paid")
        .gte("paid_at", since)
        .limit(1)
        .maybeSingle();

      if (!paidInvoice) continue;

      // Verificar se não tem override de block_access ativo
      const { data: blockOverride } = await supabase
        .from("billing_access_overrides")
        .select("id")
        .eq("organization_id", org.id)
        .eq("override_type", "block_access")
        .eq("active", true)
        .maybeSingle();

      if (blockOverride) continue;

      await supabase.from("organizations").update({
        billing_status: "active",
        blocked_at: null,
        blocked_reason: null,
      }).eq("id", org.id);

      unblocked++;
      jsonLog("info", { reqId, evt: "billing_auto_unblocked", orgId: org.id });
    }

    if (unblocked > 0) {
      jsonLog("info", { reqId, evt: "billing_unblock_done", unblocked });
    }

    return new Response(JSON.stringify({ success: true, unblocked }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    jsonLog("error", { reqId, evt: "billing_unblock_error", err: String(err) });
    return new Response(JSON.stringify({ error: "internal" }), { status: 500 });
  }
});
