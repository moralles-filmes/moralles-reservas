import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { MutableRefObject } from "react";
import type { PlanViewportApi } from "../viewport/usePlanViewport";
import { useFocusTable } from "./useFocusTable";

function apiWithTable(tableId: string) {
  const content = document.createElement("div");
  const mesa = document.createElement("button");
  mesa.dataset.tableId = tableId;
  content.appendChild(mesa);
  const centerOn = vi.fn();
  const api = { contentRef: { current: content }, centerOn } as unknown as PlanViewportApi;
  return { ref: { current: api } as MutableRefObject<PlanViewportApi | null>, centerOn };
}

describe("useFocusTable", () => {
  it("centraliza a mesa e avisa que o foco foi tratado, para quem guarda o foco limpá-lo", () => {
    const { ref, centerOn } = apiWithTable("t1");
    const onHandled = vi.fn();
    renderHook(() => useFocusTable(ref, { tableId: "t1", nonce: 1 }, onHandled));
    expect(centerOn).toHaveBeenCalledTimes(1);
    expect(onHandled).toHaveBeenCalledTimes(1);
  });

  it("sem foco não centraliza", () => {
    const { ref, centerOn } = apiWithTable("t1");
    renderHook(() => useFocusTable(ref, undefined));
    expect(centerOn).not.toHaveBeenCalled();
  });
});
