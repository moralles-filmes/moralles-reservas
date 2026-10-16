// Decisão do laço de desvinculação que antecede o DELETE de um canal WhatsApp.
//
// `webhook_executions` e `notifications_sent` referenciam o canal com
// `on delete set null`. Num DELETE direto, o Postgres reescreve TODAS essas
// linhas num único comando — e o PostgREST corta em 8 s (statement_timeout do
// `authenticator`), mesmo com service role. A RPC
// `detach_whatsapp_channel_references` faz o mesmo `set null` em lotes curtos;
// este núcleo decide quando parar.
//
// Mora em `_shared/` (e não no index.ts de manage-channels) porque o vitest não
// importa aquela EF — regra escrita lá só se confere por leitura.

/** Linhas por chamada: cada lote tem de caber com folga nos 8 s do PostgREST. */
export const CHANNEL_DETACH_BATCH_SIZE = 2000;

/** Segunda trava, por contagem (400 mil linhas). A primeira é o prazo de parede. */
export const CHANNEL_DETACH_MAX_BATCHES = 200;

/**
 * Prazo de parede do laço. Fica bem abaixo do limite da Edge Function (~150 s)
 * para que a resposta seja o 503 amigável, e não um corte do gateway sem corpo.
 * Um lote isolado pode levar até 8 s, então o prazo é checado ANTES de cada um.
 */
export const CHANNEL_DETACH_DEADLINE_MS = 90_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ids do corpo da requisição: só string com forma de UUID chega à RPC (senão 22P02 viraria 500). */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export type ChannelDetachResult =
  | { ok: true; detached: number; batches: number }
  | { ok: false; reason: "rpc_error" | "invalid_count" | "budget_exhausted"; detached: number; batches: number; error?: unknown };

/**
 * Chama `detachBatch(limit)` até ela devolver 0. Só o lote VAZIO prova o fim:
 * um lote curto pode vir de linhas apagadas por outro processo (a purga diária)
 * entre o SELECT e o UPDATE da RPC, com referências ainda restando.
 *
 * Falha FECHADO: erro da RPC ou contagem inválida param o laço e o caller NÃO
 * deve apagar o canal — sem a desvinculação, o DELETE voltaria a estourar.
 * Esgotar prazo ou teto também não apaga: o progresso já feito persiste, e
 * repetir a remoção continua de onde parou.
 */
export async function detachChannelReferences(
  detachBatch: (limit: number) => Promise<unknown>,
  opts: { batchSize?: number; maxBatches?: number; deadlineMs?: number; now?: () => number } = {},
): Promise<ChannelDetachResult> {
  const batchSize = opts.batchSize ?? CHANNEL_DETACH_BATCH_SIZE;
  const maxBatches = opts.maxBatches ?? CHANNEL_DETACH_MAX_BATCHES;
  const deadlineMs = opts.deadlineMs ?? CHANNEL_DETACH_DEADLINE_MS;
  const now = opts.now ?? Date.now;
  const startedAt = now();
  let detached = 0;
  let batches = 0;

  while (batches < maxBatches && now() - startedAt < deadlineMs) {
    let count: unknown;
    try {
      count = await detachBatch(batchSize);
    } catch (error) {
      return { ok: false, reason: "rpc_error", detached, batches, error };
    }
    batches += 1;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > batchSize) {
      return { ok: false, reason: "invalid_count", detached, batches };
    }
    if (count === 0) return { ok: true, detached, batches };
    detached += count;
  }

  return { ok: false, reason: "budget_exhausted", detached, batches };
}
