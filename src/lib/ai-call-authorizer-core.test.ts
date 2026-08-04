import { describe, expect, it, vi } from "vitest";
import {
  authorizeAndInvoke,
  type AuthorizerDeps,
  type AuthorizedCallBase,
} from "../../supabase/functions/_shared/ai-call-authorizer-core";
import type { BeforeCallDecision } from "../../supabase/functions/_shared/ai-budget-core";

const base = (over: Partial<AuthorizedCallBase> = {}): AuthorizedCallBase => ({
  organizationId: "org",
  cycleId: "cyc",
  turnId: "turn",
  requestId: "req",
  reservationId: "res",
  provider: "gemini",
  model: "gemini-2.5-flash",
  iteration: 1,
  maxIterations: 12,
  consumedCents: 0,
  reservedCents: 400,
  nextCallEstimateCents: 100,
  ...over,
});

function deps(over: Partial<AuthorizerDeps> = {}): AuthorizerDeps {
  let n = 0;
  return {
    priceFor: vi.fn(async () => ({ kind: "PRICED" as const, priceId: "price-1" })),
    beforeCall: vi.fn(async (): Promise<BeforeCallDecision> => ({
      kind: "ALLOW",
      reservationId: "res",
      remainingReservedCents: 300,
    })),
    invoke: vi.fn(async () => ({
      kind: "OK" as const,
      value: { text: "oi" },
      rawUsage: { input_tokens: 100, output_tokens: 50 },
    })),
    reportCall: vi.fn(async () => {}),
    newCallId: () => `call-${++n}`,
    ...over,
  };
}

describe("protocolo ordenado por chamada (§17.7.3)", () => {
  it("a ordem é preço → autorização → chamada → apropriação", async () => {
    const order: string[] = [];
    const d = deps({
      priceFor: vi.fn(async () => {
        order.push("price");
        return { kind: "PRICED" as const, priceId: "price-1" };
      }),
      beforeCall: vi.fn(async () => {
        order.push("before");
        return { kind: "ALLOW" as const, reservationId: "res", remainingReservedCents: 300 };
      }),
      invoke: vi.fn(async () => {
        order.push("invoke");
        return { kind: "OK" as const, value: {}, rawUsage: { input_tokens: 1, output_tokens: 1 } };
      }),
      reportCall: vi.fn(async () => {
        order.push("report");
      }),
    });
    await authorizeAndInvoke(base(), d);
    expect(order).toEqual(["price", "before", "invoke", "report"]);
  });

  it("a apropriação é AGUARDADA antes de a função retornar — a 2ª chamada não decide com o saldo da 1ª", async () => {
    let reported = false;
    const d = deps({
      reportCall: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 5));
        reported = true;
      }),
    });
    await authorizeAndInvoke(base(), d);
    expect(reported).toBe(true);
  });

  it("modelo sem preço vigente: ZERO chamada ao provider", async () => {
    const d = deps({
      priceFor: vi.fn(async () => ({ kind: "PRICE_UNKNOWN" as const, provider: "grok", model: "grok-9" })),
    });
    const r = await authorizeAndInvoke(base({ provider: "grok", model: "grok-9" }), d);
    expect(r.kind).toBe("DENIED");
    if (r.kind !== "DENIED") return;
    expect(r.decision.kind).toBe("DENY_PRICE_UNKNOWN");
    expect(d.invoke).not.toHaveBeenCalled();
    expect(d.beforeCall).not.toHaveBeenCalled();
    expect(d.reportCall).not.toHaveBeenCalled();
  });

  it("beforeCall negado: ZERO chamada externa, qualquer que seja a variante", async () => {
    for (const decision of [
      { kind: "DENY_BUDGET", reasonCode: "x" },
      { kind: "DENY_USAGE_UNRESOLVED", reasonCode: "x" },
      { kind: "ERROR", retryable: true, sanitizedCode: "x" },
    ] as BeforeCallDecision[]) {
      const d = deps({ beforeCall: vi.fn(async () => decision) });
      const r = await authorizeAndInvoke(base(), d);
      expect(r.kind).toBe("DENIED");
      expect(d.invoke).not.toHaveBeenCalled();
      expect(d.reportCall).not.toHaveBeenCalled();
    }
  });

  it("a decisão negada é PROPAGADA intacta — ERROR não vira DENY_BUDGET", async () => {
    const d = deps({
      beforeCall: vi.fn(async () => ({ kind: "ERROR" as const, retryable: false, sanitizedCode: "db_down" })),
    });
    const r = await authorizeAndInvoke(base(), d);
    expect(r.kind).toBe("DENIED");
    if (r.kind !== "DENIED" || r.decision.kind !== "ERROR") throw new Error("variante errada");
    expect(r.decision.retryable).toBe(false);
    expect(r.decision.sanitizedCode).toBe("db_down");
  });

  it("cada chamada tem call_id PRÓPRIO", async () => {
    const d = deps();
    const a = await authorizeAndInvoke(base(), d);
    const b = await authorizeAndInvoke(base({ iteration: 2 }), d);
    expect(a.meta.callId).not.toBe(b.meta.callId);
  });

  it("o meta carrega provider e model REAIS da chamada", async () => {
    const d = deps();
    const r = await authorizeAndInvoke(base({ provider: "gemini", model: "gemini-2.5-pro" }), d);
    expect(r.meta.provider).toBe("gemini");
    expect(r.meta.model).toBe("gemini-2.5-pro");
    // O preço consultado é o do modelo REAL — Pro custa múltiplas vezes Flash.
    expect(d.priceFor).toHaveBeenCalledWith("gemini", "gemini-2.5-pro");
  });

  it("usage do provider é propagado intacto — o ramo que faz o orçamento andar", async () => {
    const d = deps();
    const r = await authorizeAndInvoke(base(), d);
    if (r.kind !== "EXECUTED") throw new Error("deveria ter executado");
    if (r.outcome.kind !== "USAGE") throw new Error("deveria ser USAGE, veio " + r.outcome.kind);
    expect(r.outcome.usage.input_tokens).toBe(100);
    expect(r.outcome.usage.output_tokens).toBe(50);
  });

  it("usage ausente vira NO_USAGE — nunca consumo zero", async () => {
    const d = deps({
      invoke: vi.fn(async () => ({ kind: "OK" as const, value: {}, rawUsage: null })),
    });
    await authorizeAndInvoke(base(), d);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- introspecção de mock.calls
    const [, outcome] = (d.reportCall as any).mock.calls[0];
    expect(outcome.kind).toBe("NO_USAGE");
  });

  it("usage vazio (objeto sem tokens) também é NO_USAGE", async () => {
    const d = deps({
      invoke: vi.fn(async () => ({ kind: "OK" as const, value: {}, rawUsage: { cache_read_tokens: 9 } })),
    });
    await authorizeAndInvoke(base(), d);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- introspecção de mock.calls
    const [, outcome] = (d.reportCall as any).mock.calls[0];
    expect(outcome.kind).toBe("NO_USAGE");
  });

  it("falha do provider vira PROVIDER_FAILED e ainda assim é reportada", async () => {
    const providerError = new Error("503");
    const d = deps({
      invoke: vi.fn(async () => ({ kind: "FAILED" as const, error: providerError })),
    });
    const r = await authorizeAndInvoke(base(), d);
    expect(r.kind).toBe("EXECUTED");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- introspecção de mock.calls
    const [, outcome] = (d.reportCall as any).mock.calls[0];
    expect(outcome.kind).toBe("PROVIDER_FAILED");
    expect(outcome.error).toBe(providerError);
  });

  it("reportCall recebe o priceId da vigência consultada, não um preço inventado", async () => {
    const d = deps();
    await authorizeAndInvoke(base(), d);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- introspecção de mock.calls
    const [, , priceId] = (d.reportCall as any).mock.calls[0];
    expect(priceId).toBe("price-1");
  });

  it("reportCall é chamado UMA vez por chamada autorizada", async () => {
    const d = deps();
    await authorizeAndInvoke(base(), d);
    expect(d.reportCall).toHaveBeenCalledTimes(1);
  });

  it("erro dentro de reportCall não é engolido — apropriação silenciosamente perdida é o pior caso", async () => {
    const d = deps({
      reportCall: vi.fn(async () => {
        throw new Error("db");
      }),
    });
    await expect(authorizeAndInvoke(base(), d)).rejects.toThrow();
  });
});

describe("fallback como chamada financeira própria (§17.7.6)", () => {
  it("a segunda chamada NÃO herda a autorização da primeira", async () => {
    const d = deps();
    await authorizeAndInvoke(base({ model: "gemini-2.5-flash" }), d);
    await authorizeAndInvoke(base({ model: "gemini-2.5-pro", iteration: 1 }), d);
    expect(d.beforeCall).toHaveBeenCalledTimes(2);
    expect(d.priceFor).toHaveBeenCalledTimes(2);
  });

  it("o fallback é precificado pelo modelo REAL", async () => {
    const d = deps();
    await authorizeAndInvoke(base({ model: "gemini-2.5-pro" }), d);
    expect(d.priceFor).toHaveBeenCalledWith("gemini", "gemini-2.5-pro");
    expect(d.priceFor).not.toHaveBeenCalledWith("gemini", "gemini-2.5-flash");
  });

  it("com usage da 1ª pendente, o fallback recebe DENY_USAGE_UNRESOLVED e não chama nada", async () => {
    const d = deps({
      beforeCall: vi.fn(async () => ({ kind: "DENY_USAGE_UNRESOLVED" as const, reasonCode: "prior_usage_unresolved" })),
    });
    const r = await authorizeAndInvoke(base({ model: "gemini-2.5-pro" }), d);
    expect(r.kind).toBe("DENIED");
    if (r.kind !== "DENIED") return;
    expect(r.decision.kind).toBe("DENY_USAGE_UNRESOLVED");
    expect(d.invoke).not.toHaveBeenCalled();
  });

  it("as duas chamadas do mesmo turno compartilham turn_id e diferem em call_id", async () => {
    const d = deps();
    const a = await authorizeAndInvoke(base({ model: "gemini-2.5-flash" }), d);
    const b = await authorizeAndInvoke(base({ model: "gemini-2.5-pro" }), d);
    expect(a.meta.turnId).toBe(b.meta.turnId);
    expect(a.meta.callId).not.toBe(b.meta.callId);
  });
});

describe("o autorizador não conta volume", () => {
  it("nenhuma dependência recebe contagem de conversa ou mensagem", async () => {
    const d = deps();
    const r = await authorizeAndInvoke(base(), d);
    expect(Object.keys(r.meta)).not.toContain("conversationCount");
    expect(Object.keys(r.meta)).not.toContain("messageCount");
  });
});
