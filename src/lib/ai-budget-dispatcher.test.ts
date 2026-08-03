/**
 * Guardrail do ACOPLAMENTO POR STRING entre o produtor dos marcos da franquia
 * (Plano D) e o dispatcher `process-billing-notifications`.
 *
 * SEXTA ocorrência do padrão. Cobre as DUAS direções, no molde de
 * whatsapp-instance-alerts-dispatcher.test.ts:
 *   1. evento canônico sem template no dispatcher;
 *   2. produtor emitindo string fora da lista canônica.
 *
 * A fonte canônica é EVENT_TYPE_BY_MILESTONE_PERCENT — a lista NÃO é redigitada.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EVENT_TYPE_BY_MILESTONE_PERCENT,
  CANONICAL_AI_BUDGET_EVENT_TYPES,
} from "../../supabase/functions/_shared/ai-budget-milestones-core";

const FUNCTIONS = join(__dirname, "..", "..", "supabase", "functions");
const DISPATCHER = join(FUNCTIONS, "process-billing-notifications", "index.ts");
const CORE = join(FUNCTIONS, "_shared", "ai-budget-milestones-core.ts");
const GATE = join(FUNCTIONS, "_shared", "ai-budget-gate.ts");
const WEBHOOK = join(FUNCTIONS, "webhook-whatsapp", "index.ts");

const dispatcherSource = readFileSync(DISPATCHER, "utf8");
const coreSource = readFileSync(CORE, "utf8");

describe("acoplamento dos marcos com process-billing-notifications", () => {
  it("todo event_type canônico tem entrada em TEMPLATE_BY_EVENT", () => {
    const missing = CANONICAL_AI_BUDGET_EVENT_TYPES.filter((e) => !dispatcherSource.includes(`${e}: (d)`));
    expect(
      missing,
      `Sem entrada em TEMPLATE_BY_EVENT: ${missing.join(", ")}. A linha enfileirada morreria em failed/unknown_event_type.`,
    ).toEqual([]);
  });

  it("nenhum produtor emite event_type fora da lista canônica", () => {
    const found = new Set<string>();
    for (const path of [CORE, GATE, WEBHOOK]) {
      let src = "";
      try {
        src = readFileSync(path, "utf8");
      } catch {
        // Arquivo ainda não existe (tarefas 11/12). O teste volta a cobri-lo
        // assim que existir — e é por isso que ele não pode ser silenciado.
        continue;
      }
      for (const m of src.matchAll(/admin_ai_budget_[a-z0-9_]+/g)) found.add(m[0]);
    }
    const foreign = [...found].filter((e) => CANONICAL_AI_BUDGET_EVENT_TYPES.indexOf(e) === -1);
    expect(foreign, `event_type fora da lista canônica: ${foreign.join(", ")}`).toEqual([]);
  });

  it("os quatro marcos mapeiam para os quatro event_type", () => {
    expect(Object.keys(EVENT_TYPE_BY_MILESTONE_PERCENT)).toHaveLength(4);
    expect(CANONICAL_AI_BUDGET_EVENT_TYPES).toHaveLength(4);
  });

  it("os templates carregam o conteúdo obrigatório do alerta interno", () => {
    // §18.2: organização, ciclo, custo liquidado, custo reservado, modelo,
    // data da renovação, ação esperada.
    for (const evt of CANONICAL_AI_BUDGET_EVENT_TYPES) {
      const i = dispatcherSource.indexOf(`${evt}: (d)`);
      const block = dispatcherSource.slice(i, i + 2000);
      expect(block, `${evt} sem orgName`).toContain("d.orgName");
      expect(block, `${evt} sem dados do ciclo`).toContain("d.aiBudget");
    }
  });

  it("os templates são INTERNOS — marcados como tal e sem link de pagamento", () => {
    for (const evt of CANONICAL_AI_BUDGET_EVENT_TYPES) {
      const i = dispatcherSource.indexOf(`${evt}: (d)`);
      const block = dispatcherSource.slice(i, i + 2000);
      expect(block).toContain("[interno]");
      // Sem fatura por trás: amountBrl chega zerado e paymentUrl é null.
      expect(block).not.toContain("d.amountBrl");
      expect(block).not.toContain("payLine(");
    }
  });

  it("o marco de hard stop diz que o canal continua recebendo", () => {
    const i = dispatcherSource.indexOf("admin_ai_budget_stop: (d)");
    const block = dispatcherSource.slice(i, i + 2000);
    // §18.3: não desligar o canal, não bloquear o sistema.
    expect(block).toMatch(/continua|segue/i);
  });

  it("nenhum template de marco expõe chave, credencial ou payload de provedor", () => {
    for (const evt of CANONICAL_AI_BUDGET_EVENT_TYPES) {
      const i = dispatcherSource.indexOf(`${evt}: (d)`);
      const block = dispatcherSource.slice(i, i + 2000);
      expect(block).not.toMatch(/apiKey|api_key|credentials|Bearer/i);
    }
  });

  it("o núcleo dos marcos não conhece o dispatcher — o acoplamento é só a string", () => {
    expect(coreSource).not.toContain("process-billing-notifications");
    expect(coreSource).not.toContain("TEMPLATE_BY_EVENT");
  });

  it("controle positivo: o detector encontra um event_type que sabidamente existe", () => {
    expect(dispatcherSource.includes("admin_zapi_divergence: (d)")).toBe(true);
    expect(dispatcherSource.includes("evento_que_nao_existe: (d)")).toBe(false);
  });
});
