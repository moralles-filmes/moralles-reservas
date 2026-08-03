import { describe, expect, it } from "vitest";
import {
  AI_BUDGET_DEFAULT_LIMIT_CENTS,
  AI_TURN_INITIAL_CALLS,
  computeAvailableCents,
  resolveCycleWindow,
  estimateCallTokens,
  planNextCall,
  mapReserveDecision,
  telemetryEventFor,
  isCommercialHardStop,
  shouldAutoResolveHandoff,
  type BeforeCallContext,
} from "../../supabase/functions/_shared/ai-budget-core";

const ctx = (over: Partial<BeforeCallContext> = {}): BeforeCallContext => ({
  organizationId: "org",
  cycleId: "cyc",
  turnId: "turn",
  requestId: "req",
  provider: "gemini",
  model: "gemini-2.5-flash",
  iteration: 1,
  maxIterations: 12,
  reservationId: "res",
  consumedCents: 0,
  reservedCents: 400,
  nextCallEstimateCents: 100,
  ...over,
});

describe("teto e disponível", () => {
  it("o limite padrão é R$ 100,00", () => {
    expect(AI_BUDGET_DEFAULT_LIMIT_CENTS).toBe(10000);
  });

  it("disponível = limite − liquidado − restante COMPROMETIDO das reservas", () => {
    expect(
      computeAvailableCents({ limitCents: 10000, settledCents: 3000, activeReservedRemainingCents: 500 }),
    ).toBe(6500);
  });

  it("settled e reserva NÃO colapsam num campo só", () => {
    // Mesma soma, papéis diferentes: o disponível é igual, mas as duas grandezas
    // entram separadas — é o que permite responder "quanto custou de verdade".
    const a = computeAvailableCents({ limitCents: 10000, settledCents: 8000, activeReservedRemainingCents: 0 });
    const b = computeAvailableCents({ limitCents: 10000, settledCents: 0, activeReservedRemainingCents: 8000 });
    expect(a).toBe(2000);
    expect(b).toBe(2000);
  });

  it("nunca devolve negativo", () => {
    expect(
      computeAvailableCents({ limitCents: 10000, settledCents: 11000, activeReservedRemainingCents: 500 }),
    ).toBe(0);
  });
});

describe("janela do ciclo", () => {
  it("cycle_end é EXCLUSIVO — o primeiro dia NÃO coberto", () => {
    const w = resolveCycleWindow({
      todayIso: "2026-08-03",
      anchorDay: 4,
      subscriptionPeriodStartIso: null,
      subscriptionPeriodEndIso: null,
      orgCreatedAtIso: "2025-01-04T10:00:00Z",
    });
    expect(w.cycleStart).toBe("2026-07-04");
    expect(w.cycleEnd).toBe("2026-08-04");
    expect(w.anchorDay).toBe(4);
  });

  it("hoje igual ao dia-âncora abre o ciclo NOVO, não o anterior", () => {
    const w = resolveCycleWindow({
      todayIso: "2026-08-04",
      anchorDay: 4,
      subscriptionPeriodStartIso: null,
      subscriptionPeriodEndIso: null,
      orgCreatedAtIso: "2025-01-04T10:00:00Z",
    });
    expect(w.cycleStart).toBe("2026-08-04");
    expect(w.cycleEnd).toBe("2026-09-04");
  });

  it("âncora 31 não degrada depois de fevereiro — é persistida, nunca re-derivada", () => {
    const feb = resolveCycleWindow({
      todayIso: "2026-02-15",
      anchorDay: 31,
      subscriptionPeriodStartIso: null,
      subscriptionPeriodEndIso: null,
      orgCreatedAtIso: "2025-01-31T10:00:00Z",
    });
    expect(feb.cycleStart).toBe("2026-01-31");
    expect(feb.cycleEnd).toBe("2026-02-28");
    expect(feb.anchorDay).toBe(31);

    const mar = resolveCycleWindow({
      todayIso: "2026-03-15",
      anchorDay: 31,
      subscriptionPeriodStartIso: null,
      subscriptionPeriodEndIso: null,
      orgCreatedAtIso: "2025-01-31T10:00:00Z",
    });
    // 15/03 ainda está DENTRO do ciclo que abriu no marco clampado de fevereiro.
    expect(mar.cycleStart).toBe("2026-02-28");
    // O que prova que a âncora sobreviveu a fevereiro é o FIM voltar a 31: se
    // ela tivesse degradado para 28, este ciclo terminaria em 2026-03-28 e
    // nunca mais voltaria ao dia 31.
    expect(mar.cycleEnd).toBe("2026-03-31");
    expect(mar.anchorDay).toBe(31);
  });

  it("sem âncora persistida, deriva do fim do período da assinatura", () => {
    const w = resolveCycleWindow({
      todayIso: "2026-08-03",
      anchorDay: null,
      subscriptionPeriodStartIso: "2026-07-10T00:00:00Z",
      subscriptionPeriodEndIso: "2026-08-10T00:00:00Z",
      orgCreatedAtIso: "2025-01-04T10:00:00Z",
    });
    expect(w.anchorDay).toBe(10);
    expect(w.cycleStart).toBe("2026-07-10");
    expect(w.cycleEnd).toBe("2026-08-10");
  });

  it("sem assinatura nem âncora, cai na data de criação da organização", () => {
    const w = resolveCycleWindow({
      todayIso: "2026-08-03",
      anchorDay: null,
      subscriptionPeriodStartIso: null,
      subscriptionPeriodEndIso: null,
      orgCreatedAtIso: "2025-01-20T10:00:00Z",
    });
    expect(w.anchorDay).toBe(20);
    expect(w.cycleStart).toBe("2026-07-20");
    expect(w.cycleEnd).toBe("2026-08-20");
  });

  it("cycle_start é sempre menor que cycle_end", () => {
    for (const day of [1, 15, 28, 29, 30, 31]) {
      const w = resolveCycleWindow({
        todayIso: "2026-02-10",
        anchorDay: day,
        subscriptionPeriodStartIso: null,
        subscriptionPeriodEndIso: null,
        orgCreatedAtIso: "2025-01-01T00:00:00Z",
      });
      expect(w.cycleStart < w.cycleEnd).toBe(true);
    }
  });
});

describe("estimativa conservadora", () => {
  it("cresce com a iteração — a 11ª carrega mais contexto que a 1ª", () => {
    const first = estimateCallTokens(1);
    const eleventh = estimateCallTokens(11);
    expect(eleventh.input_tokens).toBeGreaterThan(first.input_tokens);
  });

  it("nunca assume cache hit — cache_read estimado é zero", () => {
    expect(estimateCallTokens(5).cache_read_tokens).toBe(0);
  });

  it("a reserva inicial cobre mais de uma chamada", () => {
    expect(AI_TURN_INITIAL_CALLS).toBeGreaterThanOrEqual(2);
  });
});

describe("planNextCall", () => {
  it("libera quando o restante da reserva cobre a estimativa", () => {
    const p = planNextCall(ctx({ reservedCents: 400, consumedCents: 100, nextCallEstimateCents: 100 }), {
      usageUnresolved: false,
    });
    expect(p.kind).toBe("ALLOW");
  });

  it("pede extensão quando o restante NÃO cobre — o turno longo não é punido se o ciclo tem saldo", () => {
    const p = planNextCall(ctx({ reservedCents: 400, consumedCents: 380, nextCallEstimateCents: 100 }), {
      usageUnresolved: false,
    });
    expect(p.kind).toBe("EXTEND");
    if (p.kind !== "EXTEND") return;
    expect(p.additionalCents).toBeGreaterThanOrEqual(80);
  });

  it("usage pendente nega ANTES de qualquer consideração de saldo", () => {
    const p = planNextCall(ctx({ reservedCents: 100000, consumedCents: 0 }), { usageUnresolved: true });
    expect(p.kind).toBe("DENY_USAGE_UNRESOLVED");
  });

  it("consumo acima do reservado (overage) vira pedido de extensão, não crédito silencioso", () => {
    const p = planNextCall(ctx({ reservedCents: 400, consumedCents: 500, nextCallEstimateCents: 100 }), {
      usageUnresolved: false,
    });
    expect(p.kind).toBe("EXTEND");
  });
});

describe("mapReserveDecision", () => {
  it("ALLOW carrega a reserva e o restante comprometido", () => {
    const d = mapReserveDecision({
      decision: "ALLOW",
      reservation_id: "r1",
      reserved_cents: 400,
      consumed_cents: 50,
    });
    expect(d.kind).toBe("ALLOW");
    if (d.kind !== "ALLOW") return;
    expect(d.reservationId).toBe("r1");
    expect(d.remainingReservedCents).toBe(350);
  });

  it("DENY_BUDGET é hard stop comercial", () => {
    const d = mapReserveDecision({ decision: "DENY_BUDGET", reason_code: "cycle_exhausted" });
    expect(d.kind).toBe("DENY_BUDGET");
    expect(isCommercialHardStop(d)).toBe(true);
  });

  it("ERROR de infraestrutura NÃO é confundido com teto atingido", () => {
    const d = mapReserveDecision({ decision: "SOMETHING_WEIRD" });
    expect(d.kind).toBe("ERROR");
    expect(isCommercialHardStop(d)).toBe(false);
    if (d.kind !== "ERROR") return;
    expect(d.retryable).toBe(true);
    // sanitizedCode é código curto, nunca mensagem do Postgres
    expect(d.sanitizedCode.length).toBeLessThanOrEqual(40);
    expect(d.sanitizedCode).not.toMatch(/select|insert|update|ERROR:/i);
  });

  it("nenhuma variante de negação técnica é hard stop comercial", () => {
    expect(isCommercialHardStop({ kind: "DENY_PRICE_UNKNOWN", provider: "x", model: "y" })).toBe(false);
    expect(isCommercialHardStop({ kind: "DENY_USAGE_UNRESOLVED", reasonCode: "pending" })).toBe(false);
  });

  it("cada variante tem evento de telemetria PRÓPRIO", () => {
    const events = [
      telemetryEventFor({ kind: "ALLOW", reservationId: "r", remainingReservedCents: 1 }),
      telemetryEventFor({ kind: "DENY_BUDGET", reasonCode: "x" }),
      telemetryEventFor({ kind: "DENY_PRICE_UNKNOWN", provider: "p", model: "m" }),
      telemetryEventFor({ kind: "DENY_USAGE_UNRESOLVED", reasonCode: "x" }),
      telemetryEventFor({ kind: "ERROR", retryable: true, sanitizedCode: "x" }),
    ];
    expect(new Set(events).size).toBe(5);
  });
});

describe("auto-resolve do handoff", () => {
  it("handoff por erro comum resolve normalmente depois da janela", () => {
    expect(
      shouldAutoResolveHandoff({
        handoffReason: "agent_error:gemini:gemini-2.5-flash",
        ageMs: 13 * 3600_000,
        thresholdMs: 12 * 3600_000,
        budgetExhausted: false,
      }),
    ).toBe(true);
  });

  it("franquia esgotada NÃO devolve a conversa para uma IA que não pode responder", () => {
    expect(
      shouldAutoResolveHandoff({
        handoffReason: "ai_budget_exhausted",
        ageMs: 400 * 3600_000,
        thresholdMs: 12 * 3600_000,
        budgetExhausted: true,
      }),
    ).toBe(false);
  });

  it("virada do ciclo devolve a conversa", () => {
    expect(
      shouldAutoResolveHandoff({
        handoffReason: "ai_budget_exhausted",
        ageMs: 13 * 3600_000,
        thresholdMs: 12 * 3600_000,
        budgetExhausted: false,
      }),
    ).toBe(true);
  });

  it("sem idade suficiente não resolve, qualquer que seja a razão", () => {
    expect(
      shouldAutoResolveHandoff({
        handoffReason: "ai_budget_exhausted",
        ageMs: 1000,
        thresholdMs: 12 * 3600_000,
        budgetExhausted: false,
      }),
    ).toBe(false);
  });
});
