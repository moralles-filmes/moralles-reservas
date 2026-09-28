// Fase D — decisão da captura do `referral` de anúncio Click-to-WhatsApp (CTWA).
//
// Núcleo puro: TUDO que a Fase D decide mora aqui, e `webhook-whatsapp/index.ts`
// só faz I/O. O vitest não importa aquele arquivo (`serve()` no carregamento +
// `deno.land`), e regra que só se confere por leitura já deixou passar defeito
// duas vezes neste repo.
//
// O CONTRATO QUE ESTE ARQUIVO SUSTENTA (D8 da spec): falha de INSERT do
// touchpoint é reentregável — o handler lança antes de qualquer efeito externo e
// o provider reentrega. Por isso NENHUMA entrada de provider pode produzir uma
// linha que o banco recuse: recusa persistente viraria reentrega eterna, com o
// cliente sem resposta. O que o Postgres recusaria é neutralizado AQUI:
//   - `\u0000` (`text` recusa com 22021, `jsonb` com 22P05);
//   - surrogate UTF-16 órfão (não existe em UTF-8);
//   - número em notação exponencial: o `jsonb` o expande (`1e300` vira 301
//     dígitos no `jsonb::text`) e estouraria o CHECK de tamanho que o
//     `JSON.stringify` media folgado;
//   - aninhamento acima de REFERRAL_RAW_MAX_DEPTH;
//   - tamanho, medido em BYTES UTF-8 para a subárvore.
// Provider fora de AD_TOUCHPOINT_PROVIDERS é RECUSADO aqui pelo mesmo motivo: o
// CHECK de `provider` da 115 o recusaria.
//
// Spec: docs/superpowers/specs/2026-09-27-datafy-fase-d-ctwa-referral-design.md

import {
  PROVIDER_CAPABILITIES,
  type AdReferral,
  type WhatsAppProviderName,
} from "./whatsapp-provider-core.ts";
import { shapeOf } from "./webhook-payload-shape-core.ts";

/**
 * Providers cujo touchpoint o banco aceita. DERIVADO da capability, nunca
 * digitado. Gêmeo declarado do `check (provider in (...))` da migration 115 —
 * SQL não importa TypeScript, e `whatsapp-ad-touchpoint-migration-twin.test.ts`
 * lê o arquivo da migration e reprova divergência.
 */
export const AD_TOUCHPOINT_PROVIDERS: ReadonlySet<string> = new Set(
  (Object.keys(PROVIDER_CAPABILITIES) as WhatsAppProviderName[])
    .filter((name) => PROVIDER_CAPABILITIES[name].adReferral === true),
);

// Gêmeos declarados dos CHECKs de `whatsapp_ad_touchpoints` na migration 115.
// Mudar um lado sem o outro é o começo do drift: o teste gêmeo reprova.
// `.length` do JS conta unidades UTF-16 e o `length()` do Postgres conta
// caracteres — o JS nunca é MENOR, então aceitar aqui garante aceitar lá.
export const PROVIDER_MESSAGE_ID_MAX_LEN = 512;
export const MESSAGE_TYPE_MAX_LEN = 32;
export const CTWA_CLID_MAX_LEN = 512;
export const SOURCE_TYPE_MAX_LEN = 64;
export const SOURCE_ID_MAX_LEN = 256;

/** A REGRA: acima disto a subárvore crua é descartada e os tipados ficam. */
export const REFERRAL_RAW_MAX_BYTES = 16_384;
/**
 * A REDE do banco (`octet_length(referral::text) <= 65536`), não a regra. O
 * `jsonb::text` insere espaço depois de `:` e `,` e fica mais longo que o
 * `JSON.stringify`; com os dois no mesmo número, o banco recusaria o que o
 * núcleo aceitou.
 */
export const REFERRAL_RAW_DB_MAX_BYTES = 65_536;
export const REFERRAL_RAW_MAX_DEPTH = 32;
/** 9999-12-31T23:59:59.999Z. Acima disto `toISOString` devolve `+010000-…`. */
export const MESSAGE_AT_MAX_MS = 253_402_300_799_999;

const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Texto que o Postgres aceita em `text` e em `jsonb`: sem NUL e UTF-16 bem formado. */
export function isPgSafeText(value: string): boolean {
  return !value.includes("\u0000") && !UNPAIRED_SURROGATE.test(value);
}

/** Campo tipado: trim; vazio, acima do limite ou recusável pelo banco → null. Nunca trunca. */
export function normalizeTouchpointText(value: string | null | undefined, maxLen: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLen || !isPgSafeText(trimmed)) return null;
  return trimmed;
}

export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function isStorableJsonTree(value: unknown, depth: number): boolean {
  if (depth > REFERRAL_RAW_MAX_DEPTH) return false;
  if (typeof value === "string") return isPgSafeText(value);
  if (typeof value === "number") return Number.isFinite(value) && !/e/i.test(String(value));
  if (value === null || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.every((item) => isStorableJsonTree(item, depth + 1));
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).every(
      ([key, item]) => isPgSafeText(key) && isStorableJsonTree(item, depth + 1),
    );
  }
  return false; // undefined, function, bigint, symbol: não vêm de JSON.parse
}

export type RawOmittedReason = "too_large" | "not_storable";

function storableRaw(raw: unknown): { raw: unknown; omitted: RawOmittedReason | null } {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(raw);
  } catch {
    return { raw: null, omitted: "not_storable" };
  }
  if (serialized === undefined) return { raw: null, omitted: "not_storable" };
  if (utf8ByteLength(serialized) > REFERRAL_RAW_MAX_BYTES) return { raw: null, omitted: "too_large" };
  if (!isStorableJsonTree(raw, 0)) return { raw: null, omitted: "not_storable" };
  return { raw, omitted: null };
}

export interface AdTouchpointInput {
  /** `whatsapp_channels.provider` do canal da querystring. */
  provider: string;
  /** `channel.unit_id` do MESMO SELECT que resolveu o canal — nunca do payload. */
  unitId: string;
  channelId: string | null;
  customerId: string;
  /** Id do inbound já reivindicado em `processed_messages`. */
  inboundProviderMessageId: string;
  /** Epoch em ms, normalizado pelo parser do provider. */
  messageAtMs: number;
  referral: AdReferral;
}

export interface AdTouchpointRow {
  unit_id: string;
  channel_id: string | null;
  customer_id: string;
  provider: string;
  provider_message_id: string;
  message_type: string | null;
  message_at: string;
  ctwa_clid: string | null;
  source_type: string | null;
  source_id: string | null;
  referral: unknown;
}

export type AdTouchpointRejectReason =
  | "provider_not_capable"
  | "invalid_provider_message_id"
  | "message_id_mismatch"
  | "invalid_message_at";

export type BuildAdTouchpointResult =
  | { ok: true; row: AdTouchpointRow; rawOmittedReason: RawOmittedReason | null }
  | { ok: false; reason: AdTouchpointRejectReason };

/**
 * Monta a linha ou recusa com motivo. Recusa NÃO é falha: o handler loga e
 * segue — um bug nosso de split não pode calar o cliente.
 */
export function buildAdTouchpointRow(input: AdTouchpointInput): BuildAdTouchpointResult {
  if (!AD_TOUCHPOINT_PROVIDERS.has(input.provider)) return { ok: false, reason: "provider_not_capable" };

  const messageId = normalizeTouchpointText(input.inboundProviderMessageId, PROVIDER_MESSAGE_ID_MAX_LEN);
  if (!messageId) return { ok: false, reason: "invalid_provider_message_id" };
  // Cinto contra atribuir o anúncio de uma mensagem a outra se o split mudar.
  if (normalizeTouchpointText(input.referral.providerMessageId, PROVIDER_MESSAGE_ID_MAX_LEN) !== messageId) {
    return { ok: false, reason: "message_id_mismatch" };
  }

  const ms = input.messageAtMs;
  if (!Number.isFinite(ms) || ms < 0 || ms > MESSAGE_AT_MAX_MS) return { ok: false, reason: "invalid_message_at" };

  const { raw, omitted } = storableRaw(input.referral.raw);
  return {
    ok: true,
    rawOmittedReason: omitted,
    row: {
      unit_id: input.unitId,
      channel_id: input.channelId,
      customer_id: input.customerId,
      provider: input.provider,
      provider_message_id: messageId,
      message_type: normalizeTouchpointText(input.referral.messageType, MESSAGE_TYPE_MAX_LEN),
      message_at: new Date(ms).toISOString(),
      ctwa_clid: normalizeTouchpointText(input.referral.ctwaClid, CTWA_CLID_MAX_LEN),
      source_type: normalizeTouchpointText(input.referral.sourceType, SOURCE_TYPE_MAX_LEN),
      source_id: normalizeTouchpointText(input.referral.sourceId, SOURCE_ID_MAX_LEN),
      referral: raw,
    },
  };
}

export type TouchpointInsertOutcome = "inserted" | "duplicate" | "failed";

/** `23505` é dedupe silencioso (reentrega); qualquer outro erro é falha reentregável. */
export function classifyTouchpointInsert(
  error: { code?: string | null } | null | undefined,
): TouchpointInsertOutcome {
  if (!error) return "inserted";
  return error.code === "23505" ? "duplicate" : "failed";
}

function firstMetaMessage(payload: unknown): Record<string, unknown> | null {
  // deno-lint-ignore no-explicit-any
  const msg = (payload as any)?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  return msg && typeof msg === "object" && !Array.isArray(msg) ? msg as Record<string, unknown> : null;
}

/**
 * `meta_inbound_referral_probe`: responde o que `ad_referral_captured` não
 * alcança — o clique chegou com o referral em OUTRO lugar? Sem ele, envelope
 * divergente é silêncio, e silêncio é indistinguível de "ninguém clicou".
 */
export function describeReferralProbe(payload: unknown): { has_referral: boolean; message_shape: unknown } {
  const msg = firstMetaMessage(payload);
  if (!msg) return { has_referral: false, message_shape: null };
  return {
    has_referral: msg.referral !== undefined && msg.referral !== null,
    message_shape: shapeOf(msg),
  };
}

export type TouchpointCaptureOutcome = TouchpointInsertOutcome | "rejected";

/** `ad_referral_captured` / `ad_referral_rejected`: os campos têm o nome que a documentação diz? */
export function describeCapturedReferral(args: {
  provider: string;
  outcome: TouchpointCaptureOutcome;
  referral: AdReferral;
  rawOmittedReason?: RawOmittedReason | null;
  rejectReason?: AdTouchpointRejectReason;
}): Record<string, unknown> {
  return {
    provider: args.provider,
    outcome: args.outcome,
    message_type: normalizeTouchpointText(args.referral.messageType, MESSAGE_TYPE_MAX_LEN),
    referral_shape: shapeOf(args.referral.raw),
    raw_omitted: args.rawOmittedReason ?? null,
    ...(args.rejectReason ? { reason: args.rejectReason } : {}),
  };
}
