// Edge Function: manage-ai-providers
// CRUD de chaves de API de IA por unidade (BYOK).
// Autentica via JWT, exige papel `platform_admin` (super-admin da Moralles).
// Nunca devolve `api_key` ao cliente — só metadata + last4.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { genRequestId, jsonLog } from "../_shared/security.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const VALID_PROVIDERS = new Set(["claude", "openai", "gemini", "grok", "deepseek"]);

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
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
    return new Response(null, { headers: corsHeaders });
  }

  const reqId = genRequestId();

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return jsonResponse({ error: "Não autenticado." }, 401);

    const { data: callerData, error: callerErr } = await supabase.auth.getUser(jwt);
    if (callerErr || !callerData.user) return jsonResponse({ error: "Sessão inválida." }, 401);
    const callerId = callerData.user.id;

    const body = await req.json().catch(() => ({}));
    const { action, unit_id: unitId } = body;

    if (!unitId) return jsonResponse({ error: "unit_id é obrigatório." }, 400);

    if (!(await isPlatformAdmin(callerId))) {
      return jsonResponse({ error: "Apenas administradores da plataforma." }, 403);
    }

    // ── list ─────────────────────────────────────────────────────────────────
    if (action === "list") {
      const { data, error } = await supabase
        .from("ai_provider_credentials")
        .select("provider, last4, active, updated_at")
        .eq("unit_id", unitId);

      if (error) {
        jsonLog("error", { reqId, evt: "ai_keys_list_error", err: error.message });
        return jsonResponse({ error: error.message }, 500);
      }

      return jsonResponse({ success: true, keys: data ?? [] });
    }

    // ── upsert ───────────────────────────────────────────────────────────────
    if (action === "upsert") {
      const provider = String(body.provider ?? "");
      const apiKey = String(body.api_key ?? "");

      if (!VALID_PROVIDERS.has(provider)) {
        return jsonResponse({ error: "Provedor inválido." }, 400);
      }
      if (apiKey.length < 10) {
        return jsonResponse({ error: "Chave de API muito curta." }, 400);
      }

      const last4 = apiKey.slice(-4);

      const { data, error } = await supabase
        .from("ai_provider_credentials")
        .upsert(
          {
            unit_id: unitId,
            provider,
            api_key: apiKey,
            last4,
            active: true,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "unit_id,provider" }
        )
        .select("provider, last4, active, updated_at")
        .single();

      if (error || !data) {
        jsonLog("error", { reqId, evt: "ai_keys_upsert_error", provider, err: error?.message });
        return jsonResponse({ error: error?.message ?? "Erro ao salvar chave." }, 500);
      }

      jsonLog("info", { reqId, evt: "ai_key_upserted", unit_id: unitId, provider });
      return jsonResponse({ success: true, key: data });
    }

    // ── delete ───────────────────────────────────────────────────────────────
    if (action === "delete") {
      const provider = String(body.provider ?? "");
      if (!VALID_PROVIDERS.has(provider)) {
        return jsonResponse({ error: "Provedor inválido." }, 400);
      }

      const { error } = await supabase
        .from("ai_provider_credentials")
        .delete()
        .eq("unit_id", unitId)
        .eq("provider", provider);

      if (error) {
        jsonLog("error", { reqId, evt: "ai_keys_delete_error", provider, err: error.message });
        return jsonResponse({ error: error.message }, 500);
      }

      jsonLog("info", { reqId, evt: "ai_key_deleted", unit_id: unitId, provider });
      return jsonResponse({ success: true });
    }

    return jsonResponse({ error: "Ação inválida." }, 400);
  } catch (err) {
    jsonLog("error", { reqId, evt: "manage_ai_providers_unhandled", err: String(err) });
    return jsonResponse({ error: String(err) }, 500);
  }
});
