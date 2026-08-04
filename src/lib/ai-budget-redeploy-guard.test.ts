/**
 * Testes 46 e 47 da spec: o checklist de redeploy é EXATO ou não serve.
 *
 * Redeploy desnecessário não é inofensivo — ele treina a leitura de que o
 * checklist é aproximado, e o checklist só funciona enquanto for exato: é ele
 * que impede metade do sistema de rodar com `_shared/` velho em memória.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const FUNCTIONS = join(__dirname, "..", "..", "supabase", "functions");
const PENDENCIAS = join(__dirname, "..", "..", "docs", "billing-asaas", "PLANO-D-PENDENCIAS.md");

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
    const doc = readFileSync(PENDENCIAS, "utf8");
    const i = doc.indexOf("ai-providers.ts");
    expect(i, "linha de ai-providers.ts ausente no checklist").toBeGreaterThan(-1);
    const line = doc.slice(i, doc.indexOf("\n", i));
    expect(line).toContain("webhook-whatsapp");
    expect(line).not.toContain("manage-ai-providers");
  });
});

describe("checklist de redeploy dos arquivos novos", () => {
  const doc = readFileSync(PENDENCIAS, "utf8");
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
      expect(doc).toContain(f);
    });
  }

  it("entitlements-core.ts aparece com as três consumidoras já conhecidas", () => {
    const i = doc.indexOf("entitlements-core.ts");
    expect(i).toBeGreaterThan(-1);
    const block = doc.slice(i, i + 400);
    for (const ef of ["manage-billing", "create-billing-checkout", "manage-whatsapp-implementations"]) {
      expect(block).toContain(ef);
    }
    // webhook-whatsapp passou a consumir entitlements.ts nesta frente.
    expect(block).toContain("webhook-whatsapp");
  });

  it("o acoplamento por string com process-billing-notifications está registrado", () => {
    expect(doc).toContain("process-billing-notifications");
    expect(doc).toMatch(/admin_ai_budget/);
  });

  it("a ordem obrigatória migration-antes-de-deploy está escrita", () => {
    expect(doc).toMatch(/migration[\s\S]{0,200}antes[\s\S]{0,200}deploy/i);
  });
});

describe("pendências não declaráveis por teste unitário", () => {
  const doc = readFileSync(PENDENCIAS, "utf8");

  it("os testes 42 e 44 aparecem como PENDENTES, não como concluídos", () => {
    expect(doc).toMatch(/42/);
    expect(doc).toMatch(/44/);
    expect(doc).toMatch(/PENDENTE|pendente/);
  });

  it("o gate comercial continua NO-GO", () => {
    expect(doc).toContain("PLAN_AUTOMACAO_CHECKOUT");
    expect(doc).toMatch(/NO-GO/);
  });
});
