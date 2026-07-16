import { describe, it, expect } from "vitest";
import {
  resolveEntitlements,
  type EntitlementInputs,
  type EntitlementOverrideInput,
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
