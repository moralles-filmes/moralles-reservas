/**
 * Acoplamento: classificador `app_private.unit_setting_write_class` <-> chaves que a Gestão grava.
 *
 * O trigger `settings_write_role_guard` deixa owner/gerente gravarem em `settings` só as
 * chaves da classe `manager` (a lista literal da função SQL); o resto é só de platform_admin
 * e service_role. A Gestão (telas do cliente) grava um conjunto fechado de chaves. Se uma
 * tela nova gravar chave fora da lista, o dono recebe `42501` em produção; se a lista
 * ganhar chave que nenhuma tela grava, o operador-gerente ganha poder sem uso. Este teste
 * prende os dois lados: igualdade de conjuntos, mais a prova de que as chaves de IA/prompt
 * de Automacao.tsx que são só da plataforma continuam fora da lista. As 3 chaves factuais da
 * loja (AI_STORE_SETTING_KEYS) o PromptTab também grava, para o admin, e são `manager`.
 *
 * Lê a função EFETIVA: o último arquivo de migration, em ordem de nome, que a define.
 * As chaves da Gestão vêm de GIFTBACK_SETTING_KEYS, WAITLIST_SETTING_KEYS e AI_STORE_SETTING_KEYS (importadas),
 * de SETTING_KEYS em Ajustes.tsx (regex no fonte: é página React, não se importa) e de
 * `allow_overbooking` / `restaurant_name`, cuja presença nos fontes é conferida por regex.
 * Limite: escritor novo em arquivo fora desta lista não é visto aqui; acrescente a fonte
 * ao teste junto com a chave no classificador.
 *
 * Toda extração por regex falha alto se vier vazia: mudou a forma do fonte, o teste quebra
 * em vez de passar sobre conjunto vazio. O controle negativo mexe em conjuntos em memória,
 * nunca em arquivo: prova que `diffSettingKeys` reprova o defeito, não só que o repo passa.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { GIFTBACK_SETTING_KEYS } from "../src/hooks/useGiftbackSettings";
import { WAITLIST_SETTING_KEYS } from "../src/hooks/useWaitlistSettings";
import { AI_STORE_SETTING_KEYS } from "../src/lib/ai-store-settings";

// Os hooks importam o client Supabase, que exige VITE_* no import; só as constantes interessam aqui.
vi.mock("@/lib/supabase", () => ({ supabase: {} }));

const ROOT = join(__dirname, "..");
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");
const AJUSTES_PATH = join(ROOT, "src", "pages", "gestao", "reservas", "Ajustes.tsx");
const TABLE_BLOCKS_PATH = join(ROOT, "src", "hooks", "useTableBlocks.ts");
const CONTA_PATH = join(ROOT, "src", "pages", "gestao", "Conta.tsx");
const AUTOMACAO_PATH = join(ROOT, "src", "pages", "gestao", "Automacao.tsx");

// Automacao.tsx (PromptTab + aba IA) grava 8 chaves: as 5 abaixo, só da plataforma, e as 3 de
// AI_STORE_SETTING_KEYS. Lista literal: chave nova de IA na tela exige decidir a classe aqui.
const PROMPT_TAB_PLATFORM_KEYS = ["ai_config", "ai_system_prompt", "ai_context_extra", "agent_mode", "agent_name"];
const MIN_AUTOMACAO_KEYS = PROMPT_TAB_PLATFORM_KEYS.length + AI_STORE_SETTING_KEYS.length;

function stripSqlComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

// Só `create [or replace] function`: migration que apenas revogue/altere a função não a redefine.
const FUNCTION_RE = /create\s+(?:or\s+replace\s+)?function\s+app_private\.unit_setting_write_class\b/i;

/** Último arquivo (ordem de nome) que define a função, fora de comentário. */
function effectiveClassifierMigration(dir: string): { file: string; sql: string } {
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  let found: { file: string; sql: string } | null = null;
  for (const file of files) {
    const sql = stripSqlComments(readFileSync(join(dir, file), "utf8"));
    if (FUNCTION_RE.test(sql)) found = { file, sql };
  }
  if (!found) throw new Error("nenhuma migration define app_private.unit_setting_write_class");
  return found;
}

/** Strings do `array[ ... ]` usado em `p_key = any (array[ ... ])` dentro da função. */
function extractClassifierKeys(sql: string): string[] {
  const fn = sql.match(
    /function\s+app_private\.unit_setting_write_class[\s\S]*?p_key\s*=\s*any\s*\(\s*array\s*\[([\s\S]*?)\]/i,
  );
  if (!fn) throw new Error("array literal de chaves não encontrado em unit_setting_write_class");
  const keys = [...fn[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  return keys;
}

/** `const SETTING_KEYS = [ "a", "b" ] as const` em Ajustes.tsx. */
function extractAjustesKeys(src: string): string[] {
  const m = src.match(/const\s+SETTING_KEYS\s*=\s*\[([\s\S]*?)\]\s*as\s+const/);
  if (!m) throw new Error("const SETTING_KEYS não encontrada em Ajustes.tsx");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

/** `saveSetting.mutate({ key: "x", ...})` e `saveSetting.mutateAsync({ key: "x", ...})`. */
function extractAutomacaoKeys(src: string): string[] {
  return [...src.matchAll(/saveSetting\.mutate(?:Async)?\(\s*\{\s*key:\s*"([^"]+)"/g)].map((m) => m[1]);
}

/** Diferença legível entre dois conjuntos; vazia quando são iguais. */
function diffSettingKeys(
  expected: Iterable<string>,
  actual: Iterable<string>,
): { onlyInExpected: string[]; onlyInActual: string[] } {
  const e = new Set(expected);
  const a = new Set(actual);
  return {
    onlyInExpected: [...e].filter((k) => !a.has(k)).sort(),
    onlyInActual: [...a].filter((k) => !e.has(k)).sort(),
  };
}

/** Chaves de Automacao.tsx que não são da loja e mesmo assim estão no classificador. */
function leakedPlatformKeys(automacaoKeys: string[], classifier: string[]): string[] {
  const store = new Set<string>(AI_STORE_SETTING_KEYS);
  return automacaoKeys.filter((k) => !store.has(k) && classifier.includes(k));
}

function hasDuplicates(list: string[]): string[] {
  return list.filter((k, i) => list.indexOf(k) !== i);
}

const classifier = effectiveClassifierMigration(MIGRATIONS_DIR);
const classifierKeys = extractClassifierKeys(classifier.sql);

describe("settings: classificador de escrita x chaves da Gestão", () => {
  it("extrai o array do classificador (não vazio, sem duplicata)", () => {
    expect(classifierKeys.length).toBeGreaterThan(0);
    expect(hasDuplicates(classifierKeys)).toEqual([]);
  });

  it("a Gestão grava exatamente as chaves `manager` do classificador", () => {
    const ajustes = extractAjustesKeys(readFileSync(AJUSTES_PATH, "utf8"));
    expect(ajustes.length).toBeGreaterThan(0);
    expect(GIFTBACK_SETTING_KEYS.length).toBeGreaterThan(0);
    expect(WAITLIST_SETTING_KEYS.length).toBeGreaterThan(0);
    expect(AI_STORE_SETTING_KEYS.length).toBeGreaterThan(0);

    // Chaves gravadas fora dos arrays: a string precisa estar escrita no fonte que a grava.
    expect(readFileSync(TABLE_BLOCKS_PATH, "utf8")).toMatch(/key:\s*"allow_overbooking"/);
    expect(readFileSync(CONTA_PATH, "utf8")).toMatch(/\.eq\(\s*"key"\s*,\s*"restaurant_name"\s*\)/);

    const gestao = [
      ...ajustes,
      ...GIFTBACK_SETTING_KEYS,
      ...WAITLIST_SETTING_KEYS,
      ...AI_STORE_SETTING_KEYS,
      "allow_overbooking",
      "restaurant_name",
    ];
    expect(hasDuplicates(gestao)).toEqual([]);

    const diff = diffSettingKeys(gestao, classifierKeys);
    const message =
      `Gestão x ${classifier.file}:\n` +
      `  gravada pela Gestão e ausente do classificador (dono levaria 42501): ${JSON.stringify(diff.onlyInExpected)}\n` +
      `  no classificador e não gravada por nenhuma tela da Gestão: ${JSON.stringify(diff.onlyInActual)}`;
    expect(diff, message).toEqual({ onlyInExpected: [], onlyInActual: [] });
  });

  it("as chaves de IA só da plataforma gravadas em Automacao.tsx ficam fora do classificador", () => {
    const keys = extractAutomacaoKeys(readFileSync(AUTOMACAO_PATH, "utf8"));
    expect(keys.length).toBeGreaterThanOrEqual(MIN_AUTOMACAO_KEYS);
    const store = new Set<string>(AI_STORE_SETTING_KEYS);
    expect([...new Set(keys.filter((k) => !store.has(k)))].sort()).toEqual([...PROMPT_TAB_PLATFORM_KEYS].sort());
    expect(AI_STORE_SETTING_KEYS.filter((k) => !keys.includes(k)), "o PromptTab deixou de editar chave da loja").toEqual([]);
    const leaked = leakedPlatformKeys(keys, classifierKeys);
    expect(leaked, `chaves de Automacao.tsx classificadas como manager: ${JSON.stringify(leaked)}`).toEqual([]);
  });

  it("controle negativo: diffSettingKeys reporta chave a mais em qualquer dos lados", () => {
    const base = ["a", "b", "c"];
    expect(diffSettingKeys(base, base)).toEqual({ onlyInExpected: [], onlyInActual: [] });
    expect(diffSettingKeys(base, [...base, "extra"])).toEqual({ onlyInExpected: [], onlyInActual: ["extra"] });
    expect(diffSettingKeys([...base, "extra"], base)).toEqual({ onlyInExpected: ["extra"], onlyInActual: [] });
  });

  it("controle negativo: classificador sem uma chave da loja ou com chave da plataforma reprova", () => {
    const gestao = [...AI_STORE_SETTING_KEYS, "booking_window_days"];
    const semMenu = classifierKeys.filter((k) => k !== "restaurant_menu");
    expect(semMenu.length).toBe(classifierKeys.length - 1);
    expect(diffSettingKeys(gestao, semMenu).onlyInExpected).toEqual(["restaurant_menu"]);
    expect(leakedPlatformKeys(["ai_system_prompt", "restaurant_menu"], [...classifierKeys, "ai_system_prompt"]))
      .toEqual(["ai_system_prompt"]);
    expect(leakedPlatformKeys(["ai_system_prompt", "restaurant_menu"], classifierKeys)).toEqual([]);
  });

  it("controle negativo: os extratores reprovam fonte com outra forma", () => {
    expect(() => extractClassifierKeys("create function app_private.unit_setting_write_class() ...")).toThrow();
    expect(() => extractAjustesKeys("const OUTRA = []")).toThrow();
    expect(extractAutomacaoKeys('foo.mutate({ key: "x" })')).toEqual([]);
    expect(extractAutomacaoKeys('saveSetting.mutateAsync({ key: "x", value: 1 })')).toEqual(["x"]);
  });
});
