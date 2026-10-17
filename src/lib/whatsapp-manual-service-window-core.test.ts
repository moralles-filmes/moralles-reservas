import { describe, expect, it } from "vitest";
import { evaluateManualServiceWindow, MANUAL_SERVICE_WINDOW_MS } from "../../supabase/functions/_shared/whatsapp-manual-service-window-core";

const now = Date.parse("2026-10-16T15:00:00.000Z");

describe("manual Meta service window", () => {
  it("uses the maximum valid customer timestamp regardless of JSONB order", () => {
    const messages = [
      { role: "human", timestamp: "2026-10-16T15:00:00.000Z" },
      { role: "user", timestamp: "2026-10-15T15:00:00.000Z" },
      { role: "assistant", timestamp: "2026-10-16T14:59:59.000Z" },
      { role: "user", timestamp: "2026-10-16T14:00:00.000Z" },
      { role: "user", timestamp: "2026-10-15T20:00:00.000Z" },
    ];
    expect(evaluateManualServiceWindow(messages, now)).toEqual({
      open: true,
      lastInboundAt: "2026-10-16T14:00:00.000Z",
      closesAt: "2026-10-17T14:00:00.000Z",
    });
  });

  it("closes exactly at 24 hours", () => {
    const messages = [{ role: "user", timestamp: new Date(now - MANUAL_SERVICE_WINDOW_MS).toISOString() }];
    expect(evaluateManualServiceWindow(messages, now).open).toBe(false);
    expect(evaluateManualServiceWindow(messages, now - 1).open).toBe(true);
  });

  it("ignores future, invalid, and non-customer timestamps", () => {
    const messages = [
      { role: "user", timestamp: "2026-10-17T15:00:00.000Z" },
      { role: "user", timestamp: "invalid" },
      { role: "user", timestamp: "2026-10-16T14:00:00" },
      { role: "user", timestamp: "2026-02-30T14:00:00.000Z" },
      { role: "user", timestamp: "2026-10-16T24:00:00.000Z" },
      { role: "assistant", timestamp: "2026-10-16T14:00:00.000Z" },
      { role: "human", timestamp: "2026-10-16T14:00:00.000Z" },
    ];
    expect(evaluateManualServiceWindow(messages, now).open).toBe(false);
    expect(evaluateManualServiceWindow([...messages, { role: "user", timestamp: "2026-10-16T12:00:00.000Z" }], now).open).toBe(true);
    expect(evaluateManualServiceWindow(null, now).open).toBe(false);
    expect(evaluateManualServiceWindow(messages, NaN).open).toBe(false);
  });
});
