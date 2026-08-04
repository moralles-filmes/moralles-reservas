/**
 * Testes 46 e 47 da spec: o checklist de redeploy é EXATO ou não serve.
 *
 * Redeploy desnecessário não é inofensivo — ele treina a leitura de que o
 * checklist é aproximado, e o checklist só funciona enquanto for exato: é ele
 * que impede metade do sistema de rodar com `_shared/` velho em memória.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * REGRA DESTE ARQUIVO: nada aqui mede PRESENÇA de uma string no documento
 * inteiro, e nada aqui recorta por janela de N caracteres.
 *
 * As duas primeiras versões destes casos faziam exatamente isso, e as duas
 * eram vácuas — cada uma reproduzindo uma das seis famílias de falso-verde que o
 * PRÓPRIO documento que elas verificam cataloga (seção 7 de
 * `PLANO-D-PENDENCIAS.md`):
 *
 *   - `toMatch(/42/)` e `/44/` pretendiam prender "os testes 42 e 44 seguem
 *     PENDENTES". Estavam satisfeitas pela TABELA DE GATES do próprio documento,
 *     que traz `244 problemas (2 erros, 242 avisos)`: `242` casa `/42/` e `244`
 *     casa `/44/`. Apagar a seção 1 INTEIRA deixava a suíte verde. (Família 5:
 *     presença × identidade.)
 *   - `toContain("ai-price-core.ts")` pretendia prender "tem linha própria no
 *     checklist". Estava satisfeita por qualquer menção em qualquer parágrafo —
 *     é o corolário que a seção 7 escreve (`toContain` sobre o arquivo inteiro é
 *     satisfeito pela linha de import), aplicado a prosa em vez de código.
 *   - `doc.slice(i, i + 400)` pretendia prender as consumidoras de
 *     `entitlements-core.ts`. A janela sangrava para o bullet SEGUINTE, que
 *     também cita `webhook-whatsapp`. (Família 1: janela de tamanho fixo medindo
 *     a entrada vizinha.)
 *
 * Todo recorte abaixo é por fronteira sintática real do Markdown: bloco de
 * seção (`## ` até o próximo `## `) ou item de lista (`- ` até o próximo `- ` ou
 * linha em branco).
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const FUNCTIONS = join(__dirname, "..", "..", "supabase", "functions");
const PENDENCIAS = join(__dirname, "..", "..", "docs", "billing-asaas", "PLANO-D-PENDENCIAS.md");

/** CRLF normalizado: os recortes procuram `\n- ` e `\n## `. */
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

/**
 * O bloco de cabeçalho que CONTÉM a âncora — do `## ` ou `### ` imediatamente
 * anterior até o `## `/`### ` imediatamente seguinte. Apagar a seção inteira faz
 * o `indexOf` da âncora falhar, que é o desfecho que a versão por presença não
 * produzia.
 *
 * Os DOIS níveis contam. Recortar só por `## ` devolvia a seção 11 inteira para
 * uma âncora que vive numa subseção dela: apagar a subseção "Acoplamento por
 * string" ficava verde, porque `process-billing-notifications` e
 * `admin_ai_budget` também aparecem nas subseções irmãs. Fronteira sintática é a
 * mais PRÓXIMA, não a mais conveniente.
 */
function secaoContendo(ancora: string | RegExp): string {
  const i = typeof ancora === "string" ? doc.indexOf(ancora) : doc.search(ancora);
  expect(i, `âncora ausente no documento: ${ancora}`).toBeGreaterThan(-1);
  const inicio = Math.max(doc.lastIndexOf("\n## ", i), doc.lastIndexOf("\n### ", i));
  expect(inicio, `âncora fora de qualquer seção: ${ancora}`).toBeGreaterThan(-1);
  const seguintes = [doc.indexOf("\n## ", i), doc.indexOf("\n### ", i)].filter((n) => n > -1);
  const fim = seguintes.length ? Math.min(...seguintes) : doc.length;
  return doc.slice(inicio, fim);
}

/**
 * O item de lista que CONTÉM a âncora: do `- ` que o abre até o próximo `- ` de
 * mesmo nível ou a próxima linha em branco — o que vier primeiro.
 *
 * É o recorte que substitui `slice(i, i + 400)`. A posição do item na lista não
 * participa da proteção: com um item novo logo abaixo, o recorte continua sendo
 * o certo, e é por isso que a fronteira é sintática e não posicional.
 */
function itemContendo(ancora: string): string {
  const i = doc.indexOf(ancora);
  expect(i, `âncora ausente no documento: ${ancora}`).toBeGreaterThan(-1);
  const inicio = doc.lastIndexOf("\n- ", i);
  expect(inicio, `âncora fora de qualquer item de lista: ${ancora}`).toBeGreaterThan(-1);
  const candidatos = [doc.indexOf("\n- ", i), doc.indexOf("\n\n", i)].filter((n) => n > -1);
  const fim = candidatos.length ? Math.min(...candidatos) : doc.length;
  return doc.slice(inicio, fim);
}

describe("controle dos recortes do Markdown", () => {
  it("secaoContendo devolve UMA seção, não o documento", () => {
    const s = secaoContendo(/[Tt]este 42/);
    expect(s.length, "o recorte de seção ficou vazio").toBeGreaterThan(200);
    expect(s.length, "o recorte de seção engoliu o documento").toBeLessThan(doc.length * 0.5);
    // Não sangra para a seção seguinte: só o próprio cabeçalho `## ` aparece.
    expect([...s.matchAll(/\n## /g)]).toHaveLength(1);
  });

  it("itemContendo devolve UM item, não a lista", () => {
    const b = itemContendo("entitlements-core.ts");
    expect(b.length, "o recorte de item ficou vazio").toBeGreaterThan(80);
    // Um item só: nenhum `- ` além do que o abre.
    expect(
      [...b.matchAll(/\n- /g)],
      "o recorte de item sangrou para o vizinho — é a família nº 1",
    ).toHaveLength(1);
  });
});

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
    const line = itemContendo("- **`ai-providers.ts`**");
    expect(line).toContain("webhook-whatsapp");
    expect(line).not.toContain("manage-ai-providers");
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
      // INÍCIO DE BULLET, não presença. Cinco destes seis nomes aparecem também
      // em prosa (invariantes, notas, desvios) — a versão por `toContain` ficava
      // verde com o bullet do checklist APAGADO, que é justamente a linha que o
      // caso existe para exigir.
      expect(
        doc,
        `${f} não tem bullet próprio no checklist (só menção em prosa não conta)`,
      ).toContain(`- **\`${f}\`**`);
      // E o bullet diz para onde redeployar.
      expect(itemContendo(`- **\`${f}\`**`)).toContain("webhook-whatsapp");
    });
  }

  it("entitlements-core.ts aparece com as três consumidoras já conhecidas", () => {
    const bullet = itemContendo("entitlements-core.ts");
    for (const ef of ["manage-billing", "create-billing-checkout", "manage-whatsapp-implementations"]) {
      expect(bullet, `${ef} sumiu das consumidoras de entitlements-core.ts`).toContain(ef);
    }
    // webhook-whatsapp passou a consumir entitlements.ts nesta frente.
    expect(bullet, "o webhook não foi acrescentado às consumidoras").toContain("webhook-whatsapp");
  });

  it("o acoplamento por string com process-billing-notifications está registrado", () => {
    // Âncora no CABEÇALHO da subseção, não numa string que também aparece nas
    // irmãs: apagar a subseção inteira tem de derrubar o caso, e a única forma de
    // garantir isso é ancorar no que só existe dentro dela.
    const secao = secaoContendo("### Acoplamento por string");
    expect(secao, "sumiu quem sabe renderizar os avisos").toContain(
      "process-billing-notifications",
    );
    expect(secao, "sumiram os event_type que fazem o acoplamento").toMatch(/admin_ai_budget/);
    expect(secao, "sumiu o fato de não haver `_shared/` em comum").toContain("_shared/");
  });

  it("a ordem obrigatória migration-antes-de-deploy está escrita", () => {
    expect(doc).toMatch(/migration[\s\S]{0,200}antes[\s\S]{0,200}deploy/i);
  });
});

describe("pendências não declaráveis por teste unitário", () => {
  it("os testes 42 e 44 aparecem como PENDENTES, não como concluídos", () => {
    // SOBRE A SEÇÃO, não sobre dígitos soltos. `toMatch(/42/)` e `/44/` estavam
    // satisfeitas pela tabela de gates (`244 problemas … 242 avisos`), e apagar
    // esta seção inteira deixava a suíte verde. Aqui o recorte é a seção que
    // CONTÉM a afirmação, e o que se exige dela é a substância: os dois testes
    // nomeados, o rótulo de pendência, a extensão que nunca foi criada e a
    // conclusão comercial que depende dos três.
    const secao = secaoContendo(/[Tt]este 42/);
    expect(secao, "o teste 42 deixou de ser nomeado").toMatch(/[Tt]este 42/);
    expect(secao, "o teste 44 deixou de ser nomeado").toMatch(/[Tt]este 44/);
    expect(secao, "os dois deixaram de estar rotulados como pendentes").toMatch(/PENDENTE/);
    expect(secao, "sumiu a dependência de btree_gist").toContain("btree_gist");
    expect(
      secao,
      "sumiu a conclusão: sem banco real, não declarar o teto seguro",
    ).toContain("financeiramente seguro");
  });

  it("o gate comercial continua NO-GO", () => {
    const secao = secaoContendo("PLAN_AUTOMACAO_CHECKOUT");
    expect(secao).toContain("PLAN_AUTOMACAO_CHECKOUT");
    expect(secao).toMatch(/NO-GO/);
  });
});
