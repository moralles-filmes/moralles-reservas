import { describe, it, expect } from "vitest";
import {
  planCategory,
  planProvider,
  planBillingType,
  planIntervalLabel,
  showsStripeConfig,
  isAiCreditPackage,
  isSelectableSystemPlan,
} from "./billing-plan-display";
import type { BillingPlan } from "@/types/billing";

// Fase 3 da migração billing-asaas. O ponto destes testes é o campo AUSENTE:
// os campos da migration 063 são opcionais no tipo porque uma EF antiga
// deployada não os devolve, e um `undefined` vazando pra UI vira "categoria
// vazia" ou, pior, esconde a seção errada do formulário.

function plan(partial: Partial<BillingPlan> = {}): BillingPlan {
  return {
    id: "p1",
    name: "Plano",
    slug: "plano",
    description: null,
    stripe_price_id_card: null,
    stripe_price_id_boleto: null,
    stripe_price_id_pix: null,
    amount_cents: 44900,
    currency: "brl",
    interval: "month",
    max_units: null,
    max_members_per_unit: null,
    features: [],
    trial_days: 0,
    popular: false,
    is_trial: false,
    active: true,
    sort_order: 0,
    created_at: "2026-07-18T00:00:00Z",
    updated_at: "2026-07-18T00:00:00Z",
    ...partial,
  };
}

describe("normalização dos campos da migration 063", () => {
  it("cai nos defaults do banco quando a EF não devolve os campos", () => {
    const legacy = plan();
    expect(legacy.category).toBeUndefined();
    expect(planCategory(legacy)).toBe("SYSTEM_SUBSCRIPTION");
    expect(planProvider(legacy)).toBe("stripe");
    expect(planBillingType(legacy)).toBe("recurring");
  });

  it("preserva valor válido", () => {
    expect(planCategory(plan({ category: "AI_CREDIT_PACKAGE" }))).toBe("AI_CREDIT_PACKAGE");
    expect(planProvider(plan({ provider: "asaas" }))).toBe("asaas");
    expect(planBillingType(plan({ billing_type: "one_time" }))).toBe("one_time");
  });

  it("valor desconhecido (banco à frente do frontend) cai no default sem quebrar", () => {
    const exotic = plan({
      category: "QUANTUM_PLAN" as BillingPlan["category"],
      provider: "pagseguro" as BillingPlan["provider"],
    });
    expect(planCategory(exotic)).toBe("SYSTEM_SUBSCRIPTION");
    expect(planProvider(exotic)).toBe("stripe");
  });
});

describe("planIntervalLabel", () => {
  it("rotula recorrente por intervalo", () => {
    expect(planIntervalLabel(plan({ interval: "month" }))).toBe("Mensal");
    expect(planIntervalLabel(plan({ interval: "year" }))).toBe("Anual");
  });

  // A regressão que este teste tranca: pacote de crédito de IA é one_time mas
  // carrega interval='month' no banco (coluna NOT NULL, CHECK month|year, sem
  // valor neutro — migration 065). Ler `plan.interval` direto na UI diria ao
  // operador que o cliente é cobrado R$ 70 todo mês.
  it("devolve null em cobrança única, mesmo com interval='month' no banco", () => {
    const pacote = plan({
      category: "AI_CREDIT_PACKAGE",
      billing_type: "one_time",
      interval: "month",
      amount_cents: 7000,
    });
    expect(pacote.interval).toBe("month");
    expect(planIntervalLabel(pacote)).toBeNull();
  });

  it("implantação de WhatsApp também é cobrança única", () => {
    expect(
      planIntervalLabel(plan({ category: "WHATSAPP_IMPLEMENTATION", billing_type: "one_time" })),
    ).toBeNull();
  });
});

describe("showsStripeConfig", () => {
  it("só expõe os Price IDs em plano Stripe", () => {
    expect(showsStripeConfig(plan({ provider: "stripe" }))).toBe(true);
    expect(showsStripeConfig(plan({ provider: "asaas" }))).toBe(false);
    expect(showsStripeConfig(plan({ provider: "manual" }))).toBe(false);
    expect(showsStripeConfig(plan({ provider: "lifetime" }))).toBe(false);
  });

  // Plano legado (pré-063) é Stripe — esconder a seção dele apagaria da tela o
  // price_id que a assinatura em produção usa.
  it("plano sem provider é tratado como Stripe", () => {
    expect(showsStripeConfig(plan())).toBe(true);
  });
});

describe("isAiCreditPackage", () => {
  it("só pacote de IA credita saldo", () => {
    expect(isAiCreditPackage(plan({ category: "AI_CREDIT_PACKAGE" }))).toBe(true);
    expect(isAiCreditPackage(plan({ category: "SYSTEM_SUBSCRIPTION" }))).toBe(false);
    expect(isAiCreditPackage(plan())).toBe(false);
  });
});

describe("isSelectableSystemPlan", () => {
  it("oferta a assinatura do sistema", () => {
    expect(isSelectableSystemPlan(plan({ category: "SYSTEM_SUBSCRIPTION" }))).toBe(true);
  });

  it("nunca oferta o trial — é aplicado automaticamente na criação da org", () => {
    expect(isSelectableSystemPlan(plan({ category: "TRIAL", is_trial: true }))).toBe(false);
    // Mesmo que alguém marque is_trial num plano de categoria comum.
    expect(isSelectableSystemPlan(plan({ category: "SYSTEM_SUBSCRIPTION", is_trial: true }))).toBe(
      false,
    );
  });

  // Sem este filtro, corrigir o 403 do list_plans faria a pricing table do
  // cliente listar "Implantação WhatsApp R$ 750" e 5 pacotes de IA como se
  // fossem assinaturas contratáveis — nenhum checkout os processa até a Fase 5/7.
  it("não oferta produtos que não são assinatura do sistema", () => {
    expect(isSelectableSystemPlan(plan({ category: "WHATSAPP_IMPLEMENTATION" }))).toBe(false);
    expect(isSelectableSystemPlan(plan({ category: "WHATSAPP_SUBSCRIPTION" }))).toBe(false);
    expect(isSelectableSystemPlan(plan({ category: "AI_CREDIT_PACKAGE" }))).toBe(false);
    expect(isSelectableSystemPlan(plan({ category: "CUSTOM" }))).toBe(false);
  });

  it("plano legado sem categoria segue ofertável (era assinatura do sistema)", () => {
    expect(isSelectableSystemPlan(plan())).toBe(true);
  });
});
