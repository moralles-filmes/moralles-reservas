import { describe, expect, it } from "vitest";
import { ipRateKey, trustedClientIp } from "./ip-rate-key";

describe("public waitlist IP bucket", () => {
  it("uses Cloudflare's connecting IP rather than a spoofed X-Forwarded-For prefix", async () => {
    const first = new Headers({
      "cf-connecting-ip": "203.0.113.9",
      "x-forwarded-for": "198.51.100.10, 203.0.113.9",
    });
    const spoofed = new Headers({
      "cf-connecting-ip": "203.0.113.9",
      "x-forwarded-for": "192.0.2.55, 203.0.113.9",
    });
    expect(trustedClientIp(first)).toBe("203.0.113.9");
    expect(await ipRateKey(first)).toBe(await ipRateKey(spoofed));
    expect(await ipRateKey(first)).toMatch(/^public-waitlist-ip:[0-9a-f]{64}$/);
  });

  it("fails closed when the trusted header is missing or ambiguous", async () => {
    for (const value of [null, "203.0.113.9, 192.0.2.1", "203.0.113.999", "01.2.3.4", "not-an-ip", "2001:db8:::1"]) {
      const headers = new Headers({ "x-forwarded-for": "192.0.2.1" });
      if (value !== null) headers.set("cf-connecting-ip", value);
      expect(trustedClientIp(headers)).toBeNull();
      expect(await ipRateKey(headers)).toBeNull();
    }
  });

  it("canonicalizes valid IPv6 and separates different clients", async () => {
    const long = new Headers({ "cf-connecting-ip": "2001:0db8:0000:0000:0000:0000:0000:0001" });
    const short = new Headers({ "cf-connecting-ip": "2001:db8::1" });
    const other = new Headers({ "cf-connecting-ip": "2001:db8::2" });
    expect(await ipRateKey(long)).toBe(await ipRateKey(short));
    expect(await ipRateKey(short)).not.toBe(await ipRateKey(other));
  });
});
