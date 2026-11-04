/**
 * Núcleo puro dos segredos do Instagram em `platform_secrets` (plano S5/S6, R2-c).
 *
 * - `instagram_app_secret`: chave secreta do app Moralles Reservas (o app do
 *   Login do Facebook para Empresas): troca do código, token longo, `debug_token`
 *   e primeiro candidato do HMAC do webhook. O nome da chave ficou o mesmo;
 *   `meta_app_secret` é de outro app;
 * - `instagram_verify_token`: token do handshake GET do webhook;
 * - `meta_app_secret` (opcional): segundo candidato do HMAC (S6).
 *
 * SEM fallback para variável de ambiente: leitura que falha é `read_failed` e o
 * chamador recusa (503). Uma cópia em env viraria credencial viva durante
 * qualquer soluço de leitura (AGENTS.md §5). Não existe env com esses nomes.
 *
 * Valor não-string ou em branco vira `missing`, nunca `String(...)`: `String({})`
 * é `"[object Object]"` e `String(["x"])` é `"x"`.
 *
 * Cache só do sucesso, por chave, 5 min; `clear()` avança uma geração para que
 * leitura em voo durante a limpeza não repovoe o cache (mesma régua de
 * `datafy-account-config-core.ts`). Este arquivo não toca o runtime (guarda
 * estática em `src/lib/instagram-config-core.test.ts`).
 */

export const INSTAGRAM_SECRET_KEYS = {
  appSecret: "instagram_app_secret",
  verifyToken: "instagram_verify_token",
  metaAppSecret: "meta_app_secret",
} as const;

export type InstagramSecretKey = (typeof INSTAGRAM_SECRET_KEYS)[keyof typeof INSTAGRAM_SECRET_KEYS];

/** Mesmo TTL dos irmãos: troca feita no painel vale em até 5 min. */
export const INSTAGRAM_SECRET_CACHE_TTL_MS = 5 * 60 * 1000;

export type InstagramSecretRead =
  | { ok: true; value: string }
  | { ok: false; reason: "missing" | "read_failed" };

export interface InstagramSecretReader {
  read: (key: InstagramSecretKey) => Promise<InstagramSecretRead>;
  clear: () => void;
}

const KNOWN_KEYS: ReadonlySet<string> = new Set(Object.values(INSTAGRAM_SECRET_KEYS));

/**
 * @param readRow uma leitura de `platform_secrets` pela chave; pode lançar
 *   (rede, cliente sem ambiente) → `read_failed`.
 * @param now relógio do cache local (só decide reuso em memória).
 *
 * Uso no `index.ts` da EF consumidora (D3: a consulta mora lá; uma instância
 * por isolate, no nível do módulo, para o cache valer). `supabase` é o cliente
 * service-role que o próprio `index.ts` já cria:
 *
 * ```ts
 * import { INSTAGRAM_SECRET_KEYS, createInstagramSecretReader } from "../_shared/instagram-config-core.ts";
 * import { platformSecretRowOrThrow } from "../_shared/instagram-config.ts";
 *
 * const igSecrets = createInstagramSecretReader(async (key) =>
 *   platformSecretRowOrThrow(
 *     key,
 *     await supabase.from("platform_secrets").select("value").eq("key", key).maybeSingle(),
 *   )
 * );
 *
 * const appSecret = await igSecrets.read(INSTAGRAM_SECRET_KEYS.appSecret);
 * if (appSecret.ok === false) { // falha fechado: 503, nunca "permitido"
 *   jsonLog("warn", { evt: "instagram_secret_unavailable", reason: appSecret.reason });
 *   return new Response(..., { status: 503 });
 * }
 * ```
 *
 * Exceção de rede/cliente lançada pelo `await` também vira `read_failed`.
 */
export function createInstagramSecretReader(
  readRow: (key: string) => Promise<{ value: string } | null>,
  now: () => number = () => Date.now(),
): InstagramSecretReader {
  const cache = new Map<string, { value: string; fetchedAt: number }>();
  let generation = 0;

  return {
    async read(key: InstagramSecretKey): Promise<InstagramSecretRead> {
      // Este leitor não serve para ler outro segredo da plataforma.
      if (!KNOWN_KEYS.has(key)) return { ok: false, reason: "missing" };

      const hit = cache.get(key);
      if (hit && now() - hit.fetchedAt < INSTAGRAM_SECRET_CACHE_TTL_MS) {
        return { ok: true, value: hit.value };
      }
      cache.delete(key);
      const startedAt = generation;

      let row: { value: unknown } | null;
      try {
        row = await readRow(key);
      } catch {
        return { ok: false, reason: "read_failed" };
      }

      const raw = row === null || row === undefined ? undefined : row.value;
      if (typeof raw !== "string") return { ok: false, reason: "missing" };
      const value = raw.trim();
      if (value.length === 0) return { ok: false, reason: "missing" };

      if (generation === startedAt) cache.set(key, { value, fetchedAt: now() });
      return { ok: true, value };
    },
    clear(): void {
      cache.clear();
      generation += 1;
    },
  };
}
