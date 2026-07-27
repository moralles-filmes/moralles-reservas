import { describe, it, expect } from "vitest";
import { parseAmountReaisToCents } from "./billing-amount";

describe("parseAmountReaisToCents", () => {
  it("com vírgula: vírgula é decimal, ponto é milhar", () => {
    expect(parseAmountReaisToCents("750,00")).toBe(75000);
    expect(parseAmountReaisToCents("1.750,00")).toBe(175000);
    expect(parseAmountReaisToCents("0,50")).toBe(50);
    expect(parseAmountReaisToCents("1.234.567,89")).toBe(123456789);
  });

  it("sem vírgula: exatamente 2 dígitos após o último ponto é decimal", () => {
    expect(parseAmountReaisToCents("750.00")).toBe(75000);
  });

  it("sem vírgula: contagem diferente de 2 após o último ponto é milhar", () => {
    expect(parseAmountReaisToCents("1.750")).toBe(175000);
  });

  it("entradas vazias ou não numéricas retornam NaN", () => {
    expect(parseAmountReaisToCents("")).toBeNaN();
    expect(parseAmountReaisToCents("   ")).toBeNaN();
    expect(parseAmountReaisToCents("abc")).toBeNaN();
  });

  it("não valida sinal — negativo parseia normalmente, sinal é responsabilidade do chamador", () => {
    expect(parseAmountReaisToCents("-750,00")).toBe(-75000);
  });

  it("sem ponto nem vírgula: número inteiro em reais", () => {
    expect(parseAmountReaisToCents("750")).toBe(75000);
  });

  it("ponto duplo antes do decimal ('1.750.00') trata tudo antes do último ponto como milhar", () => {
    expect(parseAmountReaisToCents("1.750.00")).toBe(175000);
  });

  it("não remove ponto às cegas (bug original: '750.00' virava R$ 75.000,00)", () => {
    // Cem vezes o valor digitado seria 7500000 — a regressão que este teste
    // trava.
    expect(parseAmountReaisToCents("750.00")).not.toBe(7500000);
  });
});

describe("round-trip com centsToBRLInput (BillingPlans.tsx)", () => {
  // centsToBRLInput não é exportado de BillingPlans.tsx (é local ao arquivo);
  // reproduz aqui a mesma fórmula: (cents / 100).toFixed(2).replace(".", ",").
  // Prova o requisito do review final: abrir um plano existente e salvar sem
  // mexer no campo não pode alterar o valor gravado.
  const centsToBRLInput = (cents: number) => (cents / 100).toFixed(2).replace(".", ",");

  it("qualquer valor em centavos sobrevive ao ciclo formatar → reparsear", () => {
    for (const cents of [0, 50, 199, 500, 14990, 75000, 449900, 123456789]) {
      expect(parseAmountReaisToCents(centsToBRLInput(cents))).toBe(cents);
    }
  });
});
