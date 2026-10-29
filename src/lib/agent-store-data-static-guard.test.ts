import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guard estático da spec Entrega B §6.3.5: os textos livres da loja em
 * `settings` só entram no prompt por `storeDataBlock(...)`. Qualquer menção às
 * 5 chaves fora dos argumentos de uma chamada `storeDataBlock(` reprova —
 * leitura direta, alias, desestruturação, gate por fora ou comentário. Dentro
 * da chamada, o limite tem de ser o da mesma chave. Também reprova despejar o
 * `settingsMap` inteiro (`Object.entries/values/keys`, `JSON.stringify`, spread).
 *
 * Limite residual (registrado): chave montada em tempo de execução
 * (`"restaurant_" + "menu"`) e leitura fora de `_shared/agent/**` e do
 * `webhook-whatsapp` não são vistas.
 */

const ROOT = resolve(__dirname, "../..");
const STORE_KEYS = ["restaurant_menu", "delivery_response", "restaurant_extra_info", "rules_and_conditions", "additional_info"];
const KEY_RE = new RegExp(`\\b(${STORE_KEYS.join("|")})\\b`, "g");
/** Onde as chaves podem aparecer por definição: limites e o próprio helper. */
const DEFINITIONS = new Set([
  "supabase/functions/_shared/agent/global-prompt-core.ts",
  "supabase/functions/_shared/agent/store-data-core.ts",
]);

function agentSources(): Array<{ path: string; src: string }> {
  const out: Array<{ path: string; src: string }> = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".ts")) out.push({ path: relative(ROOT, full).split("\\").join("/"), src: readFileSync(full, "utf8") });
    }
  };
  walk(join(ROOT, "supabase/functions/_shared/agent"));
  const webhook = "supabase/functions/webhook-whatsapp/index.ts";
  out.push({ path: webhook, src: readFileSync(join(ROOT, webhook), "utf8") });
  return out.filter((f) => !DEFINITIONS.has(f.path));
}

/** Intervalos `[abre, fecha]` dos argumentos de cada `storeDataBlock(`. */
function blockSpans(src: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const m of src.matchAll(/\bstoreDataBlock\(/g)) {
    const open = m.index! + m[0].length - 1;
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")" && --depth === 0) { spans.push([open, i]); break; }
    }
  }
  return spans;
}

function guardFindings(path: string, src: string): string[] {
  const spans = blockSpans(src);
  const findings: string[] = [];
  for (const m of src.matchAll(KEY_RE)) {
    if (!spans.some(([a, b]) => m.index! > a && m.index! < b)) {
      const line = src.slice(0, m.index).split("\n").length;
      findings.push(`${path}:${line} ${m[1]} fora de storeDataBlock(`);
    }
  }
  for (const m of src.matchAll(/Object\.(?:entries|values|keys)\(\s*settingsMap\b|JSON\.stringify\(\s*settingsMap\b|\.\.\.\s*settingsMap\b/g)) {
    const line = src.slice(0, m.index).split("\n").length;
    findings.push(`${path}:${line} settingsMap despejado inteiro (${m[0]})`);
  }
  for (const [a, b] of spans) {
    const keys = [...src.slice(a, b).matchAll(KEY_RE)].map((m) => m[1]);
    if (keys.length && new Set(keys).size !== 1) findings.push(`${path}: storeDataBlock com chaves misturadas ${keys.join(",")}`);
  }
  return findings;
}

describe("texto livre da loja entra só por storeDataBlock", () => {
  const files = agentSources();

  it("nenhuma menção às 5 chaves fora de storeDataBlock(, e o limite é o da mesma chave", () => {
    expect(files.flatMap((f) => guardFindings(f.path, f.src))).toEqual([]);
  });

  it("cada chave tem o seu bloco com o próprio limite (o guard não passa no vazio)", () => {
    const prompt = files.find((f) => f.path.endsWith("/agent/system-prompt.ts"))!.src;
    for (const key of STORE_KEYS) {
      expect(prompt, key).toMatch(new RegExp(`storeDataBlock\\([^)]*settingsMap\\["${key}"\\],\\s*STORE_TEXT_LIMITS\\.${key}\\)`));
    }
  });
});

describe("controle positivo: o guard reprova fonte sintética", () => {
  const ok = 'storeDataBlock("Cardápio", settingsMap["restaurant_menu"], STORE_TEXT_LIMITS.restaurant_menu)';
  const cases: Array<[string, string, number]> = [
    ["leitura direta", 'const x = `${settingsMap["restaurant_menu"]}`;', 1],
    ["acesso por ponto", "const x = settingsMap.delivery_response;", 1],
    ["desestruturação", "const { additional_info } = settingsMap;", 1],
    ["gate por fora do helper", `(settingsMap["rules_and_conditions"] ? ${ok.replace(/restaurant_menu/g, "rules_and_conditions")} : "")`, 1],
    ["outra função", 'foo(settingsMap["restaurant_extra_info"])', 1],
    ["limite de outra chave", 'storeDataBlock("X", settingsMap["restaurant_menu"], STORE_TEXT_LIMITS.delivery_response)', 1],
    ["Object.entries", "const all = Object.entries(settingsMap).map(([k, v]) => `${k}: ${v}`);", 1],
    ["JSON.stringify", "const all = JSON.stringify(settingsMap);", 1],
    ["spread", "const copy = { ...settingsMap };", 1],
  ];
  for (const [name, src, n] of cases) {
    it(`reprova: ${name}`, () => expect(guardFindings("sintetico.ts", src)).toHaveLength(n));
  }
  it("aceita a forma canônica", () => expect(guardFindings("sintetico.ts", ok)).toEqual([]));
});
