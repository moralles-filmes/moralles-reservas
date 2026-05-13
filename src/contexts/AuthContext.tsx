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
  refreshMemberships: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

async function loadMembershipsFor(u: User) {
  const [{ data: members, error: e1 }, { data: platformAdmin, error: e2 }] = await Promise.all([
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

  if (e1) console.error("[auth] unit_members query failed:", e1);
  if (e2) console.error("[auth] platform_admins query failed:", e2);

  const parsed: UserMembership[] = (members ?? []).map((m: any) => ({
    unit_id: m.unit_id,
    unit_slug: m.unit?.slug ?? "",
    unit_name: m.unit?.name ?? "",
    organization_id: m.unit?.organization_id ?? "",
    organization_slug: m.unit?.organization?.slug ?? "",
    role: m.role as UnitRole,
  }));

  return { memberships: parsed, isPlatformAdmin: !!platformAdmin };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [memberships, setMemberships] = useState<UserMembership[]>([]);
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);

  useEffect(() => {
    const loadMemberships = async (u: User) => {
      try {
        const { memberships: parsed, isPlatformAdmin: pa } = await loadMembershipsFor(u);
        setMemberships(parsed);
        setIsPlatformAdmin(pa);
      } catch (err) {
        console.error("[auth] loadMemberships failed:", err);
        setMemberships([]);
        setIsPlatformAdmin(false);
      }
    };

    // `settled` = first auth event has resolved. Loading is always released on
    // the first event (whatever its name) and re-entered only when a *different*
    // user signs in, so AdminRedirect can wait for memberships. SIGNED_IN events
    // for the same user (token refresh, tab refocus) must NOT trigger loading —
    // doing so would unmount the route tree and discard unsaved form state.
    let settled = false;
    let currentUserId: string | null = null;

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      const nextUserId = session?.user?.id ?? null;
      if (event === "SIGNED_IN" && nextUserId !== currentUserId) setLoading(true);
      currentUserId = nextUserId;
      setUser(session?.user ?? null);

      // Defer Supabase queries out of the auth callback. Calling authenticated
      // queries from inside this callback deadlocks the SDK's internal lock
      // (https://github.com/supabase/auth-js/issues/762).
      setTimeout(async () => {
        try {
          if (session?.user) {
            await loadMemberships(session.user);
          } else {
            setMemberships([]);
            setIsPlatformAdmin(false);
          }
        } finally {
          if (!settled || event === "SIGNED_IN") {
            settled = true;
            setLoading(false);
          }
        }
      }, 0);
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

  const refreshMemberships = async () => {
    if (!user) return;
    try {
      const { memberships: parsed, isPlatformAdmin: pa } = await loadMembershipsFor(user);
      setMemberships(parsed);
      setIsPlatformAdmin(pa);
    } catch (err) {
      console.error("[auth] refreshMemberships failed:", err);
    }
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
        refreshMemberships,
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
