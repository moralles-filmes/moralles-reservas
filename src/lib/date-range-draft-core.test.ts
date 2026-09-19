import { describe, it, expect } from "vitest";
import { addToRange, type DateRange as PickerRange } from "react-day-picker";
import { isCompleteRange, nextRangeDraft } from "./date-range-draft-core";

// Oráculo real: `addToRange` é a função que o próprio react-day-picker usa para
// montar a seleção antes de chamar `onSelect` (SelectRangeProvider.onDayClick).
// Os testes consomem a biblioteca instalada em vez de reproduzir a regra dela,
// então uma mudança de comportamento numa atualização aparece aqui.
const dia = (d: number, mes = 9, ano = 2026) => new Date(ano, mes - 1, d);

/**
 * Handler ANTIGO: entregava a saída crua do picker direto ao filtro.
 * Mantido como controle positivo — é o defeito, e ele tem que continuar
 * demonstrável para que os testes abaixo signifiquem alguma coisa.
 */
function handlerAntigo(draft: PickerRange | undefined, clicado: Date) {
  const range = addToRange(clicado, draft);
  return { draft: range, filtrou: Boolean(range?.from && range?.to) };
}

/** Handler NOVO: mesma entrada, decisão pelo núcleo. */
function handlerNovo(draft: PickerRange | undefined, clicado: Date) {
  const range = addToRange(clicado, draft);
  const next = nextRangeDraft(draft, range, clicado);
  return { draft: next, filtrou: isCompleteRange(next) };
}

describe("controle positivo — o defeito relatado", () => {
  // Filtro em vigor quando o usuário abre o calendário para pedir 10/09–18/09.
  const emVigor: PickerRange = { from: dia(20, 8), to: dia(18) };

  it("handler antigo filtra no PRIMEIRO clique (é o bug)", () => {
    const { draft, filtrou } = handlerAntigo(emVigor, dia(10));

    expect(filtrou).toBe(true);
    // Pior que filtrar cedo: filtra por um intervalo que o usuário não pediu —
    // a ponta inicial é a do filtro velho, não o dia clicado.
    expect(draft?.from).toEqual(dia(20, 8));
    expect(draft?.to).toEqual(dia(10));
  });

  it("clique ANTES da ponta inicial também devolvia intervalo completo", () => {
    expect(handlerAntigo(emVigor, dia(1, 8)).filtrou).toBe(true);
  });

  it("clique exatamente na ponta inicial limpava a seleção inteira", () => {
    const { draft, filtrou } = handlerAntigo(emVigor, dia(20, 8));

    expect(filtrou).toBe(false);
    expect(draft).toBeUndefined();
  });
});

describe("nextRangeDraft — rascunho completo significa seleção anterior encerrada", () => {
  const emVigor: PickerRange = { from: dia(20, 8), to: dia(18) };

  it("primeiro clique começa seleção nova no dia clicado e NÃO filtra", () => {
    const { draft, filtrou } = handlerNovo(emVigor, dia(10));

    expect(filtrou).toBe(false);
    expect(draft.from).toEqual(dia(10));
    expect(draft.to).toBeUndefined();
  });

  it("vale para clique antes, depois e em cima de cada ponta do filtro em vigor", () => {
    for (const clicado of [dia(1, 8), dia(20, 8), dia(10), dia(18), dia(30)]) {
      const { draft, filtrou } = handlerNovo(emVigor, clicado);

      expect(filtrou).toBe(false);
      expect(draft.from).toEqual(clicado);
      expect(draft.to).toBeUndefined();
    }
  });
});

describe("nextRangeDraft — segundo clique fecha o intervalo", () => {
  it("10/09 depois 18/09: só o segundo clique filtra (o caso do relato)", () => {
    const emVigor: PickerRange = { from: dia(20, 8), to: dia(18) };

    const primeiro = handlerNovo(emVigor, dia(10));
    expect(primeiro.filtrou).toBe(false);

    const segundo = handlerNovo(primeiro.draft, dia(18));
    expect(segundo.filtrou).toBe(true);
    expect(segundo.draft.from).toEqual(dia(10));
    expect(segundo.draft.to).toEqual(dia(18));
  });

  it("segundo clique anterior ao primeiro inverte as pontas em vez de inverter o filtro", () => {
    const primeiro = handlerNovo(undefined, dia(18));
    const segundo = handlerNovo(primeiro.draft, dia(10));

    expect(segundo.filtrou).toBe(true);
    expect(segundo.draft.from).toEqual(dia(10));
    expect(segundo.draft.to).toEqual(dia(18));
  });

  it("clicar duas vezes no mesmo dia filtra esse único dia", () => {
    const primeiro = handlerNovo(undefined, dia(10));
    const segundo = handlerNovo(primeiro.draft, dia(10));

    expect(segundo.filtrou).toBe(true);
    expect(segundo.draft.from).toEqual(dia(10));
    expect(segundo.draft.to).toEqual(dia(10));
  });

  it("terceiro clique recomeça, não estende o intervalo já fechado", () => {
    const primeiro = handlerNovo(undefined, dia(10));
    const segundo = handlerNovo(primeiro.draft, dia(18));
    const terceiro = handlerNovo(segundo.draft, dia(25));

    expect(terceiro.filtrou).toBe(false);
    expect(terceiro.draft.from).toEqual(dia(25));
    expect(terceiro.draft.to).toBeUndefined();
  });
});

describe("isCompleteRange", () => {
  it("exige as duas pontas", () => {
    expect(isCompleteRange(undefined)).toBe(false);
    expect(isCompleteRange({ from: undefined, to: undefined })).toBe(false);
    expect(isCompleteRange({ from: dia(10), to: undefined })).toBe(false);
    expect(isCompleteRange({ from: undefined, to: dia(18) })).toBe(false);
    expect(isCompleteRange({ from: dia(10), to: dia(18) })).toBe(true);
  });
});
