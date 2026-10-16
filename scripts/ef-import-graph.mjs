// Responde "quais Edge Functions precisam de redeploy quando este arquivo muda?".
//
// Edge Functions não compartilham bundle em runtime: cada EF embute sua cópia de
// `_shared/` no deploy. Este script percorre, a partir de cada
// `supabase/functions/<ef>/index.ts`, os imports relativos POR VALOR (transitivos)
// e devolve as EFs que alcançam o arquivo pedido. `import type`/`export type`
// são apagados na compilação e não entram no bundle, então não ampliam o deploy.
//
// Uso:
//   node scripts/ef-import-graph.mjs supabase/functions/_shared/phone.ts [...]
//   node scripts/ef-import-graph.mjs --all          # matriz _shared → EFs
//   node scripts/ef-import-graph.mjs --json <arq>   # saída em JSON
//
// Usa o parser do TypeScript (imports em várias linhas, `import type`), não regex.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FUNCTIONS_DIR = path.join(REPO_ROOT, "supabase", "functions");

/** Especificadores relativos importados por valor por um arquivo. */
export function valueImports(fileName, source) {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const specs = [];
  for (const st of sf.statements) {
    let spec;
    if (ts.isImportDeclaration(st)) {
      if (st.importClause?.isTypeOnly) continue;
      spec = st.moduleSpecifier;
    } else if (ts.isExportDeclaration(st)) {
      if (st.isTypeOnly || !st.moduleSpecifier) continue;
      spec = st.moduleSpecifier;
    }
    if (spec && ts.isStringLiteral(spec) && spec.text.startsWith(".")) specs.push(spec.text);
  }
  return specs;
}

function listEntrypoints(functionsDir) {
  return fs
    .readdirSync(functionsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_") && !d.name.startsWith("."))
    .map((d) => ({ name: d.name, entry: path.join(functionsDir, d.name, "index.ts") }))
    .filter((e) => fs.existsSync(e.entry));
}

/** Conjunto de arquivos (absolutos) alcançados por valor a partir de `entry`. */
function reach(entry, cache) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    let deps = cache.get(file);
    if (!deps) {
      const src = fs.readFileSync(file, "utf8");
      deps = valueImports(file, src)
        .map((s) => path.resolve(path.dirname(file), s))
        .filter((p) => fs.existsSync(p));
      cache.set(file, deps);
    }
    stack.push(...deps);
  }
  return seen;
}

/** Mapa arquivo absoluto → EFs (ordenadas) que o alcançam por valor. */
export function buildConsumerMap(functionsDir = FUNCTIONS_DIR) {
  const cache = new Map();
  const consumers = new Map();
  for (const { name, entry } of listEntrypoints(functionsDir)) {
    for (const file of reach(entry, cache)) {
      if (!consumers.has(file)) consumers.set(file, new Set());
      consumers.get(file).add(name);
    }
  }
  return new Map([...consumers].map(([f, s]) => [f, [...s].sort()]));
}

/** EFs que precisam de redeploy quando `file` (caminho relativo ao repo ou absoluto) muda. */
export function consumersOf(file, map = buildConsumerMap()) {
  const abs = path.resolve(REPO_ROOT, file);
  return map.get(abs) ?? [];
}

function main(argv) {
  const json = argv.includes("--json");
  const all = argv.includes("--all");
  const files = argv.filter((a) => !a.startsWith("--"));
  const map = buildConsumerMap();
  const rel = (p) => path.relative(REPO_ROOT, p).split(path.sep).join("/");

  let result;
  if (all) {
    const sharedDir = path.join(FUNCTIONS_DIR, "_shared") + path.sep;
    result = Object.fromEntries(
      [...map].filter(([f]) => f.startsWith(sharedDir)).sort(([a], [b]) => a.localeCompare(b)).map(([f, efs]) => [rel(f), efs]),
    );
  } else if (files.length) {
    result = Object.fromEntries(files.map((f) => [rel(path.resolve(REPO_ROOT, f)), consumersOf(f, map)]));
  } else {
    console.error("uso: node scripts/ef-import-graph.mjs [--json] (--all | <arquivo>...)");
    process.exit(2);
  }

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  for (const [file, efs] of Object.entries(result)) {
    console.log(`${file} → ${efs.length} EF(s)${efs.length ? ": " + efs.join(", ") : " (nenhuma por valor)"}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
