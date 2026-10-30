import { cn } from "@/lib/utils";

export function KpiStrip({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    // Fio à esquerda e em cima de cada item (o overflow-hidden corta os da borda): divide-x
    // deixava divisória solta quando a grade quebra em mais de uma linha.
    <div
      className={cn(
        "surface rounded-card grid grid-cols-2 lg:grid-cols-4 overflow-hidden",
        "[&>*]:shadow-[-1px_0_0_hsl(var(--border)),0_-1px_0_hsl(var(--border))]",
        className,
      )}
    >
      {children}
    </div>
  );
}
