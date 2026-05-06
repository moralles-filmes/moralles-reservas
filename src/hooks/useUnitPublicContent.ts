import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";
import type { Unit, UnitAddress } from "@/types/reserva";

export interface UnitPublicContent {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  price_range_min: number | null;
  price_range_max: number | null;
  hero_image_url: string | null;
  logo_url: string | null;
  address: UnitAddress | null;
}

const SELECT = "id, name, slug, description, price_range_min, price_range_max, hero_image_url, logo_url, address";

export function useUnitPublicContent(unitId: string) {
  return useQuery({
    queryKey: ["unit-public-content", unitId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("units")
        .select(SELECT)
        .eq("id", unitId)
        .maybeSingle();
      if (error) throw error;
      return data as UnitPublicContent | null;
    },
    enabled: !!unitId,
  });
}

export interface UpdateUnitContentPayload {
  description?: string | null;
  price_range_min?: number | null;
  price_range_max?: number | null;
  hero_image_url?: string | null;
  logo_url?: string | null;
  address?: UnitAddress | null;
}

export function useUpdateUnitPublicContent(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: UpdateUnitContentPayload) => {
      const { error } = await supabase
        .from("units")
        .update(payload)
        .eq("id", unitId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["unit-public-content", unitId] });
      queryClient.invalidateQueries({ queryKey: ["public-unit"] });
      toast.success("Página pública atualizada.");
    },
    onError: (err: Error) => {
      toast.error(err.message || "Erro ao salvar.");
    },
  });
}

export type { Unit };
