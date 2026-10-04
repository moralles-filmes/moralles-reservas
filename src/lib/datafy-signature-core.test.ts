import { describe, it, expect } from "vitest";
import {
  DATAFY_REPLAY_WINDOW_MS,
  buildDatafySignedPayload,
  decideDatafySignaturePreconditions,
} from "../../supabase/functions/_shared/datafy-signature-core";

const NOW = Date.UTC(2026, 8, 22, 17, 0, 0);
const TS = String(Math.floor(NOW / 1000));
const HEX = "a".repeat(64);
const SIG = `sha256=${HEX}`;

const base = { secret: "whsec_x", signatureHeader: SIG, timestampHeader: TS, nowMs: NOW };

describe("decideDatafySignaturePreconditions", () => {
  it("aceita assinatura e timestamp bem formados", () => {
    const verdict = decideDatafySignaturePreconditions(base);
    if (verdict.ok === false) throw new Error(`esperava ok, veio ${verdict.reason}`);
    expect(verdict.expectedHex).toBe(HEX);
    expect(verdict.signedPayloadPrefix).toBe(TS);
  });

  // Review Focus 1: canal recém-criado, secret ainda não colado.
  it("recusa quando o canal não tem webhook_secret", () => {
    for (const secret of [null, undefined, "", "   "]) {
      const verdict = decideDatafySignaturePreconditions({ ...base, secret });
      expect(verdict.ok).toBe(false);
      if (verdict.ok === false) expect(verdict.reason).toBe("missing_secret");
    }
  });

  it("recusa assinatura ausente ou fora do formato sha256=<64 hex>", () => {
    const casos: Array<[string | null, string]> = [
      [null, "missing_signature"],
      ["", "missing_signature"],
      [HEX, "malformed_signature"],
      ["sha256=" + "a".repeat(63), "malformed_signature"],
      ["sha256=" + "z".repeat(64), "malformed_signature"],
      ["sha1=" + HEX, "malformed_signature"],
    ];
    for (const [signatureHeader, reason] of casos) {
      const verdict = decideDatafySignaturePreconditions({ ...base, signatureHeader });
      expect(verdict.ok).toBe(false);
      if (verdict.ok === false) expect(verdict.reason).toBe(reason);
    }
  });

  it("aceita hex maiúsculo normalizando para minúsculo", () => {
    const verdict = decideDatafySignaturePreconditions({
      ...base,
      signatureHeader: `sha256=${"A".repeat(64)}`,
    });
    if (verdict.ok === false) throw new Error("esperava ok");
    expect(verdict.expectedHex).toBe("a".repeat(64));
  });

  it("recusa timestamp ausente ou não numérico", () => {
    for (const [timestampHeader, reason] of [
      [null, "missing_timestamp"],
      ["", "missing_timestamp"],
      ["ontem", "malformed_timestamp"],
      ["-1", "malformed_timestamp"],
    ] as Array<[string | null, string]>) {
      const verdict = decideDatafySignaturePreconditions({ ...base, timestampHeader });
      expect(verdict.ok).toBe(false);
      if (verdict.ok === false) expect(verdict.reason).toBe(reason);
    }
  });

  it("recusa entrega mais velha que a janela de replay", () => {
    const velho = String(Math.floor((NOW - DATAFY_REPLAY_WINDOW_MS - 1000) / 1000));
    const verdict = decideDatafySignaturePreconditions({ ...base, timestampHeader: velho });
    expect(verdict.ok).toBe(false);
    if (verdict.ok === false) expect(verdict.reason).toBe("stale_timestamp");
  });

  it("aceita entrega na borda da janela", () => {
    const borda = String(Math.floor((NOW - DATAFY_REPLAY_WINDOW_MS + 1000) / 1000));
    expect(decideDatafySignaturePreconditions({ ...base, timestampHeader: borda }).ok).toBe(true);
  });

  // Review Focus 2: janela tem que ser bilateral.
  it("recusa timestamp no futuro além da tolerância de clock", () => {
    const futuro = String(Math.floor((NOW + DATAFY_REPLAY_WINDOW_MS + 1000) / 1000));
    const verdict = decideDatafySignaturePreconditions({ ...base, timestampHeader: futuro });
    expect(verdict.ok).toBe(false);
    if (verdict.ok === false) expect(verdict.reason).toBe("future_timestamp");
  });
});

describe("buildDatafySignedPayload", () => {
  it("gestão WABA e lote misto assinam o envelope cru, antes de qualquer split", () => {
    const body = '{ "entry": [{"id":"123", "changes": [{"field":"message_template_status_update","value":{"message_template_id":456,"event":"PAUSED"}},{"field":"messages","value":{"metadata":{"phone_number_id":"789"},"messages":[]}}]}] }';
    const signed = buildDatafySignedPayload(TS, body);
    expect(signed).toBe(`${TS}.${body}`);
    expect(signed).not.toBe(buildDatafySignedPayload(TS, JSON.stringify(JSON.parse(body))));
    expect(decideDatafySignaturePreconditions({ ...base, signatureHeader: null }).ok).toBe(false);
    expect(decideDatafySignaturePreconditions({ ...base, timestampHeader: String(Number(TS) - DATAFY_REPLAY_WINDOW_MS / 1000 - 1) }).ok).toBe(false);
  });
  it("concatena timestamp e corpo com ponto, preservando o corpo cru", () => {
    const body = '{"a":1,\n  "b":"ç"}';
    expect(buildDatafySignedPayload("123", body)).toBe(`123.${body}`);
  });

  it("usa o timestamp cru do header, nunca um reformatado", () => {
    expect(buildDatafySignedPayload("0123", "x")).toBe("0123.x");
  });
});
