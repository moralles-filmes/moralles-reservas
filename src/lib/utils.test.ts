import { describe, it, expect } from "vitest";
import {
  cn,
  formatDateBR,
  formatPhone,
  generateReservationCode,
  safeDateParse,
} from "./utils";

describe("cn", () => {
  it("merges class names", () => {
    expect(cn("a", "b")).toBe("a b");
  });

  it("dedupes conflicting Tailwind classes", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
  });

  it("ignores falsy values", () => {
    expect(cn("a", false, null, undefined, "b")).toBe("a b");
  });
});

describe("safeDateParse", () => {
  it("parses YYYY-MM-DD as local noon (avoids UTC off-by-one)", () => {
    const d = safeDateParse("2026-04-27");
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(3); // April = 3
    expect(d.getDate()).toBe(27);
  });

  it("falls back to native Date for ISO strings", () => {
    const d = safeDateParse("2026-04-27T15:30:00Z");
    expect(d.toISOString().startsWith("2026-04-27")).toBe(true);
  });
});

describe("formatDateBR", () => {
  it("returns dash for null/undefined", () => {
    expect(formatDateBR(null)).toBe("—");
    expect(formatDateBR(undefined)).toBe("—");
  });

  it("formats YYYY-MM-DD as DD/MM/YYYY in pt-BR", () => {
    expect(formatDateBR("2026-04-27")).toBe("27/04/2026");
  });
});

describe("formatPhone", () => {
  it("formats 11-digit mobile with mask (XX) XXXXX-XXXX", () => {
    expect(formatPhone("11999887766")).toBe("(11) 99988-7766");
  });

  it("formats 10-digit landline with mask (XX) XXXX-XXXX", () => {
    expect(formatPhone("1133345566")).toBe("(11) 3334-5566");
  });

  it("strips non-digits before formatting", () => {
    expect(formatPhone("+55 (11) 99988-7766")).toBe("(11) 99988-7766");
  });

  it("returns the input when length is unexpected", () => {
    expect(formatPhone("123")).toBe("123");
  });
});

describe("generateReservationCode", () => {
  it("returns a 6-character uppercase alphanumeric code", () => {
    const code = generateReservationCode();
    expect(code).toMatch(/^[A-Z0-9]{6}$/);
  });

  it("returns a different code on each call (probabilistic)", () => {
    const codes = new Set(Array.from({ length: 50 }, () => generateReservationCode()));
    // 50 calls com 36^6 ≈ 2.1B possibilidades — colisão é absurdamente improvável.
    expect(codes.size).toBe(50);
  });
});
