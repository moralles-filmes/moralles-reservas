import { fetchAllPages } from "@/lib/fetch-all-pages";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";
import type { WalkIn, WalkInStatus } from "@/types/reserva";

// Pausa polling quando a aba está em background — em tablets de salão (8h+
// abertos), 30s × 8h = 960 requisições/dia sem ninguém olhando a tela.
const pollWhenVisible = () =>
  typeof document !== "undefined" && document.hidden ? false : 30_000;

export function useWalkIns(unitId: string, onlyActive = true) {
  return useQuery({
    queryKey: ["walk-ins", unitId, onlyActive],
    queryFn: async () => {
      const data = await fetchAllPages((from, to) => {
        let query = supabase
          .from("walk_ins")
          .select("*, table:tables(number)")
          .eq("unit_id", unitId)
          .order("arrived_at", { ascending: true })
          .order("id", { ascending: true });

        if (onlyActive) {
          // Liberados seguem `seated` para sempre: sem este filtro a lista ativa cresce sem limite.
          query = query.in("status", ["waiting", "seated"]).is("released_at", null);
        }

        return query.range(from, to);
      });
      return data as WalkIn[];
    },
    enabled: !!unitId,
    refetchInterval: pollWhenVisible,
  });
}

export function useCreateWalkIn(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      customer_name: string;
      customer_phone?: string | null;
      party_size: number;
      notes?: string | null;
      table_id?: string | null;
      /** Já nasce sentado na mesa: status, seated_at e table_id numa linha só. */
      seated?: boolean;
    }) => {
      const { seated, ...fields } = payload;
      const { error } = await supabase.from("walk_ins").insert({
        ...fields,
        ...(seated ? { status: "seated", seated_at: new Date().toISOString() } : {}),
        // Por último: o tenant é o da tela, nunca um campo que veio no payload.
        unit_id: unitId,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["walk-ins", unitId] });
      toast.success("Passante registrado.");
    },
    onError: () => toast.error("Erro ao registrar passante."),
  });
}

export const STALE_WALKIN_MESSAGE = "Esse passante já foi atualizado em outro aparelho.";

/** UPDATE/DELETE casou zero linhas: outro aparelho já mudou o passante. */
export class StaleWalkInError extends Error {
  constructor() {
    super(STALE_WALKIN_MESSAGE);
    this.name = "StaleWalkInError";
  }
}

const WALKIN_STATUS_TOAST: Record<WalkInStatus, string> = {
  waiting: "Status atualizado.",
  seated: "Cliente sentado.",
  left: "Marcado como saiu.",
  no_show: "Marcado como não compareceu.",
};

export function useUpdateWalkInStatus(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, status, table_id }: { id: string; status: WalkInStatus; table_id?: string | null }) => {
      const updates: Record<string, unknown> = { status };
      if (status === "seated") updates.seated_at = new Date().toISOString();
      if (table_id !== undefined) updates.table_id = table_id;

      const { data, error } = await supabase
        .from("walk_ins")
        .update(updates)
        .eq("id", id)
        .eq("unit_id", unitId)
        .eq("status", "waiting")
        .select("id");
      if (error) throw error;
      if (!data || data.length === 0) throw new StaleWalkInError();
      return { status };
    },
    onSuccess: (result) => {
      toast.success(WALKIN_STATUS_TOAST[result.status] ?? "Status atualizado.");
    },
    onError: (err: Error) =>
      toast.error(err instanceof StaleWalkInError ? STALE_WALKIN_MESSAGE : err.message || "Erro ao atualizar status."),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["walk-ins", unitId] }),
  });
}

export function useDeleteWalkIn(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase
        .from("walk_ins")
        .delete()
        .eq("id", id)
        .eq("unit_id", unitId)
        .select("id");
      if (error) throw error;
      if (!data || data.length === 0) throw new StaleWalkInError();
    },
    onError: (err: Error) => toast.error(err instanceof StaleWalkInError ? STALE_WALKIN_MESSAGE : "Erro ao remover."),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["walk-ins", unitId] }),
  });
}
