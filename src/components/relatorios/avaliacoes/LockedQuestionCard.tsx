import { Card, CardContent } from "@/components/ui/card";
import { Lock } from "lucide-react";

interface LockedQuestionCardProps {
  title: string;
  hint?: string;
}

export function LockedQuestionCard({ title, hint }: LockedQuestionCardProps) {
  return (
    <Card className="opacity-70 border-dashed">
      <CardContent className="pt-4 pb-4 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-medium text-muted-foreground">{title}</p>
          <Lock className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0" />
        </div>
        <p className="text-2xl font-semibold text-muted-foreground/70">—</p>
        <p className="text-[11px] uppercase tracking-wider text-amber-700 bg-amber-50 border border-amber-200 rounded inline-block px-1.5 py-0.5">
          em breve
        </p>
        {hint && <p className="text-[11px] text-muted-foreground/70">{hint}</p>}
      </CardContent>
    </Card>
  );
}
