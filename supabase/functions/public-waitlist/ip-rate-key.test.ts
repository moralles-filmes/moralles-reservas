import { describe, expect, it } from "vitest";
import { ipRateKey, trustedClientIp } from "./ip-rate-key";
import { rateBucketForIp } from "../_shared/ip-rate-key";

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

  it("canonicalizes valid IPv6 and buckets it by /64", async () => {
    const long = new Headers({ "cf-connecting-ip": "2001:0db8:0000:0000:0000:0000:0000:0001" });
    const short = new Headers({ "cf-connecting-ip": "2001:db8::1" });
    const sameNet = new Headers({ "cf-connecting-ip": "2001:db8::abcd:2" });
    const otherNet = new Headers({ "cf-connecting-ip": "2001:db8:0:1::1" });
    expect(await ipRateKey(long)).toBe(await ipRateKey(short));
    // Girar o endereço dentro do mesmo /64 não abre balde novo.
    expect(await ipRateKey(sameNet)).toBe(await ipRateKey(short));
    expect(await ipRateKey(otherNet)).not.toBe(await ipRateKey(short));
  });

  it("rateBucketForIp: IPv4 inteiro, IPv6 por /64, IPv4 mapeado volta a IPv4", () => {
    expect(rateBucketForIp("203.0.113.9")).toBe("203.0.113.9");
    expect(rateBucketForIp("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
    expect(rateBucketForIp("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(rateBucketForIp("::1")).toBe("0:0:0:0::/64");
    expect(rateBucketForIp("::ffff:cb00:7109")).toBe("203.0.113.9");
    expect(rateBucketForIp("::ffff:cb00:710a")).not.toBe(rateBucketForIp("::ffff:cb00:7109"));
  });

  it("IPv4 mapeado no cabeçalho cai no mesmo balde do IPv4", async () => {
    const mapped = new Headers({ "cf-connecting-ip": "::ffff:203.0.113.9" });
    const plain = new Headers({ "cf-connecting-ip": "203.0.113.9" });
    expect(await ipRateKey(mapped)).toBe(await ipRateKey(plain));
  });
});
