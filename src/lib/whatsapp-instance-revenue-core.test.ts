import { describe, it, expect } from "vitest";
import {
  attributeRevenue,
  grossMarginCents,
  grossMarginDisplay,
  consolidateOrgMargin,
} from "../../supabase/functions/_shared/whatsapp-instance-revenue-core";

describe("attributeRevenue (spec §7.3)", () => {
  it("1 instância + 1 assinatura: receita é o valor da assinatura", () => {
    expect(
      attributeRevenue({
        activeInstanceCount: 1,
        subscriptionAmountCents: 14900,
        hasLifetimeWhatsappOverride: false,
      }),
    ).toEqual({ customerRevenueCents: 14900, revenueSource: "SUBSCRIPTION_SOLE_INSTANCE" });
  });

  it("N>1 instâncias + 1 assinatura: NULL — copiar os R$149 para cada uma inflaria a receita em N×", () => {
    expect(
      attributeRevenue({
        activeInstanceCount: 3,
        subscriptionAmountCents: 14900,
        hasLifetimeWhatsappOverride: false,
      }),
    ).toEqual({ customerRevenueCents: null, revenueSource: "AMBIGUOUS_MULTI_INSTANCE" });
  });

  it("override vitalício: ZERO verdadeiro, não desconhecido — e vence a assinatura", () => {
    expect(
      attributeRevenue({
        activeInstanceCount: 1,
        subscriptionAmountCents: 14900,
        hasLifetimeWhatsappOverride: true,
      }),
    ).toEqual({ customerRevenueCents: 0, revenueSource: "LIFETIME_OVERRIDE" });
  });

  it("override vitalício vence também com N instâncias", () => {
    expect(
      attributeRevenue({
        activeInstanceCount: 4,
        subscriptionAmountCents: null,
        hasLifetimeWhatsappOverride: true,
      }).revenueSource,
    ).toBe("LIFETIME_OVERRIDE");
  });

  it("sem assinatura e sem override: NULL + NO_ENTITLEMENT (gera alerta no caller)", () => {
    expect(
      attributeRevenue({
        activeInstanceCount: 1,
        subscriptionAmountCents: null,
        hasLifetimeWhatsappOverride: false,
      }),
    ).toEqual({ customerRevenueCents: null, revenueSource: "NO_ENTITLEMENT" });
  });

  it("assinatura de valor zero NÃO é ausência de assinatura", () => {
    expect(
      attributeRevenue({
        activeInstanceCount: 1,
        subscriptionAmountCents: 0,
        hasLifetimeWhatsappOverride: false,
      }),
    ).toEqual({ customerRevenueCents: 0, revenueSource: "SUBSCRIPTION_SOLE_INSTANCE" });
  });
});

describe("grossMarginCents", () => {
  it("receita menos custo", () => {
    expect(grossMarginCents(14900, 10000)).toBe(4900);
  });

  it("Ren Sushi: receita 0 e custo conhecido dá margem NEGATIVA — é o produto da fase", () => {
    expect(grossMarginCents(0, 10000)).toBe(-10000);
  });

  it("receita desconhecida não vira margem", () => {
    expect(grossMarginCents(null, 10000)).toBeNull();
  });

  it("custo desconhecido não vira margem", () => {
    expect(grossMarginCents(14900, null)).toBeNull();
  });
});

describe("grossMarginDisplay — nunca 0% para desconhecido (§7.3)", () => {
  it("receita positiva: percentual", () => {
    expect(grossMarginDisplay(14900, 10000)).toEqual({ kind: "PERCENT", value: (4900 / 14900) * 100 });
  });

  it("receita zero: NÃO APLICÁVEL, nunca 0% e nunca divisão por zero", () => {
    expect(grossMarginDisplay(0, 10000)).toEqual({ kind: "NOT_APPLICABLE" });
  });

  it("receita NULL: PENDENTE", () => {
    expect(grossMarginDisplay(null, 10000)).toEqual({ kind: "PENDING" });
  });

  it("custo NULL: PENDENTE", () => {
    expect(grossMarginDisplay(14900, null)).toEqual({ kind: "PENDING" });
  });
});

describe("consolidateOrgMargin — a margem verdadeira quando há N instâncias", () => {
  it("soma os custos conhecidos e conta os desconhecidos separadamente", () => {
    expect(consolidateOrgMargin([10000, null, 12000], 14900)).toEqual({
      knownCostCents: 22000,
      unknownCostInstances: 1,
      marginCents: null,
    });
  });

  it("com todos os custos conhecidos, a margem consolidada existe", () => {
    expect(consolidateOrgMargin([10000, 12000], 14900)).toEqual({
      knownCostCents: 22000,
      unknownCostInstances: 0,
      marginCents: -7100,
    });
  });

  it("receita NULL não produz margem consolidada", () => {
    expect(consolidateOrgMargin([10000], null).marginCents).toBeNull();
  });
});
