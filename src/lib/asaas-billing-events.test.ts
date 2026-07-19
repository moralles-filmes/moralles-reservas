import { describe, it, expect } from "vitest";
import {
  buildExternalReference,
  parseExternalReference,
} from "../../supabase/functions/_shared/asaas-billing-events";

const ORG = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const PLAN = "9c858901-8a57-4791-81fe-4c455b099bc9";

describe("buildExternalReference", () => {
  it("builds the canonical shape", () => {
    expect(buildExternalReference({ orgId: ORG, planId: PLAN, purpose: "subscription" }))
      .toBe(`org:${ORG}|plan:${PLAN}|purpose:subscription`);
  });

  it("emits plan:none when there is no plan", () => {
    expect(buildExternalReference({ orgId: ORG, planId: null, purpose: "other" }))
      .toBe(`org:${ORG}|plan:none|purpose:other`);
  });

  it("stays within the Asaas 200-char limit", () => {
    const ref = buildExternalReference({ orgId: ORG, planId: PLAN, purpose: "implementation" });
    expect(ref.length).toBeLessThanOrEqual(200);
  });
});

describe("parseExternalReference", () => {
  it("round-trips what build produced", () => {
    const parts = { orgId: ORG, planId: PLAN, purpose: "subscription" as const };
    expect(parseExternalReference(buildExternalReference(parts))).toEqual(parts);
  });

  it("round-trips the no-plan form back to null", () => {
    const parts = { orgId: ORG, planId: null, purpose: "ai_topup" as const };
    expect(parseExternalReference(buildExternalReference(parts))).toEqual(parts);
  });

  it("rejects non-string input without throwing", () => {
    expect(parseExternalReference(null)).toBeNull();
    expect(parseExternalReference(undefined)).toBeNull();
    expect(parseExternalReference(42)).toBeNull();
    expect(parseExternalReference({})).toBeNull();
    expect(parseExternalReference([])).toBeNull();
  });

  it("rejects malformed shapes", () => {
    expect(parseExternalReference("")).toBeNull();
    expect(parseExternalReference("garbage")).toBeNull();
    expect(parseExternalReference(`org:${ORG}`)).toBeNull();
    expect(parseExternalReference(`org:${ORG}|plan:${PLAN}`)).toBeNull();
    expect(parseExternalReference(`plan:${PLAN}|org:${ORG}|purpose:subscription`)).toBeNull();
  });

  it("rejects a non-UUID org", () => {
    expect(parseExternalReference("org:not-a-uuid|plan:none|purpose:subscription")).toBeNull();
  });

  it("rejects a non-UUID plan that is not the literal none", () => {
    expect(parseExternalReference(`org:${ORG}|plan:nope|purpose:subscription`)).toBeNull();
  });

  it("rejects an unknown purpose", () => {
    expect(parseExternalReference(`org:${ORG}|plan:none|purpose:mystery`)).toBeNull();
  });

  it("accepts every purpose in the billing_invoices CHECK", () => {
    for (const p of ["subscription", "implementation", "ai_topup", "other"]) {
      const ref = `org:${ORG}|plan:none|purpose:${p}`;
      expect(parseExternalReference(ref)?.purpose).toBe(p);
    }
  });
});
