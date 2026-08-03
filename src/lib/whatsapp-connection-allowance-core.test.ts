import { describe, it, expect } from "vitest";
import {
  checkConnectionAllowance,
  type ConnectionAllowanceInput,
} from "../../supabase/functions/_shared/whatsapp-connection-allowance-core";

const P2 = { fundingSource: "PLAN_INCLUDED" as const, includedConnections: 1 };
const P1 = { fundingSource: "PLAN_INCLUDED" as const, includedConnections: 0 };

describe("checkConnectionAllowance — allowance por origem de financiamento e operacao", () => {
  it("teste 30 — Plano 2 bloqueia a SEGUNDA conexao", () => {
    const r = checkConnectionAllowance({
      ...P2,
      operation: "NEW_PROVISIONING",
      activeInstanceCount: 1,
      provisioningAmbiguous: false,
      providerInstanceRefKnown: false,
    });
    expect(r.allowed).toBe(false);
    if (r.allowed !== false) return;
    expect(r.reasonCode).toBe("CONNECTION_LIMIT_REACHED");
  });

  it("Plano 2 permite a PRIMEIRA", () => {
    const r = checkConnectionAllowance({
      ...P2,
      operation: "NEW_PROVISIONING",
      activeInstanceCount: 0,
      provisioningAmbiguous: false,
      providerInstanceRefKnown: false,
    });
    expect(r.allowed).toBe(true);
  });

  it("Plano 1 nao tem conexao nenhuma", () => {
    const r = checkConnectionAllowance({
      ...P1,
      operation: "NEW_PROVISIONING",
      activeInstanceCount: 0,
      provisioningAmbiguous: false,
      providerInstanceRefKnown: false,
    });
    expect(r.allowed).toBe(false);
    if (r.allowed !== false) return;
    expect(r.reasonCode).toBe("CONNECTION_LIMIT_REACHED");
  });

  it("CANCELLATION_REQUESTED continua contando — ainda custa", () => {
    // O caller conta lifecycle_state <> 'ENDED'. Este teste trava a semantica.
    const r = checkConnectionAllowance({
      ...P2,
      operation: "NEW_PROVISIONING",
      activeInstanceCount: 1,
      provisioningAmbiguous: false,
      providerInstanceRefKnown: false,
    });
    expect(r.allowed).toBe(false);
  });

  it("LEGADO nao vira allowance zero so porque a coluna nova tem default 0", () => {
    const r = checkConnectionAllowance({
      fundingSource: "LEGACY_CATEGORY",
      includedConnections: 0,
      operation: "NEW_PROVISIONING",
      activeInstanceCount: 1,
      provisioningAmbiguous: false,
      providerInstanceRefKnown: false,
    });
    expect(r.allowed).toBe(true);
    expect(r.policy).toBe("LEGACY_HISTORICAL");
  });

  it("Ren Sushi LIFETIME: backfill da instancia existente e preservado", () => {
    const r = checkConnectionAllowance({
      fundingSource: "LIFETIME_OVERRIDE",
      includedConnections: null,
      operation: "BACKFILL_EXISTING",
      activeInstanceCount: 0,
      provisioningAmbiguous: false,
      providerInstanceRefKnown: true,
    });
    expect(r.allowed).toBe(true);
  });

  it("Ren Sushi LIFETIME: provisionamento NOVO exige decisao administrativa", () => {
    const r = checkConnectionAllowance({
      fundingSource: "LIFETIME_OVERRIDE",
      includedConnections: null,
      operation: "NEW_PROVISIONING",
      activeInstanceCount: 1,
      provisioningAmbiguous: false,
      providerInstanceRefKnown: false,
    });
    expect(r.allowed).toBe(false);
    if (r.allowed !== false) return;
    expect(r.reasonCode).toBe("OVERRIDE_REQUIRES_ADMIN_DECISION");
  });

  it("BACKFILL legitimo de instancia que ja existe no provider passa", () => {
    const r = checkConnectionAllowance({
      ...P2,
      operation: "BACKFILL_EXISTING",
      activeInstanceCount: 0,
      provisioningAmbiguous: false,
      providerInstanceRefKnown: true,
    });
    expect(r.allowed).toBe(true);
  });

  it("BACKFILL DISFARCADO (sem referencia do provider) e rejeitado", () => {
    // Registrar "backfill" sem instancia real no provider e criar conexao nova
    // por outra porta.
    const r = checkConnectionAllowance({
      ...P2,
      operation: "BACKFILL_EXISTING",
      activeInstanceCount: 1,
      provisioningAmbiguous: false,
      providerInstanceRefKnown: false,
    });
    expect(r.allowed).toBe(false);
    if (r.allowed !== false) return;
    expect(r.reasonCode).toBe("BACKFILL_WITHOUT_PROVIDER_REF");
  });

  it("transicao ambigua bloqueia provisionamento NOVO", () => {
    const r = checkConnectionAllowance({
      ...P2,
      operation: "NEW_PROVISIONING",
      activeInstanceCount: 0,
      provisioningAmbiguous: true,
      providerInstanceRefKnown: false,
    });
    expect(r.allowed).toBe(false);
    if (r.allowed !== false) return;
    expect(r.reasonCode).toBe("SUBSCRIPTION_AMBIGUOUS");
  });

  it("transicao ambigua NAO impede registrar o que ja existe e ja custa", () => {
    const r = checkConnectionAllowance({
      ...P2,
      operation: "BACKFILL_EXISTING",
      activeInstanceCount: 0,
      provisioningAmbiguous: true,
      providerInstanceRefKnown: true,
    });
    expect(r.allowed).toBe(true);
  });

  it("sem fonte de financiamento, nada e autorizado", () => {
    const r = checkConnectionAllowance({
      fundingSource: "NONE",
      includedConnections: null,
      operation: "BACKFILL_EXISTING",
      activeInstanceCount: 0,
      provisioningAmbiguous: false,
      providerInstanceRefKnown: true,
    });
    expect(r.allowed).toBe(false);
    if (r.allowed !== false) return;
    expect(r.reasonCode).toBe("NO_FUNDING_SOURCE");
  });

  it("limite desconhecido no plano novo e fail-closed", () => {
    const input: ConnectionAllowanceInput = {
      fundingSource: "PLAN_INCLUDED",
      includedConnections: null,
      operation: "NEW_PROVISIONING",
      activeInstanceCount: 0,
      provisioningAmbiguous: false,
      providerInstanceRefKnown: false,
    };
    const r = checkConnectionAllowance(input);
    expect(r.allowed).toBe(false);
    if (r.allowed !== false) return;
    expect(r.reasonCode).toBe("ALLOWANCE_UNKNOWN");
  });
});
