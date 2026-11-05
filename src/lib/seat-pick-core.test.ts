import { describe, expect, it } from "vitest";
import { validSeatTargets } from "./seat-pick-core";
import type { Mesa, TableCombination } from "@/types/reserva";
import type { TableState } from "./table-situation-core";

const table = (id: string, capacity = 4) =>
  ({ id, hall_id: "h", active: true, capacity, bookable: false }) as Mesa;
const occupant = { kind: "reservation" as const, id: "r" };
const base = {
  mode: "move" as const,
  occupant,
  partySize: 3,
  tables: [table("a"), table("b", 6)],
  states: new Map<string, TableState>([
    ["a", { situation: "free" }],
    ["b", { situation: "free" }],
  ]),
  combinations: [] as TableCombination[],
  blocks: [],
  now: new Date("2026-11-03T18:00:00Z"),
};

describe("validSeatTargets", () => {
  it("aceita bookable false e ordena pela menor sobra", () => {
    const result = validSeatTargets(base);
    expect([...result.selectable]).toEqual(["a", "b"]);
    expect(result.suggested).toEqual([["a"], ["b"]]);
  });

  it("recusa outro ocupante e aceita o próprio", () => {
    const states = new Map<string, TableState>([
      ["a", { situation: "occupied", occupant: { ...occupant, since: "", partySize: 3 } }],
      ["b", { situation: "occupied", occupant: { ...occupant, id: "other", since: "", partySize: 3 } }],
    ]);
    expect([...validSeatTargets({ ...base, states }).selectable]).toEqual(["a"]);
  });

  it("recusa situação bloqueada e bloqueio de salão vigente", () => {
    const blocks = [
      { table_id: null, hall_id: "h", blocked_from: "2026-11-03T17:00:00Z", blocked_to: "2026-11-03T19:00:00Z" },
    ];
    expect(validSeatTargets({ ...base, blocks }).selectable.size).toBe(0);
    const states = new Map<string, TableState>([["a", { situation: "blocked" }]]);
    expect(validSeatTargets({ ...base, states }).selectable.has("a")).toBe(false);
  });

  it("sugere combinação por capacidade e join não sugere", () => {
    const args = {
      ...base,
      partySize: 8,
      combinations: [{ active: true, table_ids: ["a", "b"], min_capacity: 5, max_capacity: 10 } as TableCombination],
    };
    expect(validSeatTargets(args).suggested).toEqual([["a", "b"]]);
    expect(validSeatTargets({ ...args, mode: "join" }).suggested).toEqual([]);
  });
});
