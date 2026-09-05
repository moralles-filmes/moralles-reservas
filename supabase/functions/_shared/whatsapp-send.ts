// Helper compartilhado para envio de mensagem WhatsApp.
// Antes esse helper vivia em `send-whatsapp/index.ts`, mas como esse arquivo
// chama `serve(...)` no top-level, importá-lo de outra Edge Function (ex.
// send-confirmation) sobrescrevia o handler HTTP da função importadora.
// Mantemos aqui SEM `serve()` para que possa ser importado livremente.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  sendOutbound,
  tryGetWhatsAppProvider,
  type WhatsAppProvider,
  type ChannelCredentials,
  type SendResult,
} from "./whatsapp-providers.ts";
import { jsonLog } from "./security.ts";
import { resolveWhatsAppGateByUnit } from "./whatsapp-service-gate.ts";
import { resolveChannelCredentials } from "./whatsapp-channel-credentials.ts";
import { decideChannelUsability } from "./whatsapp-channel-freshness-core.ts";

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

/** Linha de canal no shape que o despacho precisa, resolvida por qualquer caminho. */
interface RoutableChannel {
  id: string;
  unit_id: string;
  provider: string;
  credentials: ChannelCredentials;
  instance_token_secret_id: string | null;
  status: string | null;
  last_health_check_at: string | null;
}

/**
 * Canais já confirmados como conectados NESTA invocação.
 *
 * Não é o que evita rajada de consultas ao provedor — quem evita é o frescor de
 * 5 min da projeção, mantido pelo worker `process-whatsapp-channel-health`.
 * Cada mensagem de um lote chega como uma invocação HTTP separada de
 * `send-whatsapp`, então este cache só rende dentro de uma invocação que envie
 * mais de uma mensagem. Fica porque é barato e porque a alternativa (cachear
 * entre invocações) faria um isolate quente afirmar "conectado" sobre um canal
 * que caiu, sem nenhum horizonte definido.
 *
 * Guarda SÓ confirmações positivas. Uma recusa não é cacheada de propósito: se
 * o operador reconectar o aparelho no meio da invocação, a próxima mensagem
 * deve poder passar.
 */
const connectedChannels = new Set<string>();

export function clearChannelConnectivityCache(): void {
  connectedChannels.clear();
}

/**
 * Persiste o snapshot observado. Best-effort: falha aqui NÃO altera a decisão
 * de envio já tomada — perder o carimbo custa uma consulta extra na próxima
 * mensagem, enquanto recusar por causa dele calaria um canal saudável.
 */
async function persistChannelStatus(
  channel: RoutableChannel,
  status: string,
  errorCode: string | null,
): Promise<void> {
  const { error } = await supabase.rpc("record_whatsapp_channel_status", {
    p_unit_id: channel.unit_id,
    p_channel_id: channel.id,
    p_status: status,
    p_display_phone: null,
    p_error_code: errorCode,
    p_actor_id: null,
    p_request_id: null,
    p_event_type: null,
  });
  if (error) {
    jsonLog("warn", {
      evt: "send_whatsapp_status_persist_failed",
      channel_id: channel.id,
      err: error.message,
    });
  }
}

/**
 * Confirma que o canal está conectado ANTES de postar.
 *
 * FAIL-CLOSED, e a polaridade é oposta à do gate de billing
 * (`whatsapp-service-gate.ts`) de propósito. Lá, não conseguir ler o banco não
 * pode calar o WhatsApp de um cliente adimplente. Aqui, não conseguir
 * confirmar a conexão não autoriza empurrar mensagem para dentro da fila do
 * provedor: a Z-API aceita com 2xx enquanto a instância está fora do ar e
 * despeja tudo na reconexão — foi assim que 88 mensagens saíram em 2,5 minutos
 * em 2026-09-03, com risco de bloqueio do número do lojista pela Meta. Entre
 * atrasar um aviso e queimar o WhatsApp do restaurante, o lado seguro é não
 * postar.
 */
async function ensureChannelConnected(
  channel: RoutableChannel,
  credentials: ChannelCredentials,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (connectedChannels.has(channel.id)) return { ok: true };

  const usability = decideChannelUsability({
    status: channel.status,
    lastHealthCheckAt: channel.last_health_check_at,
    now: Date.now(),
  });

  if (usability === "use") {
    connectedChannels.add(channel.id);
    return { ok: true };
  }

  if (usability === "refuse") {
    jsonLog("warn", {
      evt: "send_whatsapp_channel_not_connected",
      channel_id: channel.id,
      provider: channel.provider,
      status: channel.status,
      source: "projection",
    });
    return { ok: false, error: "whatsapp_not_connected" };
  }

  // recheck — projeção velha demais para responder sozinha.
  //
  // `tryGet`, NÃO `getWhatsAppProvider`: este último é fail-closed por LANÇAR,
  // contrato certo para lifecycle/UI e errado aqui. `sendOutbound` devolve
  // `unknown_provider:<nome>` como `SendResult` para uma linha com provider
  // desconhecido, e trocar isso por uma exceção faria a EF responder 500
  // genérico no lugar de um erro nomeado — regressão de diagnóstico numa
  // função cujo contrato inteiro é devolver `SendResult`.
  const adapter = tryGetWhatsAppProvider(channel.provider);
  if (!adapter?.getConnectionStatus) {
    // Provider desconhecido ou adapter sem observação de conexão: não há como
    // confirmar. Segue e deixa `sendOutbound` dar o veredito — recusar aqui
    // calaria um provider inteiro por uma capability que ele nunca prometeu, e
    // hoje nenhum adapter registrado cai neste caminho.
    jsonLog("info", {
      evt: "send_whatsapp_status_unsupported",
      channel_id: channel.id,
      provider: channel.provider,
      known_provider: adapter !== null,
    });
    connectedChannels.add(channel.id);
    return { ok: true };
  }

  try {
    const snapshot = await adapter.getConnectionStatus(credentials);
    await persistChannelStatus(
      channel,
      snapshot.status,
      snapshot.status === "provider_error" || snapshot.status === "error"
        ? "SEND_STATUS_CHECK"
        : null,
    );
    if (snapshot.status === "connected") {
      connectedChannels.add(channel.id);
      return { ok: true };
    }
    jsonLog("warn", {
      evt: "send_whatsapp_channel_not_connected",
      channel_id: channel.id,
      provider: channel.provider,
      status: snapshot.status,
      source: "provider",
    });
    return { ok: false, error: "whatsapp_not_connected" };
  } catch (error) {
    jsonLog("error", {
      evt: "send_whatsapp_status_check_failed",
      channel_id: channel.id,
      provider: channel.provider,
      err: String(error).slice(0, 200),
    });
    return { ok: false, error: "whatsapp_not_connected" };
  }
}

/**
 * Caminho único de despacho: resolve credencial, confirma conexão, posta.
 *
 * Os três pontos de resolução de canal (por `channel_id`, pela projeção ativa e
 * pelo fallback legado) convergem aqui — antes cada um repetia o bloco de
 * credenciais, e foi essa duplicação que deixou a checagem de conexão presente
 * em dois deles e ausente no terceiro.
 */
async function dispatchToChannel(
  channel: RoutableChannel,
  phone: string,
  message: string,
): Promise<SendResult> {
  let credentials: ChannelCredentials;
  try {
    credentials = await resolveChannelCredentials(supabase, {
      id: channel.id,
      provider: channel.provider as WhatsAppProvider,
      credentials: channel.credentials,
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

  const connectivity = await ensureChannelConnected(channel, credentials);
  if (connectivity.ok === false) {
    return withChannelRoute({ ok: false, error: connectivity.error }, channel);
  }

  return withChannelRoute(
    await sendOutbound(channel.provider as WhatsAppProvider, credentials, {
      toPhone: phone,
      text: message,
    }),
    channel,
  );
}

/** Colunas mínimas para `RoutableChannel` — uma lista só, três consultas. */
const CHANNEL_COLUMNS =
  "id, unit_id, provider, credentials, instance_token_secret_id, status, last_health_check_at";

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
      .select(`${CHANNEL_COLUMNS}, is_active`)
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
      if (explicitlyInactive || channel.is_active === false) {
        return { ok: false, error: "whatsapp_channel_inactive" };
      }
      // A checagem de conexão saiu daqui e virou parte do despacho. Antes ela
      // era `provider === "uazapi"`, isentando a Z-API por este caminho — a
      // porta por onde o envio para canal caído passava sem ser perguntado.
      return await dispatchToChannel(channel as unknown as RoutableChannel, phone, message);
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
    // Sem `.eq("status","connected")` no filtro: a projeção deixou de ser
    // critério de SELEÇÃO e passou a ser critério de USO, decidido no despacho
    // junto com o frescor. Filtrar aqui esconderia o canal ativo caído atrás de
    // um `whatsapp_not_configured` — diagnóstico errado para quem investiga.
    const { data: activeChannel, error: activeChannelError } = await supabase
      .from("whatsapp_channels")
      .select(CHANNEL_COLUMNS)
      .eq("unit_id", channelIdOrUnitId.unit_id)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();

    if (activeChannelError) {
      jsonLog("error", { evt: "send_whatsapp_active_channel_read_failed" });
      return { ok: false, error: "whatsapp_channel_unavailable" };
    }

    if (activeChannel) {
      return await dispatchToChannel(activeChannel as unknown as RoutableChannel, phone, message);
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
      // `status='connected'` PERMANECE no filtro deste caminho, ao contrário do
      // anterior: aqui ele não decide uso, decide QUAL linha legada é a
      // candidata entre várias. Tirá-lo elegeria uma linha morta como fallback.
      const { data: legacyChannel, error: legacyChannelError } = await supabase
        .from("whatsapp_channels")
        .select(CHANNEL_COLUMNS)
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
        return await dispatchToChannel(legacyChannel as unknown as RoutableChannel, phone, message);
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
