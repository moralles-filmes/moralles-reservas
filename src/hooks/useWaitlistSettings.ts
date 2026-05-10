import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";

export const WAITLIST_SETTING_KEYS = [
  "waitlist_qr_enabled",
  "waitlist_menu_link_enabled",
  "waitlist_priority_enabled",
  "waitlist_code_min",
  "waitlist_code_max",
  "waitlist_tolerance_minutes",
  "waitlist_remote_entry_enabled",
  "waitlist_remote_entry_limit",
] as const;

export type WaitlistSettingKey = (typeof WAITLIST_SETTING_KEYS)[number];

export interface WaitlistSettings {
  waitlist_qr_enabled: boolean;
  waitlist_menu_link_enabled: boolean;
  waitlist_priority_enabled: boolean;
  waitlist_code_min: number;
  waitlist_code_max: number;
  waitlist_tolerance_minutes: number;
  waitlist_remote_entry_enabled: boolean;
  waitlist_remote_entry_limit: number;
}

export const WAITLIST_DEFAULTS: WaitlistSettings = {
  waitlist_qr_enabled: false,
  waitlist_menu_link_enabled: false,
  waitlist_priority_enabled: true,
  waitlist_code_min: 1,
  waitlist_code_max: 1000,
  waitlist_tolerance_minutes: 3,
  waitlist_remote_entry_enabled: true,
  waitlist_remote_entry_limit: 10,
};

function coerceBoolean(raw: unknown, fallback: boolean): boolean {
  if (typeof raw === "boolean") return raw;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return fallback;
}

function coerceInt(raw: unknown, fallback: number): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.trunc(raw);
  if (typeof raw === "string") {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

export function useWaitlistSettings(unitId: string) {
  return useQuery({
    queryKey: ["settings", unitId, "waitlist"],
    queryFn: async (): Promise<WaitlistSettings> => {
      const { data, error } = await supabase
        .from("settings")
        .select("key, value")
        .eq("unit_id", unitId)
        .in("key", [...WAITLIST_SETTING_KEYS]);
      if (error) throw error;

      const map = Object.fromEntries(
        (data ?? []).map((s: { key: string; value: unknown }) => [s.key, s.value]),
      );

      return {
        waitlist_qr_enabled: coerceBoolean(
          map.waitlist_qr_enabled,
          WAITLIST_DEFAULTS.waitlist_qr_enabled,
        ),
        waitlist_menu_link_enabled: coerceBoolean(
          map.waitlist_menu_link_enabled,
          WAITLIST_DEFAULTS.waitlist_menu_link_enabled,
        ),
        waitlist_priority_enabled: coerceBoolean(
          map.waitlist_priority_enabled,
          WAITLIST_DEFAULTS.waitlist_priority_enabled,
        ),
        waitlist_code_min: coerceInt(
          map.waitlist_code_min,
          WAITLIST_DEFAULTS.waitlist_code_min,
        ),
        waitlist_code_max: coerceInt(
          map.waitlist_code_max,
          WAITLIST_DEFAULTS.waitlist_code_max,
        ),
        waitlist_tolerance_minutes: coerceInt(
          map.waitlist_tolerance_minutes,
          WAITLIST_DEFAULTS.waitlist_tolerance_minutes,
        ),
        waitlist_remote_entry_enabled: coerceBoolean(
          map.waitlist_remote_entry_enabled,
          WAITLIST_DEFAULTS.waitlist_remote_entry_enabled,
        ),
        waitlist_remote_entry_limit: coerceInt(
          map.waitlist_remote_entry_limit,
          WAITLIST_DEFAULTS.waitlist_remote_entry_limit,
        ),
      };
    },
    enabled: !!unitId,
    refetchOnWindowFocus: false,
  });
}

export function useUpdateWaitlistSettings(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (patch: Partial<WaitlistSettings>) => {
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
