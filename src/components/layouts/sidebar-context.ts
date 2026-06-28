import { createContext, useContext } from "react";

/**
 * Estado de colapso da sidebar, provido pelo AdminShell e consumido pelos
 * componentes de navegação (SidebarNav). `collapsed` é EFETIVO: só fica `true`
 * no desktop (≥lg) com o trilho recolhido — no mobile a gaveta abre sempre cheia.
 * `expand()` reabre o trilho (usado ao clicar num grupo recolhido).
 */
export type SidebarCollapseValue = {
  collapsed: boolean;
  expand: () => void;
};

export const SidebarCollapseContext = createContext<SidebarCollapseValue>({
  collapsed: false,
  expand: () => {},
});

export const useSidebarCollapse = () => useContext(SidebarCollapseContext);
