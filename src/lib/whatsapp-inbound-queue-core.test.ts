import { describe, it, expect } from "vitest";
import {
  decideIngestionMode,
  decideAckVerdict,
  normalizeDeliveryId,
  deliveryDedupeKey,
  nextAttemptDelayMs,
  agentDeadlineVerdict,
  lockTtlSecondsRequired,
  encodeRawBodyHex,
  decodeRawBodyHex,
  DATAFY_DELIVERY_ID_HEADER,
  SIGNATURE_HEADER_BY_SCHEME,
  INBOUND_RETRY_DELAYS_MS,
  INBOUND_MAX_ATTEMPTS,
  AGENT_SOFT_DEADLINE_MS,
} from "../../supabase/functions/_shared/whatsapp-inbound-queue-core";
import {
  WEBHOOK_SIGNATURE_SCHEME,
  WHATSAPP_PROVIDER_NAMES,
} from "../../supabase/functions/_shared/whatsapp-provider-core.ts";

describe("decideIngestionMode — as duas pernas do gate, fail-closed", () => {
  it("async só quando origem é provider E flag ON E canal ON", () => {
    expect(decideIngestionMode({
      source: "provider", flagEnabled: true, flagReadFailed: false, channelEnabled: true,
    })).toBe("async");
  });

  it("flag OFF mantém o caminho síncrono de hoje", () => {
    expect(decideIngestionMode({
      source: "provider", flagEnabled: false, flagReadFailed: false, channelEnabled: true,
    })).toBe("sync");
  });

  it("canal não optado mantém o caminho síncrono, mesmo com a flag global ON", () => {
    expect(decideIngestionMode({
      source: "provider", flagEnabled: true, flagReadFailed: false, channelEnabled: false,
    })).toBe("sync");
  });

  it("coluna ausente (null/undefined) é tratada como não optada", () => {
    expect(decideIngestionMode({
      source: "provider", flagEnabled: true, flagReadFailed: false, channelEnabled: null,
    })).toBe("sync");
    expect(decideIngestionMode({
      source: "provider", flagEnabled: true, flagReadFailed: false, channelEnabled: undefined,
    })).toBe("sync");
  });

  it("falha ao LER a flag não vira OFF: devolve unknown, que o caller transforma em 503", () => {
    expect(decideIngestionMode({
      source: "provider", flagEnabled: false, flagReadFailed: true, channelEnabled: true,
    })).toBe("unknown");
  });

  // CONTROLE POSITIVO do anti-laço (Review Focus #3). Se alguém remover a
  // checagem de `source`, este teste falha — é o único guardião contra
  // reinserção infinita de eventos.
  it("origem 'queue' NUNCA é async, ainda que as duas pernas do gate estejam ON", () => {
    expect(decideIngestionMode({
      source: "queue", flagEnabled: true, flagReadFailed: false, channelEnabled: true,
    })).toBe("sync");
  });

  it("origem 'sweep' NUNCA é async", () => {
    expect(decideIngestionMode({
      source: "sweep", flagEnabled: true, flagReadFailed: false, channelEnabled: true,
    })).toBe("sync");
  });
});

describe("decideAckVerdict — 200 é 'está durável ou foi descartado'; 503 é 'não guardei'", () => {
  it("modo sync não opina sobre o ACK: o pipeline de hoje decide", () => {
    expect(decideAckVerdict({ mode: "sync", insert: "skipped" }))
      .toEqual({ kind: "passthrough" });
  });

  it("inserido devolve 200", () => {
    expect(decideAckVerdict({ mode: "async", insert: "inserted" }))
      .toEqual({ kind: "ack", status: 200, outcome: "queued" });
  });

  it("entrega duplicada devolve 200 sem reprocessar", () => {
    expect(decideAckVerdict({ mode: "async", insert: "duplicate" }))
      .toEqual({ kind: "ack", status: 200, outcome: "queue_duplicate_delivery" });
  });

  it("INSERT que falhou devolve 503 — jamais 200, que apagaria o inbound", () => {
    expect(decideAckVerdict({ mode: "async", insert: "failed" }))
      .toEqual({ kind: "retry", status: 503, outcome: "queue_insert_failed" });
  });

  it("gate ilegível devolve 503, não passthrough", () => {
    expect(decideAckVerdict({ mode: "unknown", insert: "skipped" }))
      .toEqual({ kind: "retry", status: 503, outcome: "queue_gate_unreadable" });
  });
});

describe("normalizeDeliveryId — vazio não pode virar chave de dedupe (Review Focus #2)", () => {
  it("string normal passa", () => {
    expect(normalizeDeliveryId("d290f1ee-6c54-4b01-90e6-d701748f0851"))
      .toBe("d290f1ee-6c54-4b01-90e6-d701748f0851");
  });

  it("vazio, espaço e null viram null", () => {
    expect(normalizeDeliveryId("")).toBeNull();
    expect(normalizeDeliveryId("   ")).toBeNull();
    expect(normalizeDeliveryId(null)).toBeNull();
    expect(normalizeDeliveryId(undefined)).toBeNull();
  });

  it("apara espaço nas bordas em vez de gravar a versão suja", () => {
    expect(normalizeDeliveryId("  abc  ")).toBe("abc");
  });

  it("id absurdamente longo é recusado em vez de estourar a coluna", () => {
    expect(normalizeDeliveryId("x".repeat(513))).toBeNull();
  });
});

describe("deliveryDedupeKey — só a Datafy declara id de entrega hoje", () => {
  const get = (map: Record<string, string>) => (name: string) => map[name.toLowerCase()] ?? null;

  it("datafy lê x-datafy-delivery-id", () => {
    expect(deliveryDedupeKey("datafy", get({ "x-datafy-delivery-id": "abc" }))).toBe("abc");
  });

  it("providers legados não têm id de entrega: processed_messages segue a autoridade", () => {
    for (const p of ["zapi", "waha", "uazapi", "official"]) {
      expect(deliveryDedupeKey(p, get({ "x-datafy-delivery-id": "abc" }))).toBeNull();
    }
  });

  it("datafy sem o header devolve null em vez de inventar chave", () => {
    expect(deliveryDedupeKey("datafy", get({}))).toBeNull();
  });

  it("o nome do header é constante exportada, não literal repetido no webhook", () => {
    expect(DATAFY_DELIVERY_ID_HEADER).toBe("x-datafy-delivery-id");
    expect(deliveryDedupeKey("datafy", get({ [DATAFY_DELIVERY_ID_HEADER]: "abc" }))).toBe("abc");
  });
});

describe("encodeRawBodyHex — o corpo cru precisa sobreviver byte a byte", () => {
  it("corpo comum vira hex do UTF-8", () => {
    expect(encodeRawBodyHex('{"a":1}')).toBe("\\x7b2261223a317d");
  });

  it("NUL no meio do corpo não quebra e não é descartado (Review Focus #1)", () => {
    expect(encodeRawBodyHex("a\u0000b")).toBe("\\x610062");
  });

  it("acentuação PT-BR sobrevive", () => {
    expect(encodeRawBodyHex("ã")).toBe("\\xc3a3");
  });

  it("round-trip devolve o texto idêntico, inclusive com NUL", () => {
    for (const s of ['{"a":1}', "a\u0000b", "ã é ç", "🍣"]) {
      expect(decodeRawBodyHex(encodeRawBodyHex(s))).toBe(s);
    }
  });

  it("decodifica também sem o prefixo, porque o PostgREST pode entregar de qualquer forma", () => {
    expect(decodeRawBodyHex("7b2261223a317d")).toBe('{"a":1}');
  });

  it("corpo vazio não vira literal inválido", () => {
    expect(encodeRawBodyHex("")).toBe("\\x");
    expect(decodeRawBodyHex("\\x")).toBe("");
  });
});

describe("SIGNATURE_HEADER_BY_SCHEME — auditoria, nunca autoridade", () => {
  it("todo esquema em uso tem header declarado", () => {
    for (const name of WHATSAPP_PROVIDER_NAMES) {
      const scheme = WEBHOOK_SIGNATURE_SCHEME[name];
      expect(SIGNATURE_HEADER_BY_SCHEME[scheme], `sem header: ${scheme}`).toBeTruthy();
    }
  });

  it("os três headers são os que os validadores de fato leem", () => {
    expect(SIGNATURE_HEADER_BY_SCHEME.meta_app_secret).toBe("x-hub-signature-256");
    expect(SIGNATURE_HEADER_BY_SCHEME.datafy_whsec).toBe("x-datafy-signature-256");
    expect(SIGNATURE_HEADER_BY_SCHEME.channel_secret).toBe("x-webhook-secret");
  });
});

describe("nextAttemptDelayMs — curto e raso: resposta atrasada é resposta errada", () => {
  it("segue a escada declarada", () => {
    expect(nextAttemptDelayMs(0)).toBe(INBOUND_RETRY_DELAYS_MS[0]);
    expect(nextAttemptDelayMs(1)).toBe(INBOUND_RETRY_DELAYS_MS[1]);
    expect(nextAttemptDelayMs(2)).toBe(INBOUND_RETRY_DELAYS_MS[2]);
  });

  it("esgotadas as tentativas devolve null, que significa dead", () => {
    expect(nextAttemptDelayMs(INBOUND_MAX_ATTEMPTS)).toBeNull();
    expect(nextAttemptDelayMs(99)).toBeNull();
  });

  // CONTROLE POSITIVO: a janela total é curta DE PROPÓSITO. Se alguém
  // reintroduzir a escada de horas do notification_outbox, este teste falha.
  it("a janela total fica abaixo de 10 minutos", () => {
    const total = INBOUND_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThan(10 * 60_000);
  });
});

describe("agentDeadlineVerdict — suave: não começa rodada nova, não aborta a em curso", () => {
  it("dentro do orçamento, continua", () => {
    expect(agentDeadlineVerdict({ startedAt: 1_000, now: 1_000 + AGENT_SOFT_DEADLINE_MS - 1 }))
      .toBe("continue");
  });

  it("no limite exato, para de começar rodada nova", () => {
    expect(agentDeadlineVerdict({ startedAt: 1_000, now: 1_000 + AGENT_SOFT_DEADLINE_MS }))
      .toBe("stop_new_rounds");
  });

  it("relógio andando para trás não libera orçamento infinito", () => {
    expect(agentDeadlineVerdict({ startedAt: 5_000, now: 1_000 })).toBe("continue");
  });
});

describe("lockTtlSecondsRequired — o TTL do lock deixa de ser adivinhado", () => {
  // Este é o teste que fecha o achado da medição: AI_LOCK_TTL_SECONDS = 90
  // foi dimensionado contra "~51s de pior caso do runOnce", que era pior caso
  // de UM turno, não do loop. Se alguém subir o orçamento sem subir o TTL,
  // isto falha.
  it("a aritmética cabe no TTL de 90 s que o webhook usa hoje", () => {
    expect(lockTtlSecondsRequired()).toBeLessThanOrEqual(90);
  });

  it("subir o orçamento sem subir o TTL é detectável", () => {
    expect(lockTtlSecondsRequired({ budgetMs: 300_000 })).toBeGreaterThan(90);
  });
});
