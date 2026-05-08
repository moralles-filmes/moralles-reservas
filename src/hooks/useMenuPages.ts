import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { MenuPage } from "@/types/reserva";

export function useMenuPages(menuId: string | undefined) {
  return useQuery({
    queryKey: ["menu-pages", menuId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("menu_pages")
        .select("*")
        .eq("menu_id", menuId!)
        .order("sort_order", { ascending: true });
      if (error) throw error;
      return data as MenuPage[];
    },
    enabled: !!menuId,
  });
}

export function useAddMenuPage(menuId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { image_url: string; sort_order?: number }) => {
      const { error } = await supabase.from("menu_pages").insert({
        menu_id: menuId,
        image_url: input.image_url,
        sort_order: input.sort_order ?? 0,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["menu-pages", menuId] });
    },
  });
}

export function useDeleteMenuPage(menuId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("menu_pages").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["menu-pages", menuId] });
    },
  });
}

/** Atualiza sort_order de uma lista inteira. Usado após drag&drop. */
export function useReorderMenuPages(menuId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (orderedIds: string[]) => {
      // upsert em batch — preserva os outros campos (image_url, menu_id) via primary key
      const updates = orderedIds.map((id, idx) =>
        supabase.from("menu_pages").update({ sort_order: idx }).eq("id", id),
      );
      const results = await Promise.all(updates);
      const firstError = results.find((r) => r.error);
      if (firstError?.error) throw firstError.error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["menu-pages", menuId] });
    },
  });
}
