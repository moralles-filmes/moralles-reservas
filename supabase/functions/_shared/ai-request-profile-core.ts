/**
 * Núcleo PURO dos perfis de requisição: o que o runner manda ao provider por
 * família de modelo (limite de saída, controle de raciocínio).
 *
 * POR QUE ESTE ARQUIVO EXISTE SEPARADO DE `ai-providers.ts`: aquele importa
 * `https://esm.sh/@anthropic-ai/sdk` e o vitest não o alcança. O contrato do
 * corpo por família vive aqui e é testado em
 * `src/lib/ai-request-profile-core.test.ts`; um guard estático em
 * `src/lib/ai-model-catalog-wiring.test.ts` prova que o runner manda o que este
 * núcleo devolve e não monta limite nem raciocínio por conta própria.
 *
 * O perfil de cada modelo é declarado no catálogo (`ai-model-catalog.ts`); os
 * valores vêm da evidência oficial do plano §8.1 (2026-10-20). Modelo novo de
 * família nova = perfil novo aqui + contrato no teste.
 *
 * O raciocínio CONSOME o limite de saída em todas as famílias que o têm (Gemini,
 * Claude, OpenAI, Grok, DeepSeek). Por isso o limite fica em 3072 quando o
 * perfil raciocina e em 1024 quando o perfil desliga o raciocínio. Nenhum perfil
 * passa de `AI_ESTIMATE_OUTPUT_TOKENS` (ai-budget-core.ts); o teste gêmeo amarra.
 *
 * Sem I/O, sem `Deno`, sem cliente Supabase. Só decisão.
 */
import type { AIRequestProfile } from "./ai-model-catalog.ts";

/**
 * Orçamento de raciocínio do Gemini 2.5. Valor ÚNICO porque o corpo é montado
 * uma vez por iteração e reaproveitado no fallback Flash→Pro: 1024 é válido nos
 * dois (Flash aceita 0–24576; Pro exige >= 128 e não desliga).
 */
export const GEMINI_THINKING_BUDGET = 1024;

const LIMIT_THINKING_OFF = 1024;
const LIMIT_WITH_REASONING = 3072;

export type GeminiThinkingConfig =
  | { thinkingBudget: number }
  | { thinkingLevel: "minimal" | "low" };

export type AIRequestParams =
  | {
      wire: "gemini";
      generationConfig: { maxOutputTokens: number; thinkingConfig: GeminiThinkingConfig };
    }
  | {
      wire: "claude";
      body: { max_tokens: number; thinking: { type: "disabled" } | { type: "between_tools" } };
    }
  | {
      wire: "openai";
      body: {
        max_completion_tokens?: number;
        max_tokens?: number;
        reasoning_effort?: "none" | "low";
        thinking?: { type: "disabled" };
      };
    };

type ActiveProfile = Exclude<AIRequestProfile, "retired">;

/** Perfis que o runner sabe montar. O teste exige que seja o conjunto do catálogo. */
export const ACTIVE_REQUEST_PROFILES: readonly ActiveProfile[] = [
  "gemini-2.5",
  "gemini-3-low",
  "gemini-3-minimal",
  "claude-haiku-5",
  "claude-sonnet-5",
  "openai-gpt6-tools",
  "openai-gpt5-reasoning-low",
  "grok-4-non-reasoning",
  "grok-4-reasoning",
  "deepseek-v4-thinking-off",
];

/**
 * Os campos que o runner manda para este perfil. Objeto NOVO a cada chamada:
 * o runner pode anexar ao corpo sem contaminar o turno seguinte.
 *
 * `retired` lança: modelo aposentado nunca chega ao runner, porque
 * `resolveModel` o troca pelo sucessor antes do turno.
 */
export function requestParamsFor(profile: AIRequestProfile): AIRequestParams {
  switch (profile) {
    case "gemini-2.5":
      // O raciocínio do 2.5 consome o MESMO maxOutputTokens: com 1024 o modelo
      // podia gastar quase tudo pensando e devolver meia frase (MAX_TOKENS).
      return {
        wire: "gemini",
        generationConfig: {
          maxOutputTokens: LIMIT_WITH_REASONING,
          thinkingConfig: { thinkingBudget: GEMINI_THINKING_BUDGET },
        },
      };
    case "gemini-3-low":
      // 3.x: `thinkingLevel` (o `thinkingBudget` é do 2.5). O 3.8 Flash não
      // desliga o raciocínio; "low" é o menor nível.
      return {
        wire: "gemini",
        generationConfig: { maxOutputTokens: LIMIT_WITH_REASONING, thinkingConfig: { thinkingLevel: "low" } },
      };
    case "gemini-3-minimal":
      return {
        wire: "gemini",
        generationConfig: { maxOutputTokens: LIMIT_WITH_REASONING, thinkingConfig: { thinkingLevel: "minimal" } },
      };
    case "claude-haiku-5":
      // Haiku 5.5 pensa por padrão e `max_tokens` cobre pensamento + texto.
      // `disabled` é aceito com o esforço padrão (medium).
      return { wire: "claude", body: { max_tokens: LIMIT_THINKING_OFF, thinking: { type: "disabled" } } };
    case "claude-sonnet-5":
      // Sonnet 5.5 rejeita `disabled` com 400; `between_tools` é o menor nível
      // (sem raciocínio estendido) e não aceita outro campo dentro de `thinking`.
      return { wire: "claude", body: { max_tokens: LIMIT_THINKING_OFF, thinking: { type: "between_tools" } } };
    case "openai-gpt6-tools":
      // "Chat Completions supports function calling only with `reasoning_effort`
      // set to `none`" (doc do gpt-6-luna). `max_tokens` está deprecado.
      return { wire: "openai", body: { max_completion_tokens: LIMIT_THINKING_OFF, reasoning_effort: "none" } };
    case "openai-gpt5-reasoning-low":
      return { wire: "openai", body: { max_completion_tokens: LIMIT_WITH_REASONING, reasoning_effort: "low" } };
    case "grok-4-non-reasoning":
      return { wire: "openai", body: { max_completion_tokens: LIMIT_THINKING_OFF } };
    case "grok-4-reasoning":
      // Raciocina em "low" por padrão. Nenhum parâmetro de esforço é mandado:
      // o nome dele no Chat Completions da xAI não foi confirmado na doc.
      return { wire: "openai", body: { max_completion_tokens: LIMIT_WITH_REASONING } };
    case "deepseek-v4-thinking-off":
      // Thinking vem ligado por padrão; a doc da DeepSeek usa `max_tokens`.
      return { wire: "openai", body: { max_tokens: LIMIT_THINKING_OFF, thinking: { type: "disabled" } } };
    case "retired":
      throw new Error("request_profile_retired: modelo aposentado não chega ao runner");
    default: {
      const never: never = profile;
      throw new Error(`request_profile_unknown: ${String(never)}`);
    }
  }
}

/** O limite de saída que vai no corpo do perfil (fonte do teste gêmeo da franquia). */
export function maxOutputTokensFor(profile: AIRequestProfile): number {
  const p = requestParamsFor(profile);
  if (p.wire === "gemini") return p.generationConfig.maxOutputTokens;
  if (p.wire === "claude") return p.body.max_tokens;
  return p.body.max_completion_tokens ?? p.body.max_tokens ?? LIMIT_THINKING_OFF;
}
