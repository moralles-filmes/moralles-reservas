import { describe, expect, it } from "vitest";
import { resolveHandoffClock } from "../../supabase/functions/_shared/handoff-clock-core";

const now = Date.parse("2026-10-19T12:00:00.000Z");
const t1 = "2026-10-19T08:00:00.000Z";
const t2 = "2026-10-19T09:00:00.000Z";

describe("resolveHandoffClock", () => {
  it("uses handoff_at when there is no human message", () => {
    expect(resolveHandoffClock({ handoffAt: t1, lastHumanTs: 0, nowMs: now })).toEqual({
      silenceStartMs: Date.parse(t1),
      persistHandoffAt: null,
    });
  });

  it("uses the last human message when handoff_at is null", () => {
    expect(resolveHandoffClock({ handoffAt: null, lastHumanTs: Date.parse(t2), nowMs: now })).toEqual({
      silenceStartMs: Date.parse(t2),
      persistHandoffAt: null,
    });
  });

  it("takes the maximum of handoff_at and the last human message", () => {
    expect(resolveHandoffClock({ handoffAt: t2, lastHumanTs: Date.parse(t1), nowMs: now }).silenceStartMs).toBe(Date.parse(t2));
    expect(resolveHandoffClock({ handoffAt: t1, lastHumanTs: Date.parse(t2), nowMs: now }).silenceStartMs).toBe(Date.parse(t2));
  });

  it("starts the clock now and asks to persist when both are absent", () => {
    expect(resolveHandoffClock({ handoffAt: null, lastHumanTs: 0, nowMs: now })).toEqual({
      silenceStartMs: now,
      persistHandoffAt: "2026-10-19T12:00:00.000Z",
    });
  });

  it("treats an invalid handoff_at as absent", () => {
    expect(resolveHandoffClock({ handoffAt: "not-a-date", lastHumanTs: 0, nowMs: now })).toEqual({
      silenceStartMs: now,
      persistHandoffAt: "2026-10-19T12:00:00.000Z",
    });
    expect(resolveHandoffClock({ handoffAt: "not-a-date", lastHumanTs: Date.parse(t1), nowMs: now })).toEqual({
      silenceStartMs: Date.parse(t1),
      persistHandoffAt: null,
    });
  });
});
