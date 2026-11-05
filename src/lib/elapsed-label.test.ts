import { describe, expect, it } from "vitest";
import { elapsedLabel } from "./elapsed-label";

const base = new Date("2026-01-01T12:00:00.000Z");
const plus = (min: number) => new Date(base.getTime() + min * 60_000).toISOString();

const label = (min: number) => elapsedLabel(base.toISOString(), new Date(base.getTime() + min * 60_000));

describe("elapsedLabel", () => {
  it("menos de 1 min vira 'agora'", () => {
    expect(label(0)).toBe("agora");
    expect(label(0.5)).toBe("agora");
  });

  it("minutos até 59", () => {
    expect(label(8)).toBe("8 min");
    expect(label(59)).toBe("59 min");
  });

  it("horas cheias e com minutos", () => {
    expect(label(60)).toBe("1h");
    expect(label(65)).toBe("1h 05");
    expect(label(160)).toBe("2h 40");
  });

  it("início no futuro não gera negativo", () => {
    expect(elapsedLabel(plus(5), base)).toBe("agora");
  });
});

describe("elapsedLabel entrada inválida", () => {
  it("data inválida vira 'agora' (nunca NaN)", () => {
    expect(elapsedLabel("não é data", new Date())).toBe("agora");
  });
});
