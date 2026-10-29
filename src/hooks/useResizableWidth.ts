import { useCallback, useRef, useState } from "react";

type Options = {
  /** Chave do localStorage — preferência de quem vê, por navegador. */
  storageKey: string;
  defaultWidth: number;
  min: number;
  max: number;
  /** Passo das setas do teclado, em px. */
  step?: number;
};

export function clampWidth(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function readStored(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? clampWidth(n, min, max) : fallback;
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: number) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* storage indisponível (aba privada, bloqueio): a largura vale só nesta visita */
  }
}

/**
 * Largura ajustável de um painel por uma alça vertical: arrastar (mouse/toque),
 * setas (±step), Home/End (mín/máx) e duplo clique (volta ao padrão). Grava ao
 * soltar a alça, não a cada movimento.
 */
export function useResizableWidth({ storageKey, defaultWidth, min, max, step = 16 }: Options) {
  const [width, setWidthState] = useState(() => readStored(storageKey, defaultWidth, min, max));
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const latest = useRef(width);
  latest.current = width;

  const commit = useCallback(
    (value: number) => {
      const next = clampWidth(value, min, max);
      setWidthState(next);
      writeStored(storageKey, next);
    },
    [storageKey, min, max],
  );

  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { startX: e.clientX, startWidth: latest.current };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    if (!drag.current) return;
    setWidthState(clampWidth(drag.current.startWidth + e.clientX - drag.current.startX, min, max));
  };

  const onPointerUp = (e: React.PointerEvent<HTMLElement>) => {
    if (!drag.current) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    writeStored(storageKey, latest.current);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    const delta = { ArrowLeft: -step, ArrowRight: step }[e.key];
    if (delta !== undefined) commit(latest.current + delta);
    else if (e.key === "Home") commit(min);
    else if (e.key === "End") commit(max);
    else return;
    e.preventDefault();
  };

  const reset = () => commit(defaultWidth);

  return {
    width,
    handleProps: {
      role: "separator" as const,
      "aria-orientation": "vertical" as const,
      "aria-valuemin": min,
      "aria-valuemax": max,
      "aria-valuenow": width,
      tabIndex: 0,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      onKeyDown,
      onDoubleClick: reset,
    },
  };
}
