import { describe, expect, it } from "vitest";
import {
  AI_BUDGET_MILESTONE_PERCENTS,
  EVENT_TYPE_BY_MILESTONE_PERCENT,
  CANONICAL_AI_BUDGET_EVENT_TYPES,
  crossedMilestonePercents,
} from "../../supabase/functions/_shared/ai-budget-milestones-core";
import {
  AI_BUDGET_EXHAUSTED_CUSTOMER_TEXT,
  AI_BUDGET_HARDCODED_TEXTS,
  resolveMutationStopText,
} from "../../supabase/functions/_shared/ai-budget-copy";

describe("marcos da franquia", () => {
  it("são exatamente quatro: 70, 80, 90 e 100 por cento", () => {
    expect([...AI_BUDGET_MILESTONE_PERCENTS]).toEqual([70, 80, 90, 100]);
  });

  it("com limite de R$ 100 os marcos caem em R$ 70/80/90/100", () => {
    expect(crossedMilestonePercents(6999, 10000)).toEqual([]);
    expect(crossedMilestonePercents(7000, 10000)).toEqual([70]);
    expect(crossedMilestonePercents(8000, 10000)).toEqual([70, 80]);
    expect(crossedMilestonePercents(9999, 10000)).toEqual([70, 80, 90]);
    expect(crossedMilestonePercents(10000, 10000)).toEqual([70, 80, 90, 100]);
    expect(crossedMilestonePercents(999999, 10000)).toEqual([70, 80, 90, 100]);
  });

  it("os marcos são proporcionais ao limite do ciclo, não valores absolutos", () => {
    // Um ciclo com limite diferente (plano CUSTOM futuro) mantém a mesma escada.
    expect(crossedMilestonePercents(140, 200)).toEqual([70]);
  });

  it("limite zero ou negativo não produz marco — nem divisão por zero", () => {
    expect(crossedMilestonePercents(0, 0)).toEqual([]);
    expect(crossedMilestonePercents(100, -1)).toEqual([]);
  });

  it("cada marco tem event_type próprio e a lista canônica é derivada, não redigitada", () => {
    expect(EVENT_TYPE_BY_MILESTONE_PERCENT[70]).toBe("admin_ai_budget_70");
    expect(EVENT_TYPE_BY_MILESTONE_PERCENT[80]).toBe("admin_ai_budget_80");
    expect(EVENT_TYPE_BY_MILESTONE_PERCENT[90]).toBe("admin_ai_budget_90");
    expect(EVENT_TYPE_BY_MILESTONE_PERCENT[100]).toBe("admin_ai_budget_stop");
    expect(CANONICAL_AI_BUDGET_EVENT_TYPES).toHaveLength(4);
    expect(new Set(CANONICAL_AI_BUDGET_EVENT_TYPES).size).toBe(4);
  });
});

describe("copy determinística do hard stop", () => {
  it("nunca expõe custo, tokens, modelo, margem ou o limite", () => {
    for (const text of AI_BUDGET_HARDCODED_TEXTS) {
      // `\bIA\b` e não `IA`: sem as bordas, o alternador casaria dentro de
      // "família", "diária", "sequência" — o teste passaria por sorte de
      // vocabulário e reprovaria uma reescrita inocente.
      expect(text).not.toMatch(/R\$|centavo|token|margem|franquia|limite|100,00|\bIA\b|inteligência artificial/i);
    }
  });

  it("nunca afirma falha técnica", () => {
    for (const text of AI_BUDGET_HARDCODED_TEXTS) {
      expect(text).not.toMatch(/erro|falha|instabilidade|indisponível|problema técnico/i);
    }
  });

  it("o texto do hard stop encaminha para a equipe sem prometer prazo", () => {
    expect(AI_BUDGET_EXHAUSTED_CUSTOMER_TEXT).toMatch(/equipe/i);
    expect(AI_BUDGET_EXHAUSTED_CUSTOMER_TEXT.length).toBeLessThanOrEqual(4096);
  });

  it("as três situações de ferramenta mutante têm textos DIFERENTES", () => {
    const completed = resolveMutationStopText("COMPLETED");
    const pending = resolveMutationStopText("PENDING");
    const unknown = resolveMutationStopText("UNKNOWN");
    expect(new Set([completed, pending, unknown]).size).toBe(3);
  });

  it("só a situação concluída pode confirmar; pendente registra sem confirmar", () => {
    expect(resolveMutationStopText("COMPLETED")).toMatch(/confirmad/i);
    expect(resolveMutationStopText("PENDING")).not.toMatch(/confirmad/i);
    expect(resolveMutationStopText("PENDING")).toMatch(/registr/i);
  });

  it("a situação interrompida NÃO afirma nada sobre a ação", () => {
    const unknown = resolveMutationStopText("UNKNOWN");
    expect(unknown).not.toMatch(/confirmad|reservad|cancelad|alterad/i);
  });

  it("todos os textos estão na lista que entra no HARDCODED_AGENT_NOISE", () => {
    expect(AI_BUDGET_HARDCODED_TEXTS).toContain(AI_BUDGET_EXHAUSTED_CUSTOMER_TEXT);
    for (const o of ["COMPLETED", "PENDING", "UNKNOWN"] as const) {
      expect(AI_BUDGET_HARDCODED_TEXTS).toContain(resolveMutationStopText(o));
    }
  });
});
