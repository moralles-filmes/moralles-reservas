import { describe, it, expect } from "vitest";
import { simulatePartner } from "../../supabase/functions/_shared/whatsapp-partner-simulator-core";

describe("simulatePartner (spec §10.10)", () => {
  it("preço-alvo é OBRIGATÓRIO — não existe preço de Partner no código", () => {
    const r = simulatePartner({
      instanceCosts: [10000],
      partnerMonthlyTargetCents: undefined as unknown as number,
    });
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.code).toBe("PARTNER_TARGET_REQUIRED");
  });

  it("preço-alvo zero é recusado", () => {
    expect(simulatePartner({ instanceCosts: [10000], partnerMonthlyTargetCents: 0 }).ok).toBe(false);
  });

  it("preço-alvo negativo é recusado", () => {
    expect(simulatePartner({ instanceCosts: [10000], partnerMonthlyTargetCents: -1 }).ok).toBe(false);
  });

  it("usa APENAS custo real registrado e rotula como simulação", () => {
    const r = simulatePartner({ instanceCosts: [10000, 10000, 10000], partnerMonthlyTargetCents: 25000 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.simulated).toBe(true);
      expect(r.currentKnownCostCents).toBe(30000);
      expect(r.instancesWithKnownCost).toBe(3);
      expect(r.instancesWithUnknownCost).toBe(0);
      expect(r.savingsCents).toBe(5000);
    }
  });

  it("custo desconhecido é contado à parte e NÃO entra na soma como zero", () => {
    const r = simulatePartner({ instanceCosts: [10000, null], partnerMonthlyTargetCents: 25000 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.currentKnownCostCents).toBe(10000);
      expect(r.instancesWithUnknownCost).toBe(1);
    }
  });

  it("ponto de equilíbrio: quantas instâncias ao custo médio conhecido igualam o alvo", () => {
    const r = simulatePartner({ instanceCosts: [10000, 10000], partnerMonthlyTargetCents: 100000 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.breakEvenInstances).toBe(10);
  });

  it("sem custo conhecido não há ponto de equilíbrio inventado", () => {
    const r = simulatePartner({ instanceCosts: [null, null], partnerMonthlyTargetCents: 100000 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.breakEvenInstances).toBeNull();
      expect(r.currentKnownCostCents).toBe(0);
    }
  });

  it("economia negativa aparece como negativa — o Partner pode não compensar", () => {
    const r = simulatePartner({ instanceCosts: [10000], partnerMonthlyTargetCents: 25000 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.savingsCents).toBe(-15000);
  });
});
