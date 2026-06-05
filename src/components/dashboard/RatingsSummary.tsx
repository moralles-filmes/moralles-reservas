import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StarRating } from "./StarRating";
import { RatingDistributionBars } from "./RatingDistributionBars";

interface RatingsSummaryProps {
  ratings: number[];
  averageLabel?: string;
}

export function RatingsSummary({ ratings, averageLabel }: RatingsSummaryProps) {
  const total = ratings.length;
  const avg = total > 0 ? ratings.reduce((s, r) => s + r, 0) / total : null;
  const label =
    averageLabel ??
    (total > 0 ? `Média de ${total} avalia${total === 1 ? "ção" : "ções"}` : "Média geral");

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <Card>
        <CardContent className="pt-5 pb-5 text-center">
          <p className="text-4xl font-bold text-amber-500">
            {avg !== null ? avg.toFixed(1) : "—"}
          </p>
          <p className="text-sm text-muted-foreground mt-1">{label}</p>
          <div className="flex justify-center mt-2">
            <StarRating value={avg ?? 0} size="md" />
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs uppercase tracking-wide text-muted-foreground">
            Distribuição
          </CardTitle>
        </CardHeader>
        <CardContent>
          <RatingDistributionBars ratings={ratings} />
        </CardContent>
      </Card>
    </div>
  );
}
