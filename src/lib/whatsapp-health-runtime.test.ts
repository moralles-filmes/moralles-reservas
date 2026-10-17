import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readHealthIngestionMode } from "../../supabase/functions/_shared/whatsapp-health-runtime";
import { readSecureOpsAlertReadiness } from "../../supabase/functions/_shared/secure-ops-alert-sender";

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
  it("reports the configured sender separately from authenticated receiver readiness", async () => {
    const endpoint = "https://project.supabase.co/functions/v1/whatsapp-ops-alert-email";
    const config = { endpoint, projectUrl: "https://project.supabase.co", token: "A".repeat(43) };
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ready: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    expect(await readSecureOpsAlertReadiness(config, fetch)).toEqual({ senderConfigured: true, receiverReady: true });
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: "GET", redirect: "error", headers: { "x-ops-alert-key": config.token } });
    fetch.mockResolvedValue(new Response(JSON.stringify({ ready: false, code: "unavailable" }), { status: 503 }));
    expect(await readSecureOpsAlertReadiness(config, fetch)).toEqual({ senderConfigured: true, receiverReady: false });
    fetch.mockRejectedValue(new Error("private URL"));
    expect(await readSecureOpsAlertReadiness(config, fetch)).toEqual({ senderConfigured: true, receiverReady: false });
    expect(await readSecureOpsAlertReadiness({ ...config, endpoint: `${endpoint}?forged=1` }, fetch)).toEqual({ senderConfigured: false, receiverReady: false });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("wires authenticated tenant-scoped channel selection and safe metadata in the EF", () => {
    const source = readFileSync(resolve(__dirname, "../../supabase/functions/whatsapp-health/index.ts"), "utf8");
    expect(source.indexOf("isPlatformAdmin(callerData.user.id)")).toBeLessThan(source.indexOf('from("whatsapp_channels")'));
    expect(source).toContain('if (channelReadError) return jsonResponse');
    expect(source).toContain('.eq("unit_id", unitId)');
    expect(source).toContain("selectHealthChannel(rows)");
    expect(source).toContain("await readHealthIngestionMode(channelRow, providerRedelivery");
    expect(source).toContain('const opsAlertReadiness = await readSecureOpsAlertReadiness');
    expect(source).toContain('ops_alert_configured: opsAlertReadiness.receiverReady');
    expect(source).toContain("ingestion_mode_effective: ingestionMode");
  });
});
