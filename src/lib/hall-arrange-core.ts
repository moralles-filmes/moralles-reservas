/** Arranjo puro dos salões lado a lado (modo "Todos" do Salão ao vivo). Medidas em cm. */
export const HALL_GAP_CM = 200;
/** Faixa acima de cada salão para a etiqueta com o nome. */
export const HALL_LABEL_CM = 120;

export interface HallArrangeItem {
  id: string;
  widthCm: number;
  depthCm: number;
}

export interface HallArrangement {
  /** Canto superior esquerdo da PLANTA de cada salão (já descontada a faixa da etiqueta). */
  placements: Map<string, { xCm: number; yCm: number }>;
  widthCm: number;
  depthCm: number;
}

export function arrangeHalls(items: HallArrangeItem[], maxRowWidthCm?: number): HallArrangement {
  const placements = new Map<string, { xCm: number; yCm: number }>();
  if (items.length === 0) return { placements, widthCm: 0, depthCm: 0 };

  const widest = Math.max(...items.map((i) => i.widthCm));
  const total = items.reduce((s, i) => s + i.widthCm, 0);
  // Padrão: ~sqrt(n) linhas (mín. 1), então 2 e 3 salões ficam lado a lado e 4 viram 2x2.
  const rowCount = Math.max(1, Math.floor(Math.sqrt(items.length)));
  const perRow = Math.ceil(items.length / rowCount);
  const maxRow = maxRowWidthCm ?? Math.max(widest, total / rowCount + HALL_GAP_CM * (perRow - 1));

  const rows: HallArrangeItem[][] = [];
  let rowW = 0;
  for (const item of items) {
    const last = rows[rows.length - 1];
    if (last && rowW + HALL_GAP_CM + item.widthCm <= maxRow) {
      last.push(item);
      rowW += HALL_GAP_CM + item.widthCm;
    } else {
      rows.push([item]);
      rowW = item.widthCm;
    }
  }

  let top = 0;
  let widthCm = 0;
  for (const row of rows) {
    let left = 0;
    let rowH = 0;
    for (const item of row) {
      placements.set(item.id, { xCm: left, yCm: top + HALL_LABEL_CM });
      left += item.widthCm + HALL_GAP_CM;
      rowH = Math.max(rowH, HALL_LABEL_CM + item.depthCm);
    }
    widthCm = Math.max(widthCm, left - HALL_GAP_CM);
    top += rowH + HALL_GAP_CM;
  }
  return { placements, widthCm, depthCm: top - HALL_GAP_CM };
}
