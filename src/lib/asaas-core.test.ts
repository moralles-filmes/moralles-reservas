import { describe, it, expect } from "vitest";
import {
  parseAsaasEnv,
  resolveAsaasBaseUrl,
  detectKeyEnv,
  validateKeyForEnv,
  ASAAS_SANDBOX_BASE_URL,
  ASAAS_PRODUCTION_BASE_URL,
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
});
