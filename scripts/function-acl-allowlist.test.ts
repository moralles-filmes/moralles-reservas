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

const GROUPS = ["public_anon", "rls_helpers", "authenticated_tenant"] as const;

function entriesOf(group: (typeof GROUPS)[number]): AllowEntry[] {
  return (allowlist[group] ?? []) as AllowEntry[];
}

const allEntries: AllowEntry[] = GROUPS.flatMap(entriesOf);

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

const GRANT_RE =
  /grant\s+execute\s+on\s+function\s+(?:public\.)?([a-z0-9_]+)\s*\(([^)]*)\)\s*to\s+([^;]+);/gi;
const REVOKE_PUBLIC_RE =
  /revoke\s+(?:all|execute)[^;]*?\son\s+function\s+(?:public\.)?([a-z0-9_]+)\s*\(([^)]*)\)\s*from\s+([^;]+);/gi;
const BROAD_GRANT_RE = /grant\s+execute\s+on\s+all\s+functions\s+in\s+schema/i;
const DROP_RE =
  /drop\s+function\s+(?:if\s+exists\s+)?(?:public\.)?([a-z0-9_]+)\s*\(([^)]*)\)\s*;/gi;

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

function grantsIn(file: string): GrantStmt[] {
  const sql = readMigration(file);
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

/**
 * `drop function` já sem comentário (`sql` sempre vem de `stripComments`,
 * direto ou via `readMigration`) — mesma identidade do resto do arquivo:
 * nome + aridade via `key`/`splitArgs`, nunca tipo.
 *
 * DIREÇÃO DE FALHA: `DROP_RE` é o primeiro padrão deste arquivo cujo falso
 * positivo CONCEDE uma isenção em vez de ACRESCENTAR uma exigência — GRANT_RE
 * e REVOKE_PUBLIC_RE casando de mais só fariam o teste exigir/reconhecer mais
 * entrada na allowlist, nunca dispensar uma. `stripComments` só tira
 * comentário de LINHA (`--`); um texto `drop function ...;` dentro do corpo
 * `$$...$$` de uma função futura (exemplo em docstring, nome de variável,
 * literal) leria como drop real e poderia isentar da allowlist um grant que
 * continua vivo. Não é o caso de nenhuma migration hoje — checado —, mas quem
 * mexer aqui de novo precisa saber que o risco é dispensar exigência, não só
 * deixar de detectar.
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
    const sql = readMigration(file!);
    const revokedFromPublic = new Set<string>();
    for (const m of sql.matchAll(REVOKE_PUBLIC_RE)) {
      const targets = m[3].split(",").map((t) => t.trim().toLowerCase());
      if (targets.includes("public")) revokedFromPublic.add(key(m[1], splitArgs(m[2]).length));
    }

    for (const e of entriesOf("public_anon")) {
      const k = key(e.name, splitArgs(e.args).length);
      expect(
        revokedFromPublic.has(k),
        `${e.name}(${e.args}) é concedida a anon mas a 085 nunca faz "revoke ... from public"`,
      ).toBe(true);
    }
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

  // Controle positivo da regra de soma: um bloco _expected_advisor que não
  // reflete as entradas reais tem que reprovar, nomeado por `toEqual`
  // (Vitest imprime o diff campo a campo), não só um booleano mudo.
  it("CONTROLE POSITIVO — sabotagem: bloco _expected_advisor desatualizado reprova a checagem de soma", () => {
    const summed = sumAdvisorLints(advisorEntries);
    const blocoDesatualizado: ExpectedAdvisorCounts = { "0028": 1, "0029": 1, total: 2 };
    expect(summed).not.toEqual(blocoDesatualizado);
  });
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
