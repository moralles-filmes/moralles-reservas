import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

export interface UnitWithOrg {
  id: string;
  slug: string;
  name: string;
  organization_id: string;
  organization_name: string;
  organization_slug: string;
  default_whatsapp_provider?: import('@/types/reserva').WhatsAppProvider;
}

export function useAllUnits() {
  return useQuery<UnitWithOrg[]>({
    queryKey: ["all-units"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("units")
        .select("id, slug, name, organization_id, organization:organizations(name, slug, default_whatsapp_provider)")
        .order("name", { ascending: true });

      if (error) throw error;

      return (data ?? []).map((u: any) => ({
        id: u.id,
        slug: u.slug,
        name: u.name,
        organization_id: u.organization_id,
        organization_name: u.organization?.name ?? "",
        organization_slug: u.organization?.slug ?? "",
        default_whatsapp_provider: u.organization?.default_whatsapp_provider,
      }));
    },
  });
}

export function useUnitBySlug(slug: string | undefined) {
  return useQuery<UnitWithOrg | null>({
    queryKey: ["unit-by-slug", slug],
    enabled: !!slug,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("units")
        .select("id, slug, name, organization_id, organization:organizations(name, slug, default_whatsapp_provider)")
        .eq("slug", slug!)
        .maybeSingle();

      if (error) throw error;
      if (!data) return null;

      const u = data as any;
      return {
        id: u.id,
        slug: u.slug,
        name: u.name,
        organization_id: u.organization_id,
        organization_name: u.organization?.name ?? "",
        organization_slug: u.organization?.slug ?? "",
        default_whatsapp_provider: u.organization?.default_whatsapp_provider,
      };
    },
  });
}
