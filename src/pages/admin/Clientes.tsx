import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateBR, formatPhone } from "@/lib/utils";
import type { Customer } from "@/types/reserva";
import { Phone, Search } from "lucide-react";

interface CustomerWithCount extends Customer {
  reservations_count: number;
}

export default function Clientes() {
  const [search, setSearch] = useState("");

  const { data: customers, isLoading } = useQuery({
    queryKey: ["customers", search],
    queryFn: async () => {
      let query = supabase
        .from("customers")
        .select("*")
        .order("created_at", { ascending: false });

      if (search) {
        query = query.or(
          `name.ilike.%${search}%,phone.ilike.%${search}%,email.ilike.%${search}%`
        );
      }

      const { data, error } = await query;
      if (error) throw error;

      // Fetch reservation counts
      const ids = data.map((c) => c.id);
      if (ids.length === 0) return [];

      const { data: counts } = await supabase
        .from("reservations")
        .select("customer_id")
        .in("customer_id", ids);

      const countMap = (counts || []).reduce<Record<string, number>>((acc, r) => {
        acc[r.customer_id] = (acc[r.customer_id] || 0) + 1;
        return acc;
      }, {});

      return data.map((c) => ({
        ...c,
        reservations_count: countMap[c.id] || 0,
      })) as CustomerWithCount[];
    },
  });

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">Clientes</h1>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Buscar nome, telefone ou e-mail..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-16 w-full" />)}
        </div>
      ) : !customers?.length ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            Nenhum cliente encontrado.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {customers.map((c) => (
            <Card key={c.id} className="hover:shadow-sm transition-shadow">
              <CardContent className="py-3 flex items-center justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{c.name}</p>
                  <div className="flex items-center gap-3 text-sm text-muted-foreground mt-0.5">
                    <span className="flex items-center gap-1">
                      <Phone className="h-3 w-3" />
                      {formatPhone(c.phone)}
                    </span>
                    {c.email && <span className="truncate">{c.email}</span>}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <Badge variant="outline" className="text-xs">
                    {c.reservations_count} {c.reservations_count === 1 ? "reserva" : "reservas"}
                  </Badge>
                  <p className="text-xs text-muted-foreground mt-1">
                    desde {formatDateBR(c.created_at)}
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
