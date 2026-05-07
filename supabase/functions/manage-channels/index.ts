import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { type WhatsAppProvider, type ChannelCredentials } from "../_shared/whatsapp-providers.ts";
import { corsHeadersFor } from "../_shared/cors.ts";

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

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeadersFor(req) });
  }

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

      if (error) return jsonResponse(req, { error: error.message }, 500);
      return jsonResponse(req, { success: true, channels: data ?? [] });
    }

    // ── create ─────────────────────────────────────────────────────────────────
    if (action === "create") {
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
        return jsonResponse(req, { error: insertErr?.message ?? "Erro ao criar canal." }, 500);
      }

      const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
      const projectRef = supabaseUrl.match(/https:\/\/([^.]+)\./)?.[1] ?? "<project>";
      const webhookUrl = `https://${projectRef}.supabase.co/functions/v1/webhook-whatsapp?channel=${channel.id}`;

      return jsonResponse(req, { success: true, channel, webhookUrl, webhookSecret });
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

      if (delErr) return jsonResponse(req, { error: delErr.message }, 500);
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
    console.error(err);
    return jsonResponse(req, { error: String(err) }, 500);
  }
});
