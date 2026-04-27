import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendWhatsApp } from "../send-whatsapp/index.ts";
import { jsonLog, requireInternalAuth } from "../_shared/security.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-internal-key",
};

function formatDate(dateStr: string): string {
  const [year, month, day] = dateStr.split("-");
  return `${day}/${month}/${year}`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (!requireInternalAuth(req)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    // Triggered by Supabase Database Webhook on INSERT to reservations
    const body = await req.json();
    const record = body.record ?? body; // handle both webhook and direct call

    const { data: reserva, error } = await supabase
      .from("reservations")
      .select("*, customer:customers(*)")
      .eq("id", record.id)
      .single();

    if (error || !reserva) {
      jsonLog("error", { evt: "reservation_not_found", id: record.id, err: String(error) });
      return new Response(JSON.stringify({ error: "Reserva não encontrada" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { customer, date, time, party_size, reservation_code } = reserva;

    const message =
      `✅ *Reserva Confirmada!*\n\n` +
      `Olá ${customer.name}, sua reserva está confirmada.\n\n` +
      `📅 Data: ${formatDate(date)}\n` +
      `⏰ Horário: ${time}\n` +
      `👥 Pessoas: ${party_size}\n` +
      `🔑 Código: #${reservation_code}\n\n` +
      `Para alterar ou cancelar, é só responder aqui. Até logo! 😊`;

    const sent = await sendWhatsApp(customer.phone, message);

    if (sent) {
      // Mark as confirmed after sending
      await supabase
        .from("reservations")
        .update({ status: "confirmed" })
        .eq("id", record.id);
    }

    return new Response(JSON.stringify({ success: sent }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    jsonLog("error", { evt: "send_confirmation_error", err: String(err) });
    return new Response(JSON.stringify({ error: "internal_error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
