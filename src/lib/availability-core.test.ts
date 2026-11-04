import { describe, expect, it } from "vitest";
import {
  fitsParty,
  pickSeat,
  seatOptions,
  type SeatCombination,
  type SeatTable,
} from "../../supabase/functions/_shared/availability-core";

const t = (id: string, number: number, min: number, max: number, extra: Partial<SeatTable> = {}): SeatTable => ({
  id,
  number,
  minCapacity: min,
  maxCapacity: max,
  bookable: true,
  inCombination: false,
  ...extra,
});
const none = new Set<string>();
const base = { occupied: none, allowEmptySeat: false };

describe("availability-core", () => {
  it("mesa sozinha fora de combinação vem antes", () => {
    const tables = [t("a", 1, 2, 4, { inCombination: true }), t("b", 2, 2, 6)];
    const r = pickSeat({ ...base, tables, combinations: [], partySize: 3 });
    expect(r).toEqual({ tableIds: ["b"], combinationId: null });
  });

  it("combinação só quando nenhuma mesa serve", () => {
    const tables = [t("a", 1, 2, 4, { inCombination: true }), t("b", 2, 2, 4, { inCombination: true })];
    const combinations: SeatCombination[] = [{ id: "c", tableIds: ["a", "b"], minCapacity: 5, maxCapacity: 8 }];
    expect(pickSeat({ ...base, tables, combinations, partySize: 4 })?.combinationId).toBeNull();
    expect(pickSeat({ ...base, tables, combinations, partySize: 6 })).toEqual({
      tableIds: ["a", "b"],
      combinationId: "c",
    });
  });

  it("menor max primeiro em cada grupo", () => {
    const tables = [t("a", 1, 2, 8), t("b", 2, 2, 4), t("c", 3, 2, 4)];
    expect(pickSeat({ ...base, tables, combinations: [], partySize: 3 })?.tableIds).toEqual(["b"]);
    const o = seatOptions({ ...base, tables, combinations: [], partySize: 3 });
    expect(o.map((x) => x.tableIds[0])).toEqual(["b", "c", "a"]);
  });

  it("não reservável nunca", () => {
    const tables = [t("a", 1, 2, 4, { bookable: false })];
    expect(pickSeat({ ...base, tables, combinations: [], partySize: 2 })).toBeNull();
    expect(pickSeat({ ...base, tables, combinations: [], partySize: 2, choice: { kind: "table", id: "a" } })).toBeNull();
    expect(seatOptions({ ...base, tables, combinations: [], partySize: 2 })).toEqual([]);
  });

  it("membro ocupado derruba a combinação", () => {
    const tables = [t("a", 1, 2, 4, { inCombination: true }), t("b", 2, 2, 4, { inCombination: true })];
    const combinations: SeatCombination[] = [{ id: "c", tableIds: ["a", "b"], minCapacity: 5, maxCapacity: 8 }];
    expect(pickSeat({ ...base, occupied: new Set(["b"]), tables, combinations, partySize: 6 })).toBeNull();
  });

  it("combinação com membro bookable=false é inutilizável", () => {
    const tables = [t("a", 1, 2, 4), t("b", 2, 2, 4, { bookable: false })];
    const combinations: SeatCombination[] = [{ id: "c", tableIds: ["a", "b"], minCapacity: 5, maxCapacity: 8 }];
    expect(pickSeat({ ...base, tables, combinations, partySize: 6 })).toBeNull();
    expect(seatOptions({ ...base, tables, combinations, partySize: 6 })).toEqual([]);
  });

  it("escolha do cliente ocupada devolve null", () => {
    const tables = [t("a", 1, 2, 4), t("b", 2, 2, 4)];
    const r = pickSeat({
      ...base,
      occupied: new Set(["a"]),
      tables,
      combinations: [],
      partySize: 2,
      choice: { kind: "table", id: "a" },
    });
    expect(r).toBeNull();
  });

  it("escolha do cliente de mesa que não cabe devolve null", () => {
    const tables = [t("a", 1, 2, 4), t("b", 2, 2, 8)];
    expect(pickSeat({ ...base, tables, combinations: [], partySize: 6, choice: { kind: "table", id: "a" } })).toBeNull();
    expect(pickSeat({ ...base, tables, combinations: [], partySize: 6, choice: { kind: "table", id: "zz" } })).toBeNull();
  });

  it("escolha de combinação livre devolve combinationId", () => {
    const tables = [t("a", 1, 2, 4, { inCombination: true }), t("b", 2, 2, 4, { inCombination: true })];
    const combinations: SeatCombination[] = [{ id: "c", tableIds: ["b", "a"], minCapacity: 5, maxCapacity: 8 }];
    expect(
      pickSeat({ ...base, tables, combinations, partySize: 6, choice: { kind: "combination", id: "c" } }),
    ).toEqual({ tableIds: ["b", "a"], combinationId: "c" });
  });

  it("preferTableIds mantém a reserva na mesa atual quando cabe", () => {
    const tables = [t("a", 1, 2, 4), t("b", 2, 2, 8)];
    const r = pickSeat({ ...base, tables, combinations: [], partySize: 3, preferTableIds: ["b"] });
    expect(r).toEqual({ tableIds: ["b"], combinationId: null });
  });

  it("preferTableIds igual a uma combinação mantém a combinação", () => {
    const tables = [t("a", 1, 2, 4, { inCombination: true }), t("b", 2, 2, 4, { inCombination: true }), t("x", 3, 2, 10)];
    const combinations: SeatCombination[] = [{ id: "c", tableIds: ["a", "b"], minCapacity: 5, maxCapacity: 8 }];
    const r = pickSeat({ ...base, tables, combinations, partySize: 6, preferTableIds: ["b", "a"] });
    expect(r?.combinationId).toBe("c");
  });

  it("allowEmptySeat aceita partySize = min - 1", () => {
    expect(fitsParty(4, 6, 3, false)).toBe(false);
    expect(fitsParty(4, 6, 3, true)).toBe(true);
    expect(fitsParty(1, 6, 1, true)).toBe(true);
    const tables = [t("a", 1, 4, 6)];
    expect(pickSeat({ ...base, tables, combinations: [], partySize: 3 })).toBeNull();
    expect(pickSeat({ ...base, allowEmptySeat: true, tables, combinations: [], partySize: 3 })).not.toBeNull();
  });

  it("seatOptions marca indisponível sem esconder", () => {
    const tables = [t("a", 1, 2, 4), t("b", 2, 2, 4)];
    const o = seatOptions({ ...base, occupied: new Set(["a"]), tables, combinations: [], partySize: 2 });
    expect(o.map((x) => [x.tableIds[0], x.available])).toEqual([
      ["a", false],
      ["b", true],
    ]);
  });
});
