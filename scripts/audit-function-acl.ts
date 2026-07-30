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
}

interface Violation {
  severity: "CRITICO" | "ALTO" | "MEDIO";
  fn: string;
  rule: string;
  detail: string;
}

const ALLOWLIST_PATH = new URL("./function-acl-allowlist.json", import.meta.url);

/** `nome(args)` — a identidade que distingue overloads. Nunca só o nome. */
function sig(name: string, args: string): string {
  return `${name}(${args})`;
}

function loadAllowlist(): Map<string, AllowEntry> {
  const raw = Deno.readTextFileSync(ALLOWLIST_PATH);
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const map = new Map<string, AllowEntry>();

  for (const [group, value] of Object.entries(parsed)) {
    if (group.startsWith("_") || !Array.isArray(value)) continue;
    for (const entry of value as AllowEntry[]) {
      if (!entry?.name || typeof entry.args !== "string" || !Array.isArray(entry.roles)) {
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
  return map;
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

function audit(rows: AuditRow[], allow: Map<string, AllowEntry>): Violation[] {
  const violations: Violation[] = [];

  for (const r of rows) {
    const key = sig(r.function_name, r.identity_args);
    const entry = allow.get(key);
    const exposed = r.anon_execute || r.auth_execute;

    // 1. COMMENT promete service_role only, mas anon/authenticated executam.
    if (claimsServiceRoleOnly(r.fn_comment) && exposed) {
      violations.push({
        severity: "CRITICO",
        fn: key,
        rule: "comentario-mente",
        detail:
          `COMMENT declara "service_role only", mas ` +
          `${r.anon_execute ? "anon " : ""}${r.auth_execute ? "authenticated " : ""}` +
          `pode executar. ACL: ${r.acl}`,
      });
      continue; // já é o achado mais grave desta função
    }

    // 2. Concessão direta ao pseudo-papel PUBLIC. Nunca é intencional aqui:
    //    a allowlist concede a papéis nomeados, jamais a PUBLIC.
    if (r.public_execute) {
      violations.push({
        severity: "ALTO",
        fn: key,
        rule: "grant-para-PUBLIC",
        detail:
          `EXECUTE concedido ao pseudo-papel PUBLIC (ou ACL default). ` +
          `Use "revoke all ... from public, anon, authenticated" e conceda ao papel mínimo. ACL: ${r.acl}`,
      });
    }

    // 3. Exposta sem estar na allowlist = função nova sem classificação, ou
    //    regressão de uma já classificada.
    if (exposed && !entry) {
      violations.push({
        severity: r.is_secdef ? "CRITICO" : "ALTO",
        fn: key,
        rule: "fora-da-allowlist",
        detail:
          `${r.is_secdef ? "SECURITY DEFINER" : "SECURITY INVOKER"} executável por ` +
          `${[r.anon_execute && "anon", r.auth_execute && "authenticated"].filter(Boolean).join(" + ")}, ` +
          `sem entrada em function-acl-allowlist.json. ` +
          `Classifique em docs/hotfix-acl/01-INVENTARIO-E-CLASSIFICACAO.md antes de liberar.`,
      });
      continue;
    }

    // 4. Na allowlist, mas com papel a MAIS do que foi aprovado.
    if (entry) {
      const extra: string[] = [];
      if (r.anon_execute && !entry.roles.includes("anon")) extra.push("anon");
      if (r.auth_execute && !entry.roles.includes("authenticated")) extra.push("authenticated");
      if (extra.length > 0) {
        violations.push({
          severity: "ALTO",
          fn: key,
          rule: "papel-a-mais",
          detail:
            `Allowlist aprova [${entry.roles.join(", ")}], mas o banco concede também ` +
            `[${extra.join(", ")}]. ACL: ${r.acl}`,
        });
      }
    }

    // 5. SECURITY DEFINER sem `search_path` fixo: o caller controla a resolução
    //    de nomes e pode sequestrar a função com um schema próprio.
    if (r.is_secdef && !r.has_search_path) {
      violations.push({
        severity: "MEDIO",
        fn: key,
        rule: "search_path-mutavel",
        detail: `SECURITY DEFINER sem "set search_path". Adicione "set search_path = public".`,
      });
    }
  }

  const ordem = { CRITICO: 0, ALTO: 1, MEDIO: 2 };
  return violations.sort((a, b) => ordem[a.severity] - ordem[b.severity] || a.fn.localeCompare(b.fn));
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

const allow = loadAllowlist();
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

const violations = audit(rows, allow);

console.log(`Funções analisadas (não-trigger, schema public): ${rows.length}`);
console.log(`Entradas na allowlist: ${allow.size}`);

if (violations.length === 0) {
  console.log("\n✅ Sem violações. Nenhuma função exposta fora da allowlist.");
  Deno.exit(0);
}

console.error(`\n❌ ${violations.length} violação(ões):\n`);
for (const v of violations) {
  console.error(`  [${v.severity}] ${v.fn}`);
  console.error(`      regra: ${v.rule}`);
  console.error(`      ${v.detail}\n`);
}
console.error(
  "Corrija com uma migration nova (revoke/grant com assinatura completa), ou — se o acesso\n" +
    "for legítimo — acrescente a entrada em scripts/function-acl-allowlist.json COM justificativa.\n" +
    "Nunca adicione à allowlist só para o script parar de falhar.",
);
Deno.exit(1);
