import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { Menu, MenuTheme } from "@/types/reserva";

const SLUG_ALPHABET = "abcdefghijkmnopqrstuvwxyz23456789";

export function generateMenuSlug(): string {
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += SLUG_ALPHABET[Math.floor(Math.random() * SLUG_ALPHABET.length)];
  }
  return out;
}

async function ensureUniqueSlug(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = generateMenuSlug();
    const { data } = await supabase
      .from("menus")
      .select("id")
      .eq("slug", slug)
      .maybeSingle();
    if (!data) return slug;
  }
  return `${generateMenuSlug()}${Date.now().toString(36).slice(-2)}`;
}

export function useMenus(unitId: string) {
  return useQuery({
    queryKey: ["menus", unitId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("menus")
        .select("*")
        .eq("unit_id", unitId)
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as Menu[];
    },
    enabled: !!unitId,
  });
}

export function useMenu(menuId: string | undefined) {
  return useQuery({
    queryKey: ["menu", menuId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("menus")
        .select("*")
        .eq("id", menuId!)
        .single();
      if (error) throw error;
      return data as Menu;
    },
    enabled: !!menuId,
  });
}

export interface CreateMenuInput {
  name: string;
  cover_image_url?: string | null;
}

export function useCreateMenu(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateMenuInput) => {
      const slug = await ensureUniqueSlug();
      const { data, error } = await supabase
        .from("menus")
        .insert({
          unit_id: unitId,
          slug,
          name: input.name,
          cover_image_url: input.cover_image_url ?? null,
        })
        .select()
        .single();
      if (error) throw error;
      return data as Menu;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["menus", unitId] });
    },
  });
}

export function useUpdateMenu(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: { id: string } & Partial<{
        name: string;
        cover_image_url: string | null;
        theme: MenuTheme;
        active: boolean;
        sort_order: number;
      }>,
    ) => {
      const { id, ...patch } = input;
      const { data, error } = await supabase
        .from("menus")
        .update(patch)
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data as Menu;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["menus", unitId] });
      queryClient.invalidateQueries({ queryKey: ["menu", data.id] });
    },
  });
}

export function useDeleteMenu(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("menus").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["menus", unitId] });
    },
  });
}
