import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

// ── Tipos ─────────────────────────────────────────────────────────────────────

export interface DateRange {
  from: Date;
  to: Date;
}

export type FluxoTab = "geral" | "reserva" | "fila" | "passante";

export interface PartySizeBucket {
  bucket: string;
  reserva: number;
  fila: number;
  passante: number;
}

export interface DowFlow {
  /** 0 = Domingo, 6 = Sábado. */
  dow: number;
  label: string;
  reserva_mesas: number;
  reserva_pessoas: number;
  fila_mesas: number;
  fila_pessoas: number;
  passante_mesas: number;
  passante_pessoas: number;
}

export interface DailyFlow {
  date: string;
  label: string;
  reserva_mesas: number;
  reserva_pessoas: number;
  fila_mesas: number;
  fila_pessoas: number;
  passante_mesas: number;
  passante_pessoas: number;
}

export interface KpiSet {
  total_mesas: number;
  total_pessoas: number;
  media_pessoas_por_mesa: number;
  taxa_no_show_pct: number;
  taxa_cancelamento_pct: number;
  /** Apenas Fila — segundos médios entre created_at e notified_at. */
  tempo_medio_espera_seg: number | null;
  /** Mesas/pessoas efetivamente sentadas. */
  mesas_sentadas: number;
  pessoas_sentadas: number;
  /** Sempre 0 por ora — depende de pagamentos. */
  receita_centavos: number;
}

export interface FluxoData {
  kpis: {
    geral: KpiSet;
    reserva: KpiSet;
    fila: KpiSet;
    passante: KpiSet;
  };
  daily: DailyFlow[];
  partySize: PartySizeBucket[];
  dow: DowFlow[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const DOW_LABELS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function eachDay(from: Date, to: Date): string[] {
  const days: string[] = [];
  const cur = new Date(from);
  cur.setHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setHours(0, 0, 0, 0);
  while (cur <= end) {
    days.push(toIsoDate(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}

function bucketFor(partySize: number): string {
  if (partySize <= 2) return "01-02";
  if (partySize <= 4) return "03-04";
  if (partySize <= 6) return "05-06";
  if (partySize <= 8) return "07-08";
  if (partySize <= 10) return "09-10";
  if (partySize <= 12) return "11-12";
  if (partySize <= 16) return "13-16";
  if (partySize <= 19) return "17-19";
  return "20+";
}

const ALL_BUCKETS = [
  "01-02",
  "03-04",
  "05-06",
  "07-08",
  "09-10",
  "11-12",
  "13-16",
  "17-19",
  "20+",
];

function emptyKpiSet(): KpiSet {
  return {
    total_mesas: 0,
    total_pessoas: 0,
    media_pessoas_por_mesa: 0,
    taxa_no_show_pct: 0,
    taxa_cancelamento_pct: 0,
    tempo_medio_espera_seg: null,
    mesas_sentadas: 0,
    pessoas_sentadas: 0,
    receita_centavos: 0,
  };
}

interface ReservationRow {
  id: string;
  date: string;
  time: string | null;
  party_size: number;
  status: "pending" | "confirmed" | "cancelled" | "no_show";
}

interface WaitlistRow {
  id: string;
  party_size: number;
  status: "waiting" | "notified" | "seated" | "cancelled";
  created_at: string;
  notified_at: string | null;
}

interface WalkInRow {
  id: string;
  party_size: number;
  status: "waiting" | "seated" | "left" | "no_show";
  arrived_at: string;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useFluxoClientes(unitId: string, range: DateRange) {
  const fromIso = toIsoDate(range.from);
  const toIso = toIsoDate(range.to);

  const query = useQuery({
    queryKey: ["fluxo-clientes", unitId, fromIso, toIso],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const startTs = `${fromIso}T00:00:00.000Z`;
      const endTs = new Date(range.to);
      endTs.setHours(23, 59, 59, 999);
      const endTsIso = endTs.toISOString();

      const [resv, wait, walk] = await Promise.all([
        supabase
          .from("reservations")
          .select("id, date, time, party_size, status")
          .eq("unit_id", unitId)
          .gte("date", fromIso)
          .lte("date", toIso),
        supabase
          .from("waitlist")
          .select("id, party_size, status, created_at, notified_at")
          .eq("unit_id", unitId)
          .gte("created_at", startTs)
          .lte("created_at", endTsIso),
        supabase
          .from("walk_ins")
          .select("id, party_size, status, arrived_at")
          .eq("unit_id", unitId)
          .gte("arrived_at", startTs)
          .lte("arrived_at", endTsIso),
      ]);

      if (resv.error) throw resv.error;
      if (wait.error) throw wait.error;
      if (walk.error) throw walk.error;

      return {
        reservations: (resv.data ?? []) as ReservationRow[],
        waitlist: (wait.data ?? []) as WaitlistRow[],
        walkIns: (walk.data ?? []) as WalkInRow[],
      };
    },
    enabled: !!unitId,
  });

  const data = useMemo<FluxoData>(() => {
    if (!query.data) {
      return {
        kpis: {
          geral: emptyKpiSet(),
          reserva: emptyKpiSet(),
          fila: emptyKpiSet(),
          passante: emptyKpiSet(),
        },
        daily: [],
        partySize: [],
        dow: [],
      };
    }

    const { reservations, waitlist, walkIns } = query.data;

    // ── Reserva ────────────────────────────────────────────────────────────
    const reservaConfirmadas = reservations.filter(
      (r) => r.status === "confirmed",
    );
    const reservaCanceladas = reservations.filter(
      (r) => r.status === "cancelled",
    ).length;
    const reservaNoShow = reservations.filter(
      (r) => r.status === "no_show",
    ).length;

    const reservaTotalMesas = reservations.length;
    const reservaTotalPessoas = reservations.reduce(
      (acc, r) => acc + r.party_size,
      0,
    );
    const reservaSentadasPessoas = reservaConfirmadas.reduce(
      (acc, r) => acc + r.party_size,
      0,
    );

    const reservaKpis: KpiSet = {
      total_mesas: reservaTotalMesas,
      total_pessoas: reservaTotalPessoas,
      media_pessoas_por_mesa: reservaTotalMesas
        ? reservaTotalPessoas / reservaTotalMesas
        : 0,
      taxa_no_show_pct: reservaTotalMesas
        ? (reservaNoShow / reservaTotalMesas) * 100
        : 0,
      taxa_cancelamento_pct: reservaTotalMesas
        ? (reservaCanceladas / reservaTotalMesas) * 100
        : 0,
      tempo_medio_espera_seg: null,
      mesas_sentadas: reservaConfirmadas.length,
      pessoas_sentadas: reservaSentadasPessoas,
      receita_centavos: 0, // pagamentos: stub até integração
    };

    // ── Fila ───────────────────────────────────────────────────────────────
    const filaSeated = waitlist.filter((w) => w.status === "seated");
    const filaCanceladas = waitlist.filter(
      (w) => w.status === "cancelled",
    ).length;

    const filaTotalMesas = waitlist.length;
    const filaTotalPessoas = waitlist.reduce((a, w) => a + w.party_size, 0);
    const filaSentadasPessoas = filaSeated.reduce(
      (a, w) => a + w.party_size,
      0,
    );

    const filaWaits = waitlist
      .filter((w) => w.notified_at && w.created_at)
      .map(
        (w) =>
          (new Date(w.notified_at!).getTime() -
            new Date(w.created_at).getTime()) /
          1000,
      )
      .filter((s) => s >= 0);

    const filaKpis: KpiSet = {
      total_mesas: filaTotalMesas,
      total_pessoas: filaTotalPessoas,
      media_pessoas_por_mesa: filaTotalMesas
        ? filaTotalPessoas / filaTotalMesas
        : 0,
      taxa_no_show_pct: filaTotalMesas
        ? (filaCanceladas / filaTotalMesas) * 100
        : 0,
      taxa_cancelamento_pct: 0,
      tempo_medio_espera_seg: filaWaits.length
        ? filaWaits.reduce((a, b) => a + b, 0) / filaWaits.length
        : null,
      mesas_sentadas: filaSeated.length,
      pessoas_sentadas: filaSentadasPessoas,
      receita_centavos: 0,
    };

    // ── Passante (walk-ins) ────────────────────────────────────────────────
    const walkSeated = walkIns.filter((w) => w.status === "seated");
    const walkNoShow = walkIns.filter((w) => w.status === "no_show").length;

    const walkTotalMesas = walkIns.length;
    const walkTotalPessoas = walkIns.reduce((a, w) => a + w.party_size, 0);
    const walkSentadasPessoas = walkSeated.reduce(
      (a, w) => a + w.party_size,
      0,
    );

    const passanteKpis: KpiSet = {
      total_mesas: walkTotalMesas,
      total_pessoas: walkTotalPessoas,
      media_pessoas_por_mesa: walkTotalMesas
        ? walkTotalPessoas / walkTotalMesas
        : 0,
      taxa_no_show_pct: walkTotalMesas
        ? (walkNoShow / walkTotalMesas) * 100
        : 0,
      taxa_cancelamento_pct: 0,
      tempo_medio_espera_seg: null,
      mesas_sentadas: walkSeated.length,
      pessoas_sentadas: walkSentadasPessoas,
      receita_centavos: 0,
    };

    // ── Visão geral (agregado dos 3) ───────────────────────────────────────
    const totalMesas =
      reservaKpis.total_mesas +
      filaKpis.total_mesas +
      passanteKpis.total_mesas;
    const totalPessoas =
      reservaKpis.total_pessoas +
      filaKpis.total_pessoas +
      passanteKpis.total_pessoas;
    const totalNoShow = reservaNoShow + walkNoShow;

    const geralKpis: KpiSet = {
      total_mesas: totalMesas,
      total_pessoas: totalPessoas,
      media_pessoas_por_mesa: totalMesas ? totalPessoas / totalMesas : 0,
      taxa_no_show_pct: totalMesas ? (totalNoShow / totalMesas) * 100 : 0,
      taxa_cancelamento_pct: reservaTotalMesas
        ? (reservaCanceladas / reservaTotalMesas) * 100
        : 0,
      tempo_medio_espera_seg: filaKpis.tempo_medio_espera_seg,
      mesas_sentadas:
        reservaKpis.mesas_sentadas +
        filaKpis.mesas_sentadas +
        passanteKpis.mesas_sentadas,
      pessoas_sentadas:
        reservaKpis.pessoas_sentadas +
        filaKpis.pessoas_sentadas +
        passanteKpis.pessoas_sentadas,
      receita_centavos: 0,
    };

    // ── Daily flow ─────────────────────────────────────────────────────────
    const days = eachDay(range.from, range.to);
    const daily: DailyFlow[] = days.map((d) => ({
      date: d,
      label: d.slice(8, 10) + "/" + d.slice(5, 7),
      reserva_mesas: 0,
      reserva_pessoas: 0,
      fila_mesas: 0,
      fila_pessoas: 0,
      passante_mesas: 0,
      passante_pessoas: 0,
    }));
    const dailyMap = Object.fromEntries(daily.map((d) => [d.date, d]));

    for (const r of reservaConfirmadas) {
      const d = dailyMap[r.date];
      if (d) {
        d.reserva_mesas += 1;
        d.reserva_pessoas += r.party_size;
      }
    }
    for (const w of filaSeated) {
      const d = dailyMap[w.created_at.slice(0, 10)];
      if (d) {
        d.fila_mesas += 1;
        d.fila_pessoas += w.party_size;
      }
    }
    for (const w of walkSeated) {
      const d = dailyMap[w.arrived_at.slice(0, 10)];
      if (d) {
        d.passante_mesas += 1;
        d.passante_pessoas += w.party_size;
      }
    }

    // ── Party size distribution ────────────────────────────────────────────
    const psMap = new Map<string, PartySizeBucket>();
    for (const b of ALL_BUCKETS) {
      psMap.set(b, { bucket: b, reserva: 0, fila: 0, passante: 0 });
    }
    for (const r of reservations) psMap.get(bucketFor(r.party_size))!.reserva += 1;
    for (const w of waitlist) psMap.get(bucketFor(w.party_size))!.fila += 1;
    for (const w of walkIns) psMap.get(bucketFor(w.party_size))!.passante += 1;
    const partySize = Array.from(psMap.values()).filter(
      (b) => b.reserva + b.fila + b.passante > 0,
    );

    // ── Day of week ────────────────────────────────────────────────────────
    const dow: DowFlow[] = Array.from({ length: 7 }, (_, i) => ({
      dow: i,
      label: DOW_LABELS[i],
      reserva_mesas: 0,
      reserva_pessoas: 0,
      fila_mesas: 0,
      fila_pessoas: 0,
      passante_mesas: 0,
      passante_pessoas: 0,
    }));

    for (const r of reservations) {
      const d = new Date(r.date + "T00:00:00").getDay();
      dow[d].reserva_mesas += 1;
      dow[d].reserva_pessoas += r.party_size;
    }
    for (const w of waitlist) {
      const d = new Date(w.created_at).getDay();
      dow[d].fila_mesas += 1;
      dow[d].fila_pessoas += w.party_size;
    }
    for (const w of walkIns) {
      const d = new Date(w.arrived_at).getDay();
      dow[d].passante_mesas += 1;
      dow[d].passante_pessoas += w.party_size;
    }

    // Reorder Seg–Dom (Get In pattern)
    const dowReordered = [...dow.slice(1), dow[0]];

    return {
      kpis: {
        geral: geralKpis,
        reserva: reservaKpis,
        fila: filaKpis,
        passante: passanteKpis,
      },
      daily,
      partySize,
      dow: dowReordered,
    };
  }, [query.data, range.from, range.to]);

  return {
    data,
    isLoading: query.isLoading,
    error: query.error as Error | null,
  };
}
