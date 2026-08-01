// Núcleo puro (Fase 6b): simulação do Plano Partner. ZERO IMPORTS.
//
// NUNCA constante de preço de Partner no código: a Z-API não publicou preço
// para nós, e um número inventado viraria base de decisão comercial. O alvo é
// informado pelo administrador no momento da simulação. Não persiste nada.

export type PartnerSimulationInput = {
  instanceCosts: (number | null)[];
  partnerMonthlyTargetCents: number;
};

export type PartnerSimulationOk = {
  ok: true;
  simulated: true;
  instancesWithKnownCost: number;
  instancesWithUnknownCost: number;
  currentKnownCostCents: number;
  partnerMonthlyTargetCents: number;
  /** Positivo = o Partner economiza. Negativo = não compensa hoje. */
  savingsCents: number;
  breakEvenInstances: number | null;
};

export type PartnerSimulationResult =
  | PartnerSimulationOk
  | { ok: false; code: string; message: string };

export function simulatePartner(input: PartnerSimulationInput): PartnerSimulationResult {
  const target = input.partnerMonthlyTargetCents;
  if (typeof target !== "number" || !isFinite(target) || target <= 0) {
    return {
      ok: false,
      code: "PARTNER_TARGET_REQUIRED",
      message:
        "Informe o preço-alvo mensal do Plano Partner para simular. O sistema não tem esse preço.",
    };
  }

  let currentKnownCostCents = 0;
  let instancesWithKnownCost = 0;
  let instancesWithUnknownCost = 0;
  for (const c of input.instanceCosts || []) {
    if (c === null || c === undefined) instancesWithUnknownCost++;
    else {
      currentKnownCostCents += c;
      instancesWithKnownCost++;
    }
  }

  // Média só existe se houver custo conhecido — senão o ponto de equilíbrio
  // seria uma divisão por zero disfarçada de resposta.
  const breakEvenInstances =
    instancesWithKnownCost > 0
      ? Math.ceil(target / (currentKnownCostCents / instancesWithKnownCost))
      : null;

  return {
    ok: true,
    simulated: true,
    instancesWithKnownCost,
    instancesWithUnknownCost,
    currentKnownCostCents,
    partnerMonthlyTargetCents: target,
    savingsCents: currentKnownCostCents - target,
    breakEvenInstances,
  };
}
