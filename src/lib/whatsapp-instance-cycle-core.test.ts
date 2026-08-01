import { describe, it, expect } from "vitest";
import {
  clampDayToMonth,
  nextDueFromAnchor,
  isCycleDue,
  daysUntil,
  nextCycleFrom,
} from "../../supabase/functions/_shared/whatsapp-instance-cycle-core";

describe("isCycleDue — o limite exato (spec §6.4)", () => {
  it("antes do vencimento: não venceu", () => {
    expect(isCycleDue("2026-08-10", "2026-08-09")).toBe(false);
  });

  it("EXATAMENTE no vencimento: venceu — o fim é exclusivo, `>` atrasaria um dia", () => {
    expect(isCycleDue("2026-08-10", "2026-08-10")).toBe(true);
  });

  it("depois do vencimento: venceu", () => {
    expect(isCycleDue("2026-08-10", "2026-08-11")).toBe(true);
  });

  it("compara data civil, não instante: a virada UTC entre 21h e 00h BRT não antecipa nada", () => {
    // 2026-08-09T23:30-03:00 é 2026-08-10T02:30Z. Quem passar a data civil BRT
    // correta ("2026-08-09") não vence; quem usar o dia UTC vence um dia antes.
    expect(isCycleDue("2026-08-10", "2026-08-09")).toBe(false);
    expect(isCycleDue("2026-08-10", "2026-08-10")).toBe(true);
  });
});

describe("clampDayToMonth", () => {
  it("mês de 28 dias", () => {
    expect(clampDayToMonth(2026, 2, 31)).toBe(28);
  });

  it("fevereiro bissexto tem 29", () => {
    expect(clampDayToMonth(2028, 2, 31)).toBe(29);
  });

  it("mês de 30 dias", () => {
    expect(clampDayToMonth(2026, 4, 31)).toBe(30);
  });

  it("mês de 31 dias não altera nada", () => {
    expect(clampDayToMonth(2026, 5, 31)).toBe(31);
  });
});

describe("nextDueFromAnchor — a âncora sobrevive ao clamp (spec §6.3)", () => {
  it("31 → 28/02 → 31/03: o clamp do mês corrente NUNCA substitui a âncora", () => {
    expect(nextDueFromAnchor("2026-01-31", 31)).toBe("2026-02-28");
    expect(nextDueFromAnchor("2026-02-28", 31)).toBe("2026-03-31");
    expect(nextDueFromAnchor("2026-03-31", 31)).toBe("2026-04-30");
    expect(nextDueFromAnchor("2026-04-30", 31)).toBe("2026-05-31");
  });

  it("ano vira corretamente", () => {
    expect(nextDueFromAnchor("2026-12-15", 15)).toBe("2027-01-15");
  });

  it("âncora 29 em ano não bissexto vira 28/02 e volta a 29", () => {
    expect(nextDueFromAnchor("2026-01-29", 29)).toBe("2026-02-28");
    expect(nextDueFromAnchor("2026-02-28", 29)).toBe("2026-03-29");
  });

  it("fevereiro bissexto: âncora 31 vira 29", () => {
    expect(nextDueFromAnchor("2028-01-31", 31)).toBe("2028-02-29");
  });
});

describe("daysUntil", () => {
  it("conta dias civis, sem hora", () => {
    expect(daysUntil("2026-08-10", "2026-08-03")).toBe(7);
    expect(daysUntil("2026-08-10", "2026-08-09")).toBe(1);
    expect(daysUntil("2026-08-10", "2026-08-10")).toBe(0);
    expect(daysUntil("2026-08-10", "2026-08-11")).toBe(-1);
  });

  it("atravessa mês e ano", () => {
    expect(daysUntil("2027-01-01", "2026-12-25")).toBe(7);
  });
});

describe("nextCycleFrom — reexecução idempotente", () => {
  it("o próximo ciclo começa exatamente no vencimento do anterior", () => {
    expect(nextCycleFrom("2026-01-31", 31)).toEqual({
      cycleStart: "2026-01-31",
      providerDueOn: "2026-02-28",
    });
  });

  it("chamar duas vezes com a mesma entrada produz o mesmo resultado", () => {
    const a = nextCycleFrom("2026-02-28", 31);
    const b = nextCycleFrom("2026-02-28", 31);
    expect(a).toEqual(b);
    expect(a).toEqual({ cycleStart: "2026-02-28", providerDueOn: "2026-03-31" });
  });
});
