import { describe, expect, it } from "vitest";
import {
  parseOfficialAdReferral,
  type AdReferral,
} from "../../supabase/functions/_shared/whatsapp-provider-core";
import { splitMetaWebhookPayloadCore } from "../../supabase/functions/_shared/whatsapp-meta-batch-core";

// Fachada pelo glob, nunca por import direto: o import direto puxa
// whatsapp-providers.ts para o grafo do `tsc -b` do frontend e quebra o
// typecheck (global `Deno`). Mesmo padrão de whatsapp-capability-guard.test.ts.
const FACADE = "../../supabase/functions/_shared/whatsapp-providers.ts";
const modules = import.meta.glob<{
  parseAdReferral(provider: string, payload: unknown): AdReferral | null;
  hasAdReferralCapture(provider: string): boolean;
}>("../../supabase/functions/_shared/whatsapp-providers.ts", { eager: true });
const { parseAdReferral, hasAdReferralCapture } = modules[FACADE];

// Forma DOCUMENTADA pela Meta. Não foi medida (não há anúncio rodando): é
// exatamente por isso que o parser guarda a subárvore crua.
const REFERRAL = {
  source_url: "https://fb.me/abc",
  source_type: "ad",
  source_id: "120000000000001",
  headline: "Reserve sua mesa",
  body: "Clique e reserve",
  media_type: "image",
  image_url: "https://scontent.example/img.jpg",
  ctwa_clid: "ARAkLkA8rmlFeiCktEJQ",
};

function metaPost(messages: unknown[], contacts: unknown[] = []) {
  return {
    object: "whatsapp_business_account",
    entry: [{
      id: "WABA_ID",
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: "5511900000000", phone_number_id: "PNID" },
          contacts,
          messages,
        },
      }],
    }],
  };
}

function msg(id: string, from: string, extra: Record<string, unknown> = {}) {
  return { from, id, timestamp: "1727500000", type: "text", text: { body: "Oi" }, ...extra };
}

describe("parseOfficialAdReferral — referral de QUALQUER tipo de mensagem", () => {
  it("texto: campos tipados e a subárvore crua é a MESMA referência do payload", () => {
    const post = metaPost([msg("wamid.A", "5511911110001", { referral: REFERRAL })]);
    const r = parseOfficialAdReferral(post);
    expect(r).toEqual({
      providerMessageId: "wamid.A",
      messageType: "text",
      ctwaClid: "ARAkLkA8rmlFeiCktEJQ",
      sourceType: "ad",
      sourceId: "120000000000001",
      raw: REFERRAL,
    });
    // `messages` é `unknown[]` no helper (§ acima) — cast local só para reler o
    // fixture; não afeta o parser, que já recebe `post` como `any`.
    expect(r?.raw).toBe(
      (post.entry[0].changes[0].value.messages[0] as { referral: unknown }).referral,
    );
  });

  it("imagem: o caminho que parseOfficialInbound recusa também devolve referral", () => {
    const post = metaPost([{ from: "5511911110001", id: "wamid.IMG", timestamp: "1727500000", type: "image", image: { id: "m1" }, referral: REFERRAL }]);
    expect(parseOfficialAdReferral(post)?.messageType).toBe("image");
    expect(parseOfficialAdReferral(post)?.ctwaClid).toBe("ARAkLkA8rmlFeiCktEJQ");
  });

  it("tipo desconhecido: devolve referral e não normaliza o type", () => {
    const post = metaPost([msg("wamid.U", "5511911110001", { type: "unsupported", referral: REFERRAL })]);
    expect(parseOfficialAdReferral(post)?.messageType).toBe("unsupported");
  });

  it("sem referral, ou referral null → null", () => {
    expect(parseOfficialAdReferral(metaPost([msg("wamid.N", "5511911110001")]))).toBeNull();
    expect(parseOfficialAdReferral(metaPost([msg("wamid.N", "5511911110001", { referral: null })]))).toBeNull();
  });

  it("mensagem sem id → null (sem id não há como amarrar o touchpoint à mensagem)", () => {
    expect(parseOfficialAdReferral(metaPost([{ from: "5511911110001", type: "text", referral: REFERRAL }]))).toBeNull();
  });

  it("campo não-string vira null: o valor só sobrevive na subárvore crua", () => {
    const referral = { ctwa_clid: 12345, source_type: { x: 1 }, source_id: ["a"] };
    const r = parseOfficialAdReferral(metaPost([msg("wamid.B", "5511911110001", { referral })]));
    expect(r?.ctwaClid).toBeNull();
    expect(r?.sourceType).toBeNull();
    expect(r?.sourceId).toBeNull();
    expect(r?.raw).toBe(referral);
  });

  // Review Focus 2.
  it.each([
    ["string", "abc"],
    ["array", ["x", "y"]],
    ["número", 7],
    ["booleano", true],
  ])("referral %s: sem exceção, tipados nulos, raw preservado", (_rotulo, referral) => {
    const r = parseOfficialAdReferral(metaPost([msg("wamid.R", "5511911110001", { referral })]));
    expect(r?.providerMessageId).toBe("wamid.R");
    expect(r?.ctwaClid).toBeNull();
    expect(r?.sourceType).toBeNull();
    expect(r?.sourceId).toBeNull();
    expect(r?.raw).toEqual(referral);
  });

  it("payload que não é envelope Meta → null, sem exceção", () => {
    for (const p of [null, undefined, "x", 1, {}, { entry: [] }, { entry: [{ changes: [{ value: { messages: ["x"] } }] }] }]) {
      expect(parseOfficialAdReferral(p)).toBeNull();
    }
  });
});

describe("lote Meta: o referral é POR MENSAGEM, nunca por POST", () => {
  it("dois clientes, só o segundo com referral: depois do split, só a parte dele devolve referral", () => {
    const post = metaPost(
      [msg("wamid.SEM", "5511911110001"), msg("wamid.COM", "5511911110002", { referral: REFERRAL })],
      [{ wa_id: "5511911110001", profile: { name: "A" } }, { wa_id: "5511911110002", profile: { name: "B" } }],
    );
    const parts = splitMetaWebhookPayloadCore(post);
    expect(parts).toHaveLength(2);
    expect(parseOfficialAdReferral(parts[0])).toBeNull();
    expect(parseOfficialAdReferral(parts[1])?.providerMessageId).toBe("wamid.COM");
  });

  it("CONTROLE POSITIVO: ler do POST inteiro carrega o id de OUTRA mensagem — o id é o que denuncia a atribuição errada", () => {
    const post = metaPost(
      [msg("wamid.COM", "5511911110001", { referral: REFERRAL }), msg("wamid.OUTRO", "5511911110002")],
      [{ wa_id: "5511911110001" }, { wa_id: "5511911110002" }],
    );
    // A leitura "uma vez por requisição", aplicada à mensagem do outro cliente:
    const doPostInteiro = parseOfficialAdReferral(post);
    const parteDoOutro = splitMetaWebhookPayloadCore(post)[1];
    expect(parseOfficialAdReferral(parteDoOutro)).toBeNull();
    expect(doPostInteiro).not.toBeNull();
    expect(doPostInteiro?.providerMessageId).not.toBe("wamid.OUTRO");
  });

  // Review Focus 3.
  it("mesmo change, duas mensagens do MESMO cliente, referral só na segunda", () => {
    const post = metaPost(
      [msg("wamid.1", "5511911110001"), msg("wamid.2", "5511911110001", { referral: REFERRAL })],
      [{ wa_id: "5511911110001" }],
    );
    const parts = splitMetaWebhookPayloadCore(post);
    expect(parts).toHaveLength(2);
    expect(parseOfficialAdReferral(parts[0])).toBeNull();
    expect(parseOfficialAdReferral(parts[1])?.providerMessageId).toBe("wamid.2");
  });
});

describe("fachada parseAdReferral / hasAdReferralCapture", () => {
  const post = metaPost([msg("wamid.F", "5511911110001", { referral: REFERRAL })]);

  it.each(["zapi", "waha", "uazapi"])("%s não captura, mesmo com referral no payload", (provider) => {
    expect(parseAdReferral(provider, post)).toBeNull();
    expect(hasAdReferralCapture(provider)).toBe(false);
  });

  it.each(["official", "datafy"])("%s captura", (provider) => {
    expect(hasAdReferralCapture(provider)).toBe(true);
    expect(parseAdReferral(provider, post)?.ctwaClid).toBe("ARAkLkA8rmlFeiCktEJQ");
  });

  it("provider desconhecido → null e false, sem exceção", () => {
    expect(parseAdReferral("inexistente", post)).toBeNull();
    expect(hasAdReferralCapture("inexistente")).toBe(false);
  });
});
