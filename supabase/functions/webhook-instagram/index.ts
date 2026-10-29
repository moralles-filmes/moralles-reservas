/**
 * webhook-instagram — entrada do Direct do Instagram (Task 2.3, contrato C3).
 *
 * GET:  handshake da Meta (`hub.verify_token` contra `instagram_verify_token`).
 * POST: tamanho (lido com teto) → bytes crus → HMAC (`instagram`, depois `meta`) → só então
 *       `JSON.parse` → contas pelo `entry.id` com a unidade do MESMO select →
 *       gates sem cache (grant ativo E `dm_enabled`; erro de leitura FECHA)
 *       → uma linha por conta elegível em `instagram_inbound_events` (corpo cru
 *       intacto) → ACK 200 → kick best-effort do worker por linha nova.
 *
 * Adapter de I/O: toda decisão mora em `_shared/instagram-webhook-core.ts`.
 * Respostas sem detalhe interno; logs só com evento, motivo e contagens —
 * nunca segredo, corpo ou cabeçalho de assinatura. `verify_jwt = false`
 * (chamado pela Meta). Sem CORS: servidor para servidor.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jsonLog } from "../_shared/security.ts";
import { INSTAGRAM_SECRET_KEYS, createInstagramSecretReader } from "../_shared/instagram-config-core.ts";
import { platformSecretRowOrThrow } from "../_shared/instagram-config.ts";
import {
  INSTAGRAM_SIGNATURE_HEADER,
  INSTAGRAM_WEBHOOK_MAX_BYTES,
  type InstagramAccountRow,
  authenticateInstagramWebhook,
  buildInstagramInboundKick,
  decideVerifyChallenge,
  entryAccountIds,
  rawBodyByteaHex,
  readBodyWithCap,
  selectEligibleInstagramAccounts,
  sha256Hex,
} from "../_shared/instagram-webhook-core.ts";

/**
 * Global do runtime que o compilador não conhece; declarado estreito (mesma
 * nota do `webhook-whatsapp`). Não estende o wall clock: o kick é otimista e
 * a varredura (`instagram-inbound-sweep`, a cada minuto) é a rede (R2-b).
 */
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const INTERNAL_API_KEY = Deno.env.get("INTERNAL_API_KEY") ?? "";

const supabase = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

// Um leitor por isolate (o cache de 5 min só do sucesso vale entre pedidos).
// Sem fallback para `Deno.env`: leitura que falha é `read_failed` → 503.
const igSecrets = createInstagramSecretReader(async (key) =>
  platformSecretRowOrThrow(
    key,
    await supabase.from("platform_secrets").select("value").eq("key", key).maybeSingle(),
  )
);

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

const UNAVAILABLE = () => json(503, { error: "Serviço indisponível, tente novamente." });

async function handleVerify(req: Request): Promise<Response> {
  const token = await igSecrets.read(INSTAGRAM_SECRET_KEYS.verifyToken);
  if (token.ok === false && token.reason === "read_failed") {
    jsonLog("warn", { evt: "instagram_webhook_verify_unavailable", reason: token.reason });
    return UNAVAILABLE();
  }
  const expected = token.ok === true ? token.value : "";
  const decision = decideVerifyChallenge(new URL(req.url).searchParams, expected);
  if (decision.status === 200) {
    jsonLog("info", { evt: "instagram_webhook_verified" });
    return new Response(decision.body, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  jsonLog("warn", { evt: "instagram_webhook_verify_refused", reason: token.ok === true ? "mismatch" : "missing" });
  return json(403, { error: "Verificação recusada." });
}

function kick(eventId: string): void {
  if (!SUPABASE_URL || !INTERNAL_API_KEY) {
    jsonLog("warn", { evt: "instagram_inbound_kick_skipped", reason: "missing_env" });
    return;
  }
  const { url, init } = buildInstagramInboundKick(SUPABASE_URL, INTERNAL_API_KEY, eventId);
  try {
    EdgeRuntime.waitUntil(
      fetch(url, init).then(
        async (res) => {
          // Descarta o corpo sem lê-lo para log.
          await res.body?.cancel().catch(() => undefined);
          jsonLog(res.ok ? "info" : "warn", { evt: "instagram_inbound_kick", status: res.status });
        },
        () => {
          jsonLog("warn", { evt: "instagram_inbound_kick_failed" });
        },
      ),
    );
  } catch {
    jsonLog("warn", { evt: "instagram_inbound_kick_failed", reason: "wait_until" });
  }
}

async function handleEvent(req: Request): Promise<Response> {
  // 1. Tamanho: o declarado (se houver) e o lido de fato.
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > INSTAGRAM_WEBHOOK_MAX_BYTES) {
    jsonLog("warn", { evt: "instagram_webhook_too_large" });
    return json(413, { error: "Corpo grande demais." });
  }
  // Leitura com teto: sem Content-Length (chunked), para assim que passa do
  // limite em vez de carregar o corpo inteiro antes de checar.
  const read = await readBodyWithCap(req.body, INSTAGRAM_WEBHOOK_MAX_BYTES);
  if (read.ok === false) {
    jsonLog("warn", { evt: "instagram_webhook_too_large" });
    return json(413, { error: "Corpo grande demais." });
  }
  const raw = read.bytes;

  // 2. Assinatura sobre os bytes, antes de qualquer parse.
  const auth = await authenticateInstagramWebhook(
    raw,
    req.headers.get(INSTAGRAM_SIGNATURE_HEADER),
    (key) => igSecrets.read(key),
  );
  if (auth.ok === false) {
    if (auth.reason === "read_failed" || auth.reason === "no_secret") {
      jsonLog("error", { evt: "instagram_webhook_secret_unavailable", reason: auth.reason });
      return UNAVAILABLE();
    }
    jsonLog("warn", { evt: "instagram_webhook_unauthorized", reason: auth.reason });
    return json(401, { error: "Assinatura inválida." });
  }
  const matched = auth.matched;
  jsonLog("info", { evt: "instagram_webhook_authenticated", matched });

  // 3. Parse só depois da assinatura. A Meta assinou: reentregar não ajuda.
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    jsonLog("warn", { evt: "instagram_webhook_unparseable" });
    return json(200, { ok: true });
  }
  const ids = entryAccountIds(body);
  if (ids === null) {
    jsonLog("info", { evt: "instagram_webhook_ignored", reason: "object_not_instagram" });
    return json(200, { ok: true });
  }
  if (ids.length === 0) {
    jsonLog("info", { evt: "instagram_webhook_ignored", reason: "no_entries" });
    return json(200, { ok: true });
  }

  // 4. Contas e unidade do MESMO select (C3); nunca do payload.
  const { data: accountRows, error: accountsError } = await supabase
    .from("instagram_accounts")
    .select("id, unit_id, ig_user_id")
    .in("ig_user_id", ids)
    .eq("status", "connected");
  if (accountsError) {
    jsonLog("error", { evt: "instagram_webhook_gate_unavailable", reason: "accounts_read_failed" });
    return UNAVAILABLE();
  }
  const accounts = ((accountRows ?? []) as InstagramAccountRow[]).filter((a) =>
    typeof a?.id === "string" && typeof a?.unit_id === "string" && typeof a?.ig_user_id === "string"
  );

  // 5. Gates sem cache; erro de leitura fecha (503).
  const unitIds = [...new Set(accounts.map((a) => a.unit_id))];
  const activeGrantUnitIds = new Set<string>();
  const dmEnabledUnitIds = new Set<string>();
  if (unitIds.length > 0) {
    const { data: grants, error: grantsError } = await supabase
      .from("unit_module_grants")
      .select("unit_id")
      .in("unit_id", unitIds)
      .eq("module", "instagram")
      .is("revoked_at", null);
    if (grantsError) {
      jsonLog("error", { evt: "instagram_webhook_gate_unavailable", reason: "grants_read_failed" });
      return UNAVAILABLE();
    }
    for (const g of (grants ?? []) as Array<{ unit_id: unknown }>) {
      if (typeof g?.unit_id === "string") activeGrantUnitIds.add(g.unit_id);
    }

    const { data: settings, error: settingsError } = await supabase
      .from("instagram_settings")
      .select("unit_id, dm_enabled")
      .in("unit_id", unitIds);
    if (settingsError) {
      jsonLog("error", { evt: "instagram_webhook_gate_unavailable", reason: "settings_read_failed" });
      return UNAVAILABLE();
    }
    for (const s of (settings ?? []) as Array<{ unit_id: unknown; dm_enabled: unknown }>) {
      if (typeof s?.unit_id === "string" && s.dm_enabled === true) dmEnabledUnitIds.add(s.unit_id);
    }
  }

  const { eligible, discarded } = selectEligibleInstagramAccounts({
    entryIds: ids,
    accounts,
    activeGrantUnitIds,
    dmEnabledUnitIds,
  });
  if (discarded.unknown_account + discarded.no_grant + discarded.dm_disabled > 0) {
    jsonLog("info", { evt: "instagram_webhook_discarded", ...discarded });
  }
  if (eligible.length === 0) return json(200, { ok: true });

  // 6. Fila antes do ACK: as cinco colunas; 23505 é duplicata (sucesso).
  const rawHex = rawBodyByteaHex(raw);
  const bodySha = await sha256Hex(raw);
  const newIds: string[] = [];
  let duplicates = 0;
  for (const account of eligible) {
    const { data, error } = await supabase
      .from("instagram_inbound_events")
      .insert({
        instagram_account_id: account.id,
        unit_id: account.unit_id,
        raw_body: rawHex,
        body_sha256: bodySha,
        signature_secret: matched,
      })
      .select("id")
      .maybeSingle();
    if (error && (error as { code?: unknown }).code === "23505") {
      duplicates += 1;
      continue;
    }
    const newId = (data as { id?: unknown } | null)?.id;
    if (error || typeof newId !== "string") {
      const code = (error as { code?: unknown } | null)?.code;
      jsonLog("error", {
        evt: "instagram_webhook_enqueue_failed",
        code: typeof code === "string" ? code : undefined,
      });
      return UNAVAILABLE();
    }
    newIds.push(newId);
  }
  jsonLog("info", { evt: "instagram_webhook_enqueued", inserted: newIds.length, duplicates });

  // 7. ACK, e o kick por linha nova (best-effort; a varredura é a rede).
  for (const eventId of newIds) kick(eventId);
  return json(200, { ok: true });
}

serve(async (req: Request): Promise<Response> => {
  try {
    if (req.method === "GET") return await handleVerify(req);
    if (req.method === "POST") return await handleEvent(req);
    return json(405, { error: "Método não permitido." });
  } catch {
    // Exceção inesperada antes do ACK: 503 para a Meta reentregar.
    jsonLog("error", { evt: "instagram_webhook_unhandled" });
    return UNAVAILABLE();
  }
});
