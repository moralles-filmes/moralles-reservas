import { describe, expect, it } from "vitest";
import {
  addDaysBrtIso,
  brtYearStartInstantIso,
  unixSecondsToBrtDate,
} from "../../supabase/functions/_shared/brt-date-core";

const at = (iso: string) => Date.parse(iso);

describe("brtYearStartInstantIso (idempotência do aniversário por ano civil BRT)", () => {
  it("é 1º/jan 00:00 BRT do ano corrente", () => {
    expect(brtYearStartInstantIso(at("2026-11-05T12:00:00Z"))).toBe("2026-01-01T03:00:00.000Z");
  });

  it("na virada UTC de 31/dez (22h BRT) ainda é o ano que termina", () => {
    expect(brtYearStartInstantIso(at("2027-01-01T01:00:00Z"))).toBe("2026-01-01T03:00:00.000Z");
  });

  it("voucher do ano passado emitido mais tarde que a rodada de hoje não bloqueia", () => {
    // Defeito da janela de 365 dias: rodada de hoje às 12:00 UTC, voucher de
    // 2025 emitido às 12:05 UTC do mesmo dia → ficava "dentro" dos 365 dias.
    const now = at("2026-11-05T12:00:00Z");
    const lastYear = at("2025-11-05T12:05:00Z");
    expect(lastYear >= Date.parse(brtYearStartInstantIso(now))).toBe(false);
    expect(lastYear > now - 365 * 86_400_000).toBe(true);
  });

  it("voucher deste ano bloqueia", () => {
    const now = at("2026-11-05T18:00:00Z");
    expect(at("2026-11-05T12:01:00Z") >= Date.parse(brtYearStartInstantIso(now))).toBe(true);
  });
});

describe("addDaysBrtIso (vencimento de fatura em dia civil BRT)", () => {
  it("às 22h BRT conta a partir de hoje BRT, não de amanhã UTC", () => {
    // 2026-11-05 22:30 BRT = 2026-11-06 01:30 UTC
    expect(addDaysBrtIso(7, at("2026-11-06T01:30:00Z"))).toBe("2026-11-12");
  });

  it("de manhã coincide com o cálculo UTC", () => {
    expect(addDaysBrtIso(7, at("2026-11-05T12:00:00Z"))).toBe("2026-11-12");
  });

  it("atravessa mês e ano", () => {
    expect(addDaysBrtIso(3, at("2026-12-30T15:00:00Z"))).toBe("2027-01-02");
    expect(addDaysBrtIso(0, at("2027-01-01T02:59:00Z"))).toBe("2026-12-31");
  });
});

describe("unixSecondsToBrtDate (due_date do Stripe)", () => {
  it("timestamp às 23h BRT é o próprio dia BRT", () => {
    // 2026-11-12 23:00 BRT = 2026-11-13 02:00 UTC
    expect(unixSecondsToBrtDate(at("2026-11-13T02:00:00Z") / 1000)).toBe("2026-11-12");
  });

  it("timestamp de dia vira o mesmo dia", () => {
    expect(unixSecondsToBrtDate(at("2026-11-12T15:00:00Z") / 1000)).toBe("2026-11-12");
  });
});
