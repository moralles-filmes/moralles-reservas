/**
 * Núcleo PURO da decisão de provedor reserva do agente.
 *
 * POR QUE ESTE ARQUIVO EXISTE SEPARADO DE `ai-providers.ts`: aquele importa
 * `https://esm.sh/@anthropic-ai/sdk` e o vitest não o alcança. Decisão escrita
 * lá só é verificável por leitura. Aqui moram duas perguntas: "a configuração da
 * unidade declara um reserva utilizável?" e "este erro justifica trocar de
 * provedor?".
 *
 * O QUE NÃO MORA AQUI: a chave do reserva (`resolveApiKey`, BYOK da própria
 * unidade, sem fallback global) e o laço de retry. Quem decide QUANDO tentar é o
 * webhook; este arquivo só classifica.
 *
 * A união de providers é redeclarada (e não importada de `ai-providers.ts`),
 * pelo mesmo motivo de `agent-output-core.ts`: o `tsc -b` do app seguiria o tipo
 * até o import remoto do SDK. Os literais têm de acompanhar `AIProvider`.
 *
 * Sem I/O, sem `Deno`, sem cliente Supabase. Só decisão.
 */
import { isAgentTruncatedError } from "./agent-output-core.ts";
import { isAgentDeadlineError } from "./agent-deadline-core.ts";

type AIProvider = "claude" | "openai" | "gemini" | "grok" | "deepseek";

const KNOWN_PROVIDERS: readonly AIProvider[] = [
  "claude",
  "openai",
  "gemini",
  "grok",
  "deepseek",
];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Lê `ai_config.fallback` e devolve o reserva, ou `null`.
 *
 * POLARIDADE: config ilegível = SEM reserva = comportamento de hoje (retry no
 * principal). Nada aqui lança: `ai_config` é JSONB editável pela UI e um valor
 * torto não pode derrubar o turno do cliente.
 *
 * `model` ausente vale `""`: a UI grava `model?: string` e "Padrão" é a ausência
 * dele, não um formato inválido. O chamador resolve o default com
 * `resolveModel`. Já um `model` que existe e não é string (número, objeto) é
 * lixo e invalida o reserva inteiro.
 *
 * Reserva igual ao principal não é reserva: repetiria a mesma falha.
 */
export function parseFallbackConfig(
  aiConfig: unknown,
  primary: AIProvider,
): { provider: AIProvider; model: string } | null {
  if (!isPlainObject(aiConfig)) return null;
  const fb = aiConfig.fallback;
  if (!isPlainObject(fb)) return null;

  const provider = fb.provider;
  if (typeof provider !== "string") return null;
  if (!(KNOWN_PROVIDERS as readonly string[]).includes(provider)) return null;
  if (provider === primary) return null;

  const rawModel = fb.model;
  if (rawModel !== undefined && typeof rawModel !== "string") return null;
  const model: string = typeof rawModel === "string" ? rawModel : "";

  return { provider: provider as AIProvider, model };
}

/**
 * Este erro justifica tentar OUTRO provedor?
 *
 * Só indisponibilidade do provedor justifica. Não justificam:
 *  - `AgentTruncatedError`: o modelo respondeu, só que cortado; outro provedor
 *    não é a cura e a resposta cortada nunca é enviada.
 *  - `AgentDeadlineError`: o tempo do turno acabou; o reserva nasceria sem prazo.
 *  - `api_key_not_configured:*`: falta chave da unidade para ESTE provedor;
 *    configuração, não instabilidade.
 *
 * Com `status` numérico (anexado pelos runners): 5xx e 429 (inclui o 529 de
 * sobrecarga da Anthropic) são do provedor; 4xx restante (400/401/404...) é
 * pedido ou credencial errada e o reserva falharia igual.
 *
 * Sem `status` (rede, timeout, abort) = `true`: não chegou resposta, logo nada
 * indica erro nosso. Vale também para `null`/string/objeto solto, e a função
 * nunca lança.
 */
export function shouldUseFallbackProvider(err: unknown): boolean {
  if (isAgentTruncatedError(err)) return false;
  if (isAgentDeadlineError(err)) return false;

  if (err && typeof err === "object") {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message.startsWith("api_key_not_configured:")) {
      return false;
    }
    const status = (err as { status?: unknown }).status;
    if (typeof status === "number" && Number.isFinite(status)) {
      return status >= 500 || status === 429;
    }
  }
  return true;
}
