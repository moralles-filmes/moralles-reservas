import { describe, expect, it } from "vitest";
import {
  INSTAGRAM_REFRESH_MIN_AGE_MS,
  decideTokenRefresh,
} from "../../supabase/functions/_shared/instagram-token-refresh-core.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 29, 12);
const iso = (ms: number) => new Date(ms).toISOString();
const base = {
  status: "connected",
  tokenRefreshedAt: null as string | null,
  connectedAt: iso(NOW - 1 * DAY),
  tokenExpiresAt: iso(NOW + 50 * DAY) as string | null,
  nowMs: NOW,
};

describe("decideTokenRefresh", () => {
  it("expõe o limite de 30 dias", () => {
    expect(INSTAGRAM_REFRESH_MIN_AGE_MS).toBe(30 * DAY);
  });
  it("29 dias de idade: skip", () => {
    expect(decideTokenRefresh({ ...base, connectedAt: iso(NOW - 29 * DAY) })).toBe("skip");
  });
  it("30 dias de idade: refresh", () => {
    expect(decideTokenRefresh({ ...base, connectedAt: iso(NOW - 30 * DAY) })).toBe("refresh");
  });
  it("vencido: expired (mesmo velho demais)", () => {
    expect(decideTokenRefresh({ ...base, connectedAt: iso(NOW - 61 * DAY), tokenExpiresAt: iso(NOW - 1) })).toBe("expired");
    expect(decideTokenRefresh({ ...base, tokenExpiresAt: iso(NOW) })).toBe("expired");
  });
  it("reauth_required e disconnected: skip", () => {
    const old = { connectedAt: iso(NOW - 40 * DAY) };
    expect(decideTokenRefresh({ ...base, ...old, status: "reauth_required" })).toBe("skip");
    expect(decideTokenRefresh({ ...base, ...old, status: "disconnected" })).toBe("skip");
    expect(decideTokenRefresh({ ...base, ...old, status: "disconnected", tokenExpiresAt: iso(NOW - 1) })).toBe("skip");
  });
  it("usa tokenRefreshedAt quando existe", () => {
    const connectedAt = iso(NOW - 90 * DAY);
    expect(decideTokenRefresh({ ...base, connectedAt, tokenRefreshedAt: iso(NOW - 2 * DAY) })).toBe("skip");
    expect(decideTokenRefresh({ ...base, connectedAt, tokenRefreshedAt: iso(NOW - 31 * DAY) })).toBe("refresh");
  });
  it("sem tokenRefreshedAt usa connectedAt", () => {
    expect(decideTokenRefresh({ ...base, tokenRefreshedAt: null, connectedAt: iso(NOW - 45 * DAY) })).toBe("refresh");
  });
  it("sem tokenExpiresAt: decide só pela idade", () => {
    expect(decideTokenRefresh({ ...base, tokenExpiresAt: null, connectedAt: iso(NOW - 31 * DAY) })).toBe("refresh");
  });
  it("datas ilegíveis: skip, nunca refresh", () => {
    expect(decideTokenRefresh({ ...base, connectedAt: "lixo" })).toBe("skip");
    expect(decideTokenRefresh({ ...base, tokenRefreshedAt: "lixo", connectedAt: iso(NOW - 90 * DAY) })).toBe("skip");
    expect(decideTokenRefresh({ ...base, connectedAt: iso(NOW - 90 * DAY), tokenExpiresAt: "lixo" })).toBe("skip");
    expect(decideTokenRefresh({ ...base, connectedAt: iso(NOW - 90 * DAY), nowMs: Number.NaN })).toBe("skip");
  });
});
