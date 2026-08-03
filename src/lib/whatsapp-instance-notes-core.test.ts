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

/** Os valores literais dentro de `check (action in ( ... ))`. */
function actionsInMigrationCheck(): string[] {
  const sql = readFileSync(MIGRATION, "utf8");
  const m = sql.match(/action\s+text\s+not\s+null\s+check\s*\(\s*action\s+in\s*\(([^)]*)\)/i);
  if (!m) throw new Error("CHECK de `action` não encontrado na migration 096");
  return Array.from(m[1].matchAll(/'([A-Z_]+)'/g)).map((x) => x[1]);
}

describe("INSTANCE_NOTE_ACTIONS", () => {
  it("tem exatamente as sete ações que mudam a instância e pedem motivo", () => {
    expect([...INSTANCE_NOTE_ACTIONS]).toEqual([
      "REGISTER",
      "UPDATE",
      "REACTIVATE",
      "SET_COST",
      "CONFIRM_CYCLE_DATE",
      "REQUEST_CANCELLATION",
      "CONFIRM_END",
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
