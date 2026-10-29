/**
 * Adapter fino dos segredos do Instagram em `platform_secrets` (S5/S6, R2-c).
 *
 * SEM fallback para variável de ambiente (decisão e cache em
 * `instagram-config-core.ts`). O cliente service-role chega por injeção: o
 * `index.ts` da EF o cria a partir do próprio ambiente (único lugar que
 * lê o ambiente, check-portabilidade) e o adapter o obtém só dentro da
 * leitura — se o getter lançar (ambiente incompleto), o núcleo devolve
 * `read_failed`.
 *
 * Uso no `index.ts` (uma instância por isolate, para o cache valer):
 *   const igSecrets = createInstagramConfig(() => supabase);
 *   const r = await igSecrets.readInstagramSecret(INSTAGRAM_SECRET_KEYS.appSecret);
 *   if (r.ok === false) → 503 (nunca "permitido").
 *
 * Nenhum log carrega o valor: só a chave, o `code` do PostgREST (quando string)
 * ou o `name` da exceção. Nunca a mensagem nem o erro convertido em texto.
 * Guarda estática em `src/lib/instagram-config-core.test.ts`.
 *
 * Cada EF é um isolate próprio: `manage-platform-secrets` não lê estes segredos
 * e não tem instância para limpar; a troca no painel vale nas consumidoras ao
 * fim do TTL de 5 min.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jsonLog } from "./security.ts";
import {
  createInstagramSecretReader,
  type InstagramSecretKey,
  type InstagramSecretRead,
} from "./instagram-config-core.ts";

const PLATFORM_SECRETS_TABLE = "platform_secrets";

function logReadFailure(key: string, discriminator: { code?: string; name?: string }): void {
  jsonLog("warn", { evt: "instagram_secret_read_failed", key, ...discriminator });
}

export interface InstagramConfig {
  readInstagramSecret: (key: InstagramSecretKey) => Promise<InstagramSecretRead>;
  clearInstagramConfigCache: () => void;
}

export function createInstagramConfig(getServiceClient: () => SupabaseClient): InstagramConfig {
  const reader = createInstagramSecretReader(async (key) => {
    let result: { data: unknown; error: unknown };
    try {
      result = await getServiceClient()
        .from(PLATFORM_SECRETS_TABLE)
        .select("value")
        .eq("key", key)
        .maybeSingle();
    } catch (err) {
      logReadFailure(key, { name: err instanceof Error ? err.name : typeof err });
      throw err; // o núcleo classifica como `read_failed`
    }
    if (result.error) {
      const code = (result.error as { code?: unknown }).code;
      logReadFailure(key, { code: typeof code === "string" ? code : undefined });
      throw new Error("platform_secrets_read_failed"); // idem
    }
    // O núcleo confere `typeof value === "string"`; aqui não há coerção.
    return (result.data ?? null) as { value: string } | null;
  });

  return {
    async readInstagramSecret(key) {
      const result = await reader.read(key);
      if (result.ok === false) {
        jsonLog("warn", { evt: "instagram_secret_unavailable", key, reason: result.reason });
      }
      return result;
    },
    clearInstagramConfigCache() {
      reader.clear();
    },
  };
}
