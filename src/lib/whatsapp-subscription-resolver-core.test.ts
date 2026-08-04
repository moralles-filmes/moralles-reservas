import { describe, it, expect } from "vitest";
import {
  resolveWhatsAppSubscription,
  type WhatsAppSubscriptionFact,
} from "../../supabase/functions/_shared/whatsapp-subscription-resolver-core";

const fact = (o: Partial<WhatsAppSubscriptionFact>): WhatsAppSubscriptionFact => ({
  id: "s1",
  status: "active",
  category: "SYSTEM_SUBSCRIPTION",
  includedFeatures: [],
  canceledAt: null,
  suspendedAt: null,
  ...o,
});
const inc = (o: Partial<WhatsAppSubscriptionFact> = {}) =>
  fact({ id: "sys", includedFeatures: ["system", "whatsapp", "ai"], ...o });
const leg = (o: Partial<WhatsAppSubscriptionFact> = {}) =>
  fact({ id: "wa", category: "WHATSAPP_SUBSCRIPTION", ...o });

describe("resolveWhatsAppSubscription — fonte financeira do WhatsApp", () => {
  it("teste 23 — Plano 2 usa a assinatura de SISTEMA como fonte", () => {
    const r = resolveWhatsAppSubscription({ subscriptions: [inc()] });
    expect(r.kind).toBe("RESOLVED");
    if (r.kind !== "RESOLVED") return;
    expect(r.source).toBe("PLAN_INCLUDED");
    expect(r.provisioningAmbiguous).toBe(false);
  });

  it("teste 24 — legado usa WHATSAPP_SUBSCRIPTION", () => {
    const r = resolveWhatsAppSubscription({
      subscriptions: [fact({ id: "sys", includedFeatures: ["system"] }), leg()],
    });
    expect(r.kind).toBe("RESOLVED");
    if (r.kind !== "RESOLVED") return;
    expect(r.source).toBe("LEGACY_CATEGORY");
    expect(r.subscriptionId).toBe("wa");
  });

  it("categoria NAO sistemica com includedFeatures=[whatsapp] NAO vira PLAN_INCLUDED", () => {
    for (const cat of ["CUSTOM", "TRIAL", "AI_CREDIT_PACKAGE", "WHATSAPP_IMPLEMENTATION"]) {
      const r = resolveWhatsAppSubscription({
        subscriptions: [fact({ id: cat, category: cat, includedFeatures: ["whatsapp"] })],
      });
      expect(r.kind).toBe("NONE");
    }
  });

  describe("teste 25 — transicao: precedencia explicita de status", () => {
    const casos: Array<[string, string, string, string]> = [
      // [status do Plano 2, status do legado, id escolhido, descricao]
      ["active", "past_due", "sys", "P2 active vence legado past_due"],
      ["past_due", "active", "wa", "legado active vence P2 past_due"],
      ["trialing", "past_due", "sys", "P2 trialing vence legado past_due"],
      ["past_due", "trialing", "wa", "legado trialing vence P2 past_due"],
      ["active", "active", "sys", "empate active: preferencia pelo modelo novo"],
      ["past_due", "past_due", "sys", "empate past_due: preferencia pelo modelo novo"],
    ];
    for (const [sIncluded, sLegacy, expectedId, desc] of casos) {
      it(desc, () => {
        const r = resolveWhatsAppSubscription({
          subscriptions: [inc({ status: sIncluded }), leg({ status: sLegacy })],
        });
        expect(r.kind).toBe("RESOLVED");
        if (r.kind !== "RESOLVED") return;
        expect(r.subscriptionId).toBe(expectedId);
        // A escolha da fonte NAO remove nenhum dos tres marcadores:
        expect(r.source).toBe("TRANSITION");
        expect(r.adminPendency).toBe("LEGACY_WHATSAPP_SUBSCRIPTION_OPEN");
        expect(r.provisioningAmbiguous).toBe(true);
      });
    }
  });

  it("teste 26 — duplicidade legada nao escolhe a mais recente", () => {
    const r = resolveWhatsAppSubscription({
      subscriptions: [leg({ id: "wa2" }), leg({ id: "wa1" })],
    });
    expect(r.kind).toBe("AMBIGUOUS");
    if (r.kind !== "AMBIGUOUS") return;
    expect(r.reasonCode).toBe("DUPLICATE_SAME_CATEGORY");
    expect(r.candidateIds).toEqual(["wa1", "wa2"]); // ORDEM CANONICA, sem .sort() no teste
  });

  it("duplicidade PLAN_INCLUDED tambem e ambigua", () => {
    const r = resolveWhatsAppSubscription({
      subscriptions: [inc({ id: "b" }), inc({ id: "a" })],
    });
    expect(r.kind).toBe("AMBIGUOUS");
    if (r.kind !== "AMBIGUOUS") return;
    expect(r.candidateIds).toEqual(["a", "b"]);
  });

  it("nenhuma fonte: NONE, nunca excecao", () => {
    expect(resolveWhatsAppSubscription({ subscriptions: [] }).kind).toBe("NONE");
    expect(
      resolveWhatsAppSubscription({
        subscriptions: [fact({ includedFeatures: ["system"] })],
      }).kind,
    ).toBe("NONE");
  });

  it("cancelada nao e candidata; past_due e", () => {
    expect(resolveWhatsAppSubscription({ subscriptions: [leg({ status: "canceled" })] }).kind).toBe(
      "NONE",
    );
    expect(resolveWhatsAppSubscription({ subscriptions: [leg({ status: "past_due" })] }).kind).toBe(
      "RESOLVED",
    );
  });

  describe("insensibilidade a ordem das linhas", () => {
    const cenarios: Array<[string, WhatsAppSubscriptionFact[]]> = [
      ["transicao", [inc(), leg()]],
      ["duplicidade legada", [leg({ id: "wa1" }), leg({ id: "wa2" })]],
      ["duplicidade included", [inc({ id: "a" }), inc({ id: "b" })]],
      ["fonte unica", [inc()]],
      ["nenhuma fonte", [fact({ includedFeatures: ["system"] })]],
    ];
    for (const [nome, linhas] of cenarios) {
      it(`${nome}: mesmo resultado com a ordem invertida`, () => {
        const a = resolveWhatsAppSubscription({ subscriptions: linhas });
        const b = resolveWhatsAppSubscription({ subscriptions: [...linhas].reverse() });
        expect(a).toEqual(b);
      });
    }
  });
});
