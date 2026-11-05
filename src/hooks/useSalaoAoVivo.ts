import { useQuery } from "@tanstack/react-query";
import {
  fetchSalaoBlocks,
  fetchSalaoDurationSetting,
  fetchSalaoOccupantTables,
  fetchSalaoPlan,
  fetchSalaoReservations,
  fetchSalaoSeatedWalkIns,
  fetchSalaoSeatedWaitlist,
} from "@/features/planta/api";
import { brtNow } from "@/lib/table-situation-core";
import { useNow } from "./useNow";
import { useWaitlist } from "./useWaitlist";

const DEFAULT_DURATION_MINUTES = 90;

// Polling só com a aba visível (painel aberto o dia todo).
const pollWhenVisible = () =>
  typeof document !== "undefined" && document.hidden ? false : 30_000;

/** Mesma regra de `_shared/availability.ts`: número, string numérica ou `{minutes}`; padrão 90. */
export function parseDurationMinutes(raw: unknown): number {
  if (typeof raw === "number" && raw > 0) return Math.floor(raw);
  if (typeof raw === "string") {
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  if (raw && typeof raw === "object" && "minutes" in raw) {
    const v = (raw as { minutes?: unknown }).minutes;
    if (typeof v === "number" && v > 0) return Math.floor(v);
  }
  return DEFAULT_DURATION_MINUTES;
}

/** Dados ao vivo da planta do salão. Hoje/ontem em BRT rolam à meia-noite via `useNow`. */
export function useSalaoAoVivo(unitId: string) {
  const now = useNow();
  const { date: today, yesterday, tomorrow } = brtNow(now);
  const enabled = !!unitId;

  const plan = useQuery({
    queryKey: ["salao-ao-vivo", unitId, "plan"],
    queryFn: () => fetchSalaoPlan(unitId),
    enabled,
  });
  const reservations = useQuery({
    queryKey: ["reservas", unitId, "salao", today],
    queryFn: () => fetchSalaoReservations(unitId, today, yesterday),
    enabled,
    refetchInterval: pollWhenVisible,
  });
  const walkIns = useQuery({
    queryKey: ["walk-ins", unitId, "salao", today],
    queryFn: () => fetchSalaoSeatedWalkIns(unitId, yesterday),
    enabled,
    refetchInterval: pollWhenVisible,
  });
  const waitlist = useWaitlist(unitId, true);
  const seated = useQuery({
    queryKey: ["waitlist", unitId, "seated-at-table"],
    queryFn: () => fetchSalaoSeatedWaitlist(unitId, yesterday),
    enabled,
    refetchInterval: pollWhenVisible,
  });
  const blocks = useQuery({
    queryKey: ["table-blocks", unitId, "salao", today],
    queryFn: () => fetchSalaoBlocks(unitId, today, tomorrow),
    enabled,
    refetchInterval: pollWhenVisible,
  });
  const duration = useQuery({
    queryKey: ["settings", unitId, "reservation_duration_minutes"],
    queryFn: () => fetchSalaoDurationSetting(unitId),
    enabled,
  });


  // Mesas de cada ocupante já carregado (junções). A chave carrega os ids para refazer a
  // leitura quando alguém senta ou chega; o prefixo ["occupant-tables", unitId] invalida tudo.
  const occupantIds = {
    reservationIds: (reservations.data ?? []).map((r) => r.id).sort(),
    walkInIds: (walkIns.data ?? []).map((w) => w.id).sort(),
    waitlistIds: (seated.data ?? []).map((f) => f.id).sort(),
  };
  const occupantKey = [occupantIds.reservationIds, occupantIds.walkInIds, occupantIds.waitlistIds]
    .map((l) => l.join(","))
    .join("|");
  const occupantTables = useQuery({
    queryKey: ["occupant-tables", unitId, "salao", today, occupantKey],
    queryFn: () => fetchSalaoOccupantTables(unitId, occupantIds),
    enabled: enabled && reservations.data !== undefined && walkIns.data !== undefined && seated.data !== undefined,
    refetchInterval: pollWhenVisible,
    placeholderData: (prev) => prev,
  });

  const all = [plan, reservations, walkIns, waitlist, seated, blocks, duration, occupantTables];
  return {
    halls: plan.data?.halls ?? [],
    tables: plan.data?.tables ?? [],
    reservations: reservations.data ?? [],
    walkIns: walkIns.data ?? [],
    waitlistActive: waitlist.data ?? [],
    waitlistSeated: seated.data ?? [],
    blocks: blocks.data ?? [],
    occupantTables: occupantTables.data ?? [],
    durationMinutes: parseDurationMinutes(duration.data),
    isLoading: all.some((q) => q.isLoading),
    /** Todas as consultas têm dados (a duração ausente vem como null, não undefined): um erro de refetch não deve derrubar a cena. */
    hasData: all.every((q) => q.data !== undefined),
    isError: all.some((q) => q.isError),
    refetch: () => {
      all.forEach((q) => void q.refetch());
    },
  };
}
