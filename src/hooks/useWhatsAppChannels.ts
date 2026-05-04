import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";
import type { WhatsAppChannel, WhatsAppProvider } from "@/types/reserva";

export function useWhatsAppChannels(unitId: string) {
  return useQuery({
    queryKey: ["whatsapp-channels", unitId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("whatsapp_channels")
        .select("id, unit_id, provider, status, display_phone, last_event_at, last_error, webhook_secret, created_at, updated_at")
        .eq("unit_id", unitId)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return data as WhatsAppChannel[];
    },
    enabled: !!unitId,
  });
}

interface ChannelCredentials {
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

async function invokeManageChannels(body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke("manage-channels", { body });
  if (error) {
    const message =
      (data as { error?: string } | null)?.error ?? error.message ?? "Erro inesperado.";
    throw new Error(message);
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["whatsapp-channels", unitId] });
      toast.success("Canal criado. Configure o webhook no painel do provedor.");
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

export function useTestChannel(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (channelId: string) => {
      return invokeManageChannels({ action: "test", unit_id: unitId, channel_id: channelId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["whatsapp-channels", unitId] });
      toast.success("Conexão testada com sucesso.");
    },
    onError: (err: Error) => toast.error(`Falha na conexão: ${err.message}`),
  });
}
