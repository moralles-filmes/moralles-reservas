import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  INSTAGRAM_SECRET_CACHE_TTL_MS,
  INSTAGRAM_SECRET_KEYS,
  createInstagramSecretReader,
} from "../../supabase/functions/_shared/instagram-config-core.ts";
import { platformSecretRowOrThrow } from "../../supabase/functions/_shared/instagram-config.ts";

/**
 * Segredos do Instagram em `platform_secrets` (S5/S6, R2-c): leitura que falha
 * é `read_failed`, nunca valor de variável de ambiente; cache só do sucesso,
 * 5 min, com `clear()` por geração (mesma régua do leitor Datafy).
 *
 * Valores sintéticos e curtos de propósito (não casam com scanner de secret).
 */

const APP = INSTAGRAM_SECRET_KEYS.appSecret;
const VERIFY = INSTAGRAM_SECRET_KEYS.verifyToken;
const META = INSTAGRAM_SECRET_KEYS.metaAppSecret;

type Row = { value: unknown } | null;

function fakeReadRow(rows: Record<string, Row | Error>) {
  const calls: string[] = [];
  const readRow = async (key: string) => {
    calls.push(key);
    const r = rows[key];
    if (r instanceof Error) throw r;
    return (r ?? null) as { value: string } | null;
  };
  return { readRow, calls };
}

const g = globalThis as unknown as { Deno?: unknown };
const ENV_VALUE = "ENV-FALLBACK-VALUE-should-never-appear";

afterEach(() => {
  delete g.Deno;
  delete process.env.instagram_app_secret;
  delete process.env.INSTAGRAM_APP_SECRET;
});

describe("INSTAGRAM_SECRET_KEYS", () => {
  it("usa os nomes exatos do plano", () => {
    expect(INSTAGRAM_SECRET_KEYS).toEqual({
      appSecret: "instagram_app_secret",
      verifyToken: "instagram_verify_token",
      metaAppSecret: "meta_app_secret",
    });
    expect(INSTAGRAM_SECRET_CACHE_TTL_MS).toBe(5 * 60 * 1000);
  });
});

describe("createInstagramSecretReader — desfechos", () => {
  it("linha com string não vazia → ok com o valor aparado", async () => {
    const { readRow } = fakeReadRow({ [APP]: { value: "  app-secret-FAKE  " } });
    expect(await createInstagramSecretReader(readRow).read(APP)).toEqual({ ok: true, value: "app-secret-FAKE" });
  });

  it("sem linha → missing", async () => {
    const { readRow } = fakeReadRow({});
    expect(await createInstagramSecretReader(readRow).read(VERIFY)).toEqual({ ok: false, reason: "missing" });
  });

  it.each([
    ["vazio", ""],
    ["só espaço", "   \n"],
    ["número", 12345678901],
    ["objeto", { a: 1 }],
    ["array com string", ["app-secret-FAKE"]],
    ["null", null],
  ])("valor %s → missing, sem coerção por String(...)", async (_n, value) => {
    const { readRow } = fakeReadRow({ [APP]: { value } });
    expect(await createInstagramSecretReader(readRow).read(APP)).toEqual({ ok: false, reason: "missing" });
  });

  it("erro de leitura → read_failed e NUNCA o valor de env (Deno.env e process.env plantados)", async () => {
    g.Deno = { env: { get: () => ENV_VALUE, toObject: () => ({ [APP]: ENV_VALUE }) } };
    process.env.instagram_app_secret = ENV_VALUE;
    process.env.INSTAGRAM_APP_SECRET = ENV_VALUE;
    const { readRow } = fakeReadRow({ [APP]: new Error("rede caiu") });
    const result = await createInstagramSecretReader(readRow).read(APP);
    expect(result).toEqual({ ok: false, reason: "read_failed" });
    expect(JSON.stringify(result)).not.toContain(ENV_VALUE);
  });

  it("chave fora de INSTAGRAM_SECRET_KEYS → missing sem consultar o banco", async () => {
    const { readRow, calls } = fakeReadRow({ stripe_secret_key: { value: "nao-deve-sair" } });
    const reader = createInstagramSecretReader(readRow);
    expect(await reader.read("stripe_secret_key" as never)).toEqual({ ok: false, reason: "missing" });
    expect(calls).toEqual([]);
  });

  it("uma instância serve as três chaves, cada uma com seu valor", async () => {
    const { readRow } = fakeReadRow({
      [APP]: { value: "app-FAKE" },
      [VERIFY]: { value: "verify-FAKE" },
      [META]: { value: "meta-FAKE" },
    });
    const reader = createInstagramSecretReader(readRow);
    expect(await reader.read(APP)).toEqual({ ok: true, value: "app-FAKE" });
    expect(await reader.read(VERIFY)).toEqual({ ok: true, value: "verify-FAKE" });
    expect(await reader.read(META)).toEqual({ ok: true, value: "meta-FAKE" });
  });
});

describe("createInstagramSecretReader — cache (R2-c)", () => {
  it("sucesso fica em cache por chave até o TTL; depois relê", async () => {
    let t = 1_000;
    const { readRow, calls } = fakeReadRow({ [APP]: { value: "app-FAKE" }, [VERIFY]: { value: "verify-FAKE" } });
    const reader = createInstagramSecretReader(readRow, () => t);
    await reader.read(APP);
    await reader.read(APP);
    await reader.read(VERIFY);
    expect(calls).toEqual([APP, VERIFY]);
    t += INSTAGRAM_SECRET_CACHE_TTL_MS - 1;
    await reader.read(APP);
    expect(calls).toEqual([APP, VERIFY]);
    t += 1;
    await reader.read(APP);
    expect(calls).toEqual([APP, VERIFY, APP]);
  });

  it("falha nunca fica em cache: o valor cadastrado logo depois vale na chamada seguinte", async () => {
    const rows: Record<string, Row | Error> = { [APP]: new Error("x") };
    const { readRow } = fakeReadRow(rows);
    const reader = createInstagramSecretReader(readRow);
    expect(await reader.read(APP)).toEqual({ ok: false, reason: "read_failed" });
    rows[APP] = null;
    expect(await reader.read(APP)).toEqual({ ok: false, reason: "missing" });
    rows[APP] = { value: "app-FAKE" };
    expect(await reader.read(APP)).toEqual({ ok: true, value: "app-FAKE" });
  });

  it("vencido o TTL, falha de leitura recusa em vez de reaproveitar o valor antigo", async () => {
    let t = 0;
    const rows: Record<string, Row | Error> = { [APP]: { value: "old-FAKE" } };
    const { readRow } = fakeReadRow(rows);
    const reader = createInstagramSecretReader(readRow, () => t);
    expect(await reader.read(APP)).toEqual({ ok: true, value: "old-FAKE" });
    t += INSTAGRAM_SECRET_CACHE_TTL_MS;
    rows[APP] = new Error("x");
    expect(await reader.read(APP)).toEqual({ ok: false, reason: "read_failed" });
  });

  it("clear() esvazia o cache", async () => {
    const rows: Record<string, Row | Error> = { [APP]: { value: "old-FAKE" } };
    const { readRow } = fakeReadRow(rows);
    const reader = createInstagramSecretReader(readRow);
    await reader.read(APP);
    rows[APP] = { value: "new-FAKE" };
    reader.clear();
    expect(await reader.read(APP)).toEqual({ ok: true, value: "new-FAKE" });
  });

  it("leitura em voo durante clear() devolve ao chamador mas não repovoa o cache", async () => {
    let release: (v: { value: string }) => void = () => {};
    let n = 0;
    const readRow = (_key: string) => {
      n += 1;
      if (n === 1) return new Promise<{ value: string }>((r) => (release = r));
      return Promise.resolve({ value: "new-FAKE" });
    };
    const reader = createInstagramSecretReader(readRow);
    const inflight = reader.read(APP);
    reader.clear();
    release({ value: "old-FAKE" });
    expect(await inflight).toEqual({ ok: true, value: "old-FAKE" });
    expect(await reader.read(APP)).toEqual({ ok: true, value: "new-FAKE" });
    expect(n).toBe(2);
  });
});

// ── Guardas estáticas ────────────────────────────────────────────────────────

const read = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8");
const CORE = read("supabase/functions/_shared/instagram-config-core.ts");
const ADAPTER = read("supabase/functions/_shared/instagram-config.ts");
const EF = read("supabase/functions/manage-platform-secrets/index.ts");

function between(source: string, start: string, end: string): string {
  const i = source.indexOf(start);
  if (i < 0) throw new Error(`marcador ausente: ${start}`);
  const j = source.indexOf(end, i + start.length);
  if (j < 0) throw new Error(`marcador ausente: ${end}`);
  return source.slice(i, j);
}

describe("guardas estáticas do núcleo e do helper", () => {
  it("nem o núcleo nem o helper tocam variável de ambiente", () => {
    for (const src of [CORE, ADAPTER]) {
      expect(src).not.toMatch(/\bDeno\s*\.\s*env\b/);
      expect(src).not.toMatch(/\bprocess\s*\.\s*env\b|node:process/);
    }
    expect(CORE).not.toMatch(/\bDeno\b/);
    expect(CORE).not.toMatch(/esm\.sh|deno\.land/);
  });

  it("D3: o helper não consulta o banco nem importa SDK (a consulta mora no index.ts da EF)", () => {
    const code = ADAPTER.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/\.(from|rpc)\s*\(/);
    expect(code).not.toMatch(/esm\.sh|deno\.land|createClient/);
  });

  it("o log de falha do helper leva só discriminador, nunca mensagem nem String(err)", () => {
    expect(ADAPTER).toContain("instagram_secret_read_failed");
    expect(ADAPTER).not.toMatch(/String\(\s*(err|error|e)\b|\.message\b/);
  });

  it("o JSDoc do núcleo traz o readRow de referência com a tabela literal", () => {
    expect(CORE).toContain('.from("platform_secrets").select("value").eq("key", key).maybeSingle()');
    expect(CORE).toContain("platformSecretRowOrThrow(");
  });
});

describe("platformSecretRowOrThrow → contrato do núcleo", () => {
  it("linha → linha; sem linha → null; erro → lança, loga só key+code e o núcleo dá read_failed", async () => {
    expect(platformSecretRowOrThrow(APP, { data: { value: "app-FAKE" }, error: null })).toEqual({ value: "app-FAKE" });
    expect(platformSecretRowOrThrow(APP, { data: null, error: null })).toBeNull();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const pgError = { code: "PGRST301", message: "detalhe-sensivel-XYZ", details: "x" };
      expect(() => platformSecretRowOrThrow(APP, { data: { value: "app-FAKE" }, error: pgError })).toThrow();
      const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("instagram_secret_read_failed");
      expect(logged).toContain("PGRST301");
      expect(logged).not.toContain("detalhe-sensivel-XYZ");
      expect(logged).not.toContain("app-FAKE");

      const reader = createInstagramSecretReader(async (key) =>
        platformSecretRowOrThrow(key, { data: { value: "app-FAKE" }, error: pgError }),
      );
      expect(await reader.read(APP)).toEqual({ ok: false, reason: "read_failed" });
    } finally {
      warn.mockRestore();
    }
  });

  it("code não-string não é logado", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(() => platformSecretRowOrThrow(APP, { data: null, error: { code: { leak: "obj-XYZ" } } })).toThrow();
      expect(String(warn.mock.calls[0][0])).not.toContain("obj-XYZ");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("manage-platform-secrets cadastra os segredos do Instagram", () => {
  it("CONTROLE POSITIVO: o recorte lança quando o marcador some", () => {
    expect(() => between("abc", "x", "c")).toThrow(/marcador ausente/);
  });

  it("as três chaves estão em VALID_KEYS (linhas ativas, pelo nome da constante do núcleo)", () => {
    const validKeys = between(EF, "const VALID_KEYS = new Set([", "]);");
    expect(validKeys).toMatch(/^\s*INSTAGRAM_SECRET_KEYS\.appSecret,?\s*$/m);
    expect(validKeys).toMatch(/^\s*INSTAGRAM_SECRET_KEYS\.verifyToken,?\s*$/m);
    expect(validKeys).toMatch(/^\s*INSTAGRAM_SECRET_KEYS\.metaAppSecret,?\s*$/m);
    expect(EF).toMatch(/import\s*\{[^}]*\bINSTAGRAM_SECRET_KEYS\b[^}]*\}\s*from\s*"\.\.\/_shared\/instagram-config-core\.ts"/);
    expect(EF).not.toMatch(/"instagram_app_secret"|"instagram_verify_token"|"meta_app_secret"/);
  });

  it("o upsert lê o valor CRU do Instagram por typeof e apara, antes do tamanho mínimo", () => {
    const upsert = between(EF, 'action === "upsert"', 'action === "delete"');
    const guard = upsert.indexOf("INSTAGRAM_KEY_SET.has(key)");
    expect(guard).toBeGreaterThan(upsert.indexOf("VALID_KEYS.has(key)"));
    expect(upsert).toMatch(/if\s*\(\s*typeof\s+body\.value\s*!==\s*"string"\s*\)/);
    expect(upsert).toMatch(/^\s*value\s*=\s*body\.value\.trim\(\);/m);
    expect(upsert.indexOf("value.length < 10")).toBeGreaterThan(guard);
    expect(EF).toMatch(/new Set\(Object\.values\(INSTAGRAM_SECRET_KEYS\)\)/);
  });

  it("as três chaves têm descrição em KEY_DESCRIPTIONS; meta_app_secret marcada opcional", () => {
    const desc = between(EF, "const KEY_DESCRIPTIONS: Record<string, string> = {", "};");
    expect(desc).toMatch(/^\s*\[INSTAGRAM_SECRET_KEYS\.appSecret\]:\s*"/m);
    expect(desc).toMatch(/^\s*\[INSTAGRAM_SECRET_KEYS\.verifyToken\]:\s*"/m);
    expect(desc).toMatch(/^\s*\[INSTAGRAM_SECRET_KEYS\.metaAppSecret\]:\s*"[^"\n]*[Oo]pcional/m);
  });
});
