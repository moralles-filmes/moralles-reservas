import { cn } from "@/lib/utils";

export function BrandMark({ collapsed }: { collapsed?: boolean }) {
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

  return (
    <span className={cn("flex items-center gap-2 min-w-0", collapsed && "justify-center")}>
      {orb}
      {collapsed ? (
        <span className="sr-only">Moralles</span>
      ) : (
        <span className="font-semibold text-sm text-sidebar-foreground truncate">
          Moralles
        </span>
      )}
    </span>
  );
}
