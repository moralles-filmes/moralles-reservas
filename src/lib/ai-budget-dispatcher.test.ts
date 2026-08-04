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

/**
 * Fatia EXATAMENTE uma entrada de TEMPLATE_BY_EVENT: do cabeçalho dela até o
 * cabeçalho da entrada seguinte (ou o fim do mapa). Janela de tamanho fixo
 * sangra para a vizinha — e como as quatro entradas são curtas e adjacentes
 * por desenho (delegam ao helper), gutar uma nunca esvaziaria a janela: o
 * guardrail estaria medindo a irmã intacta, não a entrada sob teste.
 */
function entryBlock(source: string, evt: string): string {
  const start = source.indexOf(`${evt}: (d)`);
  expect(start, `entrada ${evt} não encontrada`).toBeGreaterThan(-1);
  const rest = source.slice(start + evt.length);
  const next = rest.match(/\n {2}[A-Za-z_][A-Za-z0-9_]*: \(d\) =>|\n};/);
  return source.slice(start, start + evt.length + (next ? next.index : rest.length));
}

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

  it("cada marco delega a montagem aos helpers de conteúdo", () => {
    // A entrada não repete o conteúdo: ela delega. O que se prova aqui é a
    // delegação; o conteúdo em si é provado no caso seguinte.
    for (const evt of CANONICAL_AI_BUDGET_EVENT_TYPES) {
      const block = entryBlock(dispatcherSource, evt);
      expect(block, `${evt} sem orgName`).toContain("d.orgName");
      expect(block, `${evt} não delega a aiBudgetText`).toMatch(/aiBudgetText\(\s*d\s*,/);
      expect(block, `${evt} não delega a aiBudgetHtml`).toMatch(/aiBudgetHtml\(\s*d\s*,/);
    }
  });

  it("os helpers de conteúdo carregam o obrigatório do alerta interno", () => {
    // §18.2 exige organização, ciclo, custo liquidado, custo reservado,
    // modelo, data da renovação e ação esperada. O helper é onde isso vive.
    for (const fn of ["function aiBudgetText(", "function aiBudgetHtml("]) {
      const i = dispatcherSource.indexOf(fn);
      expect(i, `${fn} não encontrado`).toBeGreaterThan(-1);
      const body = dispatcherSource.slice(i, dispatcherSource.indexOf("\n}\n", i));
      expect(body, `${fn} não usa d.aiBudget`).toContain("d.aiBudget");
      for (const campo of ["cycleStart", "cycleEnd", "settledBrl", "reservedBrl", "limitBrl", "models"]) {
        expect(body, `${fn} não renderiza ${campo}`).toContain(campo);
      }
      expect(body, `${fn} não recebe a ação esperada`).toContain("acao");
    }
  });

  it("controle negativo: gutar um template quebra o guardrail", () => {
    // Este caso existe porque a versão anterior deste guardrail passava mesmo
    // com o template esvaziado — bastava o comentário certo por perto.
    const gutted = dispatcherSource.replace(
      /admin_ai_budget_70: \(d\) => \(\{[\s\S]*?\}\),/,
      "admin_ai_budget_70: (d) => ({ subject: `x ${d.orgName}`, text: `x`, html: `x` }),",
    );
    const block = entryBlock(gutted, "admin_ai_budget_70");
    expect(block).not.toMatch(/aiBudgetText\(\s*d\s*,/);
  });

  it("os templates são INTERNOS — marcados como tal e sem link de pagamento", () => {
    for (const evt of CANONICAL_AI_BUDGET_EVENT_TYPES) {
      const block = entryBlock(dispatcherSource, evt);
      expect(block).toContain("[interno]");
      // Sem fatura por trás: amountBrl chega zerado e paymentUrl é null.
      expect(block).not.toContain("d.amountBrl");
      expect(block).not.toContain("payLine(");
    }
  });

  it("o marco de hard stop diz que o canal continua recebendo", () => {
    const block = entryBlock(dispatcherSource, "admin_ai_budget_stop");
    // §18.3: não desligar o canal, não bloquear o sistema.
    expect(block).toMatch(/continua|segue/i);
  });

  it("nenhum template de marco expõe chave, credencial ou payload de provedor", () => {
    for (const evt of CANONICAL_AI_BUDGET_EVENT_TYPES) {
      const block = entryBlock(dispatcherSource, evt);
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
