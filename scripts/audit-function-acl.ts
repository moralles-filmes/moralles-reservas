// scripts/audit-function-acl.ts
// GUARDRAIL de segurança: falha quando uma função do schema `public` fica
// executável por `anon`/`authenticated`/`PUBLIC` sem estar na allowlist.
//
// Existe porque o buraco que a migration 085 fechou é do tipo que REABRE
// sozinho: `pg_default_acl` concede EXECUTE a anon/authenticated em toda função
// nova de `public`, e isso é por ROLE CRIADORA — a migration 085 corrige a role
// `postgres`, mas `supabase_admin` (da plataforma) mantém o default aberto, e a
// Supabase pode restaurar defaults em manutenção. O `ALTER DEFAULT PRIVILEGES`
// evita o caso comum; ESTE script é a rede de verdade.
//
// Uso — PowerShell (shell primário deste projeto):
//   $env:SUPABASE_URL = 'https://<ref>.supabase.co'
//   $env:SUPABASE_SERVICE_ROLE_KEY = '<Ctrl+V da chave INTEIRA>'
//   npx deno@2.1.4 run --allow-net --allow-env --allow-read scripts/audit-function-acl.ts
//   $env:SUPABASE_SERVICE_ROLE_KEY = $null    # limpa a chave da sessão no fim
//
// Uso — bash / Git Bash:
//   SUPABASE_URL='https://<ref>.supabase.co' SUPABASE_SERVICE_ROLE_KEY='<chave>' \
//     npx deno@2.1.4 run --allow-net --allow-env --allow-read scripts/audit-function-acl.ts
//
// PowerShell NÃO aceita prefixo de variável inline (`VAR=x comando`) — isso é
// sintaxe de bash e vira "termo não reconhecido".
//
// Exit code 0 = limpo. Exit code 1 = violação (nomeia função E assinatura).
// Exit code 2 = erro de configuração/execução (não confundir com "limpo").
//
// A allowlist é POLÍTICA e vive em scripts/function-acl-allowlist.json,
// versionada e revisável. A RPC `audit_function_acl()` é FATO e vive no banco
// (migration 085). O script só cruza os dois — nenhuma regra fica implícita.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  computeAdvisorDivergence,
  countsMatchExpected,
  type AdvisorDivergence,
  type ExpectedAdvisorCounts,
  type LintInventory,
} from "./advisor-divergence-core.ts";

interface AuditRow {
  function_name: string;
  identity_args: string;
  is_secdef: boolean;
  anon_execute: boolean;
  auth_execute: boolean;
  public_execute: boolean;
  has_search_path: boolean;
  fn_comment: string;
  acl: string;
}

interface AllowEntry {
  name: string;
  args: string;
  roles: string[];
  why: string;
  /**
   * Assinatura realmente SECURITY DEFINER? Os lints 0028/0029 do advisor só
   * disparam para SECURITY DEFINER — duas entradas da allowlist
   * (`normalize_br_phone`, `search_reservations`) são SECURITY INVOKER,
   * concedem a papel externo e não produzem NENHUMA linha de advisor. Ver
   * Ruling 4/22 em .superpowers/sdd/2026-08-17-advisor-warnings-hardening/progress.md.
   */
  security_definer: boolean;
  /** Lints do advisor que esta assinatura DEVE produzir, segundo a política
   * revisada. Fonte da verdade "esperada" da regra 6 — comparada abaixo
   * contra o que o banco REALMENTE produz. */
  advisor_lints: string[];
}

interface Violation {
  severity: "CRITICO" | "ALTO" | "MEDIO";
  /** Assinatura completa: nome + tipos dos argumentos. */
  fn: string;
  rule: string;
  detail: string;
  /** Papéis externos que REALMENTE executam, conforme o banco. */
  observed: string;
  /** Papéis que a allowlist versionada aprova. */
  expected: string;
  /** Estado do search_path, quando a função é SECURITY DEFINER. */
  searchPath?: string;
}

const ALLOWLIST_PATH = new URL("./function-acl-allowlist.json", import.meta.url);

/** `nome(args)` — a identidade que distingue overloads. Nunca só o nome. */
function sig(name: string, args: string): string {
  return `${name}(${args})`;
}

interface LoadedAllowlist {
  byKey: Map<string, AllowEntry>;
  expectedAdvisor: ExpectedAdvisorCounts;
}

function loadAllowlist(): LoadedAllowlist {
  const raw = Deno.readTextFileSync(ALLOWLIST_PATH);
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const map = new Map<string, AllowEntry>();

  for (const [group, value] of Object.entries(parsed)) {
    if (group.startsWith("_") || !Array.isArray(value)) continue;
    for (const entry of value as AllowEntry[]) {
      if (
        !entry?.name ||
        typeof entry.args !== "string" ||
        !Array.isArray(entry.roles) ||
        typeof entry.security_definer !== "boolean" ||
        !Array.isArray(entry.advisor_lints)
      ) {
        console.error(`allowlist: entrada malformada no grupo "${group}": ${JSON.stringify(entry)}`);
        Deno.exit(2);
      }
      const key = sig(entry.name, entry.args);
      if (map.has(key)) {
        console.error(`allowlist: ${key} duplicada — remova a repetida antes de continuar.`);
        Deno.exit(2);
      }
      map.set(key, entry);
    }
  }

  const expectedAdvisor = parsed["_expected_advisor"] as ExpectedAdvisorCounts | undefined;
  if (
    !expectedAdvisor ||
    typeof expectedAdvisor["0028"] !== "number" ||
    typeof expectedAdvisor["0029"] !== "number" ||
    typeof expectedAdvisor.total !== "number"
  ) {
    console.error('allowlist: bloco "_expected_advisor" ausente ou malformado.');
    Deno.exit(2);
  }

  return { byKey: map, expectedAdvisor };
}

/**
 * Detecta a promessa "service_role only" no COMMENT. Uma função que se declara
 * exclusiva de service_role e continua chamável por anon/authenticated é o
 * modo de falha mais perigoso do achado original: a documentação afirma um
 * controle que não existe, então ninguém procura de novo.
 */
function claimsServiceRoleOnly(comment: string): boolean {
  return /service[_ ]role\s+only/i.test(comment);
}

/**
 * Papéis externos que de fato executam, conforme o banco. O dono (postgres) tem
 * EXECUTE implícito e nunca aparece aqui: esta lista é sobre superfície externa,
 * não sobre quem consegue rodar a função por ser dono.
 */
function observedRoles(r: AuditRow): string {
  const roles = [
    r.public_execute && "PUBLIC",
    r.anon_execute && "anon",
    r.auth_execute && "authenticated",
  ].filter(Boolean) as string[];
  return roles.length > 0 ? roles.join(", ") : "nenhum";
}

function expectedRoles(entry: AllowEntry | undefined): string {
  if (!entry) return "nenhum (não consta na allowlist)";
  return entry.roles.length > 0 ? entry.roles.join(", ") : "nenhum";
}

/**
 * TODA regra aplicável é avaliada para TODA função. Nenhuma classificação
 * encerra as verificações seguintes: uma mesma função pode — e deve — produzir
 * várias violações distintas. Um `continue` aqui já escondeu um defeito real de
 * `search_path` atrás de um achado de allowlist; não reintroduza.
 */
interface AuditResult {
  violations: Violation[];
  /** Assinaturas que o BANCO realmente produz para cada lint — regra 6. */
  observedAdvisor: LintInventory;
}

function audit(rows: AuditRow[], allow: Map<string, AllowEntry>): AuditResult {
  const violations: Violation[] = [];
  const observedAdvisor: LintInventory = { "0028": [], "0029": [] };

  for (const r of rows) {
    const key = sig(r.function_name, r.identity_args);
    const entry = allow.get(key);
    const exposed = r.anon_execute || r.auth_execute || r.public_execute;

    const ctx = {
      fn: key,
      observed: observedRoles(r),
      expected: expectedRoles(entry),
      ...(r.is_secdef ? { searchPath: r.has_search_path ? "fixo" : "MUTÁVEL" } : {}),
    };

    // 1. COMMENT promete service_role only, mas papel externo executa.
    if (claimsServiceRoleOnly(r.fn_comment) && exposed) {
      violations.push({
        ...ctx,
        severity: "CRITICO",
        rule: "comentario-mente",
        detail: `COMMENT declara "service_role only", mas há papel externo com EXECUTE. ACL: ${r.acl}`,
      });
    }

    // 2. Concessão ao pseudo-papel PUBLIC — implícita do CREATE FUNCTION ou
    //    explícita. Nunca é intencional aqui: a allowlist concede a papéis
    //    nomeados, jamais a PUBLIC, porque PUBLIC alcança todo papel futuro.
    if (r.public_execute) {
      violations.push({
        ...ctx,
        severity: "ALTO",
        rule: "grant-para-PUBLIC",
        detail:
          `EXECUTE concedido ao pseudo-papel PUBLIC (ou ACL default do CREATE FUNCTION). ` +
          `Use "revoke all ... from public, anon, authenticated" e conceda ao papel mínimo. ACL: ${r.acl}`,
      });
    }

    // 3. Exposta sem estar na allowlist = função nova sem classificação, ou
    //    regressão de uma já classificada.
    if (exposed && !entry) {
      violations.push({
        ...ctx,
        severity: r.is_secdef ? "CRITICO" : "ALTO",
        rule: "fora-da-allowlist",
        detail:
          `${r.is_secdef ? "SECURITY DEFINER" : "SECURITY INVOKER"} com papel externo e ` +
          `sem entrada em function-acl-allowlist.json. ` +
          `Classifique em docs/hotfix-acl/01-INVENTARIO-E-CLASSIFICACAO.md antes de liberar.`,
      });
    }

    // 4. Na allowlist, mas com papel a MAIS do que foi aprovado.
    if (entry) {
      const extra: string[] = [];
      if (r.public_execute) extra.push("PUBLIC");
      if (r.anon_execute && !entry.roles.includes("anon")) extra.push("anon");
      if (r.auth_execute && !entry.roles.includes("authenticated")) extra.push("authenticated");
      if (extra.length > 0) {
        violations.push({
          ...ctx,
          severity: "ALTO",
          rule: "papel-a-mais",
          detail: `O banco concede além do aprovado: [${extra.join(", ")}]. ACL: ${r.acl}`,
        });
      }
    }

    // 5. SECURITY DEFINER sem `search_path` fixo: o caller controla a resolução
    //    de nomes e pode sequestrar a função com um schema próprio. Ortogonal às
    //    regras acima — avaliada SEMPRE, inclusive em função já sinalizada.
    if (r.is_secdef && !r.has_search_path) {
      violations.push({
        ...ctx,
        severity: "MEDIO",
        rule: "search_path-mutavel",
        detail: `SECURITY DEFINER sem "set search_path". Adicione "set search_path = public".`,
      });
    }

    // 6. Equivalente-advisor: os lints 0028/0029 medem exatamente
    //    "SECURITY DEFINER de um schema exposto, executável por anon/authenticated".
    //    A mesma linha que alimenta as regras acima já responde isso, então o
    //    guardrail confere a ASSINATURA (não só o total) contra o que a
    //    allowlist declara em `advisor_lints`, comparado depois do laço.
    if (r.is_secdef && r.anon_execute) observedAdvisor["0028"].push(key);
    if (r.is_secdef && r.auth_execute) observedAdvisor["0029"].push(key);
  }

  sortViolations(violations);
  return { violations, observedAdvisor };
}

/** Mesma ordem sempre — usada tanto ao fim de `audit()` quanto depois que o
 * `main` empurra as violações da regra 6, para o relatório final não ficar
 * com as `advisor-divergente` soltas no fim fora de ordem de severidade. */
function sortViolations(violations: Violation[]): void {
  const ordem = { CRITICO: 0, ALTO: 1, MEDIO: 2 };
  violations.sort(
    (a, b) => ordem[a.severity] - ordem[b.severity] || a.fn.localeCompare(b.fn) || a.rule.localeCompare(b.rule),
  );
}

/**
 * Deriva o inventário ESPERADO por lint a partir do que a allowlist declara
 * (`advisor_lints` de cada entrada) — é a política revisada, não o banco.
 * `computeAdvisorDivergence` compara este lado contra `observedAdvisor`.
 */
function expectedAdvisorFromAllowlist(allow: Map<string, AllowEntry>): LintInventory {
  const expected: LintInventory = { "0028": [], "0029": [] };
  for (const [key, entry] of allow.entries()) {
    if (entry.advisor_lints.includes("0028")) expected["0028"].push(key);
    if (entry.advisor_lints.includes("0029")) expected["0029"].push(key);
  }
  return expected;
}

function advisorDivergenceViolations(
  divergence: AdvisorDivergence,
  observed: LintInventory,
  expectedCounts: ExpectedAdvisorCounts,
): Violation[] {
  const out: Violation[] = [];

  for (const lint of ["0028", "0029"] as const) {
    const d = divergence[lint];
    if (d.entered.length === 0 && d.left.length === 0) continue;
    const partes: string[] = [];
    if (d.entered.length > 0) partes.push(`entraram (banco produz, allowlist não declara): ${d.entered.join(", ")}`);
    if (d.left.length > 0) partes.push(`saíram (allowlist declara, banco não produz mais): ${d.left.join(", ")}`);
    out.push({
      severity: "ALTO",
      fn: `advisor ${lint}`,
      rule: "advisor-divergente",
      observed: `${observed[lint].length} assinatura(s)`,
      expected: `${lint === "0028" ? expectedCounts["0028"] : expectedCounts["0029"]} assinatura(s)`,
      detail: `Divergência no lint ${lint} do Security Advisor. ${partes.join(" | ")}`,
    });
  }

  if (!countsMatchExpected(observed, expectedCounts)) {
    out.push({
      severity: "ALTO",
      fn: "advisor _expected_advisor",
      rule: "advisor-divergente",
      observed: `0028=${observed["0028"].length}, 0029=${observed["0029"].length}, total=${
        observed["0028"].length + observed["0029"].length
      }`,
      expected: `0028=${expectedCounts["0028"]}, 0029=${expectedCounts["0029"]}, total=${expectedCounts.total}`,
      detail:
        `O bloco "_expected_advisor" da allowlist não bate com o que a própria allowlist ` +
        `declara por assinatura (advisor_lints). Atualize function-acl-allowlist.json.`,
    });
  }

  return out;
}

// ─── main ────────────────────────────────────────────────────────────────────

const url = Deno.env.get("SUPABASE_URL");
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!url || !key) {
  console.error(
    "Faltam SUPABASE_URL e/ou SUPABASE_SERVICE_ROLE_KEY no ambiente.\n" +
      "A RPC audit_function_acl() é service_role only de propósito — a anon key não serve.\n" +
      "Ver o cabeçalho deste arquivo para o uso em PowerShell e em bash.",
  );
  Deno.exit(2);
}

const { byKey: allow, expectedAdvisor } = loadAllowlist();
const supabase = createClient(url, key, { auth: { persistSession: false } });

const { data, error } = await supabase.rpc("audit_function_acl");

if (error) {
  console.error(`Falha ao chamar audit_function_acl(): ${error.message}`);
  console.error("A migration 085 foi aplicada? Ela é quem cria a RPC.");
  Deno.exit(2);
}

const rows = (data ?? []) as AuditRow[];

if (rows.length === 0) {
  // Zero linhas não é "tudo limpo": a RPC devolve TODA função não-trigger de
  // public, então vazio significa que algo deu errado na leitura.
  console.error("audit_function_acl() devolveu ZERO linhas — resultado implausível. Investigue antes de confiar.");
  Deno.exit(2);
}

const { violations, observedAdvisor } = audit(rows, allow);

// Regra 6 (equivalente-advisor): sempre calculada e sempre impressa, mesmo
// limpa — é o que torna "23 warnings" conferível em vez de memorizado.
const expectedAdvisorInventory = expectedAdvisorFromAllowlist(allow);
const advisorDivergence = computeAdvisorDivergence(expectedAdvisorInventory, observedAdvisor);
violations.push(...advisorDivergenceViolations(advisorDivergence, observedAdvisor, expectedAdvisor));
sortViolations(violations);

console.log(`Funções analisadas (não-trigger, schema public): ${rows.length}`);
console.log(`Entradas na allowlist: ${allow.size}`);
console.log(
  `\nEquivalente-advisor (regra 6): 0028=${observedAdvisor["0028"].length} | ` +
    `0029=${observedAdvisor["0029"].length} | total=${
      observedAdvisor["0028"].length + observedAdvisor["0029"].length
    }`,
);
console.log(`  0028 (anon):          ${observedAdvisor["0028"].sort().join(", ") || "(nenhuma)"}`);
console.log(`  0029 (authenticated): ${observedAdvisor["0029"].sort().join(", ") || "(nenhuma)"}`);

if (violations.length === 0) {
  console.log("\n✅ Sem violações. Nenhuma função exposta fora da allowlist.");
  Deno.exit(0);
}

const fnsAfetadas = new Set(violations.map((v) => v.fn)).size;
console.error(`\n❌ ${violations.length} violação(ões) em ${fnsAfetadas} função(ões):\n`);
for (const v of violations) {
  console.error(`  [${v.severity}] ${v.fn}`);
  console.error(`      regra:      ${v.rule}`);
  console.error(`      papéis:     observados [${v.observed}] | esperados [${v.expected}]`);
  if (v.searchPath) console.error(`      search_path: ${v.searchPath}`);
  console.error(`      ${v.detail}\n`);
}
console.error(
  "Corrija com uma migration nova (revoke/grant com assinatura completa), ou — se o acesso\n" +
    "for legítimo — acrescente a entrada em scripts/function-acl-allowlist.json COM justificativa.\n" +
    "Nunca adicione à allowlist só para o script parar de falhar.",
);
Deno.exit(1);
