/**
 * Resolve Stripe platform secrets.
 *
 * Prioridade: platform_secrets (banco) → Deno.env (fallback legado).
 * Cache em memória com TTL 5min — Edge Functions quentes não fazem SELECT
 * a cada request, mas refletem mudanças do admin em ≤5min.
 *
 * Chamado por: manage-stripe-accounts, create-checkout-session, stripe-webhook.
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

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
    // DB unavailable — fall through to env
  }

  const envValue = Deno.env.get(envFallback) ?? "";
  if (envValue) {
    cache.set(key, { value: envValue, fetchedAt: Date.now() });
  }
  return envValue;
}

export async function getStripeSecretKey(): Promise<string> {
  return resolveSecret("stripe_secret_key", "STRIPE_SECRET_KEY");
}

export async function getStripeWebhookSecret(): Promise<string> {
  return resolveSecret("stripe_webhook_secret", "STRIPE_WEBHOOK_SECRET");
}

export function clearStripeConfigCache(): void {
  cache.clear();
}
