/**
 * Guardrail do ACOPLAMENTO POR STRING entre o produtor de alertas da Fase 6b e
 * o dispatcher `process-billing-notifications`.
 *
 * As duas Edge Functions não compartilham nenhum arquivo `_shared/` para esse
 * acoplamento — é só o `event_type`, uma string. Sem a entrada em
 * `TEMPLATE_BY_EVENT`, a linha enfileirada morre em `failed/unknown_event_type`
 * e o aviso some em silêncio. Esta é a QUINTA ocorrência do mesmo padrão no
 * projeto (já registrado no CLAUDE.md para `process-asaas-invoice-reconcile`,
 * `process-whatsapp-enforcement` e `manage-billing`) — as quatro anteriores
 * foram tratadas por disciplina de redeploy conjunto, e disciplina não é teste.
 *
 * Aqui a conferência vira automática: o teste lê o arquivo do dispatcher e
 * exige uma entrada para cada `event_type` que o núcleo declara emitir.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EVENT_TYPE_BY_ALERT } from "../../supabase/functions/_shared/whatsapp-instance-alerts-core";

const DISPATCHER = join(
  __dirname,
  "..",
  "..",
  "supabase",
  "functions",
  "process-billing-notifications",
  "index.ts",
);

describe("acoplamento por string com process-billing-notifications", () => {
  const source = readFileSync(DISPATCHER, "utf8");

  it("todo event_type emitido pela Fase 6b tem entrada em TEMPLATE_BY_EVENT", () => {
    const missing = Object.values(EVENT_TYPE_BY_ALERT).filter(
      (eventType) => !source.includes(`${eventType}: (d)`),
    );
    expect(
      missing,
      `Sem entrada em TEMPLATE_BY_EVENT: ${missing.join(", ")}. A linha enfileirada morreria em failed/unknown_event_type.`,
    ).toEqual([]);
  });

  it("DATE_REVIEW_REQUIRED NÃO tem template — nenhum e-mail afirma uma data não confirmada", () => {
    expect(source).not.toContain("admin_zapi_date_review");
  });

  it("controle positivo: o detector encontra um event_type que sabidamente existe", () => {
    // Sem isto, um padrão de busca quebrado passaria como "nada faltando".
    expect(source.includes("admin_invoice_category_review: (d)")).toBe(true);
    expect(source.includes("evento_que_nao_existe: (d)")).toBe(false);
  });
});
