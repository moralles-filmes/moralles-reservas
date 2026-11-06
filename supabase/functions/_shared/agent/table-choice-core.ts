// Núcleo puro da mesa escolhida pelo cliente no link do WhatsApp: entender o que
// ele escreveu ("12", "mesa 12", "3+4+5") e achar a mesa ou a combinação do
// salão. Sem I/O: compatível com Deno e Vitest.

import type { SeatChoice } from "../availability-core.ts";

/** Acima disso não é número de mesa (evita ler telefone ou código como mesa). */
const MAX_TABLE_NUMBER = 9999;
/** Uma combinação real tem poucas mesas; lista longa é ruído. */
const MAX_TABLES = 12;

/**
 * Números de mesa do texto, ordenados e sem repetição; null se não houver
 * número (ex.: "mesa doze") ou se a lista não parecer uma escolha de mesa.
 */
export function parseTableChoice(text: string): number[] | null {
  if (typeof text !== "string") return null;
  const found = text.match(/\d+/g);
  if (!found) return null;
  const nums = [...new Set(found.map((s) => Number(s)))].sort((a, b) => a - b);
  if (nums.length > MAX_TABLES) return null;
  if (nums.some((n) => !Number.isInteger(n) || n < 1 || n > MAX_TABLE_NUMBER)) return null;
  return nums;
}

type ChoiceTable = { id: string; number: number; bookable: boolean };
type ChoiceCombination = { id: string; tableIds: string[] };

/**
 * Um número → a mesa reservável com esse número; vários → a combinação ativa
 * com exatamente esse conjunto de mesas. Número ambíguo (duas mesas com o mesmo
 * número no salão), mesa não reservável ou conjunto sem combinação → null.
 * As listas já vêm do salão da reserva, dentro da unidade do turno.
 */
export function resolveTableChoice(
  numbers: number[],
  tables: ChoiceTable[],
  combinations: ChoiceCombination[],
): SeatChoice | null {
  if (numbers.length === 0) return null;
  const ids: string[] = [];
  for (const n of numbers) {
    const matches = tables.filter((t) => t.number === n);
    if (matches.length !== 1 || matches[0].bookable !== true) return null;
    ids.push(matches[0].id);
  }
  if (ids.length === 1) return { kind: "table", id: ids[0] };
  const want = new Set(ids);
  const combo = combinations.filter(
    (c) => c.tableIds.length === want.size && c.tableIds.every((id) => want.has(id)),
  );
  return combo.length === 1 ? { kind: "combination", id: combo[0].id } : null;
}

/** "Mesa 12" / "Mesas 3+4+5" — mesmo rótulo da página (`seatLabel`). */
export function tableChoiceLabel(numbers: number[]): string {
  const sorted = [...numbers].sort((a, b) => a - b);
  return `${sorted.length === 1 ? "Mesa" : "Mesas"} ${sorted.join("+")}`;
}

/** Rótulos das opções livres do mapa, na ordem dele (menor primeiro), até `limit`. */
export function choiceLabelsFromMap(
  map: {
    tables: Array<{ id: string; number: number }>;
    options: Array<{ choice: SeatChoice; tableIds: string[]; available: boolean }>;
  },
  limit: number,
): string[] {
  const numberOf = new Map(map.tables.map((t) => [t.id, t.number]));
  const out: string[] = [];
  for (const option of map.options) {
    if (out.length >= limit) break;
    if (!option.available) continue;
    const nums = option.tableIds.map((id) => numberOf.get(id));
    if (nums.some((n) => n === undefined)) continue;
    out.push(tableChoiceLabel(nums as number[]));
  }
  return out;
}
