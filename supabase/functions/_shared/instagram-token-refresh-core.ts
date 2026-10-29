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

/** Teto de tempo da varredura: para de iniciar contas novas (o cron roda de novo amanhã). */
export const INSTAGRAM_REFRESH_BUDGET_MS = 100_000;

/**
 * Ordem de trabalho: só contas cuja decisão não é `skip`; vencidas primeiro,
 * depois as de token mais velho (`coalesce(token_refreshed_at, connected_at)`).
 * Empate desfaz por id para ser determinístico.
 */
export function planTokenRefreshes<T extends {
  id: string;
  status: string;
  token_refreshed_at: string | null;
  connected_at: string;
  token_expires_at: string | null;
}>(rows: T[], nowMs: number): { acc: T; decision: "refresh" | "expired" }[] {
  const planned: { acc: T; decision: "refresh" | "expired"; since: number }[] = [];
  for (const acc of rows) {
    const decision = decideTokenRefresh({
      status: acc.status,
      tokenRefreshedAt: acc.token_refreshed_at,
      connectedAt: acc.connected_at,
      tokenExpiresAt: acc.token_expires_at,
      nowMs,
    });
    if (decision === "skip") continue;
    planned.push({ acc, decision, since: Date.parse(acc.token_refreshed_at ?? acc.connected_at) });
  }
  planned.sort((a, b) => {
    if (a.decision !== b.decision) return a.decision === "expired" ? -1 : 1;
    if (a.since !== b.since) return a.since - b.since;
    return a.acc.id < b.acc.id ? -1 : a.acc.id > b.acc.id ? 1 : 0;
  });
  return planned.map(({ acc, decision }) => ({ acc, decision }));
}
