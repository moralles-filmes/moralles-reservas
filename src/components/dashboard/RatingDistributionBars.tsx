import { Star } from "lucide-react";

interface RatingDistributionBarsProps {
  ratings: number[];
}

export function RatingDistributionBars({ ratings }: RatingDistributionBarsProps) {
  const total = ratings.length;
  const dist = [5, 4, 3, 2, 1].map((n) => ({
    stars: n,
    count: ratings.filter((r) => r === n).length,
  }));

  return (
    <div className="space-y-1">
      {dist.map(({ stars, count }) => (
        <div key={stars} className="flex items-center gap-2 text-xs">
          <span className="w-2 text-right">{stars}</span>
          <Star className="h-3 w-3 fill-amber-400 text-amber-400 shrink-0" />
          <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-amber-400 rounded-full"
              style={{ width: total > 0 ? `${(count / total) * 100}%` : "0%" }}
            />
          </div>
          <span className="w-6 text-right text-muted-foreground">{count}</span>
        </div>
      ))}
    </div>
  );
}
