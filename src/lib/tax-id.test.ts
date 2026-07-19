import { describe, it, expect } from "vitest";
import {
  normalizeTaxId,
  isValidTaxId,
  formatTaxId,
  validateTaxId,
} from "./tax-id";
import {
  normalizeTaxId as normalizeTaxIdBackend,
  isValidTaxId as isValidTaxIdBackend,
} from "../../supabase/functions/_shared/tax-id";

// CPFs/CNPJs válidos gerados (dígito verificador correto). Não pertencem a
// ninguém — são os números canônicos de teste usados no Brasil.
const CPF_VALIDO = "52998224725";
const CPF_VALIDO_2 = "11144477735";
const CNPJ_VALIDO = "11222333000181";

describe("normalizeTaxId", () => {
  it("strips mask characters", () => {
    expect(normalizeTaxId("529.982.247-25")).toBe(CPF_VALIDO);
    expect(normalizeTaxId("11.222.333/0001-81")).toBe(CNPJ_VALIDO);
  });
  it("handles empty input", () => {
    expect(normalizeTaxId("")).toBe("");
    expect(normalizeTaxId(null)).toBe("");
    expect(normalizeTaxId(undefined)).toBe("");
  });
});

describe("isValidTaxId — CPF", () => {
  it("accepts a valid CPF, masked or not", () => {
    expect(isValidTaxId(CPF_VALIDO)).toBe(true);
    expect(isValidTaxId("529.982.247-25")).toBe(true);
    expect(isValidTaxId(CPF_VALIDO_2)).toBe(true);
  });
  it("rejects a CPF with a wrong check digit", () => {
    expect(isValidTaxId("52998224726")).toBe(false);
    expect(isValidTaxId("11144477730")).toBe(false);
  });
  it("rejects repeated-digit CPFs (they pass the algorithm)", () => {
    // 111.111.111-11 satisfaz o cálculo do dígito verificador. Sem o guard
    // explícito, todo CPF de dígito repetido passaria.
    expect(isValidTaxId("11111111111")).toBe(false);
    expect(isValidTaxId("00000000000")).toBe(false);
    expect(isValidTaxId("99999999999")).toBe(false);
  });
  it("rejects wrong length", () => {
    expect(isValidTaxId("1234567890")).toBe(false);
    expect(isValidTaxId("123456789012")).toBe(false);
  });
});

describe("isValidTaxId — CNPJ", () => {
  it("accepts a valid CNPJ, masked or not", () => {
    expect(isValidTaxId(CNPJ_VALIDO)).toBe(true);
    expect(isValidTaxId("11.222.333/0001-81")).toBe(true);
  });
  it("rejects a CNPJ with a wrong check digit", () => {
    expect(isValidTaxId("11222333000182")).toBe(false);
  });
  it("rejects repeated-digit CNPJs", () => {
    expect(isValidTaxId("11111111111111")).toBe(false);
  });
});

describe("formatTaxId", () => {
  it("masks CPF and CNPJ by length", () => {
    expect(formatTaxId(CPF_VALIDO)).toBe("529.982.247-25");
    expect(formatTaxId(CNPJ_VALIDO)).toBe("11.222.333/0001-81");
  });
  it("returns partial input untouched", () => {
    expect(formatTaxId("5299822")).toBe("5299822");
    expect(formatTaxId("")).toBe("");
  });
});

describe("validateTaxId", () => {
  it("reports a PT-BR reason on failure", () => {
    const r = validateTaxId("52998224726");
    expect(r.valid).toBe(false);
    expect(r.reason).toContain("inválido");
    expect(r.digits).toBe("52998224726");
  });
  it("respects allowEmpty", () => {
    expect(validateTaxId("", { allowEmpty: true }).valid).toBe(true);
    expect(validateTaxId("", { allowEmpty: false }).valid).toBe(false);
    expect(validateTaxId("").valid).toBe(false); // default: obrigatório
  });
  it("returns normalized digits on success", () => {
    const r = validateTaxId("529.982.247-25");
    expect(r.valid).toBe(true);
    expect(r.digits).toBe(CPF_VALIDO);
  });
});

// O teste que o precedente do phone.ts não tem: prova que as duas cópias
// concordam, em vez de confiar num comentário.
describe("sincronia entre src/lib/tax-id.ts e _shared/tax-id.ts", () => {
  const CORPUS = [
    CPF_VALIDO, CPF_VALIDO_2, CNPJ_VALIDO,
    "529.982.247-25", "11.222.333/0001-81",
    "52998224726", "11222333000182",
    "11111111111", "00000000000", "11111111111111",
    "1234567890", "123456789012", "", "abc", "5299822",
  ];

  it("normalizeTaxId concorda em todo o corpus", () => {
    for (const input of CORPUS) {
      expect(normalizeTaxIdBackend(input)).toBe(normalizeTaxId(input));
    }
  });

  it("isValidTaxId concorda em todo o corpus", () => {
    for (const input of CORPUS) {
      expect(isValidTaxIdBackend(input)).toBe(isValidTaxId(input));
    }
  });
});
