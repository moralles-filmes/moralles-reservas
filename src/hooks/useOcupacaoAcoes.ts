import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { setOccupantTables, setOccupantPartySize } from "@/features/planta/api";
import type { OccupantRef } from "@/lib/seat-pick-core";

/** Mensagem em PT-BR para o erro das RPCs de ocupação (`code` e `message` do PostgREST). */
export function seatActionErrorMessage(err: unknown): string {
  const e = (err ?? {}) as { code?: string; message?: string };
  if (e.code === "42501") return "Sem permissão para esta mesa.";
  if (e.message === "seat_taken") return "Essa mesa acabou de ser ocupada em outro aparelho.";
  if (e.message === "seat_blocked") return "Essa mesa está bloqueada nesse horário.";
  if (e.message === "seat_action_invalid") return "Essa ocupação não pode mais ser alterada. Recarregue a tela.";
  return "Não foi possível atualizar a mesa. Recarregue a tela.";
}

function useCallbacks(unitId: string) {
  const client = useQueryClient();
  return {
    onError: (err: unknown) => {
      toast.error(seatActionErrorMessage(err));
    },
    onSettled: () =>
      Promise.all(
        ["reservas", "walk-ins", "waitlist", "occupant-tables"].map(key =>
          client.invalidateQueries({ queryKey: [key, unitId] }),
        ),
      ),
  };
}

/** Põe o ocupante nas mesas dadas; `allowOverlap` só vai depois da confirmação de conflito. */
export function useSetOccupantTables(unitId: string) {
  return useMutation({
    mutationFn: ({
      occupant,
      tableIds,
      allowOverlap,
    }: {
      occupant: OccupantRef;
      tableIds: string[];
      allowOverlap?: boolean;
    }) => setOccupantTables(occupant, tableIds, allowOverlap),
    ...useCallbacks(unitId),
  });
}

/** Ajusta o número de pessoas do ocupante; o resultado diz se algo mudou. */
export function useSetOccupantPartySize(unitId: string) {
  return useMutation({
    mutationFn: ({ occupant, partySize }: { occupant: OccupantRef; partySize: number }) =>
      setOccupantPartySize(occupant, partySize),
    ...useCallbacks(unitId),
  });
}
