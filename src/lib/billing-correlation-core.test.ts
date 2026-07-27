import { describe, it, expect } from "vitest";
import {
  resolveCorrelation,
  type CorrelationCandidate,
} from "../../supabase/functions/_shared/billing-correlation-core";

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const PLAN = "33333333-3333-3333-3333-333333333333";
const SUB = "44444444-4444-4444-4444-444444444444";

function c(p: Partial<CorrelationCandidate> & { source: CorrelationCandidate["source"] }): CorrelationCandidate {
  return {
    organizationId: null, subscriptionId: null, planId: null, purpose: null, ...p,
  };
}

describe("resolveCorrelation", () => {
  it("sem candidato com organização devolve unresolved", () => {
    expect(resolveCorrelation([]).kind).toBe("unresolved");
    expect(resolveCorrelation([c({ source: "billing_customer" })]).kind).toBe("unresolved");
  });

  it("resolve a renovação apenas pela assinatura do provedor", () => {
    const out = resolveCorrelation([
      c({ source: "provider_subscription", organizationId: ORG_A, subscriptionId: SUB, planId: PLAN, purpose: "subscription" }),
    ]);
    expect(out).toMatchObject({
      kind: "resolved", organizationId: ORG_A, subscriptionId: SUB,
      planId: PLAN, purpose: "subscription",
    });
  });

  it("degrau superior vence e o inferior só completa campo faltante", () => {
    const out = resolveCorrelation([
      c({ source: "checkout_session", organizationId: ORG_A, planId: "outro-plano", purpose: "implementation" }),
      c({ source: "provider_subscription", organizationId: ORG_A, subscriptionId: SUB, purpose: "subscription" }),
    ]);
    // provider_subscription (rank 2) vence checkout_session (rank 4) em purpose;
    // planId vem do checkout porque a assinatura não trouxe.
    expect(out).toMatchObject({ kind: "resolved", purpose: "subscription", planId: "outro-plano", subscriptionId: SUB });
  });

  it("divergência de organização entre degraus é conflito, não escolha", () => {
    const out = resolveCorrelation([
      c({ source: "provider_subscription", organizationId: ORG_A }),
      c({ source: "checkout_session", organizationId: ORG_B }),
    ]);
    expect(out.kind).toBe("conflict");
    if (out.kind === "conflict") {
      expect(out.reason).toBe("organization_divergence");
      expect(out.sources.map((s) => s.organizationId).sort()).toEqual([ORG_A, ORG_B].sort());
    }
  });

  it("candidato sem organização nunca gera conflito", () => {
    const out = resolveCorrelation([
      c({ source: "provider_subscription", organizationId: ORG_A }),
      c({ source: "billing_customer" }),
    ]);
    expect(out.kind).toBe("resolved");
  });

  it("registra em `via` todos os degraus que contribuíram", () => {
    const out = resolveCorrelation([
      c({ source: "external_reference", organizationId: ORG_A, planId: PLAN }),
      c({ source: "provider_subscription", organizationId: ORG_A, subscriptionId: SUB }),
    ]);
    if (out.kind !== "resolved") throw new Error("esperado resolved");
    expect(out.via).toEqual(["provider_subscription", "external_reference"]);
  });

  it("divergência de plano não é fatal — o degrau superior vence", () => {
    const out = resolveCorrelation([
      c({ source: "provider_subscription", organizationId: ORG_A, planId: "plano-da-assinatura" }),
      c({ source: "external_reference", organizationId: ORG_A, planId: "plano-do-checkout" }),
    ]);
    expect(out).toMatchObject({ kind: "resolved", planId: "plano-da-assinatura" });
  });
});
