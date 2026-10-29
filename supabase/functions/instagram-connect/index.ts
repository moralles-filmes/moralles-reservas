/**
 * instagram-connect — conexão da conta pelo Instagram Login (Task 2.4, C1/C2/C6).
 *
 * POST { action, unit_id?, code?, state? }, chamado pelo painel autenticado
 * (`verify_jwt = true` + `getUser()` aqui). Ações:
 * - `start { unit_id }` → `{ authorize_url, state }` (o painel guarda e compara o state) com `state` assinado de 10 min,
 *   preso a usuário + unidade (`_shared/instagram-oauth-state.ts`).
 * - `callback { code, state }` → `{ unit_slug, username, subscribed }`. O
 *   `state` é conferido ANTES de qualquer Graph; `state.userId` tem de ser o
 *   usuário da sessão; a unidade vem SÓ do `state` (o `unit_id` do corpo é
 *   ignorado); papel e grant são reconferidos. Sequência: troca do código →
 *   token longo → `me` (Business/Media_Creator) → `store_…` → `subscribe` →
 *   `record_…`. Falha na assinatura responde 200 com `subscribed:false`.
 * - `status { unit_id }` → `{ account }`, pela RPC chamada com o JWT do
 *   usuário (C6; com service role `auth.uid()` é nulo e a RPC recusa).
 * - `disconnect { unit_id }` → `disconnect_instagram_account` da conta ativa da
 *   unidade (o SQL reconfere o papel na unidade DA CONTA). Sem conta ativa: 200
 *   idempotente `{ disconnected: true }` (duplo clique não vira erro).
 * - `resubscribe { unit_id }` → `subscribe` + `record_…` com o token do cofre.
 *
 * Acesso (`_shared/instagram-access-core.ts`): owner/gerente da unidade ou
 * platform_admin; operador e não membro sempre 403 com o mesmo corpo; grant
 * ativo em start/callback/resubscribe. Papel e admin são lidos aqui (e não por
 * `hasUnitAccess`) porque a ação depende do papel e porque erro de leitura de
 * qualquer gate tem de virar 503 (fail closed), nunca "permitido" nem 403.
 *
 * Nenhum token, segredo, texto da Meta ou mensagem do Postgres sai em resposta
 * ou log: logs só com `evt`, `action`, `errorClass`/`httpStatus`/`code`.
 * `Deno.env` só aqui (`APP_BASE_URL`, `INSTAGRAM_APP_ID`,
 * `INSTAGRAM_OAUTH_STATE_SECRET`); o segredo do app vem de `platform_secrets`,
 * sem fallback de env.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeadersFor } from "../_shared/cors.ts";
import { jsonLog } from "../_shared/security.ts";
import { INSTAGRAM_SECRET_KEYS, createInstagramSecretReader } from "../_shared/instagram-config-core.ts";
import { platformSecretRowOrThrow } from "../_shared/instagram-config.ts";
import { readBodyWithCap } from "../_shared/instagram-webhook-core.ts";
import { INSTAGRAM_SUBSCRIBED_FIELDS, buildAuthorizeUrl } from "../_shared/instagram-graph-core.ts";
import { createInstagramGraph } from "../_shared/instagram-graph.ts";
import { INSTAGRAM_STATE_TTL_MS, signInstagramState, verifyInstagramState } from "../_shared/instagram-oauth-state.ts";
import {
  type InstagramConnectAction,
  decideInstagramAccess,
  instagramActionRequiresGrant,
  isSecretMismatchError,
  isInstagramConnectAction,
} from "../_shared/instagram-access-core.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const APP_BASE_URL = (Deno.env.get("APP_BASE_URL") ?? "https://reservas.moralles.com.br").replace(/\/+$/, "");
const INSTAGRAM_APP_ID = Deno.env.get("INSTAGRAM_APP_ID") ?? "";
const STATE_SECRET = Deno.env.get("INSTAGRAM_OAUTH_STATE_SECRET") ?? "";
const REDIRECT_URI = `${APP_BASE_URL}/instagram/callback`;

const supabase = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

// Um leitor por isolate (cache de 5 min só do sucesso). Sem fallback de env.
const igSecrets = createInstagramSecretReader(async (key) =>
  platformSecretRowOrThrow(
    key,
    await supabase.from("platform_secrets").select("value").eq("key", key).maybeSingle(),
  )
);

const graph = createInstagramGraph((input, init) => fetch(input, init));

const MAX_BODY_BYTES = 16_384;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROFESSIONAL_TYPES = new Set(["Business", "Media_Creator"]);

const MSG = {
  unauthenticated: "Sessão inválida. Entre de novo.",
  forbidden: "Sem permissão para gerenciar o Instagram desta unidade.",
  noGrant: "O módulo Instagram não está liberado para esta unidade.",
  badState: "Link de conexão inválido ou expirado. Comece a conexão de novo.",
  unavailable: "Serviço indisponível, tente novamente.",
  graph: "Não foi possível concluir a conexão com o Instagram. Tente de novo.",
  notProfessional: "A conta precisa ser Profissional",
  inUse: "Esta conta do Instagram já está conectada a outra unidade",
  noAccount: "Nenhuma conta do Instagram conectada nesta unidade.",
  reauth: "A conta do Instagram precisa ser reconectada.",
  tooLarge: "Requisição grande demais.",
  connectLater: "Não foi possível concluir a conexão agora.",
  subscribe: "Não foi possível assinar as mensagens do Instagram. Tente de novo.",
} as const;

type Ctx = { req: Request; userId: string; authHeader: string; action: InstagramConnectAction };

function json(req: Request, status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeadersFor(req), "content-type": "application/json; charset=utf-8" },
  });
}

/** Só o `code` do erro do PostgREST/Postgres, quando é string. Nunca a mensagem. */
function pgCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

type Access = { ok: true } | { ok: false; status: 403 | 503; body: Record<string, unknown> };

/**
 * Papel + platform_admin + (quando a ação exige) grant ativo, todos pelo
 * service client filtrando usuário e unidade. Erro de leitura → 503.
 */
async function checkAccess(ctx: Ctx, unitId: string): Promise<Access> {
  const [member, admin] = await Promise.all([
    supabase.from("unit_members").select("role").eq("user_id", ctx.userId).eq("unit_id", unitId).maybeSingle(),
    supabase.from("platform_admins").select("user_id").eq("user_id", ctx.userId).maybeSingle(),
  ]);
  if (member.error || admin.error) {
    jsonLog("error", {
      evt: "instagram_connect_gate_unavailable",
      action: ctx.action,
      reason: member.error ? "member_read_failed" : "admin_read_failed",
      code: pgCode(member.error ?? admin.error),
    });
    return { ok: false, status: 503, body: { error: MSG.unavailable } };
  }
  const rawRole = (member.data as { role?: unknown } | null)?.role;
  const role = rawRole === "owner" || rawRole === "gerente" || rawRole === "operador" ? rawRole : null;
  const isPlatformAdmin = Boolean(admin.data);

  let grantActive = false;
  if (instagramActionRequiresGrant(ctx.action) && (isPlatformAdmin || role === "owner" || role === "gerente")) {
    const grant = await supabase
      .from("unit_module_grants")
      .select("id")
      .eq("unit_id", unitId)
      .eq("module", "instagram")
      .is("revoked_at", null)
      .maybeSingle();
    if (grant.error) {
      jsonLog("error", {
        evt: "instagram_connect_gate_unavailable",
        action: ctx.action,
        reason: "grant_read_failed",
        code: pgCode(grant.error),
      });
      return { ok: false, status: 503, body: { error: MSG.unavailable } };
    }
    grantActive = Boolean(grant.data);
  }

  const decision = decideInstagramAccess({ action: ctx.action, isPlatformAdmin, role, grantActive });
  if (decision === "allow") return { ok: true };
  jsonLog("warn", { evt: "instagram_connect_denied", action: ctx.action, reason: decision });
  return decision === "deny_grant"
    ? { ok: false, status: 403, body: { error: MSG.noGrant } }
    : { ok: false, status: 403, body: { error: MSG.forbidden } };
}

type ActiveAccount = { id: string; ig_user_id: string; status: string };

/** Conta não desconectada da unidade (no máximo uma, índice único parcial). */
async function activeAccountOf(unitId: string, action: InstagramConnectAction): Promise<{ ok: true; account: ActiveAccount | null } | { ok: false }> {
  const { data, error } = await supabase
    .from("instagram_accounts")
    .select("id, ig_user_id, status")
    .eq("unit_id", unitId)
    .neq("status", "disconnected")
    .maybeSingle();
  if (error) {
    jsonLog("error", { evt: "instagram_connect_account_read_failed", action, code: pgCode(error) });
    return { ok: false };
  }
  const row = data as { id?: unknown; ig_user_id?: unknown; status?: unknown } | null;
  if (!row) return { ok: true, account: null };
  if (typeof row.id !== "string" || typeof row.ig_user_id !== "string" || typeof row.status !== "string") {
    return { ok: false };
  }
  return { ok: true, account: { id: row.id, ig_user_id: row.ig_user_id, status: row.status } };
}

/** `subscribe` + `record_…`; `true` só quando os dois deram certo. */
async function subscribeAndRecord(ctx: Ctx, accountId: string, igUserId: string, token: string): Promise<
  { ok: true } | { ok: false; stage: "graph" | "record" }
> {
  const sub = await graph.subscribe({ igUserId, token });
  if (sub.ok === false) {
    jsonLog("warn", {
      evt: "instagram_connect_subscribe_failed",
      action: ctx.action,
      errorClass: sub.errorClass,
      httpStatus: sub.httpStatus,
      graphCode: sub.code,
    });
    return { ok: false, stage: "graph" };
  }
  const { error } = await supabase.rpc("record_instagram_account_subscription", {
    p_account_id: accountId,
    p_fields: [...INSTAGRAM_SUBSCRIBED_FIELDS],
  });
  if (error) {
    jsonLog("error", { evt: "instagram_connect_record_subscription_failed", action: ctx.action, code: pgCode(error) });
    return { ok: false, stage: "record" };
  }
  return { ok: true };
}

async function handleStart(ctx: Ctx, unitId: string): Promise<Response> {
  const access = await checkAccess(ctx, unitId);
  if (access.ok === false) return json(ctx.req, access.status, access.body);
  if (!INSTAGRAM_APP_ID) {
    jsonLog("error", { evt: "instagram_connect_misconfigured", action: ctx.action, reason: "app_id_missing" });
    return json(ctx.req, 503, { error: MSG.unavailable });
  }
  let state: string;
  try {
    state = await signInstagramState(
      { unitId, userId: ctx.userId, exp: Date.now() + INSTAGRAM_STATE_TTL_MS, nonce: crypto.randomUUID() },
      STATE_SECRET,
    );
  } catch {
    jsonLog("error", { evt: "instagram_connect_misconfigured", action: ctx.action, reason: "state_secret_unusable" });
    return json(ctx.req, 503, { error: MSG.unavailable });
  }
  jsonLog("info", { evt: "instagram_connect_started", action: ctx.action });
  return json(ctx.req, 200, {
    authorize_url: buildAuthorizeUrl({ appId: INSTAGRAM_APP_ID, redirectUri: REDIRECT_URI, state }),
    state,
  });
}

async function handleCallback(ctx: Ctx, body: Record<string, unknown>): Promise<Response> {
  if (!STATE_SECRET) {
    jsonLog("error", { evt: "instagram_connect_misconfigured", action: ctx.action, reason: "state_secret_missing" });
    return json(ctx.req, 503, { error: MSG.unavailable });
  }
  // 1. state antes de tudo: assinatura, validade e dono.
  const verified = await verifyInstagramState(
    typeof body.state === "string" ? body.state : "",
    STATE_SECRET,
    Date.now(),
  );
  if (verified.ok === false) {
    jsonLog("warn", { evt: "instagram_connect_state_refused", action: ctx.action, reason: verified.reason });
    return json(ctx.req, 403, { error: MSG.badState });
  }
  if (verified.payload.userId !== ctx.userId) {
    jsonLog("warn", { evt: "instagram_connect_state_refused", action: ctx.action, reason: "user_mismatch" });
    return json(ctx.req, 403, { error: MSG.badState });
  }
  // A unidade vem SÓ do state; `body.unit_id` é ignorado de propósito.
  const unitId = verified.payload.unitId;

  // 2. Papel e grant reconferidos agora.
  const access = await checkAccess(ctx, unitId);
  if (access.ok === false) return json(ctx.req, access.status, access.body);

  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (code === "") return json(ctx.req, 400, { error: "Código de autorização ausente." });

  if (!INSTAGRAM_APP_ID) {
    jsonLog("error", { evt: "instagram_connect_misconfigured", action: ctx.action, reason: "app_id_missing" });
    return json(ctx.req, 503, { error: MSG.unavailable });
  }
  const appSecret = await igSecrets.read(INSTAGRAM_SECRET_KEYS.appSecret);
  if (appSecret.ok === false) {
    jsonLog("error", { evt: "instagram_secret_unavailable", action: ctx.action, reason: appSecret.reason });
    return json(ctx.req, 503, { error: MSG.unavailable });
  }
  // Slug antes de consumir o código (uso único): se não der para responder, não troca.
  const unit = await supabase.from("units").select("slug").eq("id", unitId).maybeSingle();
  const unitSlug = (unit.data as { slug?: unknown } | null)?.slug;
  if (unit.error || typeof unitSlug !== "string") {
    jsonLog("error", { evt: "instagram_connect_unit_read_failed", action: ctx.action, code: pgCode(unit.error) });
    return json(ctx.req, 503, { error: MSG.unavailable });
  }

  const graphFail = (step: string, r: { errorClass: string; httpStatus: number | null; code: number | null }) => {
    jsonLog("warn", {
      evt: "instagram_connect_graph_failed",
      action: ctx.action,
      step,
      errorClass: r.errorClass,
      httpStatus: r.httpStatus,
      graphCode: r.code,
    });
    return json(ctx.req, 502, { error: MSG.graph });
  };

  // 3. Troca do código (o adapter tira o sufixo `#_`) e token longo.
  const exchanged = await graph.exchangeCode({
    appId: INSTAGRAM_APP_ID,
    appSecret: appSecret.value,
    redirectUri: REDIRECT_URI,
    code,
  });
  if (exchanged.ok === false) return graphFail("exchange_code", exchanged);
  const long = await graph.toLongLived({ appSecret: appSecret.value, shortToken: exchanged.value.shortToken });
  if (long.ok === false) return graphFail("long_lived", long);
  const token = long.value.token;

  // 4. Identidade e tipo de conta.
  const me = await graph.me({ token });
  if (me.ok === false) return graphFail("me", me);
  if (me.value.accountType === null || !PROFESSIONAL_TYPES.has(me.value.accountType)) {
    jsonLog("warn", { evt: "instagram_connect_not_professional", action: ctx.action });
    return json(ctx.req, 422, { error: MSG.notProfessional });
  }

  // 5. Gravação (o SQL reconfere papel + grant e prende o ator).
  const stored = await supabase.rpc("store_instagram_account_connection", {
    p_unit_id: unitId,
    p_ig_user_id: me.value.igUserId,
    p_username: me.value.username,
    p_account_type: me.value.accountType,
    p_token: token,
    p_expires_at: new Date(Date.now() + long.value.expiresInSec * 1000).toISOString(),
    p_actor: ctx.userId,
  });
  if (stored.error || typeof stored.data !== "string") {
    const pg = pgCode(stored.error);
    jsonLog("error", { evt: "instagram_connect_store_failed", action: ctx.action, code: pg });
    if (pg === "P0001") return json(ctx.req, 409, { error: MSG.inUse });
    if (pg === "42501") {
      if (isSecretMismatchError(stored.error)) return json(ctx.req, 503, { error: MSG.connectLater });
      return json(ctx.req, 403, { error: MSG.forbidden });
    }
    if (pg === "22023") return json(ctx.req, 502, { error: MSG.graph });
    return json(ctx.req, 503, { error: MSG.unavailable });
  }
  const accountId = stored.data;

  // 6–7. Assinatura do webhook; falha não desfaz a conexão (a tela oferece "Assinar de novo").
  const sub = await subscribeAndRecord(ctx, accountId, me.value.igUserId, token);
  jsonLog("info", { evt: "instagram_connect_connected", action: ctx.action, subscribed: sub.ok });
  return json(ctx.req, 200, { unit_slug: unitSlug, username: me.value.username, subscribed: sub.ok });
}

async function handleStatus(ctx: Ctx, unitId: string): Promise<Response> {
  const access = await checkAccess(ctx, unitId);
  if (access.ok === false) return json(ctx.req, access.status, access.body);
  // C6: com o JWT do usuário; a RPC confere `auth.uid()`.
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: ctx.authHeader } },
  });
  const { data, error } = await userClient.rpc("get_instagram_account_status", { p_unit_id: unitId });
  if (error) {
    const pg = pgCode(error);
    jsonLog(pg === "42501" ? "warn" : "error", { evt: "instagram_connect_status_failed", action: ctx.action, code: pg });
    return pg === "42501" ? json(ctx.req, 403, { error: MSG.forbidden }) : json(ctx.req, 503, { error: MSG.unavailable });
  }
  const row = (Array.isArray(data) ? data[0] : null) as Record<string, unknown> | null | undefined;
  return json(ctx.req, 200, {
    account: row
      ? {
        username: row.username ?? null,
        status: row.status ?? null,
        token_expires_at: row.token_expires_at ?? null,
        connected_at: row.connected_at ?? null,
        subscribed: row.subscribed === true,
        last_error_code: row.last_error_code ?? null,
      }
      : null,
  });
}

async function handleDisconnect(ctx: Ctx, unitId: string): Promise<Response> {
  const access = await checkAccess(ctx, unitId);
  if (access.ok === false) return json(ctx.req, access.status, access.body);
  const found = await activeAccountOf(unitId, ctx.action);
  if (found.ok === false) return json(ctx.req, 503, { error: MSG.unavailable });
  if (found.account === null) return json(ctx.req, 200, { disconnected: true });

  const { error } = await supabase.rpc("disconnect_instagram_account", {
    p_account_id: found.account.id,
    p_actor: ctx.userId,
  });
  if (error) {
    const pg = pgCode(error);
    jsonLog(pg === "42501" ? "warn" : "error", { evt: "instagram_connect_disconnect_failed", action: ctx.action, code: pg });
    return pg === "42501" ? json(ctx.req, 403, { error: MSG.forbidden }) : json(ctx.req, 503, { error: MSG.unavailable });
  }
  jsonLog("info", { evt: "instagram_connect_disconnected", action: ctx.action });
  return json(ctx.req, 200, { disconnected: true });
}

async function handleResubscribe(ctx: Ctx, unitId: string): Promise<Response> {
  const access = await checkAccess(ctx, unitId);
  if (access.ok === false) return json(ctx.req, access.status, access.body);
  const found = await activeAccountOf(unitId, ctx.action);
  if (found.ok === false) return json(ctx.req, 503, { error: MSG.unavailable });
  if (found.account === null) return json(ctx.req, 404, { error: MSG.noAccount });
  if (found.account.status !== "connected") return json(ctx.req, 409, { error: MSG.reauth });

  const tokenRes = await supabase.rpc("get_instagram_account_token", { p_account_id: found.account.id });
  if (tokenRes.error || typeof tokenRes.data !== "string" || tokenRes.data === "") {
    jsonLog("error", { evt: "instagram_connect_token_read_failed", action: ctx.action, code: pgCode(tokenRes.error) });
    return json(ctx.req, 503, { error: MSG.unavailable });
  }
  const sub = await subscribeAndRecord(ctx, found.account.id, found.account.ig_user_id, tokenRes.data);
  if (sub.ok === false) {
    return sub.stage === "graph"
      ? json(ctx.req, 502, { error: MSG.subscribe, subscribed: false })
      : json(ctx.req, 503, { error: MSG.unavailable, subscribed: false });
  }
  jsonLog("info", { evt: "instagram_connect_resubscribed", action: ctx.action });
  return json(ctx.req, 200, { subscribed: true });
}

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeadersFor(req) });
  if (req.method !== "POST") return json(req, 405, { error: "Método não permitido." });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!/^Bearer\s+\S+/i.test(authHeader)) return json(req, 401, { error: MSG.unauthenticated });
    const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userError } = await authClient.auth.getUser();
    const userId = userData?.user?.id;
    if (userError || typeof userId !== "string" || userId === "") {
      return json(req, 401, { error: MSG.unauthenticated });
    }

    let body: Record<string, unknown>;
    try {
      const read = await readBodyWithCap(req.body, MAX_BODY_BYTES);
      if (read.ok === false) {
        return read.reason === "too_large"
          ? json(req, 413, { error: MSG.tooLarge })
          : json(req, 400, { error: "Requisição inválida." });
      }
      const parsed: unknown = JSON.parse(new TextDecoder().decode(read.bytes));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not_object");
      body = parsed as Record<string, unknown>;
    } catch {
      return json(req, 400, { error: "Requisição inválida." });
    }
    if (!isInstagramConnectAction(body.action)) return json(req, 400, { error: "Ação inválida." });
    const ctx: Ctx = { req, userId, authHeader, action: body.action };

    if (ctx.action === "callback") return await handleCallback(ctx, body);

    const unitId = typeof body.unit_id === "string" && UUID_RE.test(body.unit_id) ? body.unit_id : null;
    if (unitId === null) return json(req, 400, { error: "unit_id inválido." });
    if (ctx.action === "start") return await handleStart(ctx, unitId);
    if (ctx.action === "status") return await handleStatus(ctx, unitId);
    if (ctx.action === "disconnect") return await handleDisconnect(ctx, unitId);
    return await handleResubscribe(ctx, unitId);
  } catch (err) {
    jsonLog("error", { evt: "instagram_connect_unhandled", errorClass: err instanceof Error ? err.name : typeof err });
    return json(req, 503, { error: MSG.unavailable });
  }
});
