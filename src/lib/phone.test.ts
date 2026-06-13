import { describe, it, expect } from "vitest";
import { normalizeBrPhone, canonicalBrPhone, validateBrPhone, isValidBrPhone } from "./phone";

describe("normalizeBrPhone", () => {
  it("strips non-digits", () => {
    expect(normalizeBrPhone("(11) 99999-8888")).toBe("11999998888");
  });
  it("removes country code 55 from 12/13-digit numbers", () => {
    expect(normalizeBrPhone("5511999998888")).toBe("11999998888"); // 13
    expect(normalizeBrPhone("551133334444")).toBe("1133334444"); // 12
  });
  it("keeps 55 when it is the DDD (11 digits, not a country prefix)", () => {
    expect(normalizeBrPhone("55999998888")).toBe("55999998888"); // DDD 55 (RS)
  });
  it("handles null/undefined", () => {
    expect(normalizeBrPhone(null)).toBe("");
    expect(normalizeBrPhone(undefined)).toBe("");
  });
});

describe("canonicalBrPhone", () => {
  it("adds the 9th digit to a 10-digit mobile (the dup bug)", () => {
    expect(canonicalBrPhone("4391336361")).toBe("43991336361");
    expect(canonicalBrPhone("(43) 9133-6361")).toBe("43991336361");
  });
  it("keeps an 11-digit mobile unchanged", () => {
    expect(canonicalBrPhone("43991336361")).toBe("43991336361");
    expect(canonicalBrPhone("(43) 99133-6361")).toBe("43991336361");
  });
  it("strips country code 55 then canonicalizes", () => {
    expect(canonicalBrPhone("554391336361")).toBe("43991336361"); // 12 díg, sem o 9
    expect(canonicalBrPhone("5543991336361")).toBe("43991336361"); // 13 díg, com o 9
  });
  it("leaves a 10-digit landline untouched (3rd digit 2-5)", () => {
    expect(canonicalBrPhone("4330251234")).toBe("4330251234");
  });
  it("does not touch the DDD 55 (RS) 11-digit number", () => {
    expect(canonicalBrPhone("55999998888")).toBe("55999998888");
  });
  it("handles empty/short input", () => {
    expect(canonicalBrPhone(null)).toBe("");
    expect(canonicalBrPhone(undefined)).toBe("");
    expect(canonicalBrPhone("123")).toBe("123");
  });
});

describe("validateBrPhone", () => {
  it("accepts valid 11-digit mobile", () => {
    expect(validateBrPhone("11999998888").valid).toBe(true);
    expect(validateBrPhone("(11) 99999-8888").valid).toBe(true);
  });
  it("accepts valid 10-digit landline", () => {
    expect(validateBrPhone("1133334444").valid).toBe(true);
  });
  it("accepts number with country code 55", () => {
    expect(validateBrPhone("5511999998888").valid).toBe(true);
    expect(validateBrPhone("5511999998888").digits).toBe("11999998888");
  });
  it("rejects invalid DDD (the real bug: 12-digit starting 01)", () => {
    const r = validateBrPhone("019999999999");
    expect(r.valid).toBe(false);
    expect(r.reason).toContain("inválido");
  });
  it("rejects DDD not in the official list", () => {
    expect(validateBrPhone("20999998888").valid).toBe(false); // 20 inválido
    expect(validateBrPhone("00999998888").valid).toBe(false);
  });
  it("rejects 10-digit mobile missing the 9", () => {
    expect(validateBrPhone("1199999888").valid).toBe(false); // 10 díg começando 9
  });
  it("rejects 11-digit whose 3rd digit is not 9", () => {
    expect(validateBrPhone("11333344445").valid).toBe(false);
  });
  it("rejects wrong length", () => {
    expect(validateBrPhone("119999").valid).toBe(false);
    expect(validateBrPhone("119999988887777").valid).toBe(false);
  });
  it("rejects all-same digits", () => {
    expect(validateBrPhone("11111111111").valid).toBe(false);
  });
  it("respects allowEmpty", () => {
    expect(validateBrPhone("", { allowEmpty: true }).valid).toBe(true);
    expect(validateBrPhone("", { allowEmpty: false }).valid).toBe(false);
    expect(validateBrPhone("").valid).toBe(false); // default: required
  });
  it("returns normalized digits on success", () => {
    expect(validateBrPhone("(11) 99999-8888").digits).toBe("11999998888");
  });
});

describe("isValidBrPhone", () => {
  it("is a boolean shortcut", () => {
    expect(isValidBrPhone("11999998888")).toBe(true);
    expect(isValidBrPhone("019999999999")).toBe(false);
  });
});
