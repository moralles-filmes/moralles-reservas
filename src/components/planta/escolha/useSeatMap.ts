import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { SeatMapResponse } from "@/types/reserva";

type SeatMapInput = { unitId: string; hallId: string; date: string; time: string; partySize: number } | { token: string };

export function useSeatMap(input: SeatMapInput | null) {
  const body = input === null ? null : "token" in input ? { token: input.token } : {
    unit_id: input.unitId, hall_id: input.hallId, date: input.date, time: input.time, party_size: input.partySize,
  };
  return useQuery({
    queryKey: ["seat-map", ...(body ? Object.values(body) : [])],
    enabled: input !== null,
    staleTime: 30_000,
    queryFn: async (): Promise<SeatMapResponse> => {
      const { data, error } = await supabase.functions.invoke<SeatMapResponse>("public-seat-map", { body });
      if (error) throw error;
      return data;
    },
  });
}
