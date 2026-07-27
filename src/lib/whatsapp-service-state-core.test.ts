import { describe, it, expect } from "vitest";
import {
  decideWhatsAppGate,
  systemBlocksDependentServices,
  type WhatsAppGateInput,
  type SystemBillingStatus,
} from "../../supabase/functions/_shared/whatsapp-service-state-core";

function gate(p: Partial<WhatsAppGateInput> = {}) {
  return decideWhatsAppGate({
    systemBillingStatus: "active",
    financialState: "NO_SUBSCRIPTION",
    hasActiveWhatsAppOverride: false,
    hasWhatsAppAdminBlock: false,
    isLegacyGrandfathered: false,
    ...p,
  });
}

describe("systemBlocksDependentServices", () => {
  it("bloqueia nos três estados de acesso negado", () => {
    for (const s of ["blocked", "suspended", "canceled"]) {
      expect(systemBlocksDependentServices(s)).toBe(true);
    }
  });

  it("não bloqueia nos estados de tolerância nem no normal", () => {
    for (const s of ["active", "trialing", "grace_period", "past_due", "pending_payment", "manual_override"]) {
      expect(systemBlocksDependentServices(s)).toBe(false);
    }
  });
});

// Achado 2 (fix round 1): vocabulário fechado. Fonte dos nove valores: CHECK
// `organizations_billing_status_check` em
// supabase/migrations/20260528000000_billing_module.sql:28-31 (mesma lista da
// seção "Banco de dados" do CLAUDE.md).
describe("systemBlocksDependentServices — vocabulário fechado", () => {
  const EXPECTED_BY_STATUS: Record<SystemBillingStatus, boolean> = {
    active: false,
    trialing: false,
    pending_payment: false,
    past_due: false,
    grace_period: false,
    blocked: true,
    canceled: true,
    manual_override: false,
    suspended: true,
  };

  it("classifica individualmente cada um dos nove valores do CHECK do banco", () => {
    for (const status of Object.keys(EXPECTED_BY_STATUS) as SystemBillingStatus[]) {
      expect(systemBlocksDependentServices(status)).toBe(EXPECTED_BY_STATUS[status]);
    }
  });

  it("valor fora do vocabulário não bloqueia — falha aberta de propósito", () => {
    // Um 10º status futuro no CHECK do banco, ainda não classificado aqui,
    // não pode silenciar cliente pagante por default. O ganho de segurança
    // desta task é em compilação (Record exaustivo obriga a classificar),
    // não em runtime — em runtime, desconhecido sempre libera.
    expect(systemBlocksDependentServices("vocabulario_novo")).toBe(false);
  });
});

describe("decideWhatsAppGate — estados", () => {
  it("bloqueio administrativo vence tudo, inclusive override", () => {
    const d = gate({ hasWhatsAppAdminBlock: true, hasActiveWhatsAppOverride: true, financialState: "PAID" });
    expect(d.state).toBe("ADMIN_BLOCKED");
    expect(d.sendingBlocked).toBe(true);
  });

  it("override prevalece sobre inadimplência do WhatsApp", () => {
    const d = gate({ hasActiveWhatsAppOverride: true, financialState: "OVERDUE_BEYOND_GRACE" });
    expect(d.state).toBe("OVERRIDE_ACTIVE");
    expect(d.sendingBlocked).toBe(false);
    expect(d.newProvisioningBlocked).toBe(false);
  });

  it("assinatura em dia é ACTIVE; em tolerância é GRACE_PERIOD; além dela é SUSPENDED_UNPAID", () => {
    expect(gate({ financialState: "PAID" }).state).toBe("ACTIVE");
    expect(gate({ financialState: "IN_GRACE" }).state).toBe("GRACE_PERIOD");
    expect(gate({ financialState: "OVERDUE_BEYOND_GRACE" }).state).toBe("SUSPENDED_UNPAID");
  });

  it("assinatura cancelada cai para o nível seguinte", () => {
    expect(gate({ financialState: "CANCELED", isLegacyGrandfathered: true }).state).toBe("LEGACY_GRANDFATHERED");
    expect(gate({ financialState: "CANCELED", isLegacyGrandfathered: false }).state).toBe("NOT_ENTITLED");
  });

  it("sem nada é NOT_ENTITLED", () => {
    expect(gate().state).toBe("NOT_ENTITLED");
  });
});

describe("decideWhatsAppGate — as duas perguntas", () => {
  it("só SUSPENDED_UNPAID e ADMIN_BLOCKED bloqueiam envio", () => {
    expect(gate({ financialState: "PAID" }).sendingBlocked).toBe(false);
    expect(gate({ financialState: "IN_GRACE" }).sendingBlocked).toBe(false);
    expect(gate({ isLegacyGrandfathered: true }).sendingBlocked).toBe(false);
    expect(gate().sendingBlocked).toBe(false); // NOT_ENTITLED
    expect(gate({ financialState: "OVERDUE_BEYOND_GRACE" }).sendingBlocked).toBe(true);
    expect(gate({ hasWhatsAppAdminBlock: true }).sendingBlocked).toBe(true);
  });

  // Achado 1 (fix round 1): as sete células de NEW_PROVISIONING_ALLOWED_BY_STATE
  // ficam TODAS fixadas aqui, uma por estado — inverter qualquer célula do
  // Record (inclusive SUSPENDED_UNPAID/ADMIN_BLOCKED, antes sem asserção) tem
  // que quebrar exatamente uma destas linhas.
  it("só ACTIVE e OVERRIDE_ACTIVE permitem instância nova", () => {
    expect(gate({ financialState: "PAID" }).newProvisioningBlocked).toBe(false); // ACTIVE
    expect(gate({ hasActiveWhatsAppOverride: true }).newProvisioningBlocked).toBe(false); // OVERRIDE_ACTIVE
    expect(gate({ financialState: "IN_GRACE" }).newProvisioningBlocked).toBe(true); // GRACE_PERIOD
    expect(gate({ isLegacyGrandfathered: true }).newProvisioningBlocked).toBe(true); // LEGACY_GRANDFATHERED
    expect(gate().newProvisioningBlocked).toBe(true); // NOT_ENTITLED
    expect(gate({ financialState: "OVERDUE_BEYOND_GRACE" }).newProvisioningBlocked).toBe(true); // SUSPENDED_UNPAID
    expect(gate({ hasWhatsAppAdminBlock: true }).newProvisioningBlocked).toBe(true); // ADMIN_BLOCKED
  });
});

describe("decideWhatsAppGate — gate pai do sistema", () => {
  it("sistema suspenso bloqueia WhatsApp MESMO com override ativo", () => {
    const d = gate({ systemBillingStatus: "blocked", hasActiveWhatsAppOverride: true, financialState: "PAID" });
    expect(d.state).toBe("OVERRIDE_ACTIVE"); // o estado do WhatsApp não muda...
    expect(d.systemBlocked).toBe(true);      // ...mas o gate pai fecha
    expect(d.sendingBlocked).toBe(true);
    expect(d.newProvisioningBlocked).toBe(true);
    expect(d.reason).toBe("system_blocked");
  });

  it("sistema em tolerância não bloqueia o WhatsApp", () => {
    expect(gate({ systemBillingStatus: "grace_period", financialState: "PAID" }).sendingBlocked).toBe(false);
  });
});
