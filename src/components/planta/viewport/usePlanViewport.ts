import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import {
  IDENTITY_VIEWPORT,
  clampPan,
  centerOn as centerOnCore,
  panBy,
  zoomAt,
  type Viewport,
} from "@/lib/plan-viewport-core";

const PAN_THRESHOLD_PX = 5;
const BUTTON_ZOOM_FACTOR = 1.25;
const IGNORE_SELECTOR = "button, a, input, [data-no-pan]";

function prefersReducedMotion() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}

/**
 * Pan e zoom de uma planta. O conteúdo no zoom 1 tem o tamanho da janela (container).
 * O estado vivo fica em ref; o transform é aplicado direto no DOM (rAF nos gestos).
 */
export function usePlanViewport() {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<Viewport>(IDENTITY_VIEWPORT);
  const rafRef = useRef<number | null>(null);
  const [zoom, setZoom] = useState(1);

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{
    mode: "none" | "pending" | "pan" | "pinch";
    startX: number;
    startY: number;
    lastDist: number;
    lastMidX: number;
    lastMidY: number;
  }>({ mode: "none", startX: 0, startY: 0, lastDist: 0, lastMidX: 0, lastMidY: 0 });
  const didPan = useRef(false);

  const paint = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;
    const v = viewRef.current;
    el.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.zoom})`;
  }, []);

  const schedule = useCallback(() => {
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      paint();
    });
  }, [paint]);

  const size = () => {
    const c = containerRef.current;
    return { w: c?.clientWidth ?? 0, h: c?.clientHeight ?? 0 };
  };

  const commit = useCallback(
    (next: Viewport) => {
      const { w, h } = size();
      viewRef.current = clampPan(next, w, h, w, h);
    },
    [],
  );

  /** Ação de botão/teclado: aplica na hora, com transição curta se o usuário não pediu menos movimento. */
  const applyAction = useCallback(
    (next: Viewport) => {
      commit(next);
      const el = contentRef.current;
      if (el) el.style.transition = prefersReducedMotion() ? "" : "transform 180ms ease-out";
      paint();
      setZoom(viewRef.current.zoom);
    },
    [commit, paint],
  );

  const zoomBy = useCallback(
    (factor: number) => {
      const { w, h } = size();
      applyAction(zoomAt(viewRef.current, factor, w / 2, h / 2));
    },
    [applyAction],
  );

  const zoomIn = useCallback(() => zoomBy(BUTTON_ZOOM_FACTOR), [zoomBy]);
  const zoomOut = useCallback(() => zoomBy(1 / BUTTON_ZOOM_FACTOR), [zoomBy]);
  const reset = useCallback(() => applyAction(IDENTITY_VIEWPORT), [applyAction]);
  const centerOn = useCallback(
    (cx: number, cy: number) => {
      const { w, h } = size();
      applyAction(centerOnCore(viewRef.current, cx, cy, w, h));
    },
    [applyAction],
  );

  const endGesture = useCallback(() => {
    const wasActive = gesture.current.mode === "pan" || gesture.current.mode === "pinch";
    gesture.current.mode = "none";
    if (wasActive) setZoom(viewRef.current.zoom);
  }, []);

  const localPoint = (clientX: number, clientY: number) => {
    const r = containerRef.current?.getBoundingClientRect();
    return { x: clientX - (r?.left ?? 0), y: clientY - (r?.top ?? 0) };
  };

  const onPointerDown = useCallback((e: PointerEvent<HTMLDivElement>) => {
    if (e.target instanceof Element && e.target.closest(IGNORE_SELECTOR)) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    const el = contentRef.current;
    if (el) el.style.transition = "";
    if (pointers.current.size === 1) {
      didPan.current = false;
      g.mode = "pending";
      g.startX = e.clientX;
      g.startY = e.clientY;
      g.lastMidX = e.clientX;
      g.lastMidY = e.clientY;
    } else if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      g.mode = "pinch";
      g.lastDist = Math.hypot(a.x - b.x, a.y - b.y);
      g.lastMidX = (a.x + b.x) / 2;
      g.lastMidY = (a.y + b.y) / 2;
      didPan.current = true;
      try {
        e.currentTarget.setPointerCapture?.(e.pointerId);
      } catch {
        /* ponteiro já liberado */
      }
    }
  }, []);

  const onPointerMove = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (!pointers.current.has(e.pointerId)) return;
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const g = gesture.current;
      if (g.mode === "pending") {
        if (Math.hypot(e.clientX - g.startX, e.clientY - g.startY) < PAN_THRESHOLD_PX) return;
        g.mode = "pan";
        didPan.current = true;
        g.lastMidX = e.clientX;
        g.lastMidY = e.clientY;
        try {
          e.currentTarget.setPointerCapture?.(e.pointerId);
        } catch {
          /* ponteiro já liberado */
        }
        return;
      }
      if (g.mode === "pan") {
        commit(panBy(viewRef.current, e.clientX - g.lastMidX, e.clientY - g.lastMidY));
        g.lastMidX = e.clientX;
        g.lastMidY = e.clientY;
        schedule();
      } else if (g.mode === "pinch" && pointers.current.size >= 2) {
        const [a, b] = [...pointers.current.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;
        const p = localPoint(midX, midY);
        let next = viewRef.current;
        if (g.lastDist > 0 && dist > 0) next = zoomAt(next, dist / g.lastDist, p.x, p.y);
        next = panBy(next, midX - g.lastMidX, midY - g.lastMidY);
        commit(next);
        g.lastDist = dist;
        g.lastMidX = midX;
        g.lastMidY = midY;
        schedule();
      }
    },
    [commit, schedule],
  );

  const onPointerEnd = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (!pointers.current.delete(e.pointerId)) return;
      const g = gesture.current;
      if (pointers.current.size === 0) {
        endGesture();
      } else if (g.mode === "pinch") {
        // sobrou um dedo: segue como pan a partir da posição dele
        const [rest] = [...pointers.current.values()];
        g.mode = "pan";
        g.lastMidX = rest.x;
        g.lastMidY = rest.y;
        setZoom(viewRef.current.zoom);
      }
    },
    [endGesture],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        zoomIn();
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        zoomOut();
      } else if (e.key === "0") {
        e.preventDefault();
        reset();
      }
    },
    [zoomIn, zoomOut, reset],
  );

  // Wheel com Ctrl/Meta: listener nativo não-passivo (o do React é passivo e não deixa cancelar).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const p = localPoint(e.clientX, e.clientY);
      const t = contentRef.current;
      if (t) t.style.transition = "";
      commit(zoomAt(viewRef.current, Math.exp(-e.deltaY * 0.01), p.x, p.y));
      schedule();
      setZoom(viewRef.current.zoom);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [commit, schedule]);

  useEffect(
    () => () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  /** true se o último gesto no fundo foi um arrasto (para distinguir de clique). */
  const wasPanning = useCallback(() => didPan.current, []);

  return {
    containerRef,
    contentRef,
    zoom,
    zoomIn,
    zoomOut,
    reset,
    centerOn,
    wasPanning,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: onPointerEnd,
      onPointerCancel: onPointerEnd,
      onKeyDown,
    },
  };
}

export type PlanViewportApi = ReturnType<typeof usePlanViewport>;
