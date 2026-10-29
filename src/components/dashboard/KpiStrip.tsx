import { cn } from "@/lib/utils";

export function KpiStrip({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("surface rounded-card grid grid-cols-2 lg:grid-cols-4 divide-x divide-border overflow-hidden", className)}>
      {children}
    </div>
  );
}
