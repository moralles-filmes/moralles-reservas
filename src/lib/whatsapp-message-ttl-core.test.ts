import { describe, it, expect } from "vitest";
import {
  decideMessageTtl,
  isProducerDefect,
  brtFactAt,
  MESSAGE_TTL_MS,
  type ExpirableMessageKind,
} from "../../supabase/functions/_shared/whatsapp-message-ttl-core.ts";

const FACT = "2026-09-03T12:00:00-03:00";
const FACT_MS = new Date(FACT).getTime();

/** Todos os kinds com prazo, lidos da própria fonte — nunca redigitados. */
const KINDS = Object.keys(MESSAGE_TTL_MS) as ExpirableMessageKind[];

describe("decideMessageTtl — fronteira de cada kind", () => {
  it.each(KINDS)("%s ainda vale no instante exato do vencimento", (kind) => {
    const r = decideMessageTtl({
      kind,
      factAt: FACT,
      now: FACT_MS + MESSAGE_TTL_MS[kind],
    });
    expect(r.decision).toBe("send");
    expect(r.reason).toBe("within_ttl");
  });

  it.each(KINDS)("%s vence um milissegundo depois do prazo", (kind) => {
    const r = decideMessageTtl({
      kind,
      factAt: FACT,
      now: FACT_MS + MESSAGE_TTL_MS[kind] + 1,
    });
    expect(r.decision).toBe("discard");
    expect(r.reason).toBe("expired");
  });

  it.each(KINDS)("%s vale bem antes do prazo", (kind) => {
    const r = decideMessageTtl({ kind, factAt: FACT, now: FACT_MS });
    expect(r.decision).toBe("send");
  });
});

describe("decideMessageTtl — o incidente de 2026-09-03", () => {
  // Controle NEGATIVO, e o mais importante do arquivo: as 88 mensagens do
  // incidente estavam válidas quando foram POSTADAS. Se algum dia este teste
  // passar a esperar "discard", alguém confundiu o papel desta peça com o do
  // gate de conexão — o TTL nunca teria barrado aquele despejo.
  it("lembrete postado no horário do worker, no dia da reserva, é válido", () => {
    const r = decideMessageTtl({
      kind: "reminder_d1",
      factAt: brtFactAt("2026-08-28", "20:00:00"),
      now: "2026-08-28T13:00:01Z", // 10h BRT, quando o cron roda
    });
    expect(r.decision).toBe("send");
  });

  it("mesmo lembrete, alcançado só no flush da reconexão, é descartado", () => {
    const r = decideMessageTtl({
      kind: "reminder_d1",
      factAt: brtFactAt("2026-08-28", "20:00:00"),
      now: "2026-09-03T17:12:41Z",
    });
    expect(r.decision).toBe("discard");
    expect(r.reason).toBe("expired");
  });

  it("aviso de fila de 02/09 não pode ser reenviado pelo painel em 03/09", () => {
    const r = decideMessageTtl({
      kind: "waitlist_entered",
      factAt: "2026-09-02T00:59:48-03:00",
      now: "2026-09-03T17:12:41Z",
    });
    expect(r.decision).toBe("discard");
  });
});

describe("decideMessageTtl — reserva vence em BRT, não em UTC", () => {
  // Reserva 03/09 às 20:00 BRT = 23:00Z. Às 22:00Z ainda faltam duas horas
  // para a reserva; ler o horário como UTC a daria por vencida.
  const factAt = brtFactAt("2026-09-03", "20:00:00");

  it("22:00Z (19h BRT) ainda vale — uma hora antes da reserva", () => {
    expect(decideMessageTtl({ kind: "reminder_d1", factAt, now: "2026-09-03T22:00:00Z" }).decision)
      .toBe("send");
  });

  it("23:00:01Z (20h BRT passado) vence", () => {
    expect(decideMessageTtl({ kind: "reminder_d1", factAt, now: "2026-09-03T23:00:01Z" }).decision)
      .toBe("discard");
  });

  it("confirmation segue a mesma fronteira do lembrete", () => {
    expect(decideMessageTtl({ kind: "confirmation", factAt, now: "2026-09-03T22:00:00Z" }).decision)
      .toBe("send");
    expect(decideMessageTtl({ kind: "confirmation", factAt, now: "2026-09-03T23:00:01Z" }).decision)
      .toBe("discard");
  });
});

describe("decideMessageTtl — fail-open em toda incerteza", () => {
  it("kind sem prazo definido segue, com motivo próprio", () => {
    const r = decideMessageTtl({ kind: "confirmation_email", factAt: null, now: Date.now() });
    expect(r.decision).toBe("send");
    expect(r.reason).toBe("unmapped_kind");
  });

  it("cancellation tem prazo de 24h porque o ledger exige expires_at", () => {
    expect(MESSAGE_TTL_MS.cancellation).toBe(24 * 60 * 60 * 1000);
    expect(decideMessageTtl({ kind: "cancellation", factAt: FACT, now: FACT_MS + 24 * 60 * 60 * 1000 + 1 }).decision).toBe("discard");
    expect(decideMessageTtl({ kind: "cancellation", factAt: null, now: Date.now() }).reason).toBe("missing_fact_at");
  });

  it("produtor que não passa fact_at não é barrado", () => {
    const r = decideMessageTtl({ kind: "waitlist_entered", factAt: null, now: Date.now() });
    expect(r.decision).toBe("send");
    expect(r.reason).toBe("missing_fact_at");
    expect(isProducerDefect(r.reason)).toBe(true);
  });

  it("string vazia conta como ausente, não como data inválida", () => {
    expect(decideMessageTtl({ kind: "survey_d1", factAt: "", now: Date.now() }).reason)
      .toBe("missing_fact_at");
  });

  it("fact_at impossível de interpretar segue, com motivo distinguível", () => {
    const r = decideMessageTtl({ kind: "survey_d1", factAt: "ontem", now: Date.now() });
    expect(r.decision).toBe("send");
    expect(r.reason).toBe("invalid_fact_at");
    expect(isProducerDefect(r.reason)).toBe(true);
  });

  it("unmapped_kind não é defeito de produtor — é decisão nossa", () => {
    expect(isProducerDefect("unmapped_kind")).toBe(false);
    expect(isProducerDefect("expired")).toBe(false);
  });
});

describe("brtFactAt", () => {
  it("normaliza HH:MM:SS do Postgres e crava o offset BRT", () => {
    expect(brtFactAt("2026-09-03", "20:00:00")).toBe("2026-09-03T20:00:00-03:00");
  });

  it("aceita HH:MM já curto", () => {
    expect(brtFactAt("2026-09-03", "20:00")).toBe("2026-09-03T20:00:00-03:00");
  });

  it("o resultado é uma data válida — sem dois blocos de segundos", () => {
    // Controle positivo do gotcha: `${time}:00` com time="20:00:00" produziria
    // "20:00:00:00", que vira Invalid Date e desligaria a comparação em
    // silêncio. Este assert é o que distingue a guarda de um no-op.
    const iso = brtFactAt("2026-09-03", "20:00:00");
    expect(Number.isFinite(new Date(iso as string).getTime())).toBe(true);
  });

  it("devolve null quando falta data ou hora, virando defeito de produtor", () => {
    expect(brtFactAt(null, "20:00:00")).toBeNull();
    expect(brtFactAt("2026-09-03", null)).toBeNull();
    expect(brtFactAt("2026-09-03", "")).toBeNull();
    expect(decideMessageTtl({ kind: "reminder_d1", factAt: brtFactAt("2026-09-03", null), now: Date.now() }).reason)
      .toBe("missing_fact_at");
  });
});
