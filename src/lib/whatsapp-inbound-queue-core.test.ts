import { describe, it, expect } from "vitest";
import {
  decideIngestionMode,
  decideAckVerdict,
  normalizeDeliveryId,
  deliveryDedupeKey,
  nextAttemptDelayMs,
  queuedEventVerdict,
  agentDeadlineVerdict,
  lockTtlSecondsRequired,
  encodeRawBodyHex,
  decodeRawBodyHex,
  parseSelectedEventIds,
  providerDeclaresDeliveryId,
  sweepShouldStartAnother,
  DATAFY_DELIVERY_ID_HEADER,
  SIGNATURE_HEADER_BY_SCHEME,
  INBOUND_DEBOUNCE_WINDOW_MS,
  INBOUND_RETRY_DELAYS_MS,
  INBOUND_MAX_ATTEMPTS,
  AGENT_SOFT_DEADLINE_MS,
  SWEEP_SELECT_LIMIT,
  SWEEP_WALL_CLOCK_BUDGET_MS,
  WORST_CASE_QUEUED_EVENT_MS,
  WORST_SINGLE_TURN_MS,
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

  // A ORDEM das pernas é load-bearing: o CERTO (`channelEnabled`, coluna
  // `not null default false`) decide antes do INCERTO (a flag). Com a ordem
  // invertida, um soluço de leitura de `platform_flags` devolvia `unknown` → 503
  // em todo inbound de TODO canal, inclusive dos legados com o gate desligado —
  // a loja em produção parava por causa de uma tabela sem relação com ela.
  it("canal não optado + flag ILEGÍVEL continua sync: o certo decide antes do incerto", () => {
    expect(decideIngestionMode({
      source: "provider", flagEnabled: false, flagReadFailed: true, channelEnabled: false,
    })).toBe("sync");
    expect(decideIngestionMode({
      source: "provider", flagEnabled: true, flagReadFailed: true, channelEnabled: null,
    })).toBe("sync");
  });

  // Contraparte do caso acima, e é ela que mostra que a inversão NÃO afrouxou o
  // fail-closed: com o canal optado, flag ilegível segue em 503.
  it("canal optado + flag ilegível continua unknown — o fail-closed fica onde importa", () => {
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

  // O webhook faz a MESMA pergunta para decidir se instrumenta a forma do
  // header, e ela mora aqui em vez de virar um `if (provider)` novo lá.
  it("quem declara id de entrega é decisão do núcleo, não do webhook", () => {
    expect(providerDeclaresDeliveryId("datafy")).toBe(true);
    for (const p of ["zapi", "waha", "uazapi", "official", "inexistente"]) {
      expect(providerDeclaresDeliveryId(p), `não deveria declarar: ${p}`).toBe(false);
    }
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

  // O comentário da função jura que corpo corrompido não vira payload
  // silenciosamente diferente do que o provider assinou. Sem estes casos a
  // promessa era falsa: `parseInt("zz", 16)` é `NaN`, e `NaN` num `Uint8Array`
  // grava `0` sem erro nenhum — o byte trocado apareceria como um 401
  // inexplicável na revalidação do HMAC, não como erro na linha da fila.
  it("hex de comprimento ímpar estoura em vez de truncar", () => {
    expect(() => decodeRawBodyHex("\\x7b226")).toThrow(/odd_length/);
  });

  it("caractere não-hex estoura em vez de gravar zero", () => {
    expect(() => decodeRawBodyHex("\\x7bzz")).toThrow(/not_hex/);
    expect(() => decodeRawBodyHex("\\x7b 2")).toThrow(/not_hex/);
  });

  it("hex em maiúsculas é aceito: quem escolhe o caixa é o PostgREST, não nós", () => {
    expect(decodeRawBodyHex("\\x7B2261223A317D")).toBe('{"a":1}');
  });
});

describe("SIGNATURE_HEADER_BY_SCHEME — auditoria, nunca autoridade", () => {
  it("todo esquema em uso tem header declarado", () => {
    for (const name of WHATSAPP_PROVIDER_NAMES) {
      const scheme = WEBHOOK_SIGNATURE_SCHEME[name];
      expect(SIGNATURE_HEADER_BY_SCHEME[scheme], `sem header: ${scheme}`).toBeTruthy();
    }
  });

  // O NOME deste caso diz o que ele faz, e não mais do que faz: ele PINA o mapa,
  // comparando-o com literais escritos aqui. Ele NÃO lê `whatsapp-providers.ts`,
  // então renomear o header dentro de `validateMetaSignature` ou
  // `validateChannelSecret` não deixa nada vermelho. Isso é consciente: guarda
  // que lê fonte custa manutenção permanente, e a consequência da divergência é
  // `signature_header` gravado `null` numa coluna de AUDITORIA — nada decide
  // nada a partir dela. A entrada da Datafy é a única que não pode divergir,
  // porque vem da constante canônica de quem valida o header.
  it("pina os três valores do mapa (detecta mudança AQUI, não nos validadores)", () => {
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

describe("queuedEventVerdict — o veredito da linha da fila", () => {
  it("2xx encerra a linha em done, sem retentativa e sem handoff", () => {
    expect(queuedEventVerdict({ httpStatus: 200, attempts: 0 })).toEqual({
      status: "done",
      outcome: "queue_processed",
      retryDelaySeconds: null,
      promoteToHandoff: false,
    });
  });

  // Os desfechos que NÃO respondem nada ao cliente (canal inativo, handoff
  // humano, duplicata em processed_messages, callback de status) devolvem 200 no
  // pipeline porque são corretos. O 2xx é lido como faixa, não como `=== 200`.
  it("qualquer 2xx conta como processado, não só o 200 exato", () => {
    for (const status of [200, 201, 204, 299]) {
      expect(queuedEventVerdict({ httpStatus: status, attempts: 0 }).status, `status ${status}`)
        .toBe("done");
    }
  });

  // ─── CONTROLE POSITIVO 1 do 401 terminal ─────────────────────────────────
  // `attempts: 0` é onde a escada AINDA TEM degrau (30 s). Se alguém tirar o
  // ramo do 401, este caso cai na classe 3 e vira `received` com atraso — logo
  // ele é o que reprova "401 virou retentativa", e só ele.
  it("401 com escada disponível NÃO vira retentativa: é terminal em done", () => {
    expect(queuedEventVerdict({ httpStatus: 401, attempts: 0 })).toEqual({
      status: "done",
      outcome: "queue_unauthorized_terminal",
      retryDelaySeconds: null,
      promoteToHandoff: false,
    });
  });

  // ─── CONTROLE POSITIVO 2 do 401 terminal ─────────────────────────────────
  // `attempts: INBOUND_MAX_ATTEMPTS` é onde a escada ESGOTOU. Sem o ramo do
  // 401, este caso cai em `dead` + handoff — e `dead` retém o corpo cru (PII)
  // por 30 dias em vez de 7. É este caso, e só ele, que reprova "401 virou
  // dead".
  it("401 com escada esgotada também termina em done, nunca em dead (o corpo cru é PII)", () => {
    const verdict = queuedEventVerdict({ httpStatus: 401, attempts: INBOUND_MAX_ATTEMPTS });
    expect(verdict.status).toBe("done");
    expect(verdict.status).not.toBe("dead");
    expect(verdict.promoteToHandoff).toBe(false);
    expect(verdict.outcome).toBe("queue_unauthorized_terminal");
  });

  it("não-2xx que não é 401 desce a escada, em SEGUNDOS (o banco escreve o instante)", () => {
    expect(queuedEventVerdict({ httpStatus: 503, attempts: 0 })).toEqual({
      status: "received",
      outcome: "queue_retry_scheduled",
      retryDelaySeconds: INBOUND_RETRY_DELAYS_MS[0] / 1000,
      promoteToHandoff: false,
    });
    expect(queuedEventVerdict({ httpStatus: 500, attempts: 1 }).retryDelaySeconds)
      .toBe(INBOUND_RETRY_DELAYS_MS[1] / 1000);
    expect(queuedEventVerdict({ httpStatus: 500, attempts: 2 }).retryDelaySeconds)
      .toBe(INBOUND_RETRY_DELAYS_MS[2] / 1000);
  });

  // Exceção antes de haver resposta — corpo cru corrompido (`decodeRawBodyHex`
  // estoura), rede caindo no meio. Mesma classe do não-2xx transitório.
  it("exceção sem resposta (httpStatus null) também desce a escada", () => {
    expect(queuedEventVerdict({ httpStatus: null, attempts: 0 }).status).toBe("received");
    expect(queuedEventVerdict({ httpStatus: null, attempts: 0 }).retryDelaySeconds)
      .toBe(INBOUND_RETRY_DELAYS_MS[0] / 1000);
  });

  it("escada esgotada em falha transitória vira dead E pede handoff", () => {
    expect(queuedEventVerdict({ httpStatus: 500, attempts: INBOUND_MAX_ATTEMPTS })).toEqual({
      status: "dead",
      outcome: "queue_dead_letter",
      retryDelaySeconds: null,
      promoteToHandoff: true,
    });
    expect(queuedEventVerdict({ httpStatus: null, attempts: 99 }).promoteToHandoff).toBe(true);
  });

  // 503 é o Vault da UazAPI indisponível; 500 é o catch externo. Os dois são
  // transitórios de verdade. Alargar o terminal para `>= 400` os transformaria
  // em descarte silencioso, e o inbound do cliente sumiria.
  it("503 e 500 NÃO são terminais — alargar o 401 para a faixa 4xx/5xx seria descarte", () => {
    expect(queuedEventVerdict({ httpStatus: 503, attempts: 0 }).status).not.toBe("done");
    expect(queuedEventVerdict({ httpStatus: 500, attempts: 0 }).status).not.toBe("done");
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

describe("sweepShouldStartAnother — a varredura para de COMEÇAR, nunca aborta o em curso", () => {
  const t0 = 1_000_000;
  /** O instante em que ainda sobra EXATAMENTE a reserva do pior caso. */
  const ultimoInstanteQueCabe = t0 + SWEEP_WALL_CLOCK_BUDGET_MS - WORST_CASE_QUEUED_EVENT_MS;

  // Uma varredura que não processa nada nunca esvazia a fila. O custo máximo de
  // começar a primeira é o worker morrer no meio dela — e o lease de 90 s cobre.
  it("a primeira linha começa SEMPRE, ainda que o orçamento já tivesse estourado", () => {
    expect(sweepShouldStartAnother({
      startedAt: t0,
      now: t0 + 10 * SWEEP_WALL_CLOCK_BUDGET_MS,
      processed: 0,
    })).toBe(true);
  });

  it("no início, com orçamento inteiro, começa outra", () => {
    expect(sweepShouldStartAnother({ startedAt: t0, now: t0 + 1_000, processed: 1 }))
      .toBe(true);
  });

  it("no último instante em que a reserva cabe inteira, ainda começa", () => {
    expect(sweepShouldStartAnother({ startedAt: t0, now: ultimoInstanteQueCabe, processed: 3 }))
      .toBe(true);
  });

  // (a) do requisito: orçamento quase esgotado devolve `false` MESMO com linhas
  // sobrando. As linhas não começadas não foram reivindicadas — ficam para o
  // minuto seguinte, sem lease preso e sem tentativa gasta.
  it("um milissegundo depois, recusa — ainda que haja linha devida sobrando", () => {
    expect(sweepShouldStartAnother({ startedAt: t0, now: ultimoInstanteQueCabe + 1, processed: 3 }))
      .toBe(false);
  });

  // ─── CONTROLE POSITIVO: a reserva é do PIOR CASO, não de uma média ────────
  // A média é o que faz o worker morrer no meio: evento de fila é quase sempre
  // rápido (duplicata, callback de status, canal inativo), e é justamente o
  // lento que precisa caber inteiro no que resta. Este caso escolhe o instante
  // em que sobra exatamente uma "média" — se alguém trocar
  // `WORST_CASE_QUEUED_EVENT_MS` por um número dessa ordem, a função passa a
  // devolver `true` aqui e este teste reprova.
  it("reserva o PIOR caso: onde uma média caberia, a decisão ainda é não começar", () => {
    const mediaOtimista = 10_000;
    expect(mediaOtimista).toBeLessThan(WORST_CASE_QUEUED_EVENT_MS);
    expect(sweepShouldStartAnother({
      startedAt: t0,
      now: t0 + SWEEP_WALL_CLOCK_BUDGET_MS - mediaOtimista,
      processed: 1,
    })).toBe(false);
  });

  it("relógio andando para trás não cala a varredura", () => {
    expect(sweepShouldStartAnother({ startedAt: t0, now: t0 - 5_000, processed: 1 })).toBe(true);
  });

  // Se a reserva não coubesse no orçamento, a varredura NUNCA começaria um
  // segundo evento e a fila andaria a uma linha por minuto.
  it("o pior caso de um evento cabe no orçamento, com folga para mais de um", () => {
    expect(WORST_CASE_QUEUED_EVENT_MS).toBeLessThan(SWEEP_WALL_CLOCK_BUDGET_MS);
  });

  // A reserva é DERIVADA: debounce + a mesma aritmética do TTL do lock de
  // conversa (orçamento do laço + um turno de pior caso + a folga de envio).
  // Quem subir o orçamento do agente sobe a reserva junto — este caso é o que
  // reprova quem transformar a derivação num literal.
  it("a reserva é derivada do debounce mais a aritmética do TTL do lock", () => {
    expect(WORST_CASE_QUEUED_EVENT_MS)
      .toBe(INBOUND_DEBOUNCE_WINDOW_MS + lockTtlSecondsRequired() * 1000);
    // Um turno só não é o pior caso: o deadline é SUAVE, então uma rodada
    // iniciada no último milissegundo do orçamento ainda roda inteira.
    expect(WORST_CASE_QUEUED_EVENT_MS).toBeGreaterThan(
      INBOUND_DEBOUNCE_WINDOW_MS + WORST_SINGLE_TURN_MS,
    );
  });

  // O `least(coalesce(p_limit, 20), 100)` da migration 113 é o outro lado deste
  // número; pedir mais que o teto do banco seria pedir o que ele não dá.
  it("o limite pedido por varredura respeita o teto que o banco impõe", () => {
    expect(SWEEP_SELECT_LIMIT).toBeGreaterThan(0);
    expect(SWEEP_SELECT_LIMIT).toBeLessThanOrEqual(100);
  });
});

describe("parseSelectedEventIds — a forma do retorno é do PostgREST, não nossa", () => {
  const a = "11111111-1111-1111-1111-111111111111";
  const b = "22222222-2222-2222-2222-222222222222";

  it("array de escalares (a forma esperada de `returns setof uuid`)", () => {
    expect(parseSelectedEventIds([a, b])).toEqual([a, b]);
  });

  it("array de objetos com `id` também é aceito", () => {
    expect(parseSelectedEventIds([{ id: a }, { id: b }])).toEqual([a, b]);
  });

  // A alternativa plausível: PostgREST nomeando a coluna pela função.
  it("array de objetos de uma chave só, com o nome da função, também é aceito", () => {
    expect(parseSelectedEventIds([
      { select_due_whatsapp_inbound_events: a },
      { select_due_whatsapp_inbound_events: b },
    ])).toEqual([a, b]);
  });

  it("nada devido devolve lista vazia, e `null` não estoura", () => {
    expect(parseSelectedEventIds([])).toEqual([]);
    expect(parseSelectedEventIds(null)).toEqual([]);
    expect(parseSelectedEventIds(undefined)).toEqual([]);
  });

  // Chamar o claim com lixo só gastaria ida ao banco.
  it("item que não carrega id nenhum é descartado, não inventado", () => {
    expect(parseSelectedEventIds([a, "", "   ", 42, null, {}, { id: 7 }])).toEqual([a]);
  });
});
