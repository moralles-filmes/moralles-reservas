import { describe, it, expect } from "vitest";
import { extractReservationCode } from "./reservation-code";

describe("extractReservationCode", () => {
  it("sem '#': remove não-alfanumérico e corta em 8 (digitação tecla a tecla / código puro colado)", () => {
    expect(extractReservationCode("ab1c2def")).toBe("AB1C2DEF");
    expect(extractReservationCode("  AB1C2DEF  ")).toBe("AB1C2DEF");
    expect(extractReservationCode("AB1C2DEFGH")).toBe("AB1C2DEF");
    expect(extractReservationCode("")).toBe("");
  });

  it("com '#': pega a sequência alfanumérica logo depois do ÚLTIMO '#', cortada em 8", () => {
    expect(extractReservationCode("#8GY6EG9X")).toBe("8GY6EG9X");
    expect(extractReservationCode("Código: #8GY6EG9X")).toBe("8GY6EG9X");
    expect(extractReservationCode("#velho #8GY6EG9X")).toBe("8GY6EG9X");
  });

  it("'#' sozinho, sem nada alfanumérico depois, devolve vazio", () => {
    expect(extractReservationCode("#")).toBe("");
    expect(extractReservationCode("# ")).toBe("");
  });

  it("ignora texto que vem DEPOIS do código (quebra de linha, resto da mensagem)", () => {
    expect(extractReservationCode("#8GY6EG9XRESTODOTEXTO")).toBe("8GY6EG9X");
    expect(extractReservationCode("🔑 Código: #8GY6EG9X\n\nAté logo! 😊")).toBe("8GY6EG9X");
  });
});
