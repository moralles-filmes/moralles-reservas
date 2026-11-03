import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  releaseWaitlistEntry,
  releaseWalkIn,
  seatWaitlistEntry,
  setReservationPresence,
  type PresenceAction,
} from "@/features/planta/api";

export type { PresenceAction };

const FALLBACK = "Não foi possível atualizar a mesa. Recarregue a tela.";

const CHECK_MESSAGES: Record<string, string> = {
  arrival_not_allowed: "Só dá para marcar chegada de reserva pendente ou confirmada de hoje.",
  release_requires_arrival: "Marque a chegada antes de liberar a mesa.",
  presence_final: "Esta mesa já foi liberada.",
  not_seatable: "Este cliente não está mais aguardando na fila.",
  not_seated: "Este cliente não está sentado.",
};

/** Mensagem em PT-BR para o erro das RPCs de presença (`code` e `details` do PostgREST). */
export function presenceErrorMessage(err: unknown): string {
  const e = (err ?? {}) as { code?: unknown; details?: unknown };
  if (e.code === "42501") return "Sem permissão para esta mesa.";
  if (e.code === "23514" && typeof e.details === "string") return CHECK_MESSAGES[e.details] ?? FALLBACK;
  return FALLBACK;
}

const onError = (err: unknown) => toast.error(presenceErrorMessage(err));

export function useReservationPresence(unitId: string) {
  const queryClient = useQueryClient();
  const mutation = useMutation<void, Error, { reservationId: string; action: PresenceAction }>({
    mutationFn: ({ reservationId, action }) => setReservationPresence(reservationId, action),
    onSuccess: (_data, { reservationId, action }) => {
      if (action === "arrive") {
        toast.success("Chegada marcada.", {
          action: {
            label: "Desfazer",
            onClick: () => mutation.mutate({ reservationId, action: "undo_arrive" }),
          },
        });
      } else if (action === "undo_arrive") {
        toast.success("Chegada desfeita.");
      } else {
        toast.success("Mesa liberada.");
      }
    },
    onError,
    // Também em erro: outro tablet pode ter vencido a corrida e a lista local está velha.
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["reservas", unitId] }),
  });
  return mutation;
}

/** `tableNumber` só alimenta o texto do toast. */
export function useSeatWaitlistEntry(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation<void, Error, { waitlistId: string; tableId: string; tableNumber?: number | string }>({
    mutationFn: ({ waitlistId, tableId }) => seatWaitlistEntry(waitlistId, tableId),
    onSuccess: (_data, { tableNumber }) => {
      toast.success(tableNumber != null ? `Cliente sentado na mesa ${tableNumber}.` : "Cliente sentado na mesa.");
    },
    onError,
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["waitlist", unitId] }),
  });
}

export function useReleaseWaitlistEntry(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation<void, Error, { waitlistId: string }>({
    mutationFn: ({ waitlistId }) => releaseWaitlistEntry(waitlistId),
    onSuccess: () => {
      toast.success("Mesa liberada.");
    },
    onError,
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["waitlist", unitId] }),
  });
}

export function useReleaseWalkIn(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation<void, Error, { walkInId: string }>({
    mutationFn: ({ walkInId }) => releaseWalkIn(walkInId),
    onSuccess: () => {
      toast.success("Mesa liberada.");
    },
    onError,
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["walk-ins", unitId] }),
  });
}
