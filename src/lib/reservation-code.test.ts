import { describe, it, expect } from "vitest";
import { extractReservationCode } from "./reservation-code";

describe("extractReservationCode", () => {
  it("sem '#': remove não-alfanumérico e corta em 8 (digitação tecla a tecla / código puro colado)", () => {
    expect(extractReservationCode("ab1c2def")).toBe("AB1C2DEF");
    expect(extractReservationCode("  AB1C2DEF  ")).toBe("AB1C2DEF");
    expect(extractReservationCode("AB1C2DEFGH")).toBe("AB1C2DEF");
    expect(extractReservationCode("")).toBe("");
  });

  it("com um único '#' no texto: pega os 8 primeiros caracteres do que vem depois dele", () => {
    expect(extractReservationCode("#8GY6EG9X")).toBe("8GY6EG9X");
    expect(extractReservationCode("Código: #8GY6EG9X")).toBe("8GY6EG9X");
  });

  it("'#' sozinho, sem nada alfanumérico depois, devolve vazio", () => {
    expect(extractReservationCode("#")).toBe("");
    expect(extractReservationCode("# ")).toBe("");
  });

  it("ignora texto que vem DEPOIS do código, quando é o ÚNICO '#' do texto (quebra de linha, resto da mensagem)", () => {
    expect(extractReservationCode("#8GY6EG9XRESTODOTEXTO")).toBe("8GY6EG9X");
    expect(extractReservationCode("🔑 Código: #8GY6EG9X\n\nAté logo! 😊")).toBe("8GY6EG9X");
  });

  // FIX ROUND 3, achado 2 — descoberto ao testar o achado 1 (abaixo) contra um
  // <input> de verdade: pra colar num campo de UMA linha, o próprio HTML
  // remove quebras de linha ANTES do onChange rodar, sem inserir espaço no
  // lugar. Isso funde o código com a palavra seguinte na mensagem colada —
  // acontece até com o template DEFAULT do lembrete, sem hashtag nenhuma.
  // Este teste simula a string exatamente como o <input> a entregaria (já
  // sem as quebras de linha), pra travar o achado no núcleo puro e não só no
  // teste de componente (que depende do jsdom simular o <input> certo).
  it("único '#', com lixo fundido ao código pela remoção de quebra de linha do <input>: ainda extrai o código", () => {
    expect(
      extractReservationCode("CÓDIGO: #8GY6EG9XACOMPANHE SUA RESERVA: HTTPS://EXEMPLO")
    ).toBe("8GY6EG9X");
  });

  // FIX ROUND 3, achado 1 — seleção por formato entre múltiplos "#": quando
  // há MAIS de um "#" no texto, só um candidato de comprimento EXATO 8 (o
  // tamanho real de reservation_code, confirmado contra produção:
  // min(length) = max(length) = 8) desambigua com segurança. Zero ou mais de
  // um candidato de 8 cai no fallback sem âncora.
  describe("seleção por formato entre múltiplos '#' (FIX ROUND 3, achado 1)", () => {
    it("dois '#', só um com 8 caracteres: usa o de 8, mesmo não sendo o ÚLTIMO", () => {
      // Achado da revisão: lembrete customizável pelo lojista pode ter uma
      // hashtag de Instagram (#renSushiOficial, 15 chars) DEPOIS do código.
      // "último #" (round 2) pegava a hashtag; comprimento exato resolve.
      expect(
        extractReservationCode("Codigo #8GY6EG9X. Segue a gente no insta #renSushiOficial")
      ).toBe("8GY6EG9X");
      expect(extractReservationCode("#velho #8GY6EG9X")).toBe("8GY6EG9X");
    });

    it("zero candidatos de 8: nenhum '#' do texto tem sequência de 8 — cai no fallback", () => {
      // "#AB" (2 chars) e "#ABCDEFGHIJK" (11 chars): nenhum tem exatamente 8.
      // Fallback: remove tudo que não é alfanumérico do texto INTEIRO e corta
      // em 8 — "AB" + "DEPOIS" + "ABCDEFGHIJK" = "ABDEPOISABCDEFGHIJK",
      // primeiros 8 = "ABDEPOIS".
      expect(extractReservationCode("#AB depois #ABCDEFGHIJK")).toBe("ABDEPOIS");
    });

    it("dois candidatos de 8: ambíguo — cai no fallback (não tenta adivinhar qual é o real)", () => {
      // "#8GY6EG9X" (8) e "#ABCDEFGH" (8): os dois batem — sem critério pra
      // desempatar, cai no fallback do texto inteiro. Fallback:
      // "8GY6EG9X"+"DEPOIS"+"ABCDEFGH" = "8GY6EG9XDEPOISABCDEFGH", primeiros
      // 8 = "8GY6EG9X" — recupera o código real aqui só porque ele vem
      // primeiro no texto, não porque o fallback "entende" qual é o real.
      expect(extractReservationCode("#8GY6EG9X depois #ABCDEFGH")).toBe("8GY6EG9X");
    });

    it("'#' avulso DEPOIS de um código válido não apaga o campo (regressão da round 2)", () => {
      expect(extractReservationCode("AB1C2DEF#")).toBe("AB1C2DEF");
    });
  });
});
