import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AgentDeadlineError,
  isAgentDeadlineError,
  mayStartAnotherRound,
} from "../../supabase/functions/_shared/agent-deadline-core";

/**
 * O deadline SUAVE do loop do agente, dos dois lados.
 *
 * A metade EXERCITADA está no núcleo puro: a pergunta que os três runners fazem
 * e a marca que eles lançam. A metade LIDA está em `ai-providers.ts`, que o
 * vitest não importa (`https://esm.sh/@anthropic-ai/sdk`) — ali só dá para
 * conferir que os runners perguntam ao núcleo em vez de reescrever a condição.
 *
 * `resolve(__dirname, ...)`, não `new URL(..., import.meta.url)`: a configuração
 * de teste deste repo não entrega `import.meta.url` como URL `file:`.
 */
const PROVIDERS = readFileSync(
  resolve(__dirname, "../../supabase/functions/_shared/ai-providers.ts"),
  "utf8",
).replace(/\r\n/g, "\n");

/** Recorte de um runner: do cabeçalho até o `}` na coluna zero. */
function runnerBody(nome: string): string {
  const i = PROVIDERS.indexOf(`async function ${nome}(`);
  expect(i, `runner ${nome} não encontrado`).toBeGreaterThan(-1);
  const fim = PROVIDERS.indexOf("\n}\n", i);
  expect(fim, `runner ${nome} sem fronteira`).toBeGreaterThan(i);
  const corpo = PROVIDERS.slice(i, fim);
  // Controle do recorte: um corte que não acha a fronteira devolveria o arquivo
  // inteiro e TODAS as asserções abaixo passariam a medir os três juntos.
  expect(corpo.length).toBeLessThan(PROVIDERS.length * 0.6);
  return corpo;
}

const RUNNERS = ["runClaude", "runOpenAICompatible", "runGemini"] as const;

describe("mayStartAnotherRound — ausente tem de significar RODA", () => {
  // G4. `shouldContinue` é opcional, e quem não passa a opção (qualquer
  // consumidor de `ai-providers.ts` que não seja o `webhook-whatsapp`) precisa
  // rodar exatamente como roda hoje. "Opcional" sem este caso é "opcional até
  // alguém mexer".
  it("sem a opção, NENHUMA das rodadas do teto de laço é recusada", () => {
    // MAX_ITERATIONS é 12; o laço pergunta uma vez por rodada.
    for (let rodada = 1; rodada <= 12; rodada++) {
      expect(mayStartAnotherRound(undefined), `rodada ${rodada} recusada`).toBe(true);
    }
    // E a forma sem argumento nenhum, que é como o `opts.shouldContinue`
    // ausente chega aqui.
    expect(mayStartAnotherRound()).toBe(true);
  });

  it("controle positivo: a forma tentadora recusaria TODAS elas", () => {
    // `!opts.shouldContinue?.()` é a reescrita que um lint de estilo sugere e
    // que ninguém releria: `undefined?.()` é `undefined`, `!undefined` é `true`,
    // e o agente morreria na primeira rodada de todo chamador sem a opção — sem
    // erro de tipo e sem aviso de lint. É por existir esta forma que a pergunta
    // foi extraída para um núcleo que o vitest alcança.
    const tentadora = (shouldContinue?: () => boolean) => !shouldContinue?.();
    expect(tentadora(undefined), "a forma tentadora deixou de recusar").toBe(true);
    expect(!mayStartAnotherRound(undefined)).toBe(false);
  });

  it("com a opção, só `false` EXPLÍCITO interrompe", () => {
    expect(mayStartAnotherRound(() => true)).toBe(true);
    expect(mayStartAnotherRound(() => false)).toBe(false);
  });

  it("predicado defeituoso falha ABERTO — o cliente sem resposta é o dano maior", () => {
    // Não é tolerância a qualquer coisa: é a polaridade oposta à do gate de
    // conexão. Aqui parar por engano cala o agente no meio de um atendimento.
    const quebrado = (() => undefined) as unknown as () => boolean;
    expect(mayStartAnotherRound(quebrado)).toBe(true);
  });

  it("predicado que LANÇA também falha aberto — e a exceção não escapa", () => {
    // Perna separada do caso acima, e não redundância: retorno estranho e
    // exceção saem por portas diferentes da função. Deixar a exceção subir seria
    // PIOR que continuar — ela viraria erro do agente SEM a marca de prazo, logo
    // elegível ao retry silencioso, transformando um bug de relógio em turno de
    // IA repetido, cobrado, com o cliente esperando o dobro. Sem este caso,
    // apagar o `try/catch` mantém a suíte verde.
    const explode = () => {
      throw new Error("relógio quebrado");
    };
    expect(() => mayStartAnotherRound(explode)).not.toThrow();
    expect(mayStartAnotherRound(explode)).toBe(true);
  });
});

describe("AgentDeadlineError — a marca é do objeto, nunca do texto", () => {
  // G1. O `catch` do webhook sanitiza o erro antes de qualquer coisa, e a
  // string resultante NÃO é "agent_deadline".
  it("o erro se reconhece por marca, não por comparação de string", () => {
    const err = new AgentDeadlineError("gemini", 7);
    expect(isAgentDeadlineError(err)).toBe(true);
    expect(err.provider).toBe("gemini");
    expect(err.iterationsLeft).toBe(7);
  });

  it("CONTROLE POSITIVO: a comparação que o brief propunha nunca casaria", () => {
    const err = new AgentDeadlineError("claude", 3);
    // Esta é a PRIMEIRA transformação de `sanitizeProviderError` — o caso abaixo
    // ("a premissa deste controle...") prende a fórmula ao arquivo real, para
    // que este número não seja uma lembrança.
    const comoOWebhookVeria = `${err.name}: ${err.message}`;
    expect(comoOWebhookVeria).toBe("AgentDeadlineError: agent_deadline");
    // Logo `agentError === "agent_deadline"` é SEMPRE falso, e o motivo do
    // handoff cairia em `agent_error` justamente quando quem interrompeu foi o
    // prazo. A marca, essa, casa.
    expect(comoOWebhookVeria === "agent_deadline").toBe(false);
    expect(isAgentDeadlineError(err)).toBe(true);
  });

  it("a premissa deste controle é o arquivo real, não uma lembrança", () => {
    expect(PROVIDERS).toContain("? `${err.name}: ${err.message}`");
  });

  it("erro comum do provedor NÃO é confundido com prazo, nem pelo texto", () => {
    // Inclusive um erro cuja mensagem é literalmente a palavra: quem decide é a
    // marca, e um provedor que devolvesse esse texto não pode forjar um prazo.
    expect(isAgentDeadlineError(new Error("agent_deadline"))).toBe(false);
    expect(isAgentDeadlineError(new Error("Gemini API error 503"))).toBe(false);
    expect(isAgentDeadlineError("agent_deadline")).toBe(false);
    expect(isAgentDeadlineError(null)).toBe(false);
    expect(isAgentDeadlineError(undefined)).toBe(false);
  });

  it("a marca sobrevive a um `instanceof` que falhe entre cópias do módulo", () => {
    // Duas cópias do mesmo arquivo carregadas por especificadores diferentes têm
    // protótipos diferentes, e aí `instanceof` devolve `false` em silêncio —
    // afirmando que o prazo não aconteceu. O campo é o que resta.
    const deOutraCopia = Object.assign(new Error("agent_deadline"), {
      isAgentDeadline: true,
    });
    expect(deOutraCopia instanceof AgentDeadlineError).toBe(false);
    expect(isAgentDeadlineError(deOutraCopia)).toBe(true);
  });
});

describe("os três runners perguntam ao núcleo, em vez de reescrever a condição", () => {
  it("cada runner chama mayStartAnotherRound(opts.shouldContinue)", () => {
    for (const runner of RUNNERS) {
      expect(runnerBody(runner), `${runner} não consulta o núcleo`).toContain(
        "mayStartAnotherRound(opts.shouldContinue)",
      );
    }
  });

  it("nenhum runner reescreve a pergunta à mão", () => {
    for (const runner of RUNNERS) {
      const corpo = runnerBody(runner);
      // A forma que recusa tudo quando a opção está ausente.
      expect(corpo, `${runner} usa a forma tentadora`).not.toMatch(
        /shouldContinue\?\.\(/,
      );
      // E a forma "equivalente" que dispensaria o núcleo — e com ele o único
      // teste que alcança esta decisão.
      expect(corpo, `${runner} reescreveu a condição à mão`).not.toMatch(
        /opts\.shouldContinue\s*&&\s*!opts\.shouldContinue\(\)/,
      );
    }
  });

  it("cada runner lança a MARCA, nunca um Error de texto", () => {
    for (const runner of RUNNERS) {
      const corpo = runnerBody(runner);
      expect(corpo, `${runner} não lança AgentDeadlineError`).toContain(
        "throw new AgentDeadlineError(",
      );
      expect(corpo, `${runner} voltou a lançar o prazo como texto`).not.toMatch(
        /throw new Error\(\s*["'`]agent_deadline/,
      );
    }
  });

  it("a pergunta vem ANTES da chamada ao provedor, senão a rodada já começou", () => {
    for (const runner of RUNNERS) {
      const corpo = runnerBody(runner);
      const pergunta = corpo.indexOf("mayStartAnotherRound");
      const chamada = corpo.indexOf("callWithBudget");
      expect(pergunta).toBeGreaterThan(-1);
      expect(chamada).toBeGreaterThan(-1);
      expect(pergunta, `${runner} pergunta depois de chamar o provedor`).toBeLessThan(chamada);
    }
  });

  it("a opção é OPCIONAL na interface — ausente é o caminho de hoje", () => {
    expect(PROVIDERS).toMatch(/shouldContinue\?:\s*\(\)\s*=>\s*boolean/);
  });

  it("a marca é reexportada por ai-providers.ts, que é de onde o webhook importa", () => {
    expect(PROVIDERS).toMatch(/export \{ AgentDeadlineError, isAgentDeadlineError \}/);
  });
});
