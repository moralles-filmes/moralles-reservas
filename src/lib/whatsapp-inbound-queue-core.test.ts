import { describe, it, expect } from "vitest";
import {
  decideIngestionMode,
  decideAckVerdict,
  normalizeDeliveryId,
  deliveryDedupeKey,
  nextAttemptDelayMs,
  queuedEventVerdict,
  shouldPromoteToDead,
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
  type IngestionSource,
} from "../../supabase/functions/_shared/whatsapp-inbound-queue-core";
import {
  PROVIDER_CAPABILITIES,
  WEBHOOK_SIGNATURE_SCHEME,
  WHATSAPP_PROVIDER_NAMES,
  type WhatsAppProviderCapabilities,
  type WhatsAppProviderName,
} from "../../supabase/functions/_shared/whatsapp-provider-core.ts";

// Os casos das pernas de canal e flag rodam com reentrega DOCUMENTADA, para
// continuarem medindo o que mediam: com `unmeasured`, todos cairiam em `sync`
// pela perna da reentrega e ficariam verdes por motivo errado.
describe("decideIngestionMode — as pernas do gate, fail-closed", () => {
  it("async só quando origem é provider E reentrega documentada E flag ON E canal ON", () => {
    expect(decideIngestionMode({
      source: "provider", flagEnabled: true, flagReadFailed: false, channelEnabled: true,
      providerRedelivery: "documented",
    })).toBe("async");
  });

  it("flag OFF mantém o caminho síncrono de hoje", () => {
    expect(decideIngestionMode({
      source: "provider", flagEnabled: false, flagReadFailed: false, channelEnabled: true,
      providerRedelivery: "documented",
    })).toBe("sync");
  });

  it("canal não optado mantém o caminho síncrono, mesmo com a flag global ON", () => {
    expect(decideIngestionMode({
      source: "provider", flagEnabled: true, flagReadFailed: false, channelEnabled: false,
      providerRedelivery: "documented",
    })).toBe("sync");
  });

  it("coluna ausente (null/undefined) é tratada como não optada", () => {
    expect(decideIngestionMode({
      source: "provider", flagEnabled: true, flagReadFailed: false, channelEnabled: null,
      providerRedelivery: "documented",
    })).toBe("sync");
    expect(decideIngestionMode({
      source: "provider", flagEnabled: true, flagReadFailed: false, channelEnabled: undefined,
      providerRedelivery: "documented",
    })).toBe("sync");
  });

  it("falha ao LER a flag não vira OFF: devolve unknown, que o caller transforma em 503", () => {
    expect(decideIngestionMode({
      source: "provider", flagEnabled: false, flagReadFailed: true, channelEnabled: true,
      providerRedelivery: "documented",
    })).toBe("unknown");
  });

  // A perna da REENTREGA. Com a fila ligada, falha transitória ao gravar o
  // evento devolve 503 ao provider — e só a reentrega dele traz a mensagem de
  // volta. Provider sem reentrega aceita como premissa, se não reentregar, perde
  // a mensagem sem linha na fila, sem dead letter e sem contagem no painel.
  it("reentrega sem premissa aceita (`unmeasured`) processa síncrono, ainda que canal e flag estejam ON", () => {
    expect(decideIngestionMode({
      source: "provider", flagEnabled: true, flagReadFailed: false, channelEnabled: true,
      providerRedelivery: "unmeasured",
    })).toBe("sync");
  });

  // Tabela-verdade COMPLETA das entradas: é ela que prova "única porta". Um caso
  // isolado mostra que a porta abre, não que nenhuma outra combinação abre. As
  // listas saem de `Record<união, true>`, então valor novo em `IngestionSource`
  // ou em `inboundRedelivery` reprova no typecheck até entrar aqui.
  it("tabela-verdade: reentrega documentada, com canal e flag ON, é a única porta para async", () => {
    type Reentrega = WhatsAppProviderCapabilities["inboundRedelivery"];
    const ORIGENS = Object.keys(
      { provider: true, queue: true, sweep: true } satisfies Record<IngestionSource, true>,
    ) as IngestionSource[];
    const REENTREGAS: (Reentrega | undefined)[] = [
      ...(Object.keys(
        { documented: true, unmeasured: true } satisfies Record<Reentrega, true>,
      ) as Reentrega[]),
      undefined,
    ];
    const BOOLEANOS = [true, false];
    const CANAIS = [true, false, null, undefined];

    const divergencias: string[] = [];
    let asyncs = 0;
    let unknowns = 0;
    for (const source of ORIGENS)
      for (const flagEnabled of BOOLEANOS)
        for (const flagReadFailed of BOOLEANOS)
          for (const channelEnabled of CANAIS)
            for (const providerRedelivery of REENTREGAS) {
              const porta = source === "provider"
                && channelEnabled === true
                && providerRedelivery === "documented";
              const esperado = !porta
                ? "sync"
                : flagReadFailed ? "unknown" : flagEnabled ? "async" : "sync";
              const obtido = decideIngestionMode({
                source, flagEnabled, flagReadFailed, channelEnabled, providerRedelivery,
              });
              if (obtido === "async") asyncs++;
              if (obtido === "unknown") unknowns++;
              if (obtido !== esperado) {
                const entrada = [source, flagEnabled, flagReadFailed, channelEnabled, providerRedelivery]
                  .map(String).join(" / ");
                divergencias.push(`${entrada} → ${obtido}, esperado ${esperado}`);
              }
            }

    expect(divergencias).toEqual([]);
    expect(asyncs, "async em mais de uma combinação").toBe(1);
    // As duas: flag ilegível com `flagEnabled` true e false.
    expect(unknowns, "unknown fora de provider + canal ON + documented + flag ilegível").toBe(2);
  });

  it("reentrega NÃO declarada (undefined) é sync: sem declaração, não há premissa de reentrega", () => {
    expect(decideIngestionMode({
      source: "provider", flagEnabled: true, flagReadFailed: false, channelEnabled: true,
      providerRedelivery: undefined,
    })).toBe("sync");
  });

  // A reentrega é entrada CERTA (vem do registry, em código), então decide
  // antes da flag, que é a única incerta. Um canal legado optado por engano não
  // pode receber 503 por causa de um soluço de leitura de `platform_flags`.
  it("reentrega `unmeasured` + flag ILEGÍVEL continua sync, não unknown", () => {
    expect(decideIngestionMode({
      source: "provider", flagEnabled: false, flagReadFailed: true, channelEnabled: true,
      providerRedelivery: "unmeasured",
    })).toBe("sync");
  });

  // A ORDEM das pernas é load-bearing: o CERTO (`channelEnabled`, coluna
  // `not null default false`) decide antes do INCERTO (a flag). Com a ordem
  // invertida, um soluço de leitura de `platform_flags` devolvia `unknown` → 503
  // em todo inbound de TODO canal, inclusive dos legados com o gate desligado —
  // a loja em produção parava por causa de uma tabela sem relação com ela.
  it("canal não optado + flag ILEGÍVEL continua sync: o certo decide antes do incerto", () => {
    expect(decideIngestionMode({
      source: "provider", flagEnabled: false, flagReadFailed: true, channelEnabled: false,
      providerRedelivery: "documented",
    })).toBe("sync");
    expect(decideIngestionMode({
      source: "provider", flagEnabled: true, flagReadFailed: true, channelEnabled: null,
      providerRedelivery: "documented",
    })).toBe("sync");
  });

  // Contraparte do caso acima, e é ela que mostra que a inversão NÃO afrouxou o
  // fail-closed: com o canal optado, flag ilegível segue em 503.
  it("canal optado + flag ilegível continua unknown — o fail-closed fica onde importa", () => {
    expect(decideIngestionMode({
      source: "provider", flagEnabled: false, flagReadFailed: true, channelEnabled: true,
      providerRedelivery: "documented",
    })).toBe("unknown");
  });

  // CONTROLE POSITIVO do anti-laço (Review Focus #3). Se alguém remover a
  // checagem de `source`, este teste falha — é o único guardião contra
  // reinserção infinita de eventos.
  it("origem 'queue' NUNCA é async, ainda que todas as pernas do gate estejam ON", () => {
    expect(decideIngestionMode({
      source: "queue", flagEnabled: true, flagReadFailed: false, channelEnabled: true,
      providerRedelivery: "documented",
    })).toBe("sync");
  });

  it("origem 'sweep' NUNCA é async", () => {
    expect(decideIngestionMode({
      source: "sweep", flagEnabled: true, flagReadFailed: false, channelEnabled: true,
      providerRedelivery: "documented",
    })).toBe("sync");
  });
});

// O valor por provider é o que de fato chega ao gate. Os casos acima usam
// literais e não reprovam se alguém declarar `documented` para um legado sem
// validar a premissa — é ESTE bloco que reprova.
describe("inboundRedelivery no registry — só reentrega documentada entra na fila", () => {
  // A da Datafy é publicada por ela (3×) e aceita como premissa, ainda não
  // medida contra o provider real. Os quatro legados não têm premissa aceita —
  // inclusive a Meta, que publica política de retry: ali é escolha, não lacuna.
  const REENTREGA_ESPERADA = {
    datafy: "documented",
    zapi: "unmeasured",
    waha: "unmeasured",
    uazapi: "unmeasured",
    official: "unmeasured",
  } as const satisfies Record<WhatsAppProviderName, WhatsAppProviderCapabilities["inboundRedelivery"]>;

  it.each(WHATSAPP_PROVIDER_NAMES)("%s declara a reentrega que de fato foi documentada", (name) => {
    expect(PROVIDER_CAPABILITIES[name].inboundRedelivery).toBe(REENTREGA_ESPERADA[name]);
  });

  it.each(WHATSAPP_PROVIDER_NAMES)("canal %s optado com flag ON: só reentrega documentada vira async", (name) => {
    expect(decideIngestionMode({
      source: "provider", flagEnabled: true, flagReadFailed: false, channelEnabled: true,
      providerRedelivery: PROVIDER_CAPABILITIES[name].inboundRedelivery,
    })).toBe(name === "datafy" ? "async" : "sync");
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

describe("shouldPromoteToDead — a MESMA pergunta nos dois momentos em que é feita", () => {
  it("com degrau disponível, não promove", () => {
    expect(shouldPromoteToDead(0)).toBe(false);
    expect(shouldPromoteToDead(INBOUND_MAX_ATTEMPTS - 1)).toBe(false);
  });

  it("esgotadas as tentativas, promove", () => {
    expect(shouldPromoteToDead(INBOUND_MAX_ATTEMPTS)).toBe(true);
    expect(shouldPromoteToDead(99)).toBe(true);
  });

  // Entrada impossível (o banco escreve `attempts`, que é `not null` e só
  // cresce) cai no lado SEGURO: promove. A alternativa — "não sei, então
  // processa" — devolveria a linha para o laço que esta peça existe para
  // fechar.
  it("entrada absurda promove, em vez de devolver a linha ao laço", () => {
    expect(shouldPromoteToDead(-1)).toBe(true);
    expect(shouldPromoteToDead(Number.NaN)).toBe(true);
  });

  // CONTROLE POSITIVO da concordância. O processador pergunta ANTES de
  // trabalhar e `queuedEventVerdict` pergunta DEPOIS do desfecho: se os dois
  // discordassem num degrau, existiria uma linha que o processador recusa e o
  // veredito manda retentar — devida para sempre, que é o defeito original por
  // outra porta. Quem trocar um dos dois por um limite próprio reprova aqui.
  it("concorda degrau a degrau com o que queuedEventVerdict faz numa falha transitória", () => {
    for (let attempts = 0; attempts <= INBOUND_MAX_ATTEMPTS + 2; attempts++) {
      const verdict = queuedEventVerdict({ httpStatus: 500, attempts });
      expect(verdict.status === "dead", `attempts=${attempts}`)
        .toBe(shouldPromoteToDead(attempts));
    }
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

  // ─── A QUARTA CLASSE: ESGOTOU SEM NUNCA CHEGAR A UM VEREDITO ──────────────
  //
  // É a linha envenenada por DURAÇÃO: o worker é retirado no meio, nada
  // finaliza, o lease vence, o takeover serve a linha de novo. Antes de o claim
  // gastar tentativa, ela NUNCA chegava a `dead` — e como a purga só alcança
  // `done`/`dead`, o corpo cru (PII) ficava retido indefinidamente.
  it("esgotada ANTES de processar termina em dead e pede handoff, sem retentativa", () => {
    expect(queuedEventVerdict({
      httpStatus: null,
      attempts: INBOUND_MAX_ATTEMPTS,
      exhaustedBeforeProcessing: true,
    })).toEqual({
      status: "dead",
      outcome: "queue_dead_letter_no_verdict",
      retryDelaySeconds: null,
      promoteToHandoff: true,
    });
  });

  // CONTROLE POSITIVO do outcome próprio. Reusar `queue_dead_letter` para os
  // dois apagaria a única pista que os distingue: "consumiu as tentativas sem
  // nunca chegar a um veredito" manda investigar duração e wall clock; "o
  // pipeline respondeu não-2xx N vezes" manda investigar o pipeline. Quem
  // unificar os nomes reprova aqui.
  it("o outcome distingue 'morreu sem veredito' de 'respondeu não-2xx N vezes'", () => {
    const semVeredito = queuedEventVerdict({
      httpStatus: null,
      attempts: INBOUND_MAX_ATTEMPTS,
      exhaustedBeforeProcessing: true,
    });
    const comVeredito = queuedEventVerdict({
      httpStatus: 500,
      attempts: INBOUND_MAX_ATTEMPTS,
    });
    expect(semVeredito.status).toBe(comVeredito.status);
    expect(semVeredito.promoteToHandoff).toBe(comVeredito.promoteToHandoff);
    expect(semVeredito.outcome).not.toBe(comVeredito.outcome);
  });

  // A bandeira responde uma pergunta que só existe quando NÃO houve requisição,
  // então `attempts` abaixo do teto não a desarma: quem a passa já sabe que a
  // linha chegou sem degrau. Ausente ou `false`, nada muda — é o caminho dos
  // quatro providers legados e de todo desfecho normal.
  it("ausente ou false não muda veredito nenhum", () => {
    expect(queuedEventVerdict({ httpStatus: 200, attempts: 0, exhaustedBeforeProcessing: false }))
      .toEqual(queuedEventVerdict({ httpStatus: 200, attempts: 0 }));
    expect(queuedEventVerdict({ httpStatus: 500, attempts: 0, exhaustedBeforeProcessing: false }))
      .toEqual(queuedEventVerdict({ httpStatus: 500, attempts: 0 }));
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
    expect(parseSelectedEventIds([a, b])).toEqual({ ids: [a, b], descartados: 0 });
  });

  it("array de objetos com `id` também é aceito", () => {
    expect(parseSelectedEventIds([{ id: a }, { id: b }])).toEqual({ ids: [a, b], descartados: 0 });
  });

  // A alternativa plausível: PostgREST nomeando a coluna pela função.
  it("array de objetos de uma chave só, com o nome da função, também é aceito", () => {
    expect(parseSelectedEventIds([
      { select_due_whatsapp_inbound_events: a },
      { select_due_whatsapp_inbound_events: b },
    ])).toEqual({ ids: [a, b], descartados: 0 });
  });

  it("nada devido devolve lista vazia SEM descarte — fila vazia não é anomalia", () => {
    expect(parseSelectedEventIds([])).toEqual({ ids: [], descartados: 0 });
    expect(parseSelectedEventIds(null)).toEqual({ ids: [], descartados: 0 });
    expect(parseSelectedEventIds(undefined)).toEqual({ ids: [], descartados: 0 });
  });

  // Chamar o claim com lixo só gastaria ida ao banco.
  it("item que não carrega id nenhum é descartado, não inventado", () => {
    const r = parseSelectedEventIds([a, "", "   ", 42, null, {}, { id: 7 }]);
    expect(r.ids).toEqual([a]);
    expect(r.descartados).toBe(6);
  });

  // ─── O CANÁRIO ───────────────────────────────────────────────────────────
  // Uma forma imprevista não produz erro: o PostgREST devolve 200 e a varredura
  // devolveria `{"processed":0}` para sempre, com a fila cheia, 1440 vezes por
  // dia, parecendo "não havia nada a fazer". `descartados` é o ÚNICO sinal.
  it("forma imprevista conta descarte em vez de se passar por fila vazia", () => {
    const r = parseSelectedEventIds([{ evento: { id: a } }, { evento: { id: b } }]);
    expect(r.ids).toEqual([]);
    expect(r.descartados).toBe(2);
  });

  it("corpo que não é array nem nulo também conta como descarte", () => {
    expect(parseSelectedEventIds({ rows: [a] })).toEqual({ ids: [], descartados: 1 });
    expect(parseSelectedEventIds("erro")).toEqual({ ids: [], descartados: 1 });
  });

  // Exige FORMA de uuid, não "primeira string": um objeto com várias chaves
  // entregaria um timestamp ou um status como se fosse id, e o claim seria
  // chamado com lixo — devolvendo zero linhas, indistinguível de "não era
  // reivindicável".
  it("não aceita a primeira string qualquer como id", () => {
    const r = parseSelectedEventIds([{ status: "received", criado: "2026-09-25", id: a }]);
    expect(r.ids).toEqual([a]);
    expect(parseSelectedEventIds([{ status: "received", criado: "2026-09-25" }]))
      .toEqual({ ids: [], descartados: 1 });
  });
});
