// Edge Function: manage-platform-secrets
// CRUD de secrets globais da plataforma (Stripe, futuras integrações).
// Autentica via JWT, exige papel `platform_admin`.
// NUNCA devolve o valor do secret — só last4, key e metadata.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { genRequestId, jsonLog } from "../_shared/security.ts";
import { corsHeadersFor } from "../_shared/cors.ts";
import { clearStripeConfigCache } from "../_shared/stripe-config.ts";
import { clearAsaasConfigCache } from "../_shared/asaas-config.ts";
import { clearDatafyAccountConfigCache } from "../_shared/datafy-account-config.ts";
import {
  DATAFY_ACCOUNT_TOKEN_KEY,
  decideAccountTokenRead,
} from "../_shared/datafy-account-config-core.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const VALID_KEYS = new Set([
  "stripe_secret_key",
  "stripe_webhook_secret",
  "asaas_api_key",
  "asaas_webhook_token",
  DATAFY_ACCOUNT_TOKEN_KEY,
]);

const KEY_DESCRIPTIONS: Record<string, string> = {
  stripe_secret_key: "Chave secreta Stripe (sk_test_... ou sk_live_...)",
  stripe_webhook_secret: "Webhook signing secret (whsec_...)",
  asaas_api_key: "Chave da API Asaas (sandbox $aact_hmlg_... ou produção $aact_prod_...)",
  asaas_webhook_token: "Token do header asaas-access-token nos webhooks (32-255 caracteres)",
  [DATAFY_ACCOUNT_TOKEN_KEY]: "Token de conta da Datafy (sk_acct_...), acesso a todos os canais da conta",
};

// Centraliza a limpeza de cache de config de TODOS os providers — upsert/delete
// chama isto uma vez; provider novo entra aqui, não em cada call site solto.
//
// Escopo real: cada Edge Function é seu próprio isolate com sua própria cópia
// do módulo (CLAUDE.md: "Edge Functions não compartilham bundle em runtime").
// As chamadas abaixo só limpam o cache DESTE isolate — que aqui nem chega
// a ser populado, pois manage-platform-secrets nunca lê getStripeSecretKey()/
// getAsaasApiKey()/getDatafyAccountToken(). Isolates que de fato leem a chave
// (stripe-webhook, create-checkout-session, o futuro asaas-webhook, etc.) mantêm
// o valor antigo em cache até o próprio TTL de 5min expirar — uma chave
// rotacionada pode levar até 5min pra valer em todo lugar. Não existe
// invalidação cross-isolate; esse TTL bounded é o comportamento aceito.
function clearAllProviderConfigCaches(): void {
  clearStripeConfigCache();
  clearAsaasConfigCache();
  clearDatafyAccountConfigCache();
}

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
    if (callerErr || !callerData.user) {
      return jsonResponse(req, { error: "Sessão inválida." }, 401);
    }
    const callerId = callerData.user.id;

    if (!(await isPlatformAdmin(callerId))) {
      return jsonResponse(req, { error: "Apenas administradores da plataforma." }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const { action } = body;

    // ── list ─────────────────────────────────────────────────────────────────
    if (action === "list") {
      const { data, error } = await supabase
        .from("platform_secrets")
        .select("key, last4, description, updated_at")
        .order("key");

      if (error) {
        jsonLog("error", { reqId, evt: "platform_secrets_list_error", err: error.message });
        return jsonResponse(req, { error: "Falha ao listar configurações." }, 500);
      }

      // Include keys that aren't configured yet (so UI shows them as "não configurado")
      const configuredKeys = new Set((data ?? []).map((d) => d.key));
      const allKeys = [...VALID_KEYS].map((key) => {
        const existing = data?.find((d) => d.key === key);
        return {
          key,
          last4: existing?.last4 ?? null,
          description: KEY_DESCRIPTIONS[key] ?? key,
          configured: configuredKeys.has(key),
          updated_at: existing?.updated_at ?? null,
        };
      });

      return jsonResponse(req, { success: true, secrets: allKeys });
    }

    // ── upsert ───────────────────────────────────────────────────────────────
    if (action === "upsert") {
      const key = String(body.key ?? "");
      let value = String(body.value ?? "");

      if (!VALID_KEYS.has(key)) {
        return jsonResponse(req, { error: "Chave inválida." }, 400);
      }
      // Token de conta Datafy: a mesma régua da leitura, aplicada ao valor CRU
      // do corpo (`typeof` decide, não o `String(...)` acima). Grava o token
      // aparado, para o `last4` sair do valor que a leitura aceita. Nunca ecoa
      // nem loga o valor.
      if (key === DATAFY_ACCOUNT_TOKEN_KEY) {
        const decision = decideAccountTokenRead({ row: { value: body.value }, error: null });
        if (decision.ok === false) {
          return jsonResponse(
            req,
            { error: "Token de conta da Datafy inválido: precisa começar com sk_acct_ e não ter espaços." },
            400,
          );
        }
        value = decision.token;
      }
      if (value.length < 10) {
        return jsonResponse(req, { error: "Valor muito curto." }, 400);
      }

      const last4 = value.slice(-4);

      const { error } = await supabase
        .from("platform_secrets")
        .upsert(
          {
            key,
            value,
            last4,
            description: KEY_DESCRIPTIONS[key] ?? key,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "key" },
        );

      if (error) {
        jsonLog("error", { reqId, evt: "platform_secrets_upsert_error", key, err: error.message });
        return jsonResponse(req, { error: "Falha ao salvar configuração." }, 500);
      }

      clearAllProviderConfigCaches(); // só limpa o cache deste isolate — ver comentário na função

      jsonLog("info", { reqId, evt: "platform_secret_upserted", key });
      return jsonResponse(req, { success: true, key, last4 });
    }

    // ── delete ───────────────────────────────────────────────────────────────
    if (action === "delete") {
      const key = String(body.key ?? "");
      if (!VALID_KEYS.has(key)) {
        return jsonResponse(req, { error: "Chave inválida." }, 400);
      }

      const { error } = await supabase
        .from("platform_secrets")
        .delete()
        .eq("key", key);

      if (error) {
        jsonLog("error", { reqId, evt: "platform_secrets_delete_error", key, err: error.message });
        return jsonResponse(req, { error: "Falha ao remover configuração." }, 500);
      }

      clearAllProviderConfigCaches(); // só limpa o cache deste isolate — ver comentário na função

      jsonLog("info", { reqId, evt: "platform_secret_deleted", key });
      return jsonResponse(req, { success: true });
    }

    return jsonResponse(req, { error: "Ação inválida." }, 400);
  } catch (err) {
    jsonLog("error", { reqId, evt: "manage_platform_secrets_unhandled", err: String(err) });
    return jsonResponse(req, { error: "Falha ao processar solicitação." }, 500);
  }
});
