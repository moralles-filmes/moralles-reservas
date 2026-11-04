import { describe, expect, it } from "vitest";
import {
  addDaysKey,
  brtDateOf,
  brtTodayKey,
  brtDayBounds,
  brtDowOf,
  brtHourOf,
  daysBetweenInclusive,
  eachDateKey,
  localDateKey,
} from "./brt";

describe("brt", () => {
  it("hoje em Brasília", () => {
    expect(brtTodayKey(new Date("2026-11-05T02:30:00Z"))).toBe("2026-11-04");
  });
  it("01:30Z é o dia anterior, hora 22, em BRT", () => {
    const iso = "2026-11-04T01:30:00Z";
    expect(brtDateOf(iso)).toBe("2026-11-03");
    expect(brtHourOf(iso)).toBe(22);
    expect(brtDowOf(iso)).toBe(2); // 03/11/2026 é terça
  });

  it("03:00Z é meia-noite BRT (hora 0, mesmo dia)", () => {
    expect(brtDateOf("2026-11-04T03:00:00Z")).toBe("2026-11-04");
    expect(brtHourOf("2026-11-04T03:00:00Z")).toBe(0);
    expect(brtDateOf("2026-11-04T02:59:59Z")).toBe("2026-11-03");
  });

  it("virada de mês e de ano", () => {
    expect(brtDateOf("2026-12-01T02:00:00Z")).toBe("2026-11-30");
    expect(brtDateOf("2027-01-01T02:00:00Z")).toBe("2026-12-31");
    expect(addDaysKey("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDaysKey("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("dow: domingo 0, sábado 6", () => {
    expect(brtDowOf("2026-11-01T15:00:00Z")).toBe(0);
    expect(brtDowOf("2026-11-07T15:00:00Z")).toBe(6);
    // domingo 00:30 BRT ainda é sábado em UTC? não: 03:30Z = domingo; 02:30Z = sábado
    expect(brtDowOf("2026-11-01T02:30:00Z")).toBe(6);
  });

  it("localDateKey usa getters locais", () => {
    expect(localDateKey(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });

  it("brtDayBounds", () => {
    expect(brtDayBounds("2026-11-01", "2026-11-30")).toEqual({
      startIso: "2026-11-01T00:00:00-03:00",
      endIsoExclusive: "2026-12-01T00:00:00-03:00",
    });
  });

  it("eachDateKey e daysBetweenInclusive", () => {
    expect(eachDateKey("2026-12-30", "2027-01-02")).toEqual([
      "2026-12-30",
      "2026-12-31",
      "2027-01-01",
      "2027-01-02",
    ]);
    expect(daysBetweenInclusive("2026-12-30", "2027-01-02")).toBe(4);
    expect(daysBetweenInclusive("2026-11-04", "2026-11-04")).toBe(1);
  });
});

describe("instantes e relógio BRT", () => {
  it("preserva coluna date e converte instante para o dia em Brasília", async () => {
    const { brtInstantDateKey, brtNowHHMM } = await import("./brt");
    expect(brtInstantDateKey("2026-11-05")).toBe("2026-11-05");
    expect(brtInstantDateKey("2026-11-05T01:30:00Z")).toBe("2026-11-04");
    expect(brtNowHHMM(new Date("2026-11-05T01:07:00Z"))).toBe("22:07");
  });
});
