import { describe, it, expect } from "vitest";
import {
  validateOriginPayment,
  canTransitionOperational,
  canContractInstance,
  buildClientImplementationView,
  summarizeMonthlyCosts,
  SETTLED_PAYMENT_STATUSES,
} from "../../supabase/functions/_shared/whatsapp-implementation-core";
import { resolveEntitlements } from "../../supabase/functions/_shared/entitlements-core";

describe("validateOriginPayment", () => {
  it("pagamento externo é CONFIRMED e nunca WAIVED", () => {
    expect(validateOriginPayment("EXTERNAL_PAYMENT", "CONFIRMED")).toBe(true);
    expect(validateOriginPayment("EXTERNAL_PAYMENT", "WAIVED")).toBe(false);
    expect(validateOriginPayment("EXTERNAL_PAYMENT", "PENDING")).toBe(false);
  });

  it("cortesia e override são WAIVED e nunca CONFIRMED", () => {
    expect(validateOriginPayment("COURTESY", "WAIVED")).toBe(true);
    expect(validateOriginPayment("ADMIN_OVERRIDE", "WAIVED")).toBe(true);
    expect(validateOriginPayment("COURTESY", "CONFIRMED")).toBe(false);
    expect(validateOriginPayment("ADMIN_OVERRIDE", "PENDING")).toBe(false);
  });

  it("Asaas aceita o ciclo completo, inclusive estorno e chargeback", () => {
    for (const s of ["PENDING", "CONFIRMED", "REFUNDED", "CHARGEBACK", "CANCELED"] as const) {
      expect(validateOriginPayment("ASAAS", s)).toBe(true);
    }
    expect(validateOriginPayment("ASAAS", "WAIVED")).toBe(false);
  });
});

describe("canTransitionOperational", () => {
  it("recusa COMPLETED enquanto o pagamento está PENDING", () => {
    const r = canTransitionOperational("IN_PROGRESS", "COMPLETED", "PENDING");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("payment_not_settled");
  });

  it("aceita COMPLETED com pagamento CONFIRMED ou WAIVED", () => {
    expect(canTransitionOperational("IN_PROGRESS", "COMPLETED", "CONFIRMED").ok).toBe(true);
    expect(canTransitionOperational("WAITING_CUSTOMER", "COMPLETED", "WAIVED").ok).toBe(true);
  });

  it("estorno DEPOIS da entrega não desfaz a entrega — COMPLETED é terminal", () => {
    // A transição para COMPLETED nunca parte de um pagamento estornado...
    expect(canTransitionOperational("IN_PROGRESS", "COMPLETED", "REFUNDED").ok).toBe(false);
    // ...mas uma vez COMPLETED, nada o move (o estorno só muda payment_status).
    expect(canTransitionOperational("COMPLETED", "IN_PROGRESS", "REFUNDED").ok).toBe(false);
    expect(canTransitionOperational("COMPLETED", "CANCELED", "CHARGEBACK").ok).toBe(false);
  });

  it("CANCELED é terminal e alcançável de qualquer estado vivo", () => {
    expect(canTransitionOperational("NOT_STARTED", "CANCELED", "PENDING").ok).toBe(true);
    expect(canTransitionOperational("WAITING_CUSTOMER", "CANCELED", "CONFIRMED").ok).toBe(true);
    expect(canTransitionOperational("CANCELED", "NOT_STARTED", "CONFIRMED").ok).toBe(false);
  });

  it("recusa salto para o mesmo estado e transições fora do grafo", () => {
    expect(canTransitionOperational("NOT_STARTED", "NOT_STARTED", "CONFIRMED").ok).toBe(false);
    expect(canTransitionOperational("NOT_STARTED", "COMPLETED", "CONFIRMED").ok).toBe(false);
  });
});

describe("canContractInstance", () => {
  const base = {
    flagEnabled: true,
    implementationOperationalStatus: "COMPLETED" as const,
    systemAllowed: true,
    hasActiveWhatsappSubscription: false,
    hasActiveWhatsappOverride: false,
  };

  it("libera quando tudo está no lugar", () => {
    expect(canContractInstance(base)).toEqual({ ok: true, reason: null });
  });

  it("bloqueia a mensalidade enquanto a implantação não terminou", () => {
    expect(canContractInstance({ ...base, implementationOperationalStatus: "IN_PROGRESS" }).reason)
      .toBe("implementation_incomplete");
    expect(canContractInstance({ ...base, implementationOperationalStatus: null }).reason)
      .toBe("implementation_incomplete");
  });

  it("implantação em cortesia não libera a mensalidade sozinha — quem libera é o COMPLETED", () => {
    // Cortesia entrega a implantação (WAIVED/COMPLETED); a instância segue sendo
    // uma contratação à parte, e continua bloqueada enquanto o operacional não fecha.
    expect(canContractInstance({ ...base, implementationOperationalStatus: "WAITING_CUSTOMER" }).ok).toBe(false);
  });

  it("nunca cobra quem já tem cortesia de WhatsApp", () => {
    expect(canContractInstance({ ...base, hasActiveWhatsappOverride: true }).reason).toBe("override_active");
  });

  it("não vende duas instâncias nem vende para sistema bloqueado", () => {
    expect(canContractInstance({ ...base, hasActiveWhatsappSubscription: true }).reason).toBe("already_subscribed");
    expect(canContractInstance({ ...base, systemAllowed: false }).reason).toBe("system_not_allowed");
  });

  it("flag desligada barra antes de qualquer outra checagem", () => {
    expect(canContractInstance({ ...base, flagEnabled: false, systemAllowed: false }).reason).toBe("flag_off");
  });
});

describe("buildClientImplementationView", () => {
  it("ausência de linha é NOT_REQUESTED, não erro", () => {
    const v = buildClientImplementationView(null);
    expect(v.state).toBe("NOT_REQUESTED");
    expect(v.payment_status).toBeNull();
    expect(v.operational_status).toBeNull();
  });

  it("nunca vaza campo interno", () => {
    const v = buildClientImplementationView({
      payment_status: "CONFIRMED",
      operational_status: "IN_PROGRESS",
      amount_cents: 75000,
      paid_at: "2026-07-26T12:00:00Z",
      scheduled_for: "2026-07-28",
      started_at: "2026-07-27T12:00:00Z",
      completed_at: null,
      notes: "cliente reclamou do prazo",
      reason: "cortesia combinada com o dono",
      external_payment_reference: "NF 1234",
      owner_admin_id: "11111111-1111-1111-1111-111111111111",
      created_by: "22222222-2222-2222-2222-222222222222",
    });
    const keys = Object.keys(v);
    for (const forbidden of ["notes", "reason", "external_payment_reference", "owner_admin_id", "created_by"]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("mapeia pagamento pendente para AWAITING_PAYMENT sem prometer prazo", () => {
    const v = buildClientImplementationView({
      payment_status: "PENDING", operational_status: "NOT_STARTED",
      amount_cents: 75000, paid_at: null, scheduled_for: null,
      started_at: null, completed_at: null,
    });
    expect(v.state).toBe("AWAITING_PAYMENT");
    expect(v.next_step).not.toMatch(/\d+\s*(dia|hora|semana)/i);
  });

  it("estorno após a entrega continua COMPLETED para o cliente", () => {
    const v = buildClientImplementationView({
      payment_status: "REFUNDED", operational_status: "COMPLETED",
      amount_cents: 75000, paid_at: "2026-07-01T12:00:00Z", scheduled_for: null,
      started_at: "2026-07-02T12:00:00Z", completed_at: "2026-07-05T12:00:00Z",
    });
    expect(v.state).toBe("COMPLETED");
  });
});

describe("summarizeMonthlyCosts", () => {
  const plans = {
    systemMonthlyCents: 44900,
    instanceMonthlyCents: 14900,
    implementationOneTimeCents: 75000,
  };

  it("devolve os quatro números antes de qualquer contratação", () => {
    expect(summarizeMonthlyCosts({
      ...plans,
      hasActiveInstanceSubscription: false,
      whatsappSponsored: false,
      implementationSettled: false,
      systemSponsored: false,
    })).toEqual({
      currentMonthlyCents: 44900,
      projectedMonthlyCents: 59800,
      oneTimeDueCents: 75000,
      aiVariable: true,
    });
  });

  it("com a instância contratada, o mensal atual passa a incluir os R$ 149", () => {
    const s = summarizeMonthlyCosts({
      ...plans,
      hasActiveInstanceSubscription: true,
      whatsappSponsored: false,
      implementationSettled: true,
      systemSponsored: false,
    });
    expect(s.currentMonthlyCents).toBe(59800);
    expect(s.projectedMonthlyCents).toBe(59800);
    expect(s.oneTimeDueCents).toBe(0);
  });

  it("override de WhatsApp zera a parte do WhatsApp, não a do sistema", () => {
    const s = summarizeMonthlyCosts({
      ...plans,
      hasActiveInstanceSubscription: false,
      whatsappSponsored: true,
      implementationSettled: true,
      systemSponsored: false,
    });
    expect(s.currentMonthlyCents).toBe(44900);
    expect(s.projectedMonthlyCents).toBe(44900);
  });

  it("cortesia de sistema zera o mensal inteiro (caso Ren Sushi)", () => {
    const s = summarizeMonthlyCosts({
      ...plans,
      hasActiveInstanceSubscription: false,
      whatsappSponsored: true,
      implementationSettled: true,
      systemSponsored: true,
    });
    expect(s.currentMonthlyCents).toBe(0);
    expect(s.projectedMonthlyCents).toBe(0);
  });
});

describe("SETTLED_PAYMENT_STATUSES", () => {
  it("inclui estorno e chargeback — a entrega já aconteceu", () => {
    expect([...SETTLED_PAYMENT_STATUSES].sort())
      .toEqual(["CHARGEBACK", "CONFIRMED", "REFUNDED", "WAIVED"]);
  });
});

// Interação com o resolver de entitlements. Vive neste arquivo (e não no
// entitlements-core.test.ts) porque é a Fase 5a que introduz o override de
// WhatsApp de verdade — antes dela nenhum código concedia um.
describe("override de WhatsApp × entitlements", () => {
  const base = {
    billingStatus: "active",
    trialEndsAt: null,
    subscriptions: [],
  };

  it("override de WhatsApp NÃO libera IA", () => {
    const e = resolveEntitlements({
      ...base,
      billingStatus: "blocked",
      overrides: [{
        feature: "whatsapp", enabled: true, grant_type: "LIFETIME",
        starts_at: "2026-01-01T00:00:00Z", ends_at: null, revoked_at: null,
      }],
      // Carteira implantada: sem ela, `ai` herda `system` e o teste não provaria nada.
      aiWalletBalanceCents: 0,
    });
    expect(e.whatsapp.allowed).toBe(true);
    expect(e.ai.allowed).toBe(false);
    expect(e.system.allowed).toBe(false);
  });

  it("LIFETIME não expira; TEMPORARY deixa de valer depois de ends_at", () => {
    const lifetime = {
      feature: "whatsapp" as const, enabled: true, grant_type: "LIFETIME" as const,
      starts_at: "2026-01-01T00:00:00Z", ends_at: null, revoked_at: null,
    };
    const temporary = {
      feature: "whatsapp" as const, enabled: true, grant_type: "TEMPORARY" as const,
      starts_at: "2026-01-01T00:00:00Z", ends_at: "2026-07-01T00:00:00Z", revoked_at: null,
    };
    expect(resolveEntitlements({
      ...base, overrides: [lifetime], now: "2030-01-01T00:00:00Z",
    }).whatsapp.allowed).toBe(true);
    expect(resolveEntitlements({
      ...base, overrides: [temporary], now: "2026-06-30T00:00:00Z",
    }).whatsapp.allowed).toBe(true);
    expect(resolveEntitlements({
      ...base, overrides: [temporary], now: "2026-07-02T00:00:00Z",
    }).whatsapp.allowed).toBe(false);
  });

  it("revogar volta a exigir assinatura paga", () => {
    const revoked = {
      feature: "whatsapp" as const, enabled: true, grant_type: "LIFETIME" as const,
      starts_at: "2026-01-01T00:00:00Z", ends_at: null,
      revoked_at: "2026-07-20T00:00:00Z",
    };
    expect(resolveEntitlements({ ...base, overrides: [revoked] }).whatsapp.allowed).toBe(false);
    expect(resolveEntitlements({
      ...base,
      overrides: [revoked],
      subscriptions: [{ status: "active", category: "WHATSAPP_SUBSCRIPTION", current_period_end: null }],
    }).whatsapp.allowed).toBe(true);
  });
});
