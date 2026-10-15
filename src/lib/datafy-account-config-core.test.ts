import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DATAFY_ACCOUNT_TOKEN_CACHE_TTL_MS,
  createDatafyAccountTokenReader,
  decideAccountTokenRead,
} from "../../supabase/functions/_shared/datafy-account-config-core.ts";

/**
 * O token de conta (`sk_acct_`) alcança TODOS os canais da conta de parceiro.
 * Diferente de `asaas-config.ts`/`stripe-config.ts`, que caem para variável de
 * ambiente em qualquer erro de leitura (e com isso mantêm credencial velha
 * viva), aqui leitura que falha RECUSA: nunca há segunda fonte.
 *
 * Valores abaixo são sintéticos e curtos de propósito (não casam com os
 * padrões de scanner de secret).
 */

const TOKEN_OK = "sk_acct_FAKE123";

describe("decideAccountTokenRead — os quatro desfechos", () => {
  it("linha com token sk_acct_ → ok com o token", () => {
    expect(decideAccountTokenRead({ row: { value: TOKEN_OK }, error: null })).toEqual({
      ok: true,
      token: TOKEN_OK,
    });
  });

  it("espaço em volta é aparado; o token devolvido é o aparado", () => {
    expect(decideAccountTokenRead({ row: { value: `  ${TOKEN_OK}\n` }, error: null })).toEqual({
      ok: true,
      token: TOKEN_OK,
    });
  });

  it("sem linha e sem erro → missing", () => {
    expect(decideAccountTokenRead({ row: null, error: null })).toEqual({
      ok: false,
      reason: "missing",
    });
  });

  it("erro de leitura → unavailable", () => {
    expect(decideAccountTokenRead({ row: null, error: { message: "boom" } })).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it("erro vence a linha: com erro, nunca devolve token, mesmo que a linha pareça válida", () => {
    const r = decideAccountTokenRead({ row: { value: TOKEN_OK }, error: new Error("boom") });
    expect(r).toEqual({ ok: false, reason: "unavailable" });
    expect(JSON.stringify(r)).not.toContain(TOKEN_OK);
  });

  it("valor string sem o prefixo sk_acct_ → malformed (ex.: token de canal sk_live_)", () => {
    expect(decideAccountTokenRead({ row: { value: "sk_live_FAKE123" }, error: null })).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(decideAccountTokenRead({ row: { value: "whsec_FAKE123" }, error: null })).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("vazio, só espaços ou só o prefixo → malformed", () => {
    for (const value of ["", "   ", "\n\t", "sk_acct_", "  sk_acct_  "]) {
      expect(decideAccountTokenRead({ row: { value }, error: null }), JSON.stringify(value)).toEqual({
        ok: false,
        reason: "malformed",
      });
    }
  });

  it("espaço ou caractere de controle no meio do token → malformed (iria para header HTTP)", () => {
    for (const value of ["sk_acct_FA KE", "sk_acct_FA\nKE", "sk_acct_FA\u0000KE", "sk_acct_FAKÉ"]) {
      expect(decideAccountTokenRead({ row: { value }, error: null }), JSON.stringify(value)).toEqual({
        ok: false,
        reason: "malformed",
      });
    }
  });

  it("valor não-string (null, número, booleano) → malformed", () => {
    for (const value of [null, undefined, 123, true]) {
      expect(decideAccountTokenRead({ row: { value }, error: null }), String(value)).toEqual({
        ok: false,
        reason: "malformed",
      });
    }
  });
});

describe("decideAccountTokenRead — valor não-string nunca é coagido", () => {
  it("CONTROLE POSITIVO: String() de fato transforma estes valores em algo aceitável", () => {
    // Sem este assert, os testes abaixo poderiam passar por vacuidade: se a
    // coerção não produzisse um texto com o prefixo certo, a checagem de prefixo
    // sozinha os recusaria e o `typeof` não estaria sendo exercido.
    expect(String({})).toBe("[object Object]");
    expect(String(["sk_acct_FAKE123"])).toBe(TOKEN_OK);
    expect(String({ toString: () => TOKEN_OK })).toBe(TOKEN_OK);
  });

  it("{ value: {} } → malformed, nunca um token igual a \"[object Object]\"", () => {
    const r = decideAccountTokenRead({ row: { value: {} }, error: null });
    expect(r).toEqual({ ok: false, reason: "malformed" });
    expect(JSON.stringify(r)).not.toContain("[object Object]");
  });

  it("array cujo String() vira token válido → malformed (só typeof distingue)", () => {
    expect(decideAccountTokenRead({ row: { value: [TOKEN_OK] }, error: null })).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("objeto com toString() forjado → malformed (só typeof distingue)", () => {
    expect(
      decideAccountTokenRead({ row: { value: { toString: () => TOKEN_OK } }, error: null }),
    ).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("createDatafyAccountTokenReader — cache só do sucesso", () => {
  type ReadResult = { row: { value: unknown } | null; error: unknown };

  function harness(results: Array<ReadResult | Error>) {
    let clock = 1_000_000;
    let calls = 0;
    const reader = createDatafyAccountTokenReader({
      read: async () => {
        const next = results[Math.min(calls, results.length - 1)];
        calls += 1;
        if (next instanceof Error) throw next;
        return next;
      },
      now: () => clock,
    });
    return {
      reader,
      advance: (ms: number) => {
        clock += ms;
      },
      calls: () => calls,
    };
  }

  it("sucesso fica em cache dentro do TTL e é relido depois dele", async () => {
    const h = harness([
      { row: { value: TOKEN_OK }, error: null },
      { row: { value: "sk_acct_NOVO456" }, error: null },
    ]);
    expect(await h.reader.get()).toEqual({ ok: true, token: TOKEN_OK });
    h.advance(DATAFY_ACCOUNT_TOKEN_CACHE_TTL_MS - 1);
    expect(await h.reader.get()).toEqual({ ok: true, token: TOKEN_OK });
    expect(h.calls()).toBe(1);
    h.advance(1);
    expect(await h.reader.get()).toEqual({ ok: true, token: "sk_acct_NOVO456" });
    expect(h.calls()).toBe(2);
  });

  it("o TTL é de 5 minutos", () => {
    expect(DATAFY_ACCOUNT_TOKEN_CACHE_TTL_MS).toBe(5 * 60 * 1000);
  });

  it("falha NÃO fica em cache: a chamada seguinte relê o banco", async () => {
    const h = harness([
      { row: null, error: { message: "boom" } },
      { row: null, error: null },
      { row: { value: {} }, error: null },
      { row: { value: TOKEN_OK }, error: null },
    ]);
    expect(await h.reader.get()).toEqual({ ok: false, reason: "unavailable" });
    expect(await h.reader.get()).toEqual({ ok: false, reason: "missing" });
    expect(await h.reader.get()).toEqual({ ok: false, reason: "malformed" });
    expect(await h.reader.get()).toEqual({ ok: true, token: TOKEN_OK });
    expect(h.calls()).toBe(4);
  });

  it("leitura que lança → unavailable, sem propagar a exceção", async () => {
    const h = harness([new Error("connection reset")]);
    expect(await h.reader.get()).toEqual({ ok: false, reason: "unavailable" });
  });

  it("depois do TTL, falha de leitura recusa: o token antigo NÃO é usado como reserva", async () => {
    const h = harness([
      { row: { value: TOKEN_OK }, error: null },
      { row: null, error: { message: "boom" } },
      new Error("ainda fora"),
    ]);
    expect(await h.reader.get()).toEqual({ ok: true, token: TOKEN_OK });
    h.advance(DATAFY_ACCOUNT_TOKEN_CACHE_TTL_MS);
    expect(await h.reader.get()).toEqual({ ok: false, reason: "unavailable" });
    expect(await h.reader.get()).toEqual({ ok: false, reason: "unavailable" });
  });

  it("clear() descarta o cache e força nova leitura", async () => {
    const h = harness([
      { row: { value: TOKEN_OK }, error: null },
      { row: null, error: null },
    ]);
    expect(await h.reader.get()).toEqual({ ok: true, token: TOKEN_OK });
    h.reader.clear();
    expect(await h.reader.get()).toEqual({ ok: false, reason: "missing" });
    expect(h.calls()).toBe(2);
  });

  it("clear() com leitura em voo: o token anterior à rotação não volta ao cache", async () => {
    let release: (r: ReadResult) => void = () => {};
    let calls = 0;
    const reader = createDatafyAccountTokenReader({
      read: () => {
        calls += 1;
        if (calls === 1) {
          return new Promise<ReadResult>((r) => {
            release = r;
          });
        }
        return Promise.resolve({ row: { value: "sk_acct_NOVO456" }, error: null });
      },
      now: () => 1_000_000,
    });

    const emVoo = reader.get(); // a leitura começa aqui (antes do primeiro await)
    reader.clear(); // rotação no painel enquanto a leitura está em voo
    release({ row: { value: TOKEN_OK }, error: null });

    // O chamador antigo recebe o que leu; o cache não guarda.
    expect(await emVoo).toEqual({ ok: true, token: TOKEN_OK });
    expect(await reader.get()).toEqual({ ok: true, token: "sk_acct_NOVO456" });
    expect(calls).toBe(2);
  });
});

// ── Guarda estática do adapter ───────────────────────────────────────────────
// O adapter importa `esm.sh` e usa o global `Deno`, então o vitest não o
// importa: a garantia "sem fallback de env para o token" só se confere lendo o
// arquivo. O único uso do runtime permitido é a leitura que monta o cliente
// service-role; qualquer outra ocorrência da palavra `Deno` (inclusive em
// comentário, para que um fallback comentado não sobreviva), `process.env` ou
// `node:process` reprova.

const ALLOWED_RUNTIME_READS = [
  'Deno.env.get("SUPABASE_URL")',
  'Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")',
];

/**
 * Devolve cada ocorrência proibida: toda palavra `Deno` que não inicie
 * exatamente uma das leituras permitidas, e toda menção a `process.env` ou
 * `node:process`. Cada ocorrência é julgada sozinha, então duas leituras na
 * mesma linha não se escondem uma atrás da outra.
 */
function forbiddenRuntimeMentions(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/\bDeno\b/g)) {
    const at = m.index ?? 0;
    const rest = source.slice(at);
    if (!ALLOWED_RUNTIME_READS.some((allowed) => rest.startsWith(allowed))) {
      out.push(rest.split("\n")[0].slice(0, 60));
    }
  }
  for (const m of source.matchAll(/\bprocess\s*\.\s*env\b|node:process/g)) out.push(m[0]);
  return out;
}

const ADAPTER = readFileSync(
  resolve(__dirname, "../../supabase/functions/_shared/datafy-account-config.ts"),
  "utf8",
);

const CORE = readFileSync(
  resolve(__dirname, "../../supabase/functions/_shared/datafy-account-config-core.ts"),
  "utf8",
);

describe("adapter datafy-account-config.ts nunca lê o token de variável de ambiente", () => {
  it("CONTROLE POSITIVO: o detector reprova fallbacks sintéticos e aceita o cliente", () => {
    // Sem isto, o assert sobre o arquivo real poderia passar por vacuidade
    // (regex que não casa nada).
    const proibidos = [
      'const t = Deno.env.get("DATAFY_ACCOUNT_TOKEN") ?? "";',
      "const t = Deno.env.get('DATAFY_TOKEN');",
      "const t = Deno.env.get(KEY);",
      'const t = Deno.env.get("SUPABASE_URL_X");',
      "const all = Deno.env.toObject();",
      '// fallback: Deno.env.get("DATAFY_ACCOUNT_TOKEN")',
      "// qualquer menção a Deno em comentário",
      'const t = Deno .env.get("DATAFY_X");',
      'const t = Deno["env"].get("DATAFY_X");',
      "const { env } = Deno;",
      "const e = Deno.env;",
      "const t = process.env.DATAFY_ACCOUNT_TOKEN;",
      'import process from "node:process";',
    ];
    for (const linha of proibidos) {
      expect(forbiddenRuntimeMentions(linha), linha).toHaveLength(1);
    }
    // Leitura proibida escondida na mesma linha de uma permitida.
    expect(
      forbiddenRuntimeMentions('createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("DATAFY_X")!);'),
    ).toHaveLength(1);
    expect(
      forbiddenRuntimeMentions(
        'createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);',
      ),
    ).toEqual([]);
  });

  it("não há Deno.env.get(\"DATAFY…\") no adapter", () => {
    expect(ADAPTER).not.toMatch(/Deno\s*\.\s*env\s*\.\s*get\(\s*["'`]DATAFY/);
  });

  it("o único uso do runtime no adapter é a leitura que monta o cliente service-role", () => {
    expect(forbiddenRuntimeMentions(ADAPTER)).toEqual([]);
    // As duas leituras permitidas existem (o detector não passou por vacuidade).
    for (const allowed of ALLOWED_RUNTIME_READS) expect(ADAPTER).toContain(allowed);
  });

  it("o núcleo não toca o runtime: nenhuma ocorrência de Deno nem de process.env", () => {
    expect(CORE).not.toMatch(/\bDeno\b/);
    expect(CORE).not.toMatch(/\bprocess\s*\.\s*env\b|node:process/);
  });

  it("o adapter lê a chave datafy_account_token de platform_secrets", () => {
    expect(ADAPTER).toContain('"platform_secrets"');
    expect(ADAPTER).toContain("DATAFY_ACCOUNT_TOKEN_KEY");
  });

  it("o adapter decide pelo núcleo (não reimplementa a regra)", () => {
    expect(ADAPTER).toContain("createDatafyAccountTokenReader(");
  });

  it("o log de falha leva só discriminador (code/name), nunca mensagem nem String(err)", () => {
    expect(ADAPTER).toContain("datafy_account_token_read_failed");
    expect(ADAPTER).not.toMatch(/String\(\s*(err|error|e)\b|\.message\b/);
  });
});

// ── Guarda estática do cadastro (manage-platform-secrets) ────────────────────
// A EF também importa `deno.land`/`esm.sh` e chama `serve()` no carregamento;
// o vitest não a importa. O cadastro precisa aplicar a MESMA régua da leitura
// ao valor cru do corpo, senão o painel aceita um valor que toda leitura
// recusaria (503 só depois).

const EF = readFileSync(
  resolve(__dirname, "../../supabase/functions/manage-platform-secrets/index.ts"),
  "utf8",
);

/** Trecho entre dois marcadores; lança se faltar um (nunca passa por vacuidade). */
function between(source: string, start: string, end: string): string {
  const i = source.indexOf(start);
  if (i < 0) throw new Error(`marcador ausente: ${start}`);
  const j = source.indexOf(end, i + start.length);
  if (j < 0) throw new Error(`marcador ausente: ${end}`);
  return source.slice(i, j);
}

describe("manage-platform-secrets cadastra o token de conta com a régua do núcleo", () => {
  it("CONTROLE POSITIVO: o recorte lança quando o marcador some", () => {
    expect(() => between("abc", "x", "c")).toThrow(/marcador ausente/);
    expect(() => between("abc", "a", "x")).toThrow(/marcador ausente/);
    expect(between("a [miolo] b", "[", "]")).toBe("[miolo");
  });

  it("o upsert valida o body.value CRU com decideAccountTokenRead, entre a whitelist e o tamanho mínimo", () => {
    const upsert = between(EF, 'action === "upsert"', 'action === "delete"');
    expect(upsert).toMatch(
      /decideAccountTokenRead\(\s*\{\s*row:\s*\{\s*value:\s*body\.value\s*\}\s*,\s*error:\s*null\s*\}\s*\)/,
    );
    expect(upsert).toMatch(/if\s*\(\s*key\s*===\s*DATAFY_ACCOUNT_TOKEN_KEY\s*\)/);
    expect(upsert).toMatch(/if\s*\(\s*decision\.ok\s*===\s*false\s*\)/);
    expect(upsert).toMatch(/^\s*value\s*=\s*decision\.token;/m);

    const whitelist = upsert.indexOf("VALID_KEYS.has(key)");
    const regua = upsert.indexOf("decideAccountTokenRead(");
    const tamanho = upsert.indexOf("value.length < 10");
    expect(whitelist).toBeGreaterThan(-1);
    expect(regua).toBeGreaterThan(whitelist);
    expect(tamanho).toBeGreaterThan(regua);
  });

  it("DATAFY_ACCOUNT_TOKEN_KEY está em VALID_KEYS (linha ativa, não comentada)", () => {
    const validKeys = between(EF, "const VALID_KEYS = new Set([", "]);");
    expect(validKeys).toMatch(/^\s*DATAFY_ACCOUNT_TOKEN_KEY,?\s*$/m);
  });

  it("clearAllProviderConfigCaches limpa o cache do token de conta", () => {
    const body = between(EF, "function clearAllProviderConfigCaches(): void {", "\n}");
    expect(body).toMatch(/^\s*clearDatafyAccountConfigCache\(\);/m);
  });
});
