/**
 * Guardrail de ACL — camada ESTÁTICA, bloqueante no CI.
 *
 * O guardrail de verdade é scripts/audit-function-acl.ts, que lê o ACL REAL do
 * banco pela RPC audit_function_acl(). Ele não roda neste CI porque o projeto
 * não tem banco de teste: o histórico de migrations não replaya (54 migrations
 * usam `create or replace function` para alterar retorno tabular contra 4 que
 * usam `drop function`), então nem `supabase db reset` nem Supabase Branch
 * conseguem reconstruir o schema. Conectar o CI ao banco de PRODUÇÃO está
 * proibido, e não existe staging.
 *
 * Então esta camada cobre o vetor que o CI CONSEGUE ver sem banco, que é também
 * o mais provável: alguém abrir uma função para anon/authenticated numa migration
 * nova sem classificá-la na allowlist versionada.
 *
 * O que ela NÃO cobre, e por isso o guardrail com banco continua obrigatório:
 * grant feito fora de migration (dashboard, psql manual), default privilege
 * restaurado pela plataforma, e função criada por supabase_admin.
 *
 * Ver docs/hotfix-acl/02-VALIDACAO-E-RISCOS.md §8.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(__dirname, "..", "supabase", "migrations");
const ALLOWLIST_PATH = join(__dirname, "function-acl-allowlist.json");
const AUDIT_SCRIPT_PATH = join(__dirname, "audit-function-acl.ts");

/** Versão da 085 — o marco a partir do qual a superfície está classificada. */
const HOTFIX_VERSION = "20260730160000";

interface AllowEntry {
  name: string;
  args: string;
  roles: string[];
  why: string;
}

/**
 * Entrada como ela é lida pelo bloco `_expected_advisor` — os dois campos que
 * `AllowEntry` não carrega porque o resto do arquivo (grant/drop matching)
 * não precisa deles. Tipada à parte para não forçar as ~30 outras leituras de
 * `AllowEntry` neste arquivo a lidar com campo opcional.
 */
interface AdvisorEntry extends AllowEntry {
  security_definer: boolean;
  advisor_lints: string[];
}

interface ExpectedAdvisorCounts {
  "0028": number;
  "0029": number;
  total: number;
}

const allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8")) as Record<string, unknown>;

/**
 * Grupos de entrada da allowlist, DERIVADOS: todo par de nível superior cujo
 * valor é array e cujo nome não começa com `_`.
 *
 * Era uma constante com três nomes escritos à mão, enquanto
 * scripts/audit-function-acl.ts (linhas 103-104) sempre derivou. Duas noções de
 * "todas as entradas" dentro do MESMO guardrail: um grupo novo no JSON seria
 * somado pelo script e ignorado em silêncio por este arquivo — as entradas
 * dele não passariam por "está bem formada", nem por "nunca aprova PUBLIC",
 * nem pela coerência de `advisor_lints`. Grupo novo é exatamente o momento em
 * que alguém classifica superfície nova.
 *
 * O prefixo `_` não é detalhe: `_doc` e `_doc_rls_helpers` são arrays DE PROSA,
 * então filtrar só por `Array.isArray` engoliria prosa como se fosse entrada.
 * São os dois critérios juntos, iguais aos do script.
 */
function arrayGroupNamesIn(al: Record<string, unknown>): string[] {
  return Object.entries(al)
    .filter(([name, value]) => !name.startsWith("_") && Array.isArray(value))
    .map(([name]) => name);
}

function entriesOfIn(al: Record<string, unknown>, group: string): AllowEntry[] {
  return (al[group] ?? []) as AllowEntry[];
}

/** Todas as entradas de `al`, sobre os grupos derivados dela mesma. */
function allEntriesIn(al: Record<string, unknown>): AllowEntry[] {
  return arrayGroupNamesIn(al).flatMap((g) => entriesOfIn(al, g));
}

const GROUPS: string[] = arrayGroupNamesIn(allowlist);

function entriesOf(group: string): AllowEntry[] {
  return entriesOfIn(allowlist, group);
}

const allEntries: AllowEntry[] = allEntriesIn(allowlist);

describe("manutenção de textos WhatsApp", () => {
  it("classifica a manutenção administrativa como somente authenticated, sem anon", () => {
    const entry = allEntries.find((item) => item.name === "maintain_whatsapp_legacy_template") as AdvisorEntry | undefined;
    expect(entry).toBeDefined();
    expect(entry!.roles).toEqual(["authenticated"]);
    expect(entry!.security_definer).toBe(true);
    expect(entry!.advisor_lints).toEqual(["0029"]);
    expect(entry!.args).toBe("p_table_name text, p_action text, p_row_id uuid, p_unit_id uuid, p_event text, p_body text, p_customized boolean, p_reason text");
    expect(entry!.why).toContain("platform_admin");
    expect(entry!.why).toContain("uso único");
  });
});

describe('Task10 existing outbox delegation', () => {
  it('closes all six signatures, both guards, private types/permits and the operational table', () => {
    const signatures = allowlist._service_only_whatsapp_outbox_delegation as string[];
    expect(signatures).toEqual(['claim_notification_outbox_initial(uuid)', 'delegate_notification_outbox_automation(uuid,uuid)',
      'poll_notification_outbox_automation(uuid)', 'defer_notification_outbox_automation_dependency(uuid)',
      'finish_notification_outbox_initial(uuid,uuid)', 'recover_delegated_notification_outbox(integer)']);
    const sql = readFileSync(join(MIGRATIONS_DIR, '20261006003631_whatsapp_outbox_automation_delegation.sql'), 'utf8');
    for (const signature of signatures) {
      expect(allEntries.some(entry => entry.name === signature.split('(')[0])).toBe(false);
      expect(sql).toContain(`revoke all on function public.${signature} from public,anon,authenticated,service_role;`);
      expect(sql).toContain(`grant execute on function public.${signature} to service_role;`);
    }
    for (const signature of ['guard_notification_outbox_automation()', 'guard_notification_outbox_insert_scope()']) {
      expect(sql).toContain(`revoke all on function public.${signature} from public,anon,authenticated,service_role;`);
      expect(sql).not.toContain(`grant execute on function public.${signature}`);
    }
    for (const type of ['notification_outbox_mutation_action','notification_outbox_transition_tuple','notification_outbox_automation_projection'])
      expect(sql).toContain(`revoke all on type app_private.${type} from public,anon,authenticated,service_role;`);
    expect(sql).toContain('revoke all on table app_private.notification_outbox_mutation_permits from public,anon,authenticated,service_role;');
    expect(sql).toContain('revoke all on table public.notification_outbox from public,anon,authenticated,service_role;');
    expect(sql).toContain('grant select,insert,update,delete on table public.notification_outbox to service_role;');
    expect(sql).not.toMatch(/grant\s+.*\s+to\s+(?:public|anon|authenticated)\s*;/i);
    expect(sql).not.toMatch(/grant\s+.*\s+on\s+(?:schema|type)\s+app_private/i);
  });
});

describe("RPCs internas de automação WhatsApp", () => {
  it("classifica todas as assinaturas como service-only sem ampliar a allowlist pública", () => {
    const signatures = allowlist._service_only_whatsapp_automation as string[];
    expect(signatures).toHaveLength(13);
    expect(new Set(signatures).size).toBe(signatures.length);
    const migration = readFileSync(join(MIGRATIONS_DIR, '20261004002728_whatsapp_automation_claims.sql'), 'utf8');
    for (const signature of signatures) {
      const name = signature.split('(')[0];
      expect(allEntries.some(entry => entry.name === name), signature).toBe(false);
      expect(migration, signature).toContain(`revoke all on function public.${signature} from public,anon,authenticated,service_role;`);
      expect(migration, signature).toContain(`grant execute on function public.${signature} to service_role;`);
    }
    expect(migration).toContain('revoke all on function app_private.consume_whatsapp_post_reset(text,uuid,uuid,integer,timestamptz) from public,anon,authenticated,service_role;');
    expect(migration).toContain('revoke all on function public.guard_whatsapp_template_scope() from public,anon,authenticated,service_role;');
  });
});

describe('Task9c service-only acceptance repair', () => {
  it('keeps the atomic repair outside public caller metadata', () => {
    const signature = 'reconcile_whatsapp_automation_acceptance(uuid)';
    expect(allowlist._service_only_whatsapp_acceptance).toEqual([signature]);
    expect(allEntries.some(entry => entry.name === signature.split('(')[0])).toBe(false);
    const migration = readFileSync(join(MIGRATIONS_DIR, '20261005145913_whatsapp_automation_acceptance_repair.sql'), 'utf8');
    expect(migration).toContain(`revoke all on function public.${signature} from public,anon,authenticated,service_role;`);
    expect(migration).toContain(`grant execute on function public.${signature} to service_role;`);
    expect(migration).toMatch(/security definer\s+set search_path\s*=\s*''/i);
    expect(migration).not.toMatch(/grant\s+.*\s+to\s+(?:public|anon|authenticated)\s*;/i);
  });
});

describe('Task9c final typed resource authority', () => {
  it('keeps one private authority algorithm and closes all three signatures', () => {
    const signature = 'confirm_whatsapp_automation_resource_post(uuid,uuid,bigint,bigint,bigint,jsonb)';
    expect(allowlist._service_only_whatsapp_resource_confirm).toEqual([signature]);
    expect(allEntries.some(entry => entry.name === signature.split('(')[0])).toBe(false);
    const sql = readFileSync(join(MIGRATIONS_DIR, '20261005170415_whatsapp_automation_resource_post_confirm.sql'), 'utf8');
    expect(sql).toContain(`revoke all on function public.${signature} from public,anon,authenticated,service_role;`);
    expect(sql).toContain(`grant execute on function public.${signature} to service_role;`);
    for (const args of ['uuid,uuid,bigint,bigint,bigint,boolean', 'uuid,uuid,bigint,bigint,bigint,boolean,jsonb'])
      expect(sql).toContain(`revoke all on function app_private.whatsapp_automation_post_core(${args}) from public,anon,authenticated,service_role;`);
    expect(sql).not.toMatch(/drop\s+function|grant\s+.*\s+to\s+(?:public|anon|authenticated)\s*;/i);
    expect(sql).not.toMatch(/create or replace function public\.(?:prepare|confirm)_whatsapp_automation_post\(/i);
    expect(sql.match(/language plpgsql volatile security definer set search_path=''/g)).toHaveLength(2);
    expect(sql).toContain('p_confirm_only,null)');
    const decisions = sql.slice(sql.indexOf('v_now:=clock_timestamp()'), sql.indexOf('if v_error is not null then\n    update'));
    expect(decisions).not.toMatch(/\b(?:from|join)\s+(?:public|app_private|pg_catalog)\./i);
    expect(sql).not.toMatch(/\b(?:stable|immutable)\b/i);
  });
});

describe('Task9b service-only dispatch prerequisites', () => {
  it('revokes both private helpers and the composite type without exposing an initializer', () => {
    const signatures = allowlist._service_only_whatsapp_dispatch_prerequisites as string[];
    expect(signatures).toEqual(['confirm_whatsapp_automation_post(uuid,uuid,bigint,bigint,bigint)', 'block_whatsapp_automation_preflight(uuid,uuid,text)']);
    const migration = readFileSync(join(MIGRATIONS_DIR, '20261004184738_whatsapp_automation_dispatch_prerequisites.sql'), 'utf8');
    for (const signature of signatures) {
      expect(allEntries.some(entry => entry.name === signature.split('(')[0])).toBe(false);
      expect(migration).toContain(`revoke all on function public.${signature} from public,anon,authenticated,service_role;`);
      expect(migration).toContain(`grant execute on function public.${signature} to service_role;`);
    }
    for (const signature of ['whatsapp_automation_post_core(uuid,uuid,bigint,bigint,bigint,boolean)', 'consume_whatsapp_automation_pin_initialization(uuid,app_private.whatsapp_automation_pin_tuple,app_private.whatsapp_automation_pin_tuple)']) {
      expect(migration).toContain(`revoke all on function app_private.${signature} from public,anon,authenticated,service_role;`);
    }
    expect(migration).toContain('revoke all on type app_private.whatsapp_automation_pin_tuple from public,anon,authenticated,service_role;');
    expect(migration).not.toMatch(/grant\s+.*\s+to\s+(?:public|anon|authenticated)\s*;/i);
    expect(migration).not.toMatch(/create or replace function public\.finish_whatsapp_automation/);
    expect(migration).not.toContain("errcode='40001'");
  });
});

describe('autoridade transacional de eventos de templates', () => {
  it('cerca o runtime e mantém wrappers service-only com writer privado compartilhado', () => {
    const signatures = allowlist._service_only_whatsapp_template_events as string[];
    expect(signatures).toEqual(['record_whatsapp_template_events_fenced(jsonb,jsonb)']);
    const migration = readFileSync(join(MIGRATIONS_DIR, '20261004165825_whatsapp_template_event_authority.sql'), 'utf8');
    for (const signature of [...signatures, 'record_whatsapp_template_events(uuid,jsonb)']) {
      expect(allEntries.some(entry => entry.name === signature.split('(')[0])).toBe(false);
      expect(migration).toContain(`revoke all on function public.${signature} from public,anon,authenticated,service_role;`);
      expect(migration).toContain(`grant execute on function public.${signature} to service_role;`);
    }
    expect(migration).toContain('revoke all on function app_private.record_whatsapp_template_events_core(uuid,uuid,jsonb) from public,anon,authenticated,service_role;');
    expect(migration).not.toMatch(/grant\s+execute\s+on\s+function\s+app_private\.record_whatsapp_template_events_core/i);
    expect(migration.match(/insert into public\.whatsapp_template_events/g)).toHaveLength(1);
    expect(migration.match(/return app_private\.record_whatsapp_template_events_core/g)).toHaveLength(2);
    expect(migration).toContain("raise exception 'template_authority_changed' using errcode='PT503';");
    expect(migration).not.toContain("errcode='40001'");
    const runtime = readFileSync(join(__dirname, '../supabase/functions/_shared/whatsapp-template-events.ts'), 'utf8');
    expect(runtime).toContain("db.rpc('record_whatsapp_template_events_fenced', { p_capture: capture, p_events: events })");
    expect(runtime).not.toMatch(/\.rpc\(['"]record_whatsapp_template_events['"]/);
  });
});

describe('worker interno de templates', () => {
  it('mantém RPCs service-only e triggers sem execução direta', () => {
    const signatures = allowlist._service_only_whatsapp_template_workers as string[];
    expect(signatures).toHaveLength(8);
    const migration = readFileSync(join(MIGRATIONS_DIR, '20261004025039_whatsapp_template_workers.sql'), 'utf8');
    for (const signature of signatures) {
      expect(allEntries.some(entry => entry.name === signature.split('(')[0])).toBe(false);
      expect(migration).toContain(`revoke all on function public.${signature} from public,anon,authenticated,service_role;`);
      expect(migration).toContain(`grant execute on function public.${signature} to service_role;`);
    }
    for (const name of ['guard_whatsapp_template_credential_revision', 'guard_whatsapp_template_submission_history', 'trigger_whatsapp_template_workers']) {
      expect(migration).toContain(`revoke all on function public.${name}() from public,anon,authenticated,service_role;`);
      expect(migration).not.toContain(`grant execute on function public.${name}()`);
    }
  });
});

describe('preferências públicas mediadas pela Edge Function', () => {
  it('mantém SQL interno service-only e helpers/trigger sem execução direta', () => {
    const signatures = allowlist._service_only_whatsapp_preferences as string[];
    expect(signatures).toHaveLength(6);
    const migration = readFileSync(join(MIGRATIONS_DIR, '20261004014032_whatsapp_message_preferences.sql'), 'utf8');
    for (const signature of signatures) {
      expect(allEntries.some(entry => entry.name === signature.split('(')[0])).toBe(false);
      expect(migration).toContain(`revoke all on function public.${signature} from public,anon,authenticated,service_role;`);
      expect(migration).toContain(`grant execute on function public.${signature} to service_role;`);
    }
    for (const signature of ['public.erase_whatsapp_customer_preferences()', 'public.guard_whatsapp_template_scope()', 'public.guard_whatsapp_template_evidence()', 'app_private.consume_whatsapp_slot_release(uuid)']) {
      expect(migration).toContain(`revoke all on function ${signature} from public,anon,authenticated,service_role;`);
      expect(migration).not.toContain(`grant execute on function ${signature}`);
    }
    const config = readFileSync(join(MIGRATIONS_DIR, '..', 'config.toml'), 'utf8');
    expect(config).toMatch(/\[functions\.whatsapp-message-preferences\]\s*verify_jwt = false/);
  });
});

/**
 * Divide a lista de argumentos por vírgulas de nível zero. `timestamp with time
 * zone` não tem vírgula, mas tipos futuros com precisão (`numeric(10,2)`) têm.
 */
function splitArgs(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed === "") return [];
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of trimmed) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

/**
 * Chave de comparação: nome + ARIDADE. Não dá para comparar por tipo: a
 * migration escreve `enter_waitlist(uuid, text, text, int, text, text, time)` e
 * o Postgres reporta `... integer ... time without time zone`. A aridade
 * distingue os overloads que existem aqui (get_reservation_by_code com 1 e com
 * 2 argumentos) sem depender de normalizar nome de tipo.
 */
function key(name: string, argCount: number): string {
  return `${name}/${argCount}`;
}

const allowByKey = new Map<string, AllowEntry>();
for (const e of allEntries) allowByKey.set(key(e.name, splitArgs(e.args).length), e);

interface GrantStmt {
  file: string;
  name: string;
  argCount: number;
  roles: string[];
}

/**
 * Lista de argumentos de uma assinatura, com UM nível de parênteses aninhado —
 * o bastante para tipo com precisão (`numeric(10,2)`, `varchar(255)`,
 * `character varying(255)`).
 *
 * O padrão anterior era `([^)]*)`, que NÃO casa nenhuma dessas formas: `[^)]*`
 * para no primeiro `)`, o `\)` seguinte cai sobre o `2` em vez do
 * fecha-parênteses, e o match INTEIRO falha — o statement vira invisível. Ver
 * a nota de direção de falha abaixo, que é o defeito que isso corrige.
 *
 * A troca é ampliação ESTRITA: conferido contra as migrations reais, zero
 * diferença de match nos três padrões (nenhuma usa tipo com precisão em
 * grant/revoke/drop hoje), e as formas com parênteses passam a casar.
 * `numeric[]` já casava nos dois. A aridade não infla com a vírgula de dentro
 * dos parênteses porque `splitArgs` conta profundidade.
 */
const FN_ARGS = String.raw`((?:[^()]|\([^()]*\))*)`;

/**
 * ─── DIREÇÃO DE FALHA DOS TRÊS PADRÕES — leia antes de mexer em qualquer um ──
 *
 * Não é "casar de mais é o único risco", que é o que esta nota dizia antes e
 * está errado na direção que importa. Cada padrão alimenta uma EXIGÊNCIA ou uma
 * ISENÇÃO, e é isso que decide qual direção abre brecha — elas não são a mesma
 * nos três:
 *
 * • GRANT_RE alimenta uma EXIGÊNCIA (todo grant a papel externo precisa de
 *   entrada na allowlist).
 *     – NÃO casar um grant real ⇒ grant INVISÍVEL ⇒ zero exigência ⇒ FALHA
 *       ABERTA. Era o estado real: `([^)]*)` não casava
 *       `grant execute on function public.f(numeric(10,2)) to anon;` nem
 *       `varchar(255)`, então um grant a `anon` numa função com tipo de
 *       precisão passava sem pedir classificação nenhuma. Fechado por
 *       `FN_ARGS`, com controle positivo mais abaixo neste arquivo.
 *     – casar de MAIS ⇒ exige entrada que talvez não precisasse ⇒ ruído, falha
 *       FECHADA.
 *   O que AINDA escapa, por escolha de escopo: schema diferente de `public`
 *   (`grant execute on function app_private.f(uuid) to anon;` é invisível aqui
 *   — `(?:public\.)?([a-z0-9_]+)\s*\(` não casa um qualificador que não seja
 *   `public.`), e statement sem `;`.
 *
 * • REVOKE_PUBLIC_RE alimenta uma ISENÇÃO (a função consta como revogada de
 *   PUBLIC). Polaridade INVERTIDA em relação ao GRANT_RE:
 *     – casar de MAIS ⇒ isenção falsa ⇒ FALHA ABERTA. A frase anterior desta
 *       nota — "GRANT_RE e REVOKE_PUBLIC_RE casando de mais só fariam o teste
 *       exigir/reconhecer mais entrada, nunca dispensar uma" — erra exatamente
 *       aqui: reconhecer um revoke a mais DISPENSA a exigência de revoke.
 *     – NÃO casar ⇒ cobra um revoke que existe ⇒ ruído, falha FECHADA (mesma
 *       forma de truncamento do GRANT_RE, consequência oposta).
 *
 * • DROP_RE alimenta uma ISENÇÃO (assinatura dropada depois da 085 dispensa
 *   entrada). Mesma polaridade do REVOKE_PUBLIC_RE: casar de MAIS é FALHA
 *   ABERTA, não casar é ruído. Ver também a nota em `dropsInSql`.
 *
 * VALE PARA OS TRÊS: `stripComments` remove só comentário de LINHA (`--`). Um
 * comentário de BLOCO (abre com `/*`) contendo `drop function ...;` ou
 * `revoke all ... from public;` seria lido como statement REAL e concederia
 * isenção de verdade — e o mesmo vale para esse texto dentro de um corpo
 * `$$...$$` (docstring, literal, nome de variável). Nenhuma migration usa
 * comentário de bloco hoje — conferido —, e há um caso adiante que fixa essa
 * lacuna por escrito em vez de deixá-la implícita.
 */
const GRANT_RE = new RegExp(
  String.raw`grant\s+execute\s+on\s+function\s+(?:public\.)?([a-z0-9_]+)\s*\(` +
    FN_ARGS +
    String.raw`\)\s*to\s+([^;]+);`,
  "gi",
);
const REVOKE_PUBLIC_RE = new RegExp(
  String.raw`revoke\s+(?:all|execute)[^;]*?\son\s+function\s+(?:public\.)?([a-z0-9_]+)\s*\(` +
    FN_ARGS +
    String.raw`\)\s*from\s+([^;]+);`,
  "gi",
);
const BROAD_GRANT_RE = /grant\s+execute\s+on\s+all\s+functions\s+in\s+schema/i;
const DROP_RE = new RegExp(
  String.raw`drop\s+function\s+(?:if\s+exists\s+)?(?:public\.)?([a-z0-9_]+)\s*\(` +
    FN_ARGS +
    String.raw`\)\s*;`,
  "gi",
);

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function versionOf(file: string): string {
  return file.split("_")[0];
}

/**
 * Comentários de linha carregam SQL de exemplo (blocos de rollback e de
 * verificação); contá-los como statement real produziria falso positivo. Todo
 * matching neste arquivo (grant, revoke E drop) passa por aqui primeiro — é o
 * que garante que um `drop function` dentro de um comentário não isenta nada.
 */
function stripComments(raw: string): string {
  return raw
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");
}

function readMigration(file: string): string {
  return stripComments(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
}

const EXTERNAL_ROLES = ["anon", "authenticated", "public"];

/**
 * `sql` já sem comentário de linha. Extraída de `grantsIn` para que o controle
 * positivo do `FN_ARGS` possa ir do TEXTO SQL até a exigência
 * (`unclassifiedHotfixGrants`) sem precisar de arquivo em disco — provar só que
 * "o regex casa" deixaria de fora a parte que importa, que é a exigência
 * chegar a existir.
 */
function grantsInSql(sql: string, file: string): GrantStmt[] {
  const out: GrantStmt[] = [];
  for (const m of sql.matchAll(GRANT_RE)) {
    out.push({
      file,
      name: m[1],
      argCount: splitArgs(m[2]).length,
      roles: m[3]
        .split(",")
        .map((r) => r.trim().toLowerCase())
        .filter(Boolean),
    });
  }
  return out;
}

function grantsIn(file: string): GrantStmt[] {
  return grantsInSql(readMigration(file), file);
}

/**
 * `drop function` já sem comentário (`sql` sempre vem de `stripComments`,
 * direto ou via `readMigration`) — mesma identidade do resto do arquivo:
 * nome + aridade via `key`/`splitArgs`, nunca tipo.
 *
 * DIREÇÃO DE FALHA: `DROP_RE` casando de MAIS concede uma isenção em vez de
 * acrescentar uma exigência — é falha ABERTA, e é o risco a ter em mente aqui.
 * Um texto `drop function ...;` dentro do corpo `$$...$$` de uma função futura
 * (exemplo em docstring, nome de variável, literal) ou dentro de comentário de
 * bloco leria como drop real e isentaria da allowlist um grant que continua
 * vivo; `stripComments` só tira comentário de LINHA (`--`). Não é o caso de
 * nenhuma migration hoje — checado.
 *
 * NÃO é o único padrão com essa polaridade, ao contrário do que esta nota
 * afirmava: `REVOKE_PUBLIC_RE` tem a mesma, e `GRANT_RE` tem a oposta, com o
 * risco no lado de NÃO casar. A análise dos três, junto com a forma concreta
 * que escapava, está na nota acima das três constantes — é lá que se lê antes
 * de mexer em qualquer uma delas.
 */
function dropsInSql(sql: string): { name: string; argCount: number }[] {
  const out: { name: string; argCount: number }[] = [];
  for (const m of sql.matchAll(DROP_RE)) {
    out.push({ name: m[1], argCount: splitArgs(m[2]).length });
  }
  return out;
}

function dropsIn(file: string): { name: string; argCount: number }[] {
  return dropsInSql(readMigration(file));
}

/**
 * Assinaturas (name/argCount) dropadas por QUALQUER migration num dos
 * `files` dados. Usada só com migrations POSTERIORES à 085 — ver o
 * comentário em `unclassifiedHotfixGrants`.
 */
function droppedKeysIn(files: string[]): Set<string> {
  const out = new Set<string>();
  for (const f of files) {
    for (const d of dropsIn(f)) out.add(key(d.name, d.argCount));
  }
  return out;
}

/**
 * O predicado central do describe "migration 085 vs allowlist": todo grant a
 * anon/authenticated/PUBLIC feito pela 085 precisa de entrada na allowlist —
 * EXCETO se uma migration posterior à 085 dropou aquela mesma assinatura
 * (mesmo nome, MESMA aridade — dropar `f(uuid)` não isenta `f(uuid, uuid)`).
 *
 * POR QUÊ A EXCEÇÃO NÃO ABRE BRECHA PARA RECRIAÇÃO: se uma migration futura
 * recriasse a função dropada e concedesse EXECUTE de novo, isso seria, por
 * definição, um grant NOVO numa migration posterior à 085 — e o describe
 * "migrations posteriores ao hotfix não reabrem a superfície" (mais abaixo
 * neste arquivo) já exige entrada na allowlist para todo grant novo dessas,
 * sem exceção. A propriedade continua garantida pelo checador irmão; por isso
 * não há (nem foi adicionada) nenhuma lógica de ORDEM entre o drop e um
 * eventual re-grant aqui — uma segunda noção de sequência dentro de um
 * guardrail de segurança é mais risco do que o caso vale.
 *
 * Extraída como função pura (em vez de só o corpo do `it`) para que as duas
 * pontas da exceção — "sem drop depois, a exigência original continua de pé"
 * e "drop em aridade diferente não isenta a aridade concedida" — sejam
 * provadas contra dados sintéticos, não só contra o estado atual das
 * migrations reais.
 */
function unclassifiedHotfixGrants(
  grants: GrantStmt[],
  allow: Map<string, AllowEntry>,
  droppedLater: Set<string>,
): string[] {
  const missing: string[] = [];
  for (const g of grants) {
    const external = g.roles.filter((r) => EXTERNAL_ROLES.includes(r));
    if (external.length === 0) continue;
    const k = key(g.name, g.argCount);
    if (droppedLater.has(k)) continue;
    const entry = allow.get(k);
    if (!entry) {
      missing.push(`${g.name}/${g.argCount} sem entrada na allowlist`);
      continue;
    }
    for (const r of external) {
      if (!entry.roles.includes(r)) {
        missing.push(`${g.name}/${g.argCount} -> "${r}" que a allowlist não aprova`);
      }
    }
  }
  return missing;
}

/**
 * Visão de UMA migration para `grantsWithoutAtomicPublicRevoke`: o que ela
 * concede (via `grantsInSql`, sem varredura própria) e o que ela revoga de
 * PUBLIC nela mesma. `revokedFromPublic` só existe para amarrar revoke e
 * grant ao MESMO arquivo — não é um índice global do histórico.
 */
interface FileAcl {
  file: string;
  grants: GrantStmt[];
  revokedFromPublic: Set<string>;
}

function aclOf(file: string): FileAcl {
  const sql = readMigration(file);
  const revokedFromPublic = new Set<string>();
  for (const m of sql.matchAll(REVOKE_PUBLIC_RE)) {
    const targets = m[3].split(",").map((t) => t.trim().toLowerCase());
    if (targets.includes("public")) revokedFromPublic.add(key(m[1], splitArgs(m[2]).length));
  }
  return { file, grants: grantsInSql(sql, file), revokedFromPublic };
}

/**
 * O predicado central de "revogada de PUBLIC antes de ser concedida": para
 * cada entrada da allowlist, TODA migration do pool que concede aquela
 * assinatura a anon/authenticated precisa revogar de PUBLIC NELA MESMA — não
 * em qualquer outra migration do histórico que contenha um revoke com
 * nome+aridade coincidentes.
 *
 * A amarração ao MESMO arquivo é o que a asserção mede, não detalhe de
 * implementação: sem ela, uma migration de hardening genérica que revoga
 * várias funções de uma vez (é o caso real de
 * 20260817212500_harden_advisor_function_warnings.sql neste repo) "cobriria"
 * qualquer função futura que nunca revogou de PUBLIC na própria migration que
 * a concedeu — entre o deploy de uma e o da outra, a função fica executável
 * por PUBLIC em produção. É o defeito D1 que este predicado existe para
 * pegar; um revoke solto em qualquer arquivo do pool mediria uma propriedade
 * mais fraca do que essa.
 *
 * Assinatura concedida em MAIS de um arquivo do pool exige revoke em CADA um
 * — conceder de novo sem revogar de novo é o mesmo defeito, só que na
 * segunda migration em vez da primeira.
 *
 * Extraída como função pura pelo mesmo motivo de `unclassifiedHotfixGrants`
 * acima: provar a correlação (grant num arquivo, revoke só no outro) contra
 * dados SINTÉTICOS é o que distingue esta exigência de uma que aceitaria
 * revoke solto em qualquer lugar do pool.
 */
function grantsWithoutAtomicPublicRevoke(entries: AllowEntry[], files: FileAcl[]): string[] {
  const missing: string[] = [];
  for (const e of entries) {
    const k = key(e.name, splitArgs(e.args).length);
    const grantingFiles = files.filter((f) =>
      f.grants.some(
        (g) => key(g.name, g.argCount) === k && (g.roles.includes("anon") || g.roles.includes("authenticated")),
      ),
    );
    if (grantingFiles.length === 0) {
      missing.push(`${e.name}(${e.args}): nenhuma migration do pool concede a anon/authenticated`);
      continue;
    }
    for (const f of grantingFiles) {
      if (!f.revokedFromPublic.has(k)) {
        missing.push(`${e.name}(${e.args}) concedida em ${f.file} sem "revoke ... from public" na MESMA migration`);
      }
    }
  }
  return missing;
}

describe("allowlist de ACL de funções", () => {
  it("está bem formada", () => {
    const seen = new Set<string>();
    for (const e of allEntries) {
      expect(e.name, "toda entrada precisa de name").toBeTruthy();
      expect(typeof e.args, "toda entrada precisa de args (pode ser string vazia)").toBe("string");
      expect(e.roles.length, `${e.name}: roles não pode ser vazio`).toBeGreaterThan(0);
      expect(e.why?.trim(), `${e.name}: justificativa obrigatória`).toBeTruthy();
      for (const r of e.roles) {
        expect(["anon", "authenticated"], `${e.name}: papel inesperado "${r}"`).toContain(r);
      }
      const k = `${e.name}(${e.args})`;
      expect(seen.has(k), `entrada duplicada: ${k}`).toBe(false);
      seen.add(k);
    }
  });

  it("nunca aprova o pseudo-papel PUBLIC", () => {
    // PUBLIC alcança todo papel presente e futuro. A allowlist concede a papéis
    // nomeados, sempre.
    for (const e of allEntries) {
      expect(e.roles, `${e.name}: PUBLIC não pode entrar na allowlist`).not.toContain("public");
    }
  });
});

/**
 * ─── "Todas as entradas" quer dizer a MESMA coisa nas duas peças ────────────
 *
 * Este arquivo e scripts/audit-function-acl.ts são as duas metades de um
 * guardrail só: o script cruza a allowlist com o ACL real do banco, este
 * arquivo confere a coerência interna da allowlist e das migrations sem banco.
 * Se eles discordarem sobre QUAIS grupos do JSON contam como entrada, um grupo
 * novo é somado por um e ignorado pelo outro — em silêncio, que é o modo de
 * falha que este projeto já pagou várias vezes por acoplamento só-por-string.
 *
 * POR QUE NÃO COMPARTILHAR O CÓDIGO LITERALMENTE, que seria o certo: o script é
 * Deno e importa `https://esm.sh/@supabase/supabase-js@2`. Importá-lo do vitest
 * quebra a resolução de tipos com TS2307 na URL remota — já custou uma rodada
 * de correção nesta frente. Então a derivação é INDEPENDENTE (a função
 * `arrayGroupNamesIn` acima) e a equivalência é AFIRMADA aqui: o último caso
 * deste describe lê o texto do script e exige que a linha do filtro continue
 * literalmente a mesma. Mexer em um lado sem o outro reprova, que é o serviço
 * que a importação prestaria.
 */
describe("os grupos da allowlist são derivados, não escritos à mão", () => {
  /** A linha exata do filtro em scripts/audit-function-acl.ts:104. */
  const FILTRO_DO_SCRIPT = 'if (group.startsWith("_") || !Array.isArray(value)) continue;';

  /** A constante que ESTAVA escrita à mão aqui — usada só como controle. */
  const HARDCODED_ANTIGO = ["public_anon", "rls_helpers", "authenticated_tenant"];

  it("a lista derivada não é vazia e cobre os três grupos de hoje", () => {
    // Sem esta asserção, um bug na derivação que devolvesse [] deixaria TODO
    // este arquivo passando sobre zero entradas — verde e vazio.
    expect(GROUPS.length).toBeGreaterThan(0);
    for (const g of HARDCODED_ANTIGO) {
      expect(GROUPS, `grupo "${g}" desapareceu da derivação`).toContain(g);
    }
    expect(allEntries.length, "allEntries não pode ser vazio").toBeGreaterThan(0);
  });

  it("nenhuma chave de array sem prefixo `_` fica fora — e nenhuma com prefixo entra", () => {
    for (const [name, value] of Object.entries(allowlist)) {
      if (!Array.isArray(value)) {
        expect(GROUPS, `"${name}" não é array e não devia ser grupo`).not.toContain(name);
        continue;
      }
      if (name.startsWith("_")) {
        expect(GROUPS, `"${name}" tem prefixo _ e é prosa, não entrada`).not.toContain(name);
      } else {
        expect(GROUPS, `"${name}" é array de entrada e ficou fora da derivação`).toContain(name);
      }
    }
  });

  it("o filtro de prefixo está VIVO: `_doc` e `_doc_rls_helpers` são arrays de verdade e ficam fora", () => {
    // Se fossem objetos, o `!Array.isArray` sozinho já os excluiria e o teste
    // acima não provaria nada sobre o prefixo. São arrays — então é o prefixo
    // que os exclui, e é isso que este caso fixa.
    expect(Array.isArray(allowlist["_doc"]), "_doc precisa ser array para este controle valer").toBe(true);
    expect(Array.isArray(allowlist["_doc_rls_helpers"])).toBe(true);
    expect(GROUPS).not.toContain("_doc");
    expect(GROUPS).not.toContain("_doc_rls_helpers");
  });

  it(
    "CONTROLE POSITIVO: grupo novo é somado pela derivação e ERA invisível para a " +
      "constante escrita à mão — a divergência que este item fecha",
    () => {
      const grupoNovo: AllowEntry[] = [
        { name: "oraculo_novo", args: "p_x uuid", roles: ["anon"], why: "sintético" },
      ];
      const sabotada = { ...allowlist, grupo_futuro: grupoNovo } as Record<string, unknown>;

      // Derivado: vê o grupo novo e a entrada dele.
      expect(arrayGroupNamesIn(sabotada)).toContain("grupo_futuro");
      expect(allEntriesIn(sabotada).some((e) => e.name === "oraculo_novo")).toBe(true);

      // Escrito à mão: cego. É o defeito, demonstrado e não descrito.
      const comHardcoded = HARDCODED_ANTIGO.flatMap((g) => entriesOfIn(sabotada, g));
      expect(
        comHardcoded.some((e) => e.name === "oraculo_novo"),
        "a lista escrita à mão não enxerga grupo novo — por isso ela saiu",
      ).toBe(false);
    },
  );

  it("o filtro de grupos do audit-function-acl.ts continua literalmente o mesmo", () => {
    const script = readFileSync(AUDIT_SCRIPT_PATH, "utf8");
    expect(
      script.includes(FILTRO_DO_SCRIPT),
      "scripts/audit-function-acl.ts mudou o critério de quais grupos da allowlist contam.\n" +
        `Esperado encontrar a linha: ${FILTRO_DO_SCRIPT}\n` +
        "Atualize `arrayGroupNamesIn` neste arquivo NO MESMO commit — as duas peças do " +
        "guardrail precisam somar as mesmas entradas, e não há como compartilhar o código " +
        "(o script é Deno com import de esm.sh; importá-lo daqui dá TS2307).",
    ).toBe(true);
  });
});

/** Migrations com versão estritamente posterior à 085 — usada tanto para
 * achar assinaturas dropadas depois da 085 quanto para o describe seguinte. */
const posterioresFiles = migrationFiles().filter((f) => versionOf(f) > HOTFIX_VERSION);

describe("migration 085 vs allowlist", () => {
  const file = migrationFiles().find((f) => versionOf(f) === HOTFIX_VERSION);

  it("a migration do hotfix existe", () => {
    expect(file, `nenhuma migration com versão ${HOTFIX_VERSION}`).toBeTruthy();
  });

  it("todo grant a anon/authenticated tem entrada na allowlist, exceto assinatura dropada depois", () => {
    const droppedLater = droppedKeysIn(posterioresFiles);
    const missing = unclassifiedHotfixGrants(grantsIn(file!), allowByKey, droppedLater);
    expect(
      missing,
      "085 concede assinatura sem entrada na allowlist (e nenhuma migration posterior dropou):\n" +
        missing.join("\n"),
    ).toEqual([]);
  });

  // Os quatro casos abaixo provam a exceção em si, contra dados SINTÉTICOS —
  // não dependem de nenhuma migration real continuar (ou deixar de) dropar
  // algo. Sem eles, "o teste acima passou" não distingue a exceção
  // funcionando da exceção tendo engolido o checador inteiro.
  describe("a exceção de assinatura dropada depois da 085 (unclassifiedHotfixGrants)", () => {
    it("assinatura concedida e NUNCA dropada depois continua exigindo entrada — a propriedade original", () => {
      const grants: GrantStmt[] = [
        { file: "fake", name: "nunca_dropada", argCount: 1, roles: ["authenticated"] },
      ];
      const missing = unclassifiedHotfixGrants(grants, new Map(), new Set());
      expect(missing).toEqual(["nunca_dropada/1 sem entrada na allowlist"]);
    });

    it("drop numa aridade DIFERENTE não isenta a aridade que a 085 concedeu", () => {
      const grants: GrantStmt[] = [
        { file: "fake", name: "minha_funcao", argCount: 2, roles: ["authenticated"] },
      ];
      // Só a forma de 1 argumento foi dropada — a de 2 continua precisando de
      // entrada. É exatamente o caso desta task: a 107 dropa os overloads de
      // 1 argumento e NÃO toca nos de 2.
      const droppedLater = dropsInSql("drop function if exists public.minha_funcao(p_x uuid);");
      const droppedKeys = new Set(droppedLater.map((d) => key(d.name, d.argCount)));
      const missing = unclassifiedHotfixGrants(grants, new Map(), droppedKeys);
      expect(missing).toEqual(["minha_funcao/2 sem entrada na allowlist"]);
    });

    it("drop na MESMA aridade isenta a assinatura — o caso que a exceção existe para cobrir", () => {
      const grants: GrantStmt[] = [
        { file: "fake", name: "minha_funcao", argCount: 1, roles: ["authenticated"] },
      ];
      const droppedLater = dropsInSql("drop function if exists public.minha_funcao(p_x uuid);");
      const droppedKeys = new Set(droppedLater.map((d) => key(d.name, d.argCount)));
      const missing = unclassifiedHotfixGrants(grants, new Map(), droppedKeys);
      expect(missing).toEqual([]);
    });

    it("drop function dentro de comentário não isenta nada — o matching passa por stripComments", () => {
      // Mesma composição que dropsIn(file) usa de verdade: stripComments
      // primeiro, dropsInSql depois. Uma linha comentada não deve nem chegar
      // no regex.
      const raw =
        "-- drop function if exists public.minha_funcao(p_x uuid); (exemplo em bloco de rollback)\nselect 1;";
      const dropped = dropsInSql(stripComments(raw));
      expect(dropped).toEqual([]);
    });
  });

  it("toda função pública allowlisted é revogada de PUBLIC antes de ser concedida", () => {
    // Sem o revoke, o grant implícito do CREATE FUNCTION ao pseudo-papel PUBLIC
    // sobrevive e a função fica executável por todo papel. Foi exatamente o
    // defeito D1 encontrado no ensaio.
    //
    // "Antes de ser concedida" é atomicidade, não só presença: o revoke tem de
    // estar NA MESMA migration que concede a anon/authenticated — ver o
    // comentário de `grantsWithoutAtomicPublicRevoke` para o porquê de a busca
    // não poder se limitar à 085 nem aceitar revoke solto em qualquer arquivo
    // do pool. `posterioresFiles` é a MESMA lista usada acima para achar
    // assinatura dropada depois da 085 — uma lista só, para as duas não
    // poderem divergir entre si.
    const files = [file!, ...posterioresFiles].map(aclOf);
    const missing = grantsWithoutAtomicPublicRevoke(entriesOf("public_anon"), files);
    expect(
      missing,
      "Entrada de public_anon sem revoke-from-public atômico na migration que concede:\n" + missing.join("\n"),
    ).toEqual([]);
  });

  // Prova a atomicidade em si, contra dados SINTÉTICOS — sem eles, "o it acima
  // passou" não distingue exigir revoke NA MESMA migration de aceitar revoke
  // solto em qualquer arquivo do pool (a versão mais fraca que esta substitui).
  describe("grantsWithoutAtomicPublicRevoke — controle positivo", () => {
    it("revoke existe no histórico, mas NÃO na migration que concede — reprova nomeando a assinatura", () => {
      const entries: AllowEntry[] = [{ name: "foo", args: "p_x uuid", roles: ["anon"], why: "sintético" }];
      const files: FileAcl[] = [
        {
          file: "A",
          grants: [{ file: "A", name: "foo", argCount: 1, roles: ["anon"] }],
          revokedFromPublic: new Set(),
        },
        { file: "B", grants: [], revokedFromPublic: new Set(["foo/1"]) },
      ];
      const missing = grantsWithoutAtomicPublicRevoke(entries, files);
      expect(missing).toEqual([`foo(p_x uuid) concedida em A sem "revoke ... from public" na MESMA migration`]);
    });

    it("revoke NA MESMA migration que concede não reprova — o caso positivo", () => {
      const entries: AllowEntry[] = [{ name: "foo", args: "p_x uuid", roles: ["anon"], why: "sintético" }];
      const files: FileAcl[] = [
        {
          file: "A",
          grants: [{ file: "A", name: "foo", argCount: 1, roles: ["anon"] }],
          revokedFromPublic: new Set(["foo/1"]),
        },
      ];
      expect(grantsWithoutAtomicPublicRevoke(entries, files)).toEqual([]);
    });

    it("concedida em DOIS arquivos exige revoke em CADA um — conceder de novo sem revogar de novo é o mesmo defeito", () => {
      const entries: AllowEntry[] = [{ name: "foo", args: "p_x uuid", roles: ["anon"], why: "sintético" }];
      const files: FileAcl[] = [
        {
          file: "A",
          grants: [{ file: "A", name: "foo", argCount: 1, roles: ["anon"] }],
          revokedFromPublic: new Set(["foo/1"]),
        },
        {
          file: "B",
          grants: [{ file: "B", name: "foo", argCount: 1, roles: ["authenticated"] }],
          revokedFromPublic: new Set(),
        },
      ];
      const missing = grantsWithoutAtomicPublicRevoke(entries, files);
      expect(missing).toEqual([`foo(p_x uuid) concedida em B sem "revoke ... from public" na MESMA migration`]);
    });
  });

  it("não concede EXECUTE ao schema inteiro", () => {
    expect(BROAD_GRANT_RE.test(readMigration(file!))).toBe(false);
  });
});

describe("migrations posteriores ao hotfix não reabrem a superfície", () => {
  // Mesma lista que droppedKeysIn(posterioresFiles) usa acima — uma lista só,
  // não duas que podem divergir.
  const posteriores = posterioresFiles;

  it("todo grant novo a anon/authenticated/PUBLIC está classificado", () => {
    const naoClassificados: string[] = [];
    for (const f of posteriores) {
      for (const g of grantsIn(f)) {
        const external = g.roles.filter((r) => EXTERNAL_ROLES.includes(r));
        if (external.length === 0) continue;
        if (external.includes("public")) {
          naoClassificados.push(`${f}: ${g.name}/${g.argCount} concedida ao pseudo-papel PUBLIC`);
          continue;
        }
        const entry = allowByKey.get(key(g.name, g.argCount));
        if (!entry) {
          naoClassificados.push(`${f}: ${g.name}/${g.argCount} → [${external.join(", ")}] sem entrada na allowlist`);
          continue;
        }
        for (const r of external) {
          if (!entry.roles.includes(r)) {
            naoClassificados.push(`${f}: ${g.name}/${g.argCount} → "${r}" além do que a allowlist aprova`);
          }
        }
      }
    }
    expect(
      naoClassificados,
      "Classifique em docs/hotfix-acl/01-INVENTARIO-E-CLASSIFICACAO.md e acrescente à allowlist COM justificativa.\n" +
        naoClassificados.join("\n"),
    ).toEqual([]);
  });

  it("nenhuma concede EXECUTE ao schema inteiro", () => {
    for (const f of posteriores) {
      expect(BROAD_GRANT_RE.test(readMigration(f)), `${f} concede EXECUTE ao schema inteiro`).toBe(false);
    }
  });
});

/**
 * Prova a correção do `FN_ARGS` e fixa as duas lacunas que continuam abertas.
 * Cada caso compara contra o padrão ANTIGO escrito aqui à mão: sem isso,
 * "o padrão novo casa" não distingue uma correção de um padrão que sempre casou
 * e nunca teve defeito nenhum.
 */
describe("FN_ARGS — tipo com parênteses não é mais invisível ao GRANT_RE", () => {
  /** O `([^)]*)` que estava no lugar do `FN_ARGS`, só como controle. */
  const ARGS_ANTIGO = String.raw`([^)]*)`;
  const GRANT_RE_ANTIGO = new RegExp(
    String.raw`grant\s+execute\s+on\s+function\s+(?:public\.)?([a-z0-9_]+)\s*\(` +
      ARGS_ANTIGO +
      String.raw`\)\s*to\s+([^;]+);`,
    "gi",
  );

  it(
    "CONTROLE POSITIVO: grant a anon numa função com tipo de precisão era INVISÍVEL " +
      "(falha ABERTA) e agora produz exigência de classificação",
    () => {
      const sql = "grant execute on function public.oraculo(numeric(10,2)) to anon;";

      // O defeito, demonstrado: o padrão antigo não vê este grant.
      expect(
        [...sql.matchAll(GRANT_RE_ANTIGO)],
        "o padrão antigo não casava — grant a anon passava sem exigir nada",
      ).toEqual([]);

      // A correção, ponta a ponta: do texto SQL até a exigência.
      const grants = grantsInSql(sql, "fake.sql");
      expect(grants).toEqual([
        { file: "fake.sql", name: "oraculo", argCount: 1, roles: ["anon"] },
      ]);
      const missing = unclassifiedHotfixGrants(grants, new Map(), new Set());
      expect(missing).toEqual(["oraculo/1 sem entrada na allowlist"]);
    },
  );

  it("a vírgula DENTRO dos parênteses não infla a aridade — `numeric(10,2)` é 1 argumento", () => {
    // `splitArgs` conta profundidade; se contasse vírgulas cruas, a chave viraria
    // `oraculo/2` e nunca casaria a entrada certa da allowlist.
    expect(splitArgs("numeric(10,2)")).toEqual(["numeric(10,2)"]);
    expect(splitArgs("uuid, numeric(10,2), text")).toEqual(["uuid", "numeric(10,2)", "text"]);
  });

  it("`varchar(255)` também era invisível; e `numeric[]`, que já casava, continua casando igual", () => {
    const comPrecisao = "grant execute on function public.f(varchar(255)) to authenticated;";
    expect([...comPrecisao.matchAll(GRANT_RE_ANTIGO)]).toEqual([]);
    expect(grantsInSql(comPrecisao, "fake.sql").map((g) => g.argCount)).toEqual([1]);

    const comArray = "grant execute on function public.f(numeric[]) to anon;";
    expect([...comArray.matchAll(GRANT_RE_ANTIGO)].length).toBe(1);
    expect(grantsInSql(comArray, "fake.sql")).toEqual([
      { file: "fake.sql", name: "f", argCount: 1, roles: ["anon"] },
    ]);
  });

  it("REVOKE_PUBLIC_RE e DROP_RE ganharam a mesma correção — os três padrões usam FN_ARGS", () => {
    const revoked = new Set<string>();
    for (const m of "revoke all on function public.f(numeric(10,2)) from public;".matchAll(
      REVOKE_PUBLIC_RE,
    )) {
      const targets = m[3].split(",").map((t) => t.trim().toLowerCase());
      if (targets.includes("public")) revoked.add(key(m[1], splitArgs(m[2]).length));
    }
    expect([...revoked]).toEqual(["f/1"]);

    expect(dropsInSql("drop function if exists public.f(numeric(10,2));")).toEqual([
      { name: "f", argCount: 1 },
    ]);
  });

  it(
    "LACUNA CONHECIDA, fixada por escrito: comentário de BLOCO não é removido, então um " +
      "`drop function` dentro dele concede isenção de VERDADE",
    () => {
      // `stripComments` só conhece `--`. Este caso descreve o comportamento
      // ATUAL, não o desejado: se alguém ensinar stripComments a remover
      // comentário de bloco, ele reprova — e aí a correção é trocar a
      // expectativa para `[]` e apagar este parágrafo, não relaxar o teste.
      const raw = "/*\ndrop function if exists public.minha_funcao(p_x uuid);\n*/\nselect 1;";
      expect(dropsInSql(stripComments(raw))).toEqual([{ name: "minha_funcao", argCount: 1 }]);
    },
  );

  it(
    "LACUNA CONHECIDA, fixada por escrito: grant em schema que não é `public` é invisível " +
      "ao GRANT_RE — o escopo deste checador é `public`",
    () => {
      // Não é descuido: `audit_function_acl()` varre só `public`, e o que
      // protege `app_private` são os dois describes do fim deste arquivo (revoke
      // de PUBLIC na criação, e nenhum privilégio de schema a papel público).
      // Se algum dia o escopo crescer, este caso reprova e obriga a decidir.
      expect(
        grantsInSql("grant execute on function app_private.f(uuid) to anon;", "fake.sql"),
      ).toEqual([]);
    },
  );
});

/**
 * O bloco `_expected_advisor` existe para que "23 warnings" seja número
 * conferível e não memória. Esta camada confere a consistência interna sem
 * banco; quem compara com o ACL real é a regra 6 do audit-function-acl.ts
 * (núcleo puro em scripts/advisor-divergence-core.ts, testado à parte porque
 * este arquivo não tem acesso ao banco em CI).
 *
 * CORREÇÃO SOBRE O TEXTO ORIGINAL DO PLANO (Ruling 4/22 do progress.md): a
 * regra do brief — `advisor_lints.includes("0028") === roles.includes("anon")`
 * — REPROVA dado correto. Os lints 0028/0029 do Security Advisor só disparam
 * para função SECURITY DEFINER; duas entradas (`normalize_br_phone`,
 * `search_reservations`) são SECURITY INVOKER, concedem a anon/authenticated
 * e não produzem NENHUMA linha de advisor. A regra certa cruza `roles` com
 * `security_definer`.
 */
function advisorLintsCoherent(entry: AdvisorEntry): boolean {
  const expects0028 = entry.roles.includes("anon") && entry.security_definer === true;
  const expects0029 = entry.roles.includes("authenticated") && entry.security_definer === true;
  return (
    entry.advisor_lints.includes("0028") === expects0028 &&
    entry.advisor_lints.includes("0029") === expects0029
  );
}

/** Soma quantas entradas declaram cada lint — o que o script real também faz
 * contra o ACL do banco, mas aqui é só a allowlist somando a si mesma. */
function sumAdvisorLints(entries: AdvisorEntry[]): ExpectedAdvisorCounts {
  let n0028 = 0;
  let n0029 = 0;
  for (const e of entries) {
    if (e.advisor_lints.includes("0028")) n0028++;
    if (e.advisor_lints.includes("0029")) n0029++;
  }
  return { "0028": n0028, "0029": n0029, total: n0028 + n0029 };
}

describe("_expected_advisor", () => {
  const expected = (allowlist as Record<string, unknown>)["_expected_advisor"] as
    | ExpectedAdvisorCounts
    | undefined;
  const advisorEntries = allEntries as AdvisorEntry[];

  it("existe e soma", () => {
    expect(expected, "_expected_advisor ausente na allowlist").toBeDefined();
    expect(expected!.total).toBe(expected!["0028"] + expected!["0029"]);
  });

  it("toda entrada declara security_definer e advisor_lints coerentes com seus papéis", () => {
    for (const entry of advisorEntries) {
      expect(entry.advisor_lints, `${entry.name}(${entry.args}) sem advisor_lints`).toBeDefined();
      expect(
        typeof entry.security_definer,
        `${entry.name}(${entry.args}) sem security_definer`,
      ).toBe("boolean");
      expect(
        advisorLintsCoherent(entry),
        `${entry.name}(${entry.args}): advisor_lints=[${entry.advisor_lints}] incoerente com ` +
          `roles=[${entry.roles}] e security_definer=${entry.security_definer}`,
      ).toBe(true);
    }
  });

  it("os totais somados das entradas batem com o bloco _expected_advisor (nenhum dos dois drifta sozinho)", () => {
    const summed = sumAdvisorLints(advisorEntries);
    // `expected` carrega um `_doc` de prosa que sumAdvisorLints não produz —
    // comparar campo a campo, não com toEqual do objeto inteiro.
    expect(summed["0028"]).toBe(expected!["0028"]);
    expect(summed["0029"]).toBe(expected!["0029"]);
    expect(summed.total).toBe(expected!.total);
  });

  // Os quatro casos abaixo são o controle positivo real do plano (Ruling 22):
  // provam a regra contra as DUAS entradas SECURITY INVOKER de verdade da
  // allowlist, não contra um literal desconectado dela, e contra sabotagem
  // sintética que a regra tem que pegar.
  describe("advisorLintsCoherent — controle positivo", () => {
    it("SECURITY DEFINER com anon: [\"0028\",\"0029\"] é coerente", () => {
      const entry: AdvisorEntry = {
        name: "get_unit_public",
        args: "p_slug text",
        roles: ["anon", "authenticated"],
        why: "sintético",
        security_definer: true,
        advisor_lints: ["0028", "0029"],
      };
      expect(advisorLintsCoherent(entry)).toBe(true);
    });

    it(
      "CONTROLE POSITIVO real: normalize_br_phone (anon, SECURITY INVOKER) com " +
        "advisor_lints=[] é coerente — é a exceção que o plano original não previa",
      () => {
        const real = advisorEntries.find((e) => e.name === "normalize_br_phone");
        expect(real, "normalize_br_phone precisa existir em public_anon").toBeDefined();
        expect(real!.security_definer).toBe(false);
        expect(advisorLintsCoherent(real!)).toBe(true);
      },
    );

    it(
      "CONTROLE POSITIVO real: search_reservations (authenticated, SECURITY INVOKER) " +
        "com advisor_lints=[] é coerente — a segunda exceção",
      () => {
        const real = advisorEntries.find((e) => e.name === "search_reservations");
        expect(real, "search_reservations precisa existir em authenticated_tenant").toBeDefined();
        expect(real!.security_definer).toBe(false);
        expect(advisorLintsCoherent(real!)).toBe(true);
      },
    );

    it(
      "CONTROLE POSITIVO — sabotagem: aplicar a regra ERRADA do brief " +
        "(advisor_lints == roles.includes('anon'), ignorando security_definer) " +
        "à entrada real de normalize_br_phone reprovaria dado correto",
      () => {
        const real = advisorEntries.find((e) => e.name === "normalize_br_phone")!;
        // Regra do brief, tal como escrita — sem cruzar com security_definer.
        const regraDoBriefOriginal = real.advisor_lints.includes("0028") === real.roles.includes("anon");
        expect(
          regraDoBriefOriginal,
          "a regra do brief (sem security_definer) reprova normalize_br_phone, que é dado CORRETO",
        ).toBe(false);
        // A regra corrigida, sobre o mesmo dado, aprova.
        expect(advisorLintsCoherent(real)).toBe(true);
      },
    );

    it("CONTROLE POSITIVO — sabotagem: entrada INVOKER que declara 0028 mentindo é rejeitada", () => {
      const sabotada: AdvisorEntry = {
        name: "normalize_br_phone",
        args: "raw text",
        roles: ["anon", "authenticated"],
        why: "sintético — sabotado de propósito",
        security_definer: false,
        advisor_lints: ["0028", "0029"], // mentira: invoker não produz linha de advisor
      };
      expect(advisorLintsCoherent(sabotada)).toBe(false);
    });

    it("CONTROLE POSITIVO — sabotagem: entrada DEFINER que omite 0029 apesar de conceder a authenticated é rejeitada", () => {
      const sabotada: AdvisorEntry = {
        name: "get_customer_stats",
        args: "p_customer_id uuid, p_unit_id uuid",
        roles: ["authenticated"],
        why: "sintético — sabotado de propósito",
        security_definer: true,
        advisor_lints: [], // devia declarar 0029
      };
      expect(advisorLintsCoherent(sabotada)).toBe(false);
    });
  });

  // Controle positivo da regra de soma. A versão anterior deste caso comparava
  // os dados reais contra um literal ["0028":1,"0029":1,total:2] desconectado
  // — passa esteja a lógica de soma certa ou quebrada, é a mesma vacuidade que
  // o "controle negativo" original do brief tinha (ver Correction 1). A
  // reprovação aqui precisa vir do MESMO comparador da asserção substantiva
  // acima (`sumAdvisorLints`), alimentado por um input GENUINAMENTE sabotado
  // — uma entrada real removida — não por um número inventado.
  it(
    "CONTROLE POSITIVO — sabotagem: remover uma entrada real muda o total que sumAdvisorLints " +
      "produz (mesmo comparador da asserção substantiva acima, não um literal desconectado)",
    () => {
      const semAnonymizeCustomer = advisorEntries.filter((e) => e.name !== "anonymize_customer");
      expect(
        semAnonymizeCustomer.length,
        "o controle depende de anonymize_customer existir na allowlist",
      ).toBe(advisorEntries.length - 1);

      const summedSabotado = sumAdvisorLints(semAnonymizeCustomer);
      // anonymize_customer é SECURITY DEFINER + authenticated: só declara 0029.
      // Removê-la tem que derrubar 0029 e o total em exatamente 1 — não só
      // "diferente", para o controle não passar por acidente com a conta errada.
      expect(summedSabotado["0028"]).toBe(expected!["0028"]);
      expect(summedSabotado["0029"]).toBe(expected!["0029"] - 1);
      expect(summedSabotado.total).toBe(expected!.total - 1);
    },
  );
});

/**
 * Ruling 17 do progress.md: a migration 106 criou o schema `app_private`
 * precisamente para ser inalcançável por PostgREST — mas `CREATE FUNCTION`
 * concede EXECUTE a PUBLIC por padrão (mesmo defeito que a 085 fechou em
 * `public`, e `alter default privileges ... revoke ... from public` é no-op
 * medido nesta plataforma, ver CLAUDE.md). `audit_function_acl()` varre só
 * `public`, então uma função nova em `app_private` sem revoke explícito não
 * seria pega por NENHUM guardrail de banco. Este describe é o guardrail
 * estático equivalente ao "toda função pública allowlisted é revogada de
 * PUBLIC" de cima, mas para `app_private` — reusa a mesma máquina de parsing
 * de migration (stripComments, GRANT_RE-equivalente) em vez de escrever um
 * segundo parser.
 */
const APP_PRIVATE_CREATE_RE =
  /create\s+(?:or\s+replace\s+)?function\s+app_private\.([a-z0-9_]+)\s*\(([^)]*)\)/gi;
const APP_PRIVATE_REVOKE_PUBLIC_RE =
  /revoke\s+all[^;]*?\son\s+function\s+app_private\.([a-z0-9_]+)\s*\(([^)]*)\)\s*from\s+([^;]+);/gi;

interface AppPrivateFunction {
  file: string;
  name: string;
  argCount: number;
}

function appPrivateFunctionsCreatedIn(sql: string, file: string): AppPrivateFunction[] {
  const out: AppPrivateFunction[] = [];
  for (const m of sql.matchAll(APP_PRIVATE_CREATE_RE)) {
    out.push({ file, name: m[1], argCount: splitArgs(m[2]).length });
  }
  return out;
}

function appPrivateRevokedFromPublicIn(sql: string): Set<string> {
  const out = new Set<string>();
  for (const m of sql.matchAll(APP_PRIVATE_REVOKE_PUBLIC_RE)) {
    const targets = m[3].split(",").map((t) => t.trim().toLowerCase());
    if (targets.includes("public")) out.add(key(m[1], splitArgs(m[2]).length));
  }
  return out;
}

/**
 * O predicado central: toda função CRIADA em `app_private` por uma migration
 * precisa de um `revoke all ... from public` explícito NA MESMA migration.
 * Extraída como função pura pelo mesmo motivo de `unclassifiedHotfixGrants`
 * acima — provar as duas pontas (função revogada passa; função não revogada
 * reprova nomeando-a) contra dados sintéticos, não só contra o estado atual
 * do repositório.
 */
function appPrivateFunctionsWithoutPublicRevoke(
  created: AppPrivateFunction[],
  revokedFromPublic: Set<string>,
): string[] {
  const missing: string[] = [];
  for (const fn of created) {
    const k = key(fn.name, fn.argCount);
    if (!revokedFromPublic.has(k)) {
      missing.push(`${fn.file}: app_private.${fn.name}/${fn.argCount} sem "revoke all ... from public"`);
    }
  }
  return missing;
}

describe("função nova em app_private revoga de PUBLIC (Ruling 17)", () => {
  it("controle positivo: função sintética SEM revoke reprova, nomeando-a", () => {
    const created = appPrivateFunctionsCreatedIn(
      "create function app_private.oraculo(p_x uuid) returns boolean language sql as $$ select true $$;",
      "fake.sql",
    );
    const missing = appPrivateFunctionsWithoutPublicRevoke(created, new Set());
    expect(missing).toEqual(["fake.sql: app_private.oraculo/1 sem \"revoke all ... from public\""]);
  });

  it("controle positivo: função sintética COM revoke não reprova", () => {
    const sql =
      "create function app_private.oraculo(p_x uuid) returns boolean language sql as $$ select true $$;\n" +
      "revoke all on function app_private.oraculo(uuid) from public;";
    const created = appPrivateFunctionsCreatedIn(sql, "fake.sql");
    const revoked = appPrivateRevokedFromPublicIn(sql);
    const missing = appPrivateFunctionsWithoutPublicRevoke(created, revoked);
    expect(missing).toEqual([]);
  });

  it("revoke de outra função (nome ou aridade diferente) não cobre a que falta", () => {
    const created = appPrivateFunctionsCreatedIn(
      "create function app_private.oraculo(p_x uuid, p_y uuid) returns boolean language sql as $$ select true $$;",
      "fake.sql",
    );
    const revoked = appPrivateRevokedFromPublicIn(
      "revoke all on function app_private.oraculo(uuid) from public;", // aridade 1, a criada é 2
    );
    const missing = appPrivateFunctionsWithoutPublicRevoke(created, revoked);
    expect(missing).toEqual(["fake.sql: app_private.oraculo/2 sem \"revoke all ... from public\""]);
  });

  it("drop function dentro de comentário não conta como create — mesma disciplina de stripComments", () => {
    const raw =
      "-- create function app_private.oraculo(p_x uuid) returns boolean language sql as $$ select true $$;\nselect 1;";
    const created = appPrivateFunctionsCreatedIn(stripComments(raw), "fake.sql");
    expect(created).toEqual([]);
  });

  it("toda função criada em app_private pelas migrations reais do repositório é revogada de PUBLIC", () => {
    const missing: string[] = [];
    for (const f of migrationFiles()) {
      const sql = readMigration(f);
      const created = appPrivateFunctionsCreatedIn(sql, f);
      if (created.length === 0) continue;
      const revoked = appPrivateRevokedFromPublicIn(sql);
      missing.push(...appPrivateFunctionsWithoutPublicRevoke(created, revoked));
    }
    expect(
      missing,
      "Função nova em app_private sem revoke de PUBLIC — app_private existe pra ser " +
        "inalcançável, e CREATE FUNCTION concede a PUBLIC por padrão:\n" + missing.join("\n"),
    ).toEqual([]);
  });
});

/**
 * Versão da 106 — a migration que tirou os três helpers de RLS de `public`.
 *
 * O corte dos dois describes abaixo é INCLUSIVO (`>=`), um grau mais estrito do
 * que "posterior à 106": a própria 106 não cria nenhum dos três em `public`
 * (ela usa `alter function ... set schema`) e o único `grant ... on schema
 * app_private` dela é para `service_role`, que é permitido. Incluí-la é de
 * graça, e cobre o caso de alguém EDITAR a 106 já aplicada em vez de escrever
 * migration nova — que é drift de `schema_migrations`, mas não deixa de ser um
 * jeito de reabrir o oráculo.
 */
const PRIVATE_HELPERS_VERSION = "20260910120000";

/** Migrations da 106 em diante — inclusive. Ver `PRIVATE_HELPERS_VERSION`. */
const desde106Files = migrationFiles().filter((f) => versionOf(f) >= PRIVATE_HELPERS_VERSION);

const RLS_HELPER_NAMES = ["is_unit_member", "is_platform_admin", "is_org_member"] as const;

/**
 * `create [or replace] function [<schema>.]is_unit_member(` e as duas irmãs,
 * em todas as grafias que ocorrem de verdade neste repositório e nas que
 * ocorreriam:
 *  • COM e SEM o qualificador `public.` — sem qualificador a função nasce em
 *    `public` pelo search_path default, então as duas formas são o MESMO
 *    defeito e o guardrail não pode pedir que o autor escreva `public.`;
 *  • com quebra de linha entre `function`, o nome e a lista de argumentos
 *    (`\s` casa `\n`);
 *  • em qualquer caixa (flag `i`).
 * Identificador entre aspas (`"public"."is_unit_member"`) também casa — não
 * ocorre hoje, custa dois `"?` e fecha uma evasão trivial.
 *
 * O `\(` no fim é o que distingue `is_unit_member` de um futuro
 * `is_unit_member_v2`: sem ele o guardrail reprovaria nome novo que apenas
 * COMEÇA igual. Há controle negativo para isso abaixo.
 */
const RLS_HELPER_CREATE_RE = new RegExp(
  String.raw`create\s+(?:or\s+replace\s+)?function\s+` +
    String.raw`(?:"?([a-z0-9_]+)"?\s*\.\s*)?` +
    String.raw`"?(${RLS_HELPER_NAMES.join("|")})"?\s*\(`,
  "gi",
);

interface HelperCreate {
  file: string;
  name: string;
  /** Como a migration escreveu o schema — string vazia quando não qualificou. */
  schema: string;
}

/**
 * Recriações dos três helpers que caem em `public`: qualificadas com `public.`
 * ou sem qualificador nenhum. Qualquer outro schema (`app_private.` à frente)
 * é ignorado — mover para schema privado é o que a 106 fez, é o estado
 * desejado, não o defeito.
 */
function publicRlsHelperCreatesIn(sql: string, file: string): HelperCreate[] {
  const out: HelperCreate[] = [];
  for (const m of sql.matchAll(RLS_HELPER_CREATE_RE)) {
    const schema = (m[1] ?? "").toLowerCase();
    if (schema !== "" && schema !== "public") continue;
    out.push({ file, name: m[2].toLowerCase(), schema });
  }
  return out;
}

function describeHelperCreate(c: HelperCreate): string {
  const onde = c.schema === "" ? "<sem qualificador → public>." : "public.";
  return `${c.file}: create function ${onde}${c.name}(...)`;
}

/**
 * ─── Os três helpers de RLS não voltam para `public` ────────────────────────
 *
 * A 106 moveu `is_unit_member`, `is_platform_admin` e `is_org_member` para
 * `app_private` porque `public` é o schema exposto ao PostgREST com a anon key
 * que viaja no bundle do frontend: os três respondiam um booleano sobre o
 * membership de qualquer `(user_id, unit_id)` para quem chamasse
 * `/rest/v1/rpc/is_unit_member` — oráculo de enumeração. Ver o cabeçalho de
 * supabase/migrations/20260910120000_106_advisor_private_rls_helpers.sql.
 *
 * POR QUE UM CHECADOR DE `grant` NÃO ALCANÇA ISTO, que é a razão deste describe
 * existir em vez de confiar nos dois de cima: nesta plataforma `CREATE FUNCTION`
 * concede EXECUTE a PUBLIC implicitamente, e `alter default privileges ...
 * revoke ... from public` é no-op MEDIDO (ver CLAUDE.md e docs/hotfix-acl/).
 * Então uma migration futura que recrie qualquer um dos três em `public`
 * reabre o oráculo SEM ESCREVER UM ÚNICO `grant` — nenhum dos checadores de
 * grant deste arquivo veria nada. O que se proíbe aqui é o `create`, não o
 * grant.
 *
 * ONDE MORA E POR QUÊ: a spec de design
 * (docs/superpowers/specs/2026-08-17-advisor-warnings-hardening-design.md,
 * §230-231) prometia este caso em scripts/migration-static-guard.test.ts. Ele
 * ficou aqui porque é aqui que já existe a máquina de parsing de migration
 * (`stripComments`, `migrationFiles`, `versionOf`) e o vocabulário de
 * assinatura; um segundo parser no outro arquivo divergiria deste.
 *
 * O QUE ISTO NÃO COBRE: `alter function app_private.is_unit_member(uuid, uuid)
 * set schema public;` — mover de volta em vez de recriar. Não foi adicionado
 * porque `alter ... set schema public` é a linha literal do bloco de rollback
 * da própria 106 e de supabase/tests/local-preflight/, e um segundo padrão com
 * allowlist de arquivos para não reprovar o rollback documentado troca uma
 * lacuna estreita por um guardrail que reprova o procedimento de emergência.
 */
describe("os três helpers de RLS não são recriados em public (106)", () => {
  it("CONTROLE POSITIVO: recriação qualificada com public. reprova, nomeando a função", () => {
    const created = publicRlsHelperCreatesIn(
      "create or replace function public.is_unit_member(p_user_id uuid, p_unit_id uuid)\n" +
        "returns boolean language sql security definer as $$ select true $$;",
      "fake.sql",
    );
    expect(created.map(describeHelperCreate)).toEqual([
      "fake.sql: create function public.is_unit_member(...)",
    ]);
  });

  it("CONTROLE POSITIVO: recriação SEM qualificador reprova igual — sem `public.` ela nasce em public", () => {
    const created = publicRlsHelperCreatesIn(
      "create function is_platform_admin(p_user_id uuid) returns boolean language sql as $$ select true $$;",
      "fake.sql",
    );
    expect(created.map(describeHelperCreate)).toEqual([
      "fake.sql: create function <sem qualificador → public>.is_platform_admin(...)",
    ]);
  });

  it("CONTROLE POSITIVO: caixa alta e quebra de linha entre o nome e os argumentos não escapam", () => {
    const created = publicRlsHelperCreatesIn(
      "CREATE OR REPLACE FUNCTION PUBLIC.IS_ORG_MEMBER\n  (p_user_id uuid, p_org_id uuid)\nRETURNS boolean AS $$ select true $$ LANGUAGE sql;",
      "fake.sql",
    );
    expect(created.map((c) => c.name)).toEqual(["is_org_member"]);
  });

  it("recriação em app_private NÃO reprova — é o estado que a 106 estabeleceu", () => {
    const created = publicRlsHelperCreatesIn(
      "create or replace function app_private.is_unit_member(p_user_id uuid, p_unit_id uuid)\n" +
        "returns boolean language sql as $$ select true $$;",
      "fake.sql",
    );
    expect(created).toEqual([]);
  });

  it("create dentro de comentário não reprova — mesma disciplina de stripComments", () => {
    const raw =
      "--   create or replace function public.is_unit_member(p_user_id uuid, p_unit_id uuid) -- forma PRÉ-106, só exemplo\nselect 1;";
    expect(publicRlsHelperCreatesIn(stripComments(raw), "fake.sql")).toEqual([]);
  });

  it("CONTROLE NEGATIVO: nome que só COMEÇA igual (is_unit_member_v2) não é falso positivo", () => {
    const created = publicRlsHelperCreatesIn(
      "create function public.is_unit_member_v2(p_user_id uuid) returns boolean language sql as $$ select true $$;",
      "fake.sql",
    );
    expect(created).toEqual([]);
  });

  it(
    "CONTROLE POSITIVO real (não sintético): aplicado à 013, que cria os três em public de " +
      "verdade, o detector acha os três — é o filtro de VERSÃO que mantém o teste abaixo " +
      "verde, não um regex morto",
    () => {
      const f = migrationFiles().find((x) => x.startsWith("20260504170218_013_"));
      expect(f, "a 013 (multi_tenant) precisa existir — é ela que cria os três em public").toBeTruthy();
      const created = publicRlsHelperCreatesIn(readMigration(f!), f!);
      expect(created.map((c) => c.name).sort()).toEqual([
        "is_org_member",
        "is_platform_admin",
        "is_unit_member",
      ]);
      // E ela está FORA do recorte, porque é anterior à 106.
      expect(versionOf(f!) >= PRIVATE_HELPERS_VERSION).toBe(false);
    },
  );

  it("nenhuma migration da 106 em diante recria os três helpers em public", () => {
    const ofensas: string[] = [];
    for (const f of desde106Files) {
      for (const c of publicRlsHelperCreatesIn(readMigration(f), f)) {
        ofensas.push(describeHelperCreate(c));
      }
    }
    expect(
      ofensas,
      "Helper de RLS recriado em `public` — isso reabre o oráculo de membership pelo grant " +
        "IMPLÍCITO do CREATE FUNCTION a PUBLIC, sem nenhum `grant` no arquivo. Crie em " +
        "`app_private` (e revogue de PUBLIC lá, como exige o describe acima):\n" +
        ofensas.join("\n"),
    ).toEqual([]);
  });
});

/**
 * `grant <privilégios> on schema <lista> to <papéis>;`
 *
 * A lista de schemas é capturada como lista, não como nome único, porque
 * `GRANT ... ON SCHEMA a, b TO c` é SQL válido: casar só `on\s+schema\s+
 * app_private\s+to` deixaria `on schema app_private, public to anon` passar
 * sem match nenhum — falha ABERTA por uma vírgula. O `;` final é a barreira
 * natural entre statements (`[^;]` nunca atravessa um), então nenhum dos três
 * grupos vaza para o statement vizinho.
 */
const SCHEMA_GRANT_RE = /grant\s+([^;]*?)\bon\s+schema\s+([^;]*?)\s+to\s+([^;]+);/gi;

/** Lista SQL separada por vírgula → itens minúsculos, sem aspas nem espaço. */
function splitSqlList(raw: string): string[] {
  return raw
    .split(",")
    .map((x) => x.trim().toLowerCase().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);
}

interface SchemaGrant {
  file: string;
  privileges: string;
  schemas: string[];
  roles: string[];
}

function schemaGrantsIn(sql: string, file: string): SchemaGrant[] {
  const out: SchemaGrant[] = [];
  for (const m of sql.matchAll(SCHEMA_GRANT_RE)) {
    out.push({
      file,
      // Normalizado (minúsculo, espaço único) como schemas e papéis — a
      // mensagem de reprovação não deve variar com a caixa de quem escreveu.
      privileges: m[1].trim().toLowerCase().replace(/\s+/g, " "),
      schemas: splitSqlList(m[2]),
      roles: splitSqlList(m[3]),
    });
  }
  return out;
}

/**
 * Qualquer privilégio de schema em `app_private` concedido a
 * `anon`/`authenticated`/`public`.
 *
 * NÃO filtra pelo privilégio de propósito. USAGE é o que destranca a chamada
 * por nome e é o caso da task; ALL contém USAGE; e CREATE, que não contém, é
 * pior ainda (deixaria papel público criar objeto DENTRO do schema privado).
 * Não existe privilégio de schema que esses três papéis devam ter aqui, então
 * a pergunta certa é "concedeu algo?", não "concedeu USAGE?". O privilégio
 * entra na mensagem para quem for ler a reprovação.
 */
function appPrivateGrantsToPublicRoles(grants: SchemaGrant[]): string[] {
  const ofensas: string[] = [];
  for (const g of grants) {
    if (!g.schemas.includes("app_private")) continue;
    const externos = g.roles.filter((r) => EXTERNAL_ROLES.includes(r));
    if (externos.length === 0) continue;
    ofensas.push(
      `${g.file}: grant ${g.privileges} on schema app_private to ${externos.join(", ")}`,
    );
  }
  return ofensas;
}

/**
 * ─── A última tranca: `anon`/`authenticated` sem USAGE em `app_private` ─────
 *
 * A 106 (linhas 31-35) nomeia UM evento como capaz de desfazer a migration
 * inteira: `app_private` entrar por engano na lista de Exposed schemas da API.
 * Nada detectava a preparação desse cenário, e é isto.
 *
 * POR QUE A AUSÊNCIA DE USAGE É A ÚLTIMA TRANCA, e não redundância. O move NÃO
 * mexeu na ACL das funções — ela vive na linha de `pg_proc` e viaja com o `SET
 * SCHEMA` —, então `app_private.is_unit_member` AINDA carrega EXECUTE para
 * `anon`. Isso é deliberado: 24 das 42 policies que a referenciam são `TO
 * PUBLIC`, o EXECUTE é conferido em tempo de execução, e revogá-lo faria a
 * query ESTOURAR com `permission denied for function` (42501) em vez de negar
 * linha. Ou seja: se o schema for exposto, o EXECUTE já está lá e a única coisa
 * que ainda segura o oráculo é o papel não ter USAGE no schema — a tentativa
 * morre em `permission denied for schema app_private`.
 *
 * POR QUE CONCEDER NÃO COMPRA NADA. USAGE de schema só é consultado em caminho
 * de RESOLUÇÃO DE NOME. Expressão de policy guardada no catálogo já está
 * resolvida: ela referencia a função por OID e nunca toma esse caminho — daí a
 * suíte de pré-voo da 106 rodar inteira com `anon` SEM USAGE aqui e ACL-1
 * (policy `TO PUBLIC`), ACL-1b (tenant cruzado) e ACL-4 (fila pública ponta a
 * ponta) seguirem verdes, enquanto CONTROLE-7b mostra que quem quebra de fato é
 * revogar o EXECUTE. Então o grant é custo puro: zero ganho de funcionamento,
 * e entrega a tranca. É o mesmo princípio de coluna da 086 — coisa nova nasce
 * INVISÍVEL para `anon`.
 *
 * O QUE NÃO ALCANÇA: `alter default privileges ... grant usage on schemas to
 * anon` (SCHEMAS no plural) atinge schema FUTURO, não o `app_private` que já
 * existe, então não é este vetor. E grant feito fora de migration (dashboard,
 * psql) é a lacuna estrutural de todo este arquivo — quem enxerga aquilo é o
 * guardrail com banco.
 */
describe("app_private nunca concede privilégio de schema a papel público (106)", () => {
  it("CONTROLE POSITIVO: `grant usage ... to anon` reprova, nomeando arquivo e papel", () => {
    const ofensas = appPrivateGrantsToPublicRoles(
      schemaGrantsIn("grant usage on schema app_private to anon;", "fake.sql"),
    );
    expect(ofensas).toEqual(["fake.sql: grant usage on schema app_private to anon"]);
  });

  it("CONTROLE POSITIVO: `grant all`, lista de papéis e quebra de linha — os três juntos", () => {
    const ofensas = appPrivateGrantsToPublicRoles(
      schemaGrantsIn(
        "GRANT   ALL\n  ON   SCHEMA   app_private\n  TO   service_role,\n  anon ,  authenticated ;",
        "fake.sql",
      ),
    );
    expect(ofensas).toEqual(["fake.sql: grant all on schema app_private to anon, authenticated"]);
  });

  it("CONTROLE POSITIVO: schema listado ao lado de outro não escapa por causa da vírgula", () => {
    const ofensas = appPrivateGrantsToPublicRoles(
      schemaGrantsIn("grant usage on schema app_private, public to authenticated;", "fake.sql"),
    );
    expect(ofensas).toEqual([
      "fake.sql: grant usage on schema app_private to authenticated",
    ]);
  });

  it("CONTROLE POSITIVO: o pseudo-papel PUBLIC também reprova — alcança todo papel futuro", () => {
    const ofensas = appPrivateGrantsToPublicRoles(
      schemaGrantsIn("grant usage on schema app_private to public;", "fake.sql"),
    );
    expect(ofensas).toEqual(["fake.sql: grant usage on schema app_private to public"]);
  });

  it("service_role NÃO reprova — é o grant que a própria 106 faz", () => {
    const ofensas = appPrivateGrantsToPublicRoles(
      schemaGrantsIn("grant usage on schema app_private to service_role;", "fake.sql"),
    );
    expect(ofensas).toEqual([]);
  });

  it("grant em OUTRO schema não reprova — este describe é sobre app_private", () => {
    const ofensas = appPrivateGrantsToPublicRoles(
      schemaGrantsIn("grant usage on schema public to anon;", "fake.sql"),
    );
    expect(ofensas).toEqual([]);
  });

  it("grant dentro de comentário não reprova — mesma disciplina de stripComments", () => {
    const raw = "-- grant usage on schema app_private to anon;  (exemplo do que NÃO fazer)\nselect 1;";
    expect(appPrivateGrantsToPublicRoles(schemaGrantsIn(stripComments(raw), "fake.sql"))).toEqual([]);
  });

  it(
    "CONTROLE POSITIVO real (não sintético): aplicado à 106, o detector VÊ o grant de " +
      "service_role — o parser está vivo, e o que mantém o teste verde é o papel ser " +
      "permitido, não o regex não casar nada",
    () => {
      const f = migrationFiles().find((x) => versionOf(x) === PRIVATE_HELPERS_VERSION);
      expect(f, "a 106 precisa existir").toBeTruthy();
      const grants = schemaGrantsIn(readMigration(f!), f!).filter((g) =>
        g.schemas.includes("app_private"),
      );
      expect(grants.map((g) => `${g.privileges} → ${g.roles.join(", ")}`)).toEqual([
        "usage → service_role",
      ]);
      expect(appPrivateGrantsToPublicRoles(grants)).toEqual([]);
    },
  );

  it("nenhuma migration da 106 em diante concede privilégio de schema app_private a papel público", () => {
    const ofensas: string[] = [];
    for (const f of desde106Files) {
      ofensas.push(...appPrivateGrantsToPublicRoles(schemaGrantsIn(readMigration(f), f)));
    }
    expect(
      ofensas,
      "USAGE em `app_private` para papel público é a ÚLTIMA tranca do oráculo de membership " +
        "(as funções conservam EXECUTE para anon de propósito) e não compra funcionamento " +
        "nenhum — policy referencia função por OID e nunca resolve nome. Ver o cabeçalho " +
        "deste describe e a 106 §31-35:\n" + ofensas.join("\n"),
    ).toEqual([]);
  });
});
