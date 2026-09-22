import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { resolve, join, relative, sep } from "node:path";

/**
 * GUARDRAIL DE SUPERFÍCIES COMERCIAIS — §A6.2 da spec de dois planos.
 *
 * Prova que as superfícies de CONTRATAÇÃO E APRESENTAÇÃO COMERCIAL não
 * dependem mais de `sistema-reservas`, `instancia-whatsapp` nem `credito-ia-*`.
 *
 * TRÊS EXCLUSÕES POR CONSTRUÇÃO, nunca por exceção pontual:
 *   1. migrations   — `supabase/migrations/` nunca entra em SCOPE;
 *   2. testes       — `walk()` pula `*.test.ts` e `*.test.tsx`;
 *   3. comentários  — `codeLines()` descarta linhas de comentário antes de
 *                     procurar slug.
 * É o que mantém `asaas-core.test.ts` (fixtures nomeados) e `billing-amount.ts`
 * (citação em comentário) legítimos e verdes, sem allowlist de arquivo.
 *
 * ANTI-APODRECIMENTO: todo arquivo encontrado dentro de SCOPE precisa estar
 * classificado em SURFACES. Uma tela de contratação nova em 2027 cai no escopo,
 * não é classificada, e o teste falha pedindo a classificação — em vez de
 * simplesmente não ser varrida.
 */

const ROOT = process.cwd();

/**
 * Onde vive apresentação e contratação comercial. Arquivo OU diretório.
 * Acrescentar um caminho aqui é acrescentar cobertura; remover é abrir buraco,
 * e o revisor precisa ver isso no diff.
 */
const SCOPE: readonly string[] = [
  "src/components/PricingCard.tsx",
  "src/components/PricingTable.tsx",
  "src/components/gestao",
  "src/components/billing",
  "src/pages/gestao/Cobranca.tsx",
  "src/pages/platform/BillingPlans.tsx",
  "supabase/functions/create-billing-checkout",
  "supabase/functions/manage-whatsapp-implementations",
  "supabase/functions/manage-billing",
  "supabase/functions/_shared/implementation-checkout.ts",
  "supabase/functions/_shared/checkout-sessions.ts",
];

type Classification =
  /** Oferta/apresentação comercial NOVA. Não pode citar slug retirado. */
  | "OFFER"
  /** Lê produto antigo para HISTÓRICO/compatibilidade. Pode citar. */
  | "HISTORICAL"
  /** Está no escopo por vizinhança, não participa de oferta. */
  | "NOT_COMMERCIAL";

interface SurfaceEntry {
  kind: Classification;
  /** Obrigatório: por que esta classificação, em uma frase. */
  reason: string;
}

const SURFACES: Record<string, SurfaceEntry> = {
  "src/components/PricingCard.tsx": {
    kind: "OFFER",
    reason: "Card de plano da vitrine do lojista — a oferta em si.",
  },
  "src/components/PricingTable.tsx": {
    kind: "OFFER",
    reason: "Grid da vitrine; decide o que é ofertável via isSelectableSystemPlan.",
  },
  "src/components/gestao/AutomacaoWhatsappCard.tsx": {
    kind: "OFFER",
    reason:
      "Card de automação do lojista: preços, implantação e o bloco informativo do Plano Automação.",
  },
  "src/components/gestao/CustomerStatsBlock.tsx": {
    kind: "NOT_COMMERCIAL",
    reason:
      "Histórico de reservas do cliente na ficha (contagens, taxa de no-show, última presença). Não apresenta produto, plano nem preço — caiu no escopo só por morar em src/components/gestao.",
  },
  "src/components/billing/WhatsappServiceBanner.tsx": {
    kind: "NOT_COMMERCIAL",
    reason:
      "Banner de estado do serviço (suspensão/carência). Não apresenta produto nem preço.",
  },
  "src/pages/gestao/Cobranca.tsx": {
    kind: "OFFER",
    reason: "Tela de cobrança do lojista — hospeda a vitrine e o card de automação.",
  },
  "src/pages/platform/BillingPlans.tsx": {
    kind: "OFFER",
    reason:
      "Painel de catálogo do platform_admin; edita e exibe os planos ofertados.",
  },
  "supabase/functions/create-billing-checkout/index.ts": {
    kind: "OFFER",
    reason: "Porta de contratação: resolve purpose e plano.",
  },
  "supabase/functions/create-billing-checkout/context.ts": {
    kind: "OFFER",
    reason: "Carrega o plano do checkout a partir do id.",
  },
  "supabase/functions/create-billing-checkout/subscription.ts": {
    kind: "OFFER",
    reason: "Checkout de assinatura; recusa plano inativo.",
  },
  "supabase/functions/create-billing-checkout/implementation.ts": {
    kind: "OFFER",
    reason: "Checkout da cobrança única de implantação.",
  },
  "supabase/functions/create-billing-checkout/eligibility.ts": {
    kind: "OFFER",
    reason:
      "Decide elegibilidade por categoria de plano no caminho de checkout (bloqueia contratação de instância por flag e por implantação incompleta); não cita nenhum slug retirado.",
  },
  "supabase/functions/manage-whatsapp-implementations/index.ts": {
    kind: "OFFER",
    reason:
      "Afirma preços ao lojista em get_service_status — os quatro call sites da §A6 saem daqui.",
  },
  "supabase/functions/_shared/implementation-checkout.ts": {
    kind: "OFFER",
    reason:
      "Resolve o produto de implantação. `implementacao-whatsapp` é permitido: é o produto canônico mantido.",
  },
  "supabase/functions/_shared/checkout-sessions.ts": {
    kind: "NOT_COMMERCIAL",
    reason:
      "Persistência de checkoutSession para correlação de webhook; não conhece produto.",
  },
  "supabase/functions/manage-billing/index.ts": {
    kind: "OFFER",
    reason:
      "Serve o catálogo à vitrine do lojista (action list_plans, moldado por papel) e processa troca de plano (change_plan/preview_plan_change) — não cita nenhum slug retirado.",
  },
};

/**
 * Slugs RETIRADOS da oferta (§A6.1). `implementacao-whatsapp` NÃO entra:
 * continua sendo o produto canônico da cobrança única e é citado de propósito
 * pelas superfícies de oferta.
 */
const RETIRED_SLUGS: readonly string[] = ["sistema-reservas", "instancia-whatsapp"];
const RETIRED_SLUG_PREFIXES: readonly string[] = ["credito-ia-"];

const IGNORED_DIRS = new Set(["node_modules", "dist", ".git", "__snapshots__"]);

const isTestFile = (name: string) => /\.test\.(ts|tsx)$/.test(name);
const isSourceFile = (name: string) => /\.(ts|tsx)$/.test(name);

function walk(absolute: string, out: string[]): void {
  const stat = statSync(absolute);
  if (stat.isFile()) {
    const name = absolute.split(sep).pop() ?? "";
    if (isSourceFile(name) && !isTestFile(name)) out.push(absolute);
    return;
  }
  for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      walk(join(absolute, entry.name), out);
    } else if (isSourceFile(entry.name) && !isTestFile(entry.name)) {
      out.push(join(absolute, entry.name));
    }
  }
}

function discover(): string[] {
  const found: string[] = [];
  for (const target of SCOPE) {
    const absolute = resolve(ROOT, target);
    if (!existsSync(absolute)) continue; // a asserção de manifesto podre cobre isto
    walk(absolute, found);
  }
  return [...new Set(found.map((p) => relative(ROOT, p).split(sep).join("/")))].sort();
}

/**
 * Linhas de CÓDIGO — comentários fora.
 *
 * Baseado em linha, de propósito: um parser de TS aqui seria mais frágil do que
 * o defeito que ele evitaria. LIMITE CONHECIDO: um slug num comentário no FIM
 * de uma linha de código (`const x = 1; // instancia-whatsapp`) não é
 * descartado — e é o comportamento seguro, porque a linha É código.
 */
function codeLines(source: string): string[] {
  return source.split(/\r?\n/).filter((line) => {
    const t = line.trim();
    return !(
      t.startsWith("//") ||
      t.startsWith("*") ||
      t.startsWith("/*") ||
      t.startsWith("--")
    );
  });
}

/** Retorna as ocorrências de slug retirado em linhas de código. */
export function retiredSlugHits(source: string): string[] {
  const hits: string[] = [];
  for (const line of codeLines(source)) {
    for (const slug of RETIRED_SLUGS) {
      if (line.includes(slug)) hits.push(slug);
    }
    for (const prefix of RETIRED_SLUG_PREFIXES) {
      if (line.includes(prefix)) hits.push(`${prefix}*`);
    }
  }
  return [...new Set(hits)];
}

const read = (relativePath: string) => readFileSync(resolve(ROOT, relativePath), "utf8");

describe("§A6.2 — guardrail de superfícies comerciais", () => {
  const discovered = discover();

  it("descobriu superfícies (o escopo não pode estar vazio)", () => {
    expect(discovered.length).toBeGreaterThan(0);
  });

  it("toda superfície encontrada no escopo está CLASSIFICADA", () => {
    const unclassified = discovered.filter((p) => !SURFACES[p]);
    expect(
      unclassified,
      "Superfície comercial nova sem classificação. Acrescente cada caminho a " +
        "SURFACES em src/lib/commercial-surface-guard.test.ts com kind " +
        "(OFFER | HISTORICAL | NOT_COMMERCIAL) e reason. Não remova do SCOPE " +
        "para silenciar — é exatamente o buraco que este teste existe pra impedir.",
    ).toEqual([]);
  });

  it("nenhuma entrada do manifesto aponta para arquivo inexistente", () => {
    const stale = Object.keys(SURFACES).filter((p) => !existsSync(resolve(ROOT, p)));
    expect(stale, "Manifesto podre: caminho classificado que não existe mais.").toEqual([]);
  });

  it("toda entrada do manifesto traz um motivo", () => {
    const semMotivo = Object.entries(SURFACES)
      .filter(([, entry]) => !entry.reason.trim())
      .map(([path]) => path);
    expect(semMotivo).toEqual([]);
  });

  describe("superfícies OFFER não dependem de slug retirado", () => {
    const offers = Object.entries(SURFACES)
      .filter(([, entry]) => entry.kind === "OFFER")
      .map(([path]) => path)
      .filter((path) => existsSync(resolve(ROOT, path)));

    it("existe pelo menos uma superfície OFFER", () => {
      expect(offers.length).toBeGreaterThan(0);
    });

    for (const path of offers) {
      it(`${path} não cita sistema-reservas, instancia-whatsapp nem credito-ia-*`, () => {
        expect(retiredSlugHits(read(path))).toEqual([]);
      });
    }
  });

  it("os quatro call sites da §A6 estão cobertos como OFFER", () => {
    // Se um destes sair do manifesto, a §A6 deixou de ser verificada.
    for (const path of [
      "supabase/functions/manage-whatsapp-implementations/index.ts",
      "src/components/gestao/AutomacaoWhatsappCard.tsx",
      "src/components/PricingTable.tsx",
      "src/pages/platform/BillingPlans.tsx",
    ]) {
      expect(SURFACES[path]?.kind, path).toBe("OFFER");
    }
  });
});

describe("§A6.2 — controles do detector (o teste não pode ser vacuoso)", () => {
  it("CONTROLE NEGATIVO: slug retirado em linha de CÓDIGO é detectado", () => {
    expect(retiredSlugHits(`const p = plans.find(x => x.slug === "instancia-whatsapp");`))
      .toEqual(["instancia-whatsapp"]);
    expect(retiredSlugHits(`.in("slug", ["sistema-reservas"])`)).toEqual(["sistema-reservas"]);
    expect(retiredSlugHits(`if (slug.startsWith("credito-ia-")) return null;`))
      .toEqual(["credito-ia-*"]);
  });

  it("CONTROLE POSITIVO: comentário citando slug retirado é ignorado", () => {
    // billing-amount.ts:5 faz exatamente isto e é legítimo.
    expect(retiredSlugHits(`// preço do catálogo, inclusive instancia-whatsapp`)).toEqual([]);
    expect(retiredSlugHits(` * sistema-reservas nasce inativo no seed 065`)).toEqual([]);
    expect(retiredSlugHits(`-- update billing_plans ... 'instancia-whatsapp'`)).toEqual([]);
  });

  it("CONTROLE POSITIVO: implementacao-whatsapp é permitido em superfície OFFER", () => {
    // Produto canônico da cobrança única, mantido pelo modelo novo (§A6.1).
    expect(retiredSlugHits(`export const IMPLEMENTATION_PLAN_SLUG = "implementacao-whatsapp";`))
      .toEqual([]);
  });

  it("CONTROLE POSITIVO: os slugs novos são permitidos", () => {
    expect(retiredSlugHits(`.in("slug", ["plano-reservas", "plano-automacao"])`)).toEqual([]);
  });

  it("migrations e testes ficam fora por construção, não por exceção", () => {
    const scopeText = SCOPE.join("\n");
    expect(scopeText).not.toMatch(/supabase\/migrations/);
    // A varredura nunca coleta arquivo de teste.
    for (const path of discover()) {
      expect(path).not.toMatch(/\.test\.tsx?$/);
    }
  });
});
