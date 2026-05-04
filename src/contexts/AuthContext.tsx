import { createContext, useContext, useEffect, useState } from "react";
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

interface AuthState {
  user: User | null;
  loading: boolean;
  memberships: UserMembership[];
  isPlatformAdmin: boolean;
  defaultUnitSlug: string | null;
  isAdmin: boolean;
  isSuperAdmin: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  updateEmail: (newEmail: string) => Promise<void>;
  updatePassword: (newPassword: string) => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [memberships, setMemberships] = useState<UserMembership[]>([]);
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);

  useEffect(() => {
    let initialSessionHandled = false;

    const loadMemberships = async (u: User | null) => {
      if (!u) {
        setMemberships([]);
        setIsPlatformAdmin(false);
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

    // onAuthStateChange fires INITIAL_SESSION on mount — use it as the single
    // source of truth so we don't call loadMemberships twice on startup.
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      setUser(session?.user ?? null);

      if (!session?.user) {
        setMemberships([]);
        setIsPlatformAdmin(false);
        setLoading(false);
        return;
      }

      await loadMemberships(session.user);

      // Mark loading done only after the first session event resolves
      if (!initialSessionHandled) {
        initialSessionHandled = true;
        setLoading(false);
      }
    });

    return () => subscription.unsubscribe();
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

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        memberships,
        isPlatformAdmin,
        defaultUnitSlug: defaultMembership?.unit_slug ?? null,
        isAdmin: !!user,
        isSuperAdmin: isPlatformAdmin || memberships.some((m) => m.role === "owner"),
        signIn,
        signOut,
        updateEmail,
        updatePassword,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
