import { useEffect, useRef, type MutableRefObject } from "react";
import type { PlanViewportApi } from "../viewport/usePlanViewport";

export interface TableFocus {
  tableId: string;
  nonce: number;
}

/** Centraliza a mesa [data-table-id] no viewport; mede o elemento projetado, então serve ao 3D também. */
export function useFocusTable(apiRef: MutableRefObject<PlanViewportApi | null>, focus?: TableFocus, onHandled?: () => void) {
  const onHandledRef = useRef(onHandled);
  onHandledRef.current = onHandled;
  const tableId = focus?.tableId;
  const nonce = focus?.nonce;
  useEffect(() => {
    if (tableId == null) return;
    const api = apiRef.current;
    const content = api?.contentRef.current;
    if (!api || !content) return;
    const el = Array.from(content.querySelectorAll<HTMLElement>("[data-table-id]")).find(
      (n) => n.dataset.tableId === tableId,
    );
    if (!el) return;
    const c = content.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const zoom = content.offsetWidth > 0 && c.width > 0 ? c.width / content.offsetWidth : 1;
    onHandledRef.current?.();
    api.centerOn((r.left + r.width / 2 - c.left) / zoom, (r.top + r.height / 2 - c.top) / zoom);
  }, [tableId, nonce, apiRef]);
}
