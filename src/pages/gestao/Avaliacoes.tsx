import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateBR, formatPhone } from "@/lib/utils";
import { Star } from "lucide-react";

interface RatingRow {
  id: string;
  date: string;
  time: string;
  satisfaction_rating: number;
  customer: { name: string; phone: string } | null;
}

function StarRating({ value }: { value: number }) {
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          className={`h-3.5 w-3.5 ${n <= value ? "fill-amber-400 text-amber-400" : "text-muted-foreground/30"}`}
        />
      ))}
    </div>
  );
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

  const avg =
    rows && rows.length > 0
      ? (rows.reduce((s, r) => s + r.satisfaction_rating, 0) / rows.length).toFixed(1)
      : null;

  const dist = rows
    ? [5, 4, 3, 2, 1].map((n) => ({
        stars: n,
        count: rows.filter((r) => r.satisfaction_rating === n).length,
      }))
    : [];

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <Star className="h-5 w-5 text-amber-400" />
        <h1 className="text-2xl font-bold">Avaliações</h1>
      </div>

      {rows && rows.length > 0 && (
        <div className="grid grid-cols-2 gap-4">
          <Card>
            <CardContent className="pt-4 pb-4 text-center">
              <p className="text-4xl font-bold text-amber-500">{avg}</p>
              <p className="text-sm text-muted-foreground mt-1">Média geral</p>
              <StarRating value={Math.round(Number(avg))} />
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-4">
              <CardTitle className="text-xs uppercase tracking-wide text-muted-foreground mb-2">Distribuição</CardTitle>
              <div className="space-y-1">
                {dist.map(({ stars, count }) => (
                  <div key={stars} className="flex items-center gap-2 text-xs">
                    <span className="w-2 text-right">{stars}</span>
                    <Star className="h-3 w-3 fill-amber-400 text-amber-400 shrink-0" />
                    <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full bg-amber-400 rounded-full"
                        style={{ width: rows.length > 0 ? `${(count / rows.length) * 100}%` : "0%" }}
                      />
                    </div>
                    <span className="w-6 text-right text-muted-foreground">{count}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
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
