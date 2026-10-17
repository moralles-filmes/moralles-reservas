/**
 * Acoplamento: policy `unit_member_read_audit` de `audit_log` <-> TABLE_LABEL.
 *
 * A policy de membro do cliente lê só uma LISTA de tabelas (customers,
 * reservations, unit_members). Essa lista é exatamente o que a tela de Auditoria
 * do cliente sabe rotular (`TABLE_LABEL` em src/pages/gestao/Auditoria.tsx):
 * tabela auditada nova nasce invisível para o cliente, e quem quiser mostrá-la
 * precisa mexer nos DOIS lugares. Sem este teste, um lado muda sozinho e a tela
 * mostra "customers" cru, ou a policy volta a entregar dado da plataforma
 * (custo do fornecedor, motivo de override) ao dono do restaurante.
 *
 * Lê a policy EFETIVA: o último arquivo de migration, em ordem de nome, que
 * cria `unit_member_read_audit` (comentários não contam — a 096 cita a policy e
 * esta migration traz o rollback em comentário).
 *
 * A terceira ponta é a constante `AUDIT_LOG_MEMBER_TABLES` (src/lib/audit-log-tables.ts),
 * que `useAuditLog` aplica como `.in("table_name", ...)` e tipa o `TABLE_LABEL`: sem
 * ela o platform_admin, que passa pela policy de admin, veria tabelas da plataforma
 * na tela do cliente.
 *
 * Os controles positivos mexem em TEXTO, nunca em arquivo: provam que o
 * extrator e a comparação reprovam o defeito, não só que o repo atual passa.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AUDIT_LOG_MEMBER_TABLES } from "../src/lib/audit-log-tables";

const MIGRATIONS_DIR = join(__dirname, "..", "supabase", "migrations");
const AUDITORIA_PATH = join(__dirname, "..", "src", "pages", "gestao", "Auditoria.tsx");
const EXPECTED_MIGRATION = "20261015233000_audit_log_member_read_allowlist.sql";
const PLATFORM_TABLES = [
  "whatsapp_instances",
  "whatsapp_implementations",
  "organization_entitlement_overrides",
  "whatsapp_instance_cycles",
];

function stripSqlComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

const CREATE_POLICY_RE = /create\s+policy\s+"?unit_member_read_audit"?\s+on\s+(?:public\.)?audit_log\b/i;

/** Último arquivo (ordem de nome) que cria a policy, fora de comentário. */
function effectivePolicyMigration(dir: string): { file: string; sql: string } {
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  let found: { file: string; sql: string } | null = null;
  for (const file of files) {
    const sql = stripSqlComments(readFileSync(join(dir, file), "utf8"));
    if (CREATE_POLICY_RE.test(sql)) found = { file, sql };
  }
  if (!found) throw new Error("nenhuma migration cria unit_member_read_audit");
  return found;
}

/** Texto do `create policy ... ;` da policy, sem comentários. */
function policyStatement(sql: string): string {
  const start = sql.search(CREATE_POLICY_RE);
  if (start < 0) throw new Error("create policy unit_member_read_audit nao encontrado");
  const end = sql.indexOf(";", start);
  return sql.slice(start, end < 0 ? undefined : end);
}

function allowlistOf(policy: string): string[] {
  const m = /table_name\s+in\s*\(([^)]*)\)/i.exec(policy);
  if (!m) throw new Error("a policy nao restringe por `table_name in (...)`");
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
}

function tableLabelKeys(tsx: string): string[] {
  const m = /const\s+TABLE_LABEL\s*:[^=]*=\s*\{([\s\S]*?)\n\};/.exec(tsx);
  if (!m) throw new Error("TABLE_LABEL nao encontrado em Auditoria.tsx");
  return [...m[1].matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((x) => x[1]).sort();
}

/** Mensagem de divergência (vazia = iguais), nos dois sentidos. */
function diffLists(policyList: string[], labelKeys: string[]): string[] {
  const out: string[] = [];
  for (const t of policyList) {
    if (!labelKeys.includes(t)) {
      out.push(`a policy libera '${t}' ao cliente mas o TABLE_LABEL de Auditoria.tsx nao a rotula`);
    }
  }
  for (const k of labelKeys) {
    if (!policyList.includes(k)) {
      out.push(`o TABLE_LABEL rotula '${k}' mas a policy unit_member_read_audit nao a libera ao cliente`);
    }
  }
  return out;
}

describe("audit_log: leitura de membro por lista de tabelas", () => {
  const effective = effectivePolicyMigration(MIGRATIONS_DIR);
  const policy = policyStatement(effective.sql);
  const tsx = readFileSync(AUDITORIA_PATH, "utf8");

  it("a policy efetiva e a da migration de allowlist (nenhuma migration posterior a redefine)", () => {
    expect(effective.file).toBe(EXPECTED_MIGRATION);
  });

  it("a policy restringe por table_name in ('customers', 'reservations', 'unit_members')", () => {
    expect(policy).toContain("table_name in ('customers', 'reservations', 'unit_members')");
  });

  it("a policy qualifica os helpers em app_private", () => {
    expect(policy).toContain("app_private.is_unit_member(");
    expect(policy).toContain("app_private.is_org_member(");
  });

  it("a lista da policy e igual as chaves de TABLE_LABEL, nos dois sentidos", () => {
    const divergencias = diffLists(allowlistOf(policy), tableLabelKeys(tsx));
    expect(divergencias, divergencias.join("\n")).toEqual([]);
  });

  it("a lista da policy e igual a AUDIT_LOG_MEMBER_TABLES (que o useAuditLog aplica)", () => {
    const divergencias = diffLists(allowlistOf(policy), [...AUDIT_LOG_MEMBER_TABLES].sort());
    expect(divergencias, divergencias.join("\n")).toEqual([]);
  });

  it("nenhuma tabela da plataforma aparece na lista", () => {
    const lista = allowlistOf(policy);
    for (const t of PLATFORM_TABLES) {
      expect(lista, `'${t}' e dado da plataforma e nao pode ir ao cliente`).not.toContain(t);
    }
  });

  describe("controles positivos (o teste reprova o defeito)", () => {
    // Linha de base literal, independente do repo: o controle mede o comparador,
    // e continua valendo mesmo se um dos dois lados do repo for sabotado.
    const BASELINE = ["customers", "reservations", "unit_members"];

    it("lista com tabela da plataforma a mais diverge do TABLE_LABEL", () => {
      const sabotada = policy.replace("'unit_members')", "'unit_members', 'whatsapp_instances')");
      expect(sabotada).not.toBe(policy);
      const lista = allowlistOf(sabotada);
      expect(lista).toContain("whatsapp_instances");
      expect(diffLists(lista, BASELINE).length).toBeGreaterThan(0);
    });

    it("chave extra no TABLE_LABEL diverge da lista da policy", () => {
      const sabotado = tsx.replace(
        'unit_members: "Membro da unidade",',
        'unit_members: "Membro da unidade",\n  whatsapp_instances: "Instancia",',
      );
      expect(sabotado).not.toBe(tsx);
      expect(diffLists(BASELINE, tableLabelKeys(sabotado)).length).toBeGreaterThan(0);
    });

    it("constante com tabela a mais diverge da lista da policy", () => {
      const sabotada = [...AUDIT_LOG_MEMBER_TABLES, "whatsapp_instances"].sort();
      expect(diffLists(allowlistOf(policy), sabotada).length).toBeGreaterThan(0);
    });

    it("policy sem a restricao por tabela nao tem lista (o extrator falha alto)", () => {
      const antiga = policy.replace(/table_name\s+in\s*\([^)]*\)\s+and/i, "");
      expect(() => allowlistOf(antiga)).toThrow();
    });

    it("comentario com create policy nao conta como definicao efetiva", () => {
      const comentado = stripSqlComments('-- create policy "unit_member_read_audit" on public.audit_log for select');
      expect(CREATE_POLICY_RE.test(comentado)).toBe(false);
    });
  });
});
