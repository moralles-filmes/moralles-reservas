/**
 * Resolve feature flags globais da plataforma (tabela platform_flags).
 *
 * Mesma arquitetura de stripe-config.ts: cache em memória TTL 5min — Edge
 * Functions quentes não fazem SELECT a cada request, mas refletem mudança do
 * admin em ≤5min sem redeploy.
 *
 * Semântica fail-closed pra flag GENUINAMENTE ausente (linha não existe):
 * OFF (false) — deliberado, fica valendo. Uma LEITURA que falha (DB
 * indisponível) é outra coisa: não é cacheada e não fica indistinguível de
 * "false" pra quem precisa saber a diferença — ver `checkFlagEnabled` abaixo.
 * Flags booleanas guardam jsonb true/false; flags de escolha guardam string
 * (ex.: billing_provider_default = "stripe").
 *
 * Fase 2 billing-asaas — consumido hoje por `asaas-webhook` (gate
 * asaas_enabled). Ao importar este módulo numa EF nova, lembrar do checklist
 * de redeploy no CLAUDE.md.
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

/** Resultado de uma leitura direta (sem cache) de platform_flags. */
interface FlagReadResult {
  /** false = a leitura falhou (erro do PostgREST ou exceção) — NÃO é o mesmo que flag ausente. */
  ok: boolean;
  value: unknown;
}

async function readFlagFromDb(key: string): Promise<FlagReadResult> {
  try {
    const supabase = getSupabase();
    // Destructure `error` também: supabase-js RESOLVE `{data:null, error}` em
    // query com erro — não rejeita. Olhar só `data` (como antes) confunde
    // "erro de leitura" com "linha ausente", os dois viram null.
    const { data, error } = await supabase
      .from("platform_flags")
      .select("value")
      .eq("key", key)
      .maybeSingle();

    if (error) {
      return { ok: false, value: null };
    }
    return { ok: true, value: data?.value ?? null };
  } catch {
    // DB indisponível (exceção antes/durante o fetch) — mesma classe de falha.
    return { ok: false, value: null };
  }
}

export async function getFlagValue(key: string): Promise<unknown> {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.value;
  }

  const result = await readFlagFromDb(key);
  // Só cacheia leitura que teve sucesso — uma falha transiente NÃO pode virar
  // "OFF" travado por 5min (TTL inteiro) pra quem só olha o valor.
  if (result.ok) {
    cache.set(key, { value: result.value, fetchedAt: Date.now() });
  }
  return result.value;
}

/** Flag booleana. Só `true` jsonb liga; ausente/erro/qualquer outro valor = OFF.
 *  Contrato inalterado pra callers existentes/futuros: sempre um boolean,
 *  sem distinguir "OFF de verdade" de "não deu pra ler". Quem precisa dessa
 *  distinção usa `checkFlagEnabled`. */
export async function isFlagEnabled(key: string): Promise<boolean> {
  return (await getFlagValue(key)) === true;
}

/** Resultado de `checkFlagEnabled` — ver função abaixo. */
export interface FlagCheckResult {
  /** Valor efetivo pro caller (`false` também quando a leitura falhou). */
  enabled: boolean;
  /** `true` quando o valor acima NÃO é confiável — a leitura falhou, não é uma flag OFF genuína. */
  readFailed: boolean;
}

/**
 * Como `isFlagEnabled`, mas separa "flag OFF de verdade" de "não deu pra
 * saber". Caller que trata as duas coisas igual (ex.: log informativo, UI)
 * continua usando `isFlagEnabled`; caller pra quem uma leitura falha e uma
 * flag OFF exigem ação DIFERENTE (ex.: `asaas-webhook` — falha de leitura
 * não pode virar "descarta o evento") usa esta função.
 */
export async function checkFlagEnabled(key: string): Promise<FlagCheckResult> {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return { enabled: cached.value === true, readFailed: false };
  }

  const result = await readFlagFromDb(key);
  if (!result.ok) {
    return { enabled: false, readFailed: true };
  }
  cache.set(key, { value: result.value, fetchedAt: Date.now() });
  return { enabled: result.value === true, readFailed: false };
}

/** Flag de escolha (string jsonb). Fallback quando ausente/tipo errado. */
export async function getFlagString(key: string, fallback: string): Promise<string> {
  const value = await getFlagValue(key);
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export function clearPlatformFlagsCache(): void {
  cache.clear();
}
