import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";
import type {
  WhatsAppChannel,
  WhatsAppProvider,
  WhatsAppProviderCapabilities,
} from "@/types/reserva";

export interface WhatsAppProviderMetadata {
  name: WhatsAppProvider;
  label: string;
  capabilities: WhatsAppProviderCapabilities;
}

export function useWhatsAppChannels(unitId: string) {
  return useQuery({
    queryKey: ["whatsapp-channels", unitId],
    queryFn: async () => {
      // whatsapp_channels usa FORCE RLS — leitura passa pela Edge Function
      // manage-channels que retorna apenas colunas seguras (sem `credentials`).
      const data = (await invokeManageChannels({
        action: "list",
        unit_id: unitId,
      })) as { channels?: WhatsAppChannel[] } | null;
      return (data?.channels ?? []) as WhatsAppChannel[];
    },
    enabled: !!unitId,
  });
}

export interface ChannelCredentials {
  // Z-API
  instance_id?: string;
  token?: string;
  client_token?: string;
  // WAHA
  base_url?: string;
  api_key?: string;
  session_name?: string;
  // Official
  phone_number_id?: string;
  business_account_id?: string;
  access_token?: string;
  app_secret?: string;
}

export function useWhatsAppProviderMetadata(unitId: string) {
  return useQuery({
    queryKey: ["whatsapp-provider-metadata"],
    queryFn: async () => {
      const data = await invokeManageChannels({
        action: "list_provider_metadata",
        unit_id: unitId,
      }) as { providers?: WhatsAppProviderMetadata[] } | null;
      return data?.providers ?? [];
    },
    enabled: !!unitId,
    staleTime: 30 * 60 * 1000,
  });
}

export interface ChannelConnectionResponse {
  connection?: {
    channel_id: string | null;
    status: string;
    display_phone: string | null;
    connected_at: string | null;
    last_health_check_at: string | null;
    qr_code: string | null;
  };
  warnings?: string[];
}

async function invokeManageChannels(body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke("manage-channels", { body });
  if (error) {
    // supabase-js v2 envolve qualquer non-2xx num FunctionsHttpError cuja .message é
    // sempre "Edge Function returned a non-2xx status code" — `data` vem null, e o body
    // real (a mensagem PT-BR que a Edge Function escreveu, ex.: "Canal não encontrado.")
    // só existe em error.context.json(). Sem isso o operador nunca via a mensagem
    // específica, só o texto genérico do SDK. Mesmo padrão de useSendManualMessage.ts —
    // anexa o status HTTP pro caller poder decidir (ex.: 409 força refetch).
    if (error instanceof FunctionsHttpError) {
      const errBody = (await error.context.json().catch(() => null)) as
        | { error?: string }
        | null;
      const message = errBody?.error ?? error.message ?? "Erro inesperado.";
      throw Object.assign(new Error(message), { httpStatus: error.context.status });
    }
    throw error;
  }
  if (data && typeof data === "object" && "error" in data && data.error) {
    throw new Error(String(data.error));
  }
  return data;
}

export function useCreateChannel(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      provider,
      credentials,
    }: {
      provider: WhatsAppProvider;
      credentials: ChannelCredentials;
    }) => {
      return invokeManageChannels({
        action: "create",
        unit_id: unitId,
        provider,
        credentials,
      });
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["whatsapp-channels", unitId] });
      toast.success(`Canal ${variables.provider} preparado.`);
    },
    onError: (err: Error) => toast.error(err.message),
  });
}

function useChannelLifecycleAction(
  unitId: string,
  action: "connect" | "status" | "begin_switch",
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      channelId,
      targetProvider,
    }: {
      channelId?: string;
      targetProvider?: WhatsAppProvider;
    }) => invokeManageChannels({
      action,
      unit_id: unitId,
      ...(channelId ? { channel_id: channelId } : {}),
      ...(targetProvider ? { target_provider: targetProvider } : {}),
    }) as Promise<ChannelConnectionResponse>,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["whatsapp-channels", unitId] });
    },
    onError: (err: Error) => toast.error(err.message),
  });
}

export function useConnectChannel(unitId: string) {
  return useChannelLifecycleAction(unitId, "connect");
}

export function useRefreshChannelStatus(unitId: string) {
  return useChannelLifecycleAction(unitId, "status");
}

export function useBeginChannelSwitch(unitId: string) {
  return useChannelLifecycleAction(unitId, "begin_switch");
}

export function useUpdateChannel(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      channelId,
      credentials,
    }: {
      channelId: string;
      credentials: ChannelCredentials;
    }) => {
      return invokeManageChannels({
        action: "update",
        unit_id: unitId,
        channel_id: channelId,
        credentials,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["whatsapp-channels", unitId] });
      toast.success("Credenciais atualizadas.");
    },
    onError: (err: Error) => toast.error(err.message),
  });
}

export function useDeleteChannel(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (channelId: string) => {
      return invokeManageChannels({ action: "delete", unit_id: unitId, channel_id: channelId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["whatsapp-channels", unitId] });
      toast.success("Canal removido.");
    },
    onError: (err: Error) => toast.error(err.message),
  });
}

export function useRotateChannelSecret(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (channelId: string) => {
      return invokeManageChannels({
        action: "rotate_secret",
        unit_id: unitId,
        channel_id: channelId,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["whatsapp-channels", unitId] });
      toast.success(
        "Secret rotacionado. Atualize a URL, envie uma mensagem pelo celular e use Ativar / trocar.",
      );
    },
    onError: (err: Error) => toast.error(err.message),
  });
}

export function useTestChannel(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (channelId: string) => {
      return invokeManageChannels({ action: "test", unit_id: unitId, channel_id: channelId }) as Promise<{
        success: boolean;
        status: string;
        error?: string | null;
      }>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["whatsapp-channels", unitId] });
      if (data.status === "disconnected") {
        toast.warning("A instância está desconectada.");
      } else {
        toast.success("Conexão testada com sucesso.");
      }
    },
    onError: (err: Error) => {
      queryClient.invalidateQueries({ queryKey: ["whatsapp-channels", unitId] });
      toast.error(`Falha na conexão: ${err.message}`);
    },
  });
}
