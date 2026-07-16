import { describe, it, expect } from "vitest";
import {
  parseAsaasEnv,
  resolveAsaasBaseUrl,
  detectKeyEnv,
  validateKeyForEnv,
  parseAsaasError,
  parseRateLimitReset,
  ASAAS_SANDBOX_BASE_URL,
  ASAAS_PRODUCTION_BASE_URL,
  shouldRetryMutation,
  shouldRetryGet,
  MUTATION_RATE_LIMIT_RETRIES,
  GET_MAX_RETRIES,
  centsToAsaasValue,
  asaasValueToCents,
} from "../../supabase/functions/_shared/asaas-core";

// Fatos verificados em docs/billing-asaas/03-ASAAS-API-VERIFICADO.md (§8):
// prefixo produção `$aact_prod_` / sandbox `$aact_hmlg_`. Default de ambiente
// é sempre sandbox — errar pro lado seguro nunca deve inferir produção.

describe("parseAsaasEnv", () => {
  it("'production'/'prod' (case-insensitive, com trim) → production", () => {
    expect(parseAsaasEnv("production")).toBe("production");
    expect(parseAsaasEnv("prod")).toBe("production");
    expect(parseAsaasEnv("PRODUCTION")).toBe("production");
    expect(parseAsaasEnv("PROD")).toBe("production");
    expect(parseAsaasEnv("  prod  ")).toBe("production");
  });

  it("'sandbox'/'hmlg'/undefined/vazio/lixo → sandbox (default seguro)", () => {
    expect(parseAsaasEnv("sandbox")).toBe("sandbox");
    expect(parseAsaasEnv("hmlg")).toBe("sandbox");
    expect(parseAsaasEnv(undefined)).toBe("sandbox");
    expect(parseAsaasEnv(null)).toBe("sandbox");
    expect(parseAsaasEnv("")).toBe("sandbox");
    expect(parseAsaasEnv("lixo")).toBe("sandbox");
  });
});

describe("resolveAsaasBaseUrl", () => {
  it("sem override retorna a constante do ambiente correspondente", () => {
    expect(resolveAsaasBaseUrl("sandbox")).toBe(ASAAS_SANDBOX_BASE_URL);
    expect(resolveAsaasBaseUrl("production")).toBe(ASAAS_PRODUCTION_BASE_URL);
  });

  // As duas asserções acima comparam a constante contra ela mesma — um typo em
  // ASAAS_SANDBOX_BASE_URL/ASAAS_PRODUCTION_BASE_URL passaria verde e só falharia
  // em runtime (DNS). Pinar o literal exato de 03-ASAAS-API-VERIFICADO.md (§8).
  it("as constantes de base URL batem com o literal verificado em 03-ASAAS-API-VERIFICADO.md (§8)", () => {
    expect(ASAAS_SANDBOX_BASE_URL).toBe("https://api-sandbox.asaas.com/v3");
    expect(ASAAS_PRODUCTION_BASE_URL).toBe("https://api.asaas.com/v3");
  });

  it("override com conteúdo vence, sem barra final", () => {
    expect(resolveAsaasBaseUrl("sandbox", "https://custom.example.com/v3")).toBe(
      "https://custom.example.com/v3",
    );
  });

  it("override com barra final é normalizado (sem barra final)", () => {
    expect(resolveAsaasBaseUrl("production", "https://custom.example.com/v3/")).toBe(
      "https://custom.example.com/v3",
    );
  });

  it("override vazio ou só espaço é ignorado, cai pra constante do env", () => {
    expect(resolveAsaasBaseUrl("production", "")).toBe(ASAAS_PRODUCTION_BASE_URL);
    expect(resolveAsaasBaseUrl("production", "   ")).toBe(ASAAS_PRODUCTION_BASE_URL);
    expect(resolveAsaasBaseUrl("sandbox", null)).toBe(ASAAS_SANDBOX_BASE_URL);
    expect(resolveAsaasBaseUrl("sandbox", undefined)).toBe(ASAAS_SANDBOX_BASE_URL);
  });
});

describe("detectKeyEnv", () => {
  it("prefixo $aact_hmlg_ → sandbox", () => {
    expect(detectKeyEnv("$aact_hmlg_000abc123")).toBe("sandbox");
  });

  it("prefixo $aact_prod_ → production", () => {
    expect(detectKeyEnv("$aact_prod_000abc123")).toBe("production");
  });

  it("prefixo desconhecido → null", () => {
    expect(detectKeyEnv("sk_test_lixo")).toBeNull();
    expect(detectKeyEnv("")).toBeNull();
    expect(detectKeyEnv("aact_hmlg_sem_cifrao")).toBeNull();
  });
});

describe("validateKeyForEnv", () => {
  it("caso feliz: chave sandbox + env sandbox", () => {
    expect(validateKeyForEnv("$aact_hmlg_x", "sandbox")).toEqual({ status: "ok" });
  });

  it("caso feliz: chave produção + env produção", () => {
    expect(validateKeyForEnv("$aact_prod_x", "production")).toEqual({ status: "ok" });
  });

  it("chave de produção + env sandbox → bloqueada com erro explícito", () => {
    const r = validateKeyForEnv("$aact_prod_x", "sandbox");
    expect(r.status).toBe("blocked");
    if (r.status !== "blocked") throw new Error("esperava blocked");
    expect(r.error).toMatch(/produ/i);
    expect(r.error).toMatch(/sandbox/i);
  });

  it("chave de sandbox + env produção → bloqueada com erro explícito", () => {
    const r = validateKeyForEnv("$aact_hmlg_x", "production");
    expect(r.status).toBe("blocked");
    if (r.status !== "blocked") throw new Error("esperava blocked");
    expect(r.error).toMatch(/sandbox/i);
    expect(r.error).toMatch(/produ/i);
  });

  // O lado "Chave de X" pode usar rótulo PT-BR, mas "ASAAS_ENV=" precisa do
  // literal em inglês — não é um valor traduzível. "ASAAS_ENV=produção" não é
  // um AsaasEnv válido: parseAsaasEnv("produção") cai no default "sandbox", ou
  // seja, quem copiasse esse literal do log pra configurar a env var
  // selecionaria o ambiente OPOSTO ao que o erro está reportando.
  it("mensagem usa o literal em inglês do lado direito de ASAAS_ENV= (nunca traduzido)", () => {
    const rSandbox = validateKeyForEnv("$aact_prod_x", "sandbox");
    if (rSandbox.status !== "blocked") throw new Error("esperava blocked");
    expect(rSandbox.error).toContain("ASAAS_ENV=sandbox");

    const rProduction = validateKeyForEnv("$aact_hmlg_x", "production");
    if (rProduction.status !== "blocked") throw new Error("esperava blocked");
    expect(rProduction.error).toContain("ASAAS_ENV=production");
    expect(rProduction.error).not.toContain("ASAAS_ENV=produção");
  });

  it("chave com espaço em branco à esquerda ainda é reconhecida pelo prefixo (trim antes de detectKeyEnv)", () => {
    const r = validateKeyForEnv("  $aact_prod_x", "sandbox");
    expect(r.status).toBe("blocked");
    if (r.status !== "blocked") throw new Error("esperava blocked");
    expect(r.error).toMatch(/produ/i);
    expect(r.error).toMatch(/sandbox/i);
  });

  // Prefixo desconhecido é ambíguo, não inválido: chaves geradas antes de
  // 10/03/2025 (formato legado `$aact_YTU5...`, sem segmento prod/hmlg) não
  // têm prefixo de ambiente e continuam válidas. Bloquear aqui rejeitaria
  // uma chave legítima e antiga — ver §8 de 03-ASAAS-API-VERIFICADO.md.
  it("prefixo desconhecido/legado → permitido mas inconclusivo (NÃO bloqueia)", () => {
    const r = validateKeyForEnv("chave-invalida", "sandbox");
    expect(r.status).toBe("inconclusive");
    if (r.status !== "inconclusive") throw new Error("esperava inconclusive");
    expect(r.warning).toBeTruthy();
  });

  it("chave legado ($aact_YTU5...) → permitida mas inconclusiva, nos dois ambientes", () => {
    const legacyKey = "$aact_YTU5MjJhOWY4MDAwMDAwMDAwMDAwMDAw";

    const rSandbox = validateKeyForEnv(legacyKey, "sandbox");
    expect(rSandbox.status).toBe("inconclusive");
    if (rSandbox.status !== "inconclusive") throw new Error("esperava inconclusive");
    expect(rSandbox.warning).toBeTruthy();

    const rProduction = validateKeyForEnv(legacyKey, "production");
    expect(rProduction.status).toBe("inconclusive");
    if (rProduction.status !== "inconclusive") throw new Error("esperava inconclusive");
    expect(rProduction.warning).toBeTruthy();
  });

  it("chave vazia → bloqueada dizendo que não está configurada", () => {
    const r = validateKeyForEnv("", "sandbox");
    expect(r.status).toBe("blocked");
    if (r.status !== "blocked") throw new Error("esperava blocked");
    expect(r.error).toBeTruthy();
  });

  it("mensagem de erro NUNCA contém o valor da chave (mensagens vão pra log)", () => {
    const secretKey = "$aact_prod_super_secret_value_12345";
    const r = validateKeyForEnv(secretKey, "sandbox");
    expect(r.status).toBe("blocked");
    if (r.status !== "blocked") throw new Error("esperava blocked");
    expect(r.error).not.toContain(secretKey);
    expect(r.error).not.toContain("super_secret_value_12345");
  });

  // Mesmo guard do teste acima, mas pro branch "inconclusive" — é o mais
  // tentador de "melhorar" no futuro citando o prefixo não reconhecido
  // (ex.: `warning: \`prefixo ${apiKey.slice(0,11)} não reconhecido\``), o que
  // vazaria um pedaço da chave pro log e passaria batido se só o branch
  // "blocked" fosse coberto.
  it("warning do branch inconclusive também NUNCA contém o valor da chave", () => {
    const secretKey = "chave-com-prefixo-desconhecido-super-secreta-98765";
    const r = validateKeyForEnv(secretKey, "sandbox");
    expect(r.status).toBe("inconclusive");
    if (r.status !== "inconclusive") throw new Error("esperava inconclusive");
    expect(r.warning).not.toContain(secretKey);
    expect(r.warning).not.toContain("super-secreta-98765");
  });
});

// parseAsaasError/parseRateLimitReset são consumidos por _shared/asaas.ts
// (cliente HTTP, Fase 2) — shape verificado em 03-ASAAS-API-VERIFICADO.md
// (§10). O Asaas usa `errors[0].description`, não `error.message` (Stripe).

describe("parseAsaasError", () => {
  it("caso feliz: devolve errors[0].description", () => {
    const data = { errors: [{ code: "invalid_object", description: "O campo items deve ser informado." }] };
    expect(parseAsaasError(data, "fallback")).toBe("O campo items deve ser informado.");
  });

  it("usa só o primeiro erro quando há vários", () => {
    const data = {
      errors: [
        { code: "a", description: "primeiro erro" },
        { code: "b", description: "segundo erro" },
      ],
    };
    expect(parseAsaasError(data, "fallback")).toBe("primeiro erro");
  });

  it("errors: [] (array vazio) → fallback", () => {
    expect(parseAsaasError({ errors: [] }, "fallback")).toBe("fallback");
  });

  it("errors ausente → fallback", () => {
    expect(parseAsaasError({}, "fallback")).toBe("fallback");
  });

  it("data null/undefined → fallback", () => {
    expect(parseAsaasError(null, "fallback")).toBe("fallback");
    expect(parseAsaasError(undefined, "fallback")).toBe("fallback");
  });

  it("shape inesperado (string solta) → fallback", () => {
    expect(parseAsaasError("erro genérico", "fallback")).toBe("fallback");
  });

  it("shape inesperado (número) → fallback", () => {
    expect(parseAsaasError(42, "fallback")).toBe("fallback");
  });

  it("shape inesperado (array no topo, não objeto) → fallback", () => {
    expect(parseAsaasError([{ description: "x" }], "fallback")).toBe("fallback");
  });

  it("errors[0] sem description → fallback", () => {
    expect(parseAsaasError({ errors: [{ code: "invalid_object" }] }, "fallback")).toBe("fallback");
  });

  it("errors[0] não é objeto (string solta dentro do array) → fallback", () => {
    expect(parseAsaasError({ errors: ["erro"] }, "fallback")).toBe("fallback");
  });

  it("description vazia ou só espaço → fallback", () => {
    expect(parseAsaasError({ errors: [{ description: "" }] }, "fallback")).toBe("fallback");
    expect(parseAsaasError({ errors: [{ description: "   " }] }, "fallback")).toBe("fallback");
  });

  it("nunca lança, mesmo com shapes hostis", () => {
    expect(() => parseAsaasError(undefined, "fallback")).not.toThrow();
    expect(() => parseAsaasError(null, "fallback")).not.toThrow();
    expect(() => parseAsaasError("x", "fallback")).not.toThrow();
    expect(() => parseAsaasError(123, "fallback")).not.toThrow();
    expect(() => parseAsaasError([], "fallback")).not.toThrow();
    expect(() => parseAsaasError({ errors: null }, "fallback")).not.toThrow();
    expect(() => parseAsaasError({ errors: [null] }, "fallback")).not.toThrow();
  });
});

describe("parseRateLimitReset", () => {
  it("número válido (string) → number", () => {
    expect(parseRateLimitReset("42")).toBe(42);
  });

  it("null → null (header ausente)", () => {
    expect(parseRateLimitReset(null)).toBeNull();
  });

  it("string vazia/só espaço → null", () => {
    expect(parseRateLimitReset("")).toBeNull();
    expect(parseRateLimitReset("   ")).toBeNull();
  });

  it("lixo não-numérico ('abc') → null", () => {
    expect(parseRateLimitReset("abc")).toBeNull();
  });

  it("negativo → null", () => {
    expect(parseRateLimitReset("-1")).toBeNull();
  });

  it("'0' → 0 (reset iminente é válido, não é ausência — cuidado com falsy)", () => {
    expect(parseRateLimitReset("0")).toBe(0);
  });
});

// shouldRetryMutation/shouldRetryGet são o invariante de dinheiro desta
// integração (§11 — Asaas não tem Idempotency-Key): um retry cego de
// POST/PUT/DELETE em 5xx/timeout pode duplicar uma cobrança real que já foi
// processada do lado do Asaas mesmo sem resposta a tempo. Estes testes
// existem pra que um futuro refactor que "simplifique" o retry (ex.: passar
// a repetir 5xx, ou remover o teto de tentativas) quebre CI em vez de só
// quebrar em produção. Ver política completa comentada em _shared/asaas.ts.

describe("shouldRetryMutation — NUNCA duplicar cobrança (só 429 repete, e só até o limite)", () => {
  it("429 abaixo do limite de tentativas → retry (rate limit não processou nada, repetir é seguro)", () => {
    expect(shouldRetryMutation(429, 0)).toBe(true);
    expect(shouldRetryMutation(429, MUTATION_RATE_LIMIT_RETRIES - 1)).toBe(true);
  });

  it("429 NO limite de tentativas → NÃO retry (esgotou, devolve o 429 pro caller)", () => {
    expect(shouldRetryMutation(429, MUTATION_RATE_LIMIT_RETRIES)).toBe(false);
  });

  it("429 acima do limite de tentativas → NÃO retry", () => {
    expect(shouldRetryMutation(429, MUTATION_RATE_LIMIT_RETRIES + 5)).toBe(false);
  });

  it("500/502/503 NUNCA retry — outcome desconhecido, repetir arrisca duplicar cobrança real", () => {
    expect(shouldRetryMutation(500, 0)).toBe(false);
    expect(shouldRetryMutation(502, 0)).toBe(false);
    expect(shouldRetryMutation(503, 0)).toBe(false);
  });

  it("200 (sucesso) → NÃO retry", () => {
    expect(shouldRetryMutation(200, 0)).toBe(false);
  });

  it("400/401 (erro do cliente, não é rate limit) → NÃO retry", () => {
    expect(shouldRetryMutation(400, 0)).toBe(false);
    expect(shouldRetryMutation(401, 0)).toBe(false);
  });
});

describe("shouldRetryGet — GET é idempotente: 5xx e 429 repetem normal até o limite", () => {
  it("5xx abaixo do limite de tentativas → retry", () => {
    expect(shouldRetryGet(500, 0)).toBe(true);
    expect(shouldRetryGet(503, GET_MAX_RETRIES - 1)).toBe(true);
  });

  it("429 abaixo do limite de tentativas → retry", () => {
    expect(shouldRetryGet(429, 0)).toBe(true);
  });

  it("5xx/429 no limite ou acima do limite de tentativas → NÃO retry", () => {
    expect(shouldRetryGet(500, GET_MAX_RETRIES)).toBe(false);
    expect(shouldRetryGet(429, GET_MAX_RETRIES)).toBe(false);
    expect(shouldRetryGet(500, GET_MAX_RETRIES + 3)).toBe(false);
  });

  it("2xx/4xx fora de 429 → NÃO retry", () => {
    expect(shouldRetryGet(200, 0)).toBe(false);
    expect(shouldRetryGet(400, 0)).toBe(false);
    expect(shouldRetryGet(404, 0)).toBe(false);
    expect(shouldRetryGet(401, 0)).toBe(false);
  });
});

// centsToAsaasValue/asaasValueToCents são o invariante de dinheiro mais caro
// desta integração (§9.1): o Asaas fala reais decimais, nós falamos
// amountCents inteiro. Mandar `44900` cru cobraria R$ 44.900,00 em vez de
// R$ 449,00 — 100x. Valores dos planos reais vêm de
// docs/billing-asaas/01-PLANO-IMPLEMENTACAO.md (§FASE 3).

describe("centsToAsaasValue — centavos → reais decimais (§9.1)", () => {
  it("R$ 449,00 (plano sistema-reservas): 44900 centavos → 449", () => {
    expect(centsToAsaasValue(44900)).toBe(449);
  });

  it("R$ 750,00 (plano implementacao-whatsapp): 75000 centavos → 750", () => {
    expect(centsToAsaasValue(75000)).toBe(750);
  });

  it("R$ 149,00 (plano instancia-whatsapp): 14900 centavos → 149", () => {
    expect(centsToAsaasValue(14900)).toBe(149);
  });

  it("R$ 49,90: 4990 centavos → 49.9", () => {
    expect(centsToAsaasValue(4990)).toBe(49.9);
  });

  it("zero é válido (plano trial-padrao, R$ 0)", () => {
    expect(centsToAsaasValue(0)).toBe(0);
  });

  it("não-inteiro (fração de centavo não existe) → lança", () => {
    expect(() => centsToAsaasValue(4990.5)).toThrow(RangeError);
  });

  it("negativo → lança", () => {
    expect(() => centsToAsaasValue(-100)).toThrow(RangeError);
  });

  it("NaN/Infinity → lança", () => {
    expect(() => centsToAsaasValue(NaN)).toThrow(RangeError);
    expect(() => centsToAsaasValue(Infinity)).toThrow(RangeError);
    expect(() => centsToAsaasValue(-Infinity)).toThrow(RangeError);
  });
});

describe("asaasValueToCents — reais decimais → centavos (§9.1)", () => {
  it("449 → 44900 centavos", () => {
    expect(asaasValueToCents(449)).toBe(44900);
  });

  it("750 → 75000 centavos", () => {
    expect(asaasValueToCents(750)).toBe(75000);
  });

  it("149 → 14900 centavos", () => {
    expect(asaasValueToCents(149)).toBe(14900);
  });

  it("49.9 → 4990 centavos", () => {
    expect(asaasValueToCents(49.9)).toBe(4990);
  });

  it("zero é válido", () => {
    expect(asaasValueToCents(0)).toBe(0);
  });

  // A razão de existir do Math.round: em IEEE 754, 19.90 * 100 não é 1990
  // exato. Sem arredondar, um cast/truncamento cru cortaria pra 1899 —
  // R$ 0,01 a menos por cobrança, silenciosamente. Não "simplificar" isso
  // removendo o Math.round.
  it("float drift do IEEE 754: 19.90 * 100 !== 1990 exato, mas o resultado arredondado é", () => {
    expect(19.9 * 100).not.toBe(1990);
    expect(19.9 * 100).toBeCloseTo(1990, 5);
    expect(asaasValueToCents(19.9)).toBe(1990);
  });

  it("negativo → lança", () => {
    expect(() => asaasValueToCents(-1)).toThrow(RangeError);
  });

  it("NaN/Infinity → lança", () => {
    expect(() => asaasValueToCents(NaN)).toThrow(RangeError);
    expect(() => asaasValueToCents(Infinity)).toThrow(RangeError);
    expect(() => asaasValueToCents(-Infinity)).toThrow(RangeError);
  });
});

describe("round-trip asaasValueToCents(centsToAsaasValue(x)) === x", () => {
  it.each([0, 100, 4990, 14900, 44900, 75000, 1, 999999])("%i centavos sobrevive ao round-trip", (cents) => {
    expect(asaasValueToCents(centsToAsaasValue(cents))).toBe(cents);
  });
});
