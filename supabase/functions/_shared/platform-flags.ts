/**
 * Resolve feature flags globais da plataforma (tabela platform_flags).
 *
 * Mesma arquitetura de stripe-config.ts: cache em memória TTL 5min — Edge
 * Functions quentes não fazem SELECT a cada request, mas refletem mudança do
 * admin em ≤5min sem redeploy.
 *
 * Semântica fail-closed: flag ausente ou DB indisponível = OFF (false).
 * Flags booleanas guardam jsonb true/false; flags de escolha guardam string
 * (ex.: billing_provider_default = "stripe").
 *
 * Fase 1 billing-asaas — consumidores chegam nas Fases 2+ (nenhuma EF importa
 * este módulo ainda; ao importar, lembrar do checklist de redeploy no CLAUDE.md).
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CachedFlag {
  value: unknown;
  fetchedAt: number;
}

const cache = new Map<string, CachedFlag>();

function getSupabase(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

export async function getFlagValue(key: string): Promise<unknown> {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.value;
  }

  let value: unknown = null;
  try {
    const supabase = getSupabase();
    const { data } = await supabase
      .from("platform_flags")
      .select("value")
      .eq("key", key)
      .maybeSingle();
    value = data?.value ?? null;
  } catch {
    // DB indisponível — fail-closed (null = flag OFF)
    value = null;
  }

  cache.set(key, { value, fetchedAt: Date.now() });
  return value;
}

/** Flag booleana. Só `true` jsonb liga; ausente/erro/qualquer outro valor = OFF. */
export async function isFlagEnabled(key: string): Promise<boolean> {
  return (await getFlagValue(key)) === true;
}

/** Flag de escolha (string jsonb). Fallback quando ausente/tipo errado. */
export async function getFlagString(key: string, fallback: string): Promise<string> {
  const value = await getFlagValue(key);
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export function clearPlatformFlagsCache(): void {
  cache.clear();
}
