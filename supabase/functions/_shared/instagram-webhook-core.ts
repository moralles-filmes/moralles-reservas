/**
 * Núcleo puro do `webhook-instagram` (Task 2.3, contrato C3).
 *
 * Toda decisão do webhook mora aqui, e não no `index.ts` (o vitest não importa
 * a EF): assinatura sobre os bytes crus, handshake GET, ids das contas do lote,
 * elegibilidade por grant/Direct e o pedido do "kick" pós-ACK. Sem `Deno`, sem
 * cliente Supabase; `crypto.subtle` é o global padrão (Deno, Node ≥ 20).
 *
 * Ordem do POST (no `index.ts`): tamanho → bytes → assinatura → só então
 * `JSON.parse` → contas pelo `ig_user_id` (unidade do MESMO select) → gates sem
 * cache → INSERT na fila → ACK → kick best-effort (R2-b; a varredura é a rede).
 */

/** 2 MiB. Acima disso, 413 antes de qualquer leitura de segredo. */
export const INSTAGRAM_WEBHOOK_MAX_BYTES = 2_097_152;

/** Cabeçalho da Meta; `Headers.get` não diferencia caixa. */
export const INSTAGRAM_SIGNATURE_HEADER = "x-hub-signature-256";

/**
 * Lê o corpo contando bytes e para ASSIM QUE passa de `max` (cancela o
 * stream e devolve `too_large`): sem Content-Length (chunked) o corpo inteiro
 * nunca chega à memória antes da checagem, num endpoint ainda não autenticado.
 * `null` (sem corpo) vira bytes vazios. Só a API padrão de `ReadableStream`.
 */
export async function readBodyWithCap(
  stream: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; reason: "too_large" }> {
  if (stream === null) return { ok: true, bytes: new Uint8Array(0) };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, reason: "too_large" };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

export type InstagramSignatureCandidateName = "instagram" | "meta";

export type InstagramSignatureResult =
  | { ok: true; matched: InstagramSignatureCandidateName }
  | { ok: false; reason: "missing_header" | "malformed_header" | "no_secret" | "mismatch" };

const SIGNATURE_PREFIX = "sha256=";
const HEX_64 = /^[0-9a-f]{64}$/;

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/** Comparação em tempo constante para o mesmo comprimento. */
function constantTimeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Strings: compara os bytes UTF-8; comprimento diferente já é diferente. */
function constantTimeEqualStrings(a: string, b: string): boolean {
  const enc = new TextEncoder();
  return constantTimeEqualBytes(enc.encode(a), enc.encode(b));
}

async function hmacSha256(secret: string, raw: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new Uint8Array(raw)));
}

/**
 * HMAC-SHA256 sobre os BYTES crus do corpo, candidatos na ordem recebida
 * (`instagram`, depois `meta`). Sem candidato utilizável é `no_secret` antes de
 * olhar o cabeçalho: configuração ausente é 503 (a Meta reentrega), não 401.
 * Nunca aceita corpo sem assinatura.
 */
export async function verifyInstagramSignature(
  raw: Uint8Array,
  header: string | null,
  candidates: Array<{ name: InstagramSignatureCandidateName; secret: string }>,
): Promise<InstagramSignatureResult> {
  const usable = candidates.filter((c) => typeof c.secret === "string" && c.secret.trim().length > 0);
  if (usable.length === 0) return { ok: false, reason: "no_secret" };

  const value = (header ?? "").trim();
  if (value.length === 0) return { ok: false, reason: "missing_header" };
  if (!value.startsWith(SIGNATURE_PREFIX)) return { ok: false, reason: "malformed_header" };
  const expectedHex = value.slice(SIGNATURE_PREFIX.length).toLowerCase();
  if (!HEX_64.test(expectedHex)) return { ok: false, reason: "malformed_header" };
  const expected = hexToBytes(expectedHex);

  for (const candidate of usable) {
    const actual = await hmacSha256(candidate.secret, raw);
    if (constantTimeEqualBytes(actual, expected)) return { ok: true, matched: candidate.name };
  }
  return { ok: false, reason: "mismatch" };
}

export type InstagramSecretReadLike =
  | { ok: true; value: string }
  | { ok: false; reason: "missing" | "read_failed" };

/**
 * Lê os candidatos sob demanda e decide. `read_failed` de um candidato que
 * seria necessário é `read_failed` (503, nunca "permitido"); `meta` ausente é
 * só "sem segundo candidato". O `meta` não é lido quando o `instagram` já
 * casou ou quando o cabeçalho é ausente/malformado (o segundo segredo não
 * mudaria o resultado).
 */
export async function authenticateInstagramWebhook(
  raw: Uint8Array,
  header: string | null,
  readSecret: (key: "instagram_app_secret" | "meta_app_secret") => Promise<InstagramSecretReadLike>,
): Promise<InstagramSignatureResult | { ok: false; reason: "read_failed" }> {
  const ig = await readSecret("instagram_app_secret");
  if (ig.ok === false && ig.reason === "read_failed") return { ok: false, reason: "read_failed" };

  const candidates: Array<{ name: InstagramSignatureCandidateName; secret: string }> = [];
  if (ig.ok === true) {
    candidates.push({ name: "instagram", secret: ig.value });
    const first = await verifyInstagramSignature(raw, header, candidates);
    if (first.ok === true) return first;
    if (first.reason === "missing_header" || first.reason === "malformed_header") return first;
  }

  const meta = await readSecret("meta_app_secret");
  if (meta.ok === false && meta.reason === "read_failed") return { ok: false, reason: "read_failed" };
  if (meta.ok === true) {
    // O `instagram` (se havia) já não casou: só o `meta` decide agora.
    return verifyInstagramSignature(raw, header, [{ name: "meta", secret: meta.value }]);
  }
  // Só o `instagram` (que não casou) ou nenhum candidato.
  return verifyInstagramSignature(raw, header, candidates);
}

/**
 * Handshake GET da Meta: `hub.mode=subscribe` e `hub.verify_token` igual ao
 * guardado (tempo constante). Devolve o `hub.challenge` cru.
 */
export function decideVerifyChallenge(
  params: URLSearchParams,
  expected: string,
): { status: 200; body: string } | { status: 403 } {
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token") ?? "";
  const challenge = params.get("hub.challenge");
  if (typeof expected !== "string" || expected.length === 0) return { status: 403 };
  const tokenOk = constantTimeEqualStrings(token, expected);
  if (mode !== "subscribe" || !tokenOk || challenge === null || challenge.length === 0) return { status: 403 };
  return { status: 200, body: challenge };
}

const IG_USER_ID = /^[0-9]{1,64}$/;

/**
 * `entry[].id` distintos (ig_user_id da conta que RECEBEU), só dígitos como a
 * coluna exige. `null` se `object !== "instagram"`. Número só quando é inteiro
 * seguro não negativo (precisão perdida apontaria para outra conta).
 */
export function entryAccountIds(body: unknown): string[] | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as { object?: unknown; entry?: unknown };
  if (record.object !== "instagram") return null;
  if (!Array.isArray(record.entry)) return [];
  const seen = new Set<string>();
  for (const item of record.entry) {
    if (item === null || typeof item !== "object") continue;
    const id = (item as { id?: unknown }).id;
    let value: string | null = null;
    if (typeof id === "string") value = id.trim();
    else if (typeof id === "number" && Number.isSafeInteger(id) && id >= 0) value = String(id);
    if (value !== null && IG_USER_ID.test(value)) seen.add(value);
  }
  return [...seen];
}

/** sha256 minúsculo dos bytes (casa com o CHECK `encode(sha256(raw_body),'hex')`). */
export async function sha256Hex(raw: Uint8Array): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(raw))));
}

/**
 * Literal `\x…` de `bytea` dos bytes EXATOS recebidos (R2-a). Não passa por
 * texto: decodificar e re-codificar trocaria UTF-8 inválido por U+FFFD e a
 * revalidação do HMAC no worker falharia.
 */
export function rawBodyByteaHex(raw: Uint8Array): string {
  return `\\x${bytesToHex(raw)}`;
}

export interface InstagramAccountRow {
  id: string;
  unit_id: string;
  ig_user_id: string;
}

/**
 * Elegibilidade (C3): conta conectada cujo `ig_user_id` veio no lote, com
 * grant ativo E Direct ligado na unidade DA CONTA. Descartes só contam.
 * `unknown_account` inclui conta em `reauth_required`/`disconnected` (o select
 * só traz `connected`).
 */
export function selectEligibleInstagramAccounts(input: {
  entryIds: readonly string[];
  accounts: readonly InstagramAccountRow[];
  activeGrantUnitIds: ReadonlySet<string>;
  dmEnabledUnitIds: ReadonlySet<string>;
}): {
  eligible: InstagramAccountRow[];
  discarded: { unknown_account: number; no_grant: number; dm_disabled: number };
} {
  const byIg = new Map<string, InstagramAccountRow>();
  for (const account of input.accounts) {
    if (!byIg.has(account.ig_user_id)) byIg.set(account.ig_user_id, account);
  }
  const eligible: InstagramAccountRow[] = [];
  const discarded = { unknown_account: 0, no_grant: 0, dm_disabled: 0 };
  for (const igId of input.entryIds) {
    const account = byIg.get(igId);
    if (!account) discarded.unknown_account += 1;
    else if (!input.activeGrantUnitIds.has(account.unit_id)) discarded.no_grant += 1;
    else if (!input.dmEnabledUnitIds.has(account.unit_id)) discarded.dm_disabled += 1;
    else eligible.push(account);
  }
  return { eligible, discarded };
}

/**
 * Pedido do kick pós-ACK ao worker (Task 4.1). O corpo leva só o id da linha:
 * o worker relê a fila e nunca confia em payload do pedido.
 */
export function buildInstagramInboundKick(
  supabaseUrl: string,
  internalKey: string,
  eventId: string,
): { url: string; init: { method: "POST"; headers: Record<string, string>; body: string } } {
  return {
    url: `${supabaseUrl}/functions/v1/process-instagram-inbound`,
    init: {
      method: "POST",
      headers: { "x-internal-key": internalKey, "content-type": "application/json" },
      body: JSON.stringify({ event_id: eventId }),
    },
  };
}
