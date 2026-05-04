import { useState, useEffect } from "react";
import { supabase } from "@/lib/supabase";
import type { User } from "@supabase/supabase-js";
import type { UnitRole } from "@/types/reserva";

export interface UserMembership {
  unit_id: string;
  unit_slug: string;
  unit_name: string;
  organization_id: string;
  organization_slug: string;
  role: UnitRole;
}

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [memberships, setMemberships] = useState<UserMembership[]>([]);
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);

  useEffect(() => {
    let active = true;

    const loadMemberships = async (u: User | null) => {
      if (!u) {
        if (active) {
          setMemberships([]);
          setIsPlatformAdmin(false);
        }
        return;
      }

      const [{ data: members }, { data: platformAdmin }] = await Promise.all([
        supabase
          .from("unit_members")
          .select("role, unit_id, unit:units(id, slug, name, organization_id, organization:organizations(id, slug))")
          .eq("user_id", u.id),
        supabase
          .from("platform_admins")
          .select("user_id")
          .eq("user_id", u.id)
          .maybeSingle(),
      ]);

      if (!active) return;

      const parsed: UserMembership[] = (members ?? []).map((m: any) => ({
        unit_id: m.unit_id,
        unit_slug: m.unit?.slug ?? "",
        unit_name: m.unit?.name ?? "",
        organization_id: m.unit?.organization_id ?? "",
        organization_slug: m.unit?.organization?.slug ?? "",
        role: m.role as UnitRole,
      }));

      setMemberships(parsed);
      setIsPlatformAdmin(!!platformAdmin);
    };

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!active) return;
      setUser(session?.user ?? null);
      setLoading(false);
      loadMemberships(session?.user ?? null);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_, session) => {
      setUser(session?.user ?? null);
      loadMemberships(session?.user ?? null);
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  };

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  const updateEmail = async (newEmail: string) => {
    const { error } = await supabase.auth.updateUser({ email: newEmail });
    if (error) throw error;
  };

  const updatePassword = async (newPassword: string) => {
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) throw error;
  };

  const defaultMembership = memberships[0] ?? null;

  return {
    user,
    loading,
    memberships,
    isPlatformAdmin,
    defaultUnitSlug: defaultMembership?.unit_slug ?? null,
    signIn,
    signOut,
    updateEmail,
    updatePassword,
    isAdmin: !!user,
    // backward-compat durante rollout — remover após frontend completo
    isSuperAdmin: isPlatformAdmin || memberships.some((m) => m.role === "owner"),
  };
}
