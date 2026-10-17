// Observação periódica da conexão dos canais de WhatsApp.
//
// POR QUE ESTE WORKER EXISTE
//
// `whatsapp_channels.status` só era escrito por dois caminhos, e os dois
// dependem de alguém: o callback do provider (`webhook-whatsapp`) e a abertura
// do portal (`manage-channels`). A revalidação de 30s da
// 2026-09-01-zapi-connection-status-design.md é gateada por aba visível.
//
// Medido: a instância Z-API do Ren Sushi caiu em 2026-08-28 01:45 e a projeção
// seguiu dizendo `connected` até 2026-09-02 15:40 — 4,5 dias em que o envio leu
// a projeção congelada, postou, e a Z-API aceitou com 2xx enfileirando tudo (88
// mensagens despejadas em 2,5 minutos quando o canal voltou, em 03/09 17:12).
//
// O que finalmente atualizou a projeção foi alguém abrir o painel, por acaso,
// no quinto dia. É esse "por acaso" que este worker substitui: com ele, a queda
// teria sido vista às 01:50 de 28/08 e nenhuma das 88 teria sido postada.
//
// Este worker é o terceiro escritor, o único que não depende de ninguém. Ele
// também é o que mantém `last_health_check_at` fresco o bastante para que a
// guarda de `whatsapp-send.ts` quase nunca precise consultar o provedor no
// caminho de envio.
//
// NÃO decide envio e NÃO bloqueia nada — só observa e persiste. Quem recusa
// envio é `whatsapp-send.ts`, lendo o que este worker escreveu.
//
// Auth: x-internal-key. Agendado por pg_cron a cada 5 minutos.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jsonLog, requireInternalAuth } from "../_shared/security.ts";
import {
  tryGetWhatsAppProvider,
  type WhatsAppProvider,
  type ChannelCredentials,
} from "../_shared/whatsapp-providers.ts";
import { resolveChannelCredentials } from "../_shared/whatsapp-channel-credentials.ts";
import { createOpsAlerts } from "../_shared/ops-alert-runtime.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

/**
 * Teto por execução. Com a cadência de 5 minutos, um lote maior que isto
 * significaria uma execução mais longa que o próprio intervalo — e duas
 * varreduras sobrepostas consultando o mesmo provedor. Hoje há um canal ativo;
 * o teto é para quando não houver.
 */
const MAX_CHANNELS = 50;

interface ChannelRow {
  id: string;
  unit_id: string;
  provider: string;
  credentials: ChannelCredentials;
  instance_token_secret_id: string | null;
  status: string | null;
  is_active: boolean | null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  if (!requireInternalAuth(req)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const t0 = Date.now();
  let checked = 0;
  let connected = 0;
  let disconnected = 0;
  let unsupported = 0;
  let failed = 0;
  let persistFailed = 0;
  let transitions = 0;

  try {
    // Mesma regra de binding de `whatsapp-send.ts` quanto a QUEM participa: a
    // projeção ativa explícita manda, linhas legadas `NULL` só entram quando a
    // unidade não tem nenhuma ativa, e `is_active = false` NUNCA é observado —
    // canal desativado não envia, então consultar o provedor por ele é custo
    // externo sem consequência.
    //
    // Uma diferença deliberada: `whatsapp-send.ts` filtra `status='connected'`
    // no ramo legado, este worker não. Lá o filtro ELEGE entre linhas legadas
    // candidatas (tirá-lo promoveria uma linha morta a fallback); aqui ele
    // impediria justamente o que o worker existe para fazer — observar um canal
    // que a projeção dá como caído e descobrir que voltou.
    // `order` pelo carimbo mais velho primeiro NÃO é cosmético: com mais
    // canais que `MAX_CHANNELS`, um `limit` sem ordenação devolve o mesmo
    // subconjunto a cada execução (PostgREST não promete ordem, e na prática
    // ela é estável), e os canais fora dele nunca teriam
    // `last_health_check_at` renovado — o worker existiria sem cobrir
    // exatamente quem entrou depois. Com a ordenação, o teto vira um rodízio.
    const { data: activeRows, error: activeErr } = await supabase
      .from("whatsapp_channels")
      .select("id, unit_id, provider, credentials, instance_token_secret_id, status, is_active")
      .eq("is_active", true)
      .order("last_health_check_at", { ascending: true, nullsFirst: true })
      .limit(MAX_CHANNELS);

    if (activeErr) {
      jsonLog("error", { evt: "channel_health_load_failed", err: activeErr.message });
      return new Response(JSON.stringify({ error: "load_failed" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const channels = [...((activeRows ?? []) as ChannelRow[])];

    // Unidades já cobertas por uma linha ativa não precisam do fallback legado.
    const unitsWithActive = new Set(channels.map((c) => c.unit_id));
    const { data: legacyRows, error: legacyErr } = await supabase
      .from("whatsapp_channels")
      .select("id, unit_id, provider, credentials, instance_token_secret_id, status, is_active")
      .is("is_active", null)
      .order("last_health_check_at", { ascending: true, nullsFirst: true })
      .limit(MAX_CHANNELS);

    if (legacyErr) {
      // Não aborta: os canais ativos são o caso que importa, e falhar tudo por
      // causa do fallback legado deixaria a projeção principal congelada — o
      // defeito exato que este worker existe para impedir.
      jsonLog("warn", { evt: "channel_health_legacy_load_failed", err: legacyErr.message });
    } else {
      for (const row of (legacyRows ?? []) as ChannelRow[]) {
        if (!unitsWithActive.has(row.unit_id)) channels.push(row);
      }
    }

    for (const channel of channels.slice(0, MAX_CHANNELS)) {
      checked++;

      // `tryGet` em vez de `getWhatsAppProvider`: uma linha com provider
      // desconhecido é dado ruim, não motivo para interromper a varredura dos
      // outros canais — que é justamente o que uma exceção aqui faria.
      const adapter = tryGetWhatsAppProvider(channel.provider);
      if (!adapter) {
        unsupported++;
        jsonLog("warn", {
          evt: "channel_health_provider_unknown",
          channel_id: channel.id,
          provider: channel.provider,
        });
        continue;
      }

      if (!adapter.getConnectionStatus) {
        unsupported++;
        continue;
      }

      let status: string;
      let errorCode: string | null = null;
      try {
        const credentials = await resolveChannelCredentials(supabase, {
          id: channel.id,
          provider: channel.provider as WhatsAppProvider,
          credentials: channel.credentials,
          instance_token_secret_id: channel.instance_token_secret_id,
        });
        const snapshot = await adapter.getConnectionStatus(credentials);
        status = snapshot.status;
      } catch (error) {
        // Falha de transporte ou credencial é `provider_error`, NÃO
        // `disconnected`: as duas coisas são diferentes para quem lê o painel, e
        // gravar `disconnected` por um timeout de rede diria ao lojista que o
        // WhatsApp dele caiu quando quem caiu foi a consulta.
        status = "provider_error";
        errorCode = "HEALTH_CHECK_FAILED";
        failed++;
        jsonLog("warn", {
          evt: "channel_health_check_failed",
          channel_id: channel.id,
          provider: channel.provider,
          err: String(error).slice(0, 200),
        });
      }

      if (status === "connected") connected++;
      else if (status !== "provider_error") disconnected++;

      if (channel.status !== status) {
        transitions++;
        jsonLog("info", {
          evt: "channel_health_transition",
          channel_id: channel.id,
          unit_id: channel.unit_id,
          provider: channel.provider,
          from: channel.status,
          to: status,
        });
      }

      // A RPC carimba `last_health_check_at` mesmo sem transição — é esse
      // carimbo, não a mudança de status, que mantém a projeção fresca para a
      // guarda de envio. Falha aqui não interrompe os demais canais.
      const { error: persistErr } = await supabase.rpc("record_whatsapp_channel_status", {
        p_unit_id: channel.unit_id,
        p_channel_id: channel.id,
        p_status: status,
        p_display_phone: null,
        p_error_code: errorCode,
        p_actor_id: null,
        p_request_id: null,
        p_event_type: null,
      });
      if (persistErr) {
        persistFailed++;
        jsonLog("error", {
          evt: "channel_health_persist_failed",
          channel_id: channel.id,
          err: persistErr.message,
        });
      }
    }

    const opsAlerts = await createOpsAlerts(supabase, {
      endpoint: Deno.env.get("WHATSAPP_OPS_ALERT_URL"),
      projectUrl: Deno.env.get("SUPABASE_URL"),
      token: Deno.env.get("WHATSAPP_OPS_ALERT_TOKEN"),
    },
      (event) => jsonLog("warn", event)).inbound();

    jsonLog("info", {
      evt: "channel_health_done",
      opsAlerts,
      checked,
      connected,
      disconnected,
      unsupported,
      failed,
      persistFailed,
      transitions,
      duration_ms: Date.now() - t0,
    });

    return new Response(
      JSON.stringify({
        opsAlerts,
        checked,
        connected,
        disconnected,
        unsupported,
        failed,
        persistFailed,
        transitions,
        duration_ms: Date.now() - t0,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    jsonLog("error", { evt: "channel_health_error", err: String(err).slice(0, 300), checked });
    return new Response(JSON.stringify({ error: "internal_error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
