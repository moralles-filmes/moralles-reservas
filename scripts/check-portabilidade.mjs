#!/usr/bin/env node
/**
 * scripts/check-portabilidade.mjs — Padrão SaaS v3.2 (GCP_MIGRATION §6)
 *
 * Mede se o código continua portável para fora do Supabase/Vercel. Acusa:
 *   sdk-fora-do-adapter   import de @supabase/* (ou SDK listado em "sdks"), ou do cliente
 *                         Supabase do projeto (@/integrations/supabase/client, @/lib/supabase),
 *                         fora dos adapters (`import type` é permitido em qualquer lugar)
 *   banco-direto-fora-do-adapter
 *                         .from('tabela'), .rpc('fn'), .functions.invoke(), .storage.from(),
 *                         .channel() fora dos adapters — o cliente chegou por contexto/hook,
 *                         mas a tela continua falando direto com o Supabase
 *   deno-fora-do-adapter  uso de `Deno.` fora do entrypoint da Edge Function ou de adapters
 *   empresa-no-token      empresa ativa lida de app_metadata/user_metadata quando o
 *                         tenancy-profile declara active_source: url
 *
 * Projeto legado: grave a linha de base uma vez (--write-baseline). Daí em diante o check só
 * falha quando a dívida AUMENTA (arquivo novo com violação ou mais violações num arquivo).
 * Quando diminuir, rode --write-baseline de novo para travar o ganho.
 *
 * Configuração opcional em .claude/padrao.json:
 *   {
 *     "portabilidade": {
 *       "permitidos": [...globs onde SDK é permitido...],      // substitui o padrão (DEFAULTS abaixo)
 *       "deno_permitidos": [...globs onde Deno.* é permitido...], // substitui o padrão
 *       "ignorar": ["src/legacy/**"],                                           // soma ao padrão
 *       "sdks": ["@supabase/", "stripe", "openai"],                             // substitui o padrão
 *       "clientes": ["(^|/)integrations/supabase/(?!types$)[^/]+$"]              // regex de módulos-cliente
 *     }
 *   }
 *
 * Uso:
 *   node scripts/check-portabilidade.mjs                    # verifica (CI)
 *   node scripts/check-portabilidade.mjs --write-baseline   # grava .claude/portabilidade-baseline.json
 *   node scripts/check-portabilidade.mjs --root <dir> [--json]
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const args = process.argv.slice(2)
const rootArg = args.indexOf('--root')
const ROOT = resolve(rootArg >= 0 ? args[rootArg + 1] : process.cwd())
const BASELINE = join(ROOT, '.claude', 'portabilidade-baseline.json')
const CONFIG = join(ROOT, '.claude', 'padrao.json')

const DEFAULTS = {
  permitidos: [
    '**/adapters/**',
    '**/integrations/providers/**',
    'src/lib/supabase/**',
    'src/integrations/supabase/**',
    'src/features/*/api.ts',
    'src/features/*/api/**',
    'supabase/functions/*/index.ts',
  ],
  deno_permitidos: [
    'supabase/functions/*/index.ts',
    '**/adapters/**',
  ],
  ignorar: [
    '**/node_modules/**', '**/dist/**', '**/build/**', '**/.next/**', '**/.vercel/**',
    '**/coverage/**', '**/.git/**', '**/.turbo/**', '**/.saas-audit/**', '**/.tasks/**',
    '**/*.test.*', '**/*.spec.*', '**/*_test.*', '**/__tests__/**', 'src/test/**', 'tests/**', 'e2e/**',
    'supabase/migrations/**', 'supabase/tests/**', '**/*.d.ts', 'scripts/**',
  ],
  sdks: ['@supabase/'],
  // Módulos do próprio projeto que entregam o cliente Supabase (padrão Lovable e src/lib/supabase).
  // Importar o cliente fora do adapter é o mesmo acoplamento que importar o SDK.
  clientes: [
    '(^|/)integrations/supabase/(?!types$)[^/]+$',
    '(^|/)lib/supabase(/[^/]+)?$',
  ],
}
const EXTENSIONS = /\.(c|m)?(j|t)sx?$/
// Chamada direta ao banco/plataforma (PostgREST, RPC, Edge Function, Storage, Realtime) com o
// cliente recebido por parâmetro, contexto ou hook — o acoplamento que o import não mostra.
const DIRECT_DB = /(?<!\b(?:Array|Buffer|Uint8Array|Object|Set|Map|Promise))\.(?:from|rpc)\(\s*['"`]|\.functions\.invoke\(|\.channel\(\s*['"`]/

function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      i++
      if (glob[i + 1] === '/') { i++; re += '(?:.*/)?' } else re += '.*'
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}
const matcher = globs => { const res = globs.map(globToRegExp); return p => res.some(r => r.test(p)) }

function loadConfig() {
  let cfg = {}
  if (existsSync(CONFIG)) {
    try { cfg = JSON.parse(readFileSync(CONFIG, 'utf8')).portabilidade ?? {} }
    catch (e) { console.error(`✗ .claude/padrao.json inválido: ${e.message}`); process.exit(1) }
  }
  return {
    permitidos: cfg.permitidos ?? DEFAULTS.permitidos,
    deno_permitidos: cfg.deno_permitidos ?? DEFAULTS.deno_permitidos,
    ignorar: [...DEFAULTS.ignorar, ...(cfg.ignorar ?? [])],
    sdks: cfg.sdks ?? DEFAULTS.sdks,
    clientes: cfg.clientes ?? DEFAULTS.clientes,
  }
}

function activeSourceIsUrl() {
  const p = join(ROOT, '.claude', 'tenancy-profile.yml')
  if (!existsSync(p)) return false
  return /^\s*active_source:\s*url\b/m.test(readFileSync(p, 'utf8'))
}

function walk(dir, isIgnored, out = []) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name)
    const rel = relative(ROOT, abs).split(sep).join('/')
    const st = statSync(abs)
    if (st.isDirectory()) {
      if (isIgnored(rel + '/x')) continue
      walk(abs, isIgnored, out)
    } else if (EXTENSIONS.test(name) && !isIgnored(rel)) out.push(rel)
  }
  return out
}

// Remove comentários preservando quebras de linha (números de linha continuam certos).
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
}

function scan(cfg) {
  const isIgnored = matcher(cfg.ignorar)
  const sdkAllowed = matcher(cfg.permitidos)
  const denoAllowed = matcher(cfg.deno_permitidos)
  const checkToken = activeSourceIsUrl()
  const sdkRe = new RegExp(`^(?:npm:|jsr:|https?://.*?/)?(?:${cfg.sdks.map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`)
  const clientRes = cfg.clientes.map(r => new RegExp(r))
  // Cobre import/export em várias linhas, import só de efeito, import() dinâmico e require().
  const importRe = /\b(?:import|export)\s+(type\s+)?[^;'"]*?\bfrom\s*(['"])([^'"]+)\2|\bimport\s*(['"])([^'"]+)\4|(?<!\btypeof\s*)\b(?:import|require)\s*\(\s*(['"])([^'"]+)\6/g
  const findings = []

  for (const file of walk(ROOT, isIgnored)) {
    const src = stripComments(readFileSync(join(ROOT, file), 'utf8'))
    const lines = src.split('\n')
    const lineAt = idx => src.slice(0, idx).split('\n').length

    if (!sdkAllowed(file)) {
      for (const m of src.matchAll(importRe)) {
        if (m[1]) continue  // import type / export type: só tipos, sem acoplamento em runtime
        const specifier = m[3] ?? m[5] ?? m[7]
        const isSdk = sdkRe.test(specifier)
        if (!isSdk && !clientRes.some(r => r.test(specifier))) continue
        const n = lineAt(m.index + m[0].length - 1)
        findings.push({
          rule: 'sdk-fora-do-adapter',
          file, line: n,
          text: `${isSdk ? 'SDK' : 'cliente Supabase do projeto'}: ${lines[n - 1].trim().slice(0, 120)}`,
        })
      }
    }

    lines.forEach((line, i) => {
      const at = { file, line: i + 1, text: line.trim().slice(0, 140) }
      if (/\bDeno\.[A-Za-z]/.test(line) && !denoAllowed(file)) findings.push({ rule: 'deno-fora-do-adapter', ...at })
      if (!sdkAllowed(file) && DIRECT_DB.test(line)) findings.push({ rule: 'banco-direto-fora-do-adapter', ...at })
      if (checkToken && /\b(app_metadata|user_metadata)\b[^\n]*\b(company_id|tenant_id|empresa_id|organization_id)\b/.test(line)) {
        findings.push({ rule: 'empresa-no-token', ...at })
      }
    })
  }
  return findings
}

function countByFile(findings) {
  const counts = {}
  for (const f of findings) counts[f.file] = (counts[f.file] ?? 0) + 1
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
}

function main() {
  const cfg = loadConfig()
  const findings = scan(cfg)
  const counts = countByFile(findings)

  if (args.includes('--write-baseline')) {
    mkdirSync(join(ROOT, '.claude'), { recursive: true })
    writeFileSync(BASELINE, JSON.stringify(counts, null, 2) + '\n')
    console.log(`• linha de base gravada: ${findings.length} violação(ões) em ${Object.keys(counts).length} arquivo(s) → .claude/portabilidade-baseline.json`)
    return 0
  }

  const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {}
  const regressions = Object.entries(counts).filter(([file, n]) => n > (baseline[file] ?? 0))
  const improved = Object.entries(baseline).filter(([file, n]) => (counts[file] ?? 0) < n)

  if (args.includes('--json')) {
    const byRule = {}
    for (const f of findings) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1
    console.log(JSON.stringify({
      total: findings.length,
      files: Object.keys(counts).length,
      byRule,
      regressions: regressions.map(([f]) => f),
      findings,
    }, null, 2))
    return regressions.length ? 1 : 0
  }

  const legacy = findings.length - regressions.reduce((s, [file]) => s + counts[file], 0)
  if (Object.keys(baseline).length) {
    console.log(`• linha de base: ${Object.values(baseline).reduce((a, b) => a + b, 0)} violação(ões) conhecidas; hoje: ${findings.length}`)
  }
  if (improved.length) {
    console.log(`• ${improved.length} arquivo(s) melhoraram — rode --write-baseline para travar o ganho`)
  }

  if (regressions.length) {
    console.error(`\n✗ portabilidade: dívida nova em ${regressions.length} arquivo(s) (GCP_MIGRATION §6)`)
    const regressed = new Set(regressions.map(([f]) => f))
    for (const f of findings.filter(x => regressed.has(x.file))) {
      console.error(`  - ${f.file}:${f.line} [${f.rule}] ${f.text}`)
    }
    console.error('\nComo resolver: mova o acesso para o adapter do módulo (src/features/<m>/api.ts, adapters/ ou')
    console.error('src/lib/supabase/) e chame o adapter a partir da tela. Use `import type` para tipos.')
    console.error('Projeto legado: grave a dívida atual com --write-baseline; o CI passa a barrar só o aumento.')
    return 1
  }
  console.log(`✓ portabilidade conferida${legacy ? ` (${legacy} violação(ões) legadas na linha de base)` : ''}`)
  return 0
}

// exitCode em vez de exit(): não corta a saída quando ela vai para um pipe.
process.exitCode = main()
