/**
 * Resolve o token de conta da Datafy (`sk_acct_`) a partir de `platform_secrets`.
 *
 * SEM fallback para variável de ambiente, ao contrário de `stripe-config.ts` e
 * `asaas-config.ts`: o token alcança todos os canais da conta de parceiro, e
 * uma cópia velha fora do banco viraria credencial viva durante qualquer soluço
 * de leitura. Leitura que falha devolve `unavailable` e o chamador recusa (503).
 * A decisão e o cache moram em `datafy-account-config-core.ts`; aqui é só I/O.
 * Guarda estática em `src/lib/datafy-account-config-core.test.ts`.
 *
 * Nenhum log carrega o token: só o `reason` do desfecho.
 *
 * Chamado por: manage-platform-secrets (só `clearDatafyAccountConfigCache`) e
 * manage-channels (onboarding/admin com token de conta; envio usa token de canal).
 * Ao importar numa EF nova, lembrar do checklist de redeploy no CLAUDE.md.
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jsonLog } from "./security.ts";
import {
  DATAFY_ACCOUNT_TOKEN_KEY,
  createDatafyAccountTokenReader,
  type DatafyAccountTokenRead,
} from "./datafy-account-config-core.ts";

function getSupabase(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

// Discriminador NÃO secreto de `unavailable`: só o `code` do PostgREST (quando
// é string) ou o `name` da exceção. Nunca a mensagem do erro nem o erro
// convertido em texto (guarda estática no teste).
function logReadFailure(discriminator: { code?: string; name?: string }): void {
  jsonLog("warn", { evt: "datafy_account_token_read_failed", ...discriminator });
}

const reader = createDatafyAccountTokenReader({
  // Cliente criado dentro da leitura: se o ambiente estiver incompleto, o
  // `createClient` lança aqui e o núcleo devolve `unavailable`.
  read: async () => {
    try {
      const { data, error } = await getSupabase()
        .from("platform_secrets")
        .select("value")
        .eq("key", DATAFY_ACCOUNT_TOKEN_KEY)
        .maybeSingle();
      if (error) {
        const code = (error as { code?: unknown }).code;
        logReadFailure({ code: typeof code === "string" ? code : undefined });
      }
      return { row: data ?? null, error };
    } catch (err) {
      logReadFailure({ name: err instanceof Error ? err.name : typeof err });
      throw err; // o núcleo classifica como `unavailable`
    }
  },
  now: () => Date.now(),
});

export async function getDatafyAccountToken(): Promise<DatafyAccountTokenRead> {
  const result = await reader.get();
  if (result.ok === false) {
    jsonLog("warn", { evt: "datafy_account_token_unavailable", reason: result.reason });
  }
  return result;
}

export function clearDatafyAccountConfigCache(): void {
  reader.clear();
}
