import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";

export interface PlatformSecret {
  key: string;
  last4: string | null;
  description: string;
  configured: boolean;
  updated_at: string | null;
}

async function invokeManagePlatformSecrets(body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke("manage-platform-secrets", { body });
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

export function usePlatformSecrets() {
  return useQuery({
    queryKey: ["platform-secrets"],
    queryFn: async () => {
      const data = await invokeManagePlatformSecrets({ action: "list" });
      return ((data as { secrets?: PlatformSecret[] })?.secrets ?? []) as PlatformSecret[];
    },
  });
}

export function useUpsertPlatformSecret() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ key, value }: { key: string; value: string }) => {
      return invokeManagePlatformSecrets({ action: "upsert", key, value });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["platform-secrets"] });
      toast.success("Configuração salva.");
    },
    onError: (err: Error) => toast.error(err.message),
  });
}

export function useDeletePlatformSecret() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (key: string) => {
      return invokeManagePlatformSecrets({ action: "delete", key });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["platform-secrets"] });
      toast.success("Configuração removida.");
    },
    onError: (err: Error) => toast.error(err.message),
  });
}
