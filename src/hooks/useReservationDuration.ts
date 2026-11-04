import { useQuery } from "@tanstack/react-query";
import { fetchSalaoDurationSetting } from "@/features/planta/api";
import { parseDurationMinutes } from "./useSalaoAoVivo";

/** Duração da reserva (`reservation_duration_minutes`), a mesma fonte e chave de cache da planta ao vivo. */
export function useReservationDuration(unitId: string): number {
  const q = useQuery({
    queryKey: ["settings", unitId, "reservation_duration_minutes"],
    queryFn: () => fetchSalaoDurationSetting(unitId),
    enabled: !!unitId,
    staleTime: 5 * 60_000,
  });
  return parseDurationMinutes(q.data);
}
