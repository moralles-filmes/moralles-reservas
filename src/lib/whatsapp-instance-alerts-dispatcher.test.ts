/**
 * Guardrail do ACOPLAMENTO POR STRING entre o produtor de alertas da Fase 6b e
 * o dispatcher `process-billing-notifications`.
 *
 * As duas Edge Functions não compartilham nenhum arquivo `_shared/` para esse
 * acoplamento — é só o `event_type`, uma string. Sem a entrada em
 * `TEMPLATE_BY_EVENT`, a linha enfileirada morre em `failed/unknown_event_type`
 * e o aviso some em silêncio. Esta é a QUINTA ocorrência do mesmo padrão no
 * projeto — as quatro anteriores foram tratadas por disciplina de redeploy
 * conjunto, e disciplina não é teste.
 *
 * O guardrail cobre as DUAS direções:
 *   1. evento canônico sem template no dispatcher;
 *   2. produtor emitindo string fora da lista canônica.
 *
 * A fonte canônica é `EVENT_TYPE_BY_ALERT` — a lista NÃO é redigitada aqui.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EVENT_TYPE_BY_ALERT,
  CANONICAL_EVENT_TYPES,
} from "../../supabase/functions/_shared/whatsapp-instance-alerts-core";

const FUNCTIONS = join(__dirname, "..", "..", "supabase", "functions");
const DISPATCHER = join(FUNCTIONS, "process-billing-notifications", "index.ts");
const WORKER = join(FUNCTIONS, "process-whatsapp-instance-cycles", "index.ts");
const CORE = join(FUNCTIONS, "_shared", "whatsapp-instance-alerts-core.ts");

const dispatcherSource = readFileSync(DISPATCHER, "utf8");
const workerSource = readFileSync(WORKER, "utf8");
const coreSource = readFileSync(CORE, "utf8");

describe("acoplamento por string com process-billing-notifications", () => {
  it("todo event_type canônico tem entrada em TEMPLATE_BY_EVENT", () => {
    const missing = CANONICAL_EVENT_TYPES.filter((e) => !dispatcherSource.includes(`${e}: (d)`));
    expect(
      missing,
      `Sem entrada em TEMPLATE_BY_EVENT: ${missing.join(", ")}. A linha enfileirada morreria em failed/unknown_event_type.`,
    ).toEqual([]);
  });

  it("nenhum produtor emite event_type fora da lista canônica", () => {
    // Qualquer literal `admin_zapi_*` no worker ou no núcleo tem de estar na
    // lista. Uma string hardcoded que escape da fonte canônica é exatamente o
    // modo de falha que este teste existe para pegar.
    const found = new Set<string>();
    for (const src of [workerSource, coreSource]) {
      for (const m of src.matchAll(/admin_zapi_[a-z0-9_]+/g)) found.add(m[0]);
    }
    const foreign = [...found].filter((e) => CANONICAL_EVENT_TYPES.indexOf(e) === -1);
    expect(
      foreign,
      `event_type fora da lista canônica: ${foreign.join(", ")}`,
    ).toEqual([]);
  });

  it("custo desconhecido não virou event_type em lugar nenhum", () => {
    expect(dispatcherSource).not.toContain("admin_zapi_cycle_cost_unknown");
    expect(workerSource).not.toContain("admin_zapi_cycle_cost_unknown");
  });

  it("os seis alert_type do ledger mapeiam para os seis event_type", () => {
    expect(Object.keys(EVENT_TYPE_BY_ALERT)).toHaveLength(6);
    expect(CANONICAL_EVENT_TYPES).toHaveLength(6);
  });

  it("controle positivo: o detector encontra um event_type que sabidamente existe", () => {
    // Sem isto, um padrão de busca quebrado passaria como "nada faltando".
    expect(dispatcherSource.includes("admin_invoice_category_review: (d)")).toBe(true);
    expect(dispatcherSource.includes("evento_que_nao_existe: (d)")).toBe(false);
  });
});
