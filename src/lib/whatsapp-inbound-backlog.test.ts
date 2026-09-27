import { describe, it, expect } from "vitest";
import {
  describeInboundBacklog,
  formatBacklogAge,
} from "./whatsapp-inbound-backlog";
import {
  INBOUND_MAX_ATTEMPTS,
  INBOUND_RETRY_DELAYS_MS,
  INBOUND_SWEEP_INTERVAL_MS,
  MAX_PENDING_BACKLOG_AGE_MS,
  WORST_CASE_QUEUED_EVENT_MS,
} from "../../supabase/functions/_shared/whatsapp-inbound-queue-core";

/**
 * O backlog da fila de inbound — o único número do diagnóstico que responde "o
 * pipeline está andando?".
 *
 * Por que ele existe: quem promove uma linha a `dead` é a VARREDURA, incrementando
 * `attempts` (takeover do claim e finalização, migration 113 — não há terceiro
 * escritor). Varredura parada nunca alcança `dead`, então `dead_letter: 0` é
 * verdade e é inútil. Aqui se mede o que sobra: quantas linhas não-terminais
 * existem e há quanto tempo a mais antiga está lá.
 */

const AGORA = "2026-09-27T12:00:00.000Z";
const emAtraso = (ms: number) => new Date(Date.parse(AGORA) - ms).toISOString();

describe("MAX_PENDING_BACKLOG_AGE_MS é derivado, não digitado", () => {
  const ESCADA = INBOUND_RETRY_DELAYS_MS.reduce((soma, ms) => soma + ms, 0);

  it("cobre a escada inteira com folga — senão acusaria fila que só espera", () => {
    // A linha passa `ESCADA` ms legitimamente ESPERANDO (30 + 120 + 300 s). Um
    // limite igual ou menor que isso chamaria de parada toda entrega que está
    // simplesmente no segundo degrau.
    expect(MAX_PENDING_BACKLOG_AGE_MS).toBeGreaterThan(ESCADA);
  });

  it("inclui a granularidade do cron e o pior caso de processamento por claim", () => {
    // São `INBOUND_MAX_ATTEMPTS + 1` claims, não `INBOUND_MAX_ATTEMPTS`: o caminho
    // rápido (`waitUntil`) gasta o primeiro e o último promove a `dead` sem
    // processar. Sem a granularidade do cron, o limite mediria só a escada.
    const esperado =
      ESCADA
      + (INBOUND_MAX_ATTEMPTS + 1) * (INBOUND_SWEEP_INTERVAL_MS + WORST_CASE_QUEUED_EVENT_MS);
    expect(MAX_PENDING_BACKLOG_AGE_MS).toBe(esperado);
  });

  it("fica na casa dos minutos, não das horas — o sinal precisa chegar no mesmo dia", () => {
    // Cerca frouxa de propósito: prende a ordem de grandeza sem fingir medição.
    // Um limite de horas transformaria a detecção de uma varredura morta em algo
    // que só aparece no dia seguinte — o modo de falha que esta task fecha.
    expect(MAX_PENDING_BACKLOG_AGE_MS).toBeLessThan(60 * 60_000);
  });
});

describe("`count: null` é 'não consegui contar', nunca zero", () => {
  it("contagem nula devolve `unknown` e o valor `—`", () => {
    const v = describeInboundBacklog({ count: null, oldest_received_at: null }, AGORA);
    expect(v.kind).toBe("unknown");
    expect(v.value).toBe("—");
    expect(v.alarming).toBe(false);
  });

  it("a frase NEGA explicitamente a leitura de 'fila vazia'", () => {
    // É a confusão inteira que o `null` existe para evitar. Um texto que só
    // dissesse "sem dados" deixaria o admin concluir o negativo sozinho.
    const v = describeInboundBacklog({ count: null, oldest_received_at: null }, AGORA);
    expect(v.detail).toMatch(/não é o mesmo que fila vazia/i);
  });

  it("A CONTAGEM DECIDE ANTES DA DATA: nula com data nula NÃO é fila vazia", () => {
    // `oldest_received_at: null` é ambíguo por natureza — fila vazia e leitura
    // falha produzem o mesmo `null`. Se a ordem das perguntas inverter, este caso
    // cai em `empty` e o painel afirma saúde no instante em que ninguém sabe.
    expect(
      describeInboundBacklog({ count: null, oldest_received_at: null }, AGORA).kind,
    ).not.toBe("empty");
  });

  it("o bloco inteiro ausente também é `unknown`, não zero", () => {
    // EF antiga no ar: `pending` simplesmente não vem.
    expect(describeInboundBacklog(undefined, AGORA).kind).toBe("unknown");
    expect(describeInboundBacklog(null, AGORA).kind).toBe("unknown");
  });
});

describe("fila vazia é afirmação positiva, e só ela pode afirmar", () => {
  it("zero com data nula é `empty`", () => {
    const v = describeInboundBacklog({ count: 0, oldest_received_at: null }, AGORA);
    expect(v.kind).toBe("empty");
    expect(v.value).toBe("0");
    expect(v.alarming).toBe(false);
  });
});

describe("a idade é o SINAL; a contagem só dimensiona", () => {
  it("backlog recente é `draining` — rotina, sem alarme", () => {
    const v = describeInboundBacklog(
      { count: 3, oldest_received_at: emAtraso(90_000) },
      AGORA,
    );
    expect(v.kind).toBe("draining");
    expect(v.value).toBe("3");
    expect(v.alarming).toBe(false);
    expect(v.detail).toMatch(/drenando/i);
  });

  it("CONTAGEM ALTA E RECENTE NÃO É ALARME: rajada legítima não acusa parada", () => {
    // O ponto inteiro da idade. 500 linhas de 30 s é rajada; 1 linha de 3 h é
    // varredura morta. Um limiar sobre a contagem confundiria as duas.
    const v = describeInboundBacklog(
      { count: 500, oldest_received_at: emAtraso(30_000) },
      AGORA,
    );
    expect(v.kind).toBe("draining");
    expect(v.alarming).toBe(false);
  });

  it("UMA LINHA VELHA É ALARME: idade acusa o que contagem nenhuma acusaria", () => {
    const v = describeInboundBacklog(
      { count: 1, oldest_received_at: emAtraso(3 * 60 * 60_000) },
      AGORA,
    );
    expect(v.kind).toBe("stalled");
    expect(v.value).toBe("1");
    expect(v.alarming).toBe(true);
  });

  it("a fronteira é o limite derivado, e ela é inclusiva do lado bom", () => {
    // Exatamente no limite ainda é rotina: a escada pode ter acabado de terminar.
    expect(
      describeInboundBacklog(
        { count: 1, oldest_received_at: emAtraso(MAX_PENDING_BACKLOG_AGE_MS) },
        AGORA,
      ).kind,
    ).toBe("draining");
    expect(
      describeInboundBacklog(
        { count: 1, oldest_received_at: emAtraso(MAX_PENDING_BACKLOG_AGE_MS + 1_000) },
        AGORA,
      ).kind,
    ).toBe("stalled");
  });
});

describe("a copy de parada NOMEIA AS DUAS CAUSAS e diz onde olhar", () => {
  const PARADO = describeInboundBacklog(
    { count: 40, oldest_received_at: emAtraso(3 * 60 * 60_000) },
    AGORA,
  );

  it("nomeia a varredura parada E o backlog fundo — nunca só uma", () => {
    // É a lição que a contagem de `unauthorized_terminal` deste mesmo painel já
    // aprendeu: descrever uma causa só ensina o admin a ler o número como rotina e
    // parar de olhar. Aqui a segunda é real — backlog mais fundo que o que a
    // varredura serve por minuto demora mais que o limite mesmo com ela perfeita.
    expect(PARADO.detail).toMatch(/varredura não está rodando/i);
    expect(PARADO.detail).toMatch(/mais fundo que/i);
  });

  it("nomeia o modo de falha SILENCIOSO, que é o que ninguém procuraria sozinho", () => {
    // `pg_net` é fire-and-forget: um 401 desde uma rotação da chave interna não
    // reporta a ninguém. Sem isto na frase, o admin investiga a Edge Function.
    expect(PARADO.detail).toMatch(/pg_net/);
    expect(PARADO.detail).toMatch(/401/);
  });

  it("diz ONDE conferir, com nome de tabela e de job", () => {
    expect(PARADO.detail).toMatch(/net\._http_response/);
    expect(PARADO.detail).toMatch(/whatsapp-inbound-sweep/);
  });

  it("a frase NÃO afirma que a fila está ocupada — afirma que não drena", () => {
    // "A fila está ocupada" é a leitura errada disponível, e é a que faz o admin
    // esperar em vez de investigar.
    expect(PARADO.detail).toMatch(/não está drenando/i);
  });

  it("a idade sai na frase, porque é ela que justifica a conclusão", () => {
    expect(PARADO.detail).toContain("3 h");
    expect(PARADO.oldestAgeMs).toBe(3 * 60 * 60_000);
  });
});

describe("FAIL-OPEN no veredito, nunca na contagem", () => {
  it("data ilegível com contagem > 0 dimensiona sem concluir", () => {
    const v = describeInboundBacklog(
      { count: 7, oldest_received_at: "não é data" },
      AGORA,
    );
    expect(v.kind).toBe("age_unknown");
    expect(v.value).toBe("7");
    expect(v.alarming).toBe(false);
    // A contagem é o FATO e nenhum ramo a esconde.
    expect(v.detail).toMatch(/não pôde ser lida/i);
  });

  it("data nula com contagem > 0 também não vira alarme nem saúde", () => {
    const v = describeInboundBacklog({ count: 7, oldest_received_at: null }, AGORA);
    expect(v.kind).toBe("age_unknown");
    expect(v.value).toBe("7");
  });

  it("idade NEGATIVA (relógios divergentes) não acusa nada", () => {
    // `generated_at` do Deno contra `received_at` do Postgres pode dar negativo por
    // milissegundos. Alarme aqui seria alarme falso, e alarme falso mata o sinal.
    const v = describeInboundBacklog(
      { count: 2, oldest_received_at: new Date(Date.parse(AGORA) + 5_000).toISOString() },
      AGORA,
    );
    expect(v.kind).toBe("age_unknown");
    expect(v.alarming).toBe(false);
  });

  it("`now` ilegível não derruba a contagem", () => {
    const v = describeInboundBacklog(
      { count: 4, oldest_received_at: emAtraso(60_000) },
      "carimbo quebrado",
    );
    expect(v.value).toBe("4");
    expect(v.alarming).toBe(false);
  });
});

describe("formatBacklogAge", () => {
  it("abaixo de um minuto não finge precisão", () => {
    expect(formatBacklogAge(0)).toBe("menos de 1 min");
    expect(formatBacklogAge(59_999)).toBe("menos de 1 min");
  });

  it("arredonda PARA BAIXO, para nunca exagerar a idade que acusa", () => {
    // Exagerar a idade num número que dispara alarme é inventar gravidade.
    expect(formatBacklogAge(119_000)).toBe("1 min");
    expect(formatBacklogAge(3 * 60 * 60_000 + 59 * 60_000)).toBe("3 h");
  });

  it("minutos, horas e dias", () => {
    expect(formatBacklogAge(5 * 60_000)).toBe("5 min");
    expect(formatBacklogAge(59 * 60_000)).toBe("59 min");
    expect(formatBacklogAge(2 * 60 * 60_000)).toBe("2 h");
    expect(formatBacklogAge(50 * 60 * 60_000)).toBe("2 d");
  });
});
