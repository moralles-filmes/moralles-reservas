import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  sendOutbound,
  type WhatsAppProvider,
  type ChannelCredentials,
} from "../_shared/whatsapp-providers.ts";
import { fetchWithRetry } from "../_shared/retry.ts";
import {
  jsonLog,
  requireInternalAuth,
  sanitizePhone,
} from "../_shared/security.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// Legacy Z-API credentials (fallback when no channel configured)
const LEGACY_ZAPI_INSTANCE_ID = Deno.env.get("ZAPI_INSTANCE_ID");
const LEGACY_ZAPI_TOKEN = Deno.env.get("ZAPI_TOKEN");
const LEGACY_ZAPI_CLIENT_TOKEN = Deno.env.get("ZAPI_CLIENT_TOKEN");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-internal-key",
};

export interface SendMessagePayload {
  phone: string;
  message: string;
  channel_id?: string;
  unit_id?: string;
}

// Legacy direct Z-API call (backwards compat)
async function sendZApiLegacy(phone: string, message: string): Promise<boolean> {
  if (!LEGACY_ZAPI_INSTANCE_ID || !LEGACY_ZAPI_TOKEN) return false;
  const digits = phone.replace(/\D/g, "");
  const formatted = digits.startsWith("55") ? digits : `55${digits}`;
  const url = `https://api.z-api.io/instances/${LEGACY_ZAPI_INSTANCE_ID}/token/${LEGACY_ZAPI_TOKEN}/send-text`;
  const res = await fetchWithRetry(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(LEGACY_ZAPI_CLIENT_TOKEN ? { "Client-Token": LEGACY_ZAPI_CLIENT_TOKEN } : {}) },
      body: JSON.stringify({ phone: formatted, message }),
    },
    { retries: 3, baseDelayMs: 500 }
  );
  if (!res.ok) {
    jsonLog("error", { evt: "zapi_send_failed", status: res.status, phone: sanitizePhone(phone) });
  }
  return res.ok;
}

export async function sendWhatsApp(
  phone: string,
  message: string,
  channelIdOrUnitId?: { channel_id?: string; unit_id?: string }
): Promise<boolean> {
  // Try to resolve a channel
  if (channelIdOrUnitId?.channel_id) {
    const { data: channel } = await supabase
      .from("whatsapp_channels")
      .select("provider, credentials")
      .eq("id", channelIdOrUnitId.channel_id)
      .maybeSingle();
    if (channel) {
      return sendOutbound(channel.provider as WhatsAppProvider, channel.credentials as ChannelCredentials, { toPhone: phone, text: message });
    }
  }

  if (channelIdOrUnitId?.unit_id) {
    const { data: channel } = await supabase
      .from("whatsapp_channels")
      .select("provider, credentials")
      .eq("unit_id", channelIdOrUnitId.unit_id)
      .eq("status", "connected")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (channel) {
      return sendOutbound(channel.provider as WhatsAppProvider, channel.credentials as ChannelCredentials, { toPhone: phone, text: message });
    }
  }

  // Fallback: legacy Z-API secrets
  return sendZApiLegacy(phone, message);
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
