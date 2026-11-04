import type { TableBox } from "./hall-plan-core";

export interface DraftCombination {
  key: string;
  tableIds: string[];
  min: number;
  max: number;
}

export function combinationKey(tableIds: string[]): string {
  return [...new Set(tableIds)].sort().join(",");
}

export function defaultCombinationRange(boxes: TableBox[], tableIds: string[]): { min: number; max: number } {
  const capacities = tableIds
    .map((id) => boxes.find((box) => box.tableId === id)?.capacity)
    .filter((capacity): capacity is number => capacity != null);
  if (!capacities.length) return { min: 1, max: 1 };
  const max = capacities.reduce((sum, capacity) => sum + capacity, 0);
  return { min: Math.min(Math.max(...capacities) + 1, max), max };
}

function halfExtents(box: Pick<TableBox, "w" | "h" | "rotation">): { hx: number; hy: number } {
  const rad = (box.rotation * Math.PI) / 180;
  const c = Math.abs(Math.cos(rad));
  const s = Math.abs(Math.sin(rad));
  return { hx: (box.w * c + box.h * s) / 2, hy: (box.w * s + box.h * c) / 2 };
}

function areNeighbors(a: TableBox, b: TableBox, gap: number): boolean {
  const ea = halfExtents(a);
  const eb = halfExtents(b);
  const dx = Math.max(0, Math.abs(a.x - b.x) - ea.hx - eb.hx);
  const dy = Math.max(0, Math.abs(a.y - b.y) - ea.hy - eb.hy);
  return Math.hypot(dx, dy) <= gap;
}

export function suggestRowCombinations(boxes: TableBox[], selectedIds: string[], gapCm = 60): DraftCombination[] {
  const selected = new Set(selectedIds);
  const eligible = boxes.filter((box) => selected.has(box.tableId) && box.positioned && box.bookable);
  const neighbors = eligible.map(() => new Set<number>());
  for (let i = 0; i < eligible.length; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      if (areNeighbors(eligible[i], eligible[j], gapCm)) {
        neighbors[i].add(j);
        neighbors[j].add(i);
      }
    }
  }

  const visited = new Set<number>();
  const result: DraftCombination[] = [];
  const keys = new Set<string>();
  for (let start = 0; start < eligible.length; start++) {
    if (visited.has(start)) continue;
    const component: number[] = [];
    const stack = [start];
    visited.add(start);
    while (stack.length) {
      const current = stack.pop()!;
      component.push(current);
      for (const neighbor of neighbors[current]) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          stack.push(neighbor);
        }
      }
    }
    if (component.length < 2) continue;
    const xs = component.map((i) => eligible[i].x);
    const ys = component.map((i) => eligible[i].y);
    const xSpread = Math.max(...xs) - Math.min(...xs);
    const ySpread = Math.max(...ys) - Math.min(...ys);
    const ordered = component.sort((a, b) => xSpread >= ySpread
      ? eligible[a].x - eligible[b].x || eligible[a].y - eligible[b].y
      : eligible[a].y - eligible[b].y || eligible[a].x - eligible[b].x);
    const maxSize = Math.min(ordered.length, 12);
    for (let size = 2; size <= maxSize; size++) {
      for (let offset = 0; offset + size <= ordered.length; offset++) {
        const window = ordered.slice(offset, offset + size);
        if (!window.slice(1).every((index, i) => neighbors[window[i]].has(index))) continue;
        const tableIds = window.map((index) => eligible[index].tableId);
        const key = combinationKey(tableIds);
        if (keys.has(key)) continue;
        keys.add(key);
        result.push({ key, tableIds, ...defaultCombinationRange(boxes, tableIds) });
      }
    }
  }
  return result;
}

export type CombinationValidationError = "too_few" | "duplicate" | "not_bookable" | "range";

export function validateCombinations(
  drafts: DraftCombination[],
  boxes: TableBox[],
): Array<{ key: string; error: CombinationValidationError }> {
  const seen = new Set<string>();
  const byId = new Map(boxes.map((box) => [box.tableId, box]));
  const errors: Array<{ key: string; error: CombinationValidationError }> = [];
  for (const draft of drafts) {
    const uniqueIds = new Set(draft.tableIds);
    const key = combinationKey(draft.tableIds);
    const repeated = seen.has(key);
    seen.add(key);
    let error: CombinationValidationError | null = null;
    if (uniqueIds.size < 2) error = "too_few";
    else if ([...uniqueIds].some((id) => !byId.has(id) || byId.get(id)!.bookable === false)) error = "not_bookable";
    else if (!Number.isInteger(draft.min) || !Number.isInteger(draft.max) || draft.min < 1 || draft.max < draft.min || uniqueIds.size > 12) error = "range";
    else if (repeated) error = "duplicate";
    if (error) errors.push({ key: draft.key, error });
  }
  return errors;
}
