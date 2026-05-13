import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import { useHalls, useCreateHall, useUpdateHall } from "@/hooks/useHalls";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ChevronRight, Plus, SquareStack } from "lucide-react";
import { HallCard } from "@/components/halls/HallCard";
import { PageHeader } from "@/components/PageHeader";
import { Breadcrumb } from "@/components/Breadcrumb";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { HallSchedule } from "@/types/reserva";
import { toast } from "sonner";

export default function Saloes() {
  const unit = useCurrentUnit();
  const unitId = unit?.unit_id ?? "";
  const unitSlug = unit?.unit_slug ?? "";
  const [showInactive, setShowInactive] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");

  const { data: halls, isLoading } = useHalls(unitId, { includeInactive: showInactive });
  const createHall = useCreateHall(unitId);
  const updateHall = useUpdateHall(unitId);

  const hallIds = useMemo(() => (halls ?? []).map((h) => h.id), [halls]);

  const { data: allSchedules } = useQuery({
    queryKey: ["all-hall-schedules", unitId, hallIds.join(",")],
    queryFn: async () => {
      if (hallIds.length === 0) return [] as HallSchedule[];
      const { data, error } = await supabase
        .from("hall_schedules")
        .select("*")
        .in("hall_id", hallIds);
      if (error) throw error;
      return data as HallSchedule[];
    },
    enabled: hallIds.length > 0,
  });

  const handleCreate = () => {
    const name = newName.trim();
    if (!name) {
      toast.error("Informe o nome do salão.");
      return;
    }
    createHall.mutate(
      { name, description: newDesc.trim() || null },
      {
        onSuccess: () => {
          toast.success("Salão criado.");
          setNewOpen(false);
          setNewName("");
          setNewDesc("");
        },
        onError: (err: Error) => toast.error(err.message ?? "Erro ao criar salão."),
      },
    );
  };

  const detailHrefBase = `/g/${unitSlug}/reservas/saloes`;

  return (
    <div className="space-y-5">
      <PageHeader
        breadcrumb={[
          { label: unit?.unit_name ?? "Unidade", to: `/g/${unitSlug}` },
          { label: "Reservas", to: `/g/${unitSlug}/reservas` },
          { label: "Salões" },
        ]}
        title="Salões"
      >
        <Dialog open={newOpen} onOpenChange={setNewOpen}>
          <DialogTrigger asChild>
            <Button size="sm" className="gap-2">
              <Plus className="h-4 w-4" />
              Adicionar salão
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Novo salão</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-1">
                <Label>Nome</Label>
                <Input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Ex: Salão Principal, Área externa…"
                />
              </div>
              <div className="space-y-1">
                <Label>Descrição (opcional)</Label>
                <Input
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  placeholder="Ex: Mesas internas climatizadas"
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setNewOpen(false)}>
                Cancelar
              </Button>
              <Button onClick={handleCreate} disabled={createHall.isPending}>
                Criar
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </PageHeader>

      <label className="flex items-center gap-2 text-sm">
        <Switch checked={showInactive} onCheckedChange={setShowInactive} />
        Exibir salões inativos
      </label>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-5">
        <div className="space-y-4">
          {isLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {[1, 2].map((i) => (
                <Skeleton key={i} className="h-44 w-full" />
              ))}
            </div>
          ) : !halls?.length ? (
            <Card className="p-12 text-center text-muted-foreground">
              <SquareStack className="h-8 w-8 mx-auto mb-2 opacity-30" />
              Nenhum salão cadastrado.{" "}
              <button className="underline text-primary" onClick={() => setNewOpen(true)}>
                Crie o primeiro
              </button>
              .
            </Card>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {halls.map((h) => (
                <HallCard
                  key={h.id}
                  hall={h}
                  schedules={(allSchedules ?? []).filter((s) => s.hall_id === h.id)}
                  detailHref={`${detailHrefBase}/${h.id}`}
                  onToggleActive={(active) =>
                    updateHall.mutate(
                      { id: h.id, active },
                      {
                        onError: () => toast.error("Erro ao atualizar salão."),
                      },
                    )
                  }
                />
              ))}
            </div>
          )}
        </div>

        <aside className="space-y-3">
          <Card className="p-4 space-y-3">
            <h3 className="text-sm font-semibold">Turnos da Reserva</h3>
            <p className="text-xs text-muted-foreground">
              Os turnos são derivados automaticamente das janelas configuradas em cada salão. Ex:
              janelas que cobrem 11h–15h aparecem como "Almoço"; 18h–23h como "Jantar".
            </p>
            <Button variant="ghost" size="sm" className="w-full justify-between" asChild>
              <Link to={`/g/${unitSlug}/reservas/ajustes`}>
                Ver ajustes <ChevronRight className="h-4 w-4" />
              </Link>
            </Button>
          </Card>
        </aside>
      </div>
    </div>
  );
}

export function BreadcrumbReservas({ current }: { current: string }) {
  const unit = useCurrentUnit();
  const unitSlug = unit?.unit_slug ?? "";
  return (
    <Breadcrumb
      items={[
        { label: unit?.unit_name ?? "Unidade", to: `/g/${unitSlug}` },
        { label: "Reservas", to: `/g/${unitSlug}/reservas` },
        { label: current },
      ]}
    />
  );
}
