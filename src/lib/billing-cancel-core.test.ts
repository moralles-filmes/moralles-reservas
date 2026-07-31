import { describe, it, expect } from "vitest";
import {
  decideCancelTarget,
  localCancelPatch,
} from "../../supabase/functions/_shared/billing-cancel-core";

describe("decideCancelTarget", () => {
  it("roteia asaas com provider_subscription_id", () => {
    expect(decideCancelTarget({
      provider: "asaas",
      provider_subscription_id: "sub_abc",
      stripe_subscription_id: null,
    })).toEqual({ kind: "provider", provider: "asaas", providerSubscriptionId: "sub_abc" });
  });

  it("roteia stripe com provider_subscription_id", () => {
    expect(decideCancelTarget({
      provider: "stripe",
      provider_subscription_id: "sub_stripe",
      stripe_subscription_id: "sub_stripe",
    })).toEqual({ kind: "provider", provider: "stripe", providerSubscriptionId: "sub_stripe" });
  });

  it("usa stripe_subscription_id como fallback em linha anterior ao backfill da 063", () => {
    expect(decideCancelTarget({
      provider: "stripe",
      provider_subscription_id: null,
      stripe_subscription_id: "sub_legado",
    })).toEqual({ kind: "provider", provider: "stripe", providerSubscriptionId: "sub_legado" });
  });

  it("NAO usa stripe_subscription_id como id de assinatura asaas", () => {
    expect(decideCancelTarget({
      provider: "asaas",
      provider_subscription_id: null,
      stripe_subscription_id: "sub_stripe",
    })).toEqual({ kind: "unroutable", provider: "asaas", reason: "missing_provider_id" });
  });

  it("manual cancela so' localmente", () => {
    expect(decideCancelTarget({
      provider: "manual",
      provider_subscription_id: null,
      stripe_subscription_id: null,
    })).toEqual({ kind: "local_only", provider: "manual" });
  });

  it("lifetime cancela so' localmente", () => {
    expect(decideCancelTarget({
      provider: "lifetime",
      provider_subscription_id: null,
      stripe_subscription_id: null,
    })).toEqual({ kind: "local_only", provider: "lifetime" });
  });

  it("asaas sem id nenhum e' irroteavel", () => {
    expect(decideCancelTarget({
      provider: "asaas",
      provider_subscription_id: null,
      stripe_subscription_id: null,
    })).toEqual({ kind: "unroutable", provider: "asaas", reason: "missing_provider_id" });
  });

  it("stripe sem id nenhum e' irroteavel", () => {
    expect(decideCancelTarget({
      provider: "stripe",
      provider_subscription_id: null,
      stripe_subscription_id: null,
    })).toEqual({ kind: "unroutable", provider: "stripe", reason: "missing_provider_id" });
  });

  it("provider desconhecido falha fechado", () => {
    expect(decideCancelTarget({
      provider: "paypal",
      provider_subscription_id: "sub_x",
      stripe_subscription_id: null,
    })).toEqual({ kind: "unroutable", provider: "paypal", reason: "unknown_provider" });
  });

  it("provider null falha fechado em vez de assumir stripe", () => {
    expect(decideCancelTarget({
      provider: null,
      provider_subscription_id: "sub_x",
      stripe_subscription_id: null,
    })).toEqual({ kind: "unroutable", provider: "", reason: "unknown_provider" });
  });
});

describe("localCancelPatch", () => {
  const now = "2026-07-31T18:00:00.000Z";

  it("immediate cancela de fato", () => {
    expect(localCancelPatch("immediate", now)).toEqual({
      status: "canceled",
      canceled_at: now,
      cancel_at_period_end: false,
      updated_at: now,
    });
  });

  it("at_period_end NAO toca em status", () => {
    const patch = localCancelPatch("at_period_end", now);
    expect(patch).toEqual({ cancel_at_period_end: true, updated_at: now });
    expect(patch).not.toHaveProperty("status");
    expect(patch).not.toHaveProperty("canceled_at");
  });
});
