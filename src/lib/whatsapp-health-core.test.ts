import { describe, expect, it } from "vitest";
import { selectHealthChannel } from "../../supabase/functions/_shared/whatsapp-health-core";
import { isOpsAlertConfigured } from "../../supabase/functions/_shared/ops-alert-sender";

describe("diagnostic channel selection", () => {
  const old = { is_active: false, status: "connected", created_at: "2026-01-01" };
  const recent = { is_active: false, status: "disconnected", created_at: "2026-02-01" };
  it("inspects newest onboarding without an operational binding", () => expect(selectHealthChannel([old, recent])).toBe(recent));
  it("preserves active and legacy connected bindings", () => {
    const legacy = { ...old, is_active: null };
    const active = { ...old, is_active: true };
    expect(selectHealthChannel([recent, legacy])).toBe(legacy);
    expect(selectHealthChannel([legacy, active, recent])).toBe(active);
    expect(selectHealthChannel([])).toBeNull();
  });
});
describe("ops alert diagnostic", () => {
  it("accepts only safe HTTPS endpoint configuration", () => {
    expect(isOpsAlertConfigured("https://alerts.example.test/path")).toBe(true);
    for (const value of [undefined, "", "invalid", "http://alerts.example.test", "https://user:pass@alerts.example.test", "https://alerts.example.test/#fragment"]) {
      expect(isOpsAlertConfigured(value)).toBe(false);
    }
  });
});
