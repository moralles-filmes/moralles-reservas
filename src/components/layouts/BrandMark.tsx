import { useSidebarCollapse } from "./sidebar-context";

/**
 * Marca da sidebar: orbe dourado + nome. Sem `collapsed` explícito, segue o
 * trilho recolhido do AdminShell (o nome e o `label` ficam só para leitor de tela).
 */
export function BrandMark({ collapsed, label }: { collapsed?: boolean; label?: string }) {
  const { collapsed: railCollapsed } = useSidebarCollapse();
  const isCollapsed = collapsed ?? railCollapsed;

  const orb = (
    <span
      aria-hidden="true"
      className="h-7 w-7 shrink-0 rounded-full shadow-gold-glow"
      style={{
        backgroundImage:
          "radial-gradient(circle at 30% 30%, hsl(var(--gold-ink)), hsl(var(--gold)))",
      }}
    />
  );

  if (isCollapsed) {
    return (
      <span className="flex items-center justify-center min-w-0" title={label ? `Moralles · ${label}` : "Moralles"}>
        {orb}
        <span className="sr-only">{label ? `Moralles · ${label}` : "Moralles"}</span>
      </span>
    );
  }

  return (
    <span className="flex items-center gap-2 min-w-0">
      {orb}
      <span className="font-semibold text-sm text-sidebar-foreground truncate">Moralles</span>
      {label && <span className="text-[11px] text-tertiary truncate">{label}</span>}
    </span>
  );
}
