import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendWhatsApp } from "../_shared/whatsapp-send.ts";
import { clearWhatsAppGateCache } from "../_shared/whatsapp-service-gate.ts";
import { clearChannelConnectivityCache } from "../_shared/whatsapp-send.ts";
import { jsonLog, sanitizePhone } from "../_shared/security.ts";
import { appendOutboundToConversation } from "../_shared/conversation-log.ts";
import { hasUnitAccess } from "../_shared/authz.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function formatDate(dateStr: string): string {
  const [year, month, day] = dateStr.split("-");
  return `${day}/${month}/${year}`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Cache do gate é por invocação — zera aqui, mesmo padrão do unitCache dos
  // workers, senão um isolate quente serve estado de suspensão velho.
  clearWhatsAppGateCache();
  clearChannelConnectivityCache();

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  try {
    const { reservation_id } = await req.json();
    if (!reservation_id) {
      return new Response(JSON.stringify({ error: "reservation_id é obrigatório" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: reserva, error: rErr } = await supabase
      .from("reservations")
      .select("id, status, date, time, party_size, reservation_code, unit_id, customer:customers(id, name, phone)")
      .eq("id", reservation_id)
      .maybeSingle();

    if (rErr || !reserva) {
      return new Response(JSON.stringify({ error: "reserva não encontrada" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // platform_admin opera unidades alheias via pseudo-membership fabricada em
    // useCurrentUnit.ts — backend tem que aceitar o paralelo, senão super-admin
    // recebe 403 mesmo com a UI mostrando "Proprietário".
    if (!(await hasUnitAccess(supabase, user.id, reserva.unit_id))) {
      return new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (reserva.status !== "cancelled") {
      return new Response(JSON.stringify({ error: "reserva não está cancelada" }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: existing } = await supabase
      .from("notifications_sent")
      .select("status")
      .eq("reservation_id", reservation_id)
      .eq("kind", "cancellation")
      .maybeSingle();

    if (existing?.status === "sent") {
      jsonLog("info", { evt: "cancellation_already_sent", reservation_id });
      return new Response(JSON.stringify({ success: true, already_sent: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // deno-lint-ignore no-explicit-any
    const customer = reserva.customer as any;
    const customerPhone: string = customer?.phone ?? "";
    const customerName: string = customer?.name ?? "";
    if (!customerPhone) {
      jsonLog("warn", { evt: "cancellation_skipped", reason: "no_phone", reservation_id });
      await supabase
        .from("notifications_sent")
        .upsert(
          {
            reservation_id,
            unit_id: reserva.unit_id,
            kind: "cancellation",
            status: "skipped",
            error: "no_phone",
          },
          { onConflict: "reservation_id,kind" }
        );
      return new Response(JSON.stringify({ success: false, reason: "no_phone" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const message =
      `❌ *Reserva Cancelada*\n\n` +
      `Olá ${customerName}, sua reserva foi cancelada.\n\n` +
      `📅 Data: ${formatDate(reserva.date)}\n` +
      `⏰ Horário: ${reserva.time}\n` +
      `👥 Pessoas: ${reserva.party_size}\n` +
      `🔑 Código: #${reserva.reservation_code}\n\n` +
      `Se foi engano ou quiser remarcar, é só responder aqui que ajudamos. 🙏`;

    const result = await sendWhatsApp(customerPhone, message, { unit_id: reserva.unit_id });

    await supabase
      .from("notifications_sent")
      .upsert(
        {
          reservation_id,
          unit_id: reserva.unit_id,
          kind: "cancellation",
          status: result.ok ? "sent" : "failed",
          error: result.ok ? null : (result.error ?? `status_${result.status ?? "unknown"}`),
        },
        { onConflict: "reservation_id,kind" }
      );

    let conversationHistoryPersisted = true;
    if (result.ok) {
      jsonLog("info", { evt: "cancellation_sent", reservation_id, phone: sanitizePhone(customerPhone) });
      // deno-lint-ignore no-explicit-any
      const cust = customer as any;
      const conversationLog = await appendOutboundToConversation({
        supabase,
        unitId: reserva.unit_id,
        customerId: cust?.id ?? null,
        phone: customerPhone || null,
        content: message,
        kind: "cancellation",
        eventId: result.providerMessageId
          ? `wa-out:${result.provider ?? "unknown"}:${result.providerMessageId}`
          : undefined,
      });
      conversationHistoryPersisted = conversationLog.persisted;
    } else {
      jsonLog("error", {
        evt: "cancellation_failed",
        reservation_id,
        phone: sanitizePhone(customerPhone),
        error: result.error,
        status: result.status,
        missingCreds: result.missingCreds,
      });
    }

    return new Response(JSON.stringify({
      success: result.ok,
      external_success: result.ok,
      local_success: result.ok ? conversationHistoryPersisted : false,
      warning: result.ok && !conversationHistoryPersisted ? "CONVERSATION_RECONCILIATION_REQUIRED" : undefined,
      error: result.error,
    }), {
      status: result.ok ? (conversationHistoryPersisted ? 200 : 202) : 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    jsonLog("error", { evt: "send_cancellation_error", err: String(err) });
    return new Response(JSON.stringify({ error: "internal_error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
