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
  email?: string;
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
  });
}

async function invokeManageMembers(body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke("manage-members", { body });
  if (error) {
    const message =
      (data as { error?: string } | null)?.error ?? error.message ?? "Erro inesperado.";
    throw new Error(message);
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
    }: {
      email: string;
      password: string;
      role: UnitRole;
    }) => {
      return invokeManageMembers({ action: "create_member", unit_id: unitId, email, password, role });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["unit-members", unitId] });
      toast.success("Membro cadastrado.");
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
