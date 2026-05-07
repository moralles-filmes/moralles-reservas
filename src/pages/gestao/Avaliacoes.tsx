import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateBR, formatPhone } from "@/lib/utils";
import { Star } from "lucide-react";
import { StarRating } from "@/components/dashboard/StarRating";
import { RatingsSummary } from "@/components/dashboard/RatingsSummary";

interface RatingRow {
  id: string;
  date: string;
  time: string;
  satisfaction_rating: number;
  customer: { name: string; phone: string } | null;
}

export default function Avaliacoes() {
  const unit = useCurrentUnit();
  const unitId = unit?.unit_id ?? "";

  const { data: rows, isLoading } = useQuery({
    queryKey: ["avaliacoes", unitId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("reservations")
        .select("id, date, time, satisfaction_rating, customer:customers(name, phone)")
        .eq("unit_id", unitId)
        .not("satisfaction_rating", "is", null)
        .order("date", { ascending: false })
        .limit(200);
      if (error) throw error;
      return data as RatingRow[];
    },
    enabled: !!unitId,
  });

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <Star className="h-5 w-5 text-amber-400" />
        <h1 className="text-2xl font-bold">Avaliações</h1>
      </div>

      {rows && rows.length > 0 && (
        <RatingsSummary ratings={rows.map((r) => r.satisfaction_rating)} averageLabel="Média geral" />
      )}

      {isLoading ? (
        <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
      ) : !rows?.length ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <Star className="h-8 w-8 mx-auto mb-2 opacity-30" />
            Nenhuma avaliação recebida ainda.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <Card key={r.id}>
              <CardContent className="py-3 flex items-center gap-4 flex-wrap">
                <StarRating value={r.satisfaction_rating} />
                <Badge variant="outline" className="text-xs">{r.satisfaction_rating}/5</Badge>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">
                    {r.customer?.name || formatPhone(r.customer?.phone || "")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatDateBR(r.date)} às {r.time}
                  </p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
