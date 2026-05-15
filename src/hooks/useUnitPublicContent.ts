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
  is_public: boolean;
  cnpj: string | null;
  financial_email: string | null;
  cuisine_types: string[];
  opening_hours_text: string | null;
  payment_methods: string | null;
  facilities: string[];
  phone: string | null;
  instagram: string | null;
  website: string | null;
  timezone: string;
}

const SELECT =
  "id, name, slug, description, price_range_min, price_range_max, hero_image_url, logo_url, address, is_public, cnpj, financial_email, cuisine_types, opening_hours_text, payment_methods, facilities, phone, instagram, website, timezone";

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
      if (!data) return null;
      const row = data as Record<string, unknown>;
      return {
        ...row,
        cuisine_types: Array.isArray(row.cuisine_types) ? (row.cuisine_types as string[]) : [],
        facilities: Array.isArray(row.facilities) ? (row.facilities as string[]) : [],
      } as UnitPublicContent;
    },
    enabled: !!unitId,
    refetchOnWindowFocus: false,
  });
}

export interface UpdateUnitContentPayload {
  description?: string | null;
  price_range_min?: number | null;
  price_range_max?: number | null;
  hero_image_url?: string | null;
  logo_url?: string | null;
  address?: UnitAddress | null;
  is_public?: boolean;
  cnpj?: string | null;
  financial_email?: string | null;
  cuisine_types?: string[];
  opening_hours_text?: string | null;
  payment_methods?: string | null;
  facilities?: string[];
  phone?: string | null;
  instagram?: string | null;
  website?: string | null;
  timezone?: string;
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
      queryClient.invalidateQueries({ queryKey: ["public-units"] });
      queryClient.invalidateQueries({ queryKey: ["public-cities"] });
      toast.success("Conta atualizada.");
    },
    onError: (err: Error) => {
      toast.error(err.message || "Erro ao salvar.");
    },
  });
}

export type { Unit };
