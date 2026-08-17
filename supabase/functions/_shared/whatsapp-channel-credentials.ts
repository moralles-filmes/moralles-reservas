import type {
  ChannelCredentials,
  WhatsAppProvider,
} from "./whatsapp-providers.ts";

interface ChannelCredentialRow {
  id: string;
  provider: WhatsAppProvider;
  credentials: ChannelCredentials | null;
  instance_token_secret_id?: string | null;
}

interface RpcClient {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message?: string } | null }>;
}

/**
 * Resolve credenciais somente em memória. UazAPI nunca lê token do JSONB: a
 * referência em whatsapp_channels aponta para o Vault e a RPC é exclusiva de
 * service_role. Outros providers preservam o shape atual byte a byte.
 */
export async function resolveChannelCredentials(
  client: RpcClient,
  channel: ChannelCredentialRow,
): Promise<ChannelCredentials> {
  const credentials = { ...(channel.credentials ?? {}) } as ChannelCredentials;
  if (channel.provider !== "uazapi") return credentials;

  if (!channel.instance_token_secret_id) {
    throw new Error("uazapi_instance_token_not_configured");
  }

  const { data, error } = await client.rpc("get_whatsapp_channel_instance_token", {
    p_channel_id: channel.id,
  });
  if (error || typeof data !== "string" || !data) {
    throw new Error("uazapi_instance_token_unavailable");
  }

  const runtime = globalThis as typeof globalThis & {
    Deno?: { env: { get(name: string): string | undefined } };
  };

  return {
    ...credentials,
    instance_token: data,
    base_url: runtime.Deno?.env.get("UAZAPI_BASE_URL") ?? "",
  } as ChannelCredentials;
}
