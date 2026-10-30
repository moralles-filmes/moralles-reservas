import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { RouteThemeProvider } from "@/components/RouteThemeProvider";
import { AdminShell } from "./AdminShell";

function stubMatchMedia() {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

function renderShell() {
  return render(
    <MemoryRouter initialEntries={["/g/casa"]}>
      <RouteThemeProvider>
        <Routes>
          <Route
            path="/g/:unitSlug"
            element={
              <AdminShell sidebar={<nav>menu</nav>}>
                <p>conteudo</p>
              </AdminShell>
            }
          />
        </Routes>
      </RouteThemeProvider>
    </MemoryRouter>,
  );
}

describe("AdminShell", () => {
  beforeEach(() => {
    localStorage.clear();
    stubMatchMedia();
  });

  it("recolher a sidebar persiste em admin-sidebar-collapsed", () => {
    renderShell();
    const toggles = screen.getAllByLabelText("Mostrar ou esconder menu");
    fireEvent.click(toggles[0]);
    expect(localStorage.getItem("admin-sidebar-collapsed")).toBe("1");
  });

  it("area principal tem fundo ambiente", () => {
    const { container } = renderShell();
    expect(screen.getByText("conteudo")).toBeInTheDocument();
    const main = container.querySelector("main");
    expect(main).not.toBeNull();
    expect(main!.className).toContain("ambient");
  });
});
