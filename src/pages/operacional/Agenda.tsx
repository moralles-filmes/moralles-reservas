import { useState } from "react";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import { useReservas } from "@/hooks/useReservas";
import { ReservasCalendar } from "@/components/reserva/ReservasCalendar";
import { ReservaCard } from "@/components/reserva/ReservaCard";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AlertCircle, CalendarDays, List, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ReservaStatus } from "@/types/reserva";
import { PageHeader } from "@/components/PageHeader";

type View = "calendar" | "list";
type StatusFilter = "all" | ReservaStatus;

const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "Todas" },
  { value: "pending", label: "Pendentes" },
  { value: "confirmed", label: "Confirmadas" },
  { value: "cancelled", label: "Canceladas" },
  { value: "no_show", label: "Não compareceu" },
];

function TabButton({
  active,
  onClick,
  icon: Icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
        active
          ? "border-primary text-primary"
          : "border-transparent text-muted-foreground hover:text-foreground"
      )}
    >
      <Icon className="h-4 w-4" />
      {children}
    </button>
  );
}

function ListView({ unitId }: { unitId: string }) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");

  const { data: reservas, isLoading, isError, refetch } = useReservas(unitId, {
    search: search.trim() || undefined,
    status: status === "all" ? undefined : status,
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nome ou telefone"
            className="pl-9"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {STATUS_FILTERS.map((f) => (
            <Button
              key={f.value}
              size="sm"
              variant={status === f.value ? "default" : "outline"}
              onClick={() => setStatus(f.value)}
            >
              {f.label}
            </Button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-20 w-full" />)}</div>
      ) : isError ? (
        <div className="surface rounded-card border-destructive/40 py-8 flex flex-col items-center gap-3 text-center">
          <AlertCircle className="h-8 w-8 text-destructive" />
          <p className="text-sm font-medium">Erro ao carregar reservas.</p>
          <Button size="sm" variant="outline" onClick={() => refetch()}>
            Tentar de novo
          </Button>
        </div>
      ) : !reservas || reservas.length === 0 ? (
        <div className="surface rounded-card py-12 text-center text-muted-foreground text-sm">
          Nenhuma reserva encontrada.
        </div>
      ) : (
        <div className="space-y-3">
          {reservas.map((r) => (
            <ReservaCard key={r.id} reserva={r} showActions unitId={unitId} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function Agenda() {
  const unit = useCurrentUnit();
  const unitId = unit?.unit_id ?? "";
  const [view, setView] = useState<View>("calendar");

  return (
    <div className="space-y-5">
      <PageHeader title="Calendário" />

      <div className="flex items-center gap-1 border-b">
        <TabButton active={view === "calendar"} onClick={() => setView("calendar")} icon={CalendarDays}>
          Calendário
        </TabButton>
        <TabButton active={view === "list"} onClick={() => setView("list")} icon={List}>
          Lista
        </TabButton>
      </div>

      {view === "calendar" ? <ReservasCalendar unitId={unitId} /> : <ListView unitId={unitId} />}
    </div>
  );
}
