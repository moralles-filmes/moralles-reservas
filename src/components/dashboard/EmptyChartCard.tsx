import { Inbox } from "lucide-react";

interface EmptyChartCardProps {
  message?: string;
}

export function EmptyChartCard({ message = "Sem dados no período" }: EmptyChartCardProps) {
  return (
    <div className="h-full w-full flex flex-col items-center justify-center text-muted-foreground">
      <Inbox className="h-8 w-8 mb-2 opacity-30" />
      <p className="text-sm">{message}</p>
    </div>
  );
}
