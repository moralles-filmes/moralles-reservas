/**
 * Decisão pura da assinatura de webhook da Datafy.
 *
 * A Datafy assina `{timestamp}.{corpo cru}` com o segredo `whsec_…` do número e
 * entrega o resultado em `x-datafy-signature-256` no formato `sha256=<hex>`,
 * junto de `x-datafy-timestamp`. Difere da Meta em dois pontos que importam:
 * o timestamp entra no material assinado, e existe janela anti-replay.
 *
 * O HMAC em si NÃO mora aqui: `crypto.subtle` é assíncrono e indisponível ao
 * vitest de núcleo puro. Aqui ficam as pré-condições — que é onde moram os
 * modos de falha que um canal real encontra.
 */

export const DATAFY_SIGNATURE_HEADER = "x-datafy-signature-256";
export const DATAFY_TIMESTAMP_HEADER = "x-datafy-timestamp";

/**
 * Cinco minutos, conforme a recomendação da documentação. Aplicada nos DOIS
 * sentidos: só olhar o passado aceitaria um timestamp forjado com data futura
 * para sempre, já que a assinatura fecha sobre o valor que o atacante escolheu.
 */
export const DATAFY_REPLAY_WINDOW_MS = 5 * 60_000;

const SIGNATURE_PREFIX = "sha256=";
const HEX_64 = /^[0-9a-f]{64}$/;

export type DatafySignatureRefusal =
  | "missing_secret"
  | "missing_signature"
  | "malformed_signature"
  | "missing_timestamp"
  | "malformed_timestamp"
  | "stale_timestamp"
  | "future_timestamp";

export type DatafySignaturePreconditions =
  | { ok: true; expectedHex: string; signedPayloadPrefix: string }
  | { ok: false; reason: DatafySignatureRefusal };

export function buildDatafySignedPayload(timestampRaw: string, bodyText: string): string {
  return `${timestampRaw}.${bodyText}`;
}

export function decideDatafySignaturePreconditions(input: {
  secret: string | null | undefined;
  signatureHeader: string | null;
  timestampHeader: string | null;
  nowMs: number;
}): DatafySignaturePreconditions {
  if (!input.secret || !input.secret.trim()) return { ok: false, reason: "missing_secret" };

  const rawSignature = input.signatureHeader?.trim() ?? "";
  if (!rawSignature) return { ok: false, reason: "missing_signature" };
  if (!rawSignature.startsWith(SIGNATURE_PREFIX)) return { ok: false, reason: "malformed_signature" };
  const expectedHex = rawSignature.slice(SIGNATURE_PREFIX.length).toLowerCase();
  if (!HEX_64.test(expectedHex)) return { ok: false, reason: "malformed_signature" };

  const rawTimestamp = input.timestampHeader?.trim() ?? "";
  if (!rawTimestamp) return { ok: false, reason: "missing_timestamp" };
  if (!/^\d+$/.test(rawTimestamp)) return { ok: false, reason: "malformed_timestamp" };
  const seconds = Number(rawTimestamp);
  if (!Number.isFinite(seconds) || seconds <= 0) return { ok: false, reason: "malformed_timestamp" };

  const deltaMs = input.nowMs - seconds * 1000;
  if (deltaMs > DATAFY_REPLAY_WINDOW_MS) return { ok: false, reason: "stale_timestamp" };
  if (-deltaMs > DATAFY_REPLAY_WINDOW_MS) return { ok: false, reason: "future_timestamp" };

  // O prefixo devolvido é o valor CRU do header: reformatar (zeros à esquerda,
  // recasting numérico) mudaria o material assinado e derrubaria toda entrega.
  return { ok: true, expectedHex, signedPayloadPrefix: rawTimestamp };
}
