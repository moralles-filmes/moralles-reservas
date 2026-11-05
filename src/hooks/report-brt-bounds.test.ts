import { describe, expect, it, vi } from "vitest";
import { brtDateOf, brtDayBounds } from "@/lib/brt";
import { useComunicacao } from "./useComunicacao";
import { useFluxoClientes } from "./useFluxoClientes";
import { useDashboardMetrics } from "./useDashboardMetrics";
import { fetchAllPages } from "@/lib/fetch-all-pages";

describe("report BRT bounds and pagination", () => {
  it("includes the final BRT evening and excludes the previous evening", () => {
    const { startIso, endIsoExclusive } = brtDayBounds("2026-11-04", "2026-11-04");
    const late = "2026-11-04T23:30:00-03:00";
    const previous = "2026-11-03T22:00:00-03:00";
    expect(brtDateOf(late)).toBe("2026-11-04");
    expect(Date.parse(late)).toBeGreaterThanOrEqual(Date.parse(startIso));
    expect(Date.parse(late)).toBeLessThan(Date.parse(endIsoExclusive));
    expect(Date.parse(previous)).toBeLessThan(Date.parse(startIso));
    expect(Date.parse(endIsoExclusive)).toBe(Date.parse("2026-11-05T03:00:00Z"));
  });

  it("reads 1000 + 3 rows through inclusive ranges", async () => {
    const rows = Array.from({ length: 1003 }, (_, id) => ({ id }));
    const range = vi.fn(async (from: number, to: number) => ({
      data: rows.slice(from, to + 1), error: null,
    }));
    const result = await fetchAllPages((from, to) => range(from, to));
    expect(range.mock.calls).toEqual([[0, 999], [1000, 1999]]);
    expect(result).toEqual(rows);
  });

  it("rejects a failed later page instead of returning partial data", async () => {
    const failure = new Error("page failed");
    await expect(fetchAllPages(async (from) => from === 0
      ? { data: Array.from({ length: 1000 }, (_, id) => id), error: null }
      : { data: null, error: failure })).rejects.toBe(failure);
  });
});

const queryState = vi.hoisted(() => ({ data: undefined as unknown }));
vi.mock("react", () => ({ useMemo: (compute: () => unknown) => compute() }));
vi.mock("@tanstack/react-query", () => ({
  keepPreviousData: (previous: unknown) => previous,
  useQuery: () => ({ data: queryState.data, isLoading: false, isPlaceholderData: true, error: null }),
}));
vi.mock("@/lib/supabase", () => ({ supabase: {} }));

const newRange = { from: new Date(2026, 11, 1), to: new Date(2026, 11, 2) };
describe("placeholder keeps the dates belonging to its rows", () => {
  it("communication preserves the previous daily count", () => {
    queryState.data = {
      rows: [{ id: "n", kind: "confirmation", status: "sent", error: null,
        sent_at: "2026-11-04T23:30:00-03:00", customer: null }],
      keys: { fromIso: "2026-11-04", toIso: "2026-11-04" },
    };
    const result = useComunicacao("unit", newRange);
    expect(result.data.daily).toMatchObject([{ date: "2026-11-04", total: 1 }]);
    expect(result.isPlaceholderData).toBe(true);
  });

  it("flow preserves the previous daily count and BRT weekday", () => {
    queryState.data = {
      reservations: [{ id: "r", date: "2026-11-04", time: "19:00", party_size: 2,
        status: "confirmed", source: "web" }],
      waitlist: [], walkIns: [], keys: { fromIso: "2026-11-04", toIso: "2026-11-04" },
    };
    const result = useFluxoClientes("unit", newRange, null);
    expect(result.data.daily).toMatchObject([{ date: "2026-11-04", reserva_mesas: 1 }]);
    expect(result.data.dow.find(d => d.dow === 3)?.reserva_mesas).toBe(1);
    expect(result.isPlaceholderData).toBe(true);
  });

  it("dashboard partitions the previous rows using their original period", () => {
    queryState.data = {
      rows: [{ id: "r", date: "2026-11-04", time: "19:00", party_size: 2,
        status: "confirmed", source: "web", satisfaction_rating: null,
        satisfaction_at: null, customer: null }],
      keys: { currentStart: "2026-11-04", days: 1 },
    };
    const result = useDashboardMetrics("unit", "30d");
    expect(result.charts.byDay).toMatchObject([{ date: "2026-11-04", confirmed: 1 }]);
    expect(result.kpis.reservasConfirmadas).toBe(1);
    expect(result.isPlaceholderData).toBe(true);
  });
});
