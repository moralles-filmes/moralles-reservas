/**
 * Identidade de canal declarada no PAYLOAD do webhook WhatsApp: "este evento,
 * já autenticado pelo segredo/assinatura do canal, declara o canal certo?".
 *
 * Vive em `_shared/` porque o vitest não importa o `webhook-whatsapp`
 * (`serve()` no carregamento + imports de `deno.land`), e regra de identidade
 * escrita lá só se confere por leitura.
 *
 * UazAPI: o envelope real tem as chaves de topo `BaseUrl, EventType, chat,
 * chatSource, instanceName, message, owner, token` — NÃO há `instanceId`,
 * `instance_id` nem `instance`. A âncora do eco é o `token`, o segredo da
 * instância. A comparação acontece AQUI, e não é herdada da checagem de token
 * que o handler faz antes: se aquela checagem mudar de lugar, esta guarda não
 * pode virar decorativa sem nenhum teste reprovar.
 */
import {
  isMetaShapedProvider,
  type ChannelCredentials,
  type WhatsAppProviderName,
} from "./whatsapp-provider-core.ts";

// Gêmea das cópias privadas em `security.ts` e `whatsapp-providers.ts`.
// Exportar a de `whatsapp-providers.ts` mudaria um arquivo importado por nove
// Edge Functions, todas a redeployar.
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function metaPhoneNumberIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  const entries = Array.isArray(record.entry) ? record.entry : [];
  const ids: string[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const changes = Array.isArray((entry as Record<string, unknown>).changes)
      ? (entry as Record<string, unknown>).changes as unknown[]
      : [];
    for (const change of changes) {
      if (!change || typeof change !== "object") continue;
      const value = (change as Record<string, unknown>).value;
      if (!value || typeof value !== "object") continue;
      const metadata = (value as Record<string, unknown>).metadata;
      if (!metadata || typeof metadata !== "object") continue;
      const id = (metadata as Record<string, unknown>).phone_number_id;
      if (typeof id === "string" && id.trim()) ids.push(id.trim());
    }
  }
  return ids;
}

/**
 * A assinatura Meta autentica o app, não o tenant/canal escolhido pela URL.
 * Todo change do lote precisa declarar exatamente o phone_number_id do binding.
 */
export function metaPayloadMatchesChannel(payload: unknown, credentials: ChannelCredentials): boolean {
  const expected = credentials.phone_number_id?.trim();
  if (!expected) return false;
  const ids = metaPhoneNumberIds(payload);
  return ids.length > 0 && ids.every((id) => id === expected);
}

/**
 * O eco do aparelho é a prova de paridade de conversa do canal: só conta se o
 * payload declarar POSITIVAMENTE o canal configurado. Ausência de âncora não
 * casa.
 */
export function manualEchoMatchesConfiguredChannel(
  provider: WhatsAppProviderName,
  payload: unknown,
  credentials: ChannelCredentials,
): boolean {
  if (!payload || typeof payload !== "object") return false;
  const root = payload as Record<string, unknown>;
  const nested = root.payload && typeof root.payload === "object"
    ? root.payload as Record<string, unknown>
    : root;

  if (isMetaShapedProvider(provider)) return metaPayloadMatchesChannel(payload, credentials);
  if (provider === "zapi") {
    const actual = [nested.instanceId, nested.instance_id, root.instanceId, root.instance_id]
      .find((value) => typeof value === "string" && value.trim()) as string | undefined;
    return !!actual && actual.trim() === credentials.instance_id?.trim();
  }
  if (provider === "waha") {
    const actual = [root.session, nested.session]
      .find((value) => typeof value === "string" && value.trim()) as string | undefined;
    return !!actual && actual.trim() === (credentials.session_name?.trim() || "default");
  }
  if (provider === "uazapi") {
    const actual = root.token;
    const expected = credentials.instance_token ?? "";
    return typeof actual === "string"
      && actual.length > 0
      && expected.length > 0
      && constantTimeEquals(actual, expected);
  }
  return false;
}

/**
 * Identidade DECLARADA (opcional) de Z-API/WAHA: se o payload diz de qual
 * instância/sessão veio, tem que ser a do canal. Ausência passa — as âncoras dos
 * demais providers são outras guardas do handler.
 */
export function declaredProviderIdentityMatchesChannel(
  provider: WhatsAppProviderName,
  payload: unknown,
  credentials: ChannelCredentials,
): boolean {
  if (!payload || typeof payload !== "object") return true;
  const root = payload as Record<string, unknown>;
  const nested = root.payload && typeof root.payload === "object"
    ? root.payload as Record<string, unknown>
    : root;
  if (provider === "zapi") {
    const actual = [nested.instanceId, nested.instance_id, root.instanceId, root.instance_id]
      .find((value) => typeof value === "string" && value.trim()) as string | undefined;
    return !actual || actual.trim() === credentials.instance_id?.trim();
  }
  if (provider === "waha") {
    const actual = [root.session, nested.session]
      .find((value) => typeof value === "string" && value.trim()) as string | undefined;
    return !actual || actual.trim() === (credentials.session_name?.trim() || "default");
  }
  return true;
}
