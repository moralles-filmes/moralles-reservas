import { describe, expect, it } from "vitest";
import {
  AD_TOUCHPOINT_PROVIDERS,
  CTWA_CLID_MAX_LEN,
  MESSAGE_AT_MAX_MS,
  REFERRAL_RAW_MAX_BYTES,
  REFERRAL_RAW_MAX_DEPTH,
  buildAdTouchpointRow,
  classifyTouchpointInsert,
  describeCapturedReferral,
  describeReferralProbe,
  isPgSafeText,
  normalizeTouchpointText,
  utf8ByteLength,
  type AdTouchpointInput,
  type BuildAdTouchpointResult,
} from "../../supabase/functions/_shared/whatsapp-ad-touchpoint-core";
import type { AdReferral } from "../../supabase/functions/_shared/whatsapp-provider-core";

const T0 = Date.UTC(2026, 8, 28, 15, 0, 0);

function referral(over: Partial<AdReferral> = {}): AdReferral {
  return {
    providerMessageId: "wamid.X",
    messageType: "text",
    ctwaClid: "clid-1",
    sourceType: "ad",
    sourceId: "ad-1",
    raw: { ctwa_clid: "clid-1", source_type: "ad" },
    ...over,
  };
}

function input(over: Partial<AdTouchpointInput> = {}): AdTouchpointInput {
  return {
    provider: "datafy",
    unitId: "u-1",
    channelId: "ch-1",
    customerId: "c-1",
    inboundProviderMessageId: "wamid.X",
    messageAtMs: T0,
    referral: referral(),
    ...over,
  };
}

function aceito(r: BuildAdTouchpointResult) {
  if (r.ok === false) throw new Error(`recusado: ${r.reason}`);
  return r;
}

function aninhado(niveis: number): unknown {
  let v: unknown = "folha";
  for (let i = 0; i < niveis; i++) v = { n: v };
  return v;
}

describe("AD_TOUCHPOINT_PROVIDERS é derivado da capability", () => {
  it("contém official e datafy, e só eles", () => {
    expect([...AD_TOUCHPOINT_PROVIDERS].sort()).toEqual(["datafy", "official"]);
  });
});

describe("buildAdTouchpointRow — caminho feliz", () => {
  it("monta a linha com escopo, tipados, message_at ISO e a subárvore crua", () => {
    const r = aceito(buildAdTouchpointRow(input()));
    expect(r.rawOmittedReason).toBeNull();
    expect(r.row).toEqual({
      unit_id: "u-1",
      channel_id: "ch-1",
      customer_id: "c-1",
      provider: "datafy",
      provider_message_id: "wamid.X",
      message_type: "text",
      message_at: new Date(T0).toISOString(),
      ctwa_clid: "clid-1",
      source_type: "ad",
      source_id: "ad-1",
      referral: { ctwa_clid: "clid-1", source_type: "ad" },
    });
  });

  it("channel_id nulo é aceito", () => {
    expect(aceito(buildAdTouchpointRow(input({ channelId: null }))).row.channel_id).toBeNull();
  });

  it("source_type desconhecido entra como veio — sem enum, porque recusa viraria reentrega eterna", () => {
    expect(aceito(buildAdTouchpointRow(input({ referral: referral({ sourceType: "reel" }) }))).row.source_type).toBe("reel");
  });

  it("trim; vazio e só-espaço viram null", () => {
    const r = aceito(buildAdTouchpointRow(input({ referral: referral({ ctwaClid: "  clid-2 ", sourceType: "   ", sourceId: "" }) })));
    expect(r.row.ctwa_clid).toBe("clid-2");
    expect(r.row.source_type).toBeNull();
    expect(r.row.source_id).toBeNull();
  });

  it("acima do limite vira null — nunca trunca (truncar um identificador o corrompe)", () => {
    expect(aceito(buildAdTouchpointRow(input({ referral: referral({ ctwaClid: "a".repeat(CTWA_CLID_MAX_LEN) }) }))).row.ctwa_clid)
      .toBe("a".repeat(CTWA_CLID_MAX_LEN));
    expect(aceito(buildAdTouchpointRow(input({ referral: referral({ ctwaClid: "a".repeat(CTWA_CLID_MAX_LEN + 1) }) }))).row.ctwa_clid)
      .toBeNull();
  });
});

describe("subárvore crua — limite em BYTES UTF-8", () => {
  it("multibyte: poucos caracteres, muitos bytes → omitida; os tipados ficam", () => {
    const raw = { body: "ç".repeat(9000) };
    const serializado = JSON.stringify(raw);
    // Premissa do caso: contar caracteres aceitaria, contar bytes recusa.
    expect(serializado.length).toBeLessThan(REFERRAL_RAW_MAX_BYTES);
    expect(utf8ByteLength(serializado)).toBeGreaterThan(REFERRAL_RAW_MAX_BYTES);
    const r = aceito(buildAdTouchpointRow(input({ referral: referral({ raw }) })));
    expect(r.row.referral).toBeNull();
    expect(r.rawOmittedReason).toBe("too_large");
    expect(r.row.ctwa_clid).toBe("clid-1");
  });

  it("CONTROLE: o mesmo tamanho em ASCII cabe", () => {
    const raw = { body: "c".repeat(9000) };
    const r = aceito(buildAdTouchpointRow(input({ referral: referral({ raw }) })));
    expect(r.row.referral).toEqual(raw);
    expect(r.rawOmittedReason).toBeNull();
  });
});

// Review Focus 1: tudo que o Postgres recusaria é neutralizado AQUI.
describe("texto que o Postgres recusa nunca chega ao INSERT", () => {
  it("isPgSafeText: NUL e surrogate órfão recusados; par válido aceito", () => {
    expect(isPgSafeText("abc")).toBe(true);
    expect(isPgSafeText("a\u0000b")).toBe(false);
    expect(isPgSafeText("a\ud800b")).toBe(false);
    expect(isPgSafeText("a\udc00b")).toBe(false);
    expect(isPgSafeText("sushi 🍣")).toBe(true);
  });

  it("NUL em campo tipado → null", () => {
    expect(aceito(buildAdTouchpointRow(input({ referral: referral({ ctwaClid: "cl\u0000id" }) }))).row.ctwa_clid).toBeNull();
  });

  it("surrogate órfão em campo tipado → null; par válido fica", () => {
    expect(aceito(buildAdTouchpointRow(input({ referral: referral({ sourceId: "ad\ud800" }) }))).row.source_id).toBeNull();
    expect(aceito(buildAdTouchpointRow(input({ referral: referral({ sourceId: "ad🍣" }) }))).row.source_id).toBe("ad🍣");
  });

  it.each([
    ["NUL em valor", { a: "x\u0000y" }],
    ["NUL em chave", { ["k\u0000"]: "v" }],
    ["surrogate órfão em valor", { a: "\ud800" }],
    ["surrogate órfão em chave", { ["\udc00"]: 1 }],
    ["número exponencial grande", { n: 1e300 }],
    ["número exponencial pequeno", { n: 1e-7 }],
    [`aninhamento acima de ${REFERRAL_RAW_MAX_DEPTH}`, aninhado(40)],
  ])("%s → subárvore omitida (not_storable), linha gravável", (_rotulo, raw) => {
    const r = aceito(buildAdTouchpointRow(input({ referral: referral({ raw }) })));
    expect(r.row.referral).toBeNull();
    expect(r.rawOmittedReason).toBe("not_storable");
    expect(r.row.ctwa_clid).toBe("clid-1");
  });

  it("CONTROLE: números comuns, emoji e aninhamento raso ficam", () => {
    const raw = { id: 120000000000001, x: 0.5, e: "🍣", ok: true, nada: null, lista: [1, "a"], fundo: aninhado(5) };
    expect(aceito(buildAdTouchpointRow(input({ referral: referral({ raw }) }))).row.referral).toEqual(raw);
  });

  it("message_type com NUL → null (e o log não o repete)", () => {
    const r = aceito(buildAdTouchpointRow(input({ referral: referral({ messageType: "te\u0000xt" }) })));
    expect(r.row.message_type).toBeNull();
  });
});

describe("recusas — o núcleo diz não, o handler não lança", () => {
  it("provider sem a capability → provider_not_capable (o CHECK do banco recusaria, e recusa é reentrega eterna)", () => {
    expect(buildAdTouchpointRow(input({ provider: "zapi" }))).toEqual({ ok: false, reason: "provider_not_capable" });
  });

  it("id do referral diferente do id do inbound → message_id_mismatch", () => {
    expect(buildAdTouchpointRow(input({ inboundProviderMessageId: "wamid.OUTRO" })))
      .toEqual({ ok: false, reason: "message_id_mismatch" });
  });

  it("id do inbound vazio → invalid_provider_message_id", () => {
    expect(buildAdTouchpointRow(input({ inboundProviderMessageId: "   " })))
      .toEqual({ ok: false, reason: "invalid_provider_message_id" });
  });

  // Review Focus 4.
  it.each([
    ["NaN", Number.NaN],
    ["negativo", -1],
    ["depois de 9999-12-31", MESSAGE_AT_MAX_MS + 1],
    ["ano 33658", 1e12 * 1000],
  ])("message_at %s → invalid_message_at", (_rotulo, ms) => {
    expect(buildAdTouchpointRow(input({ messageAtMs: ms }))).toEqual({ ok: false, reason: "invalid_message_at" });
  });

  it("CONTROLE: o último milissegundo de 9999 é aceito", () => {
    expect(aceito(buildAdTouchpointRow(input({ messageAtMs: MESSAGE_AT_MAX_MS }))).row.message_at)
      .toBe("9999-12-31T23:59:59.999Z");
  });
});

// Review Focus 5.
describe("classifyTouchpointInsert", () => {
  it("sem erro → inserted; 23505 → duplicate; qualquer outro código → failed", () => {
    expect(classifyTouchpointInsert(null)).toBe("inserted");
    expect(classifyTouchpointInsert(undefined)).toBe("inserted");
    expect(classifyTouchpointInsert({ code: "23505" })).toBe("duplicate");
    expect(classifyTouchpointInsert({ code: "23514" })).toBe("failed");
    expect(classifyTouchpointInsert({ code: "PGRST204" })).toBe("failed");
    expect(classifyTouchpointInsert({})).toBe("failed");
  });
});

describe("logs de forma — nomes e typeof, nunca valor", () => {
  const SEGREDOS = ["ARAkLkA8rmlFeiCktEJQ", "5511911110001", "Oi quero reservar", "120000000000001"];
  const msg = {
    from: "5511911110001",
    id: "wamid.P",
    timestamp: "1727500000",
    type: "text",
    text: { body: "Oi quero reservar" },
    referral: { ctwa_clid: "ARAkLkA8rmlFeiCktEJQ", source_id: "120000000000001", source_type: "ad" },
  };
  const post = { entry: [{ changes: [{ value: { messages: [msg] } }] }] };
  const vaza = (saida: unknown) => SEGREDOS.filter((s) => JSON.stringify(saida).includes(s));

  it("describeReferralProbe: has_referral e a forma da mensagem, sem valor", () => {
    const out = describeReferralProbe(post);
    expect(out.has_referral).toBe(true);
    expect(out.message_shape).toMatchObject({ from: "string", id: "string", referral: "object", text: "object" });
    expect(vaza(out)).toEqual([]);
  });

  it("describeReferralProbe: sem referral e payload não-Meta", () => {
    const semReferral = { entry: [{ changes: [{ value: { messages: [{ ...msg, referral: undefined }] } }] }] };
    expect(describeReferralProbe(semReferral).has_referral).toBe(false);
    expect(describeReferralProbe({ foo: 1 })).toEqual({ has_referral: false, message_shape: null });
    expect(describeReferralProbe(null)).toEqual({ has_referral: false, message_shape: null });
  });

  it("describeCapturedReferral: forma do referral, sem valor", () => {
    const out = describeCapturedReferral({
      provider: "datafy",
      outcome: "inserted",
      referral: referral({ raw: msg.referral, ctwaClid: msg.referral.ctwa_clid }),
      rawOmittedReason: null,
    });
    expect(out).toMatchObject({
      provider: "datafy",
      outcome: "inserted",
      message_type: "text",
      referral_shape: { ctwa_clid: "string", source_id: "string", source_type: "string" },
      raw_omitted: null,
    });
    expect(vaza(out)).toEqual([]);
  });

  it("describeCapturedReferral de recusa carrega o motivo", () => {
    expect(describeCapturedReferral({ provider: "official", outcome: "rejected", referral: referral(), rejectReason: "message_id_mismatch" }))
      .toMatchObject({ outcome: "rejected", reason: "message_id_mismatch" });
  });

  it("CONTROLE POSITIVO: a mesma asserção reprova uma folha trocada por String(value)", () => {
    const folhaQueVaza = (v: unknown): unknown =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, folhaQueVaza(x)]))
        : String(v);
    expect(vaza({ message_shape: folhaQueVaza(msg) }).length).toBeGreaterThan(0);
  });
});

describe("normalizeTouchpointText", () => {
  it("não-string → null", () => {
    expect(normalizeTouchpointText(null, 10)).toBeNull();
    expect(normalizeTouchpointText(undefined, 10)).toBeNull();
  });
});
