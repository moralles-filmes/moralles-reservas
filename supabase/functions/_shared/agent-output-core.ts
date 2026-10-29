/**
 * Núcleo PURO da detecção de resposta cortada pelo limite de saída.
 *
 * POR QUE ESTE ARQUIVO EXISTE SEPARADO DE `ai-providers.ts`: aquele importa
 * `https://esm.sh/@anthropic-ai/sdk` e o vitest não o alcança. Decisão escrita
 * lá só é verificável por leitura. Aqui mora a pergunta "este motivo de parada é
 * um corte?". O limite de saída e o raciocínio por família moram em
 * `ai-request-profile-core.ts` (perfil declarado no catálogo de modelos).
 *
 * A união de providers é redeclarada aqui (e não importada com `import type` de
 * `ai-providers.ts`): o vitest até apaga o import, mas o `tsc -b` do app segue
 * o tipo até o módulo e quebra no import remoto do SDK. Os literais têm de
 * acompanhar `AIProvider` de `ai-model-catalog.ts`.
 *
 * Sem I/O, sem `Deno`, sem cliente Supabase. Só decisão.
 */
type AIProvider = "claude" | "openai" | "gemini" | "grok" | "deepseek";

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
