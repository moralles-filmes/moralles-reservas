import { Card, CardContent } from "@/components/ui/card";
import { MessageCircle } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

interface ResponseRateCardProps {
  total: number;
  surveysSent: number;
  ratePct: number;
  loading?: boolean;
}

export function ResponseRateCard({ total, surveysSent, ratePct, loading }: ResponseRateCardProps) {
  return (
    <Card>
      <CardContent className="pt-5 pb-5 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium">Respostas</p>
          <div className="p-2 rounded-full bg-emerald-50 text-emerald-600">
            <MessageCircle className="h-4 w-4" />
          </div>
        </div>

        {loading ? (
          <Skeleton className="h-12 w-24" />
        ) : (
          <p className="text-4xl font-bold text-emerald-600">{total}</p>
        )}

        <div className="space-y-1.5">
          <div className="h-2 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-emerald-500 rounded-full transition-all"
              style={{ width: `${Math.min(100, Math.max(0, ratePct))}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {surveysSent > 0
              ? `${ratePct.toFixed(1).replace(/\.0$/, "")}% de ${surveysSent} pesquisa${surveysSent === 1 ? "" : "s"} enviada${surveysSent === 1 ? "" : "s"} no período`
              : "Nenhuma pesquisa D+1 foi enviada no período"}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
