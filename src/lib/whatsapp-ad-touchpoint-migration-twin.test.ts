import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AD_TOUCHPOINT_PROVIDERS,
  CTWA_CLID_MAX_LEN,
  CUSTOMER_NOT_ALIVE_SQLSTATE,
  MESSAGE_TYPE_MAX_LEN,
  PROVIDER_MESSAGE_ID_MAX_LEN,
  REFERRAL_RAW_DB_MAX_BYTES,
  REFERRAL_RAW_MAX_BYTES,
  SOURCE_ID_MAX_LEN,
  SOURCE_TYPE_MAX_LEN,
} from "../../supabase/functions/_shared/whatsapp-ad-touchpoint-core";

// Gêmeos declarados: SQL não importa TypeScript. Este teste é o único ponto
// que amarra os dois lados.
const MIGRATIONS = resolve(__dirname, "../../supabase/migrations");
const ARQUIVO = readdirSync(MIGRATIONS).find((f) => /^\d{14}_115_whatsapp_ad_touchpoints\.sql$/.test(f));
const SQL = ARQUIVO ? readFileSync(resolve(MIGRATIONS, ARQUIVO), "utf8") : "";

function semComentarios(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

function providersDoCheck(sql: string): string[] {
  const m = semComentarios(sql).match(/provider\s+text\s+not\s+null\s+check\s*\(\s*provider\s+in\s*\(([^)]*)\)\s*\)/i);
  if (!m) throw new Error("CHECK de provider não encontrado");
  return m[1].split(",").map((s) => s.trim().replace(/^'|'$/g, "")).sort();
}

function limiteDaColuna(sql: string, coluna: string): number {
  const m = semComentarios(sql).match(new RegExp(`\\b${coluna}\\s+text\\b[^\\n]*?between\\s+1\\s+and\\s+(\\d+)`, "i"));
  if (!m) throw new Error(`limite de ${coluna} não encontrado`);
  return Number(m[1]);
}

const GUARD_FN_START = "create or replace function public.whatsapp_ad_touchpoints_guard()";
const GUARD_FN_END = "$$;";

/**
 * Corpo da função do guard, do `create or replace function ...guard()` até o
 * PRIMEIRO `$$;` depois dele — o fechamento de `as $$ ... $$;`. Os testes de
 * aninhamento de marcador (fix F4) operam só sobre esta fatia: um marcador
 * que "existe em algum lugar do arquivo" não prova nada sobre a ordem DENTRO
 * do guard, e foi exatamente essa fraqueza que o review apontou.
 */
function guardBody(sql: string): string {
  const start = sql.indexOf(GUARD_FN_START);
  if (start === -1) throw new Error("função whatsapp_ad_touchpoints_guard não encontrada");
  const end = sql.indexOf(GUARD_FN_END, start);
  if (end === -1) throw new Error("fim do corpo do guard ($$;) não encontrado");
  return sql.slice(start, end + GUARD_FN_END.length);
}

interface MarcadorPos {
  open: number;
  close: number;
}

function acharMarcador(body: string, marcador: string): MarcadorPos {
  return {
    open: body.indexOf(`-- <${marcador}>`),
    close: body.indexOf(`-- </${marcador}>`),
  };
}

/** `inner` está inteiramente dentro do intervalo [abertura, fechamento] de `outer`. */
function estaAninhado(inner: MarcadorPos, outer: MarcadorPos): boolean {
  return (
    outer.open !== -1 &&
    outer.close !== -1 &&
    inner.open !== -1 &&
    inner.close !== -1 &&
    outer.open < inner.open &&
    inner.close < outer.close
  );
}

describe("migration 115 ⇔ núcleo do touchpoint", () => {
  it("o arquivo existe e vem depois da 114 (20260924120300)", () => {
    expect(ARQUIVO).toBeDefined();
    expect(Number(ARQUIVO!.slice(0, 14))).toBeGreaterThan(20260924120300);
  });

  it("o CHECK de provider é o conjunto de providers com adReferral", () => {
    expect(providersDoCheck(SQL)).toEqual([...AD_TOUCHPOINT_PROVIDERS].sort());
  });

  it("CONTROLE POSITIVO: um provider a mais no CHECK reprova", () => {
    const sabotado = SQL.replace("in ('official','datafy')", "in ('official','datafy','zapi')");
    expect(sabotado).not.toBe(SQL);
    expect(providersDoCheck(sabotado)).not.toEqual([...AD_TOUCHPOINT_PROVIDERS].sort());
  });

  it("os limites de coluna são os do núcleo", () => {
    expect(limiteDaColuna(SQL, "provider_message_id")).toBe(PROVIDER_MESSAGE_ID_MAX_LEN);
    expect(limiteDaColuna(SQL, "message_type")).toBe(MESSAGE_TYPE_MAX_LEN);
    expect(limiteDaColuna(SQL, "ctwa_clid")).toBe(CTWA_CLID_MAX_LEN);
    expect(limiteDaColuna(SQL, "source_type")).toBe(SOURCE_TYPE_MAX_LEN);
    expect(limiteDaColuna(SQL, "source_id")).toBe(SOURCE_ID_MAX_LEN);
  });

  it("o CHECK da subárvore é a REDE (65536) e a regra do núcleo cabe nela com folga de 2x", () => {
    const m = semComentarios(SQL).match(/octet_length\(referral::text\)\s*<=\s*(\d+)/i);
    expect(Number(m?.[1])).toBe(REFERRAL_RAW_DB_MAX_BYTES);
    expect(REFERRAL_RAW_MAX_BYTES * 2).toBeLessThanOrEqual(REFERRAL_RAW_DB_MAX_BYTES);
  });

  it("RLS forçada, nenhuma policy", () => {
    const sql = semComentarios(SQL).toLowerCase();
    expect(sql).toContain("alter table whatsapp_ad_touchpoints enable row level security");
    expect(sql).toContain("alter table whatsapp_ad_touchpoints force row level security");
    expect(sql).not.toMatch(/create\s+policy/);
  });

  it("as duas funções de trigger são revogadas de public, anon e authenticated com a assinatura completa", () => {
    const sql = semComentarios(SQL).toLowerCase();
    expect(sql).toContain("revoke all on function public.whatsapp_ad_touchpoints_guard() from public, anon, authenticated");
    expect(sql).toContain("revoke all on function public.purge_ad_touchpoints_on_customer_anonymize() from public, anon, authenticated");
    expect(sql).not.toMatch(/grant\s+[^;]*\bon\s+function\b/);
  });

  it("a tabela é revogada de anon e authenticated — segunda tranca além da RLS forçada", () => {
    expect(semComentarios(SQL).toLowerCase()).toContain("revoke all on table whatsapp_ad_touchpoints from anon, authenticated");
  });
});

/**
 * A perna `cliente-vivo` recusa com o SQLSTATE que o núcleo classifica como
 * `customer_not_alive` (loga e segue). Comentários fora: um `P0A15` citado em
 * comentário não prova nada sobre o `raise`.
 */
function pernaClienteVivoUsaSqlstateDoNucleo(sql: string): boolean {
  const body = guardBody(sql);
  const { open, close } = acharMarcador(body, "cliente-vivo");
  if (open === -1 || close === -1 || close < open) throw new Error("marcadores <cliente-vivo> ausentes no guard");
  return semComentarios(body.slice(open, close)).includes(`errcode = '${CUSTOMER_NOT_ALIVE_SQLSTATE}'`);
}

describe("perna cliente-vivo ⇔ CUSTOMER_NOT_ALIVE_SQLSTATE do núcleo", () => {
  it("o raise da perna usa o SQLSTATE dedicado do núcleo", () => {
    expect(pernaClienteVivoUsaSqlstateDoNucleo(SQL)).toBe(true);
  });

  it("CONTROLE POSITIVO: a perna de volta a check_violation reprova", () => {
    const sabotado = SQL.replace(`errcode = '${CUSTOMER_NOT_ALIVE_SQLSTATE}'`, "errcode = 'check_violation'");
    expect(sabotado).not.toBe(SQL);
    expect(pernaClienteVivoUsaSqlstateDoNucleo(sabotado)).toBe(false);
  });
});

describe("marcadores do guard (fix F4): aninhamento, não só presença no arquivo", () => {
  const MARCADORES = ["excecao-set-null", "coerencia-tenant", "cliente-vivo", "guarda-update"] as const;

  it("os quatro marcadores estão dentro do CORPO do guard, com abertura antes do fechamento", () => {
    const body = guardBody(SQL);
    for (const marcador of MARCADORES) {
      const { open, close } = acharMarcador(body, marcador);
      expect(open, `abertura de <${marcador}> não está no corpo do guard`).toBeGreaterThanOrEqual(0);
      expect(close, `fechamento de </${marcador}> não está no corpo do guard`).toBeGreaterThanOrEqual(0);
      expect(open, `<${marcador}>: abertura deveria vir antes do fechamento`).toBeLessThan(close);
    }
  });

  it("excecao-set-null está aninhado DENTRO de guarda-update", () => {
    const body = guardBody(SQL);
    const inner = acharMarcador(body, "excecao-set-null");
    const outer = acharMarcador(body, "guarda-update");
    expect(estaAninhado(inner, outer)).toBe(true);
  });

  it("cliente-vivo NÃO está aninhado dentro de coerencia-tenant — o acoplamento do fix F2", () => {
    const body = guardBody(SQL);
    const inner = acharMarcador(body, "cliente-vivo");
    const outer = acharMarcador(body, "coerencia-tenant");
    expect(estaAninhado(inner, outer)).toBe(false);
  });

  it(
    "CONTROLE POSITIVO: corpo sintético com cliente-vivo dentro de coerencia-tenant reprova " +
      "o teste de não-aninhamento acima",
    () => {
      const corpoSabotado = [
        "-- <coerencia-tenant>",
        "-- <cliente-vivo>",
        "if v_cust_deleted is not null then raise exception 'x'; end if;",
        "-- </cliente-vivo>",
        "-- </coerencia-tenant>",
      ].join("\n");
      const inner = acharMarcador(corpoSabotado, "cliente-vivo");
      const outer = acharMarcador(corpoSabotado, "coerencia-tenant");
      expect(estaAninhado(inner, outer)).toBe(true);
    },
  );

  it("a leitura do cliente no guard usa `for share` — fecha a corrida com anonymize_customer (fix F1)", () => {
    const body = guardBody(SQL);
    expect(body).toMatch(/from public\.customers c where c\.id = new\.customer_id for share/);
  });
});
