/**
 * Núcleo PURO: decide se um canal Datafy pode nascer e como rotacionar seu
 * `webhook_secret`. ZERO IMPORTS além do tipo `DatafyAccount`.
 */

import type { DatafyAccount } from "./datafy-client.ts";

/**
 * Lê um campo de credencial manual (token/webhook_secret) de um body HTTP já
 * desserializado (`JSON.parse`), como string — RECUSA, nunca COAGE, qualquer
 * outro tipo. `String({})` é a string não-vazia `"[object Object]"`: ela
 * passaria por `.trim()`, pela checagem de "faltando" em
 * `decideDatafyChannelSetup`/`decideDatafySecretRotation`, e seria GRAVADA
 * como o segredo/token do canal — canal que parece configurado e devolve 401
 * em toda entrega real. O handler chama isto para `access_token` e
 * `webhook_secret`, na criação E na rotação, antes de montar as decisões
 * acima; nunca `String(valor ?? "")` direto no call site.
 */
export function readManualCredentialField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export type DatafyChannelSetupRefusal =
  | "missing_token"
  | "missing_webhook_secret"
  | "discovery_failed"
  | "discovery_unrecognized";

export type DatafyChannelSetup =
  | { ok: true; credentials: { access_token: string; phone_number_id: string; business_account_id: string | null } }
  | { ok: false; reason: DatafyChannelSetupRefusal };

/**
 * A Datafy responde 403 a `webhook_configuration`, então a URL e o segredo são
 * colados à mão no painel dela. Exigir o `whsec_` já na criação é o que impede
 * um canal de nascer sem a única prova de autenticidade que ele terá.
 *
 * `phone_number_id` é obrigatório porque é a âncora da guarda cross-tenant;
 * `waba_id` é opcional aqui e só vira obrigatório na Fase F (templates).
 *
 * `discoveryResponseOk` só importa quando `account` é `null` — ele distingue
 * "o `/me` recusou/falhou" (`discovery_failed`, token ruim ou indisponibilidade)
 * de "o `/me` respondeu 2xx mas o corpo não virou `DatafyAccount`"
 * (`discovery_unrecognized`, envelope diferente do esperado). Um 401 e um 2xx
 * de forma inesperada produziam a MESMA recusa e a MESMA mensagem — o operador
 * rotacionaria um token correto pra sempre, olhando a mesma tela.
 */
export function decideDatafyChannelSetup(input: {
  token: string | null | undefined;
  webhookSecret: string | null | undefined;
  account: DatafyAccount | null;
  discoveryResponseOk?: boolean;
}): DatafyChannelSetup {
  const token = input.token?.trim();
  if (!token) return { ok: false, reason: "missing_token" };
  if (!input.webhookSecret?.trim()) return { ok: false, reason: "missing_webhook_secret" };
  if (!input.account?.phoneNumberId) {
    return { ok: false, reason: input.discoveryResponseOk ? "discovery_unrecognized" : "discovery_failed" };
  }
  return {
    ok: true,
    credentials: {
      access_token: token,
      phone_number_id: input.account.phoneNumberId,
      business_account_id: input.account.wabaId,
    },
  };
}

export type DatafySecretRotation =
  | { mode: "provider_issued"; secret: string }
  | { mode: "generate" }
  | { mode: "refused"; reason: "missing_webhook_secret" };

/**
 * Z-API/WAHA/Meta: nós emitimos o segredo, então rotacionar é gerar um novo.
 * Datafy: ELA emite e assina com o `whsec_` dela. Gerar um nosso faria toda
 * entrega seguinte morrer em 401 — e como a mesma ação zera `is_active` e
 * `manual_echo_verified_at`, o canal ficaria mudo sem nenhum erro visível.
 * Aqui a rotação acontece no painel da Datafy e o valor novo é colado.
 *
 * Discriminado por `mode` (três valores de string), nunca por um `ok` que
 * misture booleano com string: sob o `strict: false` do projeto essa mistura
 * não estreita a união, e o `TS2339` resultante nem aparece em
 * `supabase/functions/`, que o `tsc -b` não alcança.
 */
export function decideDatafySecretRotation(input: {
  provider: string;
  webhookSecret: string | null | undefined;
}): DatafySecretRotation {
  if (input.provider !== "datafy") return { mode: "generate" };
  const secret = input.webhookSecret?.trim();
  if (!secret) return { mode: "refused", reason: "missing_webhook_secret" };
  return { mode: "provider_issued", secret };
}
