import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { UnitAddress } from "@/types/reserva";

export interface PublicUnitCard {
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

const SELECT =
  "id, name, slug, description, price_range_min, price_range_max, hero_image_url, logo_url, address";

export function usePublicCities() {
  return useQuery({
    queryKey: ["public-cities"],
    queryFn: async (): Promise<string[]> => {
      const { data, error } = await supabase
        .from("units")
        .select("address")
        .eq("is_public", true);
      if (error) throw error;
      const set = new Set<string>();
      for (const row of data ?? []) {
        const city = (row.address as UnitAddress | null)?.city?.trim();
        if (city) set.add(city);
      }
      return Array.from(set).sort((a, b) => a.localeCompare(b, "pt-BR"));
    },
    staleTime: 5 * 60 * 1000,
  });
}

export interface DiscoverFilters {
  city: string | null;
  search: string;
}

export function usePublicUnits({ city, search }: DiscoverFilters) {
  const trimmedSearch = search.trim();
  return useQuery({
    queryKey: ["public-units", city ?? "any", trimmedSearch.toLowerCase()],
    queryFn: async (): Promise<PublicUnitCard[]> => {
      let query = supabase
        .from("units")
        .select(SELECT)
        .eq("is_public", true)
        .order("name", { ascending: true });

      if (trimmedSearch) {
        query = query.ilike("name", `%${trimmedSearch}%`);
      }

      const { data, error } = await query;
      if (error) throw error;
      const all = (data ?? []) as PublicUnitCard[];
      if (!city) return all;
      const wanted = city.toLowerCase();
      return all.filter(
        (u) => (u.address?.city ?? "").trim().toLowerCase() === wanted
      );
    },
    staleTime: 60 * 1000,
  });
}

export function useFeaturedHero() {
  return useQuery({
    queryKey: ["featured-hero"],
    queryFn: async (): Promise<string | null> => {
      const { data, error } = await supabase
        .from("units")
        .select("hero_image_url")
        .eq("is_public", true)
        .not("hero_image_url", "is", null)
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data?.hero_image_url as string | null) ?? null;
    },
    staleTime: 10 * 60 * 1000,
  });
}
