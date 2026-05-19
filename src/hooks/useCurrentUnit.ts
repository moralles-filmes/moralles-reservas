import { useParams, useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import type { UserMembership } from "@/hooks/useAuth";
import type { UnitRole } from "@/types/reserva";
import { supabase } from "@/lib/supabase";

const LAST_UNIT_KEY = "moralles:lastUnitSlug";

export interface CurrentUnit {
  membership: UserMembership;
  unit_id: string;
  unit_slug: string;
  unit_name: string;
  organization_id: string;
  organization_slug: string;
  role: UnitRole;
  isOwner: boolean;
  isGerente: boolean;
}

export function useCurrentUnit(): CurrentUnit | null {
  const { unitSlug } = useParams<{ unitSlug: string }>();
  const { memberships, loading, isPlatformAdmin } = useAuth();
  const navigate = useNavigate();

  const slug = unitSlug ?? localStorage.getItem(LAST_UNIT_KEY) ?? "";
  const membershipFromList = memberships.find((m) => m.unit_slug === slug);

  // Platform admin may not be a unit_member of the target unit.
  // Fetch unit info directly when the slug isn't in their memberships.
  const [platformUnit, setPlatformUnit] = useState<UserMembership | null>(null);

  useEffect(() => {
    if (loading || membershipFromList || !isPlatformAdmin || !slug) {
      setPlatformUnit(null);
      return;
    }

    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("units")
        .select("id, slug, name, organization_id, organization:organizations(id, slug)")
        .eq("slug", slug)
        .single();

      if (cancelled || !data) return;
      setPlatformUnit({
        unit_id: data.id,
        unit_slug: data.slug,
        unit_name: data.name,
        organization_id: data.organization_id,
        organization_slug: (data.organization as any)?.slug ?? "",
        role: "owner" as UnitRole,
      });
    })();

    return () => { cancelled = true; };
  }, [loading, membershipFromList, isPlatformAdmin, slug]);

  const membership = membershipFromList ?? platformUnit ?? (isPlatformAdmin ? null : memberships[0]) ?? null;

  useEffect(() => {
    if (!loading && membership) {
      localStorage.setItem(LAST_UNIT_KEY, membership.unit_slug);
    }
  }, [loading, membership]);

  useEffect(() => {
    if (!loading && memberships.length === 0 && !isPlatformAdmin && !membership) {
      // Vai pra /admin (não /admin/login) — o AuthContext desloga e redireciona
      // pra login se realmente é órfão. Login direto causaria loop: Auth.tsx
      // joga user logado de volta em /admin.
      navigate("/admin");
    }
  }, [loading, memberships, isPlatformAdmin, membership, navigate]);

  if (!membership) return null;

  return {
    membership,
    unit_id: membership.unit_id,
    unit_slug: membership.unit_slug,
    unit_name: membership.unit_name,
    organization_id: membership.organization_id,
    organization_slug: membership.organization_slug,
    role: membership.role,
    isOwner: membership.role === "owner",
    isGerente: membership.role === "owner" || membership.role === "gerente",
  };
}
