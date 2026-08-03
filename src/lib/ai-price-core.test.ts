import { describe, expect, it } from "vitest";
import {
  selectEffectivePrice,
  priceUsage,
  classifyUsage,
  usdToBrlCents,
  type AiModelPrice,
  type AiUsageTokens,
} from "../../supabase/functions/_shared/ai-price-core";

const price = (over: Partial<AiModelPrice> = {}): AiModelPrice => ({
  id: "p1",
  provider: "gemini",
  model: "gemini-2.5-flash",
  inputUsdPerMtok: 0.15,
  outputUsdPerMtok: 0.6,
  cacheReadUsdPerMtok: 0.0375,
  cacheWriteUsdPerMtok: 0,
  reasoningUsdPerMtok: null,
  usdToBrl: 5.5,
  effectiveFrom: "2026-01-01T00:00:00Z",
  effectiveTo: null,
  ...over,
});

const usage = (over: Partial<AiUsageTokens> = {}): AiUsageTokens => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
  reasoning_tokens: 0,
  ...over,
});

describe("selectEffectivePrice", () => {
  it("devolve null quando não há linha para provider/model", () => {
    expect(selectEffectivePrice([price()], "gemini", "gemini-2.5-pro", "2026-08-03T12:00:00Z")).toBeNull();
    expect(selectEffectivePrice([price()], "openai", "gemini-2.5-flash", "2026-08-03T12:00:00Z")).toBeNull();
  });

  it("respeita effective_from inclusivo e effective_to exclusivo", () => {
    const rows = [price({ id: "old", effectiveFrom: "2026-01-01T00:00:00Z", effectiveTo: "2026-06-01T00:00:00Z" })];
    expect(selectEffectivePrice(rows, "gemini", "gemini-2.5-flash", "2026-01-01T00:00:00Z")?.id).toBe("old");
    expect(selectEffectivePrice(rows, "gemini", "gemini-2.5-flash", "2026-05-31T23:59:59Z")?.id).toBe("old");
    expect(selectEffectivePrice(rows, "gemini", "gemini-2.5-flash", "2026-06-01T00:00:00Z")).toBeNull();
  });

  it("entre vigências sobrepostas escolhe a de effective_from mais recente", () => {
    const rows = [
      price({ id: "a", effectiveFrom: "2026-01-01T00:00:00Z" }),
      price({ id: "b", effectiveFrom: "2026-07-01T00:00:00Z" }),
    ];
    expect(selectEffectivePrice(rows, "gemini", "gemini-2.5-flash", "2026-08-03T12:00:00Z")?.id).toBe("b");
  });
});

describe("priceUsage", () => {
  it("modelo sem preço vigente devolve PRICE_UNKNOWN — nunca zero", () => {
    const r = priceUsage(null, usage({ input_tokens: 1_000_000 }), "grok", "grok-9");
    expect(r.kind).toBe("PRICE_UNKNOWN");
    if (r.kind === "PRICE_UNKNOWN") {
      expect(r.provider).toBe("grok");
      expect(r.model).toBe("grok-9");
    }
    // Garantia explícita: nenhuma variante com custo zero foi devolvida.
    expect(JSON.stringify(r)).not.toContain('"usd":0');
  });

  it("soma as cinco faixas de token", () => {
    const r = priceUsage(
      price({ reasoningUsdPerMtok: 2 }),
      usage({
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        cache_read_tokens: 1_000_000,
        cache_creation_tokens: 1_000_000,
        reasoning_tokens: 1_000_000,
      }),
      "gemini",
      "gemini-2.5-flash",
    );
    expect(r.kind).toBe("PRICED");
    if (r.kind !== "PRICED") return;
    // 0.15 + 0.6 + 0.0375 + 0 + 2
    expect(r.usd).toBeCloseTo(2.7875, 6);
  });

  it("reasoning sem preço próprio é cobrado como output — conservador, nunca grátis", () => {
    const r = priceUsage(price({ reasoningUsdPerMtok: null }), usage({ reasoning_tokens: 1_000_000 }), "gemini", "gemini-2.5-flash");
    expect(r.kind).toBe("PRICED");
    if (r.kind !== "PRICED") return;
    expect(r.usd).toBeCloseTo(0.6, 6);
  });

  it("converte para BRL cents ARREDONDANDO PRA CIMA e carrega a taxa usada", () => {
    const r = priceUsage(price({ usdToBrl: 5.5 }), usage({ input_tokens: 1 }), "gemini", "gemini-2.5-flash");
    expect(r.kind).toBe("PRICED");
    if (r.kind !== "PRICED") return;
    expect(r.brlCents).toBe(1); // 0.00000015 USD → arredonda pra cima, nunca 0
    expect(r.usdToBrl).toBe(5.5);
    expect(r.priceId).toBe("p1");
  });

  it("uso zero real custa zero — o piso de 1 cent só vale para consumo > 0", () => {
    const r = priceUsage(price(), usage(), "gemini", "gemini-2.5-flash");
    expect(r.kind).toBe("PRICED");
    if (r.kind !== "PRICED") return;
    expect(r.brlCents).toBe(0);
  });
});

describe("usdToBrlCents", () => {
  it("nunca devolve fração e nunca arredonda para baixo", () => {
    expect(usdToBrlCents(0.001, 5)).toBe(1);
    expect(usdToBrlCents(1, 5.5)).toBe(550);
    expect(usdToBrlCents(0, 5.5)).toBe(0);
  });
});

describe("classifyUsage", () => {
  it("ausência total de usage é MISSING — não é consumo zero", () => {
    expect(classifyUsage(null).kind).toBe("MISSING");
    expect(classifyUsage(undefined).kind).toBe("MISSING");
    expect(classifyUsage({}).kind).toBe("MISSING");
  });

  it("input e output ambos ausentes é MISSING mesmo com objeto presente", () => {
    expect(classifyUsage({ cache_read_tokens: 10 }).kind).toBe("MISSING");
  });

  it("normaliza campos faltantes para zero quando há sinal de consumo", () => {
    const c = classifyUsage({ input_tokens: 100 });
    expect(c.kind).toBe("USABLE");
    if (c.kind !== "USABLE") return;
    expect(c.usage).toEqual({
      input_tokens: 100,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      reasoning_tokens: 0,
    });
  });

  it("valores negativos ou não numéricos são tratados como zero", () => {
    const c = classifyUsage({ input_tokens: 5, output_tokens: -3, reasoning_tokens: "x" });
    expect(c.kind).toBe("USABLE");
    if (c.kind !== "USABLE") return;
    expect(c.usage.output_tokens).toBe(0);
    expect(c.usage.reasoning_tokens).toBe(0);
  });
});
