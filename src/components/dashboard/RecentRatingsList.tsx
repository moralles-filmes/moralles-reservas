import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Star } from "lucide-react";
import { formatDateBR, formatPhone } from "@/lib/utils";
import { StarRating } from "./StarRating";
import type { RecentRating } from "@/hooks/useDashboardMetrics";

interface RecentRatingsListProps {
  ratings: RecentRating[];
}

export function RecentRatingsList({ ratings }: RecentRatingsListProps) {
  if (ratings.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          <Star className="h-6 w-6 mx-auto mb-2 opacity-30" />
          <p className="text-sm">Nenhuma avaliação no período.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-2">
      {ratings.map((r) => (
        <Card key={r.id}>
          <CardContent className="py-3 flex items-center gap-3 flex-wrap">
            <StarRating value={r.rating} />
            <Badge variant="outline" className="text-xs">{r.rating}/5</Badge>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">
                {r.customerName || formatPhone(r.customerPhone || "") || "Cliente"}
              </p>
              <p className="text-xs text-muted-foreground">
                {formatDateBR(r.date)}{r.time ? ` às ${r.time}` : ""}
              </p>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
