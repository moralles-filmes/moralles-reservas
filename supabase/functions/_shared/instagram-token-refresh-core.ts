/**
 * Decisão pura da renovação diária do token longo do Instagram (Task 2.5).
 * Sem Deno nem imports remotos: o Vitest importa direto.
 *
 * A Meta só renova token com ≥ 24h e ainda válido; o sistema renova a partir de
 * 30 dias de idade (idade = agora − coalesce(token_refreshed_at, connected_at)).
 * Data ilegível nunca leva a renovar: vira `skip` (o chamador registra).
 */
export const INSTAGRAM_REFRESH_MIN_AGE_MS = 30 * 86_400_000;

export type TokenRefreshDecision = "skip" | "refresh" | "expired";

export function decideTokenRefresh(i: {
  status: string;
  tokenRefreshedAt: string | null;
  connectedAt: string;
  tokenExpiresAt: string | null;
  nowMs: number;
}): TokenRefreshDecision {
  if (i.status !== "connected") return "skip";
  if (!Number.isFinite(i.nowMs)) return "skip";

  if (i.tokenExpiresAt !== null && i.tokenExpiresAt !== undefined) {
    const exp = Date.parse(i.tokenExpiresAt);
    if (!Number.isFinite(exp)) return "skip";
    if (exp <= i.nowMs) return "expired";
  }

  const sinceRaw = i.tokenRefreshedAt ?? i.connectedAt;
  const since = typeof sinceRaw === "string" ? Date.parse(sinceRaw) : Number.NaN;
  if (!Number.isFinite(since)) return "skip";
  return i.nowMs - since >= INSTAGRAM_REFRESH_MIN_AGE_MS ? "refresh" : "skip";
}
