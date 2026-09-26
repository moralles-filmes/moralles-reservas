/**
 * Núcleo PURO do deadline SUAVE do loop do agente (Fase C).
 *
 * POR QUE ESTE ARQUIVO EXISTE SEPARADO DE `ai-providers.ts`: aquele importa
 * `https://esm.sh/@anthropic-ai/sdk` e o vitest não o alcança. Regra de decisão
 * escrita lá só é verificável por LEITURA — e leitura já deixou passar um
 * `ReferenceError` no caminho de autorização e um conflito FK × CHECK por duas
 * auditorias neste repo. É a mesma razão, palavra por palavra, que
 * `ai-call-authorizer-core.ts` declara no próprio cabeçalho.
 *
 * O QUE NÃO MORA AQUI: a POLÍTICA do prazo. Quanto tempo o turno tem e quando
 * ele venceu é `agentDeadlineVerdict` / `AGENT_SOFT_DEADLINE_MS`, em
 * `whatsapp-inbound-queue-core.ts`, e quem consulta é o webhook — o loop não
 * conhece relógio nenhum. O que mora aqui é o que o LOOP precisa: como
 * PERGUNTAR se pode começar outra rodada, e como DIZER que parou por prazo de um
 * jeito que o chamador consiga ler sem depender de texto de erro.
 *
 * Sem I/O, sem `Deno`, sem cliente Supabase. Só decisão.
 */

/**
 * "Parei porque o prazo acabou" é uma marca de OBJETO, nunca de texto.
 *
 * O `catch` do webhook faz `sanitizeProviderError(err)`, que devolve
 * `` `${err.name}: ${err.message}` `` e ainda passa por redação de credencial e
 * `slice(0, 300)`. Logo `agentError === "agent_deadline"` NUNCA casa — o valor
 * real começa em `"AgentDeadlineError: "` — e o motivo do handoff cairia sempre
 * em `agent_error`, apagando o deadline exatamente onde ele precisa ser lido: na
 * investigação de "por que esta conversa foi para atendimento humano".
 *
 * E a correção óbvia (`agentError.includes("agent_deadline")`) é pior que o
 * defeito: amarra uma decisão à FORMA de um texto que outra regra — a redação de
 * credencial, o corte em 300 — pode reescrever sem que nada fique vermelho. Este
 * repo já se queimou assim.
 */
export class AgentDeadlineError extends Error {
  /**
   * Marca de DADO, ao lado do `instanceof`, e não em vez dele.
   *
   * `instanceof` exige que quem lança e quem verifica enxerguem a MESMA
   * instância do módulo. Duas cópias carregadas por especificadores diferentes
   * têm protótipos diferentes, e aí a checagem devolve `false` em silêncio — ou
   * seja, afirma que o deadline não aconteceu, que é precisamente o defeito que
   * esta classe existe para impedir.
   */
  readonly isAgentDeadline = true;
  /** Provedor do turno interrompido. Diagnóstico; nada decide a partir dele. */
  readonly provider: string;
  /** Quantas rodadas do teto de laço ainda restavam quando o prazo venceu. */
  readonly iterationsLeft: number;

  constructor(provider: string, iterationsLeft: number) {
    // Mensagem CURTA e estável: depois de sanitizada ela vira
    // `webhook_executions.error` e `processed_messages`, e é lida por gente.
    super("agent_deadline");
    this.name = "AgentDeadlineError";
    this.provider = provider;
    this.iterationsLeft = iterationsLeft;
    // `extends Error` compilado para alvo antigo perde o protótipo e quebra o
    // `instanceof` sem erro nenhum. Uma linha para não depender do alvo.
    Object.setPrototypeOf(this, AgentDeadlineError.prototype);
  }
}

/** A pergunta que o chamador faz ANTES de sanitizar — nunca depois. */
export function isAgentDeadlineError(err: unknown): boolean {
  if (err instanceof AgentDeadlineError) return true;
  if (!err || typeof err !== "object") return false;
  return (err as { isAgentDeadline?: unknown }).isAgentDeadline === true;
}

/**
 * Pode COMEÇAR mais uma rodada de ferramenta?
 *
 * AUSENTE = "pode", e isso é o contrato, não uma conveniência: quem não passa a
 * opção — hoje, qualquer consumidor de `ai-providers.ts` que não seja o
 * `webhook-whatsapp` — tem de rodar byte a byte como roda hoje.
 *
 * A pergunta mora aqui, e não como expressão repetida nos três runners, porque a
 * forma tentadora de escrevê-la diz o OPOSTO: `!opts.shouldContinue?.()` avalia
 * `undefined?.()` → `undefined`, `!undefined` → `true`, e TODA rodada de TODO
 * chamador sem a opção seria recusada — o agente morreria no primeiro turno, sem
 * erro de tipo e sem aviso de lint. Um runner é inalcançável pelo vitest; esta
 * função não é.
 *
 * Só `false` EXPLÍCITO interrompe. Um predicado que devolva qualquer outra coisa
 * é defeito de quem o escreveu, e a polaridade segura para defeito é continuar:
 * o custo de não parar é um turno mais longo, o de parar por engano é o cliente
 * sem resposta.
 */
export function mayStartAnotherRound(shouldContinue?: () => boolean): boolean {
  if (typeof shouldContinue !== "function") return true;
  return shouldContinue() !== false;
}
