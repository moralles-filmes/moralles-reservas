import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";
import type {
  CreateOrganizationInput,
  DefaultWhatsappProvider,
  UpdateOrganizationInput,
} from "@/lib/validators/organization";

export interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  plan: string | null;
  created_at: string;
  units_count: number;
  members_count: number;
  first_unit_slug: string | null;
  /** Preferencia administrativa (o que o admin autoriza provisionar). */
  default_whatsapp_provider: DefaultWhatsappProvider;
  default_whatsapp_provider_label: string;
  /**
   * Provedor(es) REALMENTE em operacao, lidos de `whatsapp_channels`. Com
   * `whatsapp_provider_source === "default"` a org nao tem canal nenhum e a
   * lista traz so a preferencia — nao afirmar que esta em uso.
   */
  whatsapp_providers: string[];
  whatsapp_provider_labels: string[];
  whatsapp_provider_source: "channels" | "default";
}

async function invokeManageOrganizations(body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke("manage-organizations", { body });
  if (error) {
    let message = error.message ?? "Erro inesperado.";
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === "function") {
      try {
        const parsed = await ctx.json();
        if (parsed?.error) message = String(parsed.error);
      } catch {
        // body não-JSON — mantém message do error.message
      }
    }
    throw new Error(message);
  }
  if (data && typeof data === "object" && "error" in data && data.error) {
    throw new Error(String((data as { error: string }).error));
  }
  return data as Record<string, unknown>;
}

export function useOrganizations() {
  return useQuery<OrganizationRow[]>({
    queryKey: ["organizations"],
    queryFn: async () => {
      const data = await invokeManageOrganizations({ action: "list_organizations" });
      return (data.organizations as OrganizationRow[]) ?? [];
    },
  });
}

export function useCreateOrganization() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateOrganizationInput) => {
      return invokeManageOrganizations({ action: "create_organization", ...input });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
      toast.success("Empresa criada com sucesso.");
    },
    onError: (err: Error) => toast.error(err.message),
  });
}

export function useUpdateOrganization() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateOrganizationInput) => {
      return invokeManageOrganizations({ action: "update_organization", ...input });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
      toast.success("Empresa atualizada.");
    },
    onError: (err: Error) => toast.error(err.message),
  });
}
