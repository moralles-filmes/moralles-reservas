import { act, render, waitFor } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RouteThemeProvider } from "./RouteThemeProvider";

beforeEach(() => {
  // jsdom não implementa matchMedia; next-themes consulta para detectar o sistema.
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  }
  localStorage.clear();
  document.documentElement.classList.remove("dark", "light");
});

function renderAt(route: string) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <RouteThemeProvider>
        <div />
      </RouteThemeProvider>
    </MemoryRouter>,
  );
}

describe("RouteThemeProvider", () => {
  it("rota pública fica clara mesmo com escuro salvo", async () => {
    localStorage.setItem("moralles-theme", "dark");
    renderAt("/r/casa");

    await waitFor(() => {
      expect(document.documentElement.classList.contains("dark")).toBe(false);
    });
  });

  it("painel sem escolha abre escuro", async () => {
    renderAt("/g/casa");

    await waitFor(() => {
      expect(document.documentElement.classList.contains("dark")).toBe(true);
    });
  });

  it("sair da rota pública para o painel devolve o escuro salvo sem apagá-lo", async () => {
    localStorage.setItem("moralles-theme", "dark");
    let navigate: ReturnType<typeof useNavigate> = () => undefined;
    function CaptureNavigate() {
      navigate = useNavigate();
      return null;
    }
    render(
      <MemoryRouter initialEntries={["/r/casa"]}>
        <RouteThemeProvider>
          <CaptureNavigate />
        </RouteThemeProvider>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(document.documentElement.classList.contains("dark")).toBe(false);
    });

    act(() => navigate("/g/casa"));

    await waitFor(() => {
      expect(document.documentElement.classList.contains("dark")).toBe(true);
    });
    expect(localStorage.getItem("moralles-theme")).toBe("dark");
  });

  it("painel mantém claro escolhido", async () => {
    localStorage.setItem("moralles-theme", "light");
    renderAt("/g/casa");

    await waitFor(() => {
      expect(document.documentElement.classList.contains("dark")).toBe(false);
    });
  });
});
