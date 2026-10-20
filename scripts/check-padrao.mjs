#!/usr/bin/env node
/**
 * scripts/check-padrao.mjs — Padrão SaaS v3.2
 *
 * Verifica, no projeto:
 *   1. CLAUDE.md importa @AGENTS.md (fonte única para Claude Code e Codex);
 *   2. .claude/tenancy-profile.yml existe;
 *   3. manifest ↔ docs/standards nos DOIS sentidos:
 *      - todo padrão do manifest existe, a não ser que seja opcional e esteja declarado como
 *        não adotado em .claude/padrao.json, com motivo;
 *      - todo docs/standards/*.md consta no manifest;
 *      - o corpo normativo (tudo antes de "## Particularidades deste projeto") bate com o hash;
 *   4. os AGENTS.md aninhados para o Codex (ex.: supabase/AGENTS.md) estão em dia
 *      com .claude/rules/ (o Codex não lê .claude/rules/);
 *   5. links relativos em AGENTS.md e docs/ apontam para arquivos que existem;
 *   6. avisa (sem falhar) quando o AGENTS.md passa de 200 linhas.
 *
 * Configuração do projeto em .claude/padrao.json (opcional):
 *   { "nao_adotados": { "PUBLIC_API.md": "não emitimos chaves de API para clientes" } }
 *
 * Uso:
 *   node scripts/check-padrao.mjs                  # verifica (CI)
 *   node scripts/check-padrao.mjs --write-nested   # regenera os AGENTS.md aninhados
 *   node scripts/check-padrao.mjs --write-manifest # regenera o manifest (só no kit do padrão)
 *   node scripts/check-padrao.mjs --root <dir>
 *
 * Saída: exit 0 sem erros; exit 1 com a lista de erros.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const args = process.argv.slice(2)
const flag = name => args.includes(name)
const rootArg = args.indexOf('--root')
const ROOT = resolve(rootArg >= 0 ? args[rootArg + 1] : process.cwd())
const STD_DIR = join(ROOT, 'docs', 'standards')
const MANIFEST = join(STD_DIR, '.manifest.json')
const PROJECT_CONFIG = join(ROOT, '.claude', 'padrao.json')
const PARTICULARIDADES = '## Particularidades deste projeto'
const AGENTS_MAX_LINES = 200

// Alvos padrão dos AGENTS.md aninhados. O projeto pode sobrescrever em .claude/nested-agents.json:
// { "supabase/AGENTS.md": ["banco-de-dados", "integracoes", "seguranca-multitenancy"] }
const DEFAULT_NESTED = {
  'supabase/AGENTS.md': ['banco-de-dados', 'integracoes', 'seguranca-multitenancy'],
}

const errors = []
const warnings = []
const notes = []
const read = p => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')

function readJson(p, label) {
  try {
    return JSON.parse(read(p))
  } catch (e) {
    errors.push(`${label}: JSON inválido (${e.message})`)
    return null
  }
}

function normalize(text) {
  return text.split('\n').map(l => l.replace(/\s+$/, '')).join('\n').trim() + '\n'
}

function body(text) {
  const i = text.indexOf('\n' + PARTICULARIDADES)
  return normalize(i >= 0 ? text.slice(0, i) : text)
}

const sha = s => createHash('sha256').update(s, 'utf8').digest('hex')

function standardsFiles() {
  if (!existsSync(STD_DIR)) return []
  return readdirSync(STD_DIR).filter(f => f.endsWith('.md')).sort()
}

function versionOf(text) {
  const m = text.match(/Padrão SaaS v(\d+\.\d+(?:\.\d+)?)/)
  return m ? m[1] : null
}

function projectConfig() {
  if (!existsSync(PROJECT_CONFIG)) return {}
  return readJson(PROJECT_CONFIG, '.claude/padrao.json') ?? {}
}

// ─── manifest (só no kit) ───────────────────────────────────────────
function writeManifest() {
  const previous = existsSync(MANIFEST) ? readJson(MANIFEST, 'docs/standards/.manifest.json') ?? {} : {}
  const files = {}
  let version = null
  for (const f of standardsFiles()) {
    const text = read(join(STD_DIR, f))
    const v = versionOf(text)
    if (!v) errors.push(`docs/standards/${f}: cabeçalho sem "Padrão SaaS vX.Y"`)
    if (version && v && v !== version) errors.push(`docs/standards/${f}: versão ${v} diferente de ${version}`)
    version = version ?? v
    files[f] = sha(body(text))
  }
  const optional = (previous.optional ?? []).filter(f => f in files)
  if (!errors.length) {
    writeFileSync(MANIFEST, JSON.stringify({ version, optional, files }, null, 2) + '\n')
    notes.push(`manifest gravado: v${version}, ${Object.keys(files).length} padrões (${optional.length} opcionais)`)
  }
}

// ─── manifest ↔ docs/standards (projeto) ────────────────────────────
function checkManifest() {
  if (!existsSync(STD_DIR)) { errors.push('docs/standards/ ausente — instale o padrão com a skill padrao-saas:aplicar'); return }
  if (!existsSync(MANIFEST)) { errors.push('docs/standards/.manifest.json ausente — copie do kit do padrão'); return }
  const manifest = readJson(MANIFEST, 'docs/standards/.manifest.json')
  if (!manifest) return
  const listed = manifest.files ?? {}
  const optional = new Set(manifest.optional ?? [])
  const naoAdotados = projectConfig().nao_adotados ?? {}
  const present = new Set(standardsFiles())

  // declarações de "não adotado"
  for (const [f, motivo] of Object.entries(naoAdotados)) {
    if (!(f in listed)) { errors.push(`.claude/padrao.json: "${f}" não é um padrão do manifest`); continue }
    if (!optional.has(f)) errors.push(`.claude/padrao.json: ${f} é obrigatório e não pode ser marcado como não adotado`)
    if (typeof motivo !== 'string' || !motivo.trim()) errors.push(`.claude/padrao.json: ${f} marcado como não adotado sem motivo`)
    if (present.has(f)) errors.push(`.claude/padrao.json: ${f} marcado como não adotado, mas o arquivo existe em docs/standards/`)
  }

  // manifest → arquivo
  for (const f of Object.keys(listed).sort()) {
    if (present.has(f)) continue
    if (optional.has(f) && f in naoAdotados) { notes.push(`${f}: não adotado (${naoAdotados[f]})`); continue }
    errors.push(optional.has(f)
      ? `docs/standards/${f} ausente. Copie do kit ou, se não se aplica, declare em .claude/padrao.json → "nao_adotados": { "${f}": "<motivo>" }`
      : `docs/standards/${f} ausente — padrão obrigatório; copie do kit`)
  }

  // arquivo → manifest, versão e hash
  for (const f of [...present]) {
    const text = read(join(STD_DIR, f))
    const expected = listed[f]
    if (!expected) { errors.push(`docs/standards/${f}: não consta no manifest (padrão desconhecido ou renomeado)`); continue }
    if (versionOf(text) !== manifest.version) {
      errors.push(`docs/standards/${f}: versão ${versionOf(text)} ≠ manifest ${manifest.version}`)
    }
    if (sha(body(text)) !== expected) {
      errors.push(`docs/standards/${f}: corpo normativo editado no projeto. Mova a adaptação para "${PARTICULARIDADES}" ou atualize o padrão no kit`)
    }
    if (!text.includes(PARTICULARIDADES)) errors.push(`docs/standards/${f}: falta a seção "${PARTICULARIDADES}"`)
  }
  notes.push(`padrões conferidos contra o manifest v${manifest.version}`)
}

// ─── CLAUDE.md → @AGENTS.md, tamanho do AGENTS.md, tenancy-profile ──
function checkContext() {
  const agents = join(ROOT, 'AGENTS.md')
  const claude = join(ROOT, 'CLAUDE.md')
  if (!existsSync(agents)) errors.push('AGENTS.md ausente na raiz')
  else {
    const lines = read(agents).trimEnd().split('\n').length
    if (lines > AGENTS_MAX_LINES) {
      warnings.push(`AGENTS.md tem ${lines} linhas (meta: até ${AGENTS_MAX_LINES}). Mova detalhes para docs/standards ("Particularidades") ou docs/modules`)
    }
  }
  if (!existsSync(claude)) errors.push('CLAUDE.md ausente na raiz (deve conter @AGENTS.md)')
  else if (!/^@AGENTS\.md\s*$/m.test(read(claude))) errors.push('CLAUDE.md não importa @AGENTS.md em linha própria')
  if (!existsSync(join(ROOT, '.claude', 'tenancy-profile.yml'))) {
    errors.push('.claude/tenancy-profile.yml ausente — declare o modelo de tenant (skill tenant-model do saas-shield-br)')
  }
}

// ─── AGENTS.md aninhados (Codex) ────────────────────────────────────
function nestedMap() {
  const custom = join(ROOT, '.claude', 'nested-agents.json')
  return existsSync(custom) ? readJson(custom, '.claude/nested-agents.json') ?? {} : DEFAULT_NESTED
}

function ruleBody(name) {
  const p = join(ROOT, '.claude', 'rules', `${name}.md`)
  if (!existsSync(p)) return null
  return read(p).replace(/^---\n[\s\S]*?\n---\n/, '').trim()
}

function renderNested(target, rules) {
  const parts = [
    `<!-- GERADO por scripts/check-padrao.mjs --write-nested a partir de .claude/rules/. Não edite aqui: edite as rules e regenere. -->`,
    `# Regras para agentes ao trabalhar em ${dirname(target)}/`,
    '',
    'O Codex lê este arquivo. O Claude Code recebe as mesmas regras por `.claude/rules/`. As regras gerais estão no `AGENTS.md` da raiz.',
  ]
  for (const r of rules) {
    const b = ruleBody(r)
    if (b === null) { errors.push(`.claude/rules/${r}.md ausente (usado em ${target})`); continue }
    parts.push('', b.replace(/^# /m, '## '))
  }
  return normalize(parts.join('\n'))
}

function nested(write) {
  for (const [target, rules] of Object.entries(nestedMap())) {
    const abs = join(ROOT, target)
    const content = renderNested(target, rules)
    if (write) {
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, content)
      notes.push(`${target} regenerado`)
    } else if (existsSync(dirname(abs))) {
      if (!existsSync(abs)) errors.push(`${target} ausente — rode: node scripts/check-padrao.mjs --write-nested`)
      else if (read(abs) !== content) errors.push(`${target} desatualizado em relação a .claude/rules/ — rode --write-nested`)
    }
  }
}

// ─── links relativos ────────────────────────────────────────────────
function walk(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap(n => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.md') ? [p] : []
  })
}

function checkLinks() {
  const files = [join(ROOT, 'AGENTS.md'), ...walk(join(ROOT, 'docs'))].filter(existsSync)
  for (const f of files) {
    const text = read(f).replace(/```[\s\S]*?```/g, '')
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const href = m[1]
      if (/^(https?:|mailto:|#)/.test(href)) continue
      const target = resolve(dirname(f), href.split('#')[0])
      if (!existsSync(target)) errors.push(`${relative(ROOT, f)}: link quebrado → ${href}`)
    }
  }
}

// ─── main ───────────────────────────────────────────────────────────
if (flag('--write-manifest')) writeManifest()
else {
  checkContext()
  checkManifest()
}
nested(flag('--write-nested'))
checkLinks()

for (const n of notes) console.log(`• ${n}`)
for (const w of warnings) console.log(`⚠ ${w}`)
if (errors.length) {
  console.error(`\n✗ ${errors.length} problema(s):`)
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}
console.log('✓ Padrão SaaS conferido')
