import { useEffect, useState } from "react";
import { Link, NavLink, useLocation, useMatch, useResolvedPath } from "react-router-dom";
import { ChevronDown, Copy } from "lucide-react";
import { toast } from "sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useSidebarCollapse } from "./sidebar-context";

/* ────────────────────────────────────────────────────────────────────────────
   Estilos canônicos do item de navegação — fonte única, importada por todos os
   layouts (Gestão/Operacional/Plataforma/Admin legado). Item ativo usa os tokens
   da sidebar (--sidebar-accent + --sidebar-accent-foreground) com um traço
   dourado de 2px à esquerda. Superfícies únicas: sem vidro nos itens repetidos.
   ──────────────────────────────────────────────────────────────────────────── */
export const navItemBase =
  "flex items-center gap-3 px-3 py-2 coarse:min-h-11 rounded-item text-sm transition-colors";
export const navItemActive =
  "relative bg-sidebar-accent text-sidebar-accent-foreground font-medium before:absolute before:left-0 before:top-2 before:bottom-2 before:w-[2px] before:rounded-full before:bg-gold";
export const navItemIdle =
  "text-sidebar-foreground hover:bg-sidebar-accent/50 hover:text-foreground";
export const navItem = (isActive: boolean) =>
  cn(navItemBase, isActive ? navItemActive : navItemIdle);
export const navSectionTitle =
  "text-[10px] font-semibold tracking-wider text-tertiary px-3";

type IconType = React.ComponentType<{ className?: string }>;

/** Badge de contagem: pílula quando expandido, pontinho dourado quando recolhido. */
function NavBadge({ value, collapsed }: { value: number; collapsed: boolean }) {
  if (!value || value <= 0) return null;
  if (collapsed) {
    return (
      <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-warning ring-2 ring-sidebar" />
    );
  }
  return (
    <span className="ml-auto h-4 min-w-4 px-1 rounded-full bg-warning text-warning-foreground text-[10px] font-bold flex items-center justify-center leading-none tabular">
      {value > 99 ? "99+" : value}
    </span>
  );
}

/** Envolve em Tooltip (lado direito) só quando o trilho está recolhido. */
function withTooltip(node: React.ReactNode, label: string, collapsed: boolean) {
  if (!collapsed) return <>{node}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{node}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

export type SidebarLinkProps = {
  to: string;
  label: string;
  icon: IconType;
  end?: boolean;
  badge?: number;
  /**
   * "muted" = link secundário (footer/cross-painel) sem estado ativo dourado.
   * "gold"  = link de destaque sempre dourado (ex.: atalho Plataforma).
   */
  tone?: "default" | "muted" | "gold";
  /** Sobrepõe o casamento por prefixo do NavLink quando o layout decide o item ativo (`end` deixa de valer). */
  isActive?: boolean;
};

export function SidebarLink({ to, label, icon: Icon, end, badge, tone = "default", isActive: isActiveOverride }: SidebarLinkProps) {
  const { collapsed } = useSidebarCollapse();

  const linkClass = (isActive: boolean) =>
    cn(
      navItemBase,
      "relative",
      collapsed && "justify-center",
      tone === "muted"
        ? "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground"
        : tone === "gold"
          ? "text-sidebar-accent-foreground font-medium hover:bg-sidebar-accent/50"
          : isActive
            ? navItemActive
            : navItemIdle,
    );

  const content = (
    <>
      <Icon className="h-4 w-4 shrink-0" />
      {!collapsed && <span className="flex-1 truncate">{label}</span>}
      <NavBadge value={badge ?? 0} collapsed={collapsed} />
    </>
  );

  // `Link` com className em texto, nunca `NavLink`: recolhido, o link fica sob
  // `TooltipTrigger asChild`, e o Slot do Radix junta className com join(" "),
  // transformando o className-função do NavLink no código da função (o item
  // perde flex/padding e sai do centro). O ativo é o mesmo casamento do
  // NavLink, salvo quando o layout decide (`isActive`): aí o prefixo não conta,
  // senão dois itens seriam anunciados como a página atual (ex.: Cobranças dentro de Planos).
  const resolved = useResolvedPath(to);
  const match = useMatch({ path: resolved.pathname, end: end ?? false });
  const isActive = isActiveOverride ?? match !== null;

  const link = (
    <Link to={to} aria-current={isActive ? "page" : undefined} className={linkClass(isActive)}>
      {content}
    </Link>
  );

  return withTooltip(link, label, collapsed);
}

/** Item desabilitado (placeholder "em breve"). Colapsa pra ícone + tooltip. */
export function SidebarDisabledItem({ icon: Icon, label }: { icon: IconType; label: string }) {
  const { collapsed } = useSidebarCollapse();
  const node = (
    <span
      className={cn(
        navItemBase,
        "text-muted-foreground/50 cursor-not-allowed select-none",
        collapsed && "justify-center",
      )}
      aria-disabled="true"
    >
      <Icon className="h-4 w-4 shrink-0" />
      {!collapsed && <span className="flex-1 truncate">{label}</span>}
    </span>
  );
  return withTooltip(node, label, collapsed);
}

/** Botão de ação na sidebar (copiar código, sair…) — colapsa pra ícone + tooltip. */
export function SidebarActionButton({
  icon: Icon,
  label,
  onClick,
  danger,
}: {
  icon: IconType;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  const { collapsed } = useSidebarCollapse();
  const btn = (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        navItemBase,
        "relative w-full text-muted-foreground hover:bg-sidebar-accent/50",
        collapsed ? "justify-center" : "hover:text-foreground",
        danger && "hover:text-destructive",
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {!collapsed && <span className="flex-1 text-left truncate">{label}</span>}
    </button>
  );
  return withTooltip(btn, label, collapsed);
}

/** Cabeçalho de marca (ícone dourado + nome do painel). Recolhe pra ícone centrado. */
export function SidebarBrand({ icon: Icon, label }: { icon: IconType; label: string }) {
  const { collapsed } = useSidebarCollapse();
  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="h-12 flex items-center justify-center">
            <Icon className="h-5 w-5 text-gold" />
          </div>
        </TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <div className="h-14 flex items-center px-5 gap-2">
      <Icon className="h-5 w-5 text-gold shrink-0" />
      <span className="font-semibold text-sm text-sidebar-foreground truncate">{label}</span>
    </div>
  );
}

/** Texto de rodapé (ex.: e-mail do admin) — some quando recolhido. */
export function SidebarFootnote({ children }: { children: React.ReactNode }) {
  const { collapsed } = useSidebarCollapse();
  if (collapsed) return null;
  return <div className="px-5 py-3 text-xs text-muted-foreground truncate">{children}</div>;
}

/** Botão "copiar código da unidade" — rico (com slug) quando expandido, ícone+tooltip recolhido. */
export function SidebarCopyCode({ slug }: { slug: string }) {
  const { collapsed } = useSidebarCollapse();

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(slug);
      toast.success("Código copiado");
    } catch {
      toast.error("Não foi possível copiar");
    }
  };

  if (collapsed) {
    return <SidebarActionButton icon={Copy} label="Copiar código" onClick={handleCopy} />;
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="w-full flex items-center gap-2 px-3 py-1.5 rounded-item text-xs text-muted-foreground bg-muted hover:bg-muted/70 transition-colors group"
    >
      <Copy className="h-3 w-3 shrink-0 opacity-60 group-hover:opacity-100" />
      <span className="flex-1 text-left">Copiar código</span>
      <span className="font-mono text-[11px] text-foreground/80 truncate max-w-[100px]">{slug}</span>
    </button>
  );
}

/** Título de seção — vira um traço sutil quando recolhido. */
export function SidebarSectionTitle({ children }: { children: React.ReactNode }) {
  const { collapsed } = useSidebarCollapse();
  if (collapsed) {
    return <div className="my-2 mx-auto h-px w-6 rounded-full bg-sidebar-border/60" />;
  }
  return <p className={navSectionTitle}>{children}</p>;
}

export type SidebarSubItem = {
  to: string;
  label: string;
  icon: IconType;
  end?: boolean;
};

export type SidebarGroupProps = {
  label: string;
  icon: IconType;
  /** Prefixo de rota que marca o grupo como ativo / auto-expande. */
  matchPrefix: string;
  items: SidebarSubItem[];
};

export function SidebarGroup({ label, icon: Icon, matchPrefix, items }: SidebarGroupProps) {
  const { collapsed, expand } = useSidebarCollapse();
  const location = useLocation();
  const isInside = location.pathname.startsWith(matchPrefix);
  const [open, setOpen] = useState(isInside);

  useEffect(() => {
    if (isInside) setOpen(true);
  }, [isInside]);

  // Recolhido: vira um ícone só; clicar reabre o trilho e o grupo.
  if (collapsed) {
    const btn = (
      <button
        type="button"
        onClick={() => {
          expand();
          setOpen(true);
        }}
        className={cn(navItemBase, "relative w-full justify-center", isInside ? navItemActive : navItemIdle)}
        aria-label={label}
      >
        <Icon className="h-4 w-4 shrink-0" />
      </button>
    );
    return withTooltip(btn, label, collapsed);
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(navItemBase, "w-full", isInside ? navItemActive : navItemIdle)}
        aria-expanded={open}
      >
        <Icon className="h-4 w-4 shrink-0" />
        <span className="flex-1 text-left truncate">{label}</span>
        <ChevronDown
          className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
        />
      </button>
      {open && (
        <div className="mt-0.5 ml-3 pl-3 border-l border-sidebar-border/50 space-y-0.5">
          {items.map((child) => {
            const ChildIcon = child.icon;
            return (
              <NavLink
                key={child.to}
                to={child.to}
                end={child.end}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-2 px-3 py-1.5 rounded-item text-sm transition-colors",
                    isActive ? navItemActive : navItemIdle,
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <ChildIcon className={cn("h-3.5 w-3.5 shrink-0", !isActive && "text-tertiary")} />
                    <span className="flex-1 truncate">{child.label}</span>
                  </>
                )}
              </NavLink>
            );
          })}
        </div>
      )}
    </div>
  );
}
