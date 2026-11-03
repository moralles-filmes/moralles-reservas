/**
 * process-instagram-token-refresh — renovação diária do token longo (Task 2.5, C4).
 *
 * Chamado pelo pg_cron 1x ao dia com `x-internal-key`. Varre as contas
 * `connected` (paginado com `.range()`), decide por conta
 * (`_shared/instagram-token-refresh-core.ts`) e:
 * - `expired` → `set_instagram_account_status(id,'reauth_required','expired',connected_at)`,
 *   sem chamar o Graph;
 * - `refresh` → token do cofre → `graph.refresh` → `record_instagram_token_refresh`.
 *   Graph `reauth_required` muda o status; `transient`/`rate_limited`/outros só
 *   logam (o cron tenta de novo amanhã).
 * As duas escritas levam o `connected_at` lido na varredura (CAS, 20261103120800):
 * se o dono reconectou no meio, a RPC devolve `false` sem efeito e a conta conta
 * como `skipped_stale` (a conexão nova não cai para `reauth_required` nem tem o
 * token sobrescrito pelo renovado do antigo).
 * A conta vem SÓ da varredura (nunca do corpo). A falha de uma conta não aborta
 * as demais. Resposta e logs: contagens, ids internos, classe e `code` do
 * Postgres; nunca token nem texto da Meta/Postgres.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jsonLog, requireInternalAuth } from "../_shared/security.ts";
import { createInstagramGraph } from "../_shared/instagram-graph.ts";
import { INSTAGRAM_REFRESH_BUDGET_MS, planTokenRefreshes } from "../_shared/instagram-token-refresh-core.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const supabase = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
const graph = createInstagramGraph((input, init) => fetch(input, init));

const PAGE_SIZE = 500;

type AccountRow = {
  id: string;
  unit_id: string;
  status: string;
  token_refreshed_at: string | null;
  connected_at: string;
  token_expires_at: string | null;
};

function pgCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Todas as contas `connected`, página a página até uma página curta. */
async function loadConnectedAccounts(): Promise<{ ok: true; rows: AccountRow[] } | { ok: false; code?: string }> {
  const rows: AccountRow[] = [];
  for (let from = 0;; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("instagram_accounts")
      .select("id, unit_id, status, token_refreshed_at, connected_at, token_expires_at")
      .eq("status", "connected")
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error || !Array.isArray(data)) return { ok: false, code: pgCode(error) };
    for (const r of data as Partial<AccountRow>[]) {
      if (typeof r.id !== "string" || typeof r.unit_id !== "string" || typeof r.status !== "string") continue;
      rows.push({
        id: r.id,
        unit_id: r.unit_id,
        status: r.status,
        token_refreshed_at: typeof r.token_refreshed_at === "string" ? r.token_refreshed_at : null,
        connected_at: typeof r.connected_at === "string" ? r.connected_at : "",
        token_expires_at: typeof r.token_expires_at === "string" ? r.token_expires_at : null,
      });
    }
    if (data.length < PAGE_SIZE) return { ok: true, rows };
  }
}

/** Desfecho de uma escrita com CAS: aplicou, conexão nova (stale) ou falhou. */
type CasWrite = "applied" | "stale" | "failed";

function casOutcome(evtFailed: string, accountId: string, data: unknown, error: unknown): CasWrite {
  if (error) {
    jsonLog("error", { evt: evtFailed, accountId, code: pgCode(error) });
    return "failed";
  }
  if (data === true) return "applied";
  if (data === false) {
    jsonLog("info", { evt: "instagram_refresh_skipped_stale", accountId });
    return "stale";
  }
  // Fora do contrato (nem true nem false): nunca conta como aplicado.
  jsonLog("error", { evt: evtFailed, accountId, code: "unexpected_result" });
  return "failed";
}

async function setStatus(acc: AccountRow, status: string, errorCode: string): Promise<CasWrite> {
  const { data, error } = await supabase.rpc("set_instagram_account_status", {
    p_account_id: acc.id,
    p_status: status,
    p_error_code: errorCode,
    p_expected_connected_at: acc.connected_at,
  });
  return casOutcome("instagram_refresh_status_failed", acc.id, data, error);
}

function hasBadDate(acc: AccountRow): boolean {
  return Number.isNaN(Date.parse(acc.connected_at)) ||
    (acc.token_refreshed_at !== null && Number.isNaN(Date.parse(acc.token_refreshed_at))) ||
    (acc.token_expires_at !== null && Number.isNaN(Date.parse(acc.token_expires_at)));
}

serve(async (req: Request): Promise<Response> => {
  if (!requireInternalAuth(req)) return json(401, { error: "unauthorized" });

  try {
    const loaded = await loadConnectedAccounts();
    if (loaded.ok === false) {
      jsonLog("error", { evt: "instagram_refresh_scan_failed", code: loaded.code });
      return json(503, { error: "unavailable" });
    }

    const startedAt = Date.now();
    const nowMs = startedAt;
    for (const acc of loaded.rows) {
      if (hasBadDate(acc)) jsonLog("warn", { evt: "instagram_refresh_bad_dates", accountId: acc.id });
    }
    const plan = planTokenRefreshes(loaded.rows, nowMs);
    const counts = { scanned: loaded.rows.length, refreshed: 0, expired: 0, reauth: 0, failed: 0, remaining: 0, skipped_stale: 0 };

    for (let i = 0; i < plan.length; i++) {
      if (Date.now() - startedAt >= INSTAGRAM_REFRESH_BUDGET_MS) {
        counts.remaining = plan.length - i;
        jsonLog("warn", { evt: "instagram_refresh_budget_exhausted", remaining: counts.remaining });
        break;
      }
      const { acc, decision } = plan[i];
      try {
        if (decision === "expired") {
          const out = await setStatus(acc, "reauth_required", "expired");
          if (out === "applied") counts.expired++;
          else if (out === "stale") counts.skipped_stale++;
          else counts.failed++;
          continue;
        }

        const tokenRes = await supabase.rpc("get_instagram_account_token", { p_account_id: acc.id });
        if (tokenRes.error || typeof tokenRes.data !== "string" || tokenRes.data === "") {
          jsonLog("error", { evt: "instagram_refresh_token_read_failed", accountId: acc.id, code: pgCode(tokenRes.error) });
          counts.failed++;
          continue;
        }

        const res = await graph.refresh({ token: tokenRes.data });
        if (res.ok === false) {
          jsonLog("warn", {
            evt: "instagram_refresh_graph_failed",
            accountId: acc.id,
            errorClass: res.errorClass,
            httpStatus: res.httpStatus,
            graphCode: res.code,
          });
          if (res.errorClass === "reauth_required") {
            const out = await setStatus(acc, "reauth_required", String(res.code ?? "reauth_required"));
            if (out === "applied") counts.reauth++;
            else if (out === "stale") counts.skipped_stale++;
            else counts.failed++;
          } else {
            counts.failed++;
          }
          continue;
        }

        const { data: recorded, error } = await supabase.rpc("record_instagram_token_refresh", {
          p_account_id: acc.id,
          p_token: res.value.token,
          p_expires_at: new Date(Date.now() + res.value.expiresInSec * 1000).toISOString(),
          p_expected_connected_at: acc.connected_at,
        });
        const out = casOutcome("instagram_refresh_record_failed", acc.id, recorded, error);
        if (out === "applied") counts.refreshed++;
        else if (out === "stale") counts.skipped_stale++;
        else counts.failed++;
      } catch (err) {
        jsonLog("error", {
          evt: "instagram_refresh_account_unhandled",
          accountId: acc.id,
          errorClass: err instanceof Error ? err.name : typeof err,
        });
        counts.failed++;
      }
    }

    jsonLog("info", { evt: "instagram_refresh_done", ...counts });
    return json(200, counts);
  } catch {
    jsonLog("error", { evt: "instagram_refresh_unhandled" });
    return json(503, { error: "unavailable" });
  }
});
