/**
 * Testes 46 e 47 da spec: o checklist de redeploy é EXATO ou não serve.
 *
 * Redeploy desnecessário não é inofensivo — ele treina a leitura de que o
 * checklist é aproximado, e o checklist só funciona enquanto for exato: é ele
 * que impede metade do sistema de rodar com `_shared/` velho em memória.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * REGRA DESTE ARQUIVO
 *
 * Nenhuma asserção aqui pode ser satisfeita por PROSA. Toda âncora é um marcador
 * sintático do Markdown — abertura de item (`- **\`nome.ts\`**`) ou cabeçalho
 * (`## ` / `### `) —, e todo conteúdo verificado é lido do BLOCO que esse
 * marcador delimita. Nenhum recorte é por janela de N caracteres, e nenhum caso
 * pergunta "esta string existe em algum lugar do documento".
 *
 * A razão é histórica e vale mais que a regra: as três primeiras versões destes
 * casos reproduziram, cada uma, uma das seis famílias de falso-verde que o
 * PRÓPRIO documento verificado cataloga (seção 7 de `PLANO-D-PENDENCIAS.md`).
 *
 *   1. `toMatch(/42/)` e `/44/` pretendiam prender "os testes 42 e 44 seguem
 *      PENDENTES". Estavam satisfeitas pela TABELA DE GATES do próprio
 *      documento, que traz `244 problemas (2 erros, 242 avisos)`. Apagar a seção
 *      1 INTEIRA ficava verde. (Família 5.)
 *   2. `toContain("ai-price-core.ts")` pretendia prender "tem linha própria no
 *      checklist". Cinco dos seis nomes também aparecem em prosa, então apagar o
 *      bullet ficava verde. (Corolário da seção 7, aplicado a prosa em vez de
 *      código.)
 *   3. `doc.slice(i, i + 400)` sangrava para o item vizinho. (Família 1.)
 *   4. A EXPLICAÇÃO do recorte foi escrita DENTRO do item que ela explica, e a
 *      palavra `webhook-whatsapp` dessa meta-prosa satisfazia sozinha a asserção
 *      sobre o item. (Família 5, na correção da 3.)
 *   5. O recorte de seção só conhecia `## `, e devolvia a seção 11 inteira para
 *      âncora em subseção: apagar a subseção "Acoplamento por string" ficava
 *      verde. (Família 1, um nível acima da 3.)
 *   6. `/migration[\s\S]{0,200}antes[\s\S]{0,200}deploy/i` era a última janela de
 *      tamanho fixo sobre o documento inteiro. Apagar a subseção "Ordem de
 *      aplicação" E plantar uma frase banal em outra seção ("qualquer migration
 *      futura deve ser revisada antes de ir para deploy") ficava VERDE.
 *      (Famílias 1 e 5 juntas.) É por isso que a sabotagem tem de ser com DECOY,
 *      não só por deleção: deleção pura dava vermelho e enganava.
 *
 * LIMITE CONHECIDO, declarado porque não fecha: asserção sobre TEXTO não
 * distingue afirmação de negação. Reescrever "seguem PENDENTES" como "NÃO seguem
 * mais PENDENTES" fica verde, porque a palavra sobrevive na negação. Nenhum
 * recorte sintático resolve isso — só leitura humana. Não é vendido aqui como
 * proteção.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const FUNCTIONS = join(__dirname, "..", "..", "supabase", "functions");
const PENDENCIAS = join(__dirname, "..", "..", "docs", "billing-asaas", "PLANO-D-PENDENCIAS.md");

/** CRLF normalizado: os recortes procuram `\n- ` e cabeçalhos em início de linha. */
const doc = readFileSync(PENDENCIAS, "utf8").replace(/\r\n/g, "\n");

function importersOf(shared: string): string[] {
  const out: string[] = [];
  for (const dir of readdirSync(FUNCTIONS)) {
    if (dir.startsWith("_")) continue;
    const idx = join(FUNCTIONS, dir, "index.ts");
    try {
      if (!statSync(idx).isFile()) continue;
    } catch {
      continue;
    }
    if (readFileSync(idx, "utf8").includes(`../_shared/${shared}`)) out.push(dir);
  }
  return out.sort();
}

// ─── Recortes por fronteira sintática do Markdown ───────────────────────────

type Nivel = 2 | 3;

interface Cabecalho {
  nivel: Nivel;
  titulo: string;
  inicio: number;
}

function cabecalhos(src: string): Cabecalho[] {
  return [...src.matchAll(/^(#{2,3}) (.+)$/gm)].map((m) => ({
    nivel: m[1].length as Nivel,
    titulo: m[2].trim(),
    inicio: m.index!,
  }));
}

/**
 * O bloco governado por UM cabeçalho, identificado pelo TÍTULO — não pela
 * primeira ocorrência de uma string qualquer no documento.
 *
 * O nível importa: um bloco de nível 2 **inclui** suas subseções `###` e só
 * termina no próximo `## `. Sem isso, subdividir uma seção longa com um `###`
 * — a edição mais provável que este documento vai sofrer — truncava o recorte e
 * reprovava por motivo que o leitor não adivinharia.
 *
 * A âncora é o título porque ele é estável sob acréscimo de texto. Ancorar na
 * primeira menção de "Teste 42" fazia um cross-reference legítimo no preâmbulo
 * ("ver seção 1") reprovar o caso, com mensagem apontando a causa errada.
 */
function secaoDe(src: string, nivel: Nivel, chave: string): string {
  const todos = cabecalhos(src);
  const casam = todos.filter((h) => h.nivel === nivel && h.titulo.includes(chave));
  expect(
    casam.length,
    `esperava exatamente 1 cabeçalho de nível ${nivel} contendo "${chave}", achei ${casam.length}`,
  ).toBe(1);
  const atual = casam[0];
  // Fronteira: o próximo cabeçalho de nível MENOR OU IGUAL. Nível 3 termina em
  // `##` ou `###`; nível 2 só em `##`, e portanto engloba seus `###`.
  const seguinte = todos.find((h) => h.inicio > atual.inicio && h.nivel <= nivel);
  return src.slice(atual.inicio, seguinte ? seguinte.inicio : src.length);
}

const secao = (nivel: Nivel, chave: string) => secaoDe(doc, nivel, chave);

/**
 * O item de lista aberto pela âncora: do `- ` que o abre até o próximo `- ` de
 * mesmo nível ou a próxima linha em branco — o que vier primeiro.
 *
 * A âncora é sempre a ABERTURA do item (`- **\`nome\`**`), nunca uma string que
 * também possa aparecer em prosa: é o que torna o caso imune a cross-reference
 * acrescentado noutra seção.
 */
function itemDe(src: string, abertura: string): string {
  const i = src.indexOf(abertura);
  expect(i, `item de lista não encontrado (a âncora é a abertura dele): ${abertura}`)
    .toBeGreaterThan(-1);
  const candidatos = [src.indexOf("\n- ", i + 1), src.indexOf("\n\n", i)].filter((n) => n > -1);
  const fim = candidatos.length ? Math.min(...candidatos) : src.length;
  return src.slice(i, fim);
}

const item = (abertura: string) => itemDe(doc, abertura);

// ─── Controles dos recortes, sobre fonte sintética ──────────────────────────

const MD_SINT = `# t

## A — primeira
alfa
### A1 — filha
beta btree
## B — segunda
gama

### B1 — filha de B
delta
- **\`x.ts\`** alvo
- **\`y.ts\`** vizinho

fim
`;

describe("controles dos recortes de Markdown", () => {
  it("bloco de nível 2 INCLUI suas subseções e para no próximo `## `", () => {
    const a = secaoDe(MD_SINT, 2, "A — primeira");
    expect(a, "a subseção filha foi cortada — subdividir reprovaria").toContain("beta btree");
    expect(a, "o recorte vazou para a seção seguinte").not.toContain("gama");
  });

  it("bloco de nível 3 para no próximo cabeçalho, de qualquer nível", () => {
    const a1 = secaoDe(MD_SINT, 3, "A1 — filha");
    expect(a1).toContain("beta btree");
    expect(a1, "o recorte de subseção vazou para a seção irmã").not.toContain("gama");
  });

  it("âncora ambígua ou ausente é erro do caso, não verde silencioso", () => {
    expect(() => secaoDe(MD_SINT, 2, "filha")).toThrow(); // nível errado → 0 casam
    expect(() => secaoDe(MD_SINT, 3, "filha")).toThrow(); // A1 e B1 → 2 casam
  });

  it("item de lista devolve UM item, não a lista", () => {
    const b = itemDe(MD_SINT, "- **`x.ts`**");
    expect(b).toContain("alvo");
    expect(b, "o recorte de item sangrou para o vizinho — é a família nº 1").not.toContain(
      "vizinho",
    );
  });

  it("os recortes reais do documento não devolvem o documento inteiro", () => {
    for (const bloco of [
      secao(2, "Nada disto executou"),
      secao(3, "Ordem de aplicação"),
      item("- **`entitlements.ts`"),
    ]) {
      expect(bloco.length, "recorte vazio").toBeGreaterThan(80);
      expect(bloco.length, "recorte engoliu o documento").toBeLessThan(doc.length * 0.5);
    }
  });
});

// ─── Casos ──────────────────────────────────────────────────────────────────

describe("teste 46 — só webhook-whatsapp consome ai-providers.ts", () => {
  it("nenhuma outra Edge Function importa ai-providers.ts em runtime", () => {
    expect(importersOf("ai-providers.ts")).toEqual(["webhook-whatsapp"]);
  });
});

describe("teste 47 — manage-ai-providers só entra quando o catálogo mudar", () => {
  it("manage-ai-providers não importa ai-providers.ts", () => {
    const src = readFileSync(join(FUNCTIONS, "manage-ai-providers", "index.ts"), "utf8");
    expect(src).not.toContain("../_shared/ai-providers.ts");
  });

  it("o documento de pendências registra a distinção, e não põe manage-ai-providers no redeploy do beforeCall", () => {
    const linha = item("- **`ai-providers.ts`**");
    expect(linha).toContain("webhook-whatsapp");
    expect(linha).not.toContain("manage-ai-providers");
  });
});

describe("checklist de redeploy dos arquivos novos", () => {
  const NEW_SHARED = [
    "ai-price-core.ts",
    "ai-budget-core.ts",
    "ai-budget-milestones-core.ts",
    "ai-budget-copy.ts",
    "ai-call-authorizer-core.ts",
    "ai-budget-gate.ts",
  ];

  for (const f of NEW_SHARED) {
    it(`${f} tem linha própria no checklist`, () => {
      // ABERTURA DE ITEM, não presença. Cinco destes seis nomes aparecem também
      // em prosa (invariantes, notas, desvios) — a versão por `toContain(nome)`
      // ficava verde com o bullet do checklist APAGADO, que é justamente a linha
      // que o caso existe para exigir.
      const bullet = item(`- **\`${f}\`**`);
      expect(bullet, `${f}: o bullet não diz para onde redeployar`).toContain("webhook-whatsapp");
    });
  }

  it("entitlements-core.ts aparece com as três consumidoras já conhecidas", () => {
    const bullet = item("- **`entitlements.ts`");
    expect(bullet, "o bullet deixou de citar o núcleo").toContain("entitlements-core.ts");
    for (const ef of ["manage-billing", "create-billing-checkout", "manage-whatsapp-implementations"]) {
      expect(bullet, `${ef} sumiu das consumidoras de entitlements-core.ts`).toContain(ef);
    }
    // webhook-whatsapp passou a consumir entitlements.ts nesta frente.
    expect(bullet, "o webhook não foi acrescentado às consumidoras").toContain("webhook-whatsapp");
  });

  it("o acoplamento por string com process-billing-notifications está registrado", () => {
    const s = secao(3, "Acoplamento por string");
    expect(s, "sumiu quem sabe renderizar os avisos").toContain("process-billing-notifications");
    expect(s, "sumiram os event_type que fazem o acoplamento").toMatch(/admin_ai_budget/);
    expect(s, "sumiu o fato de não haver `_shared/` em comum").toContain("_shared/");
  });

  it("a ordem obrigatória migration-antes-de-deploy está escrita", () => {
    // SOBRE A SUBSEÇÃO, não sobre o documento. A versão anterior era
    // `toMatch(/migration[\s\S]{0,200}antes[\s\S]{0,200}deploy/i)` — a última
    // janela de tamanho fixo do arquivo: apagar esta subseção E plantar
    // "qualquer migration futura deve ser revisada antes de ir para deploy"
    // noutra seção ficava VERDE.
    const s = secao(3, "Ordem de aplicação");
    expect(s, "a precedência deixou de ser afirmada").toContain("ANTES");
    expect(s, "sumiu o que vem depois da migration").toContain("deploy");
    expect(s, "sumiu a faixa de migrations que precisa ir primeiro").toContain("099");
    expect(s, "sumiu a faixa de migrations que precisa ir primeiro").toContain("103");
    // E a segunda ordem, que é uma decisão própria: o dispatcher antes do
    // produtor dos avisos, senão o aviso morre em `failed/unknown_event_type`.
    expect(s, "sumiu a ordem entre dispatcher e produtor").toContain(
      "process-billing-notifications",
    );
    expect(s, "sumiu o produtor que vem por último").toContain("webhook-whatsapp");
  });

  it("a ordem invertida está descrita pelo PESO real, não como ruído tolerável", () => {
    // A versão anterior dizia "degrada aberto — tolerável, mas é ruído". É pior:
    // sem `ai_model_prices` a leitura de preço falha, vira `price_unknown`, e
    // esse é o ÚNICO código que fecha o caminho mesmo com a flag OFF. Todo
    // inbound de todo cliente vira handoff. Quem ler "tolerável" vai deployar
    // fora de ordem numa sexta-feira.
    const s = secao(3, "Ordem de aplicação");
    expect(s, "sumiu o mecanismo que torna a inversão fatal").toContain("price_unknown");
    expect(s, "sumiu o fato de a flag não conter isso").toMatch(/OFF|desligada/);
    expect(s, "sumiu o alcance: toda organização, não só as de franquia").toContain(
      "loadAiFranchise",
    );
    expect(s, "a inversão voltou a ser descrita como tolerável").not.toMatch(
      /tolerável, mas é ruído/,
    );
  });
});

describe("pendências registradas na revisão final de branch", () => {
  it("o gate comercial não afirma no presente a garantia que a seção 0 nega", () => {
    // O CHECK vem das migrations 096–098 do Plano B, ausentes nesta branch. A
    // seção 14 é exatamente a que se abre para saber o que barra a venda.
    const s = secao(2, "Gate comercial");
    expect(s, "sumiu quais migrations trazem a garantia").toContain("096");
    expect(s, "sumiu que a garantia é futura e condicionada").toMatch(/NÃO existe|passará a/i);
    expect(s, "a afirmação no presente voltou").not.toMatch(
      /CHECK do Plano B garante isso no banco/,
    );
  });

  it("o checklist do dia da flag existe e nomeia as quatro coisas que ninguém deduz", () => {
    const s = secao(2, "Antes de ligar");
    // A pendência que CALA a IA sem alerta e sem caminho que não seja SQL.
    expect(s, "sumiu o estado que silencia a IA até o fim do ciclo").toContain(
      "USAGE_REVIEW_REQUIRED",
    );
    // As duas flags são independentes, e ligar só uma é o pior par possível.
    expect(s, "sumiu a flag do dispatcher, que precisa subir junto").toContain(
      "billing_notifications_dispatch",
    );
    expect(s, "sumiu o aviso que fica pending — o de 100% é o que importa").toMatch(/100%/);
    // O guardrail de preço lê o SEED, não o catálogo: preço numa 104+ não conta.
    expect(s, "sumiu o limite do guardrail de preço semeado").toContain("099");
    expect(s, "sumiu de onde o guardrail realmente lê").toMatch(/seed|values/i);
  });

  it("o conflito de definição de overage está registrado como decisão ABERTA", () => {
    const s = secao(2, "Overage");
    // As três leituras, cada uma pelo lugar que a produz — sem isso o registro
    // vira "há um conflito" sem dizer entre o quê.
    expect(s, "sumiu a leitura do schema").toContain("consumed_cents");
    expect(s, "sumiu a leitura do núcleo, que é a que roda hoje").toContain("planNextCall");
    expect(s, "sumiu o que a spec pede e não existe").toMatch(/17\.5/);
    expect(s, "o registro deixou de dizer que a decisão está aberta").toMatch(
      /decisão aberta|Quem decide/i,
    );
  });
});

describe("pendências não declaráveis por teste unitário", () => {
  it("os testes 42 e 44 aparecem como PENDENTES, não como concluídos", () => {
    // SOBRE A SEÇÃO, ancorada no TÍTULO. `toMatch(/42/)` e `/44/` estavam
    // satisfeitas pela tabela de gates (`244 problemas … 242 avisos`), e apagar
    // esta seção inteira deixava a suíte verde. O que se exige dela é a
    // substância: os dois testes nomeados, o rótulo de pendência, a extensão de
    // que as migrations dependem e a conclusão comercial que sai dos três.
    const s = secao(2, "Nada disto executou");
    expect(s, "o teste 42 deixou de ser nomeado").toMatch(/[Tt]este 42/);
    expect(s, "o teste 44 deixou de ser nomeado").toMatch(/[Tt]este 44/);
    expect(s, "os dois deixaram de estar rotulados como pendentes").toMatch(/PENDENTE/);
    expect(s, "sumiu a dependência de btree_gist").toContain("btree_gist");
    expect(s, "sumiu a conclusão: sem banco real, não declarar o teto seguro").toContain(
      "financeiramente seguro",
    );
  });

  it("o gate comercial continua NO-GO", () => {
    const s = secao(2, "Gate comercial");
    expect(s).toContain("PLAN_AUTOMACAO_CHECKOUT");
    expect(s).toMatch(/NO-GO/);
  });

  it("a invendabilidade é condicionada às migrations do Plano B, que não estão nesta branch", () => {
    // Se o Plano D mergear sozinho, o CHECK não existe e a única barreira
    // declarada seria o NO-GO da seção 14 — que é processo, não banco.
    const s = secao(2, "fatos de coordenação");
    expect(s, "sumiu o CHECK que torna o plano invendável").toContain(
      "billing_plans_ai_plan_not_sellable_chk",
    );
    // A CONDIÇÃO vive numa citação (`> `), e é ela que se exige — não a string
    // "096", que aparece também no fato 3 (timestamps) e deixava este caso verde
    // com a condição inteira apagada. Recorte pelo bloco de citação: apagá-lo
    // esvazia o texto verificado.
    const citacao = s
      .split("\n")
      .filter((l) => l.startsWith(">"))
      .join("\n");
    expect(citacao.length, "a condição deixou de ser uma citação destacada").toBeGreaterThan(200);
    // Sem quantificador com teto: o recorte já é a citação, e a afirmação do
    // cabeçalho deste arquivo ("nenhuma janela de N caracteres") tem de valer
    // literalmente, inclusive aqui.
    expect(citacao, "a condição não diz quais migrations faltam").toContain("096");
    expect(citacao, "a condição não diz quais migrations faltam").toContain("098");
    expect(citacao, "a condição não diz que esta branch não as tem").toContain("095");
    expect(citacao, "a condição não afirma que a invendabilidade não existe sem elas").toMatch(
      /NÃO EXISTE/,
    );
    expect(citacao, "a condição não aponta a barreira que sobra").toContain(
      "PLAN_AUTOMACAO_CHECKOUT",
    );
  });
});
