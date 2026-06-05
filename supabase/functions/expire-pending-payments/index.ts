// Worker pg_cron: cancela reservas com pagamento pendente expirado.
//
// Schedule: */2 * * * * (a cada 2 minutos)
// Auth: x-internal-key via Vault (mesmo padrão dos outros workers).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jsonLog, requireInternalAuth } from "../_shared/security.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  if (!requireInternalAuth(req)) {
    return new Response(
      JSON.stringify({ error: "unauthorized" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  try {
    const now = new Date().toISOString();

    const { data: expired, error } = await supabase
      .from("reservations")
      .update({
        payment_status: "expired",
        status: "cancelled",
        updated_at: now,
      })
      .eq("payment_status", "pending_payment")
      .lt("payment_expires_at", now)
      .select("id");

    if (error) {
      jsonLog("error", { evt: "expire_payments_error", err: error.message });
      return new Response(
        JSON.stringify({ error: error.message }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }

    const count = expired?.length ?? 0;
    if (count > 0) {
      jsonLog("info", {
        evt: "expire_payments_processed",
        count,
        ids: expired!.map((r) => r.id),
      });
    }

    return new Response(
      JSON.stringify({ success: true, expired_count: count }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    jsonLog("error", { evt: "expire_payments_unhandled", err: String(err) });
    return new Response(
      JSON.stringify({ error: "Erro interno." }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
