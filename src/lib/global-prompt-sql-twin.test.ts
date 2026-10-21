import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_MODES,
  CONTROL_CHAR_CLASS,
  GLOBAL_PERSONA_BASELINE,
  GLOBAL_PROMPT_MAX_CHARS,
  GLOBAL_PROMPT_NOTE_MAX_CHARS,
  GLOBAL_PROMPT_PLACEHOLDERS,
  GLOBAL_PROMPT_SLOT,
  STORE_TEXT_LIMITS,
  isValidGlobalPromptNote,
} from "../../supabase/functions/_shared/agent/global-prompt-core";
import { composeAgentSystemPrompt, type AgentPromptParts } from "../../supabase/functions/_shared/agent/system-prompt";

/**
 * Gêmeos SQL <-> TS da camada global do prompt e do guard de valor de
 * `settings` (spec Entrega B §4.2, §4.3, §5.1, §6.2; plano B2.3).
 *
 * O SQL é o da migration `*_ai_global_prompt_and_settings_value_guard.sql`
 * (única). Cada extração falha alto se vier vazia: mudou a forma do SQL, o
 * teste quebra em vez de comparar conjunto vazio. O controle positivo roda
 * `twinDiffs` sobre SQL sintético divergente, um campo por vez.
 */

const ROOT = resolve(__dirname, "../..");
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");
const MIGRATION_SUFFIX = "_ai_global_prompt_and_settings_value_guard.sql";

function migrationSql(): string {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(MIGRATION_SUFFIX));
  if (files.length !== 1) throw new Error(`esperada 1 migration *${MIGRATION_SUFFIX}, achei ${files.length}`);
  return readFileSync(join(MIGRATIONS_DIR, files[0]), "utf8").replace(/\r\n/g, "\n");
}

/** Corpo SQL de `create or replace function <name>(...) ... $$ ... $$`. */
function functionBody(sql: string, name: string): string {
  const re = new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+${name.replace(".", "\\.")}\\s*\\([\\s\\S]*?\\$\\$([\\s\\S]*?)\\$\\$`,
    "i",
  );
  const m = sql.match(re);
  if (!m) throw new Error(`função ${name} não encontrada`);
  return m[1];
}

interface SqlTwin {
  seed: string;
  placeholders: string[];
  bodyMax: number;
  noteMax: number;
  noteNonBlank: string;
  valueLimits: Record<string, number>;
  agentModes: string[];
  slots: string[];
  bodyControlClass: string;
  valueControlClass: string;
}

function extractTwin(sql: string): SqlTwin {
  const seeds = [...sql.matchAll(/\$seed\$([\s\S]*?)\$seed\$/g)].map((m) => m[1]);
  if (seeds.length !== 1) throw new Error(`esperado 1 seed $seed$…$seed$, achei ${seeds.length}`);

  const body = functionBody(sql, "app_private.ai_prompt_body_valid");
  const ph = body.match(/regexp_replace\(p_body,\s*'\\\{\\\{\(([a-z_|]+)\)\\\}\\\}'/);
  if (!ph) throw new Error("regex de placeholders não encontrada em ai_prompt_body_valid");
  const max = body.match(/char_length\(p_body\)\s+between\s+1\s+and\s+(\d+)/);
  if (!max) throw new Error("limite do corpo não encontrado em ai_prompt_body_valid");
  const bodyCtl = body.match(/p_body\s*!~\s*'(\[\\x01[^']*\])'/);
  if (!bodyCtl) throw new Error("classe de controle não encontrada em ai_prompt_body_valid");

  const note = functionBody(sql, "app_private.ai_prompt_note_valid");
  const noteMax = note.match(/char_length\(p_note\)\s+between\s+1\s+and\s+(\d+)/);
  if (!noteMax) throw new Error("limite do motivo não encontrado em ai_prompt_note_valid");
  const noteNonBlank = note.match(/p_note\s*~\s*'([^']+)'/);
  if (!noteNonBlank) throw new Error("regex de não branco não encontrada em ai_prompt_note_valid");

  const limitFn = functionBody(sql, "app_private.unit_setting_value_limit");
  const valueLimits = Object.fromEntries(
    [...limitFn.matchAll(/when\s+'([a-z_]+)'\s+then\s+(\d+)/g)].map((m) => [m[1], Number(m[2])]),
  );
  if (Object.keys(valueLimits).length === 0) throw new Error("limites não encontrados em unit_setting_value_limit");

  const guard = functionBody(sql, "app_private.guard_unit_setting_value");
  const modes = guard.match(/<>\s*all\s*\(\s*array\[([^\]]+)\]\s*\)/);
  if (!modes) throw new Error("enum de agent_mode não encontrado em guard_unit_setting_value");
  const valueCtl = guard.match(/v_text\s*~\s*'(\[\\x01[^']*\])'/);
  if (!valueCtl) throw new Error("classe de controle não encontrada em guard_unit_setting_value");

  const slots = [...sql.matchAll(/check\s*\(\s*slot\s+in\s*\(([^)]*)\)\s*\)/g)].map((m) => m[1]);
  if (slots.length === 0) throw new Error("CHECK de slot não encontrado");

  return {
    seed: seeds[0],
    placeholders: ph[1].split("|"),
    bodyMax: Number(max[1]),
    noteMax: Number(noteMax[1]),
    noteNonBlank: noteNonBlank[1],
    valueLimits,
    agentModes: [...modes[1].matchAll(/'([^']+)'/g)].map((m) => m[1]),
    slots,
    bodyControlClass: bodyCtl[1],
    valueControlClass: valueCtl[1],
  };
}

/** Divergências entre o SQL e o núcleo TS; vazia quando são gêmeos. */
function twinDiffs(t: SqlTwin): string[] {
  const out: string[] = [];
  if (t.seed !== GLOBAL_PERSONA_BASELINE) out.push("seed != GLOBAL_PERSONA_BASELINE");
  if (JSON.stringify([...t.placeholders].sort()) !== JSON.stringify([...GLOBAL_PROMPT_PLACEHOLDERS].sort())) {
    out.push(`placeholders ${JSON.stringify(t.placeholders)} != ${JSON.stringify(GLOBAL_PROMPT_PLACEHOLDERS)}`);
  }
  if (t.bodyMax !== GLOBAL_PROMPT_MAX_CHARS) out.push(`limite do corpo ${t.bodyMax} != ${GLOBAL_PROMPT_MAX_CHARS}`);
  if (t.noteMax !== GLOBAL_PROMPT_NOTE_MAX_CHARS) out.push(`limite do motivo ${t.noteMax} != ${GLOBAL_PROMPT_NOTE_MAX_CHARS}`);
  if (t.noteNonBlank !== "\\S") out.push(`regex de não branco do motivo ${t.noteNonBlank} != \\S`);
  const keys = new Set([...Object.keys(t.valueLimits), ...Object.keys(STORE_TEXT_LIMITS)]);
  for (const k of keys) {
    const sql = t.valueLimits[k];
    const ts = (STORE_TEXT_LIMITS as Record<string, number>)[k];
    if (sql !== ts) out.push(`limite ${k}: SQL ${sql} != TS ${ts}`);
  }
  if (JSON.stringify([...t.agentModes].sort()) !== JSON.stringify([...AGENT_MODES].sort())) {
    out.push(`agent_mode ${JSON.stringify(t.agentModes)} != ${JSON.stringify(AGENT_MODES)}`);
  }
  for (const s of t.slots) {
    if (s !== `'${GLOBAL_PROMPT_SLOT}'`) out.push(`CHECK de slot ${s} != '${GLOBAL_PROMPT_SLOT}'`);
  }
  if (t.bodyControlClass !== `[${CONTROL_CHAR_CLASS}]`) {
    out.push(`classe de controle do SQL ${t.bodyControlClass} != CONTROL_CHAR_CLASS [${CONTROL_CHAR_CLASS}]`);
  }
  if (t.bodyControlClass !== t.valueControlClass) {
    out.push(`classe de controle do corpo ${t.bodyControlClass} != do guard de valor ${t.valueControlClass}`);
  }
  return out;
}

const SQL = migrationSql();
const TWIN = extractTwin(SQL);

describe("prompt global: gêmeos SQL <-> TS", () => {
  it("o SQL da migration é gêmeo do núcleo TS", () => {
    expect(twinDiffs(TWIN)).toEqual([]);
  });

  it("o seed é o texto inteiro, com os dois placeholders e sem interpolação de template", () => {
    expect(TWIN.seed.startsWith("IDENTIDADE: ")).toBe(true);
    expect(TWIN.seed.endsWith("Evite excesso de emojis. ")).toBe(true);
    expect(TWIN.seed).not.toMatch(/\$\{|`/);
    expect([...TWIN.seed.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort())
      .toEqual(["agent_name", "agent_name", "restaurant_name", "restaurant_name"]);
    expect(GLOBAL_PERSONA_BASELINE.length).toBeLessThanOrEqual(GLOBAL_PROMPT_MAX_CHARS);
  });

  it("três tabelas declaram o CHECK de slot", () => {
    expect(TWIN.slots).toHaveLength(3);
  });
});

describe("prompt global: o baseline renderizado é o trecho atual do prompt", () => {
  const parts = (over: Partial<AgentPromptParts>): AgentPromptParts => ({
    includeFaq: false, agentName: "Yumi", restaurantName: "Exemplo", globalPromptBody: GLOBAL_PERSONA_BASELINE,
    identityLine: "IDENTIDADE_DO_CANAL.",
    todayBR: "segunda-feira, 05/10/2026", weekdayName: "segunda-feira", upcomingDaysLines: ["- amanhã: terça-feira"],
    customerFirstName: "", formattingRules: "FORMATACAO_DO_CANAL", unitAddress: "", restaurantInfoLines: [],
    hallScheduleBlock: null, hoursLines: [], specialLines: [], blockedLines: [], giftbackLines: [], prefsLines: [],
    customPrompt: "", settingsMap: {}, ...over,
  });
  const render = (agentName: string, restaurantName: string) =>
    GLOBAL_PERSONA_BASELINE.replaceAll("{{agent_name}}", agentName).replaceAll("{{restaurant_name}}", restaurantName);

  for (const includeFaq of [false, true]) {
    it(`entre o cabeçalho e a identidade do canal (includeFaq=${includeFaq})`, () => {
      const prompt = composeAgentSystemPrompt(parts({ includeFaq, agentName: "Lia", restaurantName: "Casa X" }));
      const start = prompt.indexOf("IDENTIDADE: ");
      const end = prompt.indexOf("IDENTIDADE_DO_CANAL.");
      expect(start).toBeGreaterThan(0);
      expect(prompt.slice(start, end)).toBe(render("Lia", "Casa X"));
    });
  }
});

describe("prompt global: validação do motivo (gêmea de ai_prompt_note_valid)", () => {
  it("aceita de 1 a 280 caracteres com algum não branco", () => {
    expect(isValidGlobalPromptNote("a")).toBe(true);
    expect(isValidGlobalPromptNote("a".repeat(280))).toBe(true);
    expect(isValidGlobalPromptNote("  tom mais curto  ")).toBe(true);
  });

  it("recusa vazio, só brancos, acima de 280 e não string", () => {
    expect(isValidGlobalPromptNote("")).toBe(false);
    expect(isValidGlobalPromptNote(" \n\t ")).toBe(false);
    expect(isValidGlobalPromptNote("a".repeat(281))).toBe(false);
    expect(isValidGlobalPromptNote(null)).toBe(false);
    expect(isValidGlobalPromptNote(undefined)).toBe(false);
    expect(isValidGlobalPromptNote(42)).toBe(false);
  });

  it("conta code points como char_length (emoji conta 1)", () => {
    expect(isValidGlobalPromptNote("😀".repeat(280))).toBe(true);
    expect(isValidGlobalPromptNote("😀".repeat(281))).toBe(false);
  });
});

describe("controle positivo: twinDiffs reprova SQL divergente", () => {
  const mutate = (from: string | RegExp, to: string) => {
    const mutated = SQL.replace(from, to);
    expect(mutated, `mutação sem efeito: ${String(from)}`).not.toBe(SQL);
    return twinDiffs(extractTwin(mutated));
  };

  it("seed com um caractere a mais", () => {
    expect(mutate("Evite excesso de emojis. $seed$", "Evite excesso de emojis.. $seed$")).toEqual([
      "seed != GLOBAL_PERSONA_BASELINE",
    ]);
  });

  it("placeholder novo na regex do corpo", () => {
    expect(mutate("(agent_name|restaurant_name)", "(agent_name|restaurant_name|unit_city)")[0]).toMatch(/^placeholders/);
  });

  it("limite do corpo diferente", () => {
    expect(mutate("between 1 and 4000", "between 1 and 4001")).toEqual(["limite do corpo 4001 != 4000"]);
  });

  it("limite do motivo diferente", () => {
    expect(mutate("char_length(p_note) between 1 and 280", "char_length(p_note) between 1 and 281")).toEqual([
      "limite do motivo 281 != 280",
    ]);
  });

  it("regex de não branco do motivo diferente", () => {
    expect(mutate("p_note ~ '\\S'", "p_note ~ '\\w'")).toEqual(["regex de não branco do motivo \\w != \\S"]);
  });

  it("limite de chave diferente, chave a mais e chave a menos", () => {
    expect(mutate("then 6000", "then 6001")).toEqual(["limite restaurant_menu: SQL 6001 != TS 6000"]);
    expect(mutate("when 'agent_name' then 40", "when 'agent_name' then 40\n    when 'foo' then 1")).toEqual([
      "limite foo: SQL 1 != TS undefined",
    ]);
    expect(mutate("    when 'agent_name' then 40\n", "")).toEqual(["limite agent_name: SQL undefined != TS 40"]);
  });

  it("enum de agent_mode diferente", () => {
    expect(mutate("array['reservations', 'reservations_faq']", "array['reservations']")[0]).toMatch(/^agent_mode/);
  });

  it("slot diferente numa das tabelas", () => {
    expect(mutate(/(slot\s+text primary key check \(slot in \()'global_persona'/, "$1'outro'")[0])
      .toMatch(/^CHECK de slot 'outro'/);
  });

  it("classes de controle divergentes entre corpo e guard de valor", () => {
    expect(mutate("v_text ~ '[\\x01-\\x08\\x0b-\\x1f\\x7f]'", "v_text ~ '[\\x01-\\x08\\x0e-\\x1f\\x7f]'")[0])
      .toMatch(/^classe de controle/);
  });

  it("classe de controle do corpo diferente da do núcleo TS", () => {
    expect(mutate("p_body !~ '[\\x01-\\x08\\x0b-\\x1f\\x7f]'", "p_body !~ '[\\x01-\\x08\\x0e-\\x1f\\x7f]'")[0])
      .toMatch(/^classe de controle do SQL .* != CONTROL_CHAR_CLASS/);
  });

  it("os extratores reprovam SQL com outra forma", () => {
    expect(() => extractTwin("select 1")).toThrow();
    expect(() => extractTwin(SQL.replace(/\$seed\$/g, "$x$"))).toThrow(/seed/);
  });
});
