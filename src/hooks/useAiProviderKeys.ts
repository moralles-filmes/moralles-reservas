import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";

export type AIProvider = "claude" | "openai" | "gemini" | "grok" | "deepseek";

export interface AiProviderKey {
  provider: AIProvider;
  last4: string;
  active: boolean;
  updated_at: string;
}

async function invokeManageAiProviders(body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke("manage-ai-providers", { body });
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

export function useAiProviderKeys(unitId: string) {
  return useQuery({
    queryKey: ["ai-provider-keys", unitId],
    queryFn: async () => {
      const data = await invokeManageAiProviders({ action: "list", unit_id: unitId });
      return ((data as { keys?: AiProviderKey[] })?.keys ?? []) as AiProviderKey[];
    },
    enabled: !!unitId,
  });
}

export function useUpsertAiProviderKey(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ provider, apiKey }: { provider: AIProvider; apiKey: string }) => {
      return invokeManageAiProviders({
        action: "upsert",
        unit_id: unitId,
        provider,
        api_key: apiKey,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ai-provider-keys", unitId] });
      toast.success("Chave de API salva.");
    },
    onError: (err: Error) => toast.error(err.message),
  });
}

export function useDeleteAiProviderKey(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (provider: AIProvider) => {
      return invokeManageAiProviders({ action: "delete", unit_id: unitId, provider });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ai-provider-keys", unitId] });
      toast.success("Chave removida.");
    },
    onError: (err: Error) => toast.error(err.message),
  });
}
