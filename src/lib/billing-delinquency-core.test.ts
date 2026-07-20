import { describe, it, expect } from "vitest";
import {
  todayBrt,
  addDaysToDate,
  daysOverdue,
  decideDelinquencyStatus,
  pickRecipient,
  REMINDER_OFFSETS,
  GRACE_PERIOD_DAYS,
  BLOCK_AFTER_DAYS,
} from "../../supabase/functions/_shared/billing-delinquency-core";

describe("todayBrt", () => {
  it("volta o dia BRT, não UTC, perto da meia-noite", () => {
    // 2026-07-20T01:30:00Z == 2026-07-19 22:30 BRT -> dia BRT é 19
    expect(todayBrt(Date.parse("2026-07-20T01:30:00Z"))).toBe("2026-07-19");
    // 2026-07-19T12:00:00Z == 09:00 BRT -> 19
    expect(todayBrt(Date.parse("2026-07-19T12:00:00Z"))).toBe("2026-07-19");
  });
});

describe("addDaysToDate", () => {
  it("soma dias sem cruzar fuso e vira o mês", () => {
    expect(addDaysToDate("2026-07-19", 3)).toBe("2026-07-22");
    expect(addDaysToDate("2026-02-27", 2)).toBe("2026-03-01"); // 2026 não bissexto
  });
});

describe("daysOverdue", () => {
  it("conta dias de vencido (positivo = atrasado)", () => {
    expect(daysOverdue("2026-07-19", "2026-07-19")).toBe(0);
    expect(daysOverdue("2026-07-18", "2026-07-19")).toBe(1);
    expect(daysOverdue("2026-07-25", "2026-07-19")).toBe(-6);
  });
});

describe("decideDelinquencyStatus", () => {
  it("null quando não vencida (due hoje ou futuro)", () => {
    expect(decideDelinquencyStatus("2026-07-19", "2026-07-19")).toBeNull();
    expect(decideDelinquencyStatus("2026-07-25", "2026-07-19")).toBeNull();
  });
  it("grace_period de D+1 a D+5", () => {
    expect(decideDelinquencyStatus("2026-07-18", "2026-07-19")).toBe("grace_period"); // D+1
    expect(decideDelinquencyStatus("2026-07-14", "2026-07-19")).toBe("grace_period"); // D+5
  });
  it("blocked em D+6 ou mais", () => {
    expect(decideDelinquencyStatus("2026-07-13", "2026-07-19")).toBe("blocked"); // D+6
    expect(decideDelinquencyStatus("2026-06-19", "2026-07-19")).toBe("blocked");
  });
});

describe("pickRecipient", () => {
  it("prefere billing_email; senão owner; senão null", () => {
    expect(pickRecipient("a@b.com", "owner@x.com")).toBe("a@b.com");
    expect(pickRecipient(null, "owner@x.com")).toBe("owner@x.com");
    expect(pickRecipient("  ", "owner@x.com")).toBe("owner@x.com");
    expect(pickRecipient(null, null)).toBeNull();
  });
});

describe("REMINDER_OFFSETS", () => {
  it("tem os 4 offsets do ciclo, na ordem", () => {
    expect(REMINDER_OFFSETS.map((o) => o.type)).toEqual([
      "payment_pending",
      "overdue_d1",
      "overdue_d3",
      "overdue_d5",
    ]);
    expect(REMINDER_OFFSETS.map((o) => o.days)).toEqual([0, 1, 3, 5]);
  });
});

describe("constantes de política", () => {
  it("bloqueia no dia seguinte ao fim da tolerância", () => {
    expect(BLOCK_AFTER_DAYS).toBe(GRACE_PERIOD_DAYS + 1);
  });
});
