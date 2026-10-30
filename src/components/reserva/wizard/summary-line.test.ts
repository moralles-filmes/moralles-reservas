import { describe, expect, it } from "vitest";
import { wizardSummaryLine } from "./summary-line";

describe("wizardSummaryLine", () => {
  it("formata pessoas, data e horário", () => {
    expect(wizardSummaryLine({ party_size: 4, date: "2026-10-30", time: "20:00:00" })).toBe("4 pessoas · sex, 30/10 · 20:00");
  });
  it("formata uma pessoa", () => expect(wizardSummaryLine({ party_size: 1 })).toBe("1 pessoa"));
  it("omite valores ausentes", () => expect(wizardSummaryLine({})).toBe(""));
  it("formata apenas o horário", () => expect(wizardSummaryLine({ time: "19:30" })).toBe("19:30"));
  it("omite data inválida", () => expect(wizardSummaryLine({ date: "inválida" })).toBe(""));
});
