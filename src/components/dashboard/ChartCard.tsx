import { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface ChartCardProps {
  title: string;
  subtitle?: string;
  loading?: boolean;
  empty?: boolean;
  emptyContent?: ReactNode;
  children: ReactNode;
  className?: string;
  height?: string;
}

export function ChartCard({
  title,
  subtitle,
  loading,
  empty,
  emptyContent,
  children,
  className,
  height = "h-72",
}: ChartCardProps) {
  return (
    <Card className={className}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
      </CardHeader>
      <CardContent className={cn(height, "p-2")}>
        {loading ? <Skeleton className="h-full w-full" /> : empty ? emptyContent : children}
      </CardContent>
    </Card>
  );
}
