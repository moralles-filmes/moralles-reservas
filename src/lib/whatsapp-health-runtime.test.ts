import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readHealthIngestionMode } from "../../supabase/functions/_shared/whatsapp-health-runtime";
import { isOpsAlertConfigured, createOpsAlertSender } from "../../supabase/functions/_shared/ops-alert-sender";

describe("health ingestion runtime", () => {
  it("reads the flag only when both certain gates allow asynchronous ingestion", async () => {
    const flag = vi.fn().mockResolvedValue({ enabled: true, readFailed: false });
    expect(await readHealthIngestionMode(null, "documented", flag)).toBeNull();
    expect(await readHealthIngestionMode({ async_ingestion_enabled: false }, "documented", flag)).toBe("sync");
    expect(await readHealthIngestionMode({ async_ingestion_enabled: true }, "unmeasured", flag)).toBe("sync");
    expect(flag).not.toHaveBeenCalled();
    expect(await readHealthIngestionMode({ async_ingestion_enabled: true }, "documented", flag)).toBe("async");
    expect(flag).toHaveBeenCalledTimes(1);
  });
  it("preserves unknown on both failed reads and thrown failures, distinct from disabled", async () => {
    const channel = { async_ingestion_enabled: true };
    expect(await readHealthIngestionMode(channel, "documented", async () => ({ enabled: false, readFailed: true }))).toBe("unknown");
    expect(await readHealthIngestionMode(channel, "documented", async () => { throw new Error("synthetic"); })).toBe("unknown");
    expect(await readHealthIngestionMode(channel, "documented", async () => ({ enabled: false, readFailed: false }))).toBe("sync");
  });
  it("shares configuration policy with actual alert transport", async () => {
    for (const endpoint of [undefined, "http://alerts.test", "https://name:pass@alerts.test", "https://alerts.test/#x", "invalid", "https://alerts.test/path"]) {
      const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const result = await createOpsAlertSender(endpoint, fetch)({ evt: "test" });
      expect(result.delivered).toBe(isOpsAlertConfigured(endpoint));
      expect(fetch).toHaveBeenCalledTimes(isOpsAlertConfigured(endpoint) ? 1 : 0);
    }
  });
  it("wires authenticated tenant-scoped channel selection and safe metadata in the EF", () => {
    const source = readFileSync(resolve(__dirname, "../../supabase/functions/whatsapp-health/index.ts"), "utf8");
    expect(source.indexOf("isPlatformAdmin(callerData.user.id)")).toBeLessThan(source.indexOf('from("whatsapp_channels")'));
    expect(source).toContain('if (channelReadError) return jsonResponse');
    expect(source).toContain('.eq("unit_id", unitId)');
    expect(source).toContain("selectHealthChannel(rows)");
    expect(source).toContain("await readHealthIngestionMode(channelRow, providerRedelivery");
    expect(source).toContain('ops_alert_configured: isOpsAlertConfigured(Deno.env.get("WHATSAPP_OPS_ALERT_URL"))');
    expect(source).toContain("ingestion_mode_effective: ingestionMode");
  });
});
