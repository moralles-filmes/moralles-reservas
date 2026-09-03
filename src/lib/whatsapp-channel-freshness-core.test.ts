import { describe, it, expect } from "vitest";
import {
  decideChannelUsability,
  CHANNEL_FRESHNESS_MS,
} from "../../supabase/functions/_shared/whatsapp-channel-freshness-core.ts";

const NOW = new Date("2026-09-03T17:00:00Z").getTime();
const fresh = new Date(NOW - 60_000).toISOString();
const stale = new Date(NOW - CHANNEL_FRESHNESS_MS - 1).toISOString();

describe("decideChannelUsability — projeção fresca responde sozinha", () => {
  it("conectada e fresca: usa sem consultar o provedor", () => {
    expect(decideChannelUsability({ status: "connected", lastHealthCheckAt: fresh, now: NOW }))
      .toBe("use");
  });

  it("desconectada e fresca: recusa sem gastar consulta", () => {
    expect(decideChannelUsability({ status: "disconnected", lastHealthCheckAt: fresh, now: NOW }))
      .toBe("refuse");
  });

  it("status desconhecido e fresco recusa — só 'connected' autoriza", () => {
    for (const status of ["provider_error", "waiting_qr", "reconnecting", "suspended", "", null]) {
      expect(decideChannelUsability({ status, lastHealthCheckAt: fresh, now: NOW })).toBe("refuse");
    }
  });

  it("no limite exato do frescor ainda responde sozinha", () => {
    const borderline = new Date(NOW - CHANNEL_FRESHNESS_MS).toISOString();
    expect(decideChannelUsability({ status: "connected", lastHealthCheckAt: borderline, now: NOW }))
      .toBe("use");
  });
});

describe("decideChannelUsability — o incidente de 2026-09-03", () => {
  // Controle POSITIVO da guarda: a projeção do Ren Sushi dizia `connected` com
  // `last_health_check_at` de 6,6 dias antes. Antes desta peça isso autorizava
  // o POST. Se este teste voltar a esperar "use", a guarda virou no-op.
  it("connected há 6,6 dias NÃO é aceito de graça", () => {
    const seisDias = new Date(NOW - 6.6 * 24 * 3600_000).toISOString();
    expect(decideChannelUsability({ status: "connected", lastHealthCheckAt: seisDias, now: NOW }))
      .toBe("recheck");
  });
});

describe("decideChannelUsability — projeção velha nunca decide", () => {
  it("velha e conectada vai a recheck", () => {
    expect(decideChannelUsability({ status: "connected", lastHealthCheckAt: stale, now: NOW }))
      .toBe("recheck");
  });

  it("velha e desconectada vai a recheck, não a refuse", () => {
    // O caso do lado oposto: o operador reconectou pelo celular e clicou em
    // "avisar mesa pronta" antes do worker de health rodar. Recusar por uma
    // projeção velha diria "desconectado" sobre um canal que está no ar.
    expect(decideChannelUsability({ status: "disconnected", lastHealthCheckAt: stale, now: NOW }))
      .toBe("recheck");
  });

  it("sem carimbo nenhum vai a recheck", () => {
    expect(decideChannelUsability({ status: "connected", lastHealthCheckAt: null, now: NOW }))
      .toBe("recheck");
    expect(decideChannelUsability({ status: "connected", lastHealthCheckAt: "", now: NOW }))
      .toBe("recheck");
  });

  it("carimbo impossível de interpretar vai a recheck", () => {
    expect(decideChannelUsability({ status: "connected", lastHealthCheckAt: "agora", now: NOW }))
      .toBe("recheck");
  });

  it("carimbo no futuro não se auto-valida", () => {
    // Relógio torto ou fuso escrito errado gravaria um carimbo adiante do
    // relógio; aceitá-lo faria a projeção passar no teste de frescor para
    // sempre, que é exatamente o defeito que esta peça existe para matar.
    const futuro = new Date(NOW + 3600_000).toISOString();
    expect(decideChannelUsability({ status: "connected", lastHealthCheckAt: futuro, now: NOW }))
      .toBe("recheck");
  });
});
