import { describe, it, expect } from "vitest";
import {
  NEW_REAL_INSTANCE_PROVISIONING_BLOCKED_UNTIL_PHASE_6A,
  PROVISIONING_BLOCKED_CODE,
  assertProvisioningAllowed,
  canTransition,
  validateProviderInstanceRef,
} from "../../supabase/functions/_shared/whatsapp-instance-core";

describe("gate de provisionamento (spec §2)", () => {
  it("a constante existe e está LIGADA até a Fase 6a", () => {
    expect(NEW_REAL_INSTANCE_PROVISIONING_BLOCKED_UNTIL_PHASE_6A).toBe(true);
  });

  it("provisionamento novo é recusado", () => {
    const r = assertProvisioningAllowed("NEW_PROVISION");
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.code).toBe(PROVISIONING_BLOCKED_CODE);
  });

  it("backfill de instância que já existe no fornecedor é PERMITIDO", () => {
    expect(assertProvisioningAllowed("BACKFILL_EXISTING").ok).toBe(true);
  });

  it("ambiguidade entre backfill e criação nova BLOQUEIA — fail-closed", () => {
    const r = assertProvisioningAllowed("AMBIGUOUS");
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.code).toBe(PROVISIONING_BLOCKED_CODE);
  });

  it("a mensagem de bloqueio não expõe segredo nem detalhe de credencial", () => {
    const r = assertProvisioningAllowed("NEW_PROVISION");
    expect(r.ok).toBe(false);
    if (r.ok === false) {
      expect(r.message).not.toMatch(/token|secret|credential|senha/i);
      expect(r.message.length).toBeGreaterThan(0);
    }
  });
});

describe("transições de lifecycle (spec §4)", () => {
  const noEvidence = { hasProviderEvidence: false };
  const evidence = { hasProviderEvidence: true };

  it("ACTIVE → CANCELLATION_REQUESTED é permitido", () => {
    expect(canTransition("ACTIVE", "CANCELLATION_REQUESTED", noEvidence).ok).toBe(true);
  });

  it("CANCELLATION_REQUESTED → ENDED é permitido (confirmação humana)", () => {
    expect(canTransition("CANCELLATION_REQUESTED", "ENDED", noEvidence).ok).toBe(true);
  });

  it("CANCELLATION_REQUESTED → ACTIVE exige evidência de reversão no fornecedor", () => {
    expect(canTransition("CANCELLATION_REQUESTED", "ACTIVE", noEvidence).ok).toBe(false);
    expect(canTransition("CANCELLATION_REQUESTED", "ACTIVE", evidence).ok).toBe(true);
  });

  it("ENDED NÃO volta a ACTIVE silenciosamente, nem com evidência", () => {
    expect(canTransition("ENDED", "ACTIVE", evidence).ok).toBe(false);
  });

  it("ACTIVE → ENDED direto é recusado: passa por CANCELLATION_REQUESTED", () => {
    expect(canTransition("ACTIVE", "ENDED", evidence).ok).toBe(false);
  });

  it("transição para o mesmo estado é no-op permitido (idempotência)", () => {
    expect(canTransition("ACTIVE", "ACTIVE", noEvidence).ok).toBe(true);
  });
});

describe("validateProviderInstanceRef — identificador, nunca credencial (§3.3)", () => {
  it("aceita identificador simples", () => {
    const r = validateProviderInstanceRef("  3A2F9C1D  ");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("3A2F9C1D");
  });

  it("recusa string vazia", () => {
    expect(validateProviderInstanceRef("   ").ok).toBe(false);
  });

  it("recusa URL completa — ela carregaria o token na outra metade", () => {
    expect(validateProviderInstanceRef("https://api.z-api.io/instances/X/token/Y").ok).toBe(false);
  });

  it("recusa valor longo demais para ser identificador", () => {
    expect(validateProviderInstanceRef("A".repeat(129)).ok).toBe(false);
  });

  it("recusa valor com espaço interno ou quebra de linha", () => {
    expect(validateProviderInstanceRef("abc def").ok).toBe(false);
    expect(validateProviderInstanceRef("abc\ndef").ok).toBe(false);
  });
});
