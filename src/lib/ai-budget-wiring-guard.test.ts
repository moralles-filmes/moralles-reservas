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
      // ESCAPE DE FIM DE LINHA. Um literal de regex não atravessa `\n`; sem esta
      // saída, uma única `/` mal classificada (divisão cujo token anterior pareça
      // palavra-chave) põe o scanner em modo regex até a próxima `/` em QUALQUER
      // lugar do arquivo, e todo comentário no meio sobrevive sem aviso. Um lexer
      // de verdade trataria isso como erro; aqui o limite barato é ressincronizar
      // na quebra de linha, que troca um falso-negativo ilimitado por um de uma
      // linha.
      if (c === "\n") {
        mode = "code";
        reClass = false;
        lastCh = "\n";
        lastWord = "";
        out.push("\n");
        i++;
        continue;
      }
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

  it("controle do apagador: regex não terminada não contamina além da linha", () => {
    // A FIXTURE TEM DE ENTRAR EM MODO REGEX, senão o caso não prova nada. A
    // primeira versão deste caso usava `total /count`, em que `lastWord` é
    // "total" — fora de KEYWORDS, logo `regexAllowed()` é false e o scanner
    // NUNCA entrava em modo `re`: remover o escape de `\n` deixava a saída
    // idêntica e o caso verde. `return /` entra, porque `return` é palavra-chave.
    //
    // Sem o escape, o scanner sai do modo regex só na próxima `/` do ARQUIVO —
    // que é a do `// segredo` — e tudo até lá sobrevive em silêncio.
    const fonte = `function f() { return /x; }\n// segredo\nconst z = 3;\n// outro\nconst w = 4 / 2;\n`;
    const limpo = blankComments(fonte);
    expect(limpo, "índices deixaram de ser preservados").toHaveLength(fonte.length);
    expect(limpo, "a regex não terminada foi engolida").toContain("return /x; }");
    expect(limpo, "o dano passou da linha da regex não terminada").not.toContain("segredo");
    expect(limpo, "o dano passou da linha da regex não terminada").not.toContain("outro");
    expect(limpo, "o código depois da regex não terminada sumiu").toContain("const z = 3;");
    expect(limpo, "a divisão depois da recuperação foi perdida").toContain("const w = 4 / 2;");
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
  "makePriceCache",
  "todayBrt",
] as const;

/** Os ganchos são MÉTODOS de um objeto literal, não funções de topo. */
const GATE_METHODS = new Set(["beforeCall", "reportCall", "snapshot", "priceFor"]);

function gateBlock(name: string): string {
  return GATE_METHODS.has(name) ? methodBlock(gate, name) : fnBlock(gate, name);
}

/**
 * "Esta função tem de CHAMAR aquele núcleo." O `(` no fim é o que separa chamada
 * de menção — sem ele, a linha de import satisfaz a asserção sozinha, que é
 * exatamente como um caso desta suíte ficava verde com todos os pontos de
 * chamada apagados.
 */
const CHAMADAS_OBRIGATORIAS: Array<[string, string]> = [
  ["resolveCycleWindow(", "openTurnBudget"],
  ["estimateTurnCents(", "openTurnBudget"],
  ["mapReserveDecision(", "openTurnBudget"],
  ["isCommercialHardStop(", "openTurnBudget"],
  ["computeAvailableCents(", "loadAiFranchise"],
  ["selectEffectivePrice(", "loadPrice"],
  ["priceUsage(", "costOf"],
  ["planNextCall(", "beforeCall"],
  ["mapReserveDecision(", "beforeCall"],
  ["isCommercialHardStop(", "beforeCall"],
  ["estimateCallTokens(", "beforeCall"],
  ["estimateCallTokens(", "reportCall"],
  ["priceUsage(", "reportCall"],
  ["crossedMilestonePercents(", "recordMilestones"],
  ["EVENT_TYPE_BY_MILESTONE_PERCENT[", "recordMilestones"],
];

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
    // SOBRE O CORPO, não sobre o arquivo. `gate.toContain("planNextCall")` é
    // satisfeito pela linha de IMPORT sozinha: apagar todos os pontos de chamada
    // e manter os imports deixava o caso verde com o adapter decidindo por conta
    // própria. Cada par abaixo é "esta função tem de CHAMAR aquele núcleo".
    for (const [chamada, dono] of CHAMADAS_OBRIGATORIAS) {
      expect(gateBlock(dono), `${dono} não chama ${chamada}`).toContain(chamada);
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

  it("preço desconhecido FALHA FECHADO — nenhum modo converte ignorância em autorização", () => {
    // O modo observação abranda TETO, nunca PREÇO. Sem preço não há `price_id`
    // (NOT NULL em ai_usage_events) e o evento não pode existir: autorizar seria
    // consumo real sem nenhum registro possível. `authorizeAndInvoke` já nega no
    // passo 2, ANTES do beforeCall — um segundo caminho que abrandasse aqui seria
    // código morto afirmando o contrário do que produção faz.
    const ramos = [...gate.matchAll(/if \(!price\)/g)];
    expect(ramos.length, "nenhum ramo de preço ausente — o detector quebrou").toBeGreaterThan(2);
    for (const m of ramos) {
      const bloco = gate.slice(...braceBlock(gate, m.index!));
      expect(bloco, `ramo sem preço autoriza a chamada (índice ${m.index})`).not.toContain('"ALLOW"');
      expect(bloco, `ramo sem preço não sai (índice ${m.index})`).toContain("return");
    }
    // E nenhum deles consulta a flag: consultar já é abrandar.
    const semPreco = (() => {
      const body = methodBlock(gate, "beforeCall");
      return body.slice(...braceBlock(body, body.indexOf("if (!price)")));
    })();
    expect(semPreco, "sumiu a negação por preço desconhecido").toContain('kind: "DENY_PRICE_UNKNOWN"');
    expect(semPreco, "o modo observação voltou a abrandar preço desconhecido").not.toContain(
      "enforced",
    );
    const noPriceFor = (() => {
      const body = methodBlock(gate, "priceFor");
      return body.slice(...braceBlock(body, body.indexOf("if (!price)")));
    })();
    expect(noPriceFor, "priceFor deixou de devolver a ignorância tipada").toContain("PRICE_UNKNOWN");
    expect(noPriceFor, "priceFor passou a consultar a flag").not.toContain("enforced");
  });

  it("o modo observação abranda TETO, e só com a flag na mão", () => {
    expect(gate).toContain("ai_wallet_enforced");
    // Cada conversão de negação comercial em autorização vive dentro de um ramo
    // que consulta `enforced`. Recorte pelas próprias chaves do `if`.
    const body = methodBlock(gate, "beforeCall");
    const i = body.indexOf("isCommercialHardStop(decision) && !args.budget.enforced");
    expect(i, "o abrandamento do teto sumiu do beforeCall").toBeGreaterThan(-1);
    const ramo = body.slice(...braceBlock(body, i));
    expect(ramo, "o abrandamento não autoriza").toContain('kind: "ALLOW"');
  });

  it("hard stop COMERCIAL é pergunta do núcleo — o adapter não redigita a distinção", () => {
    // ERROR e DENY_BUDGET levam ao mesmo destino operacional e dizem coisas
    // OPOSTAS. Reimplementar a distinção aqui é a decisão que este arquivo não
    // pode ter. A metade positiva vive em CHAMADAS_OBRIGATORIAS (sobre o CORPO
    // das duas funções que decidem); aqui fica a negativa.
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

    // O ramo comercial tem as DUAS saídas dentro dele. Sem esta asserção, apagar
    // o `if (!enforced)` interno deixava o caso verde — o `if` externo ainda
    // casaria o regex acima — e o modo observação sumia do caminho de reserva.
    const comercial = body.slice(...braceBlock(body, body.indexOf("isCommercialHardStop(decision)")));
    expect(comercial, "o modo observação sumiu do caminho de reserva").toMatch(/if \(!enforced\)/);
    expect(comercial, "observação deixou de ter saída própria").toContain('kind: "UNMETERED"');
    expect(comercial, "sumiu a afirmação de teto").toContain('kind: "EXHAUSTED"');
  });

  it("'prossiga sem medição' é VARIANTE, não string dentro de um erro", () => {
    // `observed_only` (o turno DEVE rodar) e `price_unknown` (deve falhar
    // fechado) eram a mesma variante, separáveis só por casar texto dentro de um
    // `sanitizedCode` opaco — decisão empurrada para quem só tem a string.
    expect(gate, "sumiu a variante de turno não medido").toContain('kind: "UNMETERED"');
    expect(gate, "a variante voltou a ser um código de erro").not.toContain('"observed_only"');
    // E `ERROR` carrega `enforced`, senão o chamador não consegue nem re-derivar
    // se o gate estava ligado.
    // Statement inteiro: a união tem `;` DENTRO de cada variante, então cortar no
    // primeiro `;` mediria só a primeira delas.
    const stmt = statementFrom(gate, gate.indexOf("export type OpenTurnResult"));
    expect(stmt, "a variante ERROR não carrega o estado do gate").toMatch(
      /kind: "ERROR";[^|]*enforced: boolean/,
    );
    expect(stmt, "UNMETERED não declara motivo legível").toMatch(/kind: "UNMETERED"; reason: string/);
  });

  it("finalizeTurn não devolve instantâneo plausível quando a RPC não aplicou nada", () => {
    // RESERVATION_NOT_FOUND / CYCLE_NOT_FOUND / INVALID_STATUS vêm com
    // settled=0 e limit=0, e crossedMilestonePercents(0, 0) é lista vazia: um
    // finalize que nunca aconteceu silenciaria TODO alerta de marco.
    const body = fnBlock(gate, "finalizeTurn");
    expect(body, "o discriminador de estado real sumiu").toContain("CYCLE_STATES.has(row.state)");
    const ramo = body.slice(...braceBlock(body, body.indexOf("!CYCLE_STATES.has(row.state)")));
    expect(ramo, "a não-aplicação não é registrada").toContain("jsonLog");
    expect(ramo, "a não-aplicação devolve números plausíveis").toContain("return null");
    // E `finalized` é EXPOSTO, não descartado — o caminho idempotente devolve
    // números legítimos e precisa ser distinguível do caminho que aplicou.
    expect(body, "finalized voltou a ser descartado").toMatch(/finalized:\s*row\.finalized === true/);
  });

  it("o aviso de marco tem caminho de retry — 23505 não é o fim da linha", () => {
    // A migration 103 desenhou para isto: `notified_at` NULL com
    // enqueue_attempts > 0 = marco registrado, aviso não enfileirado, e há índice
    // parcial `where notified_at is null`. Sem o retry, uma falha transitória em
    // resolver o destinatário perde o aviso para sempre — inclusive o de 100%.
    const body = fnBlock(gate, "recordMilestones");
    expect(body, "23505 deixou de ser tratado").toContain("23505");
    // DENTRO do ramo de erro do INSERT. Afirmar só que o arquivo contém
    // `.select("id, notified_at, …")` seria verde sem retry nenhum — o próprio
    // INSERT pede essas colunas. O que prende o retry é a RELEITURA escopada
    // pelo marco, e ela só existe dentro deste ramo.
    const ramoErro = body.slice(...braceBlock(body, body.indexOf("if (error) {")));
    expect(ramoErro, "erro que não é 23505 deixou de sair").toContain("continue");
    expect(ramoErro, "23505 não relê o marco existente").toContain(
      '.eq("milestone_percent", percent)',
    );
    expect(ramoErro, "a releitura não traz o que decide o retry").toContain(
      '"id, notified_at, enqueue_attempts"',
    );
    expect(ramoErro, "a releitura não alimenta o ledger do laço").toMatch(/ledger = existing/);
    expect(body, "o retry não olha se o aviso já saiu").toMatch(/ledger\.notified_at/);
    // Sem destinatário o slot NÃO é consumido — senão a falha transitória vira
    // permanente na primeira passada. Sobre o CÓDIGO: o comentário do ramo cita
    // a coluna de propósito, e citar não é escrever.
    const codigo = fnBlock(blankComments(gate), "recordMilestones");
    const semDest = codigo.slice(...braceBlock(codigo, codigo.indexOf("if (!recipient)")));
    expect(semDest, "sem destinatário o slot é consumido").not.toContain("enqueue_attempts");
    expect(semDest).toContain("continue");
  });

  it("beforeCall precifica no MODELO REAL da chamada, nunca na estimativa do contexto", () => {
    // A RESTRIÇÃO DESTA TASK. `ctx.nextCallEstimateCents` chega precificado no
    // modelo do INÍCIO DO TURNO; confiar nele autoriza a tentativa de fallback
    // (Pro) com a folga do modelo barato (Flash). O preço tem de ser recarregado
    // a partir de `ctx.provider`/`ctx.model` e a estimativa recalculada.
    const body = methodBlock(gate, "beforeCall");
    const priceArgs = parenBlock(body, body.indexOf("resolvePrice("));
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
    expect(body.indexOf("resolvePrice(")).toBeLessThan(body.indexOf("planNextCall("));
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
    const priceArgs = parenBlock(body, body.indexOf("resolvePrice("));
    expect(priceArgs, "reportCall não usa o provedor da chamada").toContain("meta.provider");
    expect(priceArgs, "reportCall não usa o modelo da chamada").toContain("meta.model");
    expect(priceArgs, "reportCall apropria no modelo do TURNO").not.toMatch(/args\.(provider|model)/);
    // O `price_id` gravado é o que o autorizador já resolveu para ESTA chamada.
    expect(body).toMatch(/p_price_id:\s*priceId/);
  });

  it("os três pontos de preço falam da MESMA linha — um resolvedor por turno", () => {
    // Três leituras independentes não custavam só latência: `p_price_id` vinha da
    // resolução do momento da autorização e `cost_brl_cents` de uma leitura
    // fresca no momento do report. Uma vigência trocada no meio do turno gravava
    // evento cujo preço não corresponde ao custo.
    const hooks = fnBlock(gate, "makeBudgetHooks");
    expect(hooks, "o resolvedor do turno deixou de ser reaproveitado").toMatch(
      /const resolvePrice = args\.resolvePrice \?\? makePriceCache\(supabase\)/,
    );
    for (const metodo of ["priceFor", "beforeCall", "reportCall"]) {
      const body = methodBlock(gate, metodo);
      expect(body, `${metodo} não usa o resolvedor compartilhado`).toContain("resolvePrice(");
      expect(body, `${metodo} voltou a ler o preço por fora do cache`).not.toContain("loadPrice(");
    }
    // E `loadPrice` só é chamada de dentro do cache.
    const cache = fnBlock(gate, "makePriceCache");
    expect(cache).toContain("loadPrice(");

    // O QUARTO ponto: a estimativa da reserva. `openTurnBudget` cria o resolvedor
    // e o DEVOLVE, senão a afirmação "um resolvedor por turno" valeria só dentro
    // dos ganchos e o mesmo par seria lido duas vezes, de vigências possivelmente
    // diferentes.
    const abre = fnBlock(gate, "openTurnBudget");
    expect(abre, "openTurnBudget não usa o cache").toContain("makePriceCache(supabase)");
    expect(abre, "openTurnBudget não devolve o resolvedor do turno").toMatch(
      /\n\s*resolvePrice,\n/,
    );
    const stmt = statementFrom(gate, gate.indexOf("export type OpenTurnResult"));
    expect(stmt, "o resultado READY não carrega o resolvedor").toMatch(
      /kind: "READY";[^|]*resolvePrice: PriceResolver/,
    );
  });

  it("custo impossível de precificar é null, nunca sentinela numérico", () => {
    // Um valor máximo estouraria os parâmetros `integer` das RPCs, e `0` em
    // silêncio é a falha que esta frente existe para matar.
    const body = fnBlock(gate, "costOf");
    expect(body, "costOf voltou a devolver sentinela numérico").not.toContain("MAX_SAFE_INTEGER");
    expect(body, "costOf não devolve a ignorância tipada").toContain("return null");
    // E quem chama trata: os dois call sites têm ramo explícito para o null.
    expect(fnBlock(gate, "openTurnBudget"), "a estimativa do turno ignora o null").toMatch(
      /c === null/,
    );
    expect(methodBlock(gate, "beforeCall"), "a estimativa da chamada ignora o null").toMatch(
      /estimateCents === null/,
    );
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

  it("os três tempos do marco, na ordem: TOCA, enfileira, CARIMBA", () => {
    // A versão anterior deste caso exigia `.update(` DEPOIS do enqueue, e assim
    // proibia a própria correção: o primeiro UPDATE é o TOQUE, que consome o
    // slot e prova que a linha é gravável ANTES de qualquer coisa entrar na fila.
    // Contar depois de enfileirar deixa o contador parado exatamente quando a
    // escrita falha, e o teto nunca é alcançado.
    const body = fnBlock(gate, "recordMilestones");
    const insert = body.indexOf(".insert(");
    const enqueue = body.indexOf("enqueueBillingNotification(");
    const toca = body.indexOf('"touch_ai_budget_milestone"');
    const updates = [...body.matchAll(/\.update\(/g)].map((m) => m.index!);
    expect(insert, "o marco não é gravado").toBeGreaterThan(-1);
    expect(enqueue, "o aviso não é enfileirado").toBeGreaterThan(-1);
    expect(toca, "o toque atômico sumiu").toBeGreaterThan(-1);
    expect(updates.length, "o carimbo deixou de ser o único UPDATE do cliente").toBe(1);
    const [carimba] = updates;

    expect(insert, "o ledger deixou de ser a primeira barreira").toBeLessThan(toca);
    expect(toca, "enfileira antes de provar que a linha é gravável").toBeLessThan(enqueue);
    expect(enqueue, "carimba 'avisei' antes de o aviso entrar na fila").toBeLessThan(carimba);

    // O carimbo registra o envio; o toque, não — e o toque nem é UPDATE do
    // cliente, justamente porque o incremento tem de ser avaliado no servidor.
    expect(statementFrom(body, carimba), "o carimbo não registra o envio").toContain("notified_at");
    expect(
      statementFrom(body, carimba),
      "o incremento voltou para o carimbo — o teto vira inalcançável",
    ).not.toContain("enqueue_attempts");

    // Toque que não casa linha IMPEDE o enfileiramento — é o que faz dele
    // barreira, e não decoração.
    const guarda = body.indexOf("if (touchErr");
    expect(guarda, "o retorno do toque não é conferido").toBeGreaterThan(toca);
    expect(guarda, "o toque é conferido só depois de enfileirar").toBeLessThan(enqueue);
    expect(
      body.slice(...braceBlock(body, guarda)),
      "toque falho não impede o enfileiramento",
    ).toContain("continue");

    // 23505 é dedupe (o marco já foi registrado neste ciclo), não erro.
    expect(body, "o dedupe do marco virou erro").toContain("23505");
  });

  it("o incremento de tentativas é do SERVIDOR, e o teto viaja com ele", () => {
    // Read-modify-write no cliente perde tentativa sob concorrência genuína:
    // dois turnos da mesma organização cruzando o mesmo marco leem 0, ambos
    // gravam 1, ambos enfileiram — e o UNIQUE parcial não deduplica.
    const body = fnBlock(gate, "recordMilestones");
    expect(body, "o toque deixou de ser atômico").toContain('"touch_ai_budget_milestone"');
    expect(body, "o incremento voltou a ser calculado no cliente").not.toMatch(
      /enqueue_attempts:\s*\w+\s*\+\s*1/,
    );
    // O teto é ARGUMENTO da RPC — é lá que ele é aplicado, no mesmo UPDATE.
    // Ancorado no `.rpc(`, não no literal: o primeiro `(` depois do literal seria
    // o da linha seguinte, e o recorte mediria o vizinho. E sobre o texto SEM
    // comentários: um `(` dentro de comentário desbalancearia o recorte, e há
    // comentário longo dentro da região medida.
    const codigo = fnBlock(blankComments(gate), "recordMilestones");
    const args = parenBlock(codigo, codigo.indexOf('.rpc("touch_ai_budget_milestone"'));
    expect(args, "o toque não é escopado por tenant").toContain("p_organization_id");
    expect(args, "o teto não viaja para quem o aplica").toContain(
      "p_max_attempts: MILESTONE_ENQUEUE_MAX_ATTEMPTS",
    );
    // E a recusa do servidor é honrada, com o motivo que ele devolveu.
    expect(body, "o motivo da recusa é descartado").toMatch(/touch\?\.reason/);
    expect(gate, "o teto sumiu").toContain("MILESTONE_ENQUEUE_MAX_ATTEMPTS");
    // O curto-circuito local continua existindo, mas só para poupar I/O.
    const bloqueio = body.slice(
      ...braceBlock(body, body.indexOf(">= MILESTONE_ENQUEUE_MAX_ATTEMPTS")),
    );
    expect(bloqueio, "estourar o teto não interrompe nada").toContain("continue");
    expect(bloqueio, "estourar o teto passa em silêncio").toContain("jsonLog");
  });

  it("o modo observação é REPASSADO à RPC de reserva, não reimplementado aqui", () => {
    // Sem o escape na RPC, a organização que estourou o teto roda TODO turno
    // seguinte sem `reservationId` — logo sem ganchos e sem medição —,
    // permanentemente cega no único modo que existe para medi-la. E a decisão de
    // criar a reserva assim mesmo é da RPC, sob o lock; aqui só se repassa a flag.
    // Sobre o texto SEM comentários: um `(` dentro de comentário desbalancearia
    // o recorte dos argumentos, e há comentário longo exatamente ali.
    const codigo = fnBlock(blankComments(gate), "openTurnBudget");
    const args = parenBlock(codigo, codigo.indexOf('.rpc("reserve_ai_budget"'));
    expect(args, "a reserva não sabe se o gate está ligado").toMatch(
      /p_observation:\s*!enforced\b/,
    );

    // E o contorno é REGISTRADO. O gate do log inclui `reason_code` além de
    // `overrun`: quando o único guard contornado foi o de usage pendente,
    // `overrun` é false e o fato — estado pegajoso até resolução administrativa
    // — não deixaria rastro nenhum. E inclui o ALLOW, porque `reason_code` é
    // não-nulo em toda negação legítima.
    const guarda = codigo.indexOf('if (decision.kind === "ALLOW" && (row?.overrun || row?.reason_code))');
    expect(guarda, "o contorno em observação não é registrado").toBeGreaterThan(-1);
    const log = codigo.slice(...braceBlock(codigo, guarda));
    expect(log, "o contorno não é logado").toContain("jsonLog");
    expect(log, "o log não distingue overrun de usage pendente").toContain("bypass:");
    expect(log, "o contorno virou decisão em vez de registro").not.toContain("return");
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

// ═══════════════════════════════════════════════════════════════════════════
// Ligação no webhook-whatsapp
// ═══════════════════════════════════════════════════════════════════════════
//
// O webhook chama `serve()` no carregamento e importa `deno.land`/`esm.sh` — o
// vitest também não o alcança. Toda DECISÃO continua em núcleo puro; o que se
// prova aqui é a LIGAÇÃO: que o caminho novo só existe para quem resolve por
// franquia, que a reserva é finalizada em TODOS os desfechos do turno, que a
// negação distingue teto comercial de soluço de infraestrutura, e que nada de
// custo, token ou limite chega ao cliente do restaurante.
//
// MESMA REGRA DE PROJETO do resto do arquivo: nada fatia por janela de N
// caracteres. Os recortes usam as mesmas quatro fronteiras sintáticas.

const webhook = readFileSync(
  join(__dirname, "..", "..", "supabase", "functions", "webhook-whatsapp", "index.ts"),
  "utf8",
).replace(/\r\n/g, "\n");

/**
 * O webhook SEM o conteúdo dos comentários, para os recortes estruturais: uma
 * chave ou um parêntese solto dentro de um comentário desbalancearia o recorte
 * e o bloco escorregaria para a vizinha — o defeito que reprovou uma rodada
 * anterior desta frente. O caso de controle logo abaixo prova que o apagador
 * atravessou este arquivo inteiro sem dessincronizar.
 */
const webhookCode = blankComments(webhook);

/** O bloco `if (… kind === "DENIED") { … }`, por chaves balanceadas. */
function deniedBlock(src: string): string {
  const i = src.indexOf('agentOutcome.kind === "DENIED"');
  expect(i, "bloco de negação não encontrado").toBeGreaterThan(-1);
  return src.slice(...braceBlock(src, i));
}

/** Bloco `{ … }` que segue uma âncora textual, por chaves balanceadas. */
function blocoDe(ancora: string): string {
  const i = webhookCode.indexOf(ancora);
  expect(i, `âncora não encontrada: ${ancora}`).toBeGreaterThan(-1);
  return webhookCode.slice(...braceBlock(webhookCode, i));
}

/**
 * O `catch` externo do handler, achado a partir do log que só ele emite —
 * o arquivo tem vários `catch (err)` e escolher pelo índice mediria outro.
 */
function catchExterno(): string {
  const marca = webhookCode.indexOf('evt: "webhook_error"');
  expect(marca, "o catch externo sumiu").toBeGreaterThan(-1);
  const i = webhookCode.lastIndexOf("catch (err) {", marca);
  expect(i, "nenhum catch antes do log do erro do webhook").toBeGreaterThan(-1);
  return webhookCode.slice(...braceBlock(webhookCode, i));
}

/**
 * O trecho de SUCESSO: do fim do bloco de falha de envio até o início do catch
 * externo. Duas âncoras sintáticas reais — cortar no `finish("success")` mediria
 * só metade do desfecho, e é justamente a ORDEM entre a liquidação e o `finish`
 * que se prende aqui: dinheiro antes de telemetria. (A ordem inversa chegou a
 * ser escrita e foi desfeita — o comentário do caso da ordem diz por quê.)
 */
function trechoSucesso(): string {
  const [, fimEnvio] = braceBlock(webhookCode, webhookCode.indexOf("if (!sendRes.ok)"));
  const marca = webhookCode.indexOf('evt: "webhook_error"');
  const fim = webhookCode.lastIndexOf("catch (err) {", marca);
  expect(fim, "o desfecho de sucesso sumiu").toBeGreaterThan(fimEnvio);
  return webhookCode.slice(fimEnvio, fim);
}

/**
 * As quatro obrigações de um hard stop comercial, sobre o CORPO do bloco.
 *
 * São duas portas (o entitlement, antes do turno; e a corrida na reserva) e as
 * duas devem o mesmo: handoff com razão própria, resposta determinística ao
 * cliente, registro da execução e fim do turno. Prender só a CONDIÇÃO deixava
 * passar remover o handoff — o cliente é avisado, a conversa segue `ai_active`,
 * e o restaurante nunca vê a fila — ou remover a resposta, deixando o cliente
 * no escuro. E é sobre o STATEMENT de cada escrita, não sobre o bloco inteiro:
 * `toContain` no bloco fica verde quando sobra só o append no histórico.
 */
function exigeHardStopCompleto(bloco: string, nome: string) {
  const upd = bloco.indexOf('from("conversations")');
  expect(upd, `${nome}: não registra o handoff na conversa`).toBeGreaterThan(-1);
  expect(
    statementFrom(bloco, upd),
    `${nome}: o handoff não usa a razão própria da franquia`,
  ).toContain("AI_BUDGET_HANDOFF_REASON");
  const envio = bloco.indexOf("sendOutbound(");
  expect(envio, `${nome}: não responde ao cliente`).toBeGreaterThan(-1);
  expect(
    statementFrom(bloco, envio),
    `${nome}: a resposta ao cliente não é o texto determinístico`,
  ).toContain("AI_BUDGET_EXHAUSTED_CUSTOMER_TEXT");
  expect(bloco, `${nome}: não registra a execução`).toContain('finish("ai_budget_exhausted")');
  expect(bloco, `${nome}: não encerra o turno`).toContain("return new Response");
}

/** O bloco `if (opened.kind === "READY") { … }`, onde o dado é GUARDADO. */
function readyBlock(): string {
  return blocoDe('if (opened.kind === "READY")');
}

/**
 * Todos os valores atribuídos a uma variável, por statement.
 *
 * A declaração com anotação de tipo (`let x: T | null = null;`) NÃO casa — e é
 * proposital: o que interessa aqui é quem SOBRESCREVE o dado depois.
 */
function atribuicoesDe(nome: string): Array<{ valor: string; index: number }> {
  return [...webhookCode.matchAll(new RegExp(`\\b${nome} = ([^;]+);`, "g"))].map((m) => ({
    valor: m[1].trim(),
    index: m.index!,
  }));
}

/**
 * O identificador local a que um recorte liga UMA propriedade de um objeto
 * desestruturado (`const { reservationId, cycleId } = turnBudget;`), com ou sem
 * renomeação.
 *
 * O nome sai do CÓDIGO, não é redigitado aqui — mesmo padrão de `captura`/
 * `orgId`. Renomear a variável na porta não pode deixar o caso medindo um nome
 * que não existe mais.
 */
function ligadoDe(recorte: string, objeto: string, prop: string): string {
  const m = recorte.match(new RegExp(`const\\s*\\{([^}]*)\\}\\s*=\\s*${objeto};`));
  expect(m, `o recorte não desestrutura ${objeto}`).not.toBeNull();
  const campo = m![1]
    .split(",")
    .map((s) => s.trim())
    .find((s) => s === prop || s.startsWith(`${prop}:`));
  expect(campo, `${objeto}.${prop} não é lido`).toBeDefined();
  return campo!.includes(":") ? campo!.split(":")[1].trim() : campo!;
}

/**
 * IDENTIDADE, não presença: a chave `x` do objeto recebe EXATAMENTE o
 * identificador `ident` — pelo atalho de propriedade (`{ …, x, … }`, só quando
 * o nome coincide) ou explícito (`x: ident`). `x: outraCoisa` é falso, que é a
 * diferença entre "endereça uma reserva" e "endereça A reserva".
 */
function passaIdentidade(args: string, chave: string, ident: string): boolean {
  if (new RegExp(`${chave}:\\s*${ident}\\b`).test(args)) return true;
  return chave === ident && new RegExp(`[{,]\\s*${ident}\\s*[,}]`).test(args);
}

describe("webhook-whatsapp — ligação da franquia", () => {
  it("controle do apagador sobre o webhook: strings sobrevivem e comentários somem", () => {
    // Sem este controle, um apagador dessincronizado devolveria um arquivo
    // truncado e TODO recorte estrutural abaixo mediria outra coisa em silêncio.
    expect(webhookCode, "índices deixaram de ser preservados").toHaveLength(webhook.length);
    expect(webhookCode, "o apagador não chegou ao fim do arquivo").toContain('"webhook_error"');
    expect(webhookCode, "uma string do meio do arquivo foi comida").toContain("MEDIA_REPLY_TEXT");
    expect(webhookCode, "comentário real sobreviveu").not.toContain("Grava esta mensagem já");
  });

  it("importa o adapter e os núcleos, sem reimplementar decisão", () => {
    expect(webhook).toContain('from "../_shared/ai-budget-gate.ts"');
    expect(webhook).toContain('from "../_shared/ai-budget-copy.ts"');
    expect(webhook).toContain('from "../_shared/ai-budget-core.ts"');
    // CHAMADA, não menção: `toContain("openTurnBudget")` é satisfeito pela
    // linha de import sozinha — apagar todo ponto de chamada e manter os
    // imports deixaria este caso verde, que é a classe de falso-verde que já
    // reprovou uma rodada desta frente.
    for (const fn of [
      "openTurnBudget",
      "makeBudgetHooks",
      "finalizeTurn",
      "recordMilestones",
      "loadAiFranchise",
    ]) {
      expect(webhookCode, `não CHAMA ${fn}`).toMatch(new RegExp(`${fn}\\(`));
    }
  });

  it("os ganchos chegam ao LAÇO do agente — o fio que faz a franquia existir", () => {
    // Sem `budget:` na chamada a `runAgentLoop`, tudo o mais continua de pé —
    // reserva aberta, liquidação no fim, telemetria — e o LLM roda SEM
    // autorização, SEM `beforeCall` e SEM `reportCall`: `consumed_cents` fica
    // em zero, o teto nunca se move e o sistema reporta saúde perfeita. É o
    // único fio que faz a franquia existir, e construir os ganchos não é
    // passá-los.
    const i = webhookCode.indexOf("runAgentLoop(");
    expect(i, "o laço do agente não é chamado").toBeGreaterThan(-1);
    const args = parenBlock(webhookCode, i);
    const passado = args.match(/\n\s*budget:\s*([A-Za-z_$][\w$.]*)\s*,/);
    expect(passado, "os ganchos não são passados ao laço").not.toBeNull();
    // IDENTIDADE: é a variável que recebeu `makeBudgetHooks`. Um `budget:
    // undefined` satisfaz a presença da chave e desliga a franquia inteira.
    const construido = webhookCode.match(/([A-Za-z_$][\w$]*)\s*=\s*makeBudgetHooks\(/);
    expect(construido, "os ganchos não são construídos").not.toBeNull();
    expect(
      passado![1],
      "o laço recebe outra coisa no lugar dos ganchos construídos",
    ).toBe(construido![1]);
  });

  it("os textos determinísticos entram no HARDCODED_AGENT_NOISE pela LISTA, não redigitados", () => {
    // Sem isto a mensagem de bloqueio polui o histórico das invocações
    // seguintes — mesmo motivo de MEDIA_REPLY_TEXT.
    const i = webhookCode.indexOf("const HARDCODED_AGENT_NOISE");
    expect(i, "o conjunto de ruído sumiu").toBeGreaterThan(-1);
    const stmt = statementFrom(webhookCode, i);
    expect(stmt).toContain("AI_BUDGET_HARDCODED_TEXTS");
    expect(stmt, "a lista foi redigitada em vez de espalhada").toMatch(
      /\.\.\.AI_BUDGET_HARDCODED_TEXTS/,
    );
  });

  it("o hard stop usa razão de handoff PRÓPRIA, distinta de agent_error", () => {
    // SOBRE AS ESCRITAS, não sobre o arquivo: `toContain("AI_BUDGET_HANDOFF_REASON")`
    // é satisfeito pela linha de import, e o `not.toMatch` da forma
    // chave-de-objeto não vê `handoffReason = "ai_budget_exhausted";` dentro do
    // bloco de negação. Aqui todo VALOR atribuído a uma razão de handoff é
    // inspecionado, nas duas formas.
    const escritas = [...webhookCode.matchAll(/handoff_?[Rr]eason\s*[:=]\s*([^,;\n]+)/g)];
    expect(escritas.length, "nenhuma razão de handoff — o detector quebrou").toBeGreaterThan(0);
    for (const m of escritas) {
      expect(m[1].trim(), "a razão da franquia foi redigitada em vez de importada").not.toBe(
        '"ai_budget_exhausted"',
      );
    }
    // E a constante é REALMENTE usada onde importa.
    const bloco = deniedBlock(webhookCode);
    expect(bloco, "o bloco de negação não usa a constante").toContain("AI_BUDGET_HANDOFF_REASON");

    // PRESENÇA NÃO É EXCLUSIVIDADE. Reduzir a cadeia inteira a
    // `const handoffReason = AI_BUDGET_HANDOFF_REASON;` mantinha a constante no
    // bloco e a suíte verde — e faz o operador ler "franquia esgotada" num
    // fail-closed técnico (preço desconhecido, usage irresolvido), que é
    // exatamente a afirmação que a razão própria existe para impedir.
    const razoes = [...bloco.matchAll(/handoffReason = ([^;\n]+);/g)].map((m) => m[1].trim());
    expect(
      new Set(razoes).size,
      "as variantes de negação compartilham a mesma razão de handoff",
    ).toBeGreaterThanOrEqual(3);
    const iCadeia = bloco.indexOf("handoffReason");
    const iFranquia = bloco.indexOf("handoffReason = AI_BUDGET_HANDOFF_REASON");
    expect(iFranquia, "a razão da franquia sumiu da cadeia").toBeGreaterThan(-1);
    expect(
      bloco.slice(iCadeia, iFranquia),
      "a razão da franquia é escolhida sem passar por um teste de hardStop",
    ).toMatch(/if \([^)]*hardStop[^)]*\)/);
  });

  it("o auto-resolve consulta o núcleo em vez de comparar idade cru", () => {
    // Devolver a conversa para uma IA que não pode responder é o defeito; quem
    // sabe disso é o núcleo, e ele precisa do estado do orçamento para saber.
    // A forma de CHAMADA, de novo: o nome sozinho vem do import.
    expect(webhookCode, "o núcleo é importado mas não chamado").toMatch(
      /shouldAutoResolveHandoff\(\{/,
    );
    expect(webhookCode, "a comparação crua de idade voltou").not.toMatch(
      /handoffAge\s*>\s*HANDOFF_AUTO_RESOLVE_MS/,
    );
    // ORIGEM, NÃO PRESENÇA. É letra por letra o defeito que `budgetExhaustedNow`
    // já teve nesta task: reduzir o bloco inteiro a
    // `const budgetStillExhausted = false;` mantém a chave no lugar e a suíte
    // verde. A consequência é um laço: o handoff por franquia esgotada volta
    // para `ai_active` por decurso de prazo, o cliente recebe "Voltei a te
    // atender por aqui", a próxima inbound bate no hard stop e tudo se repete de
    // 12 em 12 horas — com a IA devolvida a um estado em que não pode responder.
    const passado = webhookCode.match(/budgetExhausted:\s*([A-Za-z_$][\w$]*)\s*,/);
    expect(passado, "o núcleo decide sem saber se o orçamento esgotou").not.toBeNull();
    const estado = passado![1];
    expect(["true", "false"], "o estado do orçamento virou literal").not.toContain(estado);
    const origem = atribuicoesDe(estado).find((a) => a.valor.includes('"EXHAUSTED"'));
    expect(
      origem,
      `${estado} nunca é comparado com "EXHAUSTED" — a origem do estado sumiu`,
    ).toBeDefined();
    const raiz = origem!.valor.match(/^([A-Za-z_$][\w$]*)/);
    expect(raiz, "a comparação não parte de uma variável").not.toBeNull();
    // E essa variável é a franquia REALMENTE lida — não outro objeto à mão.
    const lidas = [...webhookCode.matchAll(/([A-Za-z_$][\w$]*) = await loadAiFranchise\(/g)].map(
      (m) => m[1],
    );
    expect(lidas, `${raiz![1]} não vem de loadAiFranchise`).toContain(raiz![1]);
  });

  it("a franquia só entra quando o entitlement resolve por franchise", () => {
    // Override vitalício (Ren Sushi), carteira legada e BYOK puro NÃO entram.
    // Sobre o CÓDIGO: a prosa cita a fonte de propósito, e citar não é decidir.
    expect(webhookCode).toMatch(/ai\.source\s*===\s*"franchise"/);
    // E a abertura do orçamento fica DENTRO desse gate.
    expect(blocoDe("if (isFranchise)"), "a reserva do turno saiu do gate da franquia").toContain(
      "openTurnBudget(",
    );
  });

  it("a leitura degradada de entitlement é TELEMETRADA, não silenciosa", () => {
    // `readFailed` resolve com os defaults de quem não leu: a franquia deixa de
    // ser reconhecida e o turno roda sem ganchos e sem medição. Negar é decisão
    // comercial e não é desta task; ficar invisível não é decisão nenhuma.
    const bloco = blocoDe("if (entitlements.readFailed)");
    expect(bloco, "a leitura degradada não deixa rastro").toContain("jsonLog");
    expect(bloco, "a leitura degradada passou a NEGAR — decisão comercial, não desta task")
      .not.toContain("return new Response");
  });

  it("preço desconhecido falha FECHADO na porta de abertura, inclusive em observação", () => {
    // Duas portas para a MESMA ignorância não podem ter políticas opostas: o
    // `beforeCall` do adapter nega preço desconhecido em qualquer modo, e a
    // porta de abertura precisa dizer o mesmo. Sem preço não há `price_id`
    // (NOT NULL) e o evento não pode existir.
    const i = webhookCode.indexOf("const failClosed");
    expect(i, "a porta de abertura não distingue preço desconhecido").toBeGreaterThan(-1);
    const stmt = statementFrom(webhookCode, i);
    expect(stmt, "preço desconhecido deixou de ser motivo próprio").toContain('"price_unknown"');
    expect(
      stmt,
      "preço desconhecido virou conjunção com a flag — abrandado em observação",
    ).toMatch(/opened\.enforced\s*\|\|/);
  });

  it("o hard stop anterior ao turno também respeita o modo observação", () => {
    // Com a flag OFF nenhuma negação COMERCIAL acontece: `openTurnBudget`
    // devolve UNMETERED em vez de EXHAUSTED. Esta porta é mais curta e chega
    // antes — sem a mesma disciplina, a organização que estourou o teto é
    // bloqueada pelo atalho e o modo que existe para MEDIR antes de bloquear
    // nunca mede nada justamente dela.
    // E a condição vem do ENTITLEMENT, não de um literal: `= false` desligaria
    // esta porta inteira com o `if` intacto.
    const origem = webhookCode.match(/const budgetExhaustedNow = ([^;]+);/);
    expect(origem, "o hard stop anterior ao turno perdeu a origem").not.toBeNull();
    expect(origem![1], "o teto deixou de vir do entitlement").toContain(
      "!entitlements.ai.allowed",
    );
    expect(origem![1], "o teto deixou de ser exclusivo da franquia").toContain("isFranchise");

    const i = webhookCode.indexOf("if (budgetExhaustedNow");
    expect(i, "o hard stop anterior ao turno sumiu").toBeGreaterThan(-1);
    // CONJUNÇÃO, não presença: trocar `&&` por `||` mantém a string dentro do
    // `if` e passa a negar em modo observação — exatamente o defeito que este
    // caso existe para impedir.
    expect(
      parenBlock(webhookCode, i),
      "o hard stop mais curto nega sem exigir o gate ligado",
    ).toMatch(/budgetExhaustedNow\s*&&[\s\S]*ai_wallet_enforced/);

    // E o CORPO. Esta porta tinha caso só sobre a condição: apagar o handoff
    // ficava verde, e com ele a conversa segue `ai_active` — o cliente ouve que
    // o atendimento parou e o restaurante nunca vê a conversa na fila.
    exigeHardStopCompleto(blocoDe("if (budgetExhaustedNow"), "o hard stop do entitlement");
  });

  it("o texto de instabilidade vive numa constante só", () => {
    // Ele é enviado em três desfechos E precisa estar no filtro de ruído.
    // Redigitado, editar um sem os outros faz a mensagem escapar do filtro e
    // poluir o histórico das invocações seguintes.
    const ocorrencias = [...webhookCode.matchAll(/Tive um instante de instabilidade aqui/g)];
    expect(ocorrencias.length, "o texto voltou a ser redigitado").toBe(1);
    const stmt = statementFrom(webhookCode, webhookCode.indexOf("const HARDCODED_AGENT_NOISE"));
    expect(stmt, "a constante não entrou no filtro de ruído").toContain("AGENT_INSTABILITY_TEXT");
  });

  it("o texto determinístico NÃO passa por sanitizeForWhatsApp", () => {
    // sanitizeForWhatsApp aplica-se só a saída de LLM.
    const chamadas = [...webhookCode.matchAll(/sanitizeForWhatsApp\(([^)]*)\)/g)];
    expect(chamadas.length, "nenhuma sanitização encontrada — o detector quebrou").toBeGreaterThan(0);
    for (const m of chamadas) {
      expect(m[1]).not.toMatch(/AI_BUDGET_|stopText|errText/);
    }
  });

  it("negação por orçamento não repete ferramenta mutante nem dá retry integral", () => {
    const block = deniedBlock(webhookCode);
    expect(block, "a negação ignora que uma ferramenta mutante rodou").toContain("mutatingToolUsed");
    expect(block, "as três situações de ferramenta mutante viraram uma frase só").toContain(
      "resolveMutationStopText",
    );
    expect(block, "o turno seria refeito — a chamada negada é justamente a que faltava").not.toContain(
      "runOnce()",
    );
    expect(block, "a negação não encerra o turno").toContain("return new Response");
  });

  it("a variante ERROR não é tratada como franquia esgotada", () => {
    const block = deniedBlock(webhookCode);
    expect(block, "a distinção comercial não é consultada").toContain("isCommercialHardStop(");
    expect(block, "a distinção comercial foi redigitada no webhook").not.toMatch(
      /kind\s*===\s*"DENY_BUDGET"/,
    );
    // E a copy de franquia é EXCLUSIVA do hard stop: falha técnica não pode
    // dizer ao cliente que a franquia acabou.
    const copy = block.indexOf("AI_BUDGET_EXHAUSTED_CUSTOMER_TEXT");
    expect(copy, "o texto de franquia sumiu do bloco").toBeGreaterThan(-1);
    // A PARTIR DA CADEIA DE COPY, não do início do bloco: `const hardStop = …` e
    // o `if` da razão de handoff já põem a palavra lá em cima sozinhos, e com
    // isso um `let stopText = AI_BUDGET_EXHAUSTED_CUSTOMER_TEXT;` no topo da
    // cadeia ficava verde — dizendo ao CLIENTE que a franquia acabou quando o
    // que houve foi preço desconhecido ou usage irresolvido.
    const cadeia = block.indexOf("stopText");
    expect(cadeia, "a cadeia de copy sumiu").toBeGreaterThan(-1);
    expect(cadeia, "o texto de franquia é escolhido antes da cadeia de copy").toBeLessThan(copy);
    expect(
      block.slice(cadeia, copy),
      "o texto de franquia é escolhido sem passar por um teste de hardStop",
    ).toMatch(/if \([^)]*hardStop[^)]*\)/);
  });

  it("cada variante emite telemetria própria", () => {
    // SOBRE O BLOCO, não sobre o arquivo: `webhook.toContain("telemetryEventFor")`
    // é satisfeito pela linha de IMPORT sozinha — apagar a chamada e manter o
    // import deixava este caso verde com um `evt` fixo no lugar, que é
    // exatamente a diferença entre as variantes que o boolean apagava.
    const block = deniedBlock(webhookCode);
    expect(block, "a negação emite um evento único para todas as variantes").toContain(
      "telemetryEventFor(decision)",
    );
  });

  it("o resolvePrice do READY é repassado aos ganchos — um resolvedor por turno", () => {
    // Sem o repasse, a estimativa da reserva e o ledger voltam a ter DOIS caches
    // independentes e podem falar de vigências diferentes. `makeBudgetHooks`
    // aceita o campo opcional e cria um próprio quando ele falta: a regressão é
    // silenciosa, e é por isso que ela precisa de caso.
    const i = webhookCode.indexOf("makeBudgetHooks(");
    expect(i, "os ganchos não são montados").toBeGreaterThan(-1);
    const args = parenBlock(webhookCode, i);
    const budgetExpr = args.match(/budget:\s*([A-Za-z_$][\w$.]*)/);
    const priceExpr = args.match(/resolvePrice:\s*([A-Za-z_$][\w$.]*)/);
    expect(budgetExpr, "os ganchos não recebem a reserva do turno").not.toBeNull();
    expect(priceExpr, "os ganchos não recebem o resolvedor de preço do turno").not.toBeNull();
    // MESMA origem: o `READY` que trouxe a reserva é o que traz o preço. Um
    // `makePriceCache(supabase)` novo aqui satisfaria a presença da chave e
    // reintroduziria exatamente os dois caches independentes.
    expect(
      priceExpr![1].split(".")[0],
      "o resolvedor não vem do mesmo READY que a reserva",
    ).toBe(budgetExpr![1].split(".")[0]);
  });

  it("o READY é GUARDADO — construir e ligar não bastam se ninguém guarda o dado", () => {
    // MESMA CLASSE DO FIO PARA O LAÇO, um degrau adiante. Apagar
    // `turnBudget = opened.budget;` deixa os seis call sites de liquidação no
    // lugar, o texto que este guardrail lê idêntico, e `settleTurnBudget` vira
    // no-op PERMANENTE: todo turno liquida zero e o custo real some do teto
    // pela varredura de expiradas. Nem o eslint nem o `tsc -b` denunciam — este
    // arquivo nem é alcançado por ele.
    const ready = readyBlock();
    const porta = blocoDe("const settleTurnBudget = async");

    // As variáveis que a PORTA lê, extraídas dela — não redigitadas aqui, senão
    // renomear uma delas deixaria o caso medindo um nome que não existe mais.
    const guarda = porta.match(/if \(!([A-Za-z_$][\w$]*) \|\| !([A-Za-z_$][\w$]*)\) return;/);
    expect(guarda, "a porta única não guarda mais o estado da reserva").not.toBeNull();
    const [, varReserva, varOrg] = guarda!;

    // 1. A reserva do READY é guardada NA variável que a porta lê.
    expect(ready, `o READY não guarda a reserva em ${varReserva}`).toMatch(
      new RegExp(`${varReserva} = opened\\.budget;`),
    );
    // 2. E o tenant junto — sem ele a guarda da porta recusa tudo.
    expect(ready, `o READY não guarda a organização em ${varOrg}`).toMatch(
      new RegExp(`${varOrg} = [A-Za-z_$][\\w$]*;`),
    );
    // 3. Os ganchos são construídos aqui dentro.
    expect(ready, "os ganchos não são construídos no READY").toContain("makeBudgetHooks(");

    // NADA MAIS sobrescreve esses TRÊS — e "três" tem de ser três: a porta
    // guarda com `||`, então anular só o tenant desliga a liquidação inteira
    // com o mesmo silêncio de anular a reserva. Um `budgetHooks = undefined;`
    // entre a construção e o laço faz o mesmo do outro lado.
    const [pa, pb] = braceBlock(webhookCode, webhookCode.indexOf("const settleTurnBudget = async"));
    const naPorta = (i: number) => i > pa && i < pb;

    for (const [nome, origem] of [
      [varReserva, "opened.budget"],
      [varOrg, null],
    ] as Array<[string, string | null]>) {
      const escritas = atribuicoesDe(nome);
      expect(escritas.length, `${nome} nunca é guardado`).toBeGreaterThan(0);
      if (origem) {
        expect(
          escritas.some((a) => a.valor === origem),
          `${nome} nunca recebe ${origem}`,
        ).toBe(true);
      }
      for (const a of escritas) {
        if (a.valor === origem) continue;
        // Fora da origem, só o zerar — e só dentro da porta única.
        if (a.valor === "null") {
          expect(
            naPorta(a.index),
            `${nome} é zerado fora da porta única (índice ${a.index})`,
          ).toBe(true);
          continue;
        }
        // Qualquer outro valor tem de estar no bloco READY: é onde o dado nasce.
        expect(
          ready.includes(`${nome} = ${a.valor};`),
          `${nome} recebe "${a.valor}" fora do READY (índice ${a.index})`,
        ).toBe(true);
      }
    }
    const ganchos = atribuicoesDe("budgetHooks");
    expect(ganchos.length, "os ganchos são atribuídos mais de uma vez, ou nenhuma").toBe(1);
    expect(ganchos[0].valor, "os ganchos deixaram de vir do adapter").toMatch(/^makeBudgetHooks\(/);
  });

  it("a corrida entre a resolução e a reserva tem hard stop PRÓPRIO", () => {
    // Neutralizar este ramo não deixa a organização esgotada sem resposta: faz
    // ela cair no `else` de ERROR, onde `sanitizedCode` e `enforced` são
    // `undefined` — logo `failClosed` é falso e o turno roda SEM ganchos e SEM
    // medição. O pior desfecho possível, com zero sinal.
    const anc = 'if (opened.kind === "EXHAUSTED")';
    expect(webhookCode.indexOf(anc), "o hard stop da reserva sumiu").toBeGreaterThan(-1);
    // Mesmas quatro obrigações da porta irmã, e pelo STATEMENT de cada escrita:
    // `toContain` no bloco inteiro fica verde quando sobra só o append no
    // histórico e o cliente não recebe nada.
    exigeHardStopCompleto(blocoDe(anc), "a corrida entre resolução e reserva");
    // E ele decide ANTES do READY: depois, o valor já teria caído noutro ramo.
    expect(
      webhookCode.indexOf(anc),
      "o hard stop da reserva perdeu a precedência",
    ).toBeLessThan(webhookCode.indexOf('if (opened.kind === "READY")'));
  });

  it("o resultado do laço é CAPTURADO — sem isso a negação nunca é vista", () => {
    // `await runOnce();` sem capturar deixa o texto `agentOutcome.kind ===
    // "DENIED"` intacto e mata, em silêncio, o handoff, a copy determinística,
    // o outcome `ai_budget_exhausted` e a telemetria por variante.
    const capturas = atribuicoesDe("agentOutcome");
    expect(
      capturas.some((a) => /await runOnce\(\)/.test(a.valor)),
      "o resultado do laço não é capturado",
    ).toBe(true);
  });

  it("o tenant e a identidade do turno atravessam as duas portas iguais", () => {
    // `organizationId` vai por POSIÇÃO/atalho para as duas: trocá-lo por
    // `conv.id` falha relativamente fechado, mas é a única superfície
    // multi-tenant do caminho novo. E `turnId` divergente entre a reserva e os
    // ganchos quebra a correlação entre a chave de idempotência e os
    // `ai_usage_events` do mesmo turno.
    const abre = parenBlock(webhookCode, webhookCode.indexOf("openTurnBudget("));
    const ganchos = parenBlock(webhookCode, webhookCode.indexOf("makeBudgetHooks("));
    for (const [nome, args] of [["openTurnBudget", abre], ["makeBudgetHooks", ganchos]] as const) {
      expect(args, `${nome} não recebe o tenant pelo atalho de propriedade`).toMatch(
        /[{\s]organizationId\s*,/,
      );
      expect(args, `${nome} não recebe a identidade do turno`).toMatch(/[{\s]turnId\s*,/);
    }
    // E o tenant guardado para a liquidação é o MESMO — não `conv.id`.
    expect(webhookCode, "o tenant da liquidação não vem da organização").toMatch(
      /turnBudgetOrgId = organizationId;/,
    );

    // As leituras que ALIMENTAM a decisão também são escopadas pela
    // organização: orçamento lido de outro tenant nunca esgota, e entitlement
    // de outro tenant decide sobre a franquia errada.
    const leituras = [...webhookCode.matchAll(/loadAiFranchise\(/g)];
    expect(leituras.length, "nenhuma leitura de franquia — o detector quebrou").toBeGreaterThan(0);
    for (const m of leituras) {
      expect(
        parenBlock(webhookCode, m.index!),
        `leitura de franquia fora do escopo da organização (índice ${m.index})`,
      ).toContain("organizationId");
    }
    expect(
      parenBlock(webhookCode, webhookCode.indexOf("resolveOrgEntitlements(")),
      "o entitlement é resolvido para outro tenant",
    ).toContain("organizationId");
  });

  it("o estado da franquia viaja de ponta a ponta — cada elo é uma atribuição", () => {
    // Andando pelo DADO, não pelo texto: franquia lida → entitlement resolvido
    // → orçamento aberto → reserva guardada → ganchos no laço → liquidação.
    // Os elos 4 e 5 têm casos próprios; aqui ficam os dois primeiros e a
    // identidade do turno.
    // TODAS as leituras: o auto-resolve do handoff tem a sua, e ela não é a que
    // alimenta o entitlement — casar só a primeira mediria a errada.
    const lidas = [...webhookCode.matchAll(/([A-Za-z_$][\w$]*) = await loadAiFranchise\(/g)].map(
      (m) => m[1],
    );
    expect(lidas.length, "o estado do orçamento não é lido").toBeGreaterThan(0);
    const args = parenBlock(webhookCode, webhookCode.indexOf("resolveOrgEntitlements("));
    expect(
      lidas.some((v) => args.includes(v)),
      "o entitlement é resolvido SEM o estado do orçamento — a franquia nunca esgota",
    ).toBe(true);

    // `turn_id` é a chave de idempotência da reserva. Fixo, dois turnos
    // reutilizariam a MESMA reserva; sem `requestId` ele não é único por
    // invocação.
    const turnId = webhookCode.match(/const turnId = ([^;]+);/);
    expect(turnId, "o turno perdeu identidade").not.toBeNull();
    expect(turnId![1], "o turno não é único por invocação").toContain("requestId");
  });

  it("toda ferramenta mutante classifica o desfecho para a copy", () => {
    // Sem a classificação, `lastMutationOutcome` fica em UNKNOWN — direção
    // segura, mas a distinção das três situações de §17.7.4 morre em silêncio.
    // E `mutatingToolUsed` é o que desliga o retry: sem ele, reserva duplicada.
    for (const tool of ["create_reservation", "update_reservation", "cancel_reservation"]) {
      const i = webhookCode.indexOf(`case "${tool}":`);
      expect(i, `a ferramenta ${tool} sumiu`).toBeGreaterThan(-1);
      const caso = webhookCode.slice(i, webhookCode.indexOf("break;", i));
      expect(caso, `${tool} não desliga o retry silencioso`).toContain("mutatingToolUsed = true");
      expect(caso, `${tool} não classifica o desfecho`).toContain("lastMutationOutcome =");
    }
  });

  it("a reserva é finalizada em TODOS os desfechos do turno", () => {
    // CONTAGEM NÃO É UNIVERSALIDADE. `settles.length >= 3` com quatro
    // ocorrências tolera perder qualquer uma — e a que se perdeu na sabotagem
    // foi a do caminho de SUCESSO, a mais load-bearing de todas. Cada desfecho
    // é preso pelo seu próprio recorte sintático.
    //
    // Enquanto a reserva fica HELD o consumido não é `settled_cents`, e só
    // `finalize_ai_reservation` incrementa esse campo: a varredura de expiradas
    // marca EXPIRED sem tocá-lo. Desfecho que não liquida não atrasa a
    // contabilidade — apaga o custo do teto.
    const desfechos: Array<[string, string, string]> = [
      ["negação de orçamento", deniedBlock(webhookCode), '"SETTLED"'],
      ["falha do provedor", blocoDe("if (agentError) {"), '"RELEASED"'],
      ["resposta vazia", blocoDe("if (!finalText || !finalText.trim())"), '"RELEASED"'],
      ["falha de envio ao WhatsApp", blocoDe("if (!sendRes.ok)"), '"SETTLED"'],
      ["sucesso", trechoSucesso(), '"SETTLED"'],
      ["exceção não tratada", catchExterno(), '"RELEASED"'],
    ];
    for (const [nome, bloco, status] of desfechos) {
      expect(bloco, `o desfecho "${nome}" não liquida a reserva`).toContain("settleTurnBudget(");
      expect(bloco, `o desfecho "${nome}" liquida com o rótulo errado`).toContain(
        `settleTurnBudget(${status})`,
      );
    }
    // ORDEM: DINHEIRO ANTES DE TELEMETRIA. `finish` carimba `processed_messages`
    // como concluída e a reentrega do provedor passa a ser deduplicada — morrer
    // entre o `finish` e a liquidação apaga o custo do teto para sempre,
    // enquanto morrer entre a liquidação e o `finish` custa só o registro, que é
    // reconstituível. (A ordem inversa chegou a ser escrita para proteger o
    // registro de uma exceção da liquidação; `settleTurnBudget` não lança —
    // engole o erro da RPC e volta —, então não havia registro em risco.)
    for (const [nome, bloco] of desfechos) {
      const iFinish = bloco.indexOf("finish(");
      const iSettle = bloco.indexOf("settleTurnBudget(");
      expect(iFinish, `o desfecho "${nome}" não registra a execução`).toBeGreaterThan(-1);
      expect(iSettle, `o desfecho "${nome}" não liquida`).toBeGreaterThan(-1);
      expect(
        iSettle,
        `o desfecho "${nome}" registra antes de liquidar — telemetria na frente do dinheiro`,
      ).toBeLessThan(iFinish);
    }
    // No catch externo, a liquidação vem antes até do lock: soltá-lo com a
    // reserva ainda HELD deixa uma inbound irmã abrir orçamento novo contra
    // capacidade que ainda está comprometida.
    const excecao = catchExterno();
    expect(
      excecao.indexOf("settleTurnBudget("),
      "o lock é solto com a reserva ainda pendurada",
    ).toBeLessThan(excecao.indexOf("releaseAiLock()"));

    // A liquidação passa por UMA porta, e é ela quem fala com o adapter — para
    // que "todo desfecho liquida" seja uma regra, não seis cópias.
    const porta = blocoDe("const settleTurnBudget = async");
    expect(porta, "a porta única não finaliza de verdade").toContain("finalizeTurn(");
    expect(porta, "a porta única não registra marcos").toContain("recordMilestones(");
    const fora = [...webhookCode.matchAll(/finalizeTurn\(/g)];
    expect(fora.length, "voltou a haver finalização fora da porta única").toBe(1);

    // E a porta não pode ser NEUTRALIZADA. `if (true) return;` no topo desliga
    // as seis liquidações de uma vez e deixa idêntico todo o texto que este
    // guardrail lê — a regra "todo desfecho liquida" vira teatro sem que nenhum
    // recorte perceba. A única saída antes do finalize é a guarda de tenant.
    const antesDoFinalize = porta.slice(0, porta.indexOf("finalizeTurn("));
    expect(
      [...antesDoFinalize.matchAll(/\breturn\b/g)].length,
      "há saída extra antes da liquidação — a porta pode ser neutralizada",
    ).toBe(1);
  });

  it("todo retorno posterior à reserva liquida — a lista de desfechos é exaustiva", () => {
    // O caso acima prende SEIS blocos PELO NOME. Enumeração correta hoje não é
    // regra: um `return new Response(...)` novo entre a reserva e os desfechos,
    // com `finish` e sem liquidar, ficava verde — e cada turno que saísse por
    // ele deixaria a reserva HELD, para a varredura marcar EXPIRED sem tocar
    // `settled_cents`. Aqui a pergunta é sobre TODO retorno depois da abertura.
    const reserva = webhookCode.indexOf("openTurnBudget(");
    expect(reserva, "a abertura do orçamento sumiu").toBeGreaterThan(-1);
    const retornos = [...webhookCode.matchAll(/return new Response\(/g)]
      .map((m) => m.index!)
      .filter((i) => i > reserva);

    // Os DOIS isentos: neles a RPC recusou a reserva, então não existe
    // `reservation_id` para finalizar. Recortados pelos próprios blocos — se
    // algum dia passarem a receber um id, entram na regra.
    const isentos = [
      braceBlock(webhookCode, webhookCode.indexOf('if (opened.kind === "EXHAUSTED")')),
      braceBlock(webhookCode, webhookCode.indexOf("if (failClosed)")),
    ];
    const isento = (i: number) => isentos.some(([a, b]) => i > a && i < b);

    expect(retornos.length, "a lista de retornos posteriores à reserva mudou").toBe(8);
    expect(retornos.filter(isento).length, "os isentos deixaram de ser dois").toBe(2);

    // O trecho que LEVA a cada retorno é o que vai do retorno anterior (ou da
    // abertura) até ele: um retorno novo inserido no meio parte o trecho em
    // dois, e o pedaço novo não tem liquidação nenhuma.
    let anterior = reserva;
    for (const i of retornos) {
      const trecho = webhookCode.slice(anterior, i);
      anterior = i;
      if (isento(i)) {
        expect(
          trecho,
          `um desfecho sem reserva passou a liquidar (índice ${i})`,
        ).not.toContain("settleTurnBudget(");
        continue;
      }
      expect(trecho, `retorno sem liquidação no índice ${i}`).toContain("settleTurnBudget(");
    }
  });

  it("liquidação que falha NÃO apaga o estado, e não passa em silêncio", () => {
    // Zerar antes do `await` fazia de uma RPC que falha um custo perdido para
    // sempre: ninguém mais tentava — nem o catch externo, porque o estado já
    // tinha sido apagado —, a reserva ficava HELD, a varredura marcava EXPIRED
    // e o consumido real sumia do teto. Dupla liquidação continua impossível
    // pela própria RPC, que devolve sem redebitar quando o status não é HELD.
    const porta = blocoDe("const settleTurnBudget = async");
    const guardaEntrada = porta.match(/if \(!([A-Za-z_$][\w$]*) \|\| !([A-Za-z_$][\w$]*)\) return;/);
    expect(guardaEntrada, "a porta única não guarda mais o estado").not.toBeNull();
    const varReserva = guardaEntrada![1];

    const chamada = porta.indexOf("finalizeTurn(");
    const confere = porta.indexOf("if (!fin)");
    const zera = porta.indexOf(`${varReserva} = null;`);
    expect(chamada, "a porta não finaliza").toBeGreaterThan(-1);
    expect(confere, "o retorno da liquidação não é conferido").toBeGreaterThan(chamada);
    expect(zera, "a porta nunca zera o estado — a liquidação repetiria").toBeGreaterThan(-1);

    // FORA do ramo de falha, não apenas depois do índice dele. Mover as duas
    // linhas do zerar para DENTRO do `if (!fin)` satisfaz "vem depois" e
    // restaura o defeito inteiro — falha apaga o estado, sucesso não zera — com
    // o comentário sobrevivendo ao lado, mentindo.
    const [fa, fb] = braceBlock(porta, confere);
    expect(
      zera > fa && zera < fb,
      "o zerar foi para dentro do ramo de falha — a falha volta a apagar o estado",
    ).toBe(false);
    expect(
      zera,
      "o estado é apagado antes de a liquidação ser confirmada — a falha vira custo perdido",
    ).toBeGreaterThan(fb);

    const ramoFalha = porta.slice(fa, fb);
    expect(ramoFalha, "a falha segue para o zerar em vez de sair").toContain("return");
    expect(ramoFalha, "liquidação que não aplicou passa em silêncio").toContain("jsonLog");

    // O RÓTULO chega ao adapter: com um literal fixo aqui dentro, as seis
    // asserções de `settleTurnBudget("…")` viram teatro.
    // O cabeçalho fica FORA do recorte (a porta começa no `{` do corpo).
    const param = webhookCode.match(/const settleTurnBudget = async \((\w+):/);
    expect(param, "a porta perdeu o parâmetro de rótulo").not.toBeNull();
    const argsFinalize = parenBlock(porta, chamada);
    // Atalho de propriedade (`{ …, status }`) ou explícito — o que não pode é um
    // literal fixo, que faria das seis asserções de rótulo puro teatro.
    expect(argsFinalize, "o rótulo é descartado pela porta").toMatch(
      new RegExp(`status:\\s*${param![1]}\\b|[{,]\\s*${param![1]}\\s*[,}]`),
    );

    // E os marcos saem dos números REAIS do ciclo, não de zero: com
    // `settledCents: 0` nenhum marco cruza e o alerta de 100% morre.
    const recebe = porta.match(/const (\w+) = await finalizeTurn\(/);
    expect(recebe, "o resultado da liquidação não é capturado").not.toBeNull();
    const argsMarcos = parenBlock(porta, porta.indexOf("recordMilestones("));
    expect(argsMarcos, "os marcos não usam o liquidado real do ciclo").toContain(
      `settledCents: ${recebe![1]}.settledCents`,
    );
    expect(argsMarcos, "os marcos não usam o limite real do ciclo").toContain(
      `limitCents: ${recebe![1]}.limitCents`,
    );

    // E as duas escritas são escopadas pelo tenant GUARDADO com a reserva, não
    // por outro id qualquer que esteja à mão — é a última fronteira
    // multi-tenant do caminho, já dentro do dinheiro.
    const varOrg = guardaEntrada![2];
    const captura = porta.match(new RegExp(`const (\\w+) = ${varOrg};`));
    expect(captura, "a porta não captura o tenant da reserva").not.toBeNull();
    for (const [nome, args] of [["a liquidação", argsFinalize], ["os marcos", argsMarcos]] as const) {
      expect(args, `${nome} não é escopada pelo tenant da reserva`).toContain(
        `organizationId: ${captura![1]}`,
      );
    }
    // IDENTIDADE, NÃO PRESENÇA — e são justamente os dois identificadores que
    // endereçam o dinheiro. A checagem anterior aceitava qualquer coisa:
    // `reservationId: turnId`, `reservationId: cycleId` e
    // `reservationId: requestId` passavam os três com a suíte inteira verde,
    // enquanto as outras três chaves das MESMAS duas chamadas já eram presas
    // por identidade.
    //
    // Com id errado, `finalize_ai_reservation` cai em RESERVATION_NOT_FOUND
    // (migration 102), `finalizeTurn` devolve null, a porta loga
    // `ai_budget_settle_not_applied` e sai SEM zerar: a reserva real fica HELD
    // para sempre, a varredura marca EXPIRED sem tocar `settled_cents` e o
    // custo real de TODO turno some do teto. Uma linha de log por turno é o
    // único sinal.
    const idReserva = ligadoDe(porta, varReserva, "reservationId");
    const idCiclo = ligadoDe(porta, varReserva, "cycleId");
    expect(
      passaIdentidade(argsFinalize, "reservationId", idReserva),
      `a liquidação endereça outra coisa no lugar de ${idReserva}`,
    ).toBe(true);
    expect(
      passaIdentidade(argsMarcos, "cycleId", idCiclo),
      `os marcos endereçam outro ciclo no lugar de ${idCiclo}`,
    ).toBe(true);
  });

  it("o erro do provedor entra em webhook_executions SANITIZADO", () => {
    // A chave de IA é per-unit (BYOK) e o erro do provedor pode ecoar o request
    // com o header de autorização, ou a URL do Gemini com `?key=`. `String(err)`
    // aqui grava isso em `webhook_executions.error`.
    const atribuicoes = [...webhookCode.matchAll(/agentError = (?!null)([^;\n]+)/g)];
    expect(atribuicoes.length, "nenhuma atribuição de erro do agente — o detector quebrou")
      .toBeGreaterThan(0);
    for (const m of atribuicoes) {
      expect(m[1], "erro do provedor estringificado cru").toContain("sanitizeProviderError(");
    }
  });

  it("o hard stop NÃO desliga o canal nem toca no billing da organização", () => {
    // O WhatsApp continua recebendo, a conversa continua visível e o
    // atendimento humano continua possível. A única escrita é na conversa.
    const block = deniedBlock(webhookCode);
    for (const tabela of ["whatsapp_channels", "whatsapp_instances", "organizations", "units"]) {
      expect(block, `a negação escreve em ${tabela}`).not.toContain(`from("${tabela}")`);
    }
    expect(block, "a negação não registra o handoff na conversa").toContain('from("conversations")');
  });

  it("nenhum valor de custo, token ou limite é enviado ao cliente final", () => {
    const chamadas = [...webhookCode.matchAll(/sendOutbound\(/g)];
    expect(chamadas.length, "nenhum envio encontrado — o detector quebrou").toBeGreaterThan(0);
    for (const m of chamadas) {
      expect(
        statementFrom(webhookCode, m.index!),
        `envio com valor financeiro no índice ${m.index}`,
      ).not.toMatch(/settledCents|limitCents|budgetRemaining|reservedCents|estimated_cost|cost_brl/);
    }
  });

  it("budgetRemainingCents nunca sai numa resposta HTTP do webhook", () => {
    expect(webhook).not.toContain("budgetRemainingCents");
  });

  it("nenhuma contagem de conversa autoriza a IA", () => {
    expect(webhook).not.toMatch(/conversationCount|messageQuota|interactionLimit/);
  });

  it("controle positivo: o detector acha um símbolo que sabidamente existe", () => {
    expect(webhook.includes("MEDIA_REPLY_TEXT")).toBe(true);
    expect(webhook.includes("SIMBOLO_QUE_NAO_EXISTE")).toBe(false);
  });
});
