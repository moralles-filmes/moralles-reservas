import { describe, it, expect } from "vitest";
import {
  resolveEntitlements,
  type EntitlementInputs,
  type EntitlementOverrideInput,
  type EntitlementSubscriptionInput,
} from "../../supabase/functions/_shared/entitlements-core";

// Prioridade documentada (spec §12): 1. bloqueio admin explícito → 2. override
// → 3. assinatura paga → 4. trial → 5. sem acesso. Cobre os cenários 25/26/27
// da spec de migração billing-asaas.

const NOW = "2026-07-16T12:00:00Z";
const FUTURE = "2026-12-31T23:59:59Z";
const PAST = "2026-01-01T00:00:00Z";

function base(partial?: Partial<EntitlementInputs>): EntitlementInputs {
  return {
    now: NOW,
    billingStatus: "active",
    trialEndsAt: null,
    overrides: [],
    subscriptions: [],
    ...partial,
  };
}

function override(partial: Partial<EntitlementOverrideInput>): EntitlementOverrideInput {
  return {
    feature: "system",
    enabled: true,
    grant_type: "LIFETIME",
    starts_at: PAST,
    ends_at: null,
    revoked_at: null,
    ...partial,
  };
}

describe("resolveEntitlements — prioridade", () => {
  it("5. sem acesso: org sem override/assinatura/trial nega tudo", () => {
    const r = resolveEntitlements(base());
    expect(r.system.allowed).toBe(false);
    expect(r.system.source).toBe("none");
    expect(r.whatsapp.allowed).toBe(false);
  });

  it("4. trial concede SOMENTE system", () => {
    const r = resolveEntitlements(
      base({ billingStatus: "trialing", trialEndsAt: FUTURE }),
    );
    expect(r.system).toMatchObject({ allowed: true, source: "trial", expiresAt: FUTURE });
    expect(r.whatsapp.allowed).toBe(false);
  });

  it("4. trial vencido não concede", () => {
    const r = resolveEntitlements(
      base({ billingStatus: "trialing", trialEndsAt: PAST }),
    );
    expect(r.system.allowed).toBe(false);
  });

  it("3. assinatura ativa concede a feature da categoria do plano", () => {
    const r = resolveEntitlements(
      base({
        subscriptions: [
          { status: "active", category: "SYSTEM_SUBSCRIPTION", current_period_end: FUTURE },
        ],
      }),
    );
    expect(r.system).toMatchObject({ allowed: true, source: "subscription", expiresAt: FUTURE });
    expect(r.whatsapp.allowed).toBe(false); // system sub não libera whatsapp
  });

  it("3. past_due mantém acesso (tolerância — suspensão é decisão dos workers)", () => {
    const r = resolveEntitlements(
      base({
        subscriptions: [
          { status: "past_due", category: "SYSTEM_SUBSCRIPTION", current_period_end: null },
        ],
      }),
    );
    expect(r.system.allowed).toBe(true);
    expect(r.system.status).toBe("past_due");
  });

  it("3. canceled/unpaid/paused NÃO concedem", () => {
    for (const status of ["canceled", "unpaid", "paused"]) {
      const r = resolveEntitlements(
        base({
          subscriptions: [{ status, category: "SYSTEM_SUBSCRIPTION", current_period_end: null }],
        }),
      );
      expect(r.system.allowed).toBe(false);
    }
  });

  it("3. assinatura WHATSAPP_SUBSCRIPTION concede whatsapp sem tocar system", () => {
    const r = resolveEntitlements(
      base({
        subscriptions: [
          { status: "active", category: "WHATSAPP_SUBSCRIPTION", current_period_end: FUTURE },
        ],
      }),
    );
    expect(r.whatsapp.allowed).toBe(true);
    expect(r.system.allowed).toBe(false);
  });

  it("2. cenário 25: LIFETIME prevalece sobre ausência de assinatura", () => {
    const r = resolveEntitlements(
      base({
        overrides: [
          override({ feature: "system" }),
          override({ feature: "whatsapp" }),
          override({ feature: "ai" }),
        ],
      }),
    );
    expect(r.system).toMatchObject({ allowed: true, source: "override", status: "LIFETIME", expiresAt: null });
    expect(r.whatsapp.allowed).toBe(true);
    expect(r.ai.allowed).toBe(true);
  });

  it("2. TEMPORARY expirado é ignorado; revogado é ignorado", () => {
    const r = resolveEntitlements(
      base({
        overrides: [
          override({ feature: "system", grant_type: "TEMPORARY", ends_at: PAST }),
          override({ feature: "whatsapp", revoked_at: NOW }),
        ],
      }),
    );
    expect(r.system.allowed).toBe(false);
    expect(r.whatsapp.allowed).toBe(false);
  });

  it("1. bloqueio explícito (enabled=false) vence override E assinatura paga", () => {
    const r = resolveEntitlements(
      base({
        overrides: [
          override({ feature: "system", enabled: false, grant_type: "MANUAL_OVERRIDE" }),
          override({ feature: "system" }), // grant coexistente perde pro bloqueio
        ],
        subscriptions: [
          { status: "active", category: "SYSTEM_SUBSCRIPTION", current_period_end: FUTURE },
        ],
      }),
    );
    expect(r.system).toMatchObject({ allowed: false, source: "admin_block" });
  });

  it("compat legado: billing_status manual_override concede system", () => {
    const r = resolveEntitlements(base({ billingStatus: "manual_override" }));
    expect(r.system).toMatchObject({ allowed: true, source: "legacy" });
  });
});

describe("resolveEntitlements — IA (pré e pós carteira)", () => {
  const systemSub = {
    subscriptions: [
      { status: "active", category: "SYSTEM_SUBSCRIPTION", current_period_end: FUTURE },
    ],
  };

  it("pré-carteira (undefined): ai herda system — mundo BYOK atual", () => {
    const r = resolveEntitlements(base(systemSub));
    expect(r.ai.allowed).toBe(true);
    const blocked = resolveEntitlements(base());
    expect(blocked.ai.allowed).toBe(false);
  });

  it("cenário 26: com carteira implantada, override de SYSTEM não libera IA (saldo 0 bloqueia)", () => {
    const r = resolveEntitlements(
      base({
        overrides: [override({ feature: "system" })],
        aiWalletBalanceCents: 0,
      }),
    );
    expect(r.system.allowed).toBe(true);
    expect(r.ai).toMatchObject({ allowed: false, source: "wallet", status: "no_credits", balanceCents: 0 });
  });

  it("cenário 27: override de IA não libera whatsapp", () => {
    const r = resolveEntitlements(
      base({ overrides: [override({ feature: "ai" })], aiWalletBalanceCents: 0 }),
    );
    expect(r.ai.allowed).toBe(true); // override de ai vence saldo zerado
    expect(r.whatsapp.allowed).toBe(false);
  });

  it("cenário 19 (parcial): saldo zerado bloqueia IA sem bloquear system", () => {
    const r = resolveEntitlements(base({ ...systemSub, aiWalletBalanceCents: 0 }));
    expect(r.system.allowed).toBe(true);
    expect(r.ai.allowed).toBe(false);
  });

  it("saldo positivo + system ativo libera IA via wallet", () => {
    const r = resolveEntitlements(base({ ...systemSub, aiWalletBalanceCents: 7000 }));
    expect(r.ai).toMatchObject({ allowed: true, source: "wallet", balanceCents: 7000 });
  });

  it("system bloqueado derruba IA mesmo com saldo", () => {
    const r = resolveEntitlements(base({ aiWalletBalanceCents: 7000 }));
    expect(r.system.allowed).toBe(false);
    expect(r.ai.allowed).toBe(false);
  });

  it("bloqueio explícito de IA vence saldo positivo", () => {
    const r = resolveEntitlements(
      base({
        ...systemSub,
        overrides: [override({ feature: "ai", enabled: false, grant_type: "MANUAL_OVERRIDE" })],
        aiWalletBalanceCents: 7000,
      }),
    );
    expect(r.ai).toMatchObject({ allowed: false, source: "admin_block" });
  });
});

// ---------------------------------------------------------------------------
// Modelo comercial de dois planos (plano A, Task 3).
//
// Matriz contratada:
//                                   system | whatsapp | ai
//   Plano 1  ({system})                ✅   |    ❌    | ❌
//   Plano 2  ({system,whatsapp,ai})    ✅   |    ✅    | ✅
//   Trial    (sem assinatura)          ✅   |    ❌    | ❌
//   Legado sistema ({})                ✅   |    ❌    | herança histórica
//   Legado sistema + WhatsApp ({})     ✅   |    ✅    | herança histórica
//   Override LIFETIME                  ✅   |    ✅    | ✅
//
// `included_features` é AUTORIZAÇÃO; `billing_plans.features` é copy de
// marketing e não é input deste núcleo.
// ---------------------------------------------------------------------------
describe("resolveEntitlements — modelo de dois planos (declaração explícita)", () => {
  function sub(partial: Partial<EntitlementSubscriptionInput>): EntitlementSubscriptionInput {
    return {
      status: "active",
      category: "SYSTEM_SUBSCRIPTION",
      current_period_end: null,
      ...partial,
    };
  }

  const planoReservas = sub({ includedFeatures: ["system"] });
  const planoAutomacao = sub({ includedFeatures: ["system", "whatsapp", "ai"] });
  const legadoSistema = sub({}); // sem includedFeatures = plano legado
  const legadoWhatsapp = sub({ category: "WHATSAPP_SUBSCRIPTION" });

  it("teste 3 — Plano 1 concede system", () => {
    const e = resolveEntitlements(base({ subscriptions: [planoReservas] }));
    expect(e.system.allowed).toBe(true);
    expect(e.system.source).toBe("subscription");
  });

  it("teste 4a — Plano 1 NAO concede whatsapp", () => {
    const e = resolveEntitlements(base({ subscriptions: [planoReservas] }));
    expect(e.whatsapp.allowed).toBe(false);
  });

  it("teste 4b — Plano 1 NAO concede ai POR HERANCA", () => {
    // Regressao da v1 deste plano: a heranca pre-carteira dava ai=true aqui.
    const e = resolveEntitlements(base({ subscriptions: [planoReservas] }));
    expect(e.ai.allowed).toBe(false);
    expect(e.ai.status).toBe("not_included");
  });

  it("teste 5 — Plano 2 concede system, whatsapp e ai", () => {
    const e = resolveEntitlements(base({ subscriptions: [planoAutomacao] }));
    expect(e.system.allowed).toBe(true);
    expect(e.whatsapp.allowed).toBe(true);
    expect(e.ai.allowed).toBe(true);
  });

  it("teste 6a — legado SO sistema mantem o comportamento historico de ai", () => {
    // Heranca pre-carteira PRESERVADA para plano legado — e so para ele.
    const e = resolveEntitlements(base({ subscriptions: [legadoSistema] }));
    expect(e.system.allowed).toBe(true);
    expect(e.whatsapp.allowed).toBe(false);
    expect(e.ai.allowed).toBe(true);
    expect(e.ai.source).toBe("subscription");
  });

  it("teste 6b — legado sistema + WhatsApp concede as duas por categoria", () => {
    const e = resolveEntitlements(base({ subscriptions: [legadoSistema, legadoWhatsapp] }));
    expect(e.system.allowed).toBe(true);
    expect(e.whatsapp.allowed).toBe(true);
  });

  it("teste 8 — trial concede system e NAO concede whatsapp nem ai", () => {
    const e = resolveEntitlements(
      base({ billingStatus: "trialing", trialEndsAt: FUTURE, subscriptions: [] }),
    );
    expect(e.system.allowed).toBe(true);
    expect(e.whatsapp.allowed).toBe(false);
    expect(e.ai.allowed).toBe(false);
  });

  it("teste 1 — copy de marketing nao concede acesso", () => {
    // `features` (copy) nao e input do nucleo. Nenhum campo de copy pode
    // aparecer aqui — este teste trava a fronteira.
    const e = resolveEntitlements(base({ subscriptions: [planoReservas] }));
    expect(e.whatsapp.allowed).toBe(false);
    expect(e.ai.allowed).toBe(false);
  });

  it("teste 7 — Ren Sushi: override LIFETIME vence a assinatura", () => {
    const e = resolveEntitlements(
      base({
        overrides: [
          override({ feature: "system" }),
          override({ feature: "whatsapp" }),
          override({ feature: "ai" }),
        ],
        subscriptions: [],
      }),
    );
    expect(e.system.source).toBe("override");
    expect(e.whatsapp.source).toBe("override");
    expect(e.ai.source).toBe("override");
  });

  it("declaracao explicita vence heranca mesmo com carteira ausente", () => {
    const e = resolveEntitlements(base({ subscriptions: [planoReservas] }));
    expect(e.ai.source).not.toBe("wallet");
    expect(e.ai.allowed).toBe(false);
  });
});

describe("Plano D — franquia de IA", () => {
  const plano2 = {
    status: "active",
    category: "SYSTEM_SUBSCRIPTION",
    current_period_end: "2026-09-04T00:00:00Z",
    includedFeatures: ["system", "whatsapp", "ai"],
  };
  const plano1 = {
    status: "active",
    category: "SYSTEM_SUBSCRIPTION",
    current_period_end: "2026-09-04T00:00:00Z",
    includedFeatures: ["system"],
  };

  it("Plano 2 sem orçamento carregado: concede IA por franquia, sem afirmar saldo", () => {
    const e = resolveEntitlements({
      billingStatus: "active",
      trialEndsAt: null,
      overrides: [],
      subscriptions: [plano2],
    });
    expect(e.ai.allowed).toBe(true);
    expect(e.ai.source).toBe("franchise");
    expect(e.ai.status).toBe("within_budget");
    expect(e.ai.budgetRemainingCents).toBeUndefined();
  });

  it("Plano 2 com orçamento aberto: concede e informa o restante", () => {
    const e = resolveEntitlements({
      billingStatus: "active",
      trialEndsAt: null,
      overrides: [],
      subscriptions: [plano2],
      aiFranchise: { state: "OPEN", remainingCents: 3500 },
    });
    expect(e.ai.allowed).toBe(true);
    expect(e.ai.source).toBe("franchise");
    expect(e.ai.status).toBe("within_budget");
    expect(e.ai.budgetRemainingCents).toBe(3500);
  });

  it("Plano 2 com franquia esgotada: NEGA a IA sem tocar system nem whatsapp", () => {
    const e = resolveEntitlements({
      billingStatus: "active",
      trialEndsAt: null,
      overrides: [],
      subscriptions: [plano2],
      aiFranchise: { state: "EXHAUSTED", remainingCents: 0 },
    });
    expect(e.ai.allowed).toBe(false);
    expect(e.ai.source).toBe("franchise");
    expect(e.ai.status).toBe("budget_exhausted");
    expect(e.ai.budgetRemainingCents).toBe(0);
    // O hard stop NÃO desliga o canal nem bloqueia o sistema (§18.3).
    expect(e.system.allowed).toBe(true);
    expect(e.whatsapp.allowed).toBe(true);
  });

  it("franquia esgotada com restante positivo ainda é esgotada — o estado manda", () => {
    const e = resolveEntitlements({
      billingStatus: "active",
      trialEndsAt: null,
      overrides: [],
      subscriptions: [plano2],
      aiFranchise: { state: "EXHAUSTED", remainingCents: 12 },
    });
    expect(e.ai.allowed).toBe(false);
  });

  it("balanceCents NÃO é reusado — franquia não é crédito do cliente", () => {
    const e = resolveEntitlements({
      billingStatus: "active",
      trialEndsAt: null,
      overrides: [],
      subscriptions: [plano2],
      aiFranchise: { state: "OPEN", remainingCents: 3500 },
    });
    expect(e.ai.balanceCents).toBeUndefined();
  });

  it("Plano 1 continua negando IA por não declarar — franquia não muda isso", () => {
    const e = resolveEntitlements({
      billingStatus: "active",
      trialEndsAt: null,
      overrides: [],
      subscriptions: [plano1],
      aiFranchise: { state: "OPEN", remainingCents: 10000 },
    });
    expect(e.ai.allowed).toBe(false);
    expect(e.ai.status).toBe("not_included");
    expect(e.ai.source).not.toBe("franchise");
  });

  it("REN SUSHI: override LIFETIME vence a franquia esgotada — prioridade 2 intacta", () => {
    const e = resolveEntitlements({
      billingStatus: "active",
      trialEndsAt: null,
      overrides: [
        { feature: "ai", enabled: true, grant_type: "LIFETIME", starts_at: "2025-01-01T00:00:00Z", ends_at: null, revoked_at: null },
      ],
      subscriptions: [plano2],
      aiFranchise: { state: "EXHAUSTED", remainingCents: 0 },
    });
    expect(e.ai.allowed).toBe(true);
    expect(e.ai.source).toBe("override");
    expect(e.ai.status).toBe("LIFETIME");
  });

  it("REN SUSHI sem assinatura nenhuma continua fora de todo caminho do Plano D", () => {
    const e = resolveEntitlements({
      billingStatus: "active",
      trialEndsAt: null,
      overrides: [
        { feature: "system", enabled: true, grant_type: "LIFETIME", starts_at: "2025-01-01T00:00:00Z", ends_at: null, revoked_at: null },
        { feature: "whatsapp", enabled: true, grant_type: "LIFETIME", starts_at: "2025-01-01T00:00:00Z", ends_at: null, revoked_at: null },
        { feature: "ai", enabled: true, grant_type: "LIFETIME", starts_at: "2025-01-01T00:00:00Z", ends_at: null, revoked_at: null },
      ],
      subscriptions: [],
      aiFranchise: { state: "EXHAUSTED", remainingCents: 0 },
    });
    expect(e.ai.allowed).toBe(true);
    expect(e.ai.source).toBe("override");
  });

  it("bloqueio administrativo de ai vence a franquia disponível", () => {
    const e = resolveEntitlements({
      billingStatus: "active",
      trialEndsAt: null,
      overrides: [
        { feature: "ai", enabled: false, grant_type: "MANUAL_OVERRIDE", starts_at: "2025-01-01T00:00:00Z", ends_at: null, revoked_at: null },
      ],
      subscriptions: [plano2],
      aiFranchise: { state: "OPEN", remainingCents: 10000 },
    });
    expect(e.ai.allowed).toBe(false);
    expect(e.ai.source).toBe("admin_block");
  });

  it("plano LEGADO (included_features vazio) não entra na franquia, mesmo com orçamento", () => {
    const e = resolveEntitlements({
      billingStatus: "active",
      trialEndsAt: null,
      overrides: [],
      subscriptions: [{ status: "active", category: "SYSTEM_SUBSCRIPTION", current_period_end: null }],
      aiWalletBalanceCents: undefined,
      aiFranchise: { state: "EXHAUSTED", remainingCents: 0 },
    });
    // Herança pré-carteira, byte a byte como antes.
    expect(e.ai.allowed).toBe(true);
    expect(e.ai.source).toBe(e.system.source);
  });

  it("carteira legada continua no ramo de carteira quando o plano não declara ai", () => {
    const e = resolveEntitlements({
      billingStatus: "active",
      trialEndsAt: null,
      overrides: [],
      subscriptions: [{ status: "active", category: "SYSTEM_SUBSCRIPTION", current_period_end: null }],
      aiWalletBalanceCents: 500,
      aiFranchise: { state: "EXHAUSTED", remainingCents: 0 },
    });
    expect(e.ai.source).toBe("wallet");
    expect(e.ai.balanceCents).toBe(500);
  });

  it("trial continua sem IA — o ramo de franquia não o reintroduz", () => {
    const e = resolveEntitlements({
      billingStatus: "trialing",
      trialEndsAt: "2099-01-01T00:00:00Z",
      overrides: [],
      subscriptions: [],
      aiFranchise: { state: "OPEN", remainingCents: 10000 },
    });
    expect(e.ai.allowed).toBe(false);
    expect(e.ai.status).toBe("trial_no_ai");
  });
});
