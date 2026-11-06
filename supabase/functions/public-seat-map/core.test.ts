import { describe, expect, it, vi } from "vitest";
import { handleSeatMap, type SeatMapDeps } from "./core";
import { createSeatLinkToken, hashSeatLinkToken } from "../_shared/seat-link-core";

const UNIT = "11111111-1111-4111-8111-111111111111";
const HALL = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2030-03-15T20:00:00-03:00");

const MAP = {
  hall: { id: HALL, name: "Salão", plan: null },
  tables: [{ id: "t1", number: 1, plan: null, bookable: true, available: true }],
  options: [],
};

function deps(over: Partial<SeatMapDeps> = {}): SeatMapDeps {
  return {
    publicUnit: vi.fn(async () => ({ name: "Moralles", billingStatus: "active" })),
    rateLimit: vi.fn(async () => true),
    link: vi.fn(async () => null),
    seatChoiceEnabled: vi.fn(async () => true),
    seatMap: vi.fn(async () => MAP),
    channelPhone: vi.fn(async () => "5511999998888"),
    now: () => NOW,
    ...over,
  };
}

const params = { unit_id: UNIT, hall_id: HALL, date: "2030-03-15", time: "21:00", party_size: 4 };

describe("public-seat-map: modo parâmetros", () => {
  it("parâmetros válidos → mapa", async () => {
    const d = deps();
    const out = await handleSeatMap(params, d);
    expect(out.status).toBe(200);
    expect(out.json).toEqual({
      ok: true, unit: { name: "Moralles" }, hall_id: HALL, date: "2030-03-15", time: "21:00", party_size: 4,
      map: MAP, whatsapp_phone: null,
    });
    expect(d.seatMap).toHaveBeenCalledWith({ unitId: UNIT, hallId: HALL, date: "2030-03-15", time: "21:00", partySize: 4 });
    // Balde global do IP e depois o da unidade (só para unidade pública real).
    expect((d.rateLimit as ReturnType<typeof vi.fn>).mock.calls).toEqual([[null], [UNIT]]);
  });

  it("unit_id inventado só consome o balde global, nunca o da unidade", async () => {
    const d = deps({ publicUnit: vi.fn(async () => null) });
    await handleSeatMap({ ...params, unit_id: "33333333-3333-4333-8333-333333333333" }, d);
    expect((d.rateLimit as ReturnType<typeof vi.fn>).mock.calls).toEqual([[null]]);
  });

  it("balde global estourado responde 429 antes de ler a unidade", async () => {
    const d = deps({ rateLimit: vi.fn(async (u: string | null) => u !== null) });
    const out = await handleSeatMap(params, d);
    expect(out.status).toBe(429);
    expect(d.publicUnit).not.toHaveBeenCalled();
  });

  it("unidade não pública → unit_invalid, sem mapa", async () => {
    const d = deps({ publicUnit: vi.fn(async () => null) });
    const out = await handleSeatMap(params, d);
    expect(out.json).toEqual({ ok: false, reason: "unit_invalid" });
    expect(d.seatMap).not.toHaveBeenCalled();
  });

  it("organização bloqueada → unit_invalid", async () => {
    const out = await handleSeatMap(params, deps({ publicUnit: vi.fn(async () => ({ name: "X", billingStatus: "blocked" })) }));
    expect(out.json).toEqual({ ok: false, reason: "unit_invalid" });
  });

  it("entrada inválida → 400 invalid_input", async () => {
    for (const bad of [null, [], { ...params, unit_id: "x" }, { ...params, date: "2030-02-31" }, { ...params, time: "25:00" }, { ...params, party_size: 0 }, { ...params, party_size: 2.5 }]) {
      const out = await handleSeatMap(bad, deps());
      expect(out).toEqual({ status: 400, json: { ok: false, reason: "invalid_input" } });
    }
  });

  it("rate-limit falso → 429", async () => {
    const d = deps({ rateLimit: vi.fn(async () => false) });
    const out = await handleSeatMap(params, d);
    expect(out).toEqual({ status: 429, json: { ok: false, reason: "rate_limited" } });
    expect(d.seatMap).not.toHaveBeenCalled();
  });

  it("erro do rate-limit → 503, com o erro entregue ao diagnóstico", async () => {
    const onError = vi.fn();
    const out = await handleSeatMap(params, deps({ rateLimit: vi.fn(async () => { throw new Error("db"); }), onError }));
    expect(out).toEqual({ status: 503, json: { ok: false, reason: "dependency_unavailable" } });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("erro de leitura do mapa → 503 (nunca mapa vazio)", async () => {
    const out = await handleSeatMap(params, deps({ seatMap: vi.fn(async () => { throw new Error("availability_read_failed"); }) }));
    expect(out.status).toBe(503);
  });

  it("recusa de horário do mapa vira ok:false com o motivo", async () => {
    const out = await handleSeatMap(params, deps({ seatMap: vi.fn(async () => ({ error: "outside_hours" as const })) }));
    expect(out).toEqual({ status: 200, json: { ok: false, reason: "outside_hours" } });
  });
});

describe("public-seat-map: modo token", () => {
  async function linkFor(token: string, over: Record<string, unknown> = {}) {
    const hash = await hashSeatLinkToken(token);
    return vi.fn(async (h: string) => (h === hash ? {
      unitId: UNIT, hallId: HALL, channelId: "ch-1", date: "2030-03-16", time: "19:30:00", partySize: 6,
      expiresAt: "2030-03-15T23:30:00.000Z", ...over,
    } : null));
  }

  it("usa data, hora, pessoas e salão do link (e o número do canal)", async () => {
    const token = createSeatLinkToken();
    const d = deps({ link: await linkFor(token) });
    const out = await handleSeatMap({ token, unit_id: "99999999-9999-4999-8999-999999999999", party_size: 2 }, d);
    expect(out.json).toMatchObject({ ok: true, hall_id: HALL, date: "2030-03-16", time: "19:30", party_size: 6, whatsapp_phone: "5511999998888" });
    expect(d.seatMap).toHaveBeenCalledWith({ unitId: UNIT, hallId: HALL, date: "2030-03-16", time: "19:30", partySize: 6 });
    expect(d.channelPhone).toHaveBeenCalledWith("ch-1", UNIT);
    // Balde do modo token: antes de ler o link, sem unidade.
    expect(d.rateLimit).toHaveBeenCalledWith(null);
  });

  it("token expirado e inválido dão a mesma resposta", async () => {
    const token = createSeatLinkToken();
    const expirado = await handleSeatMap({ token }, deps({ link: await linkFor(token, { expiresAt: "2030-03-15T22:59:59.000Z" }) }));
    const inexistente = await handleSeatMap({ token: createSeatLinkToken() }, deps({ link: await linkFor(token) }));
    const malformado = await handleSeatMap({ token: "abc" }, deps());
    const unidadeFora = await handleSeatMap({ token }, deps({ link: await linkFor(token), publicUnit: vi.fn(async () => null) }));
    for (const out of [expirado, inexistente, malformado, unidadeFora]) {
      expect(out).toEqual({ status: 200, json: { ok: false, reason: "link_invalid" } });
    }
  });

  it("whatsapp_phone nulo quando o canal não tem número (ou falha a leitura)", async () => {
    const token = createSeatLinkToken();
    const semNumero = await handleSeatMap({ token }, deps({ link: await linkFor(token), channelPhone: vi.fn(async () => null) }));
    const falha = await handleSeatMap({ token }, deps({ link: await linkFor(token), channelPhone: vi.fn(async () => { throw new Error("x"); }) }));
    const semCanal = await handleSeatMap({ token }, deps({ link: await linkFor(token, { channelId: null }) }));
    for (const out of [semNumero, falha, semCanal]) expect(out.json).toMatchObject({ ok: true, whatsapp_phone: null });
  });

  it("rate-limit vale antes de procurar o token", async () => {
    const d = deps({ rateLimit: vi.fn(async () => false) });
    const out = await handleSeatMap({ token: createSeatLinkToken() }, d);
    expect(out.status).toBe(429);
    expect(d.link).not.toHaveBeenCalled();
  });

  it("token que não é string → 400", async () => {
    expect((await handleSeatMap({ token: 123 }, deps())).status).toBe(400);
  });
});

describe("public-seat-map: sem PII", () => {
  it("resposta não contém chaves além das do contrato", async () => {
    // O mapa que vier com extras (ex.: um campo de reserva) é recortado nas três chaves.
    const leaky = { ...MAP, reservations: [{ customer_name: "Fulano" }] } as unknown as typeof MAP;
    const out = await handleSeatMap(params, deps({ seatMap: vi.fn(async () => leaky) }));
    if (out.json.ok !== true) throw new Error("esperava mapa");
    expect(Object.keys(out.json).sort()).toEqual(["date", "hall_id", "map", "ok", "party_size", "time", "unit", "whatsapp_phone"]);
    expect(Object.keys(out.json.unit)).toEqual(["name"]);
    expect(Object.keys(out.json.map).sort()).toEqual(["hall", "options", "tables"]);
    expect(JSON.stringify(out.json)).not.toContain("Fulano");
  });
});

describe("public-seat-map: chave seat_choice_enabled", () => {
  it("chave desligada no modo parâmetros → choice_disabled, sem ler o mapa", async () => {
    const d = deps({ seatChoiceEnabled: vi.fn(async () => false) });
    const out = await handleSeatMap(params, d);
    expect(out).toEqual({ status: 200, json: { ok: false, reason: "choice_disabled" } });
    expect(d.seatChoiceEnabled).toHaveBeenCalledWith(UNIT);
    expect(d.seatMap).not.toHaveBeenCalled();
  });

  it("chave desligada no modo token → choice_disabled pela unidade do link", async () => {
    const token = createSeatLinkToken();
    const hash = await hashSeatLinkToken(token);
    const d = deps({
      seatChoiceEnabled: vi.fn(async () => false),
      link: vi.fn(async (h: string) => (h === hash ? {
        unitId: UNIT, hallId: HALL, channelId: null, date: "2030-03-16", time: "19:30:00", partySize: 6,
        expiresAt: "2030-03-15T23:30:00.000Z",
      } : null)),
    });
    const out = await handleSeatMap({ token }, d);
    expect(out.json).toEqual({ ok: false, reason: "choice_disabled" });
    expect(d.seatChoiceEnabled).toHaveBeenCalledWith(UNIT);
    expect(d.seatMap).not.toHaveBeenCalled();
  });

  it("unidade não pública responde unit_invalid antes de consultar a chave", async () => {
    const d = deps({ publicUnit: vi.fn(async () => null) });
    const out = await handleSeatMap(params, d);
    expect(out.json).toEqual({ ok: false, reason: "unit_invalid" });
    expect(d.seatChoiceEnabled).not.toHaveBeenCalled();
  });
});
