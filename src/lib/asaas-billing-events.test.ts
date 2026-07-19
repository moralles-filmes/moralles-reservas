import { describe, it, expect } from "vitest";
import {
  buildExternalReference,
  parseExternalReference,
  decideEventEffect,
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

describe("decideEventEffect — gate de ativação", () => {
  it("activates on PAYMENT_CONFIRMED when the invoice is still open", () => {
    const e = decideEventEffect({
      eventType: "PAYMENT_CONFIRMED",
      invoiceStatus: "open",
      subscriptionStatus: null,
    });
    expect(e.kind).toBe("activate_subscription");
  });

  it("activates on PAYMENT_RECEIVED when the invoice is still open", () => {
    // PIX/boleto NUNCA emite CONFIRMED — provado ao vivo em 18/07/2026 (§5 do
    // doc 03). Um gate só-CONFIRMED deixaria todo cliente de PIX pagando sem
    // receber acesso, e funcionaria no cartão, escondendo o bug.
    const e = decideEventEffect({
      eventType: "PAYMENT_RECEIVED",
      invoiceStatus: "open",
      subscriptionStatus: null,
    });
    expect(e.kind).toBe("activate_subscription");
  });

  it("is idempotent: the card's second event is a noop", () => {
    // Cartão emite CONFIRMED e depois RECEIVED (até ~30d). O primeiro marcou a
    // invoice como paid; o segundo não pode ativar de novo.
    const e = decideEventEffect({
      eventType: "PAYMENT_RECEIVED",
      invoiceStatus: "paid",
      subscriptionStatus: "active",
    });
    expect(e.kind).toBe("noop");
  });

  it("is idempotent for CONFIRMED arriving after paid", () => {
    const e = decideEventEffect({
      eventType: "PAYMENT_CONFIRMED",
      invoiceStatus: "paid",
      subscriptionStatus: "active",
    });
    expect(e.kind).toBe("noop");
  });

  it("marks the invoice paid when there is no subscription to activate", () => {
    const e = decideEventEffect({
      eventType: "PAYMENT_RECEIVED",
      invoiceStatus: null,
      subscriptionStatus: null,
    });
    expect(e.kind).toBe("mark_invoice_paid");
  });
});

describe("decideEventEffect — demais eventos", () => {
  it("marks overdue on PAYMENT_OVERDUE", () => {
    expect(decideEventEffect({
      eventType: "PAYMENT_OVERDUE",
      invoiceStatus: "open",
      subscriptionStatus: "active",
    }).kind).toBe("mark_invoice_overdue");
  });

  it("does not re-mark an already paid invoice as overdue", () => {
    expect(decideEventEffect({
      eventType: "PAYMENT_OVERDUE",
      invoiceStatus: "paid",
      subscriptionStatus: "active",
    }).kind).toBe("noop");
  });

  it("records refunds and chargebacks", () => {
    for (const ev of [
      "PAYMENT_REFUNDED",
      "PAYMENT_PARTIALLY_REFUNDED",
      "PAYMENT_CHARGEBACK_REQUESTED",
      "PAYMENT_AWAITING_CHARGEBACK_REVERSAL",
    ]) {
      expect(decideEventEffect({
        eventType: ev,
        invoiceStatus: "paid",
        subscriptionStatus: "active",
      }).kind).toBe("record_refund");
    }
  });

  it("treats informational payment events as noop, not unknown", () => {
    for (const ev of ["PAYMENT_CREATED", "PAYMENT_UPDATED", "PAYMENT_BANK_SLIP_VIEWED"]) {
      expect(decideEventEffect({
        eventType: ev,
        invoiceStatus: "open",
        subscriptionStatus: null,
      }).kind).toBe("noop");
    }
  });

  it("returns unknown for an event outside the Asaas catalogue", () => {
    expect(decideEventEffect({
      eventType: "SOMETHING_NEW",
      invoiceStatus: null,
      subscriptionStatus: null,
    }).kind).toBe("unknown");
  });

  it("does not match chargeback events by prefix", () => {
    // PAYMENT_AWAITING_CHARGEBACK_REVERSAL não começa com PAYMENT_CHARGEBACK_.
    // Um matcher por prefixo erraria justamente esse.
    expect(decideEventEffect({
      eventType: "PAYMENT_AWAITING_CHARGEBACK_REVERSAL",
      invoiceStatus: "paid",
      subscriptionStatus: "active",
    }).kind).toBe("record_refund");
  });

  it("always fills a reason for observability", () => {
    const e = decideEventEffect({
      eventType: "PAYMENT_RECEIVED",
      invoiceStatus: "open",
      subscriptionStatus: null,
    });
    expect(e.reason.length).toBeGreaterThan(0);
  });
});
