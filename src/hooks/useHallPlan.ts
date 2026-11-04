import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchHallPlan, saveHallPlan, type SaveHallPlanArgs } from "@/features/planta/api";

export type SaveHallPlanPayload = SaveHallPlanArgs;

/** Salão e mesas ativas dele, com a planta. */
export function useHallPlanData(unitId: string, hallId: string) {
  return useQuery({
    queryKey: ["hall-plan", unitId, hallId],
    queryFn: () => fetchHallPlan(unitId, hallId),
    enabled: !!unitId && !!hallId,
  });
}

export function useSaveHallPlan(unitId: string, hallId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ expectedUpdatedAt, payload }: { expectedUpdatedAt: string; payload: SaveHallPlanPayload }) =>
      saveHallPlan(hallId, expectedUpdatedAt, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["hall-plan", unitId, hallId] });
      qc.invalidateQueries({ queryKey: ["hall", unitId, hallId] });
      qc.invalidateQueries({ queryKey: ["hall-tables", unitId, hallId] });
      qc.invalidateQueries({ queryKey: ["salao-ao-vivo", unitId] });
    },
  });
}

export function hallPlanErrorMessage(err: unknown): string {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code === "string") {
    if (code === "40001") return "A planta foi alterada por outra pessoa. Recarregue para ver a versão atual.";
    const message = (err as { message?: unknown }).message;
    if (code === "42501" && typeof message === "string" && message.includes("combination_invalid")) return "Uma combinação tem mesa fora de reserva ou inativa. Revise as combinações.";
    if (code === "22023") return "A planta tem dados inválidos. Recarregue e tente de novo.";
    if (code === "42501") return "Você não tem permissão para editar esta planta.";
  }
  return "Não foi possível salvar a planta. Tente de novo.";
}
