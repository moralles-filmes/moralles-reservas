/**
 * `state` assinado do OAuth do Instagram Login (C1, R2-d).
 *
 * Formato: `base64url(json).base64url(hmac_sha256(segredo, parte1))`, com o json
 * `{ unitId, userId, exp, nonce }` e `exp` em epoch ms. O segredo é o Edge secret
 * `INSTAGRAM_OAUTH_STATE_SECRET`, lido só no `index.ts` e passado por parâmetro.
 *
 * Módulo puro (só WebCrypto `crypto.subtle`, sem API do runtime nem import remoto): o Vitest importa.
 *
 * Verificação, nesta ordem: estrutura (duas partes base64url canônicas, sem
 * padding, assinatura de 32 bytes) → assinatura por `crypto.subtle.verify`
 * (comparação em tempo constante) → só então o JSON é lido e validado → `exp`.
 * Conteúdo não autenticado nunca é interpretado. `expired` quando `nowMs >= exp`.
 *
 * Segredo vazio, não-string ou com menos de `MIN_SECRET_LENGTH` caracteres:
 * `sign` lança e `verify` recusa (`bad_signature`) — nunca se assina com chave fraca.
 *
 * USO ÚNICO (R2-d): não há armazenamento de nonce no banco neste bloco. O uso
 * único vem do código OAuth da Meta (vale uma vez, 1h) somado ao `state` preso a
 * usuário + unidade + expiração de 10 min; o callback do frontend (Task 5.3)
 * compara o `state` devolvido com o que guardou no início e o descarta após o
 * uso. A EF confere assinatura, `userId === usuário da sessão` e expiração; a
 * unidade vem só daqui, nunca do corpo.
 */

export const INSTAGRAM_STATE_TTL_MS = 600_000;

/** Tamanho mínimo do segredo do `state` (caracteres). */
const MIN_SECRET_LENGTH = 32;
const HMAC_BYTES = 32;
const B64URL = /^[A-Za-z0-9_-]+$/;

export interface InstagramStatePayload {
  unitId: string;
  userId: string;
  exp: number;
  nonce: string;
}

export type InstagramStateVerify =
  | { ok: true; payload: InstagramStatePayload }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

const enc = new TextEncoder();

function isUsableSecret(secret: unknown): secret is string {
  return typeof secret === "string" && secret.length >= MIN_SECRET_LENGTH;
}

function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decodifica base64url canônico; `null` se inválido ou não canônico (bits de folga). */
function b64urlToBytes(s: string): Uint8Array | null {
  if (!B64URL.test(s) || s.length % 4 === 1) return null;
  let bin: string;
  try {
    bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  } catch {
    return null;
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return bytesToB64url(out) === s ? out : null;
}

function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

const nonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

function toPayload(v: unknown): InstagramStatePayload | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (!nonEmptyString(o.unitId) || !nonEmptyString(o.userId) || !nonEmptyString(o.nonce)) return null;
  if (typeof o.exp !== "number" || !Number.isFinite(o.exp)) return null;
  return { unitId: o.unitId, userId: o.userId, exp: o.exp, nonce: o.nonce };
}

export async function signInstagramState(p: InstagramStatePayload, secret: string): Promise<string> {
  if (!isUsableSecret(secret)) throw new Error("instagram_state_secret_unusable");
  const payload = toPayload(p);
  if (payload === null) throw new Error("instagram_state_payload_invalid");
  const part = bytesToB64url(
    enc.encode(JSON.stringify({ unitId: payload.unitId, userId: payload.userId, exp: payload.exp, nonce: payload.nonce })),
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), enc.encode(part)));
  return `${part}.${bytesToB64url(sig)}`;
}

export async function verifyInstagramState(
  token: string,
  secret: string,
  nowMs: number,
): Promise<InstagramStateVerify> {
  if (typeof token !== "string") return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [part, sigPart] = parts;
  const payloadBytes = b64urlToBytes(part);
  const sig = b64urlToBytes(sigPart);
  if (payloadBytes === null || sig === null || sig.length !== HMAC_BYTES) {
    return { ok: false, reason: "malformed" };
  }

  if (!isUsableSecret(secret)) return { ok: false, reason: "bad_signature" };
  let valid: boolean;
  try {
    valid = await crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), sig.buffer as ArrayBuffer, enc.encode(part));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "bad_signature" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const payload = toPayload(parsed);
  if (payload === null) return { ok: false, reason: "malformed" };
  if (!(typeof nowMs === "number" && nowMs < payload.exp)) return { ok: false, reason: "expired" };
  return { ok: true, payload };
}
