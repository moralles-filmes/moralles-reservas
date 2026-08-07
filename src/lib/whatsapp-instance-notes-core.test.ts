/**
 * Acoplamento constante ↔ CHECK da migration, nas DUAS direções.
 *
 * O CHECK de `whatsapp_instance_notes.action` e `INSTANCE_NOTE_ACTIONS` são a
 * mesma lista escrita em duas linguagens. Divergir uma delas produz um erro que
 * só aparece em runtime, contra o banco, no dia em que a ação nova for usada —
 * e best-effort como o helper é, ele engoliria o erro e o histórico sumiria em
 * silêncio. Mesmo padrão do teste bidirecional dos `event_type` da Fase 6b.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  INSTANCE_NOTE_ACTIONS,
  isInstanceNoteAction,
} from "../../supabase/functions/_shared/whatsapp-instance-notes-core";

const MIGRATION = join(
  __dirname,
  "..",
  "..",
  "supabase",
  "migrations",
  "20260803120000_096_whatsapp_instance_notes.sql",
);

const MIGRATION_104 = join(
  __dirname,
  "..",
  "..",
  "supabase",
  "migrations",
  "20260807100000_104_whatsapp_cycle_cost_and_end.sql",
);

/**
 * Os valores do CHECK **EFETIVO** de `action`, e nao os da 096 isolada.
 *
 * A 104 faz `drop constraint if exists` + `add constraint` com a lista
 * estendida: depois de aplicada, o CHECK que o banco tem e o DELA. Ler so a
 * 096 fixaria o teste numa foto anterior a migration seguinte — e o proximo
 * valor novo passaria a exigir editar a 096, que e migration aplicada e nao se
 * reescreve.
 */
function actionsInMigrationCheck(): string[] {
  const sql104 = readFileSync(MIGRATION_104, "utf8");
  const m104 = sql104.match(/add\s+constraint\s+whatsapp_instance_notes_action_check\s+check\s*\(\s*action\s+in\s*\(([^)]*)\)/i);
  if (m104) return Array.from(m104[1].matchAll(/'([A-Z_]+)'/g)).map((x) => x[1]);

  const sql = readFileSync(MIGRATION, "utf8");
  const m = sql.match(/action\s+text\s+not\s+null\s+check\s*\(\s*action\s+in\s*\(([^)]*)\)/i);
  if (!m) throw new Error("CHECK de `action` não encontrado na migration 096");
  return Array.from(m[1].matchAll(/'([A-Z_]+)'/g)).map((x) => x[1]);
}

/**
 * Corpo executável de `whatsapp_instance_note_guard()`, com todo comentário
 * `-- ...` removido linha a linha. A remoção de comentário é essencial aqui:
 * o comentário da migration cita literalmente a condição antiga com `<>` para
 * explicar a divergência com a 089, e sem remover essas linhas o teste que
 * proíbe `<>` acusaria falso positivo no texto do COMENTÁRIO, não do CÓDIGO.
 */
function noteGuardFunctionBody(): string {
  const sql = readFileSync(MIGRATION, "utf8");
  const m = sql.match(
    /create or replace function public\.whatsapp_instance_note_guard\(\)[\s\S]*?as \$\$([\s\S]*?)\$\$;/i,
  );
  if (!m) throw new Error("corpo de whatsapp_instance_note_guard() nao encontrado na migration 096");
  return m[1]
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

/** O bloco `if ... end if;` que guarda a mudança de `instance_id`, código-only. */
function instanceIdGuardClause(): string {
  const body = noteGuardFunctionBody();
  const m = body.match(/if\s+old\.instance_id[\s\S]*?end if;/i);
  if (!m) throw new Error("clausula de guarda de instance_id nao encontrada");
  return m[0];
}

/**
 * Reimplementação em JS da fórmula extraída da migration
 * (`old.instance_id is distinct from new.instance_id and new.instance_id is
 * not null`), avaliada com a semântica de NULL do Postgres — `is distinct
 * from` nunca produz UNKNOWN, então NULL se compara como qualquer valor.
 *
 * NÃO é execução da trigger contra um banco (não há banco nesta frente) — é
 * uma simulação da fórmula, cujo texto real é conferido separadamente por
 * `instanceIdGuardClause()`. Confirma que a fórmula ESCRITA no SQL, se o
 * Postgres avaliar `is distinct from` como documentado, produz o veredito
 * certo nas quatro transições. Não prova o comportamento do banco em runtime.
 */
function raisesForInstanceIdTransition(oldId: string | null, newId: string | null): boolean {
  const isDistinct = oldId !== newId; // is distinct from: NULL comparável, sem UNKNOWN
  return isDistinct && newId !== null;
}

describe("INSTANCE_NOTE_ACTIONS", () => {
  it("tem as sete ações que mudam a instância mais a correção de ciclo passado", () => {
    expect([...INSTANCE_NOTE_ACTIONS]).toEqual([
      "REGISTER",
      "UPDATE",
      "REACTIVATE",
      "SET_COST",
      "CONFIRM_CYCLE_DATE",
      "REQUEST_CANCELLATION",
      "CONFIRM_END",
      "CORRECT_CYCLE_COST",
    ]);
  });

  it("não inclui as ações de alerta, que têm ledger próprio", () => {
    expect(isInstanceNoteAction("ACKNOWLEDGE_ALERT")).toBe(false);
    expect(isInstanceNoteAction("RESOLVE_ALERT")).toBe(false);
  });

  it("recusa valor que não é string", () => {
    expect(isInstanceNoteAction(null)).toBe(false);
    expect(isInstanceNoteAction(7)).toBe(false);
    expect(isInstanceNoteAction(undefined)).toBe(false);
  });

  it("toda constante do núcleo está no CHECK da migration", () => {
    const inCheck = new Set(actionsInMigrationCheck());
    for (const a of INSTANCE_NOTE_ACTIONS) expect(inCheck.has(a)).toBe(true);
  });

  it("o CHECK da migration não tem valor fora do núcleo", () => {
    for (const a of actionsInMigrationCheck()) expect(isInstanceNoteAction(a)).toBe(true);
  });
});

/**
 * VERIFICAÇÃO ESTÁTICA DO TEXTO SQL — não é prova de comportamento da
 * trigger. Não há banco nesta frente: nenhum destes casos insere ou atualiza
 * uma linha de verdade. O que cada caso confirma é (a) que a cláusula que
 * decide a mudança de `instance_id` está escrita com `is distinct from` (a
 * única forma que enxerga NULL sem produzir UNKNOWN) e não com `<>` puro, e
 * (b) que a fórmula extraída, quando avaliada com a semântica de NULL do
 * Postgres, produz o veredito esperado nas quatro transições. Nome de caso
 * nenhum aqui afirma "a trigger recusa X" — afirma que o TEXTO da migration
 * está redigido do jeito que recusaria X, se o Postgres se comportar como
 * `is distinct from` está documentado a se comportar.
 */
describe("guarda de instance_id na migration (verificação estática do texto SQL)", () => {
  it("a cláusula usa `is distinct from`, nunca `<>` puro, na comparação de instance_id", () => {
    const clause = instanceIdGuardClause();
    expect(clause).toMatch(/old\.instance_id\s+is\s+distinct\s+from\s+new\.instance_id/i);
    // Trava a regressão para a forma antiga (`old.instance_id is not null and
    // new.instance_id is not null and new.instance_id <> old.instance_id`),
    // que é UNKNOWN — e portanto muda — quando um dos lados é NULL.
    expect(clause).not.toMatch(/<>/);
  });

  it("formula: instance_id inalterado (nao-nulo) — sem violacao", () => {
    expect(raisesForInstanceIdTransition("inst-1", "inst-1")).toBe(false);
  });

  it("formula: instance_id inalterado (nulo dos dois lados) — sem violacao", () => {
    expect(raisesForInstanceIdTransition(null, null)).toBe(false);
  });

  it("formula: uuid -> NULL (nulagem pela FK apos exclusao da instancia) — sem violacao", () => {
    expect(raisesForInstanceIdTransition("inst-1", null)).toBe(false);
  });

  it("formula: uuid -> outro uuid (reapontar para instancia diferente) — viola", () => {
    expect(raisesForInstanceIdTransition("inst-1", "inst-2")).toBe(true);
  });

  it("formula: NULL -> uuid (reatar observacao ja orfa a uma instancia viva) — viola", () => {
    expect(raisesForInstanceIdTransition(null, "inst-1")).toBe(true);
  });

  it("o bloco append-only guarda instance_ref, organization_id, action, note, created_by e created_at", () => {
    const body = noteGuardFunctionBody();
    for (const field of [
      "instance_ref",
      "organization_id",
      "action",
      "note",
      "created_by",
      "created_at",
    ]) {
      const pattern = new RegExp(`new\\.${field}\\s+is\\s+distinct\\s+from\\s+old\\.${field}`, "i");
      expect(body).toMatch(pattern);
    }
  });
});
