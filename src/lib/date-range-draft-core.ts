import type { DateRange as PickerRange } from "react-day-picker";

export interface CompleteRange {
  from: Date;
  to: Date;
}

/**
 * Um rascunho de seleção só pode virar filtro quando tem as DUAS pontas.
 */
export function isCompleteRange(
  draft: PickerRange | undefined,
): draft is CompleteRange {
  return Boolean(draft?.from && draft?.to);
}

/**
 * Decide o próximo rascunho do calendário de intervalo a partir de um clique.
 *
 * `pickerRange` é o que o react-day-picker já calculou (`addToRange(dia, draft)`)
 * e entrega no `onSelect`. Com um rascunho COMPLETO, aquela função não começa um
 * intervalo novo: ela ajusta uma das pontas do anterior e devolve outro intervalo
 * completo (ou `undefined`, se o clique cair em cima de uma ponta). Consumir essa
 * saída crua fazia o PRIMEIRO clique de uma seleção nova aplicar o filtro — por um
 * intervalo que ainda herdava a ponta do filtro anterior.
 *
 * Aqui rascunho completo significa "seleção anterior encerrada": o clique começa
 * uma nova, só com `from`, e o filtro espera o segundo clique.
 */
export function nextRangeDraft(
  draft: PickerRange | undefined,
  pickerRange: PickerRange | undefined,
  clickedDay: Date,
): PickerRange {
  if (isCompleteRange(draft)) {
    return { from: clickedDay, to: undefined };
  }
  // Com rascunho incompleto o picker sempre devolve intervalo; o fallback cobre
  // estado inesperado sem perder o clique do usuário.
  return pickerRange ?? { from: clickedDay, to: undefined };
}
