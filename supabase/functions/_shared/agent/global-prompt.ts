/**
 * Loader da camada global do prompt (spec Entrega B §8): I/O fino sobre o
 * núcleo puro `global-prompt-core.ts`, que decide a fonte e a polaridade (D7:
 * falha ABERTA para cache de qualquer idade e depois para o baseline).
 *
 * - Lê (pelo adapter `adapters/global-prompt-read.ts`) por service role `ai_prompt_slots` (`slot='global_persona'`) e a versão
 *   ativa em `ai_prompt_versions`. Não recebe id de escopo do caller: a camada
 *   é da plataforma, igual para toda unidade.
 * - Cache em memória do isolate, TTL de 60s; invalidação só por TTL. É
 *   deliberado e diferente do `unitCache` dos workers (zerado por invocação).
 * - Falha emite `ai_global_prompt_read_failed` com motivo e código, nunca o
 *   corpo.
 *
 * Sem `Deno` nem `security.ts`: client, relógio e logger entram por parâmetro,
 * para o vitest e o `tsc -b` alcançarem.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { readActiveGlobalPrompt } from "./adapters/global-prompt-read.ts";
import {
  freshCachedGlobalPrompt,
  GLOBAL_PROMPT_SLOT,
  resolveGlobalPrompt,
  type GlobalPromptCacheEntry,
  type GlobalPromptSource,
} from "./global-prompt-core.ts";

export interface GlobalPrompt {
  body: string;
  /** Id da versão ativa, ou `baseline`. */
  version: string;
  source: GlobalPromptSource;
}

export type GlobalPromptLog = (level: "info" | "warn" | "error", payload: Record<string, unknown>) => void;

export interface GlobalPromptLoadOptions {
  requestId?: string;
  /** `jsonLog` de `_shared/security.ts` no turno. */
  log: GlobalPromptLog;
}

/** Um loader = um cache. O do módulo (`loadGlobalPrompt`) vive o quanto vive o isolate. */
export function createGlobalPromptLoader(now: () => number = Date.now) {
  let cache: GlobalPromptCacheEntry | null = null;
  return async function load(supabase: SupabaseClient, opts: GlobalPromptLoadOptions): Promise<GlobalPrompt> {
    const hit = freshCachedGlobalPrompt(cache, now());
    if (hit) return { body: hit.body, version: hit.version, source: hit.source };

    const read = await readActiveGlobalPrompt(supabase);
    const resolved = resolveGlobalPrompt(read, cache, now());
    cache = resolved.cache;
    if (resolved.failure) {
      opts.log("warn", {
        requestId: opts.requestId,
        evt: "ai_global_prompt_read_failed",
        slot: GLOBAL_PROMPT_SLOT,
        reason: resolved.failure.reason,
        code: resolved.failure.code,
        source: resolved.source,
        version: resolved.version,
      });
    }
    return { body: resolved.body, version: resolved.version, source: resolved.source };
  };
}

export const loadGlobalPrompt = createGlobalPromptLoader();
