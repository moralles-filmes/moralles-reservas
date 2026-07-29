import { describe, it, expect } from "vitest";
import {
  decideWhatsAppGate,
  systemBlocksDependentServices,
  resolveEnforcement,
  resolveProvisioningEligibility,
  decideInboundAutoReply,
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

// Fix round 1, findings 1 e 2 (histórico): a CONSEQUÊNCIA (não o estado) tem a
// assimetria fail-open (envio) / fail-closed (provisionamento). A Task 16
// separou o lado fail-closed para `resolveProvisioningEligibility` (describe
// dedicado logo abaixo) — este describe cobre só o que `resolveEnforcement`
// ainda decide: a consequência sobre uso EXISTENTE, submetida à flag. Todo
// caso abaixo passa a decisão REAL de decideWhatsAppGate para
// resolveEnforcement — nunca um literal de WhatsAppGateDecision escrito à mão
// — para que o teste proteja a ligação entre os dois núcleos, não só cada um
// isolado.
describe("resolveEnforcement — consequência operacional", () => {
  it("flag ON + leitura válida + ACTIVE: envio permitido", () => {
    const decision = gate({ financialState: "PAID" });
    expect(decision.state).toBe("ACTIVE");

    const r = resolveEnforcement({ decision, flagEnabled: true, flagReadFailed: false, dataReadFailed: false });

    expect(r.enforcementEnabled).toBe(true);
    expect(r.enforced.sending).toBe(false);
    expect(r.telemetry).toBe("NONE");
  });

  it("flag ON + leitura válida + OVERRIDE_ACTIVE: envio permitido", () => {
    const decision = gate({ hasActiveWhatsAppOverride: true });
    expect(decision.state).toBe("OVERRIDE_ACTIVE");

    const r = resolveEnforcement({ decision, flagEnabled: true, flagReadFailed: false, dataReadFailed: false });

    expect(r.enforced.sending).toBe(false);
  });

  it("flag OFF + leitura válida: envio sem enforcement (enforcementEnabled=false)", () => {
    const decision = gate({ financialState: "PAID" });

    const r = resolveEnforcement({ decision, flagEnabled: false, flagReadFailed: false, dataReadFailed: false });

    expect(r.enforcementEnabled).toBe(false);
    expect(r.enforced.sending).toBe(false);
    expect(r.telemetry).toBe("NONE"); // ACTIVE não bloquearia envio de qualquer forma — nada para o dry-run registrar
  });

  it("flag OFF + leitura válida + estado que bloquearia envio: dry-run registra o que TERIA acontecido", () => {
    const decision = gate({ financialState: "OVERDUE_BEYOND_GRACE" });
    expect(decision.state).toBe("SUSPENDED_UNPAID");

    const r = resolveEnforcement({ decision, flagEnabled: false, flagReadFailed: false, dataReadFailed: false });

    expect(r.enforced.sending).toBe(false); // dry-run não aplica a consequência, só a registra
    expect(r.telemetry).toBe("DRY_RUN_WOULD_BLOCK_SENDING");
  });

  it("falha de leitura de dado + estado que bloquearia envio: envio continua liberado (fail-open)", () => {
    const decision = gate({ financialState: "OVERDUE_BEYOND_GRACE" });
    expect(decision.sendingBlocked).toBe(true);

    const r = resolveEnforcement({ decision, flagEnabled: true, flagReadFailed: false, dataReadFailed: true });

    expect(r.enforced.sending).toBe(false); // apesar do estado bloquear, a leitura falhou — não suspende
  });

  it("falha de leitura de dado + estado ACTIVE: envio permanece liberado", () => {
    const decision = gate({ financialState: "PAID" });

    const r = resolveEnforcement({ decision, flagEnabled: true, flagReadFailed: false, dataReadFailed: true });

    expect(r.enforced.sending).toBe(false); // ACTIVE não bloqueia envio de qualquer forma
  });

  it("falha de leitura de dado tampouco produz dry-run, mesmo com flag OFF e estado bloqueado", () => {
    const decision = gate({ financialState: "OVERDUE_BEYOND_GRACE" });

    const r = resolveEnforcement({ decision, flagEnabled: false, flagReadFailed: false, dataReadFailed: true });

    expect(r.telemetry).toBe("NONE");
    expect(r.enforced.sending).toBe(false);
  });

  it("falha de leitura da FLAG não produz dry-run — produz FLAG_READ_FAILED, e envio permanece liberado", () => {
    const decision = gate({ financialState: "OVERDUE_BEYOND_GRACE" });

    const r = resolveEnforcement({ decision, flagEnabled: false, flagReadFailed: true, dataReadFailed: false });

    expect(r.telemetry).toBe("FLAG_READ_FAILED");
    expect(r.telemetry).not.toBe("DRY_RUN_WOULD_BLOCK_SENDING");
    expect(r.enforcementEnabled).toBe(false);
    expect(r.enforced.sending).toBe(false); // fail-open
  });

  it("GRACE_PERIOD e LEGACY_GRANDFATHERED não bloqueiam envio, mesmo com enforcement pleno", () => {
    const grace = gate({ financialState: "IN_GRACE" });
    expect(grace.state).toBe("GRACE_PERIOD");
    const rGrace = resolveEnforcement({ decision: grace, flagEnabled: true, flagReadFailed: false, dataReadFailed: false });
    expect(rGrace.enforced.sending).toBe(false);

    const legacy = gate({ financialState: "CANCELED", isLegacyGrandfathered: true });
    expect(legacy.state).toBe("LEGACY_GRANDFATHERED");
    const rLegacy = resolveEnforcement({ decision: legacy, flagEnabled: true, flagReadFailed: false, dataReadFailed: false });
    expect(rLegacy.enforced.sending).toBe(false);
  });

  it("SUSPENDED_UNPAID e ADMIN_BLOCKED continuam bloqueando envio com enforcement efetivamente habilitado", () => {
    const suspended = gate({ financialState: "OVERDUE_BEYOND_GRACE" });
    expect(suspended.state).toBe("SUSPENDED_UNPAID");
    const rSuspended = resolveEnforcement({
      decision: suspended,
      flagEnabled: true,
      flagReadFailed: false,
      dataReadFailed: false,
    });
    expect(rSuspended.enforced.sending).toBe(true);

    const blocked = gate({ hasWhatsAppAdminBlock: true });
    expect(blocked.state).toBe("ADMIN_BLOCKED");
    const rBlocked = resolveEnforcement({
      decision: blocked,
      flagEnabled: true,
      flagReadFailed: false,
      dataReadFailed: false,
    });
    expect(rBlocked.enforced.sending).toBe(true);
  });
});

// Task 16: elegibilidade para provisionar instância NOVA — eixo separado de
// `resolveEnforcement`, e deliberadamente: aquela função governa consequência
// sobre uso EXISTENTE, gateada pela flag `whatsapp_service_enforcement`
// (fail-open); esta função governa autorização de despesa recorrente NOVA, e
// nunca consulta aquela flag (fail-closed). Todo caso é montado pelo caminho
// REAL — `gate(...)` (que chama `decideWhatsAppGate`) — nunca um literal de
// `WhatsAppGateDecision` escrito à mão, mesma disciplina do describe acima.
describe("resolveProvisioningEligibility", () => {
  const active = () => gate({ financialState: "PAID" });
  const suspendedUnpaid = () => gate({ financialState: "OVERDUE_BEYOND_GRACE" });
  const legacy = () => gate({ financialState: "CANCELED", isLegacyGrandfathered: true });
  const overrideActive = () => gate({ hasActiveWhatsAppOverride: true });

  it("flag de enforcement OFF + ACTIVE libera, e não pelo motivo errado", () => {
    const decision = active();
    expect(decision.state).toBe("ACTIVE");
    const r = resolveProvisioningEligibility({ decision, dataReadFailed: false });
    expect(r.allowed).toBe(true);
    expect(r.blockReason).toBe("ALLOWED");
  });

  it("flag de enforcement OFF + SUSPENDED_UNPAID continua bloqueando", () => {
    const decision = suspendedUnpaid();
    expect(decision.state).toBe("SUSPENDED_UNPAID");
    const r = resolveProvisioningEligibility({ decision, dataReadFailed: false });
    expect(r.allowed).toBe(false);
    expect(r.blockReason).toBe("SERVICE_STATE");
  });

  it("falha na leitura da flag de enforcement não interfere", () => {
    const decision = active();

    // Prova estrutural: `ProvisioningEligibilityInput` não tem campo de flag
    // — não há como esta chamada consultá-la, nem se quisesse.
    const r = resolveProvisioningEligibility({ decision, dataReadFailed: false });
    expect(r.allowed).toBe(true);

    // Prova de comportamento: mesmo depois de rodar `resolveEnforcement` com
    // `flagReadFailed: true` (o eixo que de fato consome a flag), a
    // elegibilidade de provisionamento sobre a MESMA decisão não muda.
    const enforcement = resolveEnforcement({ decision, flagEnabled: false, flagReadFailed: true, dataReadFailed: false });
    expect(enforcement.enforced.sending).toBe(false); // fail-open, de referência
    expect(resolveProvisioningEligibility({ decision, dataReadFailed: false }).allowed).toBe(true);
  });

  it("falha na resolução do estado bloqueia", () => {
    const r = resolveProvisioningEligibility({ decision: active(), dataReadFailed: true });
    expect(r.allowed).toBe(false);
    expect(r.blockReason).toBe("STATE_READ_FAILED");
  });

  it("LEGACY_GRANDFATHERED permite envio e bloqueia instância nova", () => {
    const d = legacy();
    expect(d.state).toBe("LEGACY_GRANDFATHERED");
    expect(d.sendingBlocked).toBe(false);
    expect(resolveProvisioningEligibility({ decision: d, dataReadFailed: false }).allowed).toBe(false);
  });

  it("OVERRIDE_ACTIVE permite provisionamento", () => {
    const d = overrideActive();
    expect(d.state).toBe("OVERRIDE_ACTIVE");
    expect(resolveProvisioningEligibility({ decision: d, dataReadFailed: false }).allowed).toBe(true);
  });

  it("sistema suspenso bloqueia mesmo com OVERRIDE_ACTIVE de WhatsApp", () => {
    const d = gate({ hasActiveWhatsAppOverride: true, systemBillingStatus: "suspended" });
    expect(d.state).toBe("OVERRIDE_ACTIVE");
    const r = resolveProvisioningEligibility({ decision: d, dataReadFailed: false });
    expect(r.allowed).toBe(false);
    expect(r.blockReason).toBe("SERVICE_STATE");
  });

  // GRACE_PERIOD, NOT_ENTITLED e ADMIN_BLOCKED também bloqueiam. Cobertos
  // aqui porque o describe "decideWhatsAppGate — as duas perguntas" só
  // exercita `decision.newProvisioningBlocked`, nunca esta função.
  it("GRACE_PERIOD bloqueia provisionamento", () => {
    const d = gate({ financialState: "IN_GRACE" });
    expect(d.state).toBe("GRACE_PERIOD");
    expect(resolveProvisioningEligibility({ decision: d, dataReadFailed: false }).allowed).toBe(false);
  });

  it("NOT_ENTITLED bloqueia provisionamento", () => {
    const d = gate();
    expect(d.state).toBe("NOT_ENTITLED");
    expect(resolveProvisioningEligibility({ decision: d, dataReadFailed: false }).allowed).toBe(false);
  });

  it("ADMIN_BLOCKED bloqueia provisionamento", () => {
    const d = gate({ hasWhatsAppAdminBlock: true });
    expect(d.state).toBe("ADMIN_BLOCKED");
    expect(resolveProvisioningEligibility({ decision: d, dataReadFailed: false }).allowed).toBe(false);
  });
});

// Task 15b: resposta automática a mídia (áudio/imagem/sticker). Os seis casos
// abaixo são montados pelo caminho REAL — decideWhatsAppGate() via gate()
// seguido de resolveEnforcement() — nunca por um literal de
// `{ systemBlocked, enforcedSending }` escrito à mão, porque um teste que
// finge o booleano não prova que o estado real o produz. Mesma disciplina do
// describe "resolveEnforcement — consequência operacional" acima.
describe("decideInboundAutoReply", () => {
  const call = (o: { state?: Partial<WhatsAppGateInput>; enforcementOn?: boolean } = {}) => {
    const decision = gate(o.state);
    const enforcement = resolveEnforcement({
      decision,
      flagEnabled: o.enforcementOn ?? true,
      flagReadFailed: false,
      dataReadFailed: false,
    });
    return decideInboundAutoReply({
      systemBlocked: decision.systemBlocked,
      enforcedSending: enforcement.enforced.sending,
    });
  };

  it("SUSPENDED_UNPAID com enforcement ligado não responde", () => {
    const decision = gate({ financialState: "OVERDUE_BEYOND_GRACE" });
    expect(decision.state).toBe("SUSPENDED_UNPAID");
    expect(call({ state: { financialState: "OVERDUE_BEYOND_GRACE" }, enforcementOn: true }))
      .toBe("SILENT_WHATSAPP_SUSPENDED");
  });

  it("ADMIN_BLOCKED com enforcement ligado não responde", () => {
    const decision = gate({ hasWhatsAppAdminBlock: true });
    expect(decision.state).toBe("ADMIN_BLOCKED");
    expect(call({ state: { hasWhatsAppAdminBlock: true }, enforcementOn: true }))
      .toBe("SILENT_WHATSAPP_SUSPENDED");
  });

  it("sistema suspenso não responde mesmo com override de WhatsApp e enforcement desligado", () => {
    const decision = gate({ systemBillingStatus: "suspended", hasActiveWhatsAppOverride: true });
    expect(decision.state).toBe("OVERRIDE_ACTIVE"); // o estado do WhatsApp não muda...
    expect(decision.systemBlocked).toBe(true); // ...mas o gate pai fecha, mesmo com enforcement OFF
    expect(call({
      state: { systemBillingStatus: "suspended", hasActiveWhatsAppOverride: true },
      enforcementOn: false,
    })).toBe("SILENT_SYSTEM_BLOCKED");
  });

  it("ACTIVE responde", () => {
    const decision = gate({ financialState: "PAID" });
    expect(decision.state).toBe("ACTIVE");
    expect(call({ state: { financialState: "PAID" }, enforcementOn: true })).toBe("REPLY");
  });

  it("OVERRIDE_ACTIVE responde", () => {
    const decision = gate({ hasActiveWhatsAppOverride: true });
    expect(decision.state).toBe("OVERRIDE_ACTIVE");
    expect(call({ state: { hasActiveWhatsAppOverride: true }, enforcementOn: true })).toBe("REPLY");
  });

  it("dry-run com SUSPENDED_UNPAID responde", () => {
    const decision = gate({ financialState: "OVERDUE_BEYOND_GRACE" });
    expect(decision.state).toBe("SUSPENDED_UNPAID");
    expect(call({ state: { financialState: "OVERDUE_BEYOND_GRACE" }, enforcementOn: false })).toBe("REPLY");
  });
});
