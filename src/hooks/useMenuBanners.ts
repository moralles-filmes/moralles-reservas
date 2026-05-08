import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { MenuBanner, MenuBannerType } from "@/types/reserva";

export function useMenuBanners(unitId: string, type: MenuBannerType) {
  return useQuery({
    queryKey: ["menu-banners", unitId, type],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("menu_banners")
        .select("*")
        .eq("unit_id", unitId)
        .eq("type", type)
        .order("sort_order", { ascending: true });
      if (error) throw error;
      return data as MenuBanner[];
    },
    enabled: !!unitId,
  });
}

export interface UpsertMenuBannerInput {
  id?: string;
  image_url: string;
  link_url?: string | null;
  active?: boolean;
  sort_order?: number;
}

export function useCreateMenuBanner(unitId: string, type: MenuBannerType) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpsertMenuBannerInput) => {
      const { data, error } = await supabase
        .from("menu_banners")
        .insert({
          unit_id: unitId,
          type,
          image_url: input.image_url,
          link_url: input.link_url ?? null,
          active: input.active ?? false,
          sort_order: input.sort_order ?? 0,
        })
        .select()
        .single();
      if (error) throw error;
      return data as MenuBanner;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["menu-banners", unitId, type] });
    },
  });
}

export function useUpdateMenuBanner(unitId: string, type: MenuBannerType) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: { id: string } & Partial<{
        image_url: string;
        link_url: string | null;
        active: boolean;
        sort_order: number;
      }>,
    ) => {
      const { id, ...patch } = input;
      const { error } = await supabase
        .from("menu_banners")
        .update(patch)
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["menu-banners", unitId, type] });
    },
  });
}

export function useDeleteMenuBanner(unitId: string, type: MenuBannerType) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("menu_banners").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["menu-banners", unitId, type] });
    },
  });
}
