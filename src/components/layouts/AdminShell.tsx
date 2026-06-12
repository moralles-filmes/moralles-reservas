import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { Menu } from "lucide-react";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "admin-sidebar-collapsed";

type AdminShellProps = {
  /** Conteúdo interno do <aside> (profile, nav, separators, sair…). */
  sidebar: React.ReactNode;
  /** Conteúdo do <main> (a página). */
  children: React.ReactNode;
  /** Aplica o tema navy `.theme-admin`. Default true; Admin legado passa false. */
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
  const location = useLocation();

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
    } catch {
      /* localStorage indisponível (modo privativo) — ignora */
    }
  }, [collapsed]);

  // Fecha a gaveta ao navegar (cobre clique em qualquer NavLink).
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  // Fecha a gaveta no Escape.
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileOpen]);

  const onToggle = () =>
    window.matchMedia("(min-width:1024px)").matches
      ? setCollapsed((v) => !v)
      : setMobileOpen((v) => !v);

  return (
    <div className={cn(themeAdmin && "theme-admin", "flex h-screen bg-background")}>
      {/* Backdrop só no mobile com gaveta aberta */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside
        className={cn(
          "z-50 flex flex-col bg-sidebar border-r border-sidebar-border shrink-0",
          // mobile: gaveta fixa que desliza
          "fixed inset-y-0 left-0 w-64 transition-transform duration-200",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
          // desktop: estática, largura colapsável, transform resetado
          "lg:static lg:translate-x-0 lg:transition-[width] lg:duration-200",
          collapsed ? "lg:w-0 lg:overflow-hidden lg:border-r-0" : sidebarWidthClass,
        )}
      >
        {sidebar}
      </aside>

      <main className="flex-1 overflow-y-auto min-w-0 flex flex-col">
        <div className="sticky top-0 z-30 flex items-center h-12 px-3 border-b border-sidebar-border bg-background/80 backdrop-blur">
          <button
            type="button"
            onClick={onToggle}
            aria-label="Mostrar ou esconder menu"
            className="p-2 rounded-md text-sidebar-foreground hover:bg-sidebar-accent/50 transition-colors"
          >
            <Menu className="h-5 w-5" />
          </button>
        </div>
        <div className={cn(mainPaddingClass, "flex-1")}>{children}</div>
      </main>
    </div>
  );
}
