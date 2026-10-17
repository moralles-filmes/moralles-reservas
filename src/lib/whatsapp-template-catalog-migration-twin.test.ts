import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TEMPLATE_CATALOG } from "../../supabase/functions/_shared/whatsapp-template-catalog-core";
import { SCHEDULED_KINDS } from "../../supabase/functions/_shared/whatsapp-automation-core";

/*
 * Gêmeos declarados: SQL não importa TypeScript. O catálogo oficial
 * (TEMPLATE_CATALOG) e os kinds do ledger (SCHEDULED_KINDS) se repetem como
 * listas FIXAS em CHECKs e corpos de função espalhados pelo histórico de
 * migrations. Este teste resolve o que está VIGENTE (última definição de cada
 * função e de cada CHECK, em ordem de arquivo) e confere cada lista contra o TS.
 * Uma função antiga esquecida com 7 ids recusaria em silêncio os modelos novos.
 *
 * Limites (cobertos pelo pré-voo 66, não por este teste): listas só de KIND
 * dentro de corpos (`kind in('confirmation','cancellation')`, `kind = '...'`)
 * não são comparadas; SQL dentro de `DO`/`execute format(...)` não é lido;
 * função redefinida com parâmetros renomeados deixa entrada vigente velha
 * (falha alto, por falso positivo); CASE pesquisado (`case when kind = ...`)
 * cai no alerta de literal fora de lista. Os mapeamentos kind→template e
 * kind→recurso abaixo são tabelas do teste, conferidas contra o catálogo.
 */

const MIGRATIONS_DIR = resolve(__dirname, "../../supabase/migrations");
const NEW_MIGRATION = "20261017120000_whatsapp_templates_table_ready_cancellation.sql";
const APPROVED_SUBMISSION_MIGRATION = "20261017200000_whatsapp_template_approved_submission_pilot.sql";
const TEMPLATE_ID = /^(res|fila|mkt)_[a-z_]+_v\d+$/;
const TEMPLATE_LITERAL = /'((?:res|fila|mkt)_[a-z_]+_v\d+)'/g;

interface SqlFile {
  name: string;
  sql: string;
}

const ALL_FILES: SqlFile[] = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((name) => ({ name, sql: readFileSync(resolve(MIGRATIONS_DIR, name), "utf8") }));

const CATALOG_IDS = Object.keys(TEMPLATE_CATALOG).sort();

/** Mapeamento kind → modelos que o TS escolhe (whatsapp-automation-resources.ts). */
const TS_KIND_TO_TEMPLATES: Record<string, string[]> = {
  confirmation: ["res_confirmacao_desconto_v1", "res_confirmacao_v1"],
  reminder_d1: ["res_lembrete_dia_v1"],
  survey_d1: ["res_pesquisa_reserva_v1"],
  waitlist_entered: ["fila_entrada_v1"],
  waitlist_feedback: ["fila_feedback_v1"],
  voucher_issued: ["mkt_voucher_programado_v1"],
  cancellation: ["res_cancelada_v1"],
  waitlist_table_ready: ["fila_mesa_pronta_v1"],
};

/** Gatilho declarado no catálogo → kind do ledger que o produz. */
const TRIGGER_TO_KIND: Record<string, string> = {
  reservation_confirmed: "confirmation",
  reservation_reminder: "reminder_d1",
  reservation_survey: "survey_d1",
  waitlist_entered: "waitlist_entered",
  waitlist_feedback: "waitlist_feedback",
  voucher_birthday: "voucher_issued",
  voucher_frequency: "voucher_issued",
  reservation_cancelled: "cancellation",
  waitlist_table_ready: "waitlist_table_ready",
};

/** Kind → coluna de recurso exigida pelo CHECK kind↔recurso. */
const TS_KIND_RESOURCE: Record<string, string> = {
  confirmation: "reservation",
  reminder_d1: "reservation",
  survey_d1: "reservation",
  cancellation: "reservation",
  waitlist_entered: "waitlist",
  waitlist_feedback: "waitlist",
  waitlist_table_ready: "waitlist",
  voucher_issued: "voucher",
};

// ---------------------------------------------------------------- lexer SQL

const DOLLAR_TAG = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

/** Remove comentários `--` e `/* *\/` respeitando strings e dollar-quotes (recursivo nos corpos). */
function stripComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += " ";
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "$" && !/\w/.test(sql[i - 1] ?? "")) {
      const m = DOLLAR_TAG.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        const inner = end === -1 ? sql.slice(i + tag.length) : sql.slice(i + tag.length, end);
        out += tag + stripComments(inner) + tag;
        i = end === -1 ? sql.length : end + tag.length;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/** Divide em statements por `;` fora de strings e dollar-quotes (entrada já sem comentários). */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      i = j + 1;
      continue;
    }
    if (ch === "$" && !/\w/.test(sql[i - 1] ?? "")) {
      const m = DOLLAR_TAG.exec(sql.slice(i));
      if (m) {
        const end = sql.indexOf(m[0], i + m[0].length);
        i = end === -1 ? sql.length : end + m[0].length;
        continue;
      }
    }
    if (ch === ";") {
      out.push(sql.slice(start, i).trim());
      start = i + 1;
    }
    i++;
  }
  const tail = sql.slice(start).trim();
  if (tail) out.push(tail);
  return out.filter(Boolean);
}

/** Conteúdo entre o `(` em `open` e o `)` correspondente, ignorando parênteses em strings. */
function balanced(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'") {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "'" && text[j + 1] === "'") j += 2;
        else if (text[j] === "'") break;
        else j++;
      }
      i = j;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return text.slice(open + 1, i);
  }
  throw new Error(`parênteses desbalanceados em: ${text.slice(open, open + 80)}`);
}

const qualify = (name: string) => (name.includes(".") ? name : `public.${name}`).toLowerCase();

// ------------------------------------------------- resolução do que é vigente

interface FunctionDef {
  key: string;
  name: string;
  arity: number;
  body: string;
  file: string;
}

type CheckClass = "logical_id" | "approved_catalog_logical_id" | "jobs_kind" | "jobs_kind_resource" | "pin_tuple";

interface CheckDef {
  cls: CheckClass;
  expr: string;
  file: string;
}

interface InForce {
  functions: FunctionDef[];
  checks: Map<CheckClass, CheckDef>;
  /** CHECKs que contêm id de modelo mas não caem em nenhuma das classes conhecidas. */
  unclassifiedChecks: string[];
}

function topLevelArity(args: string): number {
  if (!args.trim()) return 0;
  let depth = 0;
  let n = 1;
  for (const ch of args) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) n++;
  }
  return n;
}

function classifyCheck(table: string, expr: string): CheckClass | null {
  const e = expr.replace(/\s+/g, " ").trim();
  if (table === "public.whatsapp_remote_templates" && /\blogical_id in ?\(/i.test(e)) return "logical_id";
  if (table === "app_private.whatsapp_template_approved_submissions" && /\blogical_id in ?\(/i.test(e)) return "approved_catalog_logical_id";
  if (table !== "public.whatsapp_automation_jobs") return null;
  if (/\binitial_catalog_key in ?\(/i.test(e)) return "pin_tuple";
  if (/^\(? ?kind in ?\([^)]*\) ?\)?$/i.test(e)) return "jobs_kind";
  if (/\bkind in ?\(/i.test(e) && /\breservation_id is not null\b/i.test(e)) return "jobs_kind_resource";
  return null;
}

function resolveInForce(files: SqlFile[]): InForce {
  const functions = new Map<string, FunctionDef>();
  const checks = new Map<CheckClass, CheckDef>();
  const unclassified = new Map<string, string>();
  for (const file of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    for (const stmt of splitStatements(stripComments(file.sql))) {
      const fn = /^create\s+(?:or\s+replace\s+)?function\s+([\w.]+)\s*\(/i.exec(stmt);
      if (fn) {
        const open = fn.index + fn[0].length - 1;
        const args = balanced(stmt, open);
        const rest = stmt.slice(open + args.length + 2);
        const tag = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
        if (!tag) throw new Error(`corpo não encontrado em ${file.name}: ${fn[1]}`);
        const bodyStart = tag.index + tag[0].length;
        const bodyEnd = rest.indexOf(tag[0], bodyStart);
        const name = qualify(fn[1]);
        const key = `${name}(${args.replace(/\s+/g, "").toLowerCase()})`;
        functions.set(key, { key, name, arity: topLevelArity(args), body: rest.slice(bodyStart, bodyEnd), file: file.name });
        continue;
      }
      const drop = /^drop\s+function\s+(?:if\s+exists\s+)?([\w.]+)\s*(\()?/i.exec(stmt);
      if (drop) {
        const name = qualify(drop[1]);
        const arity = drop[2] ? topLevelArity(balanced(stmt, drop.index + drop[0].length - 1)) : null;
        for (const [k, f] of functions) if (f.name === name && (arity === null || f.arity === arity)) functions.delete(k);
        continue;
      }
      const table = /^(?:create\s+table\s+(?:if\s+not\s+exists\s+)?|alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?)([\w.]+)/i.exec(stmt);
      if (!table) continue;
      const tableName = qualify(table[1]);
      const re = /\bcheck\s*\(/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(stmt))) {
        const expr = balanced(stmt, m.index + m[0].length - 1);
        const cls = classifyCheck(tableName, expr);
        if (cls) {
          checks.set(cls, { cls, expr, file: file.name });
        } else if (new RegExp(TEMPLATE_LITERAL.source).test(expr)) {
          unclassified.set(`${tableName}:${expr.slice(0, 60)}`, `${file.name}:${tableName}`);
        }
      }
    }
  }
  return { functions: [...functions.values()], checks, unclassifiedChecks: [...unclassified.values()] };
}

// ---------------------------------------------------------------- extração

interface IdList {
  where: string;
  ids: string[];
  start: number;
  end: number;
}

/** Listas `in(...)` de literais em que algum membro é id de modelo. */
function templateIdLists(text: string, where: string): IdList[] {
  const out: IdList[] = [];
  const re = /\bin\s*\(\s*('[^']*'(?:\s*,\s*'[^']*')*)\s*\)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const ids = m[1].split(",").map((s) => s.trim().replace(/^'|'$/g, ""));
    if (ids.some((id) => TEMPLATE_ID.test(id))) out.push({ where, ids, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

interface KindCase {
  where: string;
  mapping: Record<string, string[]>;
  elseIds: string[];
  start: number;
  end: number;
}

/** `case <expr> when '<kind>' then ...` cujo resultado é id de modelo, com CASE aninhado no ramo. */
function kindTemplateCases(text: string, where: string): KindCase[] {
  const out: KindCase[] = [];
  const startRe = /\bcase\s+[\w.]+\s+when\s+'/gi;
  let s: RegExpExecArray | null;
  while ((s = startRe.exec(text))) {
    const tokens = /'(?:[^']|'')*'|\b(?:case|end|when|then|else)\b/gi;
    tokens.lastIndex = s.index;
    const mapping: Record<string, string[]> = {};
    let depth = -1;
    let branch: string | null = null;
    let collecting = false;
    let expectKind = false;
    let end = text.length;
    let t: RegExpExecArray | null;
    while ((t = tokens.exec(text))) {
      const tok = t[0].toLowerCase();
      if (tok === "case") {
        depth++;
        continue;
      }
      if (tok === "end") {
        if (depth === 0) {
          end = t.index + t[0].length;
          break;
        }
        depth--;
        continue;
      }
      if (depth === 0 && tok === "when") {
        expectKind = true;
        collecting = false;
        continue;
      }
      if (depth === 0 && tok === "then") {
        collecting = true;
        continue;
      }
      if (depth === 0 && tok === "else") {
        branch = "__else__";
        collecting = true;
        continue;
      }
      if (tok.startsWith("'")) {
        const lit = t[0].slice(1, -1);
        if (expectKind) {
          branch = lit;
          mapping[branch] ??= [];
          expectKind = false;
        } else if (collecting && branch && TEMPLATE_ID.test(lit)) {
          (mapping[branch] ??= []).push(lit);
        }
      }
    }
    const elseIds = mapping.__else__ ?? [];
    delete mapping.__else__;
    const producesTemplate = Object.values(mapping).some((ids) => ids.length > 0) || elseIds.length > 0;
    if (producesTemplate) {
      for (const k of Object.keys(mapping)) mapping[k] = [...new Set(mapping[k])].sort();
      out.push({ where, mapping, elseIds, start: s.index, end });
    }
    startRe.lastIndex = end;
  }
  return out;
}

/** Disjuntos `(kind in(...)|kind='x') and <recurso>_id is not null` do CHECK kind↔recurso. */
function kindResourcePairs(expr: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /\(\s*kind\s*(?:in\s*\(([^)]*)\)|=\s*'(\w+)')\s+and\s+(\w+)_id\s+is\s+not\s+null\s*\)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expr))) {
    const kinds = m[1] ? m[1].split(",").map((s) => s.trim().replace(/^'|'$/g, "")) : [m[2]];
    for (const k of kinds) out[k] = m[3];
  }
  return out;
}

// --------------------------------------------------------------- comparador

interface TwinReport {
  idLists: IdList[];
  cases: KindCase[];
  checks: Map<CheckClass, CheckDef>;
  mismatches: string[];
}

const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();
const sameSet = (a: Iterable<string>, b: Iterable<string>) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

function compareTwins(
  files: SqlFile[],
  expected = { ids: CATALOG_IDS, kinds: [...SCHEDULED_KINDS] as string[], kindTemplates: TS_KIND_TO_TEMPLATES, kindResource: TS_KIND_RESOURCE },
): TwinReport {
  const inForce = resolveInForce(files);
  const mismatches: string[] = inForce.unclassifiedChecks.map((w) => `CHECK não classificado com id de modelo: ${w}`);
  const idLists: IdList[] = [];
  const cases: KindCase[] = [];

  for (const fn of inForce.functions) {
    const where = `${fn.file}:${fn.key}`;
    const lists = templateIdLists(fn.body, where);
    const fnCases = kindTemplateCases(fn.body, where);
    idLists.push(...lists);
    cases.push(...fnCases);
    // Literal de modelo fora de lista/CASE reconhecido é um gêmeo que este teste não enxerga.
    const covered = [...lists, ...fnCases];
    for (const lit of fn.body.matchAll(TEMPLATE_LITERAL)) {
      const at = lit.index ?? 0;
      if (!covered.some((c) => at >= c.start && at < c.end)) mismatches.push(`${where}: literal ${lit[1]} fora de lista/CASE reconhecido`);
    }
  }

  for (const check of inForce.checks.values()) {
    idLists.push(...templateIdLists(check.expr, `${check.file}:CHECK ${check.cls}`));
  }
  for (const cls of ["logical_id", "jobs_kind", "jobs_kind_resource", "pin_tuple"] as const) {
    if (!inForce.checks.has(cls)) mismatches.push(`CHECK ${cls} vigente não encontrado`);
  }

  for (const list of idLists) {
    if (!sameSet(list.ids, expected.ids)) {
      const missing = expected.ids.filter((id) => !list.ids.includes(id));
      const extra = list.ids.filter((id) => !expected.ids.includes(id));
      mismatches.push(`${list.where}: lista de ids diverge (faltam [${missing}], sobram [${extra}])`);
    }
  }

  for (const c of cases) {
    if (c.elseIds.length) mismatches.push(`${c.where}: ramo else do CASE produz modelo [${c.elseIds}]`);
    if (!sameSet(Object.keys(c.mapping), Object.keys(expected.kindTemplates))) {
      mismatches.push(`${c.where}: kinds do CASE [${sorted(Object.keys(c.mapping))}] ≠ TS [${sorted(Object.keys(expected.kindTemplates))}]`);
    }
    for (const [kind, ids] of Object.entries(c.mapping)) {
      const want = expected.kindTemplates[kind];
      if (want && !sameSet(ids, want)) mismatches.push(`${c.where}: CASE ${kind} → [${ids}] ≠ TS [${want}]`);
    }
  }

  const kindCheck = inForce.checks.get("jobs_kind");
  if (kindCheck) {
    const m = /kind\s+in\s*\(([^)]*)\)/i.exec(kindCheck.expr);
    const kinds = m ? m[1].split(",").map((s) => s.trim().replace(/^'|'$/g, "")) : [];
    if (!sameSet(kinds, expected.kinds)) mismatches.push(`${kindCheck.file}: CHECK de kind [${sorted(kinds)}] ≠ SCHEDULED_KINDS [${sorted(expected.kinds)}]`);
  }
  const resourceCheck = inForce.checks.get("jobs_kind_resource");
  if (resourceCheck) {
    const pairs = kindResourcePairs(resourceCheck.expr);
    if (JSON.stringify(Object.entries(pairs).sort()) !== JSON.stringify(Object.entries(expected.kindResource).sort())) {
      mismatches.push(`${resourceCheck.file}: CHECK kind↔recurso ${JSON.stringify(pairs)} ≠ TS ${JSON.stringify(expected.kindResource)}`);
    }
  }

  return { idLists, cases, checks: inForce.checks, mismatches };
}

// -------------------------------------------------------------------- testes

describe("catálogo de modelos TS ⇔ listas fixas vigentes nas migrations", () => {
  const report = compareTwins(ALL_FILES);

  it("o mapeamento TS de referência é coerente com SCHEDULED_KINDS e com o catálogo", () => {
    expect(sorted(Object.keys(TS_KIND_TO_TEMPLATES))).toEqual(sorted(SCHEDULED_KINDS));
    expect(sorted(Object.keys(TS_KIND_RESOURCE))).toEqual(sorted(SCHEDULED_KINDS));
    expect(sorted(Object.values(TS_KIND_TO_TEMPLATES).flat())).toEqual(CATALOG_IDS);
    for (const [id, def] of Object.entries(TEMPLATE_CATALOG)) {
      expect(def.allowedTriggers.length, id).toBeGreaterThan(0);
      for (const trigger of def.allowedTriggers) {
        const kind = TRIGGER_TO_KIND[trigger];
        expect(kind, `gatilho ${trigger} de ${id} sem kind`).toBeDefined();
        expect(TS_KIND_TO_TEMPLATES[kind], `${id} deveria ser produzido por ${kind}`).toContain(id);
      }
    }
  });

  it("encontra o mínimo de lugares vigentes — o parser não pode passar no vazio", () => {
    const fnLists = report.idLists.filter((l) => !l.where.includes(":CHECK "));
    const checkLists = report.idLists.filter((l) => l.where.includes(":CHECK "));
    expect(fnLists.length).toBeGreaterThanOrEqual(3);
    expect(checkLists.length).toBeGreaterThanOrEqual(2);
    expect(report.cases.length).toBeGreaterThanOrEqual(4);
    expect([...report.checks.keys()].sort()).toEqual(["approved_catalog_logical_id", "jobs_kind", "jobs_kind_resource", "logical_id", "pin_tuple"]);
  });

  it("os CHECKs vigentes são os das migrations do catálogo e da aprovação", () => {
    for (const check of report.checks.values()) expect(check.file, check.cls).toBe(
      check.cls === "approved_catalog_logical_id" ? APPROVED_SUBMISSION_MIGRATION : NEW_MIGRATION,
    );
  });

  it("toda lista de ids, todo CASE kind→modelo e os CHECKs de kind concordam com o TS", () => {
    expect(report.mismatches).toEqual([]);
  });

  it("CONTROLE (RED): sem as migrations novas, o histórico diverge do TS em todas as classes", () => {
    const red = compareTwins(ALL_FILES.filter((f) => f.name !== NEW_MIGRATION && f.name !== APPROVED_SUBMISSION_MIGRATION));
    const joined = red.mismatches.join("\n");
    expect(red.mismatches.length).toBeGreaterThan(0);
    expect(joined).toMatch(/CHECK logical_id: lista de ids diverge/);
    expect(joined).toMatch(/CHECK pin_tuple: lista de ids diverge/);
    expect(joined).toMatch(/CHECK de kind/);
    expect(joined).toMatch(/CHECK kind↔recurso/);
    expect(joined).toMatch(/CASE cancellation|kinds do CASE/);
    expect(joined).toMatch(/prepare_whatsapp_template_provision.*lista de ids diverge/);
  });
});

describe("CONTROLES POSITIVOS do comparador", () => {
  const ids = CATALOG_IDS.map((id) => `'${id}'`);
  const kinds = SCHEDULED_KINDS.map((k) => `'${k}'`);
  const resourceCheck =
    "check((kind in('confirmation','reminder_d1','survey_d1','cancellation') and reservation_id is not null) or " +
    "(kind in('waitlist_entered','waitlist_feedback','waitlist_table_ready') and waitlist_id is not null) or (kind='voucher_issued' and voucher_id is not null))";
  const caseSql = (confirmation = "'res_confirmacao_v1'", cancellation = "'res_cancelada_v1'") =>
    `v:=case k when 'confirmation' then case when x then 'res_confirmacao_desconto_v1' else ${confirmation} end ` +
    `when 'reminder_d1' then 'res_lembrete_dia_v1' when 'survey_d1' then 'res_pesquisa_reserva_v1' when 'waitlist_entered' then 'fila_entrada_v1' ` +
    `when 'waitlist_feedback' then 'fila_feedback_v1' when 'voucher_issued' then 'mkt_voucher_programado_v1' when 'cancellation' then ${cancellation} ` +
    `when 'waitlist_table_ready' then 'fila_mesa_pronta_v1' end;`;
  const synthetic = (o: { idList?: string[]; kindList?: string[]; caseBody?: string; fnIds?: string[] } = {}): SqlFile[] => [
    {
      name: "00000000000001_synthetic.sql",
      sql: [
        `create table public.whatsapp_remote_templates (logical_id text not null check(logical_id in(${(o.idList ?? ids).join(",")})));`,
        `create table public.whatsapp_automation_jobs (kind text not null check(kind in(${(o.kindList ?? kinds).join(",")})), ${resourceCheck});`,
        `alter table public.whatsapp_automation_jobs add constraint whatsapp_automation_pin_tuple_check check(initial_catalog_key is null or initial_catalog_key in(${ids.join(",")}));`,
        `create or replace function public.f(p uuid) returns void language plpgsql as $$ begin -- comentário com ; e 'aspas`,
        `  if x not in(${(o.fnIds ?? ids).join(",")}) then return; end if; ${o.caseBody ?? caseSql()} end $$;`,
      ].join("\n"),
    },
  ];

  it("o SQL sintético íntegro passa (base dos controles)", () => {
    const r = compareTwins(synthetic());
    expect(r.mismatches).toEqual([]);
    expect(r.cases).toHaveLength(1);
    expect(r.idLists).toHaveLength(3);
  });

  it("CHECK de logical_id sem um id reprova", () => {
    const r = compareTwins(synthetic({ idList: ids.filter((id) => id !== "'res_cancelada_v1'") }));
    expect(r.mismatches.join("\n")).toMatch(/CHECK logical_id: lista de ids diverge \(faltam \[res_cancelada_v1\]/);
  });

  it("lista de função sem um id reprova", () => {
    const r = compareTwins(synthetic({ fnIds: ids.filter((id) => id !== "'fila_mesa_pronta_v1'") }));
    expect(r.mismatches.join("\n")).toMatch(/public\.f\(puuid\): lista de ids diverge \(faltam \[fila_mesa_pronta_v1\]/);
  });

  it("CHECK de kind com um kind a mais reprova", () => {
    const r = compareTwins(synthetic({ kindList: [...kinds, "'walk_in'"] }));
    expect(r.mismatches.join("\n")).toMatch(/CHECK de kind .*walk_in/);
  });

  it("CASE com mapeamento trocado reprova", () => {
    const r = compareTwins(synthetic({ caseBody: caseSql("'res_confirmacao_v1'", "'res_confirmacao_v1'") }));
    expect(r.mismatches.join("\n")).toMatch(/CASE cancellation → \[res_confirmacao_v1\] ≠ TS \[res_cancelada_v1\]/);
  });

  it("CASE sem o ramo do kind novo reprova", () => {
    const body = caseSql().replace("when 'waitlist_table_ready' then 'fila_mesa_pronta_v1' ", "");
    const r = compareTwins(synthetic({ caseBody: body }));
    expect(r.mismatches.join("\n")).toMatch(/kinds do CASE/);
  });

  it("redefinição posterior com lista velha vence (última definição é a vigente)", () => {
    const files = [
      ...synthetic(),
      {
        name: "00000000000002_regression.sql",
        sql: `create or replace function public.f(p uuid) returns void language plpgsql as $$ begin if x not in(${ids.slice(0, 7).join(",")}) then return; end if; ${caseSql()} end $$;`,
      },
    ];
    expect(compareTwins(files).mismatches.join("\n")).toMatch(/00000000000002_regression\.sql:public\.f\(puuid\): lista de ids diverge/);
  });

  it("função removida por drop deixa de ser vigente", () => {
    const files = [
      ...synthetic({ fnIds: ids.slice(0, 7) }),
      { name: "00000000000002_drop.sql", sql: "drop function if exists public.f(uuid);" },
    ];
    expect(compareTwins(files).mismatches.join("\n")).not.toMatch(/public\.f/);
  });
});
