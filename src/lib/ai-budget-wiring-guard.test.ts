/**
 * Guardrail de LEITURA sobre `ai-providers.ts`, que o vitest não consegue
 * importar (ele importa `https://esm.sh/@anthropic-ai/sdk`).
 *
 * Toda DECISÃO desta frente vive em núcleo puro e é testada de verdade
 * (`ai-call-authorizer-core.test.ts`, `ai-budget-core.test.ts`,
 * `ai-price-core.test.ts`). O que este arquivo prova é o WIRING: que os cinco
 * runners chamam o autorizador em vez de reimplementar a ordem, que nenhum deles
 * conversa com o provedor por fora, que o fallback do Gemini é chamada
 * financeira PRÓPRIA, e que nada sensível vaza. Leitura humana já deixou passar
 * um `ReferenceError` de autorização e um conflito FK × CHECK por duas
 * auditorias na 6b — este teste é a leitura que não cansa.
 *
 * REGRA DE PROJETO DESTE ARQUIVO: asserção que continua verde com a regra
 * removida não vale a linha. Nada aqui fatia por janela de N caracteres — a
 * rodada anterior desta frente mediu o vizinho em vez do alvo exatamente assim.
 * Todo recorte é por fronteira sintática REAL, e são só quatro: cabeçalho de
 * função até o `}` de coluna zero; par de chaves balanceado; par de parênteses
 * balanceado; fim de statement (`;`) ou delimitador de comentário (`/**`). Todo
 * detector tem controle positivo E negativo sobre fonte sintética.
 *
 * E toda asserção sobre IDENTIDADE de valor — o modelo que vai ao autorizador é
 * o modelo que vai ao provedor — compara as duas ocorrências entre si. Só checar
 * que a chave `model` existe no objeto é verde com um literal fixo dentro.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SHARED = join(__dirname, "..", "..", "supabase", "functions", "_shared");
/**
 * CRLF normalizado na LEITURA. O arquivo está com fim de linha do Windows, e um
 * recorte que procura `\n}\n` não acha nada num arquivo CRLF: o bloco escorrega
 * até o fim do arquivo e o guardrail passa a medir todas as funções de uma vez —
 * exatamente o defeito de "medir o vizinho" que reprovou a rodada anterior. O
 * caso "os recortes não sangram para a vizinha" existe para prender isto.
 */
const providers = readFileSync(join(SHARED, "ai-providers.ts"), "utf8").replace(/\r\n/g, "\n");

// ─── Recortes por fronteira sintática ───────────────────────────────────────

/** [início, fim) de uma função de topo: do cabeçalho até o `}` na coluna zero. */
function fnRange(src: string, name: string): [number, number] | null {
  const header = new RegExp(`^(?:export )?(?:async )?function ${name}(?:<[^>]*>)?\\(`, "m");
  const m = header.exec(src);
  if (!m) return null;
  const start = m.index;
  const close = src.indexOf("\n}\n", start);
  return [start, close === -1 ? src.length : close + 3];
}

function fnBlock(src: string, name: string): string {
  const r = fnRange(src, name);
  expect(r, `função ${name} não encontrada`).not.toBeNull();
  return src.slice(r![0], r![1]);
}

/** Par de chaves balanceado a partir do primeiro `{` em/depois de `from`. */
function braceBlock(src: string, from: number): [number, number] {
  const open = src.indexOf("{", from);
  expect(open, `nenhum '{' depois do índice ${from}`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return [open, i + 1];
    }
  }
  throw new Error(`chaves desbalanceadas a partir de ${open}`);
}

/**
 * Apaga o CONTEÚDO dos comentários preservando os índices (troca por espaço).
 * Necessário quando a regra é sobre CÓDIGO e a prosa cita o mesmo identificador
 * de propósito — como o JSDoc que explica `opts.budget`.
 */
function blankComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

/** Par de parênteses balanceado a partir do primeiro `(` em/depois de `from`. */
function parenBlock(src: string, from: number): string {
  const open = src.indexOf("(", from);
  expect(open, `nenhum '(' depois do índice ${from}`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`parênteses desbalanceados a partir de ${open}`);
}

/** O objeto literal passado a `callWithBudget` dentro de um corpo de runner. */
function budgetSpec(runnerBody: string): string {
  const i = runnerBody.indexOf("callWithBudget");
  expect(i, "runner não chama callWithBudget").toBeGreaterThan(-1);
  const [a, b] = braceBlock(runnerBody, i);
  return runnerBody.slice(a, b);
}

/**
 * A EXPRESSÃO que o spec passa em `model` — shorthand (`model,`) ou identificador
 * (`model: attemptModel,`). Um literal fixo (`model: "gpt-4o"`) não casa e o caso
 * fica vermelho: é a diferença entre "declara um modelo" e "declara O modelo".
 */
function specModelExpr(spec: string, runner: string): string {
  const m = spec.match(/\n\s*model(?::\s*([A-Za-z_$][\w$.]*))?\s*,/);
  expect(
    m,
    `${runner}: spec não passa \`model\` como identificador — literal fixo ou chave ausente`,
  ).not.toBeNull();
  return m![1] ?? "model";
}

/** O bloco `invoke: async () => { … }` de UM spec, por chaves balanceadas. */
function invokeBlockOf(spec: string, runner: string): string {
  const i = spec.search(/invoke:\s*async/);
  expect(i, `${runner}: spec não passa invoke`).toBeGreaterThan(-1);
  const [a, b] = braceBlock(spec, i);
  return spec.slice(a, b);
}

/** Todos os blocos `invoke: async () => { … }` do arquivo, balanceados. */
function invokeBlocks(src: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of src.matchAll(/invoke:\s*(?:async\s*)?\(\s*\)\s*=>\s*\{/g)) {
    out.push(braceBlock(src, m.index! + m[0].length - 1));
  }
  return out;
}

/**
 * Índices de chamada HTTP ao provedor que NÃO estão dentro de um `invoke`
 * autorizado. `fetchWithRetry` dentro do corpo de `callGeminiOnce` é o único
 * ponto isento — e não é uma brecha, porque `callGeminiOnce(` também é detectado
 * e portanto TODO call site dele precisa estar dentro de um invoke.
 */
function rawCallsOutsideInvoke(src: string): number[] {
  const blocks = invokeBlocks(src);
  const once = fnRange(src, "callGeminiOnce");
  const out: number[] = [];
  const re = /anthropic\.messages\.create\(|(?<!function )\bfetchWithRetry\(|(?<!function )\bcallGeminiOnce\(/g;
  for (const m of src.matchAll(re)) {
    const i = m.index!;
    if (once && i > once[0] && i < once[1]) continue;
    if (!blocks.some(([s, e]) => i > s && i < e)) out.push(i);
  }
  return out;
}

/** Argumentos de cada `console.*()` do arquivo, com parênteses balanceados. */
function consoleCallArgs(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/console\.(?:warn|error|info|log)\(/g)) {
    out.push(parenBlock(src, m.index! + m[0].length - 1));
  }
  return out;
}

// ─── Fontes sintéticas para os controles dos detectores ─────────────────────

const SYNTH_OK = `
async function runX() {
  const call = await callWithBudget(opts, {
    invoke: async () => {
      const r = await fetchWithRetry("u", {}, {});
      return { value: r, rawUsage: null };
    },
  });
}
`;

const SYNTH_BAD = `
async function runX() {
  const r = await fetchWithRetry("u", {}, {});
  const call = await callWithBudget(opts, {
    invoke: async () => {
      return { value: r, rawUsage: null };
    },
  });
}
`;

const RUNNERS = ["runClaude", "runOpenAICompatible", "runGemini"] as const;

// ─── Casos ──────────────────────────────────────────────────────────────────

describe("ai-providers.ts — contrato de orçamento", () => {
  it("controle dos recortes: nenhum bloco sangra para a função vizinha", () => {
    // Sem isto, um recorte que não encontra sua fronteira devolve o arquivo
    // inteiro e TODAS as asserções de corpo passam a medir todas as funções.
    // A lista precisa conter TODA função que algum caso recorta — uma que fique
    // de fora sangra sem ninguém notar, que é o defeito original desta classe.
    const nomes = [
      "callWithBudget",
      "callGeminiOnce",
      "sanitizeProviderError",
      "shouldTryGeminiFallback",
      "runAgentLoop",
      "estimateCostUsd",
      ...RUNNERS,
    ];
    for (const nome of nomes) {
      const bloco = fnBlock(providers, nome);
      expect(bloco.length, `recorte de ${nome} vazio`).toBeGreaterThan(50);
      expect(bloco.length, `recorte de ${nome} engoliu o arquivo`).toBeLessThan(providers.length * 0.6);
      const vizinhas = nomes.filter((n) => n !== nome);
      for (const outra of vizinhas) {
        expect(bloco, `recorte de ${nome} inclui o cabeçalho de ${outra}`).not.toMatch(
          new RegExp(`function ${outra}(?:<|\\()`),
        );
      }
    }
  });

  it("importa o autorizador puro em vez de reimplementar a ordem", () => {
    expect(providers).toContain('from "./ai-call-authorizer-core.ts"');
    expect(providers).toContain("authorizeAndInvoke");
    // E o usa no helper — importar sem chamar seria decoração.
    expect(fnBlock(providers, "callWithBudget")).toContain("await authorizeAndInvoke(");
  });

  it("não reimplementa nenhum passo do protocolo: quem fala com beforeCall/reportCall é o núcleo", () => {
    // O helper repassa os ganchos ao núcleo; ele NUNCA chama beforeCall e depois
    // decide sozinho o que fazer com a resposta — essa ordem é do núcleo.
    const body = fnBlock(providers, "callWithBudget");
    expect(body).toMatch(/beforeCall:\s*\(ctx\)\s*=>/);
    expect(body).toMatch(/reportCall:\s*\(meta,\s*outcome,\s*priceId\)\s*=>/);
    expect(body).toMatch(/priceFor:\s*\(provider,\s*model\)\s*=>/);
    for (const runner of RUNNERS) {
      const rb = fnBlock(providers, runner);
      // Sem o `(`: pega `b.beforeCall (ctx)`, `const { beforeCall } = …` e
      // qualquer alias, porque o NOME tem de aparecer para o alias existir.
      for (const gancho of ["beforeCall", "reportCall", "priceFor", "newCallId", "snapshot"]) {
        expect(rb, `${runner} menciona o gancho ${gancho} por fora do núcleo`).not.toContain(gancho);
      }
      // E a regra de que ele nasce: `opts.budget` é lido em UM lugar só.
      expect(rb, `${runner} lê opts.budget direto — só callWithBudget pode`).not.toContain(
        "opts.budget",
      );
    }
    // `opts.budget` é LIDO num lugar só. Comentários são apagados preservando
    // índices — a prosa cita o campo de propósito e não é leitura.
    const codigo = blankComments(providers);
    const [s, e] = fnRange(codigo, "callWithBudget")!;
    const donos = [...codigo.matchAll(/opts\.budget/g)];
    expect(donos.length, "opts.budget não é mais lido em lugar nenhum").toBeGreaterThan(0);
    for (const m of donos) {
      expect(
        m.index! > s && m.index! < e,
        `opts.budget lido fora de callWithBudget (índice ${m.index})`,
      ).toBe(true);
    }
  });

  it("expõe os hooks de orçamento como OPCIONAIS — ausente = comportamento de hoje", () => {
    expect(providers).toMatch(/budget\?:\s*AgentBudgetHooks/);
  });

  it("sem `opts.budget` o helper sai ANTES de qualquer autorização", () => {
    // Ren Sushi (override vitalício), carteira legada e BYOK puro dependem deste
    // early-return: nenhuma autorização, nenhuma apropriação, nenhum custo.
    const body = fnBlock(providers, "callWithBudget");
    const guard = body.search(/if\s*\(!b\)/);
    const auth = body.indexOf("authorizeAndInvoke");
    expect(guard, "sumiu o early-return do caminho legado").toBeGreaterThan(-1);
    expect(auth).toBeGreaterThan(-1);
    expect(guard, "o caminho legado passou a rodar DEPOIS da autorização").toBeLessThan(auth);
    // O ramo legado é recortado pelas PRÓPRIAS chaves; fatiar "até
    // authorizeAndInvoke" arrastaria o preâmbulo do ramo com orçamento junto.
    const [la, lb] = braceBlock(body, guard);
    const legacy = body.slice(la, lb);
    expect(legacy, "o ramo legado não chama o provedor direto").toContain("spec.invoke()");
    expect(legacy).toMatch(/return\s*\{\s*kind:\s*"OK"/);
    expect(legacy, "o ramo legado tocou o orçamento").not.toMatch(/beforeCall|reportCall|priceFor|snapshot/);
  });

  it("controle negativo: sem o early-return, o caso acima fica vermelho", () => {
    const gutted = providers.replace(/\n {2}if \(!b\) \{[\s\S]*?\n {2}\}\n/, "\n");
    expect(gutted, "a cirurgia do controle não achou o bloco").not.toBe(providers);
    expect(fnBlock(gutted, "callWithBudget").search(/if\s*\(!b\)/)).toBe(-1);
  });

  it("runAgentLoop devolve resultado discriminado, não string crua", () => {
    expect(providers).toMatch(/export type AgentLoopResult/);
    expect(providers).toMatch(/runAgentLoop\([^)]*\):\s*Promise<AgentLoopResult>/);
    // As duas variantes existem: "acabou o orçamento" e "terminei" exigem
    // consequências opostas no webhook.
    expect(providers).toMatch(/kind:\s*"TEXT"/);
    expect(providers).toMatch(/kind:\s*"DENIED"/);
  });

  it("os CINCO provedores passam pelo mesmo caminho autorizado", () => {
    // Implementar o gancho só no Gemini o tornaria "o único testado".
    const entry = fnBlock(providers, "runAgentLoop");
    for (const p of ["claude", "openai", "grok", "deepseek", "gemini"]) {
      expect(entry, `provedor ${p} sem rota no switch`).toContain(`case "${p}":`);
    }
    for (const runner of RUNNERS) {
      const body = fnBlock(providers, runner);
      expect(body, `${runner} não usa callWithBudget`).toContain("callWithBudget");
      expect(body, `${runner} não devolve AgentLoopResult`).toContain("Promise<AgentLoopResult>");
    }
  });

  it("cada chamada autorizada declara provedor, MODELO REAL e iteração 1-based", () => {
    const esperado: Record<string, RegExp> = {
      runClaude: /provider:\s*"claude"/,
      runOpenAICompatible: /provider:\s*opts\.provider/,
      runGemini: /provider:\s*"gemini"/,
    };
    for (const runner of RUNNERS) {
      const spec = budgetSpec(fnBlock(providers, runner));
      expect(spec, `${runner} não declara o provedor`).toMatch(esperado[runner]);
      expect(spec, `${runner} não declara a iteração`).toMatch(
        /iteration:\s*MAX_ITERATIONS\s*-\s*iterations/,
      );
      expect(spec, `${runner} não passa invoke`).toMatch(/invoke:\s*async/);

      // IDENTIDADE, não presença: o modelo autorizado tem de ser a MESMA
      // expressão que o `invoke` manda ao provedor. Um literal fixo no spec
      // (`model: "gpt-4o"`) satisfazia a checagem antiga enquanto o laço chamava
      // outro modelo — e é exatamente assim que se autoriza Flash e chama Pro.
      expect(spec, `${runner} fixa o modelo por literal no spec`).not.toMatch(
        /model:\s*["'`]/,
      );
      const expr = specModelExpr(spec, runner);
      expect(
        invokeBlockOf(spec, runner),
        `${runner}: o modelo autorizado (${expr}) não é o que vai ao provedor`,
      ).toContain(expr);
    }
  });

  it("o snapshot é pedido para o MODELO da chamada em curso, não para o do turno", () => {
    // `nextCallEstimateCents` é a estimativa que viaja no BeforeCallContext e
    // contra a qual `planNextCall` decide ALLOW vs EXTEND. Só com a iteração, o
    // contrato entrega um número precificado no modelo do TURNO — e a tentativa
    // de fallback (Pro) chega ao autorizador com folga de Flash. O adapter
    // recalcula no `beforeCall`; o que se prende aqui é o contrato não mentir.
    expect(providers, "o hook voltou a receber só a iteração").toMatch(
      /snapshot\(\s*iteration:\s*number,\s*provider:\s*string,\s*model:\s*string\s*\)/,
    );
    const helper = fnBlock(providers, "callWithBudget");
    const i = helper.indexOf("b.snapshot(");
    expect(i, "callWithBudget não pede o snapshot").toBeGreaterThan(-1);
    const args = parenBlock(helper, i);
    expect(args, "o snapshot não recebe a iteração da chamada").toContain("spec.iteration");
    expect(args, "o snapshot não recebe o provedor da chamada").toContain("spec.provider");
    expect(args, "o snapshot não recebe o MODELO da chamada").toContain("spec.model");
    // E é o mesmo `spec.model` que vai para a autorização — um não pode divergir
    // do outro, senão estima-se um modelo e autoriza-se outro.
    expect(helper, "o autorizador recebe um modelo diferente do estimado").toMatch(
      /model:\s*spec\.model\b/,
    );
  });

  it("negação encerra o turno — nenhum runner segue para a próxima chamada", () => {
    for (const runner of RUNNERS) {
      const body = fnBlock(providers, runner);
      expect(body, `${runner} ignora a negação`).toMatch(/kind === "DENIED"/);
      expect(body, `${runner} não propaga a decisão negada`).toMatch(
        /return \{ kind: "DENIED", decision/,
      );
    }
  });

  it("nenhuma chamada HTTP ao provedor acontece fora do invoke autorizado", () => {
    expect(rawCallsOutsideInvoke(providers)).toEqual([]);
  });

  it("controle do detector de chamada crua: reconhece dentro e fora do invoke", () => {
    expect(rawCallsOutsideInvoke(SYNTH_OK)).toHaveLength(0);
    expect(rawCallsOutsideInvoke(SYNTH_BAD)).toHaveLength(1);
    // E o arquivo real tem invokes de verdade para o detector varrer.
    expect(invokeBlocks(providers).length).toBeGreaterThanOrEqual(RUNNERS.length);
  });

  it("retry dentro de UMA chamada não gera autorização nova", () => {
    // `fetchWithRetry` retenta a MESMA chamada, mesmo modelo; tentativa que falha
    // não produz usage. Autorização aninhada dentro do invoke seria uma por
    // tentativa — cobrança inventada.
    for (const [s, e] of invokeBlocks(providers)) {
      const block = providers.slice(s, e);
      expect(block, "autorização aninhada dentro do invoke").not.toContain("authorizeAndInvoke");
      expect(block, "callWithBudget aninhado dentro do invoke").not.toContain("callWithBudget");
    }
  });

  it("o fallback do Gemini é chamada NOVA, com o modelo REAL e autorização própria", () => {
    // Cobrar Pro a preço de Flash é subcontabilização direta.
    expect(providers, "o fallback embutido no helper HTTP voltou").not.toContain(
      "callGeminiWithFallback",
    );
    const body = fnBlock(providers, "runGemini");

    const decl = body.slice(body.indexOf("const attemptModels"));
    const stmt = decl.slice(0, decl.indexOf(";") + 1);
    expect(stmt, "a lista de tentativas não considera o fallback").toContain("fallbackModel");
    expect(stmt, "a lista de tentativas não parte do modelo ativo").toContain("activeModel");

    const spec = budgetSpec(body);
    expect(spec, "a autorização do Gemini não usa o modelo da TENTATIVA").toMatch(
      /model:\s*attemptModel\b/,
    );
    // Argumentos recortados por parênteses balanceados — não por janela de N
    // caracteres, que mediria o que estivesse por perto.
    const httpArgs = parenBlock(spec, spec.indexOf("callGeminiOnce("));
    expect(httpArgs, "o HTTP do Gemini não usa o modelo da tentativa").toContain("attemptModel");

    // O helper de UMA chamada não escolhe modelo — quem escolhe é o laço que
    // autoriza cada tentativa.
    const once = fnBlock(providers, "callGeminiOnce");
    expect(once, "o helper HTTP voltou a decidir fallback").not.toContain("fallbackModel");
    expect(once, "o helper HTTP voltou a decidir fallback").not.toContain("FALLBACK_MODELS");
  });

  it("a negação do fallback também encerra o turno — não cai em texto vazio", () => {
    const body = fnBlock(providers, "runGemini");
    const i = body.indexOf("if (denied)");
    expect(i, "a negação da tentativa não é propagada para fora do laço").toBeGreaterThan(-1);
    // Chaves balanceadas: pega o bloco `{ … }` se houver, e o objeto devolvido
    // na forma de uma linha só. Nos dois casos é fronteira real, não janela.
    const [a, b] = braceBlock(body, i);
    expect(body.slice(a, b)).toMatch(/kind: "DENIED"/);
  });

  it("o erro do provedor é SANITIZADO antes de virar desfecho financeiro", () => {
    // A variante PROVIDER_FAILED carrega o erro cru do SDK, e erro que ecoa o
    // request pode conter a chave BYOK. O núcleo não sanitiza — o adapter é aqui.
    expect(providers).toContain("function sanitizeProviderError");
    const helper = fnBlock(providers, "callWithBudget");
    expect(helper, "o erro cru vaza para o desfecho financeiro").toMatch(
      /error:\s*sanitizeProviderError\(/,
    );
    expect(helper).not.toMatch(/kind:\s*"FAILED",\s*error:\s*err\b/);
    const san = fnBlock(providers, "sanitizeProviderError");
    for (const padrao of ["key=", "Bearer", "REDACTED"]) {
      expect(san, `sanitizador não trata ${padrao}`).toContain(padrao);
    }
  });

  it("erro do provedor nunca é estringificado cru — nem por String(), nem por interpolação", () => {
    // A URL do Gemini leva `?key=<chave>` e mensagens de rede do runtime a ecoam.
    // As DUAS formas contam: `String(e)` (o objeto lançado em runGemini se chama
    // `e`) e `${err}`. Cobrir só uma deixa a outra livre.
    expect(providers, "String() cru sobre um erro").not.toMatch(
      /String\(\s*(?:err|error|e|ex|lastError)\s*[).,]/,
    );
    expect(providers, "interpolação crua de um erro").not.toMatch(
      /\$\{\s*(?:err|error|e|ex|lastError)\s*\}/,
    );
  });

  it("todo log é estruturado, e nenhum campo dele pode carregar a chave", () => {
    // Sobre o CÓDIGO do log, não sobre a prosa: o comentário que explica por que
    // a URL com `?key=` precisa ser sanitizada não é um vazamento. Índices
    // preservados, então os blocos recortados são os mesmos.
    const logs = consoleCallArgs(blankComments(providers));
    expect(logs.length, "nenhum console encontrado — o detector quebrou").toBeGreaterThan(0);
    for (const args of logs) {
      // Valor cru como argumento (`console.warn(url)`) esconde a URL do Gemini,
      // que leva `?key=<chave>`, de qualquer verificação por NOME de campo.
      expect(args, "log não estruturado — um valor cru pode carregar a chave").toMatch(
        /^\(\s*JSON\.stringify\(\{/,
      );
      expect(args, "campo com cara de credencial no log").not.toMatch(
        /apiKey|api_key|Authorization|credentials|key=/,
      );
      // E todo VALOR de erro passa pelo sanitizador — o lado direito do campo,
      // não o nome dele.
      for (const line of args.split("\n")) {
        const c = line.indexOf(":");
        if (c === -1) continue;
        if (!/\b(?:err|error|lastError|ex)\b/.test(line.slice(c + 1))) continue;
        expect(line, "valor de erro entra no log sem sanitizador").toContain(
          "sanitizeProviderError",
        );
      }
    }
  });

  it("controle do detector de log: pega a chave, o log não estruturado e o erro cru", () => {
    const comChave = `console.warn(JSON.stringify({ evt: "x", key: opts.apiKey }));`;
    expect(consoleCallArgs(comChave)).toHaveLength(1);
    expect(consoleCallArgs(comChave)[0]).toMatch(/apiKey/);
    // Log não estruturado: é assim que a URL com `?key=` escaparia da checagem
    // por nome de campo.
    expect(consoleCallArgs(`console.warn(url);`)[0]).not.toMatch(/^\(\s*JSON\.stringify\(\{/);
    expect(
      consoleCallArgs(`console.warn(JSON.stringify({ evt: "x" }));`)[0],
    ).toMatch(/^\(\s*JSON\.stringify\(\{/);
    // Erro cru no valor de um campo estruturado.
    const cru = `console.warn(JSON.stringify({\n  error: String(e),\n}));`;
    const linhaCrua = consoleCallArgs(cru)[0].split("\n").find((l) => l.includes("error:"));
    expect(linhaCrua).not.toContain("sanitizeProviderError");
  });

  it("o catálogo de modelos NÃO muda nesta frente — manage-ai-providers fora do redeploy", () => {
    expect(providers).toContain("DEFAULT_MODELS");
    expect(providers).toContain("KNOWN_MODELS");
    expect(providers).toMatch(/gemini:\s*"gemini-2\.5-flash"/);
    expect(providers).toMatch(/gemini:\s*"gemini-2\.5-pro"/);
  });

  it("estimateCostUsd continua existindo, e o comentário fixa que ele NÃO serve o orçamento", () => {
    expect(providers).toContain("export function estimateCostUsd");
    // O bloco JSDoc é recortado pela fronteira do próprio comentário — não por
    // janela de caracteres, que mediria o vizinho.
    const decl = providers.indexOf("const PRICING_USD_PER_MTOK");
    expect(decl).toBeGreaterThan(-1);
    const doc = providers.slice(providers.lastIndexOf("/**", decl), decl);
    expect(doc).toMatch(/orçamento|orcamento/i);
    expect(doc).toMatch(/ai-price-core/);
    // E o caminho de orçamento realmente não os consulta.
    const helper = fnBlock(providers, "callWithBudget");
    expect(helper).not.toContain("estimateCostUsd");
    expect(helper).not.toContain("PRICING_USD_PER_MTOK");
  });

  it("nenhuma contagem de conversa, mensagem ou interação autoriza chamada", () => {
    expect(providers).not.toMatch(/conversationCount|messageCount|interactionCount/);
    // O único teto é financeiro: MAX_ITERATIONS segue sendo guarda de laço.
    expect(providers).toMatch(/const MAX_ITERATIONS = 12;/);
  });
});
