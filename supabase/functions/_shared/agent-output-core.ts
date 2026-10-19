/**
 * Núcleo PURO do limite de saída do agente e da detecção de resposta cortada.
 *
 * POR QUE ESTE ARQUIVO EXISTE SEPARADO DE `ai-providers.ts`: aquele importa
 * `https://esm.sh/@anthropic-ai/sdk` e o vitest não o alcança. Decisão escrita
 * lá só é verificável por leitura. Aqui moram o limite por provider, o orçamento
 * de raciocínio do Gemini e a pergunta "este motivo de parada é um corte?".
 *
 * A união de providers é redeclarada aqui (e não importada com `import type` de
 * `ai-providers.ts`): o vitest até apaga o import, mas o `tsc -b` do app segue
 * o tipo até o módulo e quebra no import remoto do SDK. Os literais têm de
 * acompanhar `AIProvider`; o `Record<AIProvider, number>` em `ai-providers.ts`
 * (índice por `opts.provider`) deixa o `deno check` vermelho se divergirem.
 *
 * Sem I/O, sem `Deno`, sem cliente Supabase. Só decisão.
 */
type AIProvider = "claude" | "openai" | "gemini" | "grok" | "deepseek";

/**
 * Teto de tokens de SAÍDA por chamada, por provider.
 *
 * Gemini 2.5 conta o raciocínio interno (`thoughtsTokenCount`) no MESMO
 * `maxOutputTokens`: com 1024 o modelo podia gastar quase tudo pensando e
 * devolver meia frase com `finishReason: MAX_TOKENS`. Por isso 3072 + um
 * `thinkingBudget` limitado (abaixo) — sobram ~2000 tokens para a resposta.
 *
 * `AI_ESTIMATE_OUTPUT_TOKENS` (ai-budget-core.ts) tem de ser >= o maior valor
 * daqui, senão a reserva de franquia subestima a chamada. O teste gêmeo em
 * `src/lib/agent-output-core.test.ts` amarra os dois.
 */
export const MAX_OUTPUT_TOKENS_BY_PROVIDER: Record<AIProvider, number> = {
  gemini: 3072,
  claude: 1024,
  openai: 1024,
  grok: 1024,
  deepseek: 1024,
};

/**
 * Orçamento de raciocínio do Gemini. Valor ÚNICO porque o corpo da requisição
 * é montado uma vez por iteração e reaproveitado no fallback Flash→Pro: 1024 é
 * válido nos dois (Flash aceita 0–24576; Pro exige >= 128 e não desliga).
 */
export const GEMINI_THINKING_BUDGET = 1024;

export function geminiThinkingConfig(_model: string): { thinkingBudget: number } {
  return { thinkingBudget: GEMINI_THINKING_BUDGET };
}

/**
 * O motivo de parada indica que a resposta foi cortada pelo limite de saída?
 * Só os motivos de corte; qualquer outro (inclusive `undefined`, SAFETY,
 * `refusal`, `pause_turn`) mantém o comportamento anterior.
 */
export function isTruncatedStop(provider: AIProvider, reason: unknown): boolean {
  if (typeof reason !== "string") return false;
  switch (provider) {
    case "gemini":
      return reason === "MAX_TOKENS";
    case "claude":
      return reason === "max_tokens";
    case "openai":
    case "grok":
    case "deepseek":
      return reason === "length";
    default:
      return false;
  }
}

/**
 * "A resposta veio cortada" é uma marca de OBJETO, nunca de texto — mesmo
 * motivo de `AgentDeadlineError`: o `catch` do webhook sanitiza a mensagem, e
 * uma decisão amarrada ao texto quebra em silêncio.
 */
export class AgentTruncatedError extends Error {
  /** Marca de DADO ao lado do `instanceof` (duas cópias do módulo = dois protótipos). */
  readonly isAgentTruncated = true;
  readonly provider: string;
  readonly model: string;
  readonly reason: string;

  constructor(provider: string, model: string, reason: string) {
    // Mensagem curta e estável: vira `webhook_executions.error` e é lida por gente.
    super("agent_truncated");
    this.name = "AgentTruncatedError";
    this.provider = provider;
    this.model = model;
    this.reason = reason;
    Object.setPrototypeOf(this, AgentTruncatedError.prototype);
  }
}

export function isAgentTruncatedError(err: unknown): boolean {
  if (err instanceof AgentTruncatedError) return true;
  if (!err || typeof err !== "object") return false;
  return (err as { isAgentTruncated?: unknown }).isAgentTruncated === true;
}
