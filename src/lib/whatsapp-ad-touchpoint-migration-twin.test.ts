import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AD_TOUCHPOINT_PROVIDERS,
  CTWA_CLID_MAX_LEN,
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

  it("os marcadores de que os controles do pré-voo dependem estão no corpo do guard", () => {
    for (const marcador of ["excecao-set-null", "coerencia-tenant", "guarda-update"]) {
      expect(SQL).toContain(`-- <${marcador}>`);
      expect(SQL).toContain(`-- </${marcador}>`);
    }
  });
});
