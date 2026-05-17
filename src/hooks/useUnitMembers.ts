import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";
import type { UnitRole } from "@/types/reserva";

export interface UnitMemberRow {
  id: string;
  user_id: string;
  unit_id: string;
  role: UnitRole;
  created_at: string;
  email: string | null;
  name: string | null;
}

export function useUnitMembers(unitId: string) {
  return useQuery({
    queryKey: ["unit-members", unitId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("unit_members")
        .select("*")
        .eq("unit_id", unitId)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return data as UnitMemberRow[];
    },
    enabled: !!unitId,
    staleTime: 30_000,
  });
}

async function invokeManageMembers(body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke("manage-members", { body });
  if (error) {
    let detail: string | undefined;
    const ctx = (error as { context?: unknown }).context;
    if (ctx instanceof Response) {
      try {
        const parsed = await ctx.clone().json();
        if (parsed && typeof parsed === "object" && "error" in parsed) {
          detail = String((parsed as { error: unknown }).error);
        }
      } catch {
        // body não-JSON: cai no fallback
      }
    }
    throw new Error(detail ?? error.message ?? "Erro inesperado.");
  }
  if (data && typeof data === "object" && "error" in data && data.error) {
    throw new Error(String(data.error));
  }
  return data;
}

export function useCreateUnitMember(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      email,
      password,
      role,
      name,
    }: {
      email: string;
      password: string;
      role: UnitRole;
      name?: string | null;
    }) => {
      return invokeManageMembers({
        action: "create_member",
        unit_id: unitId,
        email,
        password,
        role,
        name: name ?? null,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["unit-members", unitId] });
    },
    onError: (err: Error) => toast.error(err.message),
  });
}

export function useUpdateMemberName(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      memberId,
      name,
    }: {
      memberId: string;
      name: string | null;
    }) => {
      return invokeManageMembers({
        action: "update_member",
        unit_id: unitId,
        member_id: memberId,
        name,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["unit-members", unitId] });
      toast.success("Nome atualizado.");
    },
    onError: (err: Error) => toast.error(err.message),
  });
}

export function useDeleteUnitMember(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (memberId: string) => {
      return invokeManageMembers({ action: "delete_member", unit_id: unitId, member_id: memberId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["unit-members", unitId] });
      toast.success("Membro removido.");
    },
    onError: (err: Error) => toast.error(err.message),
  });
}

export function useUpdateMemberRole(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ memberId, role }: { memberId: string; role: UnitRole }) => {
      return invokeManageMembers({ action: "update_role", unit_id: unitId, member_id: memberId, role });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["unit-members", unitId] });
      toast.success("Papel atualizado.");
    },
    onError: (err: Error) => toast.error(err.message),
  });
}
