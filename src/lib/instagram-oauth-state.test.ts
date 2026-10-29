import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  INSTAGRAM_STATE_TTL_MS,
  signInstagramState,
  verifyInstagramState,
} from "../../supabase/functions/_shared/instagram-oauth-state.ts";

/** Segredo sintético (≥ 32 caracteres), nunca um valor real. */
const SECRET = "test-state-secret-0123456789-abcdefXYZ";
const OTHER_SECRET = "test-state-secret-OTHER-0123456789-xyz";
const NOW = 1_800_000_000_000;

const PAYLOAD = {
  unitId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  exp: NOW + INSTAGRAM_STATE_TTL_MS,
  nonce: "nonce-FAKE-0123456789abcdef",
};

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const b64urlText = (t: string) => b64url(new TextEncoder().encode(t));

/** HMAC independente do módulo, para montar tokens com payload arbitrário assinado. */
async function hmacPart(part: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(part))));
}
async function signedRaw(payloadPart: string, secret = SECRET): Promise<string> {
  return `${payloadPart}.${await hmacPart(payloadPart, secret)}`;
}

function flip(ch: string): string {
  return ch === "A" ? "B" : "A";
}

describe("INSTAGRAM_STATE_TTL_MS", () => {
  it("é 10 minutos", () => {
    expect(INSTAGRAM_STATE_TTL_MS).toBe(600_000);
  });
});

describe("signInstagramState / verifyInstagramState", () => {
  it("ida e volta: formato base64url(json).base64url(hmac) e payload íntegro", async () => {
    const token = await signInstagramState(PAYLOAD, SECRET, NOW);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    const [p, s] = token.split(".");
    expect(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(p.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))))).toEqual(PAYLOAD);
    expect(s).toBe(await hmacPart(p, SECRET));
    expect(await verifyInstagramState(token, SECRET, NOW)).toEqual({ ok: true, payload: PAYLOAD });
  });

  it("state adulterado em 1 caractere do payload → bad_signature", async () => {
    const token = await signInstagramState(PAYLOAD, SECRET, NOW);
    const i = 5;
    const tampered = token.slice(0, i) + flip(token[i]) + token.slice(i + 1);
    expect(await verifyInstagramState(tampered, SECRET, NOW)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("state adulterado em 1 caractere da assinatura → bad_signature", async () => {
    const token = await signInstagramState(PAYLOAD, SECRET, NOW);
    const i = token.indexOf(".") + 10;
    const tampered = token.slice(0, i) + flip(token[i]) + token.slice(i + 1);
    expect(await verifyInstagramState(tampered, SECRET, NOW)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("qualquer troca do último caractere da assinatura é recusada (sem bits de folga aceitos)", async () => {
    const token = await signInstagramState(PAYLOAD, SECRET, NOW);
    const last = token[token.length - 1];
    for (const c of "AEIMQUYcgkosw048BCDFfh") {
      if (c === last) continue;
      const r = await verifyInstagramState(token.slice(0, -1) + c, SECRET, NOW);
      expect(r.ok).toBe(false);
    }
  });

  it("userId trocado no json com a assinatura antiga → bad_signature", async () => {
    const token = await signInstagramState(PAYLOAD, SECRET, NOW);
    const oldSig = token.split(".")[1];
    const swapped = b64urlText(JSON.stringify({ ...PAYLOAD, userId: "33333333-3333-4333-8333-333333333333" }));
    expect(await verifyInstagramState(`${swapped}.${oldSig}`, SECRET, NOW)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("assinado com outro segredo → bad_signature", async () => {
    const token = await signInstagramState(PAYLOAD, OTHER_SECRET, NOW);
    expect(await verifyInstagramState(token, SECRET, NOW)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("vencido (now >= exp) → expired; um ms antes ainda vale", async () => {
    const token = await signInstagramState(PAYLOAD, SECRET, NOW);
    expect(await verifyInstagramState(token, SECRET, PAYLOAD.exp)).toEqual({ ok: false, reason: "expired" });
    expect(await verifyInstagramState(token, SECRET, PAYLOAD.exp + 1)).toEqual({ ok: false, reason: "expired" });
    expect((await verifyInstagramState(token, SECRET, PAYLOAD.exp - 1)).ok).toBe(true);
  });

  it("assinatura confere antes do vencimento: token alheio vencido continua bad_signature", async () => {
    const token = await signInstagramState(PAYLOAD, OTHER_SECRET, NOW);
    expect(await verifyInstagramState(token, SECRET, PAYLOAD.exp + 1)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it.each([
    ["vazio", ""],
    ["uma parte", "abc"],
    ["três partes", "a.b.c"],
    ["parte vazia", ".abc"],
    ["caractere fora do base64url", "ab+c.def"],
    ["padding", "abc=.def"],
  ])("estrutura inválida (%s) → malformed", async (_n, token) => {
    expect(await verifyInstagramState(token, SECRET, NOW)).toEqual({ ok: false, reason: "malformed" });
  });

  it("token que não é string → malformed", async () => {
    expect(await verifyInstagramState(undefined as unknown as string, SECRET, NOW)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("assinatura com tamanho errado → malformed", async () => {
    const token = await signInstagramState(PAYLOAD, SECRET, NOW);
    expect(await verifyInstagramState(`${token.split(".")[0]}.AAAA`, SECRET, NOW)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it.each([
    ["não-JSON", b64urlText("isto não é json")],
    ["JSON array", b64urlText(JSON.stringify([PAYLOAD]))],
    ["JSON null", b64urlText("null")],
    ["sem unitId", b64urlText(JSON.stringify({ ...PAYLOAD, unitId: undefined }))],
    ["userId número", b64urlText(JSON.stringify({ ...PAYLOAD, userId: 42 }))],
    ["exp string", b64urlText(JSON.stringify({ ...PAYLOAD, exp: String(PAYLOAD.exp) }))],
    ["exp ausente", b64urlText(JSON.stringify({ ...PAYLOAD, exp: undefined }))],
    ["nonce vazio", b64urlText(JSON.stringify({ ...PAYLOAD, nonce: "" }))],
    ["unitId vazio", b64urlText(JSON.stringify({ ...PAYLOAD, unitId: "" }))],
    ["UTF-8 inválido", b64url(new Uint8Array([0xff, 0xfe, 0x7b]))],
  ])("payload %s, mesmo bem assinado → malformed", async (_n, part) => {
    expect(await verifyInstagramState(await signedRaw(part), SECRET, NOW)).toEqual({ ok: false, reason: "malformed" });
  });

  it("o payload devolvido traz só os quatro campos", async () => {
    const part = b64urlText(JSON.stringify({ ...PAYLOAD, extra: "x" }));
    expect(await verifyInstagramState(await signedRaw(part), SECRET, NOW)).toEqual({ ok: true, payload: PAYLOAD });
  });

  it.each([
    ["vazio", ""],
    ["curto", "short-secret"],
    ["não-string", undefined as unknown as string],
  ])("segredo %s: sign lança e verify recusa", async (_n, secret) => {
    await expect(signInstagramState(PAYLOAD, secret, NOW)).rejects.toThrow();
    const token = await signInstagramState(PAYLOAD, SECRET, NOW);
    expect((await verifyInstagramState(token, secret, NOW)).ok).toBe(false);
    // e um token assinado com o próprio segredo fraco também não passa
    if (typeof secret === "string" && secret.length > 0) {
      const part = token.split(".")[0];
      const forged = `${part}.${await hmacPart(part, secret)}`;
      expect((await verifyInstagramState(forged, secret, NOW)).ok).toBe(false);
    }
  });

  it("sign recusa payload inválido", async () => {
    await expect(signInstagramState({ ...PAYLOAD, userId: "" }, SECRET, NOW)).rejects.toThrow();
    await expect(signInstagramState({ ...PAYLOAD, exp: Number.NaN }, SECRET, NOW)).rejects.toThrow();
  });
});

describe("teto do exp e nonce mínimo", () => {
  const MAX_AHEAD = INSTAGRAM_STATE_TTL_MS + 60_000;

  it("exp no teto (TTL + 60 s) é aceito por sign e verify", async () => {
    const p = { ...PAYLOAD, exp: NOW + MAX_AHEAD };
    const token = await signInstagramState(p, SECRET, NOW);
    expect(await verifyInstagramState(token, SECRET, NOW)).toEqual({ ok: true, payload: p });
  });

  it("sign lança quando exp passa do teto", async () => {
    await expect(signInstagramState({ ...PAYLOAD, exp: NOW + MAX_AHEAD + 1 }, SECRET, NOW)).rejects.toThrow();
  });

  it("sign usa o relógio atual por padrão: exp longe no futuro lança", async () => {
    await expect(signInstagramState({ ...PAYLOAD, exp: Date.now() + 24 * 3600_000 }, SECRET)).rejects.toThrow();
    const ok = { ...PAYLOAD, exp: Date.now() + INSTAGRAM_STATE_TTL_MS };
    await expect(signInstagramState(ok, SECRET)).resolves.toMatch(/./);
  });

  it("verify recusa (malformed) state bem assinado com exp além do teto", async () => {
    const part = b64urlText(JSON.stringify({ ...PAYLOAD, exp: NOW + MAX_AHEAD + 1 }));
    expect(await verifyInstagramState(await signedRaw(part), SECRET, NOW)).toEqual({ ok: false, reason: "malformed" });
    // um ano à frente, típico de chave vazada usada para cunhar state "eterno"
    const year = b64urlText(JSON.stringify({ ...PAYLOAD, exp: NOW + 365 * 24 * 3600_000 }));
    expect(await verifyInstagramState(await signedRaw(year), SECRET, NOW)).toEqual({ ok: false, reason: "malformed" });
  });

  it("nonce com menos de 16 caracteres: sign lança e verify devolve malformed", async () => {
    await expect(signInstagramState({ ...PAYLOAD, nonce: "123456789012345" }, SECRET, NOW)).rejects.toThrow();
    const part = b64urlText(JSON.stringify({ ...PAYLOAD, nonce: "123456789012345" }));
    expect(await verifyInstagramState(await signedRaw(part), SECRET, NOW)).toEqual({ ok: false, reason: "malformed" });
  });

  it("nonce de crypto.randomUUID() é aceito", async () => {
    const p = { ...PAYLOAD, nonce: crypto.randomUUID() };
    expect((await verifyInstagramState(await signInstagramState(p, SECRET, NOW), SECRET, NOW)).ok).toBe(true);
  });
});

describe("guardas estáticas", () => {
  const SRC = readFileSync(resolve(__dirname, "../../supabase/functions/_shared/instagram-oauth-state.ts"), "utf8");
  it("módulo puro: sem Deno, sem esm.sh/deno.land", () => {
    expect(SRC).not.toMatch(/\bDeno\b/);
    expect(SRC).not.toMatch(/esm\.sh|deno\.land|process\.env/);
  });
  it("assinatura conferida por crypto.subtle.verify (tempo constante), nunca por ===", () => {
    expect(SRC).toMatch(/crypto\.subtle\.verify\(/);
  });
});
