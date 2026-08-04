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
 *
 * STRING-AWARE de propósito. A versão anterior era uma expressão regular de
 * "barra-barra até o fim da linha" sobre texto bruto, e tratava qualquer `//`
 * como início de comentário — inclusive o de `https://` dentro de uma string ou
 * template literal. Em `ai-providers.ts` isso branqueava exatamente a linha da
 * URL do Gemini, que carrega a chave BYOK na query string:
 * o detector de vazamento de credencial ficava cego justo no vetor que ele
 * existe para vigiar. Nenhum caso dependia disso ainda, mas passa a depender —
 * um falso-negativo dormente na infraestrutura do próprio guardrail é pior que
 * um caso ausente, porque parece cobertura.
 *
 * LITERAL DE EXPRESSÃO REGULAR é reconhecido, e não por preciosismo: os
 * sanitizadores deste projeto trazem aspas DENTRO da regex (`["'\s:=]`), e um
 * scanner que só conhece string entra em modo string ali e dessincroniza o
 * arquivo inteiro a partir daquele ponto — trocar um ponto cego por outro maior.
 * A ambiguidade `/` divisão × `/` regex é resolvida pelo último token
 * significativo, que é o que todo lexer de JS faz.
 */
function blankComments(src: string): string {
  const out: string[] = [];
  // Uma entrada por `${` aberto, contando as chaves abertas dentro dele: o `}`
  // que fecha a interpolação só é o que encontra a contagem em zero.
  const tpl: number[] = [];
  let mode: "code" | "line" | "block" | "sq" | "dq" | "tpl" | "re" = "code";
  let reClass = false;
  // Último caractere de código significativo e última palavra — juntos decidem
  // se um `/` abre regex ou é divisão. Depois de identificador, número, `)` ou
  // `]` é divisão; depois de palavra-chave (`return /x/`), é regex.
  let lastCh = "";
  let lastWord = "";
  const KEYWORDS = new Set([
    "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
    "case", "do", "else", "yield", "await", "throw",
  ]);
  const regexAllowed = () =>
    /[A-Za-z0-9_$]/.test(lastCh) ? KEYWORDS.has(lastWord) : !/[)\]'"`]/.test(lastCh);
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (mode === "code") {
      if (c === "/" && d === "/") {
        mode = "line";
        out.push(" ", " ");
        i += 2;
      } else if (c === "/" && d === "*") {
        mode = "block";
        out.push(" ", " ");
        i += 2;
      } else if (c === "/" && regexAllowed()) {
        mode = "re";
        reClass = false;
        out.push(c);
        i++;
      } else if (c === "'" || c === '"' || c === "`") {
        mode = c === "'" ? "sq" : c === '"' ? "dq" : "tpl";
        out.push(c);
        i++;
      } else {
        if (tpl.length && c === "{") tpl[tpl.length - 1]++;
        if (tpl.length && c === "}") {
          if (tpl[tpl.length - 1] === 0) {
            tpl.pop();
            mode = "tpl";
          } else {
            tpl[tpl.length - 1]--;
          }
        }
        out.push(c);
        i++;
      }
      if (mode === "code" && !/\s/.test(c)) {
        lastWord = /[A-Za-z0-9_$]/.test(c) ? lastWord + c : "";
        lastCh = c;
      }
      continue;
    }
    if (mode === "re") {
      if (c === "\\") {
        out.push(c);
        if (i + 1 < src.length) out.push(src[i + 1]);
        i += 2;
        continue;
      }
      if (c === "[") reClass = true;
      else if (c === "]") reClass = false;
      else if (c === "/" && !reClass) {
        mode = "code";
        lastCh = "/";
        lastWord = "";
      }
      out.push(c);
      i++;
      continue;
    }
    if (mode === "line") {
      out.push(c === "\n" ? "\n" : " ");
      if (c === "\n") mode = "code";
      i++;
      continue;
    }
    if (mode === "block") {
      if (c === "*" && d === "/") {
        mode = "code";
        out.push(" ", " ");
        i += 2;
      } else {
        out.push(c === "\n" ? "\n" : " ");
        i++;
      }
      continue;
    }
    // Dentro de string/template nada é comentário, e a barra invertida come o
    // próximo caractere — senão uma aspa escapada fecharia a string cedo demais.
    if (c === "\\") {
      out.push(c);
      if (i + 1 < src.length) out.push(src[i + 1]);
      i += 2;
      continue;
    }
    if (mode === "tpl" && c === "$" && d === "{") {
      tpl.push(0);
      mode = "code";
      out.push("$", "{");
      i += 2;
      continue;
    }
    if ((mode === "sq" && c === "'") || (mode === "dq" && c === '"') || (mode === "tpl" && c === "`")) {
      mode = "code";
      lastCh = c;
      lastWord = "";
    }
    out.push(c);
    i++;
  }
  return out.join("");
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

/**
 * Método de um objeto literal (os ganchos devolvidos por `makeBudgetHooks`), do
 * cabeçalho até a chave que o fecha. Fronteira sintática real — a anotação de
 * retorno (`: Promise<BeforeCallDecision>`) não tem chave, então o primeiro `{`
 * depois do cabeçalho é sempre o corpo.
 */
function methodBlock(src: string, name: string): string {
  const m = new RegExp(`\\n\\s+(?:async )?${name}\\(`).exec(src);
  expect(m, `método ${name} não encontrado`).not.toBeNull();
  const [a, b] = braceBlock(src, m!.index + m![0].length - 1);
  return src.slice(a, b);
}

/**
 * Statement completo a partir de `from`: até o `;` com TODOS os aninhamentos
 * fechados. É o recorte certo para uma cadeia PostgREST
 * (`.from(...).update(...).eq(...).select(...)`), que não cabe em par de chaves
 * nem de parênteses — e cujo tamanho varia, então janela de N caracteres mediria
 * o vizinho.
 */
function statementFrom(src: string, from: number): string {
  let paren = 0;
  let brace = 0;
  let bracket = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === "(") paren++;
    else if (c === ")") paren--;
    else if (c === "{") brace++;
    else if (c === "}") brace--;
    else if (c === "[") bracket++;
    else if (c === "]") bracket--;
    else if (c === ";" && paren === 0 && brace === 0 && bracket === 0) return src.slice(from, i + 1);
  }
  throw new Error(`statement sem fim a partir de ${from}`);
}

/**
 * As duas pontas da Restrição 2: a expressão que `beforeCall` RECALCULA a partir
 * do preço do modelo real, e a que ele PASSA em `nextCallEstimateCents`.
 *
 * Devolver as duas separadas (em vez de um booleano) é o que permite exigir
 * IDENTIDADE entre elas. `passed: null` quer dizer que não há chave explícita —
 * e aí o spread de `ctx` entrega a estimativa precificada no modelo do TURNO,
 * que é exatamente o defeito que esta task existe para impedir.
 */
function estimateWiring(beforeCallBody: string): { recomputed: string | null; passed: string | null } {
  const assign = beforeCallBody.match(/const\s+([A-Za-z_$][\w$]*)\s*=\s*costOf\(/);
  const i = beforeCallBody.indexOf("planNextCall(");
  const plan = i === -1 ? "" : parenBlock(beforeCallBody, i);
  const passed = plan.match(/nextCallEstimateCents:\s*([A-Za-z_$][\w$.]*)/);
  return { recomputed: assign ? assign[1] : null, passed: passed ? passed[1] : null };
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

  it("controle do apagador de comentários: `//` dentro de string NÃO é comentário", () => {
    // Falso-negativo dormente na infraestrutura do guardrail: enquanto o
    // apagador tratava `https://` como início de comentário, todo detector que
    // roda sobre `blankComments(...)` ficava cego da URL para a frente.
    const fonte = `const u = "https://a/b"; // some\nconst v = \`x//y\${z}//w\`; /* some */\nconst s = 'p//q';\n`;
    const limpo = blankComments(fonte);
    expect(limpo, "índices deixaram de ser preservados").toHaveLength(fonte.length);
    expect(limpo, "string com // foi tratada como comentário").toContain('"https://a/b"');
    expect(limpo, "template literal com // foi tratado como comentário").toContain("x//y");
    expect(limpo, "trecho após a interpolação foi perdido").toContain("//w");
    expect(limpo, "string simples com // foi tratada como comentário").toContain("p//q");
    expect(limpo, "comentário de linha sobreviveu").not.toContain("some");
    // E o que É comentário continua apagado depois de uma string qualquer.
    expect(blankComments(`const a = "x"; // segredo\n`)).not.toContain("segredo");
  });

  it("controle do apagador: regex com aspas dentro não dessincroniza o resto", () => {
    // `["'\s:=]` dentro de uma regex é o padrão real dos sanitizadores deste
    // projeto. Um scanner que só conhece string entra em modo string ali e todo
    // o arquivo DEPOIS daquele ponto passa a ser lido errado — o comentário
    // seguinte sobrevive e o código seguinte é apagado, os dois em silêncio.
    const fonte = `const r = /["'\\s:=]+/g;\n// segredo\nconst z = 1;\n`;
    const limpo = blankComments(fonte);
    expect(limpo, "índices deixaram de ser preservados").toHaveLength(fonte.length);
    expect(limpo, "a regex foi comida").toContain(`/["'\\s:=]+/g`);
    expect(limpo, "o comentário depois da regex sobreviveu").not.toContain("segredo");
    expect(limpo, "o código depois da regex foi apagado").toContain("const z = 1;");
    // E divisão continua sendo divisão: `a / b // c` tem comentário de verdade.
    const div = blankComments(`const q = (a) / b; // nota\nconst w = 2;\n`);
    expect(div, "divisão foi lida como regex e engoliu o comentário").not.toContain("nota");
    expect(div).toContain("const w = 2;");
  });

  it("controle positivo no arquivo real: a URL do Gemini sobrevive ao apagador", () => {
    // É a linha que carrega `key=${apiKey}`. Com o apagador antigo ela sumia
    // inteira — e o caso "nenhum campo de log pode carregar a chave", que roda
    // sobre o texto apagado, nunca chegaria a vê-la.
    expect(blankComments(providers)).toContain("generativelanguage.googleapis.com");
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

// ═══════════════════════════════════════════════════════════════════════════
// Adapter de I/O do orçamento
// ═══════════════════════════════════════════════════════════════════════════
//
// `ai-budget-gate.ts` importa supabase-js por URL e o vitest também não o
// alcança. Ele não pode conter DECISÃO — toda pergunta é respondida por núcleo
// puro, que tem teste de verdade. O que se prova aqui é que ele de fato delega,
// e que as regras que não cabem em núcleo (ordem de escrita, gate da flag,
// sanitização, escopo de tenant) estão onde deveriam.

const gate = readFileSync(join(SHARED, "ai-budget-gate.ts"), "utf8").replace(/\r\n/g, "\n");

const GATE_FNS = [
  "loadAiFranchise",
  "openTurnBudget",
  "makeBudgetHooks",
  "finalizeTurn",
  "recordMilestones",
  "loadPrice",
  "costOf",
  "makePriceResolver",
  "todayBrt",
] as const;

describe("ai-budget-gate.ts — adapter sem decisão própria", () => {
  it("controle dos recortes: nenhum bloco do adapter sangra para a função vizinha", () => {
    for (const nome of GATE_FNS) {
      const bloco = fnBlock(gate, nome);
      expect(bloco.length, `recorte de ${nome} vazio`).toBeGreaterThan(30);
      expect(bloco.length, `recorte de ${nome} engoliu o arquivo`).toBeLessThan(gate.length * 0.6);
      for (const outra of GATE_FNS.filter((n) => n !== nome)) {
        expect(bloco, `recorte de ${nome} inclui o cabeçalho de ${outra}`).not.toMatch(
          new RegExp(`function ${outra}(?:<|\\()`),
        );
      }
    }
  });

  it("delega a decisão aos núcleos puros", () => {
    for (const core of ["ai-budget-core.ts", "ai-price-core.ts", "ai-budget-milestones-core.ts"]) {
      expect(gate, `não importa ${core}`).toContain(`from "./${core}"`);
    }
    for (const fn of [
      "planNextCall",
      "mapReserveDecision",
      "computeAvailableCents",
      "priceUsage",
      "selectEffectivePrice",
      "crossedMilestonePercents",
      "resolveCycleWindow",
    ]) {
      expect(gate, `não usa ${fn}`).toContain(fn);
    }
  });

  it("não reimplementa a fórmula do teto nem a escada de marcos", () => {
    expect(gate).not.toMatch(/limit_?[Cc]ents\s*-\s*settled/);
    expect(gate).not.toMatch(/\b(7000|8000|9000|10000)\b/);
  });

  it("não redigita event_type de marco — a fonte canônica é o núcleo", () => {
    expect(gate).not.toMatch(/"admin_ai_budget_(70|80|90|stop)"/);
    expect(gate).toContain("EVENT_TYPE_BY_MILESTONE_PERCENT");
  });

  it("chama as cinco RPCs pelo nome, sem SQL cru", () => {
    for (const rpc of [
      "open_ai_cycle_budget",
      "reserve_ai_budget",
      "extend_ai_reservation",
      "record_ai_call_usage",
      "finalize_ai_reservation",
    ]) {
      expect(gate, `não chama ${rpc}`).toContain(`"${rpc}"`);
    }
    expect(gate).not.toMatch(/\bselect\s+\*\s+from\b/i);
  });

  it("todo UPDATE escopado por tenant confere as linhas casadas", () => {
    // PostgREST devolve error:null num UPDATE que não casa linha nenhuma: sem
    // conferir o retorno, "o predicado negou" fica indistinguível de "gravei".
    // Recorte por fim de statement, não por janela — a cadeia PostgREST tem
    // comprimento variável.
    const updates = [...gate.matchAll(/\.update\(/g)];
    expect(updates.length, "nenhum UPDATE encontrado — o detector quebrou").toBeGreaterThan(0);
    for (const m of updates) {
      const stmt = statementFrom(gate, m.index!);
      expect(stmt, `UPDATE sem .select() no índice ${m.index}`).toContain(".select(");
      expect(stmt, `UPDATE sem predicado de tenant no índice ${m.index}`).toContain(
        '.eq("organization_id"',
      );
    }
    // E o retorno é REALMENTE conferido, não só pedido.
    expect(fnBlock(gate, "recordMilestones"), "o tamanho do retorno não é conferido").toMatch(
      /\.length === 0/,
    );
  });

  it("nenhum sanitizedCode carrega mensagem do Postgres ou SQL", () => {
    const achados = [...gate.matchAll(/sanitizedCode:\s*([^,;}\n]+)/g)];
    expect(achados.length, "nenhum sanitizedCode — o detector quebrou").toBeGreaterThan(0);
    for (const m of achados) {
      const v = m[1].trim();
      // `sanitizedCode: string` é a ANOTAÇÃO do tipo, não um valor.
      if (v === "string") continue;
      expect(v).not.toContain("error.message");
      expect(v).not.toContain("err.message");
      expect(v).toMatch(/^"[a-z0-9_]{1,40}"$/);
    }
  });

  it("o modo observação nunca nega — e o gate é a flag, não um if solto", () => {
    expect(gate).toContain("ai_wallet_enforced");
    // Preço desconhecido com a flag OFF vira ALLOW: medir não pode calar o
    // agente de ninguém. O ramo é recortado pelas PRÓPRIAS chaves.
    const body = methodBlock(gate, "beforeCall");
    const semPreco = body.slice(...braceBlock(body, body.indexOf("if (!price)")));
    expect(semPreco, "o ramo sem preço ignora a flag").toContain("enforced");
    expect(semPreco, "o ramo sem preço nunca autoriza em observação").toContain('kind: "ALLOW"');
    expect(semPreco, "sumiu a negação por preço desconhecido").toContain("DENY_PRICE_UNKNOWN");
  });

  it("hard stop COMERCIAL é pergunta do núcleo — o adapter não redigita a distinção", () => {
    // ERROR e DENY_BUDGET levam ao mesmo destino operacional e dizem coisas
    // OPOSTAS. Reimplementar a distinção aqui é a decisão que este arquivo não
    // pode ter.
    expect(gate, "a distinção comercial não vem do núcleo").toContain("isCommercialHardStop");
    expect(gate, "a distinção comercial foi redigitada").not.toMatch(/kind\s*===\s*"DENY_BUDGET"/);
  });

  it("EXHAUSTED é afirmação COMERCIAL — falha de infraestrutura nunca vira franquia esgotada", () => {
    const body = fnBlock(gate, "openTurnBudget");
    const saidas = [...body.matchAll(/kind: "EXHAUSTED"/g)];
    expect(saidas.length, "nenhuma saída EXHAUSTED — o detector quebrou").toBeGreaterThan(0);
    for (const m of saidas) {
      const guard = body.lastIndexOf("if (", m.index!);
      expect(guard, `EXHAUSTED sem if que o preceda (índice ${m.index})`).toBeGreaterThan(-1);
      expect(
        parenBlock(body, guard),
        `EXHAUSTED devolvido sem gate comercial (índice ${m.index})`,
      ).toMatch(/enforced|isCommercialHardStop/);
    }
    // E a falha da própria RPC de abertura leva a ERROR, nunca a EXHAUSTED.
    const falhaAbertura = body.slice(...braceBlock(body, body.indexOf("if (openErr")));
    expect(falhaAbertura).toContain('kind: "ERROR"');
    expect(falhaAbertura, "erro de banco virou franquia esgotada").not.toContain("EXHAUSTED");
  });

  it("beforeCall precifica no MODELO REAL da chamada, nunca na estimativa do contexto", () => {
    // A RESTRIÇÃO DESTA TASK. `ctx.nextCallEstimateCents` chega precificado no
    // modelo do INÍCIO DO TURNO; confiar nele autoriza a tentativa de fallback
    // (Pro) com a folga do modelo barato (Flash). O preço tem de ser recarregado
    // a partir de `ctx.provider`/`ctx.model` e a estimativa recalculada.
    const body = methodBlock(gate, "beforeCall");
    const priceArgs = parenBlock(body, body.indexOf("loadPrice("));
    expect(priceArgs, "beforeCall não precifica o provedor da chamada").toContain("ctx.provider");
    expect(priceArgs, "beforeCall não precifica o modelo da chamada").toContain("ctx.model");
    expect(priceArgs, "beforeCall precifica no modelo do TURNO").not.toMatch(/args\.(provider|model)/);

    const w = estimateWiring(body);
    expect(w.recomputed, "beforeCall não recalcula a estimativa").not.toBeNull();
    expect(
      w.passed,
      "planNextCall não recebe estimativa explícita — o spread de ctx entrega a do turno",
    ).not.toBeNull();
    expect(w.passed, "planNextCall decide com a estimativa do contexto").toBe(w.recomputed);

    // E a ordem: precificar ANTES de planejar. Planejar primeiro seria decidir
    // com o número velho e só depois descobrir o preço certo.
    expect(body.indexOf("loadPrice(")).toBeLessThan(body.indexOf("planNextCall("));
  });

  it("controle do detector acima: pega a estimativa vinda do contexto e a chave ausente", () => {
    const bom = `{
      const price = await loadPrice(supabase, ctx.provider, ctx.model);
      const estimateCents = costOf(price, estimateCallTokens(ctx.iteration), ctx.provider, ctx.model);
      const plan = planNextCall({ ...ctx, nextCallEstimateCents: estimateCents }, { usageUnresolved });
    }`;
    expect(estimateWiring(bom)).toEqual({ recomputed: "estimateCents", passed: "estimateCents" });

    const doContexto = bom.replace("nextCallEstimateCents: estimateCents", "nextCallEstimateCents: ctx.nextCallEstimateCents");
    const w1 = estimateWiring(doContexto);
    expect(w1.passed).not.toBe(w1.recomputed);

    const semChave = bom.replace(", nextCallEstimateCents: estimateCents", "");
    expect(estimateWiring(semChave).passed).toBeNull();
  });

  it("reportCall apropria o custo no modelo REAL da chamada, não no do turno", () => {
    // Cobrar Pro a preço de Flash é subcontabilização direta — a mesma regra do
    // autorizador, na ponta que escreve no ledger.
    const body = methodBlock(gate, "reportCall");
    const priceArgs = parenBlock(body, body.indexOf("loadPrice("));
    expect(priceArgs, "reportCall não usa o provedor da chamada").toContain("meta.provider");
    expect(priceArgs, "reportCall não usa o modelo da chamada").toContain("meta.model");
    expect(priceArgs, "reportCall apropria no modelo do TURNO").not.toMatch(/args\.(provider|model)/);
    // O `price_id` gravado é o que o autorizador já resolveu para ESTA chamada.
    expect(body).toMatch(/p_price_id:\s*priceId/);
  });

  it("usage ausente não vira custo zero — e a apropriação perdida nunca é silenciosa", () => {
    const body = methodBlock(gate, "reportCall");
    // As três variantes de desfecho existem separadas: zero VERDADEIRO só em
    // PROVIDER_FAILED; chamada que ocorreu com custo indeterminado vira
    // USAGE_REVIEW_REQUIRED e tira a reserva da expiração automática.
    expect(body).toContain("PROVIDER_FAILED");
    expect(body).toContain("USAGE_REVIEW_REQUIRED");
    expect(body, "usage indeterminado não trava a próxima chamada").toContain(
      "usageUnresolved = true",
    );
    const zero = body.split("\n").find((l) => l.includes("p_cost_brl_cents"));
    expect(zero, "não há linha de custo — o detector quebrou").toBeDefined();
    expect(zero, "o zero deixou de ser exclusivo do PROVIDER_FAILED").toContain("PROVIDER_FAILED");
    expect(zero, "o custo real deixou de ser gravado").toContain("brlCents");
    // Falha de gravação PROPAGA: custo real que o orçamento não soube é o pior
    // caso possível.
    expect(body).toMatch(/throw new Error\("ai_usage_record_failed"\)/);
  });

  it("o marco é gravado ANTES de enfileirar, e carimbado só DEPOIS", () => {
    // Disciplina de três tempos (6b): o INSERT é a barreira de persistência; o
    // carimbo é a última coisa. Inverter reabre um dos dois defeitos opostos —
    // aviso diário sem teto, ou ledger dizendo "avisei" sobre e-mail que não saiu.
    const body = fnBlock(gate, "recordMilestones");
    const insert = body.indexOf(".insert(");
    const enqueue = body.indexOf("enqueueBillingNotification(");
    const stamp = body.indexOf(".update(");
    expect(insert, "o marco não é gravado").toBeGreaterThan(-1);
    expect(enqueue, "o aviso não é enfileirado").toBeGreaterThan(-1);
    expect(stamp, "o marco não é carimbado").toBeGreaterThan(-1);
    expect(insert, "enfileira antes de provar que o ledger grava").toBeLessThan(enqueue);
    expect(enqueue, "carimba 'avisei' antes de o aviso entrar na fila").toBeLessThan(stamp);
    // 23505 é dedupe (o marco já foi registrado neste ciclo), não erro.
    expect(body, "o dedupe do marco virou erro").toContain("23505");
  });

  it("a franquia lida é escopada pela organização e o restante vem do núcleo", () => {
    const body = fnBlock(gate, "loadAiFranchise");
    expect(body, "leitura de orçamento sem escopo de tenant").toContain('.eq("organization_id"');
    expect(body, "a fórmula do disponível foi reimplementada").toContain("computeAvailableCents(");
  });

  it("nenhuma chave de IA é lida ou logada aqui", () => {
    expect(gate).not.toMatch(/ai_provider_credentials|apiKey|api_key/);
  });

  it("budgetRemainingCents nunca é devolvido ao frontend do lojista", () => {
    // O adapter é chamado só por webhook-whatsapp (service_role). Não pode
    // existir nenhum caminho que devolva o restante numa resposta HTTP.
    expect(gate).not.toMatch(/new Response\(/);
  });

  it("nenhuma contagem de conversa autoriza chamada", () => {
    expect(gate).not.toContain('from("conversations")');
    expect(gate).not.toMatch(/conversationCount|messageCount|interactionCount/);
  });
});
