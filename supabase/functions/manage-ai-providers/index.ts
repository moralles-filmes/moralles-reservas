// Edge Function: manage-ai-providers
// CRUD de chaves de API de IA por unidade (BYOK).
// Autentica via JWT, exige papel `platform_admin` (super-admin da Moralles).
// Nunca devolve `api_key` ao cliente — só metadata + last4.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { genRequestId, jsonLog } from "../_shared/security.ts";

import { corsHeadersFor } from "../_shared/cors.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const VALID_PROVIDERS = new Set(["claude", "openai", "gemini", "grok", "deepseek"]);

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

  const reqId = genRequestId();

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

    // ── list ─────────────────────────────────────────────────────────────────
    if (action === "list") {
      const { data, error } = await supabase
        .from("ai_provider_credentials")
        .select("provider, last4, active, updated_at")
        .eq("unit_id", unitId);

      if (error) {
        jsonLog("error", { reqId, evt: "ai_keys_list_error", err: error.message });
        return jsonResponse(req, { error: "Falha ao listar chaves." }, 500);
      }

      return jsonResponse(req, { success: true, keys: data ?? [] });
    }

    // ── upsert ───────────────────────────────────────────────────────────────
    if (action === "upsert") {
      const provider = String(body.provider ?? "");
      const apiKey = String(body.api_key ?? "");

      if (!VALID_PROVIDERS.has(provider)) {
        return jsonResponse(req, { error: "Provedor inválido." }, 400);
      }
      if (apiKey.length < 10) {
        return jsonResponse(req, { error: "Chave de API muito curta." }, 400);
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
        return jsonResponse(req, { error: "Falha ao salvar chave." }, 500);
      }

      jsonLog("info", { reqId, evt: "ai_key_upserted", unit_id: unitId, provider });
      return jsonResponse(req, { success: true, key: data });
    }

    // ── delete ───────────────────────────────────────────────────────────────
    if (action === "delete") {
      const provider = String(body.provider ?? "");
      if (!VALID_PROVIDERS.has(provider)) {
        return jsonResponse(req, { error: "Provedor inválido." }, 400);
      }

      const { error } = await supabase
        .from("ai_provider_credentials")
        .delete()
        .eq("unit_id", unitId)
        .eq("provider", provider);

      if (error) {
        jsonLog("error", { reqId, evt: "ai_keys_delete_error", provider, err: error.message });
        return jsonResponse(req, { error: "Falha ao remover chave." }, 500);
      }

      jsonLog("info", { reqId, evt: "ai_key_deleted", unit_id: unitId, provider });
      return jsonResponse(req, { success: true });
    }

    return jsonResponse(req, { error: "Ação inválida." }, 400);
  } catch (err) {
    jsonLog("error", { reqId, evt: "manage_ai_providers_unhandled", err: String(err) });
    return jsonResponse(req, { error: "Falha ao processar solicitação." }, 500);
  }
});
