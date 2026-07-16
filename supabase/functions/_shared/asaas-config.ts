/**
 * Resolve config Asaas (chave de API, token de webhook, ambiente, base URL).
 *
 * Prioridade: platform_secrets (banco) → Deno.env (fallback legado). Mesma
 * arquitetura de stripe-config.ts: cache em memória com TTL 5min — Edge
 * Functions quentes não fazem SELECT a cada request, mas refletem mudanças
 * do admin em ≤5min.
 *
 * Fase 2 billing-asaas — sem consumidor ainda (chega em `_shared/asaas.ts` e
 * `asaas-webhook` nas próximas tasks). Ao importar este módulo numa EF,
 * lembrar do checklist de redeploy no CLAUDE.md.
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { parseAsaasEnv, resolveAsaasBaseUrl, type AsaasEnv } from "./asaas-core.ts";

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CachedSecret {
  value: string;
  fetchedAt: number;
}

const cache = new Map<string, CachedSecret>();

function getSupabase(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

async function resolveSecret(key: string, envFallback: string): Promise<string> {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.value;
  }

  try {
    const supabase = getSupabase();
    const { data } = await supabase
      .from("platform_secrets")
      .select("value")
      .eq("key", key)
      .maybeSingle();

    if (data?.value) {
      cache.set(key, { value: data.value, fetchedAt: Date.now() });
      return data.value;
    }
  } catch {
    // DB indisponível — cai pro env
  }

  const envValue = Deno.env.get(envFallback) ?? "";
  if (envValue) {
    cache.set(key, { value: envValue, fetchedAt: Date.now() });
  }
  return envValue;
}

export async function getAsaasApiKey(): Promise<string> {
  return resolveSecret("asaas_api_key", "ASAAS_API_KEY");
}

export async function getAsaasWebhookToken(): Promise<string> {
  return resolveSecret("asaas_webhook_token", "ASAAS_WEBHOOK_TOKEN");
}

export function getAsaasEnv(): AsaasEnv {
  return parseAsaasEnv(Deno.env.get("ASAAS_ENV"));
}

export function getAsaasBaseUrl(): string {
  return resolveAsaasBaseUrl(getAsaasEnv(), Deno.env.get("ASAAS_BASE_URL"));
}

export function clearAsaasConfigCache(): void {
  cache.clear();
}
