import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  INBOUND_LEASE_TTL_MS,
  INBOUND_ERROR_TEXT_MAX,
  lockTtlSecondsRequired,
  sanitizeQueueErrorText,
} from "../../supabase/functions/_shared/whatsapp-inbound-queue-core";

/**
 * Testes de ACOPLAMENTO da re-entrada a partir da fila.
 *
 * Eles leem FONTE, o que é um instrumento grosseiro — e é o único disponível
 * aqui: o `index.ts` do `webhook-whatsapp` chama `serve()` no carregamento e
 * importa `deno.land`, então o vitest não o importa, e a migration é SQL que
 * nenhum runtime de teste deste repo executa. Regra que só se confere por leitura
 * humana já deixou passar defeito duas vezes neste repo (o `ReferenceError` no
 * caminho de autorização do worker de ciclos, e o conflito FK × CHECK da 089).
 */

// `resolve(__dirname, ...)`, não `new URL(..., import.meta.url)`: a configuração
// de teste deste repo não entrega `import.meta.url` como URL `file:`, e a segunda
// forma estoura "The URL must be of scheme file". É a convenção dos outros testes
// de acoplamento daqui (ver `datafy-adapter-coupling-guard.test.ts`).
const EF = readFileSync(
  resolve(__dirname, "../../supabase/functions/webhook-whatsapp/index.ts"),
  "utf8",
);

const MIGRATION_113 = readFileSync(
  resolve(
    __dirname,
    "../../supabase/migrations/20260924120200_113_inbound_claim_rpc.sql",
  ),
  "utf8",
);

describe("anti-laço: a re-entrada não pode reinserir o evento", () => {
  // O dano não é simétrico entre providers, e é isso que faz este teste valer.
  // Numa entrega Datafy o `delivery_id` existe e o unique parcial da 111 pararia
  // o laço no segundo insert (23505). Nos QUATRO providers legados o
  // `delivery_id` é NULL, e NULL é distinto de NULL em índice unique: cada
  // re-entrada inseriria uma linha NOVA e despacharia OUTRO `waitUntil`. O laço
  // cresce, e Z-API e UazAPI estão em produção com loja real.
  it("processQueuedEventById re-entra com source: \"queue\"", () => {
    expect(EF).toMatch(/source:\s*"queue"/);
  });

  it("a decisão de persistir vem do núcleo, não de um if solto no handler", () => {
    expect(EF).toMatch(/decideIngestionMode\(/);
    // Controle positivo: se alguém reimplementar a pergunta no handler, reprova.
    expect(EF).not.toMatch(/ingestionSource\s*===\s*"provider"\s*&&\s*[a-zA-Z]*[Ff]lag/);
  });

  it("o canal viaja na QUERYSTRING da re-entrada, nunca no corpo", () => {
    // É o que faz a guarda anti-cross-tenant do handler valer alguma coisa: ele
    // resolve o canal por `?channel=` + SELECT. Um dia em que a re-entrada
    // passasse o canal no corpo, a guarda passaria a comparar o payload consigo
    // mesmo.
    expect(EF).toMatch(/\?channel=\$\{row\.channel_id\}/);
  });

  it("o claim é o primeiro ato, e a finalização é cercada pelo claim_id", () => {
    const corpo = EF.slice(EF.indexOf("async function processQueuedEventById"));
    const claim = corpo.indexOf("claim_whatsapp_inbound_event");
    const reentrada = corpo.indexOf("handleWebhookRequest");
    expect(claim).toBeGreaterThan(-1);
    expect(reentrada).toBeGreaterThan(-1);
    // Reivindicar DEPOIS de re-entrar seria não reivindicar: duas execuções da
    // mesma linha são duas IAs respondendo ao mesmo cliente.
    expect(claim).toBeLessThan(reentrada);
    expect(EF).toMatch(/p_claim_id:\s*input\.claimId/);
  });
});

describe("gêmeos declarados: o número vive em dois lugares e nenhum importa o outro", () => {
  // O SQL não importa TypeScript. Sem este pino, `INBOUND_LEASE_TTL_MS` é um
  // export que NENHUM código de runtime consome — trocá-lo não quebraria nada, e
  // quatro lugares (migration, pré-voo 18, controles 19, README) afirmam que ele
  // está amarrado ao lease do banco. Afirmação sem mecanismo é comentário.
  // ESCOPADO AO CORPO DO CLAIM, e não ao arquivo. A Task 6 vai fazer APPEND
  // nesta mesma migration (seleção da varredura e purga), então um pino que só
  // perguntasse "o arquivo contém `secs => 90`?" passaria a poder ficar verde por
  // causa de outra função — inclusive com o lease do claim trocado. O pino tem de
  // olhar para a função cujo número ele prende.
  const CORPO_DO_CLAIM = (() => {
    const inicio = MIGRATION_113.indexOf(
      "create or replace function public.claim_whatsapp_inbound_event",
    );
    expect(inicio).toBeGreaterThan(-1);
    const fim = MIGRATION_113.indexOf("$$;", inicio);
    expect(fim).toBeGreaterThan(inicio);
    return MIGRATION_113.slice(inicio, fim);
  })();

  it("o lease do claim é exatamente INBOUND_LEASE_TTL_MS", () => {
    const segundos = INBOUND_LEASE_TTL_MS / 1000;
    expect(Number.isInteger(segundos)).toBe(true);
    expect(CORPO_DO_CLAIM).toContain(`make_interval(secs => ${segundos})`);
  });

  it("o corpo do claim monta UM intervalo só, para o pino não ter onde se esconder", () => {
    // Dois intervalos no mesmo corpo deixariam o pino verde com o lease errado,
    // bastando que o outro carregasse o número certo.
    const todos = CORPO_DO_CLAIM.match(/make_interval\(secs => \d+\)/g) ?? [];
    expect(todos).toHaveLength(1);
  });

  it("a migration nomeia o gêmeo, para quem lê o SQL primeiro", () => {
    expect(MIGRATION_113).toContain("INBOUND_LEASE_TTL_MS");
  });

  it("o backstop de last_error é MAIOR que o limite do adapter, não igual", () => {
    // Iguais convidariam a "unificar" e apagar a distinção entre o limite real
    // (que também remove o que o Postgres recusa) e a rede de segurança.
    const m = MIGRATION_113.match(/left\(p_error,\s*(\d+)\)/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(INBOUND_ERROR_TEXT_MAX);
  });
});

describe("sanitizeQueueErrorText — o que impede uma linha de ficar presa para sempre", () => {
  // Postgres recusa `\u0000` em `text` (22021). Como é a finalização quem escreve
  // `attempts` e `next_attempt_at`, uma finalização que falha SEMPRE deixa a linha
  // devida e reivindicável para sempre: retomada a cada 90 s, nunca virando dead
  // letter, e primeira na ordem da varredura — adiando o inbound dos outros
  // tenants.
  it("remove o octeto NUL, que o Postgres recusa em coluna text", () => {
    const saida = sanitizeQueueErrorText("falhou\u0000aqui");
    expect(saida).not.toContain("\u0000");
    expect(saida).toBe("falhou aqui");
  });

  it("remove todo controle C0/C1, não só o NUL", () => {
    const saida = sanitizeQueueErrorText("a\u0001b\u001fc\u007fd\u009fe");
    expect(saida).toBe("a b c d e");
  });

  it("normaliza para ESPAÇO em vez de apagar, para não fundir palavras", () => {
    // Descartar o separador funde o dado com o seguinte — o defeito que este repo
    // já pagou ao descartar `\n` de texto colado.
    expect(sanitizeQueueErrorText("erro\nno canal")).toBe("erro no canal");
    expect(sanitizeQueueErrorText("erro\tno canal")).toBe("erro no canal");
  });

  it("trunca no limite do adapter", () => {
    const saida = sanitizeQueueErrorText("x".repeat(INBOUND_ERROR_TEXT_MAX + 50));
    expect(saida).toHaveLength(INBOUND_ERROR_TEXT_MAX);
  });

  it("null/undefined/vazio viram null, nunca string vazia", () => {
    // String vazia gravaria `last_error = ''`, que se lê como "houve erro sem
    // mensagem" — diferente de "não houve erro".
    expect(sanitizeQueueErrorText(null)).toBeNull();
    expect(sanitizeQueueErrorText(undefined)).toBeNull();
    expect(sanitizeQueueErrorText("   ")).toBeNull();
    expect(sanitizeQueueErrorText("\u0000\u0000")).toBeNull();
  });

  it("texto normal atravessa intacto", () => {
    expect(sanitizeQueueErrorText("http_503")).toBe("http_503");
  });
});

describe("a finalização não pode deixar a linha sem contabilidade de tentativa", () => {
  it("há uma segunda tentativa SEM o texto do erro", () => {
    // Perder o texto do erro é barato; perder `attempts` e `next_attempt_at` põe a
    // linha em laço de 90 s para sempre. Se alguém remover este caminho, isto
    // reprova.
    expect(EF).toMatch(/queued_event_finalize_retry_without_error_text/);
    expect(EF).toMatch(/await call\(null\)/);
  });

  it("o texto que vai para a coluna passa pelo sanitizador, não pelo de log", () => {
    expect(EF).toMatch(/const errorText = sanitizeQueueErrorText\(input\.error\)/);
    // Controle positivo: entregar o texto cru à RPC reprova aqui.
    expect(EF).not.toMatch(/call\(input\.error\)/);
  });

  it("a decisão de retentar olha o texto SANITIZADO, não o cru", () => {
    // Se o sanitizador já devolveu `null`, a primeira chamada foi sem texto e a
    // segunda seria byte-idêntica — retentar o mesmo não é retentar.
    expect(EF).toMatch(/if \(error && errorText !== null\)/);
  });

  it("o log da cerca diz se houve retentativa, porque isso muda o que ele significa", () => {
    // Zero linhas depois de uma retentativa tem leitura OPOSTA à de zero linhas
    // sem ela: provavelmente a primeira chamada gravou e só a resposta se perdeu.
    expect(EF).toMatch(/evt: "queued_event_finalize_fenced"[\s\S]{0,200}retried:/);
  });

  it("a contagem de linhas afetadas é conferida antes de promover dead letter", () => {
    // `UPDATE` que casa zero linhas devolve `error: null` no supabase-js: sem
    // conferir, "a cerca negou" fica indistinguível de "gravei".
    const corpo = EF.slice(EF.indexOf("async function finalizeQueuedEvent"));
    const confere = corpo.indexOf("Number(data ?? 0) < 1");
    const promove = corpo.indexOf("promoteDeadLetterToHandoff");
    expect(confere).toBeGreaterThan(-1);
    expect(promove).toBeGreaterThan(confere);
  });
});

/**
 * O deadline SUAVE, do lado do webhook.
 *
 * O que é EXERCITÁVEL (a pergunta do laço, a marca do erro) mora em
 * `agent-deadline-core.test.ts`. Aqui ficam as três amarras que só existem no
 * `index.ts`: de que relógio o prazo é contado, que o retry silencioso NÃO o
 * engole, e que o motivo do handoff o distingue de um erro de provedor.
 */
const CONDICAO_DO_RETRY = (() => {
  const marco = EF.indexOf('evt: "agent_retry"');
  expect(marco, "o retry silencioso sumiu do webhook").toBeGreaterThan(-1);
  const abre = EF.lastIndexOf("if (", marco);
  expect(abre).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = EF.indexOf("(", abre); i < EF.length; i++) {
    if (EF[i] === "(") depth++;
    else if (EF[i] === ")") {
      depth--;
      if (depth === 0) return EF.slice(abre, i + 1);
    }
  }
  throw new Error("parênteses desbalanceados na condição do retry");
})();

describe("o relógio do prazo é o do PROCESSAMENTO, não o da requisição", () => {
  it("o deadline é perguntado ao núcleo, com processingStartedAt", () => {
    expect(EF).toMatch(
      /agentDeadlineVerdict\(\{\s*startedAt:\s*processingStartedAt/,
    );
    expect(EF).toMatch(/shouldContinue:\s*\(\)\s*=>/);
  });

  it("NÃO é `t0`, e o relógio nasce depois da janela de rajada", () => {
    // `t0` é o começo da REQUISIÇÃO: nele cabem resolução de canal, CRM e os 6 s
    // de debounce. Contar o prazo dali gastaria o orçamento antes de o agente
    // existir — e faria o deadline morder rodada que ele não deveria alcançar.
    expect(EF, "o prazo voltou a ser contado de t0").not.toMatch(
      /agentDeadlineVerdict\(\{\s*startedAt:\s*t0\b/,
    );
    const debounce = EF.indexOf("await sleep(DEBOUNCE_WINDOW_MS)");
    const relogio = EF.indexOf("const processingStartedAt = Date.now()");
    expect(debounce, "o debounce sumiu").toBeGreaterThan(-1);
    expect(relogio, "processingStartedAt não é declarado").toBeGreaterThan(-1);
    expect(relogio, "o relógio do prazo subiu para antes do debounce").toBeGreaterThan(debounce);
  });

  it("AI_LOCK_TTL_SECONDS cobre a aritmética declarada, em vez de ser adivinhado", () => {
    // O TTL foi dimensionado contra "~51 s de pior caso do runOnce" — que era o
    // pior caso de UM turno, não do laço. Agora ele responde à soma real:
    // orçamento + pior turno + envio.
    const m = EF.match(/AI_LOCK_TTL_SECONDS\s*=\s*(\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(lockTtlSecondsRequired());
  });
});

describe("o retry silencioso NÃO pode engolir o prazo", () => {
  // Sem a exclusão, o `catch` genérico reiniciaria o agente inteiro logo depois
  // de o prazo ter dito para não começar nem mais uma rodada — o deadline
  // anulando a si mesmo no único caso em que ele importa. Hoje isso não dispara
  // por coincidência aritmética (os dois orçamentos valem 30 000, em arquivos
  // diferentes e contados de relógios diferentes), e coincidência não é guarda.
  it("a condição do retry exclui o prazo explicitamente", () => {
    expect(CONDICAO_DO_RETRY, "a exclusão do prazo sumiu do retry").toContain(
      "!agentDeadlineReached",
    );
  });

  it("e continua excluindo o que já excluía — a exclusão é nova, não uma troca", () => {
    expect(CONDICAO_DO_RETRY).toContain("attempt === 0");
    expect(CONDICAO_DO_RETRY).toContain("!mutatingToolUsed");
    expect(CONDICAO_DO_RETRY).toContain("AGENT_RETRY_BUDGET_MS");
  });

  it("controle positivo: sem a exclusão, o caso acima fica vermelho", () => {
    const mutilada = CONDICAO_DO_RETRY.replace(/&&\s*!agentDeadlineReached/, "");
    expect(mutilada, "a cirurgia do controle não achou a exclusão").not.toBe(CONDICAO_DO_RETRY);
    expect(mutilada).not.toContain("!agentDeadlineReached");
  });
});

describe("o motivo do handoff distingue prazo de erro do provedor", () => {
  it("a decisão vem da MARCA do objeto, lida antes de sanitizar", () => {
    const i = EF.indexOf("agentDeadlineReached = isAgentDeadlineError(err)");
    const j = EF.indexOf("agentError = sanitizeProviderError(err)");
    expect(i, "a marca do prazo não é lida no catch do agente").toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(-1);
    expect(i, "a marca é lida depois de sanitizar").toBeLessThan(j);
  });

  it("nunca por comparação com o texto sanitizado", () => {
    // `sanitizeProviderError` devolve `${err.name}: ${err.message}` e ainda passa
    // por redação e `slice(0, 300)`: `=== "agent_deadline"` seria sempre falso, e
    // `includes` amarraria a decisão à forma de um texto que outra regra
    // reescreve.
    expect(EF, "voltou a comparar o texto sanitizado").not.toMatch(
      /agentError\s*===?\s*["'`]agent_deadline/,
    );
    expect(EF, "voltou a casar o prazo por substring").not.toMatch(
      /agentError\s*\.\s*(?:includes|startsWith|indexOf)\(\s*["'`]agent_deadline/,
    );
  });

  it("as duas razões existem, e a gravada é a escolhida", () => {
    expect(EF).toMatch(/agent_deadline:\$\{provider_ai\}/);
    expect(EF).toMatch(/agent_error:\$\{provider_ai\}/);
    expect(EF).toMatch(/handoff_reason:\s*agentHandoffReason/);
  });

  it("CONTROLE POSITIVO: o ramo de erro do agente não grava mais a razão fixa", () => {
    // É a regressão que a emenda nomeia: com `agentError === "agent_deadline"`,
    // o motivo caía SEMPRE em `agent_error` e o prazo ficava invisível
    // exatamente onde se investiga por que a conversa foi para atendimento
    // humano. Se alguém reintroduzir o literal na escrita, isto reprova.
    const ramo = EF.slice(EF.indexOf("    if (agentError) {"));
    const fim = ramo.indexOf('return new Response("ok")');
    expect(fim, "o ramo de erro do agente não foi encontrado").toBeGreaterThan(-1);
    const corpo = ramo.slice(0, fim);
    // A razão gravada é a ESCOLHIDA no próprio ramo, e o identificador é
    // exclusivo dele — `handoffReason` pertence à porta de negação do
    // orçamento, e reusá-lo aqui colapsaria as duas portas para o guardrail que
    // as enumera por texto (`ai-budget-wiring-guard.test.ts`).
    expect(corpo).toContain("const agentHandoffReason = agentDeadlineReached");
    expect(corpo).toContain("handoff_reason: agentHandoffReason");
    expect(corpo, "a razão voltou a ser literal na escrita").not.toMatch(
      /handoff_reason:\s*`agent_error:/,
    );
  });
});
