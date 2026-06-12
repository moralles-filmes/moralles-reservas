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
  type SendResult,
} from "./whatsapp-providers.ts";
import { jsonLog } from "./security.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

export interface SendMessagePayload {
  phone: string;
  message: string;
  channel_id?: string;
  unit_id?: string;
}

export type { SendResult };

export async function sendWhatsApp(
  phone: string,
  message: string,
  channelIdOrUnitId?: { channel_id?: string; unit_id?: string }
): Promise<SendResult> {
  // Quando ambos channel_id e unit_id são fornecidos, exige que pertençam à
  // mesma unit — defesa contra envio cross-tenant se INTERNAL_API_KEY vazar.
  if (channelIdOrUnitId?.channel_id) {
    let q = supabase
      .from("whatsapp_channels")
      .select("provider, credentials, unit_id")
      .eq("id", channelIdOrUnitId.channel_id);
    if (channelIdOrUnitId.unit_id) {
      q = q.eq("unit_id", channelIdOrUnitId.unit_id);
    }
    const { data: channel } = await q.maybeSingle();
    if (channel) {
      return sendOutbound(
        channel.provider as WhatsAppProvider,
        channel.credentials as ChannelCredentials,
        { toPhone: phone, text: message }
      );
    }
    // channel_id não encontrado/não pertence à unit informada — sem fallback.
    jsonLog("warn", {
      evt: "send_whatsapp_channel_mismatch",
      channel_id: channelIdOrUnitId.channel_id,
      unit_id: channelIdOrUnitId.unit_id ?? null,
    });
    return { ok: false, error: "channel_mismatch" };
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

  // Sem canal `connected` pra esta unit (ou nenhum identificador). SEM fallback
  // global: o antigo sendZApiLegacy (env ZAPI_*) mandava do número de OUTRA conta
  // — vazamento cross-tenant — e, quando as creds globais caducavam, devolvia um
  // 403 confuso. Retorna erro explícito pra UI/worker tratar (ex.: "configure o
  // canal em Plataforma → Automação").
  jsonLog("warn", {
    evt: "send_whatsapp_not_configured",
    unit_id: channelIdOrUnitId?.unit_id ?? null,
  });
  return { ok: false, error: "whatsapp_not_configured" };
}
