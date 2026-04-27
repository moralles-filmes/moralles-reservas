import { useReservas } from "@/hooks/useReservas";
import { useReservaStore } from "@/stores/reservaStore";
import { ReservaCard } from "@/components/reserva/ReservaCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Search, X } from "lucide-react";
import type { ReservaStatus } from "@/types/reserva";
import { STATUS_LABELS } from "@/types/reserva";

const STATUS_OPTIONS: Array<{ value: ReservaStatus | ""; label: string }> = [
  { value: "", label: "Todos os status" },
  { value: "pending", label: STATUS_LABELS.pending },
  { value: "confirmed", label: STATUS_LABELS.confirmed },
  { value: "cancelled", label: STATUS_LABELS.cancelled },
  { value: "no_show", label: STATUS_LABELS.no_show },
];

export default function Reservas() {
  const { filters, setFilter, resetFilters } = useReservaStore();
  const { data, isLoading } = useReservas({
    date: filters.date || undefined,
    status: (filters.status as ReservaStatus) || undefined,
    search: filters.search || undefined,
  });

  const hasActiveFilters = filters.status || filters.search;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Reservas</h1>
        {hasActiveFilters && (
          <Button variant="ghost" size="sm" onClick={resetFilters}>
            <X className="h-3 w-3 mr-1" /> Limpar filtros
          </Button>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <Input
          type="date"
          value={filters.date}
          onChange={(e) => setFilter("date", e.target.value)}
          className="w-40"
        />
        <Select
          value={filters.status}
          onValueChange={(v) => setFilter("status", v as ReservaStatus | "")}
        >
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value || "__all__"}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Buscar nome, telefone, código..."
            value={filters.search}
            onChange={(e) => setFilter("search", e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      {/* Results */}
      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-20 w-full" />)}
        </div>
      ) : !data?.length ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            Nenhuma reserva encontrada com os filtros selecionados.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {data.length} reserva{data.length !== 1 ? "s" : ""} encontrada{data.length !== 1 ? "s" : ""}
          </p>
          {data.map((r) => (
            <ReservaCard key={r.id} reserva={r} showActions />
          ))}
        </div>
      )}
    </div>
  );
}
