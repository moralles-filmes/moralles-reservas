import { describe, expect, it } from "vitest";
import {
  createSeatLinkToken,
  hashSeatLinkToken,
  isSeatLinkToken,
  SEAT_LINK_TTL_HOURS,
} from "../../supabase/functions/_shared/seat-link-core";
import { ipRateKeyFor } from "../../supabase/functions/_shared/ip-rate-key";
import { ipRateKey } from "../../supabase/functions/public-waitlist/ip-rate-key";

describe("seat-link-core", () => {
  it("token tem 43 caracteres base64url, sem padding, e não se repete", () => {
    const a = createSeatLinkToken();
    const b = createSeatLinkToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(isSeatLinkToken(a)).toBe(true);
    expect(a).not.toBe(b);
  });

  it("isSeatLinkToken recusa formato errado", () => {
    for (const bad of ["", "abc", "a".repeat(42), "a".repeat(44), `${"a".repeat(42)}=`, `${"a".repeat(42)}+`]) {
      expect(isSeatLinkToken(bad)).toBe(false);
    }
  });

  it("hash é SHA-256 hex minúsculo (formato de token_hash) e determinístico", async () => {
    const h = await hashSeatLinkToken("abc");
    expect(h).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("TTL de 6 h (a tabela aceita até 24 h)", () => {
    expect(SEAT_LINK_TTL_HOURS).toBe(6);
  });
});

describe("ipRateKeyFor", () => {
  const headers = new Headers({ "cf-connecting-ip": "203.0.113.9" });

  it("prefixo exigido pela RPC do mapa e balde separado da fila", async () => {
    const seat = await ipRateKeyFor(headers, "public-seat-map");
    expect(seat).toMatch(/^public-seat-map-ip:[0-9a-f]{64}$/);
    expect(seat!.slice(-64)).not.toBe((await ipRateKey(headers))!.slice(-64));
  });

  it("a chave da fila pública continua idêntica", async () => {
    expect(await ipRateKey(headers)).toBe(await ipRateKeyFor(headers, "public-waitlist"));
    expect(await ipRateKey(headers)).toMatch(/^public-waitlist-ip:[0-9a-f]{64}$/);
  });
});
