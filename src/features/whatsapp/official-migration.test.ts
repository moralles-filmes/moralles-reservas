import { describe, expect, it } from "vitest";
import { migrationProviderLabel, projectMigration, resolveReplacedChannel } from "./official-migration";

type Row = { id: string; provider: string | null; status: string | null; is_active: boolean | null; created_at?: string | null };
const row = (id: string, provider: string, is_active: boolean | null, status = "connected", created_at: string | null = "2025-01-01T00:00:00Z"): Row =>
  ({ id, provider, status, is_active, created_at });

describe("resolveReplacedChannel", () => {
  it("binding de outro provider é o substituído", () => {
    const uaz = row("b", "uazapi", true);
    expect(resolveReplacedChannel([row("a", "zapi", null), uaz, row("c", "datafy", false)])).toBe(uaz);
  });
  it("binding datafy: nada é substituído, nem legado de outro provider", () => {
    expect(resolveReplacedChannel([row("a", "datafy", true), row("b", "uazapi", null, "disconnected")])).toBeNull();
  });
  it("binding legado NULL+connected vence o fallback", () => {
    const connected = row("z", "uazapi", null, "connected", "2025-06-01T00:00:00Z");
    expect(resolveReplacedChannel([row("a", "zapi", null, "disconnected", "2025-01-01T00:00:00Z"), connected])).toBe(connected);
  });
  it("sem binding: legado mais antigo de outro provider, qualquer status", () => {
    const oldest = row("b", "zapi", null, "disconnected", "2025-01-01T00:00:00Z");
    expect(resolveReplacedChannel([
      row("a", "uazapi", null, "provider_error", "2025-03-01T00:00:00Z"),
      oldest,
      row("c", "datafy", null, "disconnected", "2024-01-01T00:00:00Z"),
    ])).toBe(oldest);
  });
  it("desempate por id e created_at nulo por último", () => {
    const first = row("a", "uazapi", null, "disconnected", "2025-01-01T00:00:00Z");
    expect(resolveReplacedChannel([row("b", "uazapi", null, "disconnected", "2025-01-01T00:00:00Z"), first])).toBe(first);
    const dated = row("z", "uazapi", null, "disconnected", "2026-01-01T00:00:00Z");
    expect(resolveReplacedChannel([row("a", "uazapi", null, "disconnected", null), dated])).toBe(dated);
  });
  it("is_active false nunca conta", () => {
    expect(resolveReplacedChannel([row("a", "uazapi", false, "connected")])).toBeNull();
    expect(resolveReplacedChannel([row("a", "uazapi", false), row("b", "datafy", null, "disconnected")])).toBeNull();
  });
  it("lista vazia ou ausente", () => {
    expect(resolveReplacedChannel([])).toBeNull();
    expect(resolveReplacedChannel(null)).toBeNull();
    expect(resolveReplacedChannel(undefined)).toBeNull();
  });
});

describe("projectMigration / migrationProviderLabel", () => {
  it("aceita provider conhecido de origem e descarta datafy", () => {
    expect(projectMigration({ fromProvider: "uazapi", channelId: "x" })).toEqual({ fromProvider: "uazapi" });
    expect(projectMigration({ fromProvider: "datafy" })).toBeNull();
  });
  it("rótulo conhecido e fallback cru", () => {
    expect(migrationProviderLabel("uazapi")).toBe("UazAPI");
    expect(migrationProviderLabel("constructor")).toBe("constructor");
  });
});
