// Extracts the SQL text a reviewed local-preflight setup script builds, without
// running its docker section: takes the source up to a cut marker, makes the
// relative migration URLs absolute and writes the named variable to `out`.
// Never talks to Docker or reads keys; `out` must live outside the repo.
import fs from 'node:fs'; import path from 'node:path'; import { pathToFileURL } from 'node:url';
const [, , file, cut, variable, out, skipA, skipB] = process.argv;
if (!file || !cut || !variable || !out) throw new Error('usage: <setup.mjs> <cut-marker> <variable> <out.sql> [skipA skipB]');
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../../..');
const outAbs = path.resolve(out);
if (!path.relative(repo, outAbs).startsWith('..')) throw new Error('out must be outside the repo');
let src = fs.readFileSync(file, 'utf8');
if (skipA) { const a = src.indexOf(skipA), b = src.indexOf(skipB); if (a < 0 || b < a) throw new Error('skip markers'); src = src.slice(0, a) + src.slice(b); }
const idx = src.indexOf(cut); if (idx < 0) throw new Error('cut marker not found');
const base = pathToFileURL(path.resolve(file)).href;
const head0 = src.slice(0, idx);
const importRe = /^import \{ resolveLocalDocker \}.*$/m, callRe = /^const docker ?= ?resolveLocalDocker\(\);/m;
// Fail loudly on source drift instead of silently evaluating a docker-resolving head.
if (!importRe.test(head0) || !callRe.test(head0)) throw new Error('docker resolver markers not found');
let head = head0.replace(importRe, '').replace(callRe, '').replaceAll('import.meta.url', JSON.stringify(base));
head += `\nimport { writeFileSync as __w } from 'node:fs'; __w(${JSON.stringify(outAbs)}, ${variable});\n`;
const tmp = path.join(path.dirname(outAbs), 'extract-tmp.mjs');
fs.writeFileSync(tmp, head);
try { await import(pathToFileURL(tmp).href); } finally { fs.rmSync(tmp, { force: true }); }
console.log('extracted', outAbs, fs.statSync(outAbs).size, 'bytes');
