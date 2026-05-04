import { useParams, useNavigate } from "react-router-dom";
import { useEffect } from "react";
import { useAuth } from "@/hooks/useAuth";
import type { UserMembership } from "@/hooks/useAuth";
import type { UnitRole } from "@/types/reserva";

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
  const { memberships, loading } = useAuth();
  const navigate = useNavigate();

  const slug = unitSlug ?? localStorage.getItem(LAST_UNIT_KEY) ?? "";
  const membership = memberships.find((m) => m.unit_slug === slug) ?? memberships[0] ?? null;

  useEffect(() => {
    if (!loading && membership) {
      localStorage.setItem(LAST_UNIT_KEY, membership.unit_slug);
    }
  }, [loading, membership]);

  useEffect(() => {
    if (!loading && memberships.length === 0 && !membership) {
      navigate("/admin/login");
    }
  }, [loading, memberships, membership, navigate]);

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
