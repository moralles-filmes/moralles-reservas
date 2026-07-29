import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { type WhatsAppProvider, type ChannelCredentials } from "../_shared/whatsapp-providers.ts";
import { corsHeadersFor } from "../_shared/cors.ts";
import { resolveWhatsAppGateByUnit, clearWhatsAppGateCache } from "../_shared/whatsapp-service-gate.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

function jsonResponse(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeadersFor(req), "Content-Type": "application/json" },
  });
}

async function isPlatformAdmin(userId: string): Promise<boolean> {
  const { data } = await supabase
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();
  return !!data;
}

/**
 * Mensagem por estado. Textos DIFERENTES de propósito: "regularize a
 * mensalidade" e "contrate a automação" pedem ações opostas, e um texto
 * genérico faria o cliente tentar a errada.
 */
const NEW_PROVISIONING_MESSAGE: Record<string, string> = {
  GRACE_PERIOD:
    "Há uma mensalidade da automação em aberto. Regularize em Cobrança para adicionar um novo número.",
  LEGACY_GRANDFATHERED:
    "Sua unidade usa a automação de WhatsApp em condição anterior à cobrança. Adicionar um novo número exige contratar a mensalidade da instância.",
  NOT_ENTITLED:
    "A automação de WhatsApp não está contratada para esta organização. Contrate em Cobrança para configurar o canal.",
  SUSPENDED_UNPAID:
    "Automação de WhatsApp suspensa por falta de pagamento. Regularize em Cobrança.",
  ADMIN_BLOCKED:
    "Automação de WhatsApp bloqueada administrativamente. Fale com o suporte.",
  ACTIVE: "Não foi possível criar o canal.",
  OVERRIDE_ACTIVE: "Não foi possível criar o canal.",
};

/**
 * Estado indeterminado ≠ sem direito. Dizer "você não contratou" a quem só
 * sofreu um soluço de leitura manda o cliente comprar o que já tem.
 */
const PROVISIONING_UNVERIFIABLE =
  "Não foi possível verificar o direito de uso da automação de WhatsApp agora. Tente novamente em alguns minutos.";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeadersFor(req) });
  }

  // Cache do gate é por invocação — zera aqui, mesmo padrão do unitCache dos
  // workers, senão um isolate quente serve estado de suspensão velho.
  clearWhatsAppGateCache();

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return jsonResponse(req, { error: "Não autenticado." }, 401);

    const { data: callerData, error: callerErr } = await supabase.auth.getUser(jwt);
    if (callerErr || !callerData.user) return jsonResponse(req, { error: "Sessão inválida." }, 401);
    const callerId = callerData.user.id;

    const body = await req.json().catch(() => ({}));
    const { action, unit_id: unitId } = body;

    if (!unitId) return jsonResponse(req, { error: "unit_id é obrigatório." }, 400);

    if (!(await isPlatformAdmin(callerId))) {
      return jsonResponse(req, { error: "Apenas administradores da plataforma." }, 403);
    }

    // ── list ──────────────────────────────────────────────────────────────────
    // Retorna canais da unidade com colunas seguras (sem `credentials`).
    // Necessário porque whatsapp_channels usa FORCE RLS — UI não pode mais
    // consultar a tabela direto.
    if (action === "list") {
      const { data, error } = await supabase
        .from("whatsapp_channels")
        .select("id, unit_id, provider, status, display_phone, last_event_at, last_error, webhook_secret, created_at, updated_at")
        .eq("unit_id", unitId)
        .order("created_at", { ascending: true });

      if (error) {
        console.error("manage-channels:list", error);
        return jsonResponse(req, { error: "Falha ao listar canais." }, 500);
      }
      return jsonResponse(req, { success: true, channels: data ?? [] });
    }

    // ── create ─────────────────────────────────────────────────────────────────
    if (action === "create") {
      // Gate de NOVO provisionamento: só ACTIVE e OVERRIDE_ACTIVE autorizam
      // gerar custo externo novo. GRACE_PERIOD preserva a instância existente
      // mas não cria outra; LEGACY_GRANDFATHERED preserva o uso existente mas
      // não expande o serviço.
      //
      // NÃO consulta `whatsapp_service_enforcement`, nem para liberar nem para
      // bloquear: aquela flag governa a suspensão de uso EXISTENTE. Esta guarda
      // impede despesa recorrente nova de nascer e vale sempre. Fail-closed:
      // gate irresolvível (unidade sem organização, leitura que falhou) recusa.
      //
      // platform_admin NÃO passa por cima — esta EF já é exclusiva de
      // super-admin, então "exceto para admin" seria "nunca". Provisionar para
      // organização sem assinatura exige override formal de `whatsapp`, que
      // leva a OVERRIDE_ACTIVE e libera pela porta da frente, com rastro.
      const { count: existingChannels, error: countErr } = await supabase
        .from("whatsapp_channels")
        .select("id", { count: "exact", head: true })
        .eq("unit_id", unitId);

      if (countErr) {
        console.error("manage-channels:create count", countErr);
        return jsonResponse(req, { error: PROVISIONING_UNVERIFIABLE }, 403);
      }

      if ((existingChannels ?? 0) === 0) {
        const gate = await resolveWhatsAppGateByUnit(supabase, unitId);
        if (!gate || !gate.provisioning.allowed) {
          const message = !gate || gate.provisioning.blockReason === "STATE_READ_FAILED"
            ? PROVISIONING_UNVERIFIABLE
            : NEW_PROVISIONING_MESSAGE[gate.state];
          return jsonResponse(req, { error: message }, 403);
        }
      }

      const provider: WhatsAppProvider = body.provider;
      const credentials: ChannelCredentials = body.credentials ?? {};

      if (!provider || !["zapi", "waha", "official"].includes(provider)) {
        return jsonResponse(req, { error: "Provedor inválido." }, 400);
      }

      // Generate a per-channel webhook secret
      const webhookSecret = Array.from(
        crypto.getRandomValues(new Uint8Array(32))
      ).map((b) => b.toString(16).padStart(2, "0")).join("");

      const { data: channel, error: insertErr } = await supabase
        .from("whatsapp_channels")
        .insert({
          unit_id: unitId,
          provider,
          credentials,       // stored as JSONB — add pgcrypto encryption in production
          webhook_secret: webhookSecret,
          status: "disconnected",
        })
        .select("id, unit_id, provider, status, display_phone, created_at")
        .single();

      if (insertErr || !channel) {
        console.error("manage-channels:create", insertErr);
        return jsonResponse(req, { error: "Falha ao criar canal." }, 500);
      }

      const supabaseUrl = Deno.env.get("SUPABASE_URL");
      if (!supabaseUrl) {
        console.error("manage-channels:create SUPABASE_URL not configured");
        return jsonResponse(req, { error: "Falha ao gerar URL de webhook." }, 500);
      }
      const projectRef = supabaseUrl.match(/https:\/\/([^.]+)\./)?.[1];
      if (!projectRef) {
        console.error("manage-channels:create unexpected SUPABASE_URL format", supabaseUrl);
        return jsonResponse(req, { error: "Falha ao gerar URL de webhook." }, 500);
      }
      const webhookUrl = `https://${projectRef}.supabase.co/functions/v1/webhook-whatsapp?channel=${channel.id}`;

      return jsonResponse(req, { success: true, channel, webhookUrl, webhookSecret });
    }

    // ── update ─────────────────────────────────────────────────────────────────
    // Atualiza credenciais de um canal existente SEM recriar — channel_id e
    // webhook_secret são preservados, então o webhook configurado no provedor
    // continua válido. Merge: só sobrescreve as chaves enviadas com valor
    // não-vazio (campo em branco mantém o atual). Caso de uso: rotacionar só o
    // Client Token do Z-API sem reenviar instance_id/token.
    if (action === "update") {
      const channelId = String(body.channel_id ?? "");
      if (!channelId) return jsonResponse(req, { error: "channel_id é obrigatório." }, 400);

      const incoming: Record<string, unknown> = body.credentials ?? {};

      const { data: existing, error: fetchErr } = await supabase
        .from("whatsapp_channels")
        .select("credentials")
        .eq("id", channelId)
        .eq("unit_id", unitId)
        .maybeSingle();

      if (fetchErr) {
        console.error("manage-channels:update fetch", fetchErr);
        return jsonResponse(req, { error: "Falha ao carregar canal." }, 500);
      }
      if (!existing) return jsonResponse(req, { error: "Canal não encontrado." }, 404);

      // Whitelist de chaves conhecidas — evita injeção de campos arbitrários no JSONB.
      const ALLOWED_CRED_KEYS = [
        "instance_id", "token", "client_token",                                  // Z-API
        "base_url", "api_key", "session_name",                                   // WAHA
        "phone_number_id", "business_account_id", "access_token", "app_secret",  // Official
      ];

      const merged: Record<string, unknown> = { ...((existing.credentials as Record<string, unknown>) ?? {}) };
      let changed = 0;
      for (const key of ALLOWED_CRED_KEYS) {
        const v = incoming[key];
        if (typeof v === "string" && v.trim() !== "") {
          merged[key] = v.trim();
          changed++;
        }
      }

      if (changed === 0) {
        return jsonResponse(req, { error: "Nenhuma credencial para atualizar." }, 400);
      }

      const { error: updateErr } = await supabase
        .from("whatsapp_channels")
        .update({ credentials: merged, updated_at: new Date().toISOString() })
        .eq("id", channelId)
        .eq("unit_id", unitId);

      if (updateErr) {
        console.error("manage-channels:update", updateErr);
        return jsonResponse(req, { error: "Falha ao atualizar credenciais." }, 500);
      }
      return jsonResponse(req, { success: true });
    }

    // ── delete ─────────────────────────────────────────────────────────────────
    if (action === "delete") {
      const channelId = String(body.channel_id ?? "");
      if (!channelId) return jsonResponse(req, { error: "channel_id é obrigatório." }, 400);

      const { error: delErr } = await supabase
        .from("whatsapp_channels")
        .delete()
        .eq("id", channelId)
        .eq("unit_id", unitId);

      if (delErr) {
        console.error("manage-channels:delete", delErr);
        return jsonResponse(req, { error: "Falha ao remover canal." }, 500);
      }
      return jsonResponse(req, { success: true });
    }

    // ── test ──────────────────────────────────────────────────────────────────
    if (action === "test") {
      const channelId = String(body.channel_id ?? "");
      if (!channelId) return jsonResponse(req, { error: "channel_id é obrigatório." }, 400);

      const { data: channel } = await supabase
        .from("whatsapp_channels")
        .select("*")
        .eq("id", channelId)
        .eq("unit_id", unitId)
        .maybeSingle();

      if (!channel) return jsonResponse(req, { error: "Canal não encontrado." }, 404);

      const creds: ChannelCredentials = channel.credentials ?? {};
      const provider: WhatsAppProvider = channel.provider;

      let connected = false;
      let errorMsg: string | null = null;

      try {
        if (provider === "zapi") {
          const { instance_id, token, client_token } = creds;
          if (!instance_id || !token) throw new Error("Credenciais Z-API incompletas.");
          const url = `https://api.z-api.io/instances/${instance_id}/token/${token}/status`;
          const res = await fetch(url, {
            headers: client_token ? { "Client-Token": client_token } : {},
          });
          connected = res.ok;
          if (!connected) errorMsg = `HTTP ${res.status}`;
        } else if (provider === "waha") {
          const { base_url, api_key, session_name = "default" } = creds;
          if (!base_url) throw new Error("URL base WAHA não configurada.");
          const url = `${base_url.replace(/\/$/, "")}/api/sessions/${session_name}`;
          const res = await fetch(url, {
            headers: api_key ? { "X-Api-Key": api_key } : {},
          });
          connected = res.ok;
          if (!connected) errorMsg = `HTTP ${res.status}`;
        } else if (provider === "official") {
          const { phone_number_id, access_token } = creds;
          if (!phone_number_id || !access_token) throw new Error("Credenciais Meta incompletas.");
          const url = `https://graph.facebook.com/v19.0/${phone_number_id}?fields=id,display_phone_number`;
          const res = await fetch(url, {
            headers: { "Authorization": `Bearer ${access_token}` },
          });
          connected = res.ok;
          if (!connected) errorMsg = `HTTP ${res.status}`;
          if (connected) {
            const data = await res.json();
            // Update display_phone from Meta
            if (data.display_phone_number) {
              await supabase
                .from("whatsapp_channels")
                .update({ display_phone: data.display_phone_number })
                .eq("id", channelId);
            }
          }
        }
      } catch (e) {
        errorMsg = String(e);
        connected = false;
      }

      const newStatus = connected ? "connected" : "error";
      await supabase
        .from("whatsapp_channels")
        .update({
          status: newStatus,
          last_event_at: connected ? new Date().toISOString() : undefined,
          last_error: connected ? null : errorMsg,
        })
        .eq("id", channelId);

      return jsonResponse(req, { success: connected, status: newStatus, error: errorMsg });
    }

    return jsonResponse(req, { error: "Ação inválida." }, 400);
  } catch (err) {
    console.error("manage-channels unhandled", err);
    return jsonResponse(req, { error: "Falha ao processar solicitação." }, 500);
  }
});
