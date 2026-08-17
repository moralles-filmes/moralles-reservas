// Edge Function de diagnóstico do canal WhatsApp por unidade.
//
// Lê do servidor (service_role) o estado do canal, da chave de IA e as
// estatísticas das últimas 24h em `webhook_executions` + `processed_messages`.
// Alimenta a aba "Diagnóstico" em /platform/automacao/<slug>.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeadersFor } from "../_shared/cors.ts";
import {
  getWhatsAppProvider,
  type ChannelCredentials,
  type WhatsAppProvider,
} from "../_shared/whatsapp-providers.ts";
import { resolveChannelCredentials } from "../_shared/whatsapp-channel-credentials.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const AI_KEY_ENV: Record<string, string> = {
  claude: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  grok: "GROK_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
};

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

function presentCredentialKeys(provider: WhatsAppProvider, creds: ChannelCredentials): string[] {
  // Não expomos os valores — apenas quais chaves estão preenchidas.
  const keys: Array<keyof ChannelCredentials> =
    provider === "zapi"
      ? ["instance_id", "token", "client_token"]
      : provider === "uazapi"
        ? []
      : provider === "waha"
        ? ["base_url", "api_key", "session_name"]
        : ["phone_number_id", "business_account_id", "access_token", "app_secret"];
  return keys.filter((k) => {
    const v = creds[k];
    return typeof v === "string" && v.length > 0;
  });
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

    if (!(await isPlatformAdmin(callerData.user.id))) {
      return jsonResponse(req, { error: "Apenas administradores da plataforma." }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const unitId: string = body.unit_id ?? "";
    if (!unitId) return jsonResponse(req, { error: "unit_id é obrigatório." }, 400);

    // ── Channel ────────────────────────────────────────────────────────────────
    const { data: channelRows } = await supabase
      .from("whatsapp_channels")
      .select("id, unit_id, provider, status, display_phone, last_event_at, last_error, credentials, is_active, instance_token_secret_id, external_instance_id, connected_at, last_health_check_at, created_at, updated_at")
      .eq("unit_id", unitId)
      .order("created_at", { ascending: true });

    const rows = channelRows ?? [];
    const channelRow = rows.find((row) => row.is_active === true)
      ?? rows.find((row) => row.is_active === null && row.status === "connected")
      ?? rows.find((row) => row.is_active === null)
      ?? null;

    let providerObserved: unknown = null;
    if (channelRow) {
      try {
        const provider = channelRow.provider as WhatsAppProvider;
        const adapter = getWhatsAppProvider(provider);
        if (adapter.getConnectionStatus) {
          const credentials = await resolveChannelCredentials(supabase, {
            id: channelRow.id,
            provider,
            credentials: (channelRow.credentials ?? {}) as ChannelCredentials,
            instance_token_secret_id: channelRow.instance_token_secret_id,
          });
          providerObserved = await adapter.getConnectionStatus(credentials);
        }
      } catch (error) {
        providerObserved = { status: "provider_error", error: "provider_status_unavailable" };
        console.error("whatsapp-health:provider status", String(error));
      }
    }

    const channelInfo = channelRow
      ? {
          id: channelRow.id,
          provider: channelRow.provider,
          status: channelRow.status,
          is_active: channelRow.is_active,
          display_phone: channelRow.display_phone,
          last_event_at: channelRow.last_event_at,
          last_error: channelRow.last_error,
          credentials_present: presentCredentialKeys(
            channelRow.provider as WhatsAppProvider,
            (channelRow.credentials ?? {}) as ChannelCredentials
          ),
          instance_token_configured: channelRow.provider === "uazapi"
            ? !!channelRow.instance_token_secret_id
            : null,
          provider_observed: providerObserved,
          external_instance_id: channelRow.external_instance_id,
          connected_at: channelRow.connected_at,
          last_health_check_at: channelRow.last_health_check_at,
          created_at: channelRow.created_at,
          updated_at: channelRow.updated_at,
        }
      : null;

    // ── AI provider ────────────────────────────────────────────────────────────
    const { data: aiConfigRow } = await supabase
      .from("settings")
      .select("value")
      .eq("unit_id", unitId)
      .eq("key", "ai_config")
      .maybeSingle();

    const aiConfig = (aiConfigRow?.value ?? {}) as { provider?: string; models?: Record<string, string> };
    const aiProvider = aiConfig.provider ?? "claude";
    const aiModel = aiConfig.models?.[aiProvider];

    const { data: aiKeyRow } = await supabase
      .from("ai_provider_credentials")
      .select("last4, active, updated_at")
      .eq("unit_id", unitId)
      .eq("provider", aiProvider)
      .eq("active", true)
      .maybeSingle();

    const globalKeyEnv = AI_KEY_ENV[aiProvider];
    const hasGlobalKey = !!Deno.env.get(globalKeyEnv);

    const aiInfo = {
      provider: aiProvider,
      model: aiModel ?? null,
      key_source: aiKeyRow ? "byok" : (hasGlobalKey ? "global" : "missing"),
      byok_last4: aiKeyRow?.last4 ?? null,
      byok_updated_at: aiKeyRow?.updated_at ?? null,
      global_env: globalKeyEnv,
    };

    // ── Webhook executions (24h) ──────────────────────────────────────────────
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: execs } = await supabase
      .from("webhook_executions")
      .select("id, request_id, outcome, error, duration_ms, created_at, phone_hash, meta")
      .eq("unit_id", unitId)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(50);

    const lastExecutions = execs ?? [];

    // Agrega outcomes
    const byOutcome: Record<string, number> = {};
    for (const e of lastExecutions) {
      byOutcome[e.outcome] = (byOutcome[e.outcome] ?? 0) + 1;
    }

    // Total real (sem cap) — segunda query rápida
    const { count: total24h } = await supabase
      .from("webhook_executions")
      .select("id", { count: "exact", head: true })
      .eq("unit_id", unitId)
      .gte("created_at", since);

    const stats24h = {
      total: total24h ?? 0,
      by_outcome: byOutcome,
      sample_size: lastExecutions.length,
    };

    return jsonResponse(req, {
      success: true,
      generated_at: new Date().toISOString(),
      channel: channelInfo,
      ai: aiInfo,
      stats_24h: stats24h,
      last_executions: lastExecutions,
    });
  } catch (err) {
    console.error("whatsapp-health unhandled", err);
    return jsonResponse(req, { error: "Falha ao obter diagnóstico." }, 500);
  }
});
