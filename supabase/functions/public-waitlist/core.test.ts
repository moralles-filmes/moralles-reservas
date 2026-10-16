import { describe, expect, it, vi } from "vitest";
import { parsePublicWaitlistInput, submitPublicWaitlist, type PublicWaitlistDeps } from "./core";
import { validateBrPhone as frontendValidateBrPhone } from "../../../src/lib/phone";
import { validateBrPhone as backendValidateBrPhone } from "../_shared/public-br-phone";

const unitId = "11111111-1111-4111-8111-111111111111";
const entryId = "22222222-2222-4222-8222-222222222222";
const customerId = "33333333-3333-4333-8333-333333333333";
const input = {
  unit_id: unitId,
  customer_name: "Ana Silva",
  customer_phone: "(11) 98765-4321",
  party_size: 2,
  priority_category: "normal",
};

function dependencies(): PublicWaitlistDeps & Record<string, ReturnType<typeof vi.fn>> {
  return {
    publicUnit: vi.fn().mockResolvedValue({ organizationId: "org-from-db", billingStatus: "active" }),
    rateLimit: vi.fn().mockResolvedValue(true),
    enter: vi.fn().mockResolvedValue({ id: entryId, code: 42 }),
    customer: vi.fn().mockResolvedValue(customerId),
    link: vi.fn().mockResolvedValue(true),
    consent: vi.fn().mockResolvedValue(true),
    onFailure: vi.fn(),
  };
}

describe("public waitlist", () => {
  it("validates inputs before service-role RPC, including the anon party limit", async () => {
    const deps = dependencies();
    for (const invalid of [
      null, { ...input, party_size: 21 }, { ...input, party_size: 1.5 },
      { ...input, customer_phone: "123" }, { ...input, customer_name: " " },
      { ...input, customer_phone: "20999998888" },
      { ...input, customer_phone: "1199999888" },
      { ...input, customer_phone: "11333344445" },
      { ...input, customer_phone: "11111111111" },
      { ...input, priority_category: "vip" }, { ...input, unit_id: "x" },
    ]) {
      expect((await submitPublicWaitlist(invalid, deps)).status).toBe(400);
    }
    expect(deps.publicUnit).not.toHaveBeenCalled();
    expect(parsePublicWaitlistInput(input)?.phone).toBe("11987654321");
  });

  it("keeps public backend phone validation aligned with the form", () => {
    for (const phone of [
      "11999998888", "(11) 99999-8888", "+55 (55) 99999-8888",
      "1133334444", "01999998888", "20999998888", "1199999888",
      "11333344445", "11111111111", "119999", "",
    ]) {
      expect(backendValidateBrPhone(phone)).toBe(frontendValidateBrPhone(phone).valid);
    }
  });

  it("refuses private unit, private org and blocked billing without entering", async () => {
    for (const unavailable of [null, { organizationId: "org", billingStatus: "blocked" }, { organizationId: "org", billingStatus: "suspended" }]) {
      const deps = dependencies();
      deps.publicUnit.mockResolvedValue(unavailable);
      expect((await submitPublicWaitlist(input, deps)).status).toBe(403);
      expect(deps.enter).not.toHaveBeenCalled();
    }
  });

  it("fails closed on rate-limit refusal or dependency failure", async () => {
    const deps = dependencies();
    deps.rateLimit.mockResolvedValue(false);
    expect((await submitPublicWaitlist(input, deps)).status).toBe(429);
    deps.rateLimit.mockRejectedValue(new Error("private detail"));
    expect((await submitPublicWaitlist(input, deps)).status).toBe(503);
    expect(deps.enter).not.toHaveBeenCalled();
  });

  it("does not create customer or consent when entry is refused", async () => {
    const deps = dependencies();
    deps.enter.mockRejectedValue(new Error("private detail"));
    expect((await submitPublicWaitlist({ ...input, marketing_opt_in: true }, deps)).status).toBe(503);
    expect(deps.customer).not.toHaveBeenCalled();
    expect(deps.consent).not.toHaveBeenCalled();
  });

  it("links existing or newly created customer using org derived from unit", async () => {
    for (const id of [customerId, "44444444-4444-4444-8444-444444444444"]) {
      const deps = dependencies();
      deps.customer.mockResolvedValue(id);
      const result = await submitPublicWaitlist({ ...input, organization_id: "forged" }, deps);
      expect(result).toEqual({ status: 200, body: { success: true, code: 42 } });
      expect(deps.customer).toHaveBeenCalledWith(expect.objectContaining({ phone: "11987654321" }), "org-from-db");
      expect(deps.link).toHaveBeenCalledWith(entryId, unitId, id);
    }
  });

  it("only literal true records consent after the customer link", async () => {
    for (const value of [undefined, false, "true", 1, null]) {
      const deps = dependencies();
      await submitPublicWaitlist({ ...input, marketing_opt_in: value }, deps);
      expect(deps.consent).not.toHaveBeenCalled();
    }
    const deps = dependencies();
    await submitPublicWaitlist({ ...input, marketing_opt_in: true }, deps);
    expect(deps.consent).toHaveBeenCalledWith(unitId, customerId, entryId);
    expect(deps.link.mock.invocationCallOrder[0]).toBeLessThan(deps.consent.mock.invocationCallOrder[0]);
  });

  it("returns committed code with a warning on customer, link race or consent failure", async () => {
    for (const stage of ["customer", "link", "consent"] as const) {
      const deps = dependencies();
      if (stage === "customer") deps.customer.mockRejectedValue(new Error("private detail"));
      if (stage === "link") deps.link.mockResolvedValue(false);
      if (stage === "consent") deps.consent.mockResolvedValue(false);
      const result = await submitPublicWaitlist({ ...input, marketing_opt_in: true }, deps);
      expect(result).toEqual({ status: 200, body: {
        success: true, code: 42,
        warning: stage === "consent" ? "consent_not_recorded" : "registration_incomplete",
      } });
      expect(deps.enter).toHaveBeenCalledTimes(1);
      expect(deps.onFailure).toHaveBeenCalledWith({
        stage: stage === "link" ? "customer_link" : stage,
        reason: "dependency_error", unitId, waitlistId: entryId, marketingOptIn: true,
      });
      if (stage !== "consent") expect(deps.consent).not.toHaveBeenCalled();
    }
  });
});
