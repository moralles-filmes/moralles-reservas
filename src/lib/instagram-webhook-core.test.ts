// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  INSTAGRAM_SIGNATURE_HEADER,
  INSTAGRAM_WEBHOOK_MAX_BYTES,
  authenticateInstagramWebhook,
  buildInstagramInboundKick,
  decideVerifyChallenge,
  entryAccountIds,
  rawBodyByteaHex,
  readBodyWithCap,
  selectEligibleInstagramAccounts,
  sha256Hex,
  verifyInstagramSignature,
} from "../../supabase/functions/_shared/instagram-webhook-core.ts";

/**
 * Núcleo do `webhook-instagram` (Task 2.3): assinatura sobre os bytes crus,
 * handshake GET, ids das contas do lote, elegibilidade e o "kick" pós-ACK.
 * Segredos sintéticos e curtos de propósito.
 */

const IG = "synthetic-ig-app-secret";
const META = "synthetic-meta-app-secret";

const sign = (secret: string, raw: Uint8Array) =>
  `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;

// Bytes com NUL, acento (UTF-8 multibyte) e um byte inválido em UTF-8 (0xff):
// a assinatura é sobre os bytes, não sobre texto re-codificado.
const RAW = new Uint8Array([
  ...new TextEncoder().encode('{"object":"instagram","t":"café '),
  0x00,
  0xff,
  ...new TextEncoder().encode('"}'),
]);

describe("verifyInstagramSignature", () => {
  it("confere sobre os bytes crus, inclusive com \\u0000 e acento", async () => {
    const r = await verifyInstagramSignature(RAW, sign(IG, RAW), [{ name: "instagram", secret: IG }]);
    expect(r).toEqual({ ok: true, matched: "instagram" });
    const text = new TextEncoder().encode(new TextDecoder().decode(RAW)); // re-codificado: 0xff vira U+FFFD
    expect(await verifyInstagramSignature(text, sign(IG, RAW), [{ name: "instagram", secret: IG }]))
      .toEqual({ ok: false, reason: "mismatch" });
  });

  it("aceita hex maiúsculo no cabeçalho", async () => {
    const header = `sha256=${sign(IG, RAW).slice(7).toUpperCase()}`;
    expect(await verifyInstagramSignature(RAW, header, [{ name: "instagram", secret: IG }]))
      .toEqual({ ok: true, matched: "instagram" });
  });

  it("candidato meta casa quando instagram não casa e devolve matched:meta", async () => {
    const r = await verifyInstagramSignature(RAW, sign(META, RAW), [
      { name: "instagram", secret: IG },
      { name: "meta", secret: META },
    ]);
    expect(r).toEqual({ ok: true, matched: "meta" });
  });

  it("sem candidatos dá no_secret (mesmo sem cabeçalho)", async () => {
    expect(await verifyInstagramSignature(RAW, sign(IG, RAW), [])).toEqual({ ok: false, reason: "no_secret" });
    expect(await verifyInstagramSignature(RAW, null, [])).toEqual({ ok: false, reason: "no_secret" });
    expect(await verifyInstagramSignature(RAW, sign(IG, RAW), [{ name: "instagram", secret: "  " }]))
      .toEqual({ ok: false, reason: "no_secret" });
  });

  it("cabeçalho ausente dá missing_header", async () => {
    for (const h of [null, "", "   "]) {
      expect(await verifyInstagramSignature(RAW, h, [{ name: "instagram", secret: IG }]))
        .toEqual({ ok: false, reason: "missing_header" });
    }
  });

  it("cabeçalho sem sha256= ou com hex inválido dá malformed_header", async () => {
    const hex = sign(IG, RAW).slice(7);
    for (const h of [hex, `sha1=${hex}`, "sha256=", `sha256=${hex.slice(1)}`, `sha256=${hex}0`, `sha256=${"z".repeat(64)}`]) {
      expect(await verifyInstagramSignature(RAW, h, [{ name: "instagram", secret: IG }]))
        .toEqual({ ok: false, reason: "malformed_header" });
    }
  });

  it("assinatura de outro segredo dá mismatch", async () => {
    expect(await verifyInstagramSignature(RAW, sign("other", RAW), [
      { name: "instagram", secret: IG },
      { name: "meta", secret: META },
    ])).toEqual({ ok: false, reason: "mismatch" });
  });
});

describe("authenticateInstagramWebhook", () => {
  type Read = { ok: true; value: string } | { ok: false; reason: "missing" | "read_failed" };
  const reader = (ig: Read, meta: Read) => {
    const calls: string[] = [];
    return {
      calls,
      read: async (key: string): Promise<Read> => {
        calls.push(key);
        return key === "instagram_app_secret" ? ig : meta;
      },
    };
  };
  const ok = (value: string): Read => ({ ok: true, value });
  const missing: Read = { ok: false, reason: "missing" };
  const failed: Read = { ok: false, reason: "read_failed" };

  it("instagram casa sem ler o meta", async () => {
    const r = reader(ok(IG), failed);
    expect(await authenticateInstagramWebhook(RAW, sign(IG, RAW), r.read)).toEqual({ ok: true, matched: "instagram" });
    expect(r.calls).toEqual(["instagram_app_secret"]);
  });

  it("meta casa quando instagram não casa", async () => {
    const r = reader(ok(IG), ok(META));
    expect(await authenticateInstagramWebhook(RAW, sign(META, RAW), r.read)).toEqual({ ok: true, matched: "meta" });
  });

  it("meta casa quando instagram não está configurado", async () => {
    const r = reader(missing, ok(META));
    expect(await authenticateInstagramWebhook(RAW, sign(META, RAW), r.read)).toEqual({ ok: true, matched: "meta" });
  });

  it("os dois missing dá no_secret", async () => {
    expect(await authenticateInstagramWebhook(RAW, sign(IG, RAW), reader(missing, missing).read))
      .toEqual({ ok: false, reason: "no_secret" });
  });

  it("read_failed de um candidato necessário dá read_failed", async () => {
    expect(await authenticateInstagramWebhook(RAW, sign(META, RAW), reader(failed, ok(META)).read))
      .toEqual({ ok: false, reason: "read_failed" });
    expect(await authenticateInstagramWebhook(RAW, sign(META, RAW), reader(ok(IG), failed).read))
      .toEqual({ ok: false, reason: "read_failed" });
  });

  it("meta missing é só 'sem segundo candidato'", async () => {
    expect(await authenticateInstagramWebhook(RAW, sign("other", RAW), reader(ok(IG), missing).read))
      .toEqual({ ok: false, reason: "mismatch" });
  });

  it("cabeçalho ruim com segredo instagram não lê o meta", async () => {
    const r = reader(ok(IG), failed);
    expect(await authenticateInstagramWebhook(RAW, null, r.read)).toEqual({ ok: false, reason: "missing_header" });
    expect(await authenticateInstagramWebhook(RAW, "md5=1", r.read)).toEqual({ ok: false, reason: "malformed_header" });
    expect(r.calls).toEqual(["instagram_app_secret", "instagram_app_secret"]);
  });
});

describe("decideVerifyChallenge", () => {
  const p = (q: string) => new URLSearchParams(q);
  it("devolve o hub.challenge cru com token certo", () => {
    expect(decideVerifyChallenge(p("hub.mode=subscribe&hub.verify_token=tok-1&hub.challenge=12345"), "tok-1"))
      .toEqual({ status: 200, body: "12345" });
  });
  it("token errado dá 403", () => {
    expect(decideVerifyChallenge(p("hub.mode=subscribe&hub.verify_token=tok-2&hub.challenge=1"), "tok-1")).toEqual({ status: 403 });
    expect(decideVerifyChallenge(p("hub.mode=subscribe&hub.verify_token=tok-&hub.challenge=1"), "tok-1")).toEqual({ status: 403 });
  });
  it("modo errado, sem challenge ou token esperado vazio dá 403", () => {
    expect(decideVerifyChallenge(p("hub.mode=unsubscribe&hub.verify_token=tok-1&hub.challenge=1"), "tok-1")).toEqual({ status: 403 });
    expect(decideVerifyChallenge(p("hub.mode=subscribe&hub.verify_token=tok-1"), "tok-1")).toEqual({ status: 403 });
    expect(decideVerifyChallenge(p("hub.mode=subscribe&hub.verify_token=&hub.challenge=1"), "")).toEqual({ status: 403 });
  });
});

describe("entryAccountIds", () => {
  it("null quando object não é instagram", () => {
    expect(entryAccountIds({ object: "page", entry: [{ id: "1" }] })).toBeNull();
    expect(entryAccountIds(null)).toBeNull();
    expect(entryAccountIds([])).toBeNull();
    expect(entryAccountIds("instagram")).toBeNull();
  });
  it("ids distintos, só dígitos, na ordem", () => {
    expect(entryAccountIds({ object: "instagram", entry: [{ id: "17841" }, { id: "999" }, { id: "17841" }, { id: "a1" }, { id: 12 }, {}, null, { id: "" }] }))
      .toEqual(["17841", "999", "12"]);
  });
  it("número inseguro é recusado", () => {
    expect(entryAccountIds({ object: "instagram", entry: [{ id: 2 ** 60 }, { id: -1 }, { id: 1.5 }] })).toEqual([]);
  });
  it("entry ausente ou não-array dá lista vazia", () => {
    expect(entryAccountIds({ object: "instagram" })).toEqual([]);
    expect(entryAccountIds({ object: "instagram", entry: {} })).toEqual([]);
  });
});

describe("sha256Hex e rawBodyByteaHex", () => {
  it("sha256 minúsculo dos bytes", async () => {
    expect(await sha256Hex(RAW)).toBe(createHash("sha256").update(RAW).digest("hex"));
  });
  it("hex \\x dos bytes exatos, sem passar por texto (R2-a)", () => {
    expect(rawBodyByteaHex(RAW)).toBe(`\\x${Buffer.from(RAW).toString("hex")}`);
    expect(rawBodyByteaHex(new Uint8Array([0, 255, 16]))).toBe("\\x00ff10");
  });
});

describe("selectEligibleInstagramAccounts", () => {
  const acc = (id: string, unit: string, ig: string) => ({ id, unit_id: unit, ig_user_id: ig });
  it("separa elegíveis, sem grant, Direct desligado e desconhecidas", () => {
    const r = selectEligibleInstagramAccounts({
      entryIds: ["1", "2", "3", "4"],
      accounts: [acc("a", "u1", "1"), acc("b", "u2", "2"), acc("c", "u3", "3")],
      activeGrantUnitIds: new Set(["u1", "u3"]),
      dmEnabledUnitIds: new Set(["u1", "u2"]),
    });
    expect(r.eligible.map((a) => a.id)).toEqual(["a"]);
    expect(r.discarded).toEqual({ unknown_account: 1, no_grant: 1, dm_disabled: 1 });
  });
  it("conta cujo ig_user_id não veio no lote não entra", () => {
    const r = selectEligibleInstagramAccounts({
      entryIds: ["1"],
      accounts: [acc("a", "u1", "1"), acc("x", "u1", "9")],
      activeGrantUnitIds: new Set(["u1"]),
      dmEnabledUnitIds: new Set(["u1"]),
    });
    expect(r.eligible.map((a) => a.id)).toEqual(["a"]);
  });
});

describe("readBodyWithCap", () => {
  const streamOf = (chunks: Uint8Array[], track = { pulled: 0, cancelled: false }) =>
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (track.pulled >= chunks.length) { controller.close(); return; }
        controller.enqueue(chunks[track.pulled++]);
      },
      cancel() { track.cancelled = true; },
    }, { highWaterMark: 0 });

  it("null vira bytes vazios", async () => {
    const r = await readBodyWithCap(null, 10);
    expect(r.ok).toBe(true);
    if (r.ok === true) expect(r.bytes).toEqual(new Uint8Array(0));
  });

  it("concatena os pedaços na ordem, exatamente no limite", async () => {
    const r = await readBodyWithCap(streamOf([new Uint8Array([1, 2]), new Uint8Array([]), new Uint8Array([3, 0, 255])]), 5);
    expect(r).toEqual({ ok: true, bytes: new Uint8Array([1, 2, 3, 0, 255]) });
  });

  it("passa do limite: too_large e cancela sem puxar o resto", async () => {
    const track = { pulled: 0, cancelled: false };
    const chunks = Array.from({ length: 10 }, () => new Uint8Array(4));
    expect(await readBodyWithCap(streamOf(chunks, track), 9)).toEqual({ ok: false, reason: "too_large" });
    expect(track.pulled).toBe(3);
    expect(track.cancelled).toBe(true);
  });
});

describe("buildInstagramInboundKick", () => {
  it("POST interno só com event_id e x-internal-key", () => {
    const k = buildInstagramInboundKick("https://p.invalid", "synthetic-internal", "e-1");
    expect(k.url).toBe("https://p.invalid/functions/v1/process-instagram-inbound");
    expect(k.init.method).toBe("POST");
    expect(k.init.headers).toEqual({ "x-internal-key": "synthetic-internal", "content-type": "application/json" });
    expect(JSON.parse(String(k.init.body))).toEqual({ event_id: "e-1" });
  });
});

describe("constantes e guarda estática", () => {
  it("limite e cabeçalho", () => {
    expect(INSTAGRAM_WEBHOOK_MAX_BYTES).toBe(2_097_152);
    expect(INSTAGRAM_SIGNATURE_HEADER).toBe("x-hub-signature-256");
  });
  it("o núcleo não toca o runtime nem o banco", () => {
    const src = readFileSync(resolve(__dirname, "../../supabase/functions/_shared/instagram-webhook-core.ts"), "utf8");
    expect(src).not.toMatch(/Deno\.|\.from\(|https:\/\/esm\.sh|deno\.land/);
  });
});
