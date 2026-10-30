import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendWhatsApp } from "../_shared/whatsapp-send.ts";
import { clearWhatsAppGateCache } from "../_shared/whatsapp-service-gate.ts";
import { clearChannelConnectivityCache } from "../_shared/whatsapp-send.ts";
import { jsonLog, sanitizePhone } from "../_shared/security.ts";
import { hasUnitAccess } from "../_shared/authz.ts";
import { resolveUnitChannelBinding } from "../_shared/whatsapp-org-provider-core.ts";
import { isMetaShapedProvider } from "../_shared/whatsapp-provider-core.ts";
import { evaluateManualServiceWindow } from "../_shared/whatsapp-manual-service-window-core.ts";
import { createInstagramGraph, type GraphResult } from "../_shared/instagram-graph.ts";
import { isGraphOutcomeUnknown, redactSecrets } from "../_shared/instagram-graph-core.ts";
import { splitInstagramText } from "../_shared/instagram-format.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const graph = createInstagramGraph((input, init) => fetch(input, init));

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Mesma decisão do `beforeOutbound` do WhatsApp: janela aberta no relógio de AGORA. */
function serviceWindowOpenNow(window: { lastInboundAt: string | null; closesAt: string | null }): boolean {
  const currentTime = Date.now();
  const start = Date.parse(window.lastInboundAt ?? "");
  const deadline = Date.parse(window.closesAt ?? "");
  return Number.isFinite(start) && Number.isFinite(deadline) && currentTime >= start && currentTime < deadline;
}

interface ManualConversation {
  id: string;
  unit_id: string;
  status: string;
  channel: string;
  instagram_contact_id: string | null;
  instagram_contact: { igsid?: unknown; instagram_account_id?: unknown } | null;
}

type Stop =
  | { kind: "window" }
  | { kind: "unknown" }
  | { kind: "failed"; errorClass: string; status: number | null; code: number | null };

/**
 * Envio manual pelo Direct (Task 4.2). Chamado só DEPOIS do `hasUnitAccess`.
 * NUNCA chama o provider WhatsApp, mesmo com cliente ligado que tenha telefone.
 * Sem retry: a parte com desfecho desconhecido pode ter saído e não se reenvia.
 * O histórico recebe só as partes confirmadas, com `provider_message_ids`, para
 * que o eco delas conte como `echo_own` no worker (D5).
 */
async function sendInstagramManual(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  conv: ManualConversation,
  userId: string,
  message: string,
  secrets: string[],
): Promise<Response> {
  if (conv.status !== "human_active" && conv.status !== "awaiting_human") {
    return json(409, { error: "conversa não está em atendimento humano" });
  }
  const contact = conv.instagram_contact;
  const igsid = typeof contact?.igsid === "string" ? contact.igsid : "";
  const accountId = typeof contact?.instagram_account_id === "string" ? contact.instagram_account_id : "";
  if (!conv.instagram_contact_id || !igsid || !accountId) {
    return json(422, { error: "contato do Instagram não encontrado" });
  }

  // Conta da MESMA unidade da conversa (o tenant vem da conversa autorizada,
  // nunca do caller), e só `connected` envia.
  const { data: account, error: accountErr } = await supabase
    .from("instagram_accounts")
    .select("id, unit_id, ig_user_id, status")
    .eq("id", accountId)
    .eq("unit_id", conv.unit_id)
    .maybeSingle();
  if (accountErr) {
    jsonLog("error", { evt: "manual_instagram_account_read_failed", convId: conv.id, code: accountErr.code ?? null });
    return json(503, { error: "Não foi possível validar a conta do Instagram." });
  }
  if (
    !account || account.id !== accountId || account.unit_id !== conv.unit_id || account.status !== "connected" ||
    typeof account.ig_user_id !== "string" || account.ig_user_id === ""
  ) {
    return json(409, { error: "INSTAGRAM_NOT_CONNECTED" });
  }

  const { data: history, error: historyErr } = await supabase
    .from("conversations")
    .select("messages")
    .eq("id", conv.id)
    .eq("unit_id", conv.unit_id)
    .maybeSingle();
  if (historyErr || !history) {
    return json(503, { error: "Não foi possível validar a janela de atendimento." });
  }
  const serviceWindow = evaluateManualServiceWindow(history.messages, Date.now());
  if (!serviceWindow.open) return json(409, { error: "OUTSIDE_SERVICE_WINDOW" });

  const parts = splitInstagramText(message);
  if (parts.length === 0) return json(400, { error: "conversation_id e message são obrigatórios" });

  const { data: token, error: tokenErr } = await supabase.rpc("get_instagram_account_token", { p_account_id: account.id });
  if (tokenErr || typeof token !== "string" || token === "") {
    jsonLog("error", { evt: "manual_instagram_token_unavailable", convId: conv.id, accountId: account.id, code: tokenErr?.code ?? null });
    return json(503, { error: "Não foi possível acessar a conta do Instagram." });
  }
  secrets.push(token);

  const sentIds: string[] = [];
  const sentParts: string[] = [];
  let stop: Stop | null = null;
  for (const part of parts) {
    // Reavaliada imediatamente antes de CADA POST: a janela pode fechar
    // durante a leitura do token ou enquanto a parte anterior estava no ar.
    if (!serviceWindowOpenNow(serviceWindow)) {
      stop = { kind: "window" };
      break;
    }
    let r: GraphResult<{ messageId: string }>;
    try {
      r = await graph.sendText({ igUserId: account.ig_user_id, token, igsid, text: part });
    } catch {
      // O adapter não lança; se lançar, a parte pode ter saído.
      r = { ok: false, errorClass: "transient", httpStatus: null, code: null };
    }
    if (r.ok === true) {
      sentIds.push(r.value.messageId);
      sentParts.push(part);
      continue;
    }
    stop = isGraphOutcomeUnknown(r, "POST")
      ? { kind: "unknown" }
      : { kind: "failed", errorClass: r.errorClass, status: r.httpStatus, code: r.code };
    break;
  }

  if (stop?.kind === "failed" && stop.errorClass === "reauth_required") {
    const { error: markErr } = await supabase.rpc("set_instagram_account_status", {
      p_account_id: account.id,
      p_status: "reauth_required",
      p_error_code: "190",
    });
    jsonLog(markErr ? "error" : "warn", {
      evt: "instagram_account_reauth_required", accountId: account.id, code: markErr?.code ?? null,
    });
  }
  if (stop) {
    jsonLog("warn", {
      evt: "manual_instagram_send_stopped",
      convId: conv.id,
      accountId: account.id,
      stop: stop.kind,
      errorClass: stop.kind === "failed" ? stop.errorClass : null,
      status: stop.kind === "failed" ? stop.status : null,
      graphCode: stop.kind === "failed" ? stop.code : null,
      sent: sentIds.length,
      total: parts.length,
    });
  }

  // Grava só o que saiu (com os ids), mesmo em falha parcial.
  let recorded = true;
  if (sentIds.length > 0) {
    const humanMsg = {
      event_id: crypto.randomUUID(),
      role: "human",
      author: "human",
      content: sentIds.length === parts.length ? message : sentParts.join("\n\n"),
      timestamp: new Date().toISOString(),
      human_user_id: userId,
      provider_message_ids: [...sentIds],
    };
    let appendErr: { message?: string; code?: string } | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await supabase.rpc("record_whatsapp_human_message", {
        p_conversation_id: conv.id,
        p_unit_id: conv.unit_id,
        p_message: humanMsg,
        p_handoff_reason: "atendente respondeu pelo painel",
      });
      appendErr = result.error;
      if (!appendErr) break;
    }
    if (appendErr) {
      recorded = false;
      jsonLog("error", {
        evt: "manual_append_failed",
        convId: conv.id,
        channel: "instagram",
        err: redactSecrets(String(appendErr.message ?? ""), secrets),
      });
    }
  }

  if (!stop) {
    if (!recorded) {
      return json(202, {
        success: true,
        external_success: true,
        local_success: false,
        warning: "CONVERSATION_RECONCILIATION_REQUIRED",
      });
    }
    jsonLog("info", { evt: "human_replied", convId: conv.id, userId, channel: "instagram" });
    return json(200, { success: true });
  }

  const reason = stop.kind === "window"
    ? "OUTSIDE_SERVICE_WINDOW"
    : stop.kind === "unknown"
    ? "SEND_OUTCOME_UNKNOWN"
    : stop.errorClass === "reauth_required"
    ? "INSTAGRAM_REAUTH_REQUIRED"
    : stop.errorClass === "window_closed"
    ? "OUTSIDE_SERVICE_WINDOW"
    : stop.errorClass;

  if (sentIds.length === 0 && stop.kind !== "unknown") {
    if (reason === "OUTSIDE_SERVICE_WINDOW" || reason === "INSTAGRAM_REAUTH_REQUIRED") {
      return json(409, { error: reason });
    }
    return json(502, { error: "falha ao enviar mensagem Instagram", reason });
  }

  // Falha parcial ou desfecho desconhecido: `sent` conta só as partes
  // confirmadas; `outcome_unknown` avisa que a parte seguinte pode ter saído.
  return json(502, {
    error: "PARTIAL_SEND",
    code: "PARTIAL_SEND",
    sent: sentIds.length,
    total: parts.length,
    reason,
    outcome_unknown: stop.kind === "unknown",
    local_success: recorded,
  });
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

  // Identify the calling user via their JWT
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

  // Service role client for privileged operations
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  // Credenciais vistas nesta invocação: todo texto de erro logado passa por `redactSecrets`.
  const secrets: string[] = [];

  try {
    const { conversation_id, message } = await req.json();
    const trimmedMessage = typeof message === "string" ? message.trim() : "";
    if (!conversation_id || !trimmedMessage) {
      return new Response(JSON.stringify({ error: "conversation_id e message são obrigatórios" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (trimmedMessage.length > 4096) {
      return new Response(JSON.stringify({ error: "mensagem excede 4096 caracteres" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Load conversation + customer phone + unit
    const { data: conv, error: convErr } = await supabase
      .from("conversations")
      .select("id, unit_id, status, channel, instagram_contact_id, customer:customers(phone), instagram_contact:instagram_contacts(igsid, instagram_account_id)")
      .eq("id", conversation_id)
      .maybeSingle();

    if (convErr || !conv) {
      return new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Verify caller is a member of this unit OR a platform admin.
    // useCurrentUnit.ts fabrica pseudo-membership "owner" pra platform_admin operar
    // unidades alheias na UI; sem o paralelo aqui, super-admin é bloqueado pelo backend.
    if (!(await hasUnitAccess(supabase, user.id, conv.unit_id))) {
      return new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Canal da conversa decide o envio. Instagram nunca cai no provider
    // WhatsApp, mesmo com cliente ligado que tenha telefone.
    if (conv.channel === "instagram") {
      return await sendInstagramManual(supabase, conv as ManualConversation, user.id, trimmedMessage, secrets);
    }
    if (conv.channel !== "whatsapp") {
      return json(422, { error: "canal da conversa não suportado" });
    }

    // Canal WhatsApp. Service role bypasses RLS. Resolve the operational binding after the
    // conversation authorization, and pin it for the eventual send so a
    // concurrent provider switch cannot bypass the window decision.
    const { data: channels, error: channelErr } = await supabase
      .from("whatsapp_channels")
      .select("id, provider, status, is_active, created_at")
      .eq("unit_id", conv.unit_id)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true });
    if (channelErr) {
      return new Response(JSON.stringify({ error: "Não foi possível validar o canal WhatsApp." }), {
        status: 503,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const binding = resolveUnitChannelBinding(channels);
    if (!binding) {
      return new Response(JSON.stringify({ error: "Canal WhatsApp não configurado." }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Only allow sending when conversation is in human hands
    if (conv.status !== "human_active" && conv.status !== "awaiting_human") {
      return new Response(JSON.stringify({ error: "conversa não está em atendimento humano" }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let serviceWindow: ReturnType<typeof evaluateManualServiceWindow> | null = null;
    if (isMetaShapedProvider(binding.provider)) {
      const { data: history, error: historyErr } = await supabase
        .from("conversations")
        .select("messages")
        .eq("id", conv.id)
        .eq("unit_id", conv.unit_id)
        .maybeSingle();
      if (historyErr || !history) {
        return new Response(JSON.stringify({ error: "Não foi possível validar a janela de atendimento." }), {
          status: 503,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      serviceWindow = evaluateManualServiceWindow(history.messages, Date.now());
      if (!serviceWindow.open) {
        return new Response(JSON.stringify({ error: "OUTSIDE_SERVICE_WINDOW" }), {
          status: 409,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // deno-lint-ignore no-explicit-any
    const customerPhone: string = (conv.customer as any)?.phone ?? "";
    if (!customerPhone) {
      return new Response(JSON.stringify({ error: "telefone do cliente não encontrado" }), {
        status: 422,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Send WhatsApp message via shared helper (canal `connected` da unit; sem
    // canal devolve { ok:false, error:"whatsapp_not_configured" } — sem fallback global).
    const result = await sendWhatsApp(customerPhone, trimmedMessage, {
      unit_id: conv.unit_id,
      channel_id: binding.id,
      ...(serviceWindow ? { outboundOptions: { retryPolicy: "none" as const } } : {}),
      beforeOutbound: (outboundChannel) => {
        if (outboundChannel.provider !== binding.provider) return "whatsapp_channel_changed";
        if (!isMetaShapedProvider(outboundChannel.provider)) return null;
        const currentTime = Date.now();
        const start = Date.parse(serviceWindow?.lastInboundAt ?? "");
        const deadline = Date.parse(serviceWindow?.closesAt ?? "");
        return Number.isFinite(start) && Number.isFinite(deadline)
            && currentTime >= start && currentTime < deadline
          ? null : "OUTSIDE_SERVICE_WINDOW";
      },
    });
    if (!result.ok) {
      if (result.error === "OUTSIDE_SERVICE_WINDOW") {
        return new Response(JSON.stringify({ error: "OUTSIDE_SERVICE_WINDOW" }), {
          status: 409,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      jsonLog("error", {
        evt: "manual_send_failed",
        convId: conversation_id,
        phone: sanitizePhone(customerPhone),
        error: result.error,
        status: result.status,
        missingCreds: result.missingCreds,
      });
      return new Response(
        JSON.stringify({ error: "falha ao enviar mensagem WhatsApp", reason: result.error }),
        {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Append human message to conversation history (RPC atômica — evita race com inbound concorrente)
    const now = new Date().toISOString();
    const humanMsg = {
      event_id: crypto.randomUUID(),
      role: "human",
      author: "human",
      content: trimmedMessage,
      timestamp: now,
      human_user_id: user.id,
    };

    let appendErr: { message: string } | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await supabase.rpc("record_whatsapp_human_message", {
        p_conversation_id: conversation_id,
        p_unit_id: conv.unit_id,
        p_message: humanMsg,
        p_handoff_reason: "atendente respondeu pelo painel",
      });
      appendErr = result.error;
      if (!appendErr) break;
    }
    if (appendErr) {
      jsonLog("error", {
        evt: "manual_append_failed",
        convId: conversation_id,
        err: appendErr.message,
      });
      // O provider já aceitou o envio: não há retry cego. Expomos a falha
      // parcial para reconciliação, em vez de afirmar persistência completa.
      return new Response(JSON.stringify({
        success: true,
        external_success: true,
        local_success: false,
        warning: "CONVERSATION_RECONCILIATION_REQUIRED",
      }), {
        status: 202,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    jsonLog("info", { evt: "human_replied", convId: conversation_id, userId: user.id });

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    jsonLog("error", { evt: "send_manual_message_error", err: redactSecrets(String(err), secrets) });
    return new Response(JSON.stringify({ error: "internal_error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
