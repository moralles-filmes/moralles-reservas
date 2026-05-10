import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";

export const GIFTBACK_SETTING_KEYS = [
  "giftback_whatsapp_enabled",
  "giftback_email_enabled",
  "giftback_message_template",
] as const;

export type GiftbackSettingKey = (typeof GIFTBACK_SETTING_KEYS)[number];

export interface GiftbackSettings {
  giftback_whatsapp_enabled: boolean;
  giftback_email_enabled: boolean;
  giftback_message_template: string;
}

export const DEFAULT_GIFTBACK_TEMPLATE =
  "🎁 Você ganhou {{discount}}% de desconto na sua próxima visita ao {{unidade}}!\n\n" +
  "Código: *{{codigo}}*\nVálido até *{{validade}}*.\n\n" +
  "Apresente esse código quando for pagar.";

export const GIFTBACK_DEFAULTS: GiftbackSettings = {
  giftback_whatsapp_enabled: true,
  giftback_email_enabled: false,
  giftback_message_template: DEFAULT_GIFTBACK_TEMPLATE,
};

function coerceBoolean(raw: unknown, fallback: boolean): boolean {
  if (typeof raw === "boolean") return raw;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return fallback;
}

function coerceString(raw: unknown, fallback: string): string {
  if (typeof raw === "string" && raw) return raw;
  return fallback;
}

export function useGiftbackSettings(unitId: string) {
  return useQuery({
    queryKey: ["settings", unitId, "giftback"],
    queryFn: async (): Promise<GiftbackSettings> => {
      const { data, error } = await supabase
        .from("settings")
        .select("key, value")
        .eq("unit_id", unitId)
        .in("key", [...GIFTBACK_SETTING_KEYS]);
      if (error) throw error;

      const map = Object.fromEntries(
        (data ?? []).map((s: { key: string; value: unknown }) => [s.key, s.value]),
      );

      return {
        giftback_whatsapp_enabled: coerceBoolean(
          map.giftback_whatsapp_enabled,
          GIFTBACK_DEFAULTS.giftback_whatsapp_enabled,
        ),
        giftback_email_enabled: coerceBoolean(
          map.giftback_email_enabled,
          GIFTBACK_DEFAULTS.giftback_email_enabled,
        ),
        giftback_message_template: coerceString(
          map.giftback_message_template,
          GIFTBACK_DEFAULTS.giftback_message_template,
        ),
      };
    },
    enabled: !!unitId,
    refetchOnWindowFocus: false,
  });
}

export function useUpdateGiftbackSettings(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (patch: Partial<GiftbackSettings>) => {
      const rows = Object.entries(patch).map(([key, value]) => ({
        unit_id: unitId,
        key,
        value: value as unknown,
      }));
      const { error } = await supabase
        .from("settings")
        .upsert(rows, { onConflict: "unit_id,key" });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", unitId] });
      toast.success("Ajustes salvos.");
    },
    onError: (err: Error) => toast.error(err.message ?? "Erro ao salvar."),
  });
}

export function renderGiftbackTemplate(
  template: string,
  vars: { discount: number | string; unidade: string; codigo: string; validade: string },
): string {
  return template
    .replace(/\{\{discount\}\}/g, String(vars.discount))
    .replace(/\{\{unidade\}\}/g, vars.unidade)
    .replace(/\{\{codigo\}\}/g, vars.codigo)
    .replace(/\{\{validade\}\}/g, vars.validade);
}
