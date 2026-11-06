/** "Mesa 12" ou "Mesas 3+4+5" (ordem crescente, sem alterar o array). */
export function seatLabel(nums: number[]): string {
  return `${nums.length === 1 ? "Mesa" : "Mesas"} ${[...nums].sort((a, b) => a - b).join("+")}`;
}

/** "Mesa 12" → "Quero a mesa 12"; "Mesas 3+4+5" → "Quero as mesas 3+4+5". */
export function buildChoiceMessage(label: string): string {
  const lower = label.charAt(0).toLowerCase() + label.slice(1);
  return lower.startsWith("mesas ") ? `Quero as ${lower}` : `Quero a ${lower}`;
}
