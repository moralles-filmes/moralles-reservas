// Helper compartilhado para envio de mensagem WhatsApp.
// Antes esse helper vivia em `send-whatsapp/index.ts`, mas como esse arquivo
// chama `serve(...)` no top-level, importá-lo de outra Edge Function (ex.
// send-confirmation) sobrescrevia o handler HTTP da função importadora.
// Mantemos aqui SEM `serve()` para que possa ser importado livremente.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  sendOutbound,
  type WhatsAppProvider,
  type ChannelCredentials,
} from "./whatsapp-providers.ts";
import { fetchWithRetry } from "./retry.ts";
import { jsonLog, sanitizePhone } from "./security.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const LEGACY_ZAPI_INSTANCE_ID = Deno.env.get("ZAPI_INSTANCE_ID");
const LEGACY_ZAPI_TOKEN = Deno.env.get("ZAPI_TOKEN");
const LEGACY_ZAPI_CLIENT_TOKEN = Deno.env.get("ZAPI_CLIENT_TOKEN");

export interface SendMessagePayload {
  phone: string;
  message: string;
  channel_id?: string;
  unit_id?: string;
}

async function sendZApiLegacy(phone: string, message: string): Promise<boolean> {
  if (!LEGACY_ZAPI_INSTANCE_ID || !LEGACY_ZAPI_TOKEN) return false;
  const digits = phone.replace(/\D/g, "");
  const formatted = digits.startsWith("55") ? digits : `55${digits}`;
  const url = `https://api.z-api.io/instances/${LEGACY_ZAPI_INSTANCE_ID}/token/${LEGACY_ZAPI_TOKEN}/send-text`;
  const res = await fetchWithRetry(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(LEGACY_ZAPI_CLIENT_TOKEN ? { "Client-Token": LEGACY_ZAPI_CLIENT_TOKEN } : {}),
      },
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
  if (channelIdOrUnitId?.channel_id) {
    const { data: channel } = await supabase
      .from("whatsapp_channels")
      .select("provider, credentials")
      .eq("id", channelIdOrUnitId.channel_id)
      .maybeSingle();
    if (channel) {
      return sendOutbound(
        channel.provider as WhatsAppProvider,
        channel.credentials as ChannelCredentials,
        { toPhone: phone, text: message }
      );
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
      return sendOutbound(
        channel.provider as WhatsAppProvider,
        channel.credentials as ChannelCredentials,
        { toPhone: phone, text: message }
      );
    }
  }

  return sendZApiLegacy(phone, message);
}
