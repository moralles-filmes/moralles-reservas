import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";

export interface AdminUser {
  id: string;
  email: string;
  role: "admin" | "super_admin";
  created_at: string;
  created_by: string | null;
}

export function useAdminUsers() {
  return useQuery({
    queryKey: ["admin-users"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("admin_users")
        .select("*")
        .order("created_at", { ascending: true });
      if (error) throw error;
      return data as AdminUser[];
    },
  });
}

async function invokeManageAdmins(body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke("manage-admins", { body });
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

export function useCreateAdmin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ email, password }: { email: string; password: string }) => {
      return invokeManageAdmins({ action: "create_admin", email, password });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      toast.success("Administrador cadastrado.");
    },
    onError: (err: Error) => toast.error(err.message),
  });
}

export function useDeleteAdmin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      return invokeManageAdmins({ action: "delete_admin", id });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      toast.success("Administrador removido.");
    },
    onError: (err: Error) => toast.error(err.message),
  });
}
