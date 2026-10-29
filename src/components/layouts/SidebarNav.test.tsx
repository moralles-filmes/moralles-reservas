import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { LayoutDashboard, Users } from "lucide-react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarCollapseContext } from "./sidebar-context";
import { SidebarLink } from "./SidebarNav";

function renderLinks(collapsed: boolean, path = "/g/casa") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <TooltipProvider>
        <SidebarCollapseContext.Provider value={{ collapsed, expand: () => {} }}>
          <SidebarLink to="/g/casa" label="Dashboard" icon={LayoutDashboard} end />
          <SidebarLink to="/g/casa/clientes" label="Clientes" icon={Users} />
        </SidebarCollapseContext.Provider>
      </TooltipProvider>
    </MemoryRouter>,
  );
}

describe("SidebarLink", () => {
  // Regressão: sob TooltipTrigger asChild, um className-função virava o texto da função.
  it("recolhido, o link recebe as classes do item centralizado", () => {
    renderLinks(true);
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link.className).toContain("flex");
      expect(link.className).toContain("justify-center");
      expect(link.className).not.toContain("=>");
    }
  });

  it("marca só o item da rota atual, respeitando end", () => {
    renderLinks(true, "/g/casa/clientes/123");
    const [dashboard, clientes] = screen.getAllByRole("link");
    expect(dashboard).not.toHaveAttribute("aria-current");
    expect(clientes).toHaveAttribute("aria-current", "page");
  });

  it("expandido, mostra o rótulo e marca o item exato", () => {
    renderLinks(false);
    expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Clientes" })).not.toHaveAttribute("aria-current");
  });
});
