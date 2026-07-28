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
  parseAsaasAmountCents,
  ASAAS_PAYMENT_EVENTS,
  ASAAS_SUBSCRIPTION_EVENTS,
  ASAAS_CHECKOUT_EVENTS,
  classifyAsaasEvent,
  parseAsaasWebhookEnvelope,
  parseAsaasPaymentListPage,
  ASAAS_PAYMENT_LIST_PAGE_SIZE,
  ASAAS_PAYMENT_LIST_MAX_PAGES,
  ASAAS_PAYMENT_LIST_MIN_PAGE_BUDGET_MS,
  hasAsaasBudgetForAnotherPage,
  mapAsaasBillingTypeToPaymentMethod,
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

  // `{ error: string }` não é shape do Asaas (a API real só manda `errors[]`)
  // — é o formato SINTÉTICO que asaas.ts usa nos próprios guards (chave do
  // ambiente errado, falha de rede). Sem este branch a mensagem específica
  // morre no fallback genérico do wrapper (achado #4 da revisão da Fase 2).
  it("data.error (shape sintético do próprio asaas.ts) → devolve a mensagem específica", () => {
    expect(
      parseAsaasError({ error: "Chave de produção configurada mas ASAAS_ENV=sandbox." }, "fallback"),
    ).toBe("Chave de produção configurada mas ASAAS_ENV=sandbox.");
    expect(parseAsaasError({ error: "Falha de conexão com o Asaas." }, "fallback")).toBe(
      "Falha de conexão com o Asaas.",
    );
  });

  it("data.error vazio, só espaço, ou não-string → fallback", () => {
    expect(parseAsaasError({ error: "" }, "fallback")).toBe("fallback");
    expect(parseAsaasError({ error: "   " }, "fallback")).toBe("fallback");
    expect(parseAsaasError({ error: 42 }, "fallback")).toBe("fallback");
  });

  it("errors[0].description tem prioridade sobre data.error quando os dois vierem presentes", () => {
    const data = { errors: [{ description: "erro real do Asaas" }], error: "não deveria vencer" };
    expect(parseAsaasError(data, "fallback")).toBe("erro real do Asaas");
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
  // exato. Sem arredondar, um cast/truncamento cru cortaria pra 1989 —
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

// parseAsaasAmountCents — Fix round 1 da Fase 5b (Task 9): protege
// `upsert_open_invoice` de tratar "não deu pra ler o valor" como R$ 0,00.
// Zero explícito e ausência têm que produzir resultados DIFERENTES — é o
// ponto inteiro da função.
describe("parseAsaasAmountCents — não confunde ausente com zero (Fix round 1)", () => {
  it("valor válido vira centavos respeitando o arredondamento existente (delega a asaasValueToCents)", () => {
    expect(parseAsaasAmountCents(449)).toEqual({ ok: true, cents: 44900 });
    // Mesmo float drift do IEEE 754 que asaasValueToCents já cobre — prova que
    // não existe uma segunda lógica de conversão aqui.
    expect(parseAsaasAmountCents(19.9)).toEqual({ ok: true, cents: 1990 });
  });

  it("zero explícito é aceito (protege plano trial R$ 0)", () => {
    expect(parseAsaasAmountCents(0)).toEqual({ ok: true, cents: 0 });
  });

  it("zero explícito é DISTINTO de ausente — o mesmo `cents:0` não pode nascer de um value que nunca veio", () => {
    const zero = parseAsaasAmountCents(0);
    const missing = parseAsaasAmountCents(undefined);
    expect(zero.ok).toBe(true);
    expect(missing.ok).toBe(false);
    // `missing.ok === false` (não `!missing.ok`) — sob strict:false deste
    // tsconfig, negar um discriminante boolean não estreita a união dentro do
    // próprio `if`; comparação por igualdade estreita corretamente.
    if (missing.ok === false) expect(missing.code).toBe("MISSING_PAYMENT_AMOUNT");
  });

  it("undefined não vira zero — MISSING_PAYMENT_AMOUNT", () => {
    expect(parseAsaasAmountCents(undefined)).toEqual({ ok: false, code: "MISSING_PAYMENT_AMOUNT" });
  });

  it("null não vira zero — MISSING_PAYMENT_AMOUNT", () => {
    expect(parseAsaasAmountCents(null)).toEqual({ ok: false, code: "MISSING_PAYMENT_AMOUNT" });
  });

  it("string vazia não vira zero — MISSING_PAYMENT_AMOUNT", () => {
    expect(parseAsaasAmountCents("")).toEqual({ ok: false, code: "MISSING_PAYMENT_AMOUNT" });
  });

  it("NaN é recusado — INVALID_PAYMENT_AMOUNT", () => {
    expect(parseAsaasAmountCents(NaN)).toEqual({ ok: false, code: "INVALID_PAYMENT_AMOUNT" });
  });

  it("Infinity é recusado — INVALID_PAYMENT_AMOUNT", () => {
    expect(parseAsaasAmountCents(Infinity)).toEqual({ ok: false, code: "INVALID_PAYMENT_AMOUNT" });
  });

  it("negativo é recusado — INVALID_PAYMENT_AMOUNT", () => {
    expect(parseAsaasAmountCents(-1)).toEqual({ ok: false, code: "INVALID_PAYMENT_AMOUNT" });
  });

  it("não-número (string não vazia, objeto) é recusado — INVALID_PAYMENT_AMOUNT", () => {
    expect(parseAsaasAmountCents("449")).toEqual({ ok: false, code: "INVALID_PAYMENT_AMOUNT" });
    expect(parseAsaasAmountCents({})).toEqual({ ok: false, code: "INVALID_PAYMENT_AMOUNT" });
  });

  it("valor absurdamente grande (centavos estourando Number.MAX_SAFE_INTEGER) é recusado — INVALID_PAYMENT_AMOUNT", () => {
    // MAX_SAFE_INTEGER / 100 já é maior que qualquer cobrança real possível —
    // fronteira de correção de representação, não regra de negócio.
    const hugeValue = Number.MAX_SAFE_INTEGER;
    expect(parseAsaasAmountCents(hugeValue)).toEqual({ ok: false, code: "INVALID_PAYMENT_AMOUNT" });
  });
});

// classifyAsaasEvent/parseAsaasWebhookEnvelope são consumidos por
// asaas-webhook/index.ts (Fase 2 Task 4). Nomes de evento vêm de
// docs/billing-asaas/03-ASAAS-API-VERIFICADO.md (§4) — pinar contagem e
// nomes específicos evita que um refactor futuro "simplifique" pra matching
// por prefixo (a armadilha real: PAYMENT_AWAITING_CHARGEBACK_REVERSAL não
// começa com PAYMENT_CHARGEBACK_) ou invente um evento que não existe
// (SUBSCRIPTION_CANCELED).

describe("ASAAS_*_EVENTS — contagem pinada contra a lista verificada (§4)", () => {
  it("PAYMENT_* tem exatamente 29 nomes", () => {
    expect(ASAAS_PAYMENT_EVENTS.size).toBe(29);
  });

  it("SUBSCRIPTION_* tem exatamente 7 nomes", () => {
    expect(ASAAS_SUBSCRIPTION_EVENTS.size).toBe(7);
  });

  it("CHECKOUT_* tem exatamente 4 nomes", () => {
    expect(ASAAS_CHECKOUT_EVENTS.size).toBe(4);
  });
});

describe("classifyAsaasEvent", () => {
  it("PAYMENT_RECEIVED (caso comum) → known", () => {
    expect(classifyAsaasEvent("PAYMENT_RECEIVED")).toBe("known");
  });

  // A armadilha real do §4: este evento existe e começa com "PAYMENT_" mas
  // NÃO com "PAYMENT_CHARGEBACK_" — um matcher por prefixo cru erraria.
  it("PAYMENT_AWAITING_CHARGEBACK_REVERSAL é reconhecido (guard do bug de prefixo)", () => {
    expect(classifyAsaasEvent("PAYMENT_AWAITING_CHARGEBACK_REVERSAL")).toBe("known");
  });

  it("os outros dois nomes de chargeback também são reconhecidos", () => {
    expect(classifyAsaasEvent("PAYMENT_CHARGEBACK_REQUESTED")).toBe("known");
    expect(classifyAsaasEvent("PAYMENT_CHARGEBACK_DISPUTE")).toBe("known");
  });

  it("SUBSCRIPTION_DELETED e SUBSCRIPTION_INACTIVATED (cancelamento real) → known", () => {
    expect(classifyAsaasEvent("SUBSCRIPTION_DELETED")).toBe("known");
    expect(classifyAsaasEvent("SUBSCRIPTION_INACTIVATED")).toBe("known");
  });

  // Não existe SUBSCRIPTION_CANCELED na API (§4) — se alguém "adivinhar" esse
  // nome no futuro (é o palpite óbvio vindo da Stripe), tem que classificar
  // como desconhecido, não known.
  it("SUBSCRIPTION_CANCELED (nome que NÃO existe na API) → unknown", () => {
    expect(classifyAsaasEvent("SUBSCRIPTION_CANCELED")).toBe("unknown");
  });

  it("CHECKOUT_PAID → known", () => {
    expect(classifyAsaasEvent("CHECKOUT_PAID")).toBe("known");
  });

  it("evento totalmente desconhecido → unknown, sem lançar", () => {
    expect(() => classifyAsaasEvent("PIX_QRCODE_SOMETHING_NEW")).not.toThrow();
    expect(classifyAsaasEvent("PIX_QRCODE_SOMETHING_NEW")).toBe("unknown");
  });

  it("string vazia → unknown", () => {
    expect(classifyAsaasEvent("")).toBe("unknown");
  });
});

describe("parseAsaasWebhookEnvelope", () => {
  // Exemplo literal de docs/billing-asaas/03-ASAAS-API-VERIFICADO.md (§3).
  const validPayload = {
    id: "evt_05b708f961d739ea7eba7e4db318f621&368604920",
    event: "PAYMENT_RECEIVED",
    dateCreated: "2024-06-12 16:45:03",
    payment: { object: "payment", id: "pay_080225913252" },
  };

  it("envelope válido (exemplo da doc) → valid:true com id/event/dateCreated", () => {
    const result = parseAsaasWebhookEnvelope(validPayload);
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error("esperava valid:true");
    expect(result.id).toBe("evt_05b708f961d739ea7eba7e4db318f621&368604920");
    expect(result.event).toBe("PAYMENT_RECEIVED");
    expect(result.dateCreated).toBe("2024-06-12 16:45:03");
  });

  // Guard explícito contra "limpar" o id — o `&` é literal (§3), nunca deve
  // ser splitado, decodificado ou tratado como separador de query string.
  it("id com '&' literal é preservado INTEIRO, sem split/decode", () => {
    const result = parseAsaasWebhookEnvelope(validPayload);
    if (!result.valid) throw new Error("esperava valid:true");
    expect(result.id).toContain("&");
    expect(result.id.split("&")).toHaveLength(2); // prova que NINGUÉM deu split nele
    expect(result.id).toBe(validPayload.id);
  });

  it("shape não-uniforme (checkout com 'account' + objeto inteiro) ainda é válido — só envelope importa", () => {
    const checkoutPayload = {
      id: "evt_abc123&999",
      event: "CHECKOUT_PAID",
      dateCreated: "2024-06-12 16:45:03",
      account: { id: "acc_1" },
      checkout: { id: "chk_1", status: "PAID" },
    };
    const result = parseAsaasWebhookEnvelope(checkoutPayload);
    expect(result.valid).toBe(true);
  });

  it("event desconhecido no envelope ainda é um envelope válido — classificação é responsabilidade de classifyAsaasEvent", () => {
    const result = parseAsaasWebhookEnvelope({ ...validPayload, event: "SOME_NEW_EVENT" });
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error("esperava valid:true");
    expect(classifyAsaasEvent(result.event)).toBe("unknown");
  });

  it("body null → inválido com motivo", () => {
    const result = parseAsaasWebhookEnvelope(null);
    expect(result.valid).toBe(false);
    // Comparação explícita (não truthy-check cru): projeto roda com
    // strictNullChecks:false, e "if (result.valid) throw" nesse modo NÃO
    // estreita o tipo pro branch valid:false (confirmado — precisa do
    // "!== false" explícito pra TS liberar `.reason` na linha seguinte).
    if (result.valid !== false) throw new Error("esperava valid:false");
    expect(result.reason).toBeTruthy();
  });

  it("body undefined → inválido com motivo", () => {
    const result = parseAsaasWebhookEnvelope(undefined);
    expect(result.valid).toBe(false);
  });

  it("body array → inválido com motivo", () => {
    const result = parseAsaasWebhookEnvelope([validPayload]);
    expect(result.valid).toBe(false);
  });

  it("body string solta → inválido com motivo", () => {
    const result = parseAsaasWebhookEnvelope("PAYMENT_RECEIVED");
    expect(result.valid).toBe(false);
  });

  it("body número → inválido com motivo", () => {
    const result = parseAsaasWebhookEnvelope(42);
    expect(result.valid).toBe(false);
  });

  it("objeto sem 'id' → inválido com motivo mencionando o campo", () => {
    const { id, ...rest } = validPayload;
    void id;
    const result = parseAsaasWebhookEnvelope(rest);
    expect(result.valid).toBe(false);
    // Comparação explícita (não truthy-check cru): projeto roda com
    // strictNullChecks:false, e "if (result.valid) throw" nesse modo NÃO
    // estreita o tipo pro branch valid:false (confirmado — precisa do
    // "!== false" explícito pra TS liberar `.reason` na linha seguinte).
    if (result.valid !== false) throw new Error("esperava valid:false");
    expect(result.reason).toMatch(/id/);
  });

  it("objeto sem 'event' → inválido com motivo mencionando o campo", () => {
    const { event, ...rest } = validPayload;
    void event;
    const result = parseAsaasWebhookEnvelope(rest);
    expect(result.valid).toBe(false);
    // Comparação explícita (não truthy-check cru): projeto roda com
    // strictNullChecks:false, e "if (result.valid) throw" nesse modo NÃO
    // estreita o tipo pro branch valid:false (confirmado — precisa do
    // "!== false" explícito pra TS liberar `.reason` na linha seguinte).
    if (result.valid !== false) throw new Error("esperava valid:false");
    expect(result.reason).toMatch(/event/);
  });

  it("'id' com tipo errado (número) → inválido", () => {
    const result = parseAsaasWebhookEnvelope({ ...validPayload, id: 12345 });
    expect(result.valid).toBe(false);
  });

  it("'event' com tipo errado (objeto) → inválido", () => {
    const result = parseAsaasWebhookEnvelope({ ...validPayload, event: { name: "x" } });
    expect(result.valid).toBe(false);
  });

  it("'id' vazio ou só espaço → inválido", () => {
    expect(parseAsaasWebhookEnvelope({ ...validPayload, id: "" }).valid).toBe(false);
    expect(parseAsaasWebhookEnvelope({ ...validPayload, id: "   " }).valid).toBe(false);
  });

  it("'dateCreated' ausente → valid:true com dateCreated:null (campo não é obrigatório pro envelope)", () => {
    const { dateCreated, ...rest } = validPayload;
    void dateCreated;
    const result = parseAsaasWebhookEnvelope(rest);
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error("esperava valid:true");
    expect(result.dateCreated).toBeNull();
  });

  it("'dateCreated' NÃO é convertido pra Date/ISO — permanece string crua (formato sem timezone)", () => {
    const result = parseAsaasWebhookEnvelope(validPayload);
    if (!result.valid) throw new Error("esperava valid:true");
    expect(typeof result.dateCreated).toBe("string");
    expect(result.dateCreated).not.toMatch(/T.*Z$/); // não vira ISO
    expect(result.dateCreated).toBe("2024-06-12 16:45:03");
  });

  it("nunca lança, mesmo com shapes hostis", () => {
    expect(() => parseAsaasWebhookEnvelope(null)).not.toThrow();
    expect(() => parseAsaasWebhookEnvelope(undefined)).not.toThrow();
    expect(() => parseAsaasWebhookEnvelope([])).not.toThrow();
    expect(() => parseAsaasWebhookEnvelope("x")).not.toThrow();
    expect(() => parseAsaasWebhookEnvelope(123)).not.toThrow();
    expect(() => parseAsaasWebhookEnvelope({})).not.toThrow();
    expect(() => parseAsaasWebhookEnvelope({ id: null, event: null })).not.toThrow();
  });
});

// parseAsaasPaymentListPage — Fase 5b Task 10. Consumido por
// _shared/asaas.ts (listAsaasSubscriptionPayments), que percorre
// GET /subscriptions/{id}/payments (§13.2 de 03-ASAAS-API-VERIFICADO.md) pra
// alimentar o reconciliador de Task 11. Duas regras deliberadamente rígidas:
// (1) um item malformado invalida A PÁGINA INTEIRA — não "pula e segue"; (2)
// `hasMore` ausente/tipo errado é ERRO, nunca default `false` (que pararia a
// paginação como se a lista estivesse completa).

describe("parseAsaasPaymentListPage", () => {
  const validItem = {
    id: "pay_080225913252",
    status: "RECEIVED",
    value: 449,
    dueDate: "2026-07-26",
    billingType: "PIX",
    subscription: "sub_abc123",
    externalReference: "org:probe|plan:probe|purpose:subscription",
  };

  it("página válida com 1 item e hasMore:false → valid:true com o item parseado", () => {
    const result = parseAsaasPaymentListPage({ data: [validItem], hasMore: false });
    expect(result.valid).toBe(true);
    if (result.valid !== true) throw new Error("esperava valid:true");
    expect(result.hasMore).toBe(false);
    expect(result.payments).toEqual([
      {
        id: "pay_080225913252",
        status: "RECEIVED",
        value: 449,
        dueDate: "2026-07-26",
        billingType: "PIX",
        subscription: "sub_abc123",
        externalReference: "org:probe|plan:probe|purpose:subscription",
      },
    ]);
  });

  it("página válida com múltiplos itens preserva a ordem", () => {
    const item2 = { ...validItem, id: "pay_2", value: 149 };
    const result = parseAsaasPaymentListPage({ data: [validItem, item2], hasMore: true });
    expect(result.valid).toBe(true);
    if (result.valid !== true) throw new Error("esperava valid:true");
    expect(result.payments.map((p) => p.id)).toEqual(["pay_080225913252", "pay_2"]);
    expect(result.hasMore).toBe(true);
  });

  it("página vazia (data: []) é válida — assinatura sem cobranças ainda", () => {
    const result = parseAsaasPaymentListPage({ data: [], hasMore: false });
    expect(result.valid).toBe(true);
    if (result.valid !== true) throw new Error("esperava valid:true");
    expect(result.payments).toEqual([]);
  });

  // §13.6: cobrança avulsa OMITE a chave `subscription` (não vem como null).
  // Cobrança de assinatura traz `subscription: "sub_..."`. Os dois casos têm
  // que normalizar pro mesmo `null` no lado ausente.
  it("'subscription' omitido (cobrança avulsa, §13.6) normaliza pra null", () => {
    const { subscription, ...avulsa } = validItem;
    void subscription;
    const result = parseAsaasPaymentListPage({ data: [avulsa], hasMore: false });
    expect(result.valid).toBe(true);
    if (result.valid !== true) throw new Error("esperava valid:true");
    expect(result.payments[0].subscription).toBeNull();
  });

  it("'billingType' e 'externalReference' ausentes normalizam pra null (campos secundários, não invalidam o item)", () => {
    const { billingType, externalReference, ...rest } = validItem;
    void billingType;
    void externalReference;
    const result = parseAsaasPaymentListPage({ data: [rest], hasMore: false });
    expect(result.valid).toBe(true);
    if (result.valid !== true) throw new Error("esperava valid:true");
    expect(result.payments[0].billingType).toBeNull();
    expect(result.payments[0].externalReference).toBeNull();
  });

  it("'billingType' com tipo errado (número) normaliza pra null em vez de invalidar o item", () => {
    const result = parseAsaasPaymentListPage({ data: [{ ...validItem, billingType: 42 }], hasMore: false });
    expect(result.valid).toBe(true);
    if (result.valid !== true) throw new Error("esperava valid:true");
    expect(result.payments[0].billingType).toBeNull();
  });

  // Regra central da função: um item ruim não vira "pula e segue" — a página
  // inteira fica não confiável.
  it("um item malformado no meio da lista invalida A PÁGINA INTEIRA (não pula o item)", () => {
    const item2 = { ...validItem, id: "pay_2" };
    const badItem = { ...validItem, id: undefined };
    const result = parseAsaasPaymentListPage({ data: [validItem, badItem, item2], hasMore: false });
    expect(result.valid).toBe(false);
    if (result.valid !== false) throw new Error("esperava valid:false");
    expect(result.reason).toMatch(/item 1/);
    expect(result.reason).toMatch(/id/);
  });

  it("campo 'id' ausente ou vazio → item inválido", () => {
    expect(parseAsaasPaymentListPage({ data: [{ ...validItem, id: undefined }], hasMore: false }).valid).toBe(false);
    expect(parseAsaasPaymentListPage({ data: [{ ...validItem, id: "" }], hasMore: false }).valid).toBe(false);
    expect(parseAsaasPaymentListPage({ data: [{ ...validItem, id: "   " }], hasMore: false }).valid).toBe(false);
    expect(parseAsaasPaymentListPage({ data: [{ ...validItem, id: 123 }], hasMore: false }).valid).toBe(false);
  });

  it("campo 'status' ausente ou vazio → item inválido", () => {
    expect(parseAsaasPaymentListPage({ data: [{ ...validItem, status: undefined }], hasMore: false }).valid).toBe(
      false,
    );
    expect(parseAsaasPaymentListPage({ data: [{ ...validItem, status: "" }], hasMore: false }).valid).toBe(false);
  });

  it("campo 'dueDate' ausente ou vazio → item inválido", () => {
    expect(parseAsaasPaymentListPage({ data: [{ ...validItem, dueDate: undefined }], hasMore: false }).valid).toBe(
      false,
    );
    expect(parseAsaasPaymentListPage({ data: [{ ...validItem, dueDate: "" }], hasMore: false }).valid).toBe(false);
  });

  // "money never gets a ?? 0 fallback" — value ausente/inválido bloqueia o
  // item (e por consequência a página), nunca vira 0 silenciosamente.
  it("campo 'value' ausente, negativo, NaN, Infinity ou string → item inválido (nunca vira 0)", () => {
    expect(parseAsaasPaymentListPage({ data: [{ ...validItem, value: undefined }], hasMore: false }).valid).toBe(
      false,
    );
    expect(parseAsaasPaymentListPage({ data: [{ ...validItem, value: null }], hasMore: false }).valid).toBe(false);
    expect(parseAsaasPaymentListPage({ data: [{ ...validItem, value: -1 }], hasMore: false }).valid).toBe(false);
    expect(parseAsaasPaymentListPage({ data: [{ ...validItem, value: NaN }], hasMore: false }).valid).toBe(false);
    expect(parseAsaasPaymentListPage({ data: [{ ...validItem, value: Infinity }], hasMore: false }).valid).toBe(
      false,
    );
    expect(parseAsaasPaymentListPage({ data: [{ ...validItem, value: "449" }], hasMore: false }).valid).toBe(false);
  });

  it("'value: 0' é um item VÁLIDO — zero é dinheiro de verdade, não ausência (mesmo princípio de parseAsaasAmountCents)", () => {
    const result = parseAsaasPaymentListPage({ data: [{ ...validItem, value: 0 }], hasMore: false });
    expect(result.valid).toBe(true);
    if (result.valid !== true) throw new Error("esperava valid:true");
    expect(result.payments[0].value).toBe(0);
  });

  it("item que não é objeto (string, número, null, array) → item inválido", () => {
    expect(parseAsaasPaymentListPage({ data: ["pay_1"], hasMore: false }).valid).toBe(false);
    expect(parseAsaasPaymentListPage({ data: [42], hasMore: false }).valid).toBe(false);
    expect(parseAsaasPaymentListPage({ data: [null], hasMore: false }).valid).toBe(false);
    expect(parseAsaasPaymentListPage({ data: [[validItem]], hasMore: false }).valid).toBe(false);
  });

  it("campo 'data' ausente ou não é array → página inválida", () => {
    expect(parseAsaasPaymentListPage({ hasMore: false }).valid).toBe(false);
    expect(parseAsaasPaymentListPage({ data: "não é array", hasMore: false }).valid).toBe(false);
    expect(parseAsaasPaymentListPage({ data: {}, hasMore: false }).valid).toBe(false);
  });

  // hasMore ausente/tipo errado NÃO pode virar `false` por default — isso
  // pararia a paginação achando que já leu tudo (o "capped scan que lê como
  // cobertura completa" que este parser existe pra impedir).
  it("campo 'hasMore' ausente → página inválida (NUNCA default false)", () => {
    const result = parseAsaasPaymentListPage({ data: [validItem] });
    expect(result.valid).toBe(false);
    if (result.valid !== false) throw new Error("esperava valid:false");
    expect(result.reason).toMatch(/hasMore/);
  });

  it("campo 'hasMore' com tipo errado (string 'false') → página inválida", () => {
    expect(parseAsaasPaymentListPage({ data: [validItem], hasMore: "false" }).valid).toBe(false);
    expect(parseAsaasPaymentListPage({ data: [validItem], hasMore: 0 }).valid).toBe(false);
  });

  it("resposta que não é objeto (null/undefined/array/string/número) → página inválida", () => {
    expect(parseAsaasPaymentListPage(null).valid).toBe(false);
    expect(parseAsaasPaymentListPage(undefined).valid).toBe(false);
    expect(parseAsaasPaymentListPage([]).valid).toBe(false);
    expect(parseAsaasPaymentListPage("x").valid).toBe(false);
    expect(parseAsaasPaymentListPage(42).valid).toBe(false);
  });

  it("nunca lança, mesmo com shapes hostis", () => {
    expect(() => parseAsaasPaymentListPage(null)).not.toThrow();
    expect(() => parseAsaasPaymentListPage(undefined)).not.toThrow();
    expect(() => parseAsaasPaymentListPage({})).not.toThrow();
    expect(() => parseAsaasPaymentListPage({ data: null })).not.toThrow();
    expect(() => parseAsaasPaymentListPage({ data: [undefined, null, 42, "x"] })).not.toThrow();
  });

  // Pinagem dos tetos contra o VALOR EXATO, não só "é positivo" — um teto de
  // cobertura é justamente o tipo de número que não pode mudar sem alguém
  // notando (trocar 100×100 por 50×100 cortaria a cobertura segura pela
  // metade e um `toBeGreaterThan(0)` deixaria passar calado).
  it("ASAAS_PAYMENT_LIST_PAGE_SIZE e ASAAS_PAYMENT_LIST_MAX_PAGES pinados no valor exato", () => {
    expect(ASAAS_PAYMENT_LIST_PAGE_SIZE).toBe(100);
    expect(ASAAS_PAYMENT_LIST_MAX_PAGES).toBe(100);
    // Nenhuma assinatura real (mesmo semanal, décadas de histórico) chega
    // perto de 10.000 cobranças — o produto documenta a folga, não é a
    // garantia em si (a garantia é o valor exato pinado acima).
    expect(ASAAS_PAYMENT_LIST_PAGE_SIZE * ASAAS_PAYMENT_LIST_MAX_PAGES).toBe(10_000);
  });
});

// hasAsaasBudgetForAnotherPage — Fix round 1 da Fase 5b (Task 10). Transforma
// o `budgetMs` TOTAL de AsaasRequestOptions numa decisão por página dentro do
// laço de listAsaasSubscriptionPayments (asaas.ts): sem isso, repassar `opts`
// cru a cada página reiniciaria o relógio do orçamento a cada
// `asaasRequest`, e um `budgetMs: 5000` custaria 5s × número de páginas em
// vez de 5s no total.
describe("hasAsaasBudgetForAnotherPage", () => {
  it("ASAAS_PAYMENT_LIST_MIN_PAGE_BUDGET_MS pinado no valor exato", () => {
    expect(ASAAS_PAYMENT_LIST_MIN_PAGE_BUDGET_MS).toBe(2_000);
  });

  it("restante acima do limiar → true (vale tentar mais uma página)", () => {
    expect(hasAsaasBudgetForAnotherPage(ASAAS_PAYMENT_LIST_MIN_PAGE_BUDGET_MS + 1)).toBe(true);
    expect(hasAsaasBudgetForAnotherPage(10_000)).toBe(true);
  });

  it("restante EXATAMENTE no limiar → true (limiar é o mínimo aceitável, não o primeiro valor recusado)", () => {
    expect(hasAsaasBudgetForAnotherPage(ASAAS_PAYMENT_LIST_MIN_PAGE_BUDGET_MS)).toBe(true);
  });

  it("restante abaixo do limiar → false (desiste antes de tentar uma página sem tempo plausível)", () => {
    expect(hasAsaasBudgetForAnotherPage(ASAAS_PAYMENT_LIST_MIN_PAGE_BUDGET_MS - 1)).toBe(false);
    expect(hasAsaasBudgetForAnotherPage(100)).toBe(false);
  });

  it("restante zero ou negativo (orçamento já estourou) → false", () => {
    expect(hasAsaasBudgetForAnotherPage(0)).toBe(false);
    expect(hasAsaasBudgetForAnotherPage(-500)).toBe(false);
  });

  it("nunca lança, mesmo com entrada hostil (NaN/Infinity)", () => {
    expect(() => hasAsaasBudgetForAnotherPage(NaN)).not.toThrow();
    expect(hasAsaasBudgetForAnotherPage(NaN)).toBe(false);
    expect(() => hasAsaasBudgetForAnotherPage(Infinity)).not.toThrow();
    expect(hasAsaasBudgetForAnotherPage(Infinity)).toBe(true);
  });
});

// Extraído de `asaas-billing-events-apply.ts` pro fix round 1 da Fase 5b
// Task 11 (achado "minor" de duplicação): aquele arquivo importa
// `SupabaseClient` (mesmo só de tipo) de `https://esm.sh/@supabase/supabase-js`,
// o que quebra a resolução do Vite pra qualquer teste vitest que tente
// importá-lo — confirmado empiricamente, não por dedução. Mover o mapa pra
// cá (em vez de manter uma segunda cópia em `_shared/asaas-invoice-reconcile-core.ts`
// com um teste de sincronia) elimina a duplicação inteira: agora só existe
// UMA definição, e `asaas-billing-events-apply.ts` importa dela.
describe("mapAsaasBillingTypeToPaymentMethod", () => {
  it("mapeia os 3 tipos conhecidos", () => {
    expect(mapAsaasBillingTypeToPaymentMethod("CREDIT_CARD")).toBe("card");
    expect(mapAsaasBillingTypeToPaymentMethod("PIX")).toBe("pix");
    expect(mapAsaasBillingTypeToPaymentMethod("BOLETO")).toBe("boleto");
  });

  it("null/undefined/não-string/desconhecido nunca chutam um método", () => {
    expect(mapAsaasBillingTypeToPaymentMethod(null)).toBeNull();
    expect(mapAsaasBillingTypeToPaymentMethod(undefined)).toBeNull();
    expect(mapAsaasBillingTypeToPaymentMethod("UNDEFINED")).toBeNull();
    expect(mapAsaasBillingTypeToPaymentMethod("")).toBeNull();
    expect(mapAsaasBillingTypeToPaymentMethod("credit_card")).toBeNull(); // case-sensitive
    expect(mapAsaasBillingTypeToPaymentMethod(123)).toBeNull();
    expect(mapAsaasBillingTypeToPaymentMethod({})).toBeNull();
  });
});
