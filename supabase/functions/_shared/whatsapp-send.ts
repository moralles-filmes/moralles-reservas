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
import { resolveWhatsAppGateByUnit } from "./whatsapp-service-gate.ts";
import { resolveChannelCredentials } from "./whatsapp-channel-credentials.ts";

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

function withChannelRoute(
  result: SendResult,
  channel: { id: string; provider: string },
): SendResult {
  return {
    ...result,
    provider: channel.provider as WhatsAppProvider,
    channelId: channel.id,
  };
}

export async function sendWhatsApp(
  phone: string,
  message: string,
  channelIdOrUnitId?: { channel_id?: string; unit_id?: string }
): Promise<SendResult> {
  // Gate de serviço. Precisa de unit_id; quando só veio channel_id, resolve a
  // unit pelo canal primeiro (a consulta do canal já acontece logo abaixo, mas
  // o gate tem que vir ANTES de tocar no provedor — depois já custou dinheiro).
  let gateUnitId = channelIdOrUnitId?.unit_id ?? null;
  if (!gateUnitId && channelIdOrUnitId?.channel_id) {
    const { data: ch } = await supabase
      .from("whatsapp_channels")
      .select("unit_id")
      .eq("id", channelIdOrUnitId.channel_id)
      .maybeSingle();
    gateUnitId = (ch?.unit_id as string | undefined) ?? null;
  }

  if (gateUnitId) {
    const gate = await resolveWhatsAppGateByUnit(supabase, gateUnitId);
    if (gate?.enforced.sending) {
      jsonLog("warn", {
        evt: "send_whatsapp_service_suspended",
        unit_id: gateUnitId,
        org: gate.organizationId,
        state: gate.state,
        reason: gate.reason,
      });
      return { ok: false, error: "whatsapp_service_suspended" };
    }
  }

  // Quando ambos channel_id e unit_id são fornecidos, exige que pertençam à
  // mesma unit — defesa contra envio cross-tenant se INTERNAL_API_KEY vazar.
  if (channelIdOrUnitId?.channel_id) {
    let q = supabase
      .from("whatsapp_channels")
      .select("id, provider, credentials, unit_id, status, is_active, instance_token_secret_id")
      .eq("id", channelIdOrUnitId.channel_id);
    if (channelIdOrUnitId.unit_id) {
      q = q.eq("unit_id", channelIdOrUnitId.unit_id);
    }
    const { data: channel, error: channelError } = await q.maybeSingle();
    if (channelError) {
      jsonLog("error", { evt: "send_whatsapp_channel_read_failed" });
      return { ok: false, error: "whatsapp_channel_unavailable" };
    }
    if (channel) {
      const { count: explicitActiveCount, error: activeCountError } = await supabase
        .from("whatsapp_channels")
        .select("id", { count: "exact", head: true })
        .eq("unit_id", channel.unit_id)
        .eq("is_active", true);
      if (activeCountError) {
        jsonLog("error", { evt: "send_whatsapp_active_projection_read_failed" });
        return { ok: false, error: "whatsapp_channel_unavailable" };
      }
      const explicitlyInactive = (explicitActiveCount ?? 0) > 0 && channel.is_active !== true;
      const requiresConnectedProjection = channel.provider === "uazapi";
      if ((requiresConnectedProjection && channel.status !== "connected") || explicitlyInactive || channel.is_active === false) {
        return { ok: false, error: explicitlyInactive || channel.is_active === false
          ? "whatsapp_channel_inactive"
          : "whatsapp_not_connected" };
      }
      let credentials: ChannelCredentials;
      try {
        credentials = await resolveChannelCredentials(supabase, {
          id: channel.id,
          provider: channel.provider as WhatsAppProvider,
          credentials: channel.credentials as ChannelCredentials,
          instance_token_secret_id: channel.instance_token_secret_id,
        });
      } catch (error) {
        jsonLog("error", {
          evt: "send_whatsapp_credentials_unavailable",
          channel_id: channel.id,
          provider: channel.provider,
          err: String(error),
        });
        return { ok: false, error: "whatsapp_credentials_unavailable" };
      }
      return withChannelRoute(await sendOutbound(
        channel.provider as WhatsAppProvider,
        credentials,
        { toPhone: phone, text: message }
      ), channel);
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
    // Modelo explícito: somente a projeção ativa pode enviar. Se ela estiver
    // desconectada não caímos silenciosamente em um canal legado/antigo.
    const { data: activeChannel, error: activeChannelError } = await supabase
      .from("whatsapp_channels")
      .select("id, provider, credentials, instance_token_secret_id")
      .eq("unit_id", channelIdOrUnitId.unit_id)
      .eq("is_active", true)
      .eq("status", "connected")
      .limit(1)
      .maybeSingle();

    if (activeChannelError) {
      jsonLog("error", { evt: "send_whatsapp_active_channel_read_failed" });
      return { ok: false, error: "whatsapp_channel_unavailable" };
    }

    if (activeChannel) {
      let credentials: ChannelCredentials;
      try {
        credentials = await resolveChannelCredentials(supabase, {
          id: activeChannel.id,
          provider: activeChannel.provider as WhatsAppProvider,
          credentials: activeChannel.credentials as ChannelCredentials,
          instance_token_secret_id: activeChannel.instance_token_secret_id,
        });
      } catch (error) {
        jsonLog("error", {
          evt: "send_whatsapp_credentials_unavailable",
          channel_id: activeChannel.id,
          provider: activeChannel.provider,
          err: String(error),
        });
        return { ok: false, error: "whatsapp_credentials_unavailable" };
      }
      return withChannelRoute(await sendOutbound(
        activeChannel.provider as WhatsAppProvider,
        credentials,
        { toPhone: phone, text: message }
      ), activeChannel);
    }

    const { count: anyExplicitActive, error: explicitCountError } = await supabase
      .from("whatsapp_channels")
      .select("id", { count: "exact", head: true })
      .eq("unit_id", channelIdOrUnitId.unit_id)
      .eq("is_active", true);

    if (explicitCountError) {
      jsonLog("error", { evt: "send_whatsapp_active_projection_read_failed" });
      return { ok: false, error: "whatsapp_channel_unavailable" };
    }

    if ((anyExplicitActive ?? 0) === 0) {
      // Compatibilidade de rollout: somente linhas NULL participam do fallback
      // legado. `false` é sempre inativo, mesmo sem outra linha ativa.
      const { data: legacyChannel, error: legacyChannelError } = await supabase
        .from("whatsapp_channels")
        .select("id, provider, credentials, instance_token_secret_id")
        .eq("unit_id", channelIdOrUnitId.unit_id)
        .is("is_active", null)
        .eq("status", "connected")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();

      if (legacyChannelError) {
        jsonLog("error", { evt: "send_whatsapp_legacy_channel_read_failed" });
        return { ok: false, error: "whatsapp_channel_unavailable" };
      }

      if (legacyChannel) {
        const credentials = await resolveChannelCredentials(supabase, {
          id: legacyChannel.id,
          provider: legacyChannel.provider as WhatsAppProvider,
          credentials: legacyChannel.credentials as ChannelCredentials,
          instance_token_secret_id: legacyChannel.instance_token_secret_id,
        });
        return withChannelRoute(await sendOutbound(
          legacyChannel.provider as WhatsAppProvider,
          credentials,
          { toPhone: phone, text: message },
        ), legacyChannel);
      }
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
