import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { Menu } from "lucide-react";
import { cn } from "@/lib/utils";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeToggle } from "@/components/ThemeToggle";
import { SidebarCollapseContext } from "./sidebar-context";

const STORAGE_KEY = "admin-sidebar-collapsed";
const DESKTOP_MQ = "(min-width:1024px)";

type AdminShellProps = {
  /** Conteúdo interno do <aside> (profile, nav, separators, sair…). */
  sidebar: React.ReactNode;
  /** Conteúdo do <main> (a página). */
  children: React.ReactNode;
  /** Aplica o token de escopo do painel admin. Default true; Admin legado passa false. */
  themeAdmin?: boolean;
  /** Largura do aside no desktop. Default "lg:w-60". */
  sidebarWidthClass?: string;
  /** Padding do conteúdo do main. Default "p-6". */
  mainPaddingClass?: string;
};

export function AdminShell({
  sidebar,
  children,
  themeAdmin = true,
  sidebarWidthClass = "lg:w-60",
  mainPaddingClass = "p-6",
}: AdminShellProps) {
  // Colapso no desktop — persistido entre painéis e recargas.
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });
  // Gaveta no mobile — efêmera, sempre começa fechada.
  const [mobileOpen, setMobileOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  // Acompanha o breakpoint desktop pra calcular o colapso EFETIVO (trilho só-ícones
  // não vale no mobile, onde a gaveta abre cheia).
  const [isDesktop, setIsDesktop] = useState(() => {
    try {
      return window.matchMedia(DESKTOP_MQ).matches;
    } catch {
      return true;
    }
  });
  const location = useLocation();

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
    } catch {
      /* localStorage indisponível (modo privativo) — ignora */
    }
  }, [collapsed]);

  // Observa a media query do desktop.
  useEffect(() => {
    const mql = window.matchMedia(DESKTOP_MQ);
    const onChange = () => setIsDesktop(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  // Fecha a gaveta ao navegar (cobre clique em qualquer NavLink).
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  // Fecha a gaveta no Escape.
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMobileOpen(false);
        menuButtonRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileOpen]);

  const onToggle = () =>
    isDesktop ? setCollapsed((v) => !v) : setMobileOpen((v) => !v);

  const collapsedEffective = isDesktop && collapsed;

  return (
    <div className={cn(themeAdmin && "theme-admin", "flex h-screen bg-background")}>
      {/* Backdrop só no mobile com gaveta aberta */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-background/60 backdrop-blur-sm lg:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}

      <TooltipProvider delayDuration={120}>
        <SidebarCollapseContext.Provider
          value={{ collapsed: collapsedEffective, expand: () => setCollapsed(false) }}
        >
          <aside
            ref={(node) => {
              if (node) node.inert = !isDesktop && !mobileOpen;
            }}
            className={cn(
              "z-50 flex flex-col bg-sidebar border-r border-sidebar-border shrink-0",
              // mobile: gaveta fixa que desliza
              "fixed inset-y-0 left-0 w-64 transition-transform duration-200",
              mobileOpen ? "translate-x-0" : "-translate-x-full",
              // desktop: estática, largura colapsável (trilho só-ícones), transform resetado
              "lg:static lg:translate-x-0 lg:transition-[width] lg:duration-200",
              collapsed ? "lg:w-[4.5rem]" : sidebarWidthClass,
            )}
          >
            {sidebar}
          </aside>
        </SidebarCollapseContext.Provider>
      </TooltipProvider>

      <main className="relative flex-1 overflow-y-auto min-w-0 flex flex-col ambient">
        <div className="glass sticky top-0 z-30 flex items-center gap-1 h-12 px-3 border-b border-sidebar-border">
          <button
            ref={menuButtonRef}
            type="button"
            onClick={onToggle}
            aria-label="Mostrar ou esconder menu"
            className="p-2 rounded-full text-sidebar-foreground hover:bg-sidebar-accent/50 hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring coarse:h-11 coarse:w-11"
          >
            <Menu className="h-5 w-5" />
          </button>
          <ThemeToggle className="ml-auto" />
        </div>
        <div className={cn(mainPaddingClass, "flex-1")}>{children}</div>
      </main>
    </div>
  );
}
