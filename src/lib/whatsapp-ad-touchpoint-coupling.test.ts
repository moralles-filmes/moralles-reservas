import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

// O vitest não importa o webhook (`serve()` no carregamento + `deno.land`): a
// cobertura do ADAPTER é estrutural. A decisão está no núcleo, testado à parte.
// `.replace(/\r\n/g, "\n")`: checkout Windows com `core.autocrlf=true` grava
// CRLF em disco: mesma normalização de `whatsapp-inbound-reentry.test.ts`,
// necessária para os `indexOf("\n}\n")` abaixo encontrarem o fecho de função.
const WEBHOOK = readFileSync(resolve(__dirname, "../../supabase/functions/webhook-whatsapp/index.ts"), "utf8")
  .replace(/\r\n/g, "\n");
const FUNCTIONS = resolve(__dirname, "../../supabase/functions");

function definicao(): string {
  const inicio = WEBHOOK.indexOf("async function captureAdTouchpoint(");
  if (inicio < 0) throw new Error("captureAdTouchpoint não definida");
  const fim = WEBHOOK.indexOf("\n}\n", inicio);
  return WEBHOOK.slice(inicio, fim + 2);
}

function chamadas(): { idx: number; texto: string }[] {
  const out: { idx: number; texto: string }[] = [];
  let i = WEBHOOK.indexOf("await captureAdTouchpoint(");
  while (i >= 0) {
    out.push({ idx: i, texto: WEBHOOK.slice(i, WEBHOOK.indexOf("});", i) + 3) });
    i = WEBHOOK.indexOf("await captureAdTouchpoint(", i + 1);
  }
  return out;
}

function arquivosTs(dir: string): string[] {
  return readdirSync(dir).flatMap((nome) => {
    const p = join(dir, nome);
    return statSync(p).isDirectory() ? arquivosTs(p) : p.endsWith(".ts") ? [p] : [];
  });
}

/** Operações de escrita diferentes de INSERT na tabela de touchpoints. */
function escritasProibidas(fonte: string): string[] {
  const achados: string[] = [];
  const re = /from\(\s*["']whatsapp_ad_touchpoints["']\s*\)\s*\.(\w+)\(/g;
  for (const m of fonte.matchAll(re)) if (m[1] !== "insert") achados.push(m[1]);
  return achados;
}

describe("webhook-whatsapp captura o referral nos DOIS caminhos, no ponto certo", () => {
  it("há exatamente duas chamadas", () => {
    expect(chamadas()).toHaveLength(2);
  });

  it("mídia: depois do claim e antes de qualquer resolução, gate ou envio", () => {
    const [midia] = chamadas();
    const claim = WEBHOOK.indexOf("p_message_id: media.providerMessageId");
    expect(claim).toBeGreaterThan(0);
    expect(midia.idx).toBeGreaterThan(claim);
    expect(midia.idx).toBeLessThan(WEBHOOK.indexOf('"media_unit_lookup_failed"'));
    expect(midia.idx).toBeLessThan(WEBHOOK.indexOf("toPhone: mediaPhone, text: MEDIA_REPLY_TEXT"));
    expect(midia.texto).toContain("inboundProviderMessageId: media.providerMessageId");
  });

  it("texto: depois do claim e ANTES de rate limit, billing e suspensão", () => {
    const [, texto] = chamadas();
    const claim = WEBHOOK.indexOf("p_message_id: inbound.providerMessageId");
    expect(claim).toBeGreaterThan(0);
    expect(texto.idx).toBeGreaterThan(claim);
    expect(texto.idx).toBeLessThan(WEBHOOK.indexOf('"check_rate_limit"'));
    expect(texto.idx).toBeLessThan(WEBHOOK.indexOf('"webhook_org_billing_blocked"'));
    expect(texto.idx).toBeLessThan(WEBHOOK.indexOf('"webhook_whatsapp_service_suspended"'));
    expect(texto.texto).toContain("inboundProviderMessageId: inbound.providerMessageId");
  });

  it("escopo vem do canal da querystring, nunca do payload", () => {
    for (const c of chamadas()) {
      expect(c.texto).toContain("unitId: channel.unit_id");
      expect(c.texto).toContain("channelId: channel.id");
    }
  });

  it("a definição só faz I/O: decide pelo núcleo e não redigita o 23505", () => {
    const def = definicao();
    for (const chamada of [
      "hasAdReferralCapture(",
      "parseAdReferral(",
      "describeReferralProbe(",
      "buildAdTouchpointRow(",
      "classifyTouchpointInsert(",
      "describeCapturedReferral(",
    ]) expect(def).toContain(chamada);
    expect(def).not.toContain("23505");
    // Quem conhece o SQLSTATE da perna cliente-vivo é o núcleo.
    expect(def).not.toContain("P0A15");
    expect(def).not.toContain("shapeOf(");
  });

  it("provider sem a capability sai antes de qualquer I/O e de qualquer log", () => {
    const def = definicao();
    const saida = def.indexOf("if (!hasAdReferralCapture(");
    expect(saida).toBeGreaterThan(0);
    expect(saida).toBeLessThan(def.indexOf("jsonLog("));
    expect(saida).toBeLessThan(def.indexOf("supabase"));
  });

  // Review Focus 5: só a falha lança; duplicata e recusa seguem.
  it("lança ad_touchpoint_persist_failed só quando o INSERT falhou", () => {
    const def = definicao();
    expect(def).toContain('if (outcome === "failed") throw new Error("ad_touchpoint_persist_failed")');
    expect(def).toMatch(/if \(built\.ok === false\) \{[\s\S]*?return;\s*\}/);
  });

  it("nenhum código de Edge Function faz UPDATE, UPSERT ou DELETE na tabela", () => {
    const achados = arquivosTs(FUNCTIONS).flatMap((f) =>
      escritasProibidas(readFileSync(f, "utf8")).map((op) => `${f}: ${op}`)
    );
    expect(achados).toEqual([]);
  });

  it("CONTROLE POSITIVO: o detector acha update e upsert", () => {
    expect(escritasProibidas(`supabase.from("whatsapp_ad_touchpoints").update({ x: 1 })`)).toEqual(["update"]);
    expect(escritasProibidas(`supabase.from('whatsapp_ad_touchpoints').upsert(row)`)).toEqual(["upsert"]);
    expect(escritasProibidas(`supabase.from("whatsapp_ad_touchpoints").insert(row)`)).toEqual([]);
  });
});
