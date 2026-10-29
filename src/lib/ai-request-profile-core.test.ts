import { describe, expect, it } from "vitest";
import {
  ACTIVE_REQUEST_PROFILES,
  GEMINI_THINKING_BUDGET,
  maxOutputTokensFor,
  requestParamsFor,
  type AIRequestParams,
} from "../../supabase/functions/_shared/ai-request-profile-core";
import { AI_MODEL_CATALOG, getModelEntry } from "../../supabase/functions/_shared/ai-model-catalog";
import { AI_ESTIMATE_OUTPUT_TOKENS } from "../../supabase/functions/_shared/ai-budget-core";

/**
 * Contrato do corpo da requisição por família (spec §7.4, plano §0.4 e §8.1).
 * O vitest não importa `ai-providers.ts` (SDK via esm.sh), então o contrato é
 * do núcleo puro, e um guard estático em `ai-model-catalog-wiring.test.ts`
 * prende o runner a mandar o que o núcleo devolve.
 */

function paramsOf(provider: Parameters<typeof getModelEntry>[0], id: string): AIRequestParams {
  const entry = getModelEntry(provider, id);
  if (!entry) throw new Error(`modelo fora do catálogo: ${provider}/${id}`);
  return requestParamsFor(entry.requestProfile);
}

/** Todas as chaves do corpo, em qualquer profundidade, para checar proibidos. */
function deepKeys(v: unknown, out: string[] = []): string[] {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      deepKeys(x, out);
    }
  }
  return out;
}

describe("Gemini", () => {
  it("2.5 (Flash e Pro): 3072 + thinkingBudget 1024, IGUAL a hoje — as lojas não mudam", () => {
    for (const id of ["gemini-2.5-flash", "gemini-2.5-pro"]) {
      expect(paramsOf("gemini", id)).toEqual({
        wire: "gemini",
        generationConfig: { maxOutputTokens: 3072, thinkingConfig: { thinkingBudget: 1024 } },
      });
    }
    expect(GEMINI_THINKING_BUDGET).toBe(1024);
  });

  it("3.x usa thinkingLevel, nunca thinkingBudget (o 2.5 rejeita thinkingLevel e vice-versa)", () => {
    expect(paramsOf("gemini", "gemini-3.8-flash")).toEqual({
      wire: "gemini",
      generationConfig: { maxOutputTokens: 3072, thinkingConfig: { thinkingLevel: "low" } },
    });
    expect(paramsOf("gemini", "gemini-3.5-flash-lite")).toEqual({
      wire: "gemini",
      generationConfig: { maxOutputTokens: 3072, thinkingConfig: { thinkingLevel: "minimal" } },
    });
  });

  it("o fallback same-provider reaproveita o corpo: o perfil do fallback é o do principal", () => {
    // `runGemini` monta o corpo uma vez por iteração e o reusa na tentativa do
    // fallback. Fallback com outro perfil mandaria parâmetro do modelo errado.
    const pairs = AI_MODEL_CATALOG.filter((e) => e.sameProviderFallback);
    expect(pairs.length).toBeGreaterThan(0);
    for (const e of pairs) {
      const fb = getModelEntry(e.provider, e.sameProviderFallback as string);
      expect(fb?.requestProfile, `${e.id} → ${e.sameProviderFallback}`).toBe(e.requestProfile);
    }
  });
});

describe("Claude 5.5", () => {
  it("Haiku 5.5 pensa por padrão e o limite cobre pensamento + texto: o perfil desliga", () => {
    expect(paramsOf("claude", "claude-haiku-5-5")).toEqual({
      wire: "claude",
      body: { max_tokens: 1024, thinking: { type: "disabled" } },
    });
  });

  it("Sonnet 5.5 rejeita `disabled` (400): o mínimo é `between_tools`, sem outro campo", () => {
    expect(paramsOf("claude", "claude-sonnet-5-5")).toEqual({
      wire: "claude",
      body: { max_tokens: 1024, thinking: { type: "between_tools" } },
    });
  });

  it("Claude 4.x legado só existe como sucessor resolvido: o perfil não é alcançável", () => {
    for (const id of ["claude-haiku-4-5", "claude-sonnet-4-6"]) {
      const entry = getModelEntry("claude", id);
      expect(entry?.status).toBe("retired");
      expect(() => requestParamsFor(entry!.requestProfile)).toThrow(/retired/);
    }
  });
});

describe("OpenAI-compatível (OpenAI, Grok, DeepSeek)", () => {
  it("GPT-6 Luna: max_completion_tokens + reasoning_effort none (ferramentas no Chat Completions exigem none)", () => {
    expect(paramsOf("openai", "gpt-6-luna")).toEqual({
      wire: "openai",
      body: { max_completion_tokens: 1024, reasoning_effort: "none" },
    });
  });

  it("GPT-5.6 Sol: raciocínio low conta no limite, então o limite sobe para 3072", () => {
    expect(paramsOf("openai", "gpt-5.6-sol")).toEqual({
      wire: "openai",
      body: { max_completion_tokens: 3072, reasoning_effort: "low" },
    });
  });

  it("Grok 4.x: max_completion_tokens (max_tokens deprecado); 4.3 raciocina por padrão", () => {
    expect(paramsOf("grok", "grok-4.20-0309-non-reasoning")).toEqual({
      wire: "openai",
      body: { max_completion_tokens: 1024 },
    });
    expect(paramsOf("grok", "grok-4.3")).toEqual({
      wire: "openai",
      body: { max_completion_tokens: 3072 },
    });
  });

  it("DeepSeek Flash: thinking ligado por padrão, o perfil desliga; o parâmetro lá é max_tokens", () => {
    expect(paramsOf("deepseek", "deepseek-flash")).toEqual({
      wire: "openai",
      body: { max_tokens: 1024, thinking: { type: "disabled" } },
    });
  });
});

describe("todo perfil ativo", () => {
  const activeProfiles = [
    ...new Set(AI_MODEL_CATALOG.filter((e) => e.status === "active").map((e) => e.requestProfile)),
  ];

  it("a lista de perfis ativos do núcleo é a do catálogo — perfil novo exige contrato aqui", () => {
    expect([...ACTIVE_REQUEST_PROFILES].sort()).toEqual([...activeProfiles].sort());
  });

  it("nunca manda parâmetro proibido ou de amostragem", () => {
    for (const p of activeProfiles) {
      const keys = deepKeys(requestParamsFor(p));
      for (const proibido of ["temperature", "top_p", "top_k", "budget_tokens", "presence_penalty", "frequency_penalty", "stop"]) {
        expect(keys, `${p} manda ${proibido}`).not.toContain(proibido);
      }
    }
  });

  it("OpenAI e Grok usam max_completion_tokens; max_tokens só onde o provider o documenta", () => {
    for (const e of AI_MODEL_CATALOG.filter((x) => x.status === "active")) {
      const params = requestParamsFor(e.requestProfile);
      if (params.wire !== "openai") continue;
      const keys = Object.keys(params.body);
      if (e.provider === "deepseek") {
        expect(keys, e.id).toContain("max_tokens");
      } else {
        expect(keys, e.id).toContain("max_completion_tokens");
        expect(keys, e.id).not.toContain("max_tokens");
      }
    }
  });

  it("onde o raciocínio consome o limite, sobram pelo menos 1024 tokens de resposta útil", () => {
    // Lição do MAX_TOKENS do Gemini 2.5. Raciocínio por nível não tem teto
    // declarado: conta-se um teto presumido de 2048, e o limite tem de cobrir.
    const PRESUMED_LEVEL_REASONING = 2048;
    for (const e of AI_MODEL_CATALOG.filter((x) => x.status === "active")) {
      const limit = maxOutputTokensFor(e.requestProfile);
      const reasoning =
        e.capabilities.reasoning === "budget"
          ? GEMINI_THINKING_BUDGET
          : e.requestProfile === "gemini-3-low" ||
              e.requestProfile === "gemini-3-minimal" ||
              e.requestProfile === "openai-gpt5-reasoning-low" ||
              e.requestProfile === "grok-4-reasoning"
            ? PRESUMED_LEVEL_REASONING
            : 0;
      expect(limit - reasoning, `${e.id}: limite ${limit}, raciocínio ${reasoning}`).toBeGreaterThanOrEqual(1024);
    }
  });

  it("a estimativa da franquia cobre o maior limite de todos os perfis (gêmeo de ai-budget-core)", () => {
    const maior = Math.max(...activeProfiles.map((p) => maxOutputTokensFor(p)));
    expect(AI_ESTIMATE_OUTPUT_TOKENS).toBeGreaterThanOrEqual(maior);
  });

  it("CONTROLE POSITIVO: um perfil acima da estimativa reprova o gêmeo", () => {
    const limites = [...activeProfiles.map((p) => maxOutputTokensFor(p)), AI_ESTIMATE_OUTPUT_TOKENS + 1];
    expect(AI_ESTIMATE_OUTPUT_TOKENS >= Math.max(...limites)).toBe(false);
  });

  it("maxOutputTokensFor lê o mesmo número que vai no corpo", () => {
    for (const p of activeProfiles) {
      const params = requestParamsFor(p);
      const noCorpo =
        params.wire === "gemini"
          ? params.generationConfig.maxOutputTokens
          : params.wire === "claude"
            ? params.body.max_tokens
            : (params.body.max_completion_tokens ?? params.body.max_tokens);
      expect(maxOutputTokensFor(p), p).toBe(noCorpo);
    }
  });

  it("devolve objeto novo a cada chamada — o runner pode mutar sem contaminar o próximo turno", () => {
    const a = requestParamsFor("gemini-2.5");
    const b = requestParamsFor("gemini-2.5");
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    if (a.wire === "gemini" && b.wire === "gemini") {
      expect(a.generationConfig).not.toBe(b.generationConfig);
      expect(a.generationConfig.thinkingConfig).not.toBe(b.generationConfig.thinkingConfig);
    }
  });
});
