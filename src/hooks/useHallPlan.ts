import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { toSavePayload } from "@/lib/hall-plan-core";
import { TABLE_COLUMNS } from "@/hooks/useHallTables";
import type { Hall, Mesa } from "@/types/reserva";

export type SaveHallPlanPayload = ReturnType<typeof toSavePayload>;

/** Salão e mesas ativas dele, com a planta. */
export function useHallPlanData(unitId: string, hallId: string) {
  return useQuery({
    queryKey: ["hall-plan", unitId, hallId],
    queryFn: async () => {
      const [hallRes, tablesRes] = await Promise.all([
        supabase.from("halls").select("*").eq("id", hallId).eq("unit_id", unitId).single(),
        supabase
          .from("tables")
          .select(TABLE_COLUMNS)
          .eq("unit_id", unitId)
          .eq("hall_id", hallId)
          .eq("active", true)
          .order("number", { ascending: true }),
      ]);
      if (hallRes.error) throw hallRes.error;
      if (tablesRes.error) throw tablesRes.error;
      return { hall: hallRes.data as Hall, tables: (tablesRes.data ?? []) as Mesa[] };
    },
    enabled: !!unitId && !!hallId,
  });
}

export function useSaveHallPlan(unitId: string, hallId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ expectedUpdatedAt, payload }: { expectedUpdatedAt: string; payload: SaveHallPlanPayload }) => {
      // A revisão vai como a string que o PostgREST devolveu: passar por Date perde os
      // microssegundos e a RPC recusaria todo salvamento com 40001.
      const { data, error } = await supabase.rpc("save_hall_plan", {
        p_hall_id: hallId,
        p_expected_updated_at: expectedUpdatedAt,
        p_hall: payload.p_hall,
        p_tables: payload.p_tables,
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["hall-plan", unitId, hallId] });
      qc.invalidateQueries({ queryKey: ["hall", hallId] });
      qc.invalidateQueries({ queryKey: ["hall-tables", hallId] });
      qc.invalidateQueries({ queryKey: ["salao-ao-vivo", unitId] });
    },
  });
}

export function hallPlanErrorMessage(err: unknown): string {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code === "string") {
    if (code === "40001") return "A planta foi alterada por outra pessoa. Recarregue para ver a versão atual.";
    if (code === "42501") return "Você não tem permissão para editar esta planta.";
  }
  return "Não foi possível salvar a planta. Tente de novo.";
}
