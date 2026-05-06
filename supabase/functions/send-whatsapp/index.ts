import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { sendWhatsApp, type SendMessagePayload } from "../_shared/whatsapp-send.ts";
import { jsonLog, requireInternalAuth } from "../_shared/security.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-internal-key",
};

// Re-exporta o helper para compatibilidade com imports existentes que apontam
// para `../send-whatsapp/index.ts`. Novos imports devem usar `_shared/whatsapp-send.ts`.
export { sendWhatsApp };
export type { SendMessagePayload };

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
    const { phone, message, channel_id, unit_id }: SendMessagePayload = await req.json();
    if (!phone || !message) {
      return new Response(JSON.stringify({ error: "phone e message são obrigatórios" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const ok = await sendWhatsApp(phone, message, { channel_id, unit_id });
    return new Response(JSON.stringify({ success: ok }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    jsonLog("error", { evt: "send_whatsapp_error", err: String(err) });
    return new Response(JSON.stringify({ error: "internal_error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
