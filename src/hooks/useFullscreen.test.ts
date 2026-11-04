import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFullscreen } from "./useFullscreen";

let fsEl: Element | null = null;
const request = vi.fn();
const exitFs = vi.fn();

function install() {
  fsEl = null;
  request.mockReset().mockImplementation(() => {
    fsEl = document.documentElement;
    return Promise.resolve();
  });
  exitFs.mockReset().mockImplementation(() => {
    fsEl = null;
    return Promise.resolve();
  });
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fsEl });
  Object.defineProperty(document, "exitFullscreen", { configurable: true, writable: true, value: exitFs });
  Object.defineProperty(document.documentElement, "requestFullscreen", {
    configurable: true,
    writable: true,
    value: request,
  });
}

function uninstall() {
  delete document.documentElement.requestFullscreen;
}

describe("useFullscreen", () => {
  beforeEach(install);
  afterEach(() => {
    uninstall();
    document.body.innerHTML = "";
  });

  it("enter chama requestFullscreen no documentElement", () => {
    const { result } = renderHook(() => useFullscreen());
    act(() => result.current.enter());
    expect(request).toHaveBeenCalledTimes(1);
    expect(result.current.active).toBe(true);
  });

  it("fullscreenchange com null desliga", () => {
    const { result } = renderHook(() => useFullscreen());
    act(() => result.current.enter());
    act(() => {
      fsEl = null;
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    expect(result.current.active).toBe(false);
  });

  it("exit sai da tela cheia nativa", () => {
    const { result } = renderHook(() => useFullscreen());
    act(() => result.current.enter());
    act(() => result.current.exit());
    expect(exitFs).toHaveBeenCalled();
    expect(result.current.active).toBe(false);
  });

  it("sem a API, enter ativa e Escape desliga", () => {
    uninstall();
    const { result } = renderHook(() => useFullscreen());
    act(() => result.current.enter());
    expect(result.current.active).toBe(true);
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(result.current.active).toBe(false);
  });

  it("Escape com diálogo aberto não desliga", () => {
    uninstall();
    const dlg = document.createElement("div");
    dlg.setAttribute("role", "dialog");
    document.body.appendChild(dlg);
    const { result } = renderHook(() => useFullscreen());
    act(() => result.current.enter());
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(result.current.active).toBe(true);
  });

  it("recusa do navegador mantém a camada", async () => {
    request.mockImplementation(() => Promise.reject(new Error("negado")));
    const { result } = renderHook(() => useFullscreen());
    await act(async () => result.current.enter());
    expect(result.current.active).toBe(true);
  });

  it("unmount ativo sai da tela cheia nativa", () => {
    const { result, unmount } = renderHook(() => useFullscreen());
    act(() => result.current.enter());
    unmount();
    expect(exitFs).toHaveBeenCalled();
  });
});
