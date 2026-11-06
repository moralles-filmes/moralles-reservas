/** "Mesa 12" ou "Mesas 3+4+5" (ordem crescente, sem alterar o array). */
export function seatLabel(nums: number[]): string {
  return `${nums.length === 1 ? "Mesa" : "Mesas"} ${[...nums].sort((a, b) => a - b).join("+")}`;
}
