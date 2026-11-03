import { describe, expect, it } from "vitest";
import type { WaitlistEntry } from "@/types/reserva";
import { activeQueueToday } from "./waitlist-queue";

const NOW = new Date("2026-11-03T18:00:00Z"); // 15:00 BRT
const e = (id: string, created_at: string, priority?: number | null) =>
  ({ id, created_at, priority }) as unknown as WaitlistEntry;

describe("activeQueueToday", () => {
  it("descarta entradas de dias anteriores (BRT)", () => {
    const out = activeQueueToday([e("velha", "2026-11-02T20:00:00Z"), e("hoje", "2026-11-03T15:00:00Z")], NOW);
    expect(out.map((x) => x.id)).toEqual(["hoje"]);
  });

  it("usa o dia BRT: 02:00Z de hoje ainda é ontem em BRT", () => {
    expect(activeQueueToday([e("a", "2026-11-03T02:00:00Z")], NOW)).toEqual([]);
  });

  it("ordena por prioridade e depois por chegada, sem mutar a entrada", () => {
    const input = [
      e("c", "2026-11-03T13:00:00Z", 1),
      e("b", "2026-11-03T14:00:00Z", 0),
      e("a", "2026-11-03T12:30:00Z", null),
    ];
    const out = activeQueueToday(input, NOW);
    expect(out.map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(input.map((x) => x.id)).toEqual(["c", "b", "a"]);
  });

});
