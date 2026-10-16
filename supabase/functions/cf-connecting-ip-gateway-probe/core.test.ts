import { describe, expect, it } from "vitest";
import { FORGED_MARKER, probeHeaders } from "./core";

describe("temporary hosted CF-Connecting-IP probe", () => {
  it("returns only booleans for a normal valid gateway header", () => {
    const result = probeHeaders(new Headers({
      "cf-connecting-ip": "203.0.113.9",
      "x-forwarded-for": FORGED_MARKER,
    }));
    expect(result).toEqual({ present: true, valid: true, equalsForgedMarker: false });
    expect(Object.values(result).every((value) => typeof value === "boolean")).toBe(true);
  });

  it("detects a forwarded forged marker in CF-Connecting-IP", () => {
    const result = probeHeaders(new Headers({
      "cf-connecting-ip": FORGED_MARKER,
      "x-forwarded-for": FORGED_MARKER,
    }));
    expect(result).toEqual({ present: true, valid: true, equalsForgedMarker: true });
  });

  it("distinguishes a missing or malformed trusted header from X-Forwarded-For", () => {
    expect(probeHeaders(new Headers({ "x-forwarded-for": FORGED_MARKER })))
      .toEqual({ present: false, valid: false, equalsForgedMarker: false });
    expect(probeHeaders(new Headers({
      "cf-connecting-ip": "bad-ip",
      "x-forwarded-for": FORGED_MARKER,
    }))).toEqual({ present: true, valid: false, equalsForgedMarker: false });
  });
});
