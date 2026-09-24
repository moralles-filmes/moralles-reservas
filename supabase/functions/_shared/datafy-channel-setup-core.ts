/**
 * Núcleo PURO: decide se um canal Datafy pode nascer e como rotacionar seu
 * `webhook_secret`. ZERO IMPORTS além do tipo `DatafyAccount`.
 */

import type { DatafyAccount } from "./datafy-client.ts";

export type DatafyChannelSetupRefusal =
  | "missing_token"
  | "missing_webhook_secret"
  | "discovery_failed";

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
 */
export function decideDatafyChannelSetup(input: {
  token: string | null | undefined;
  webhookSecret: string | null | undefined;
  account: DatafyAccount | null;
}): DatafyChannelSetup {
  const token = input.token?.trim();
  if (!token) return { ok: false, reason: "missing_token" };
  if (!input.webhookSecret?.trim()) return { ok: false, reason: "missing_webhook_secret" };
  if (!input.account?.phoneNumberId) return { ok: false, reason: "discovery_failed" };
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
