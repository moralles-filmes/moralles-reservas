import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { ReservationWidget, WidgetFieldConfigMap } from "@/types/reserva";

const SLUG_ALPHABET = "abcdefghijkmnopqrstuvwxyz23456789";

export function generateWidgetSlug(): string {
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += SLUG_ALPHABET[Math.floor(Math.random() * SLUG_ALPHABET.length)];
  }
  return out;
}

export function useWidgets(unitId: string) {
  return useQuery({
    queryKey: ["widgets", unitId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("reservation_widgets")
        .select("*")
        .eq("unit_id", unitId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as ReservationWidget[];
    },
    enabled: !!unitId,
  });
}

export function useWidget(widgetId: string | undefined) {
  return useQuery({
    queryKey: ["widget", widgetId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("reservation_widgets")
        .select("*")
        .eq("id", widgetId!)
        .single();
      if (error) throw error;
      return data as ReservationWidget;
    },
    enabled: !!widgetId,
  });
}

async function ensureUniqueSlug(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = generateWidgetSlug();
    const { data } = await supabase
      .from("reservation_widgets")
      .select("id")
      .eq("slug", slug)
      .maybeSingle();
    if (!data) return slug;
  }
  // Fallback extremamente improvável; usa timestamp pra garantir unicidade.
  return `${generateWidgetSlug()}${Date.now().toString(36).slice(-2)}`;
}

export function useCreateWidget(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { name: string }) => {
      const slug = await ensureUniqueSlug();
      const { data, error } = await supabase
        .from("reservation_widgets")
        .insert({
          unit_id: unitId,
          slug,
          name: input.name,
          field_config: {},
        })
        .select()
        .single();
      if (error) throw error;
      return data as ReservationWidget;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["widgets", unitId] });
    },
  });
}

export function useUpdateWidget(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: { id: string } & Partial<{
        name: string;
        field_config: WidgetFieldConfigMap;
        client_instructions: string | null;
        show_menu_banner: boolean;
        active: boolean;
      }>,
    ) => {
      const { id, ...patch } = input;
      const { data, error } = await supabase
        .from("reservation_widgets")
        .update(patch)
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data as ReservationWidget;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["widgets", unitId] });
      queryClient.invalidateQueries({ queryKey: ["widget", data.id] });
    },
  });
}

export function useDeleteWidget(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("reservation_widgets").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["widgets", unitId] });
    },
  });
}
