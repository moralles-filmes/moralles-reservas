import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import { useHall, useUpdateHall, useDeleteHall } from "@/hooks/useHalls";
import {
  useHallSchedules,
  useCreateHallSchedules,
  useDeleteHallSchedule,
} from "@/hooks/useHallSchedules";
import { useHallTables, useCreateTablesBulk, useDeleteTable } from "@/hooks/useHallTables";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { ArrowLeft, Map, Pencil, Trash2 } from "lucide-react";
import { HallScheduleGrid } from "@/components/halls/HallScheduleGrid";
import { HallScheduleSheet } from "@/components/halls/HallScheduleSheet";
import { BreadcrumbReservas } from "./Saloes";
import type { HallSchedule, Mesa } from "@/types/reserva";
import { toast } from "sonner";

export default function SalaoDetalhe() {
  const { hallId } = useParams<{ hallId: string }>();
  const unit = useCurrentUnit();
  const unitId = unit?.unit_id ?? "";
  const unitSlug = unit?.unit_slug ?? "";
  const navigate = useNavigate();

  const [dayOfWeek, setDayOfWeek] = useState(0);
  const [sheetOpen, setSheetOpen] = useState(false);

  const { data: hall, isLoading: hallLoading } = useHall(hallId);
  const { data: schedules, isLoading: schedulesLoading } = useHallSchedules(hallId);
  const { data: hallTables } = useHallTables(hallId);
  const createSchedules = useCreateHallSchedules();
  const deleteSchedule = useDeleteHallSchedule();
  const createTablesBulk = useCreateTablesBulk();
  const deleteTable = useDeleteTable();
  const updateHall = useUpdateHall(unitId);
  const removeHall = useDeleteHall(unitId);

  if (hallLoading || !hall) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const handleDelete = async (schedule: HallSchedule) => {
    deleteSchedule.mutate(
      { id: schedule.id, hall_id: schedule.hall_id },
      {
        onSuccess: () => toast.success("Horário removido."),
        onError: () => toast.error("Erro ao remover horário."),
      },
    );
  };

  const handleDeleteTable = async (table: Mesa) => {
    deleteTable.mutate(
      { id: table.id, unit_id: table.unit_id, hall_id: table.hall_id },
      {
        onSuccess: () => toast.success("Mesa removida."),
        onError: () => toast.error("Não foi possível remover (verifique reservas vinculadas)."),
      },
    );
  };

  const handleSubmitSchedule = async (payload: {
    days: number[];
    open_time: string;
    close_time: string;
    slot_minutes: number;
    min_advance_minutes: number;
    discount_percent: number;
    charge_enabled: boolean;
    charge_amount_cents: number | null;
    newTables: Array<{ count: number; min: number; max: number }>;
  }) => {
    try {
      // 1) Criar mesas novas (se houver)
      for (const t of payload.newTables) {
        await createTablesBulk.mutateAsync({
          unit_id: unitId,
          hall_id: hall.id,
          count: t.count,
          min_capacity: t.min,
          max_capacity: t.max,
        });
      }
      // 2) Criar schedules pra cada dia selecionado
      await createSchedules.mutateAsync({
        hall_id: hall.id,
        days: payload.days,
        open_time: payload.open_time,
        close_time: payload.close_time,
        slot_minutes: payload.slot_minutes,
        min_advance_minutes: payload.min_advance_minutes,
        discount_percent: payload.discount_percent,
        charge_enabled: payload.charge_enabled,
        charge_amount_cents: payload.charge_amount_cents,
      });
      toast.success("Horário criado.");
    } catch (err) {
      toast.error((err as Error).message ?? "Erro ao salvar horário.");
      throw err;
    }
  };

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <BreadcrumbReservas current={hall.name} />
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" asChild>
              <Link to={`/g/${unitSlug}/reservas/saloes`} aria-label="Voltar">
                <ArrowLeft className="h-4 w-4" />
              </Link>
            </Button>
            <h1 className="text-2xl font-bold">Grade horária</h1>
          </div>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-5 items-start">
        <Card className="p-5">
          <HallScheduleGrid
            schedules={schedules ?? []}
            dayOfWeek={dayOfWeek}
            onChangeDay={setDayOfWeek}
            onAdd={() => setSheetOpen(true)}
            onDelete={handleDelete}
            loading={schedulesLoading}
          />
        </Card>

        <aside className="space-y-3">
          <Card className="p-4 space-y-3">
            <header className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">{hall.name}</h3>
            </header>
            <label className="flex items-center justify-between text-sm">
              <span>Salão ativo?</span>
              <Switch
                checked={hall.active}
                onCheckedChange={(active) => updateHall.mutate({ id: hall.id, active })}
              />
            </label>
            <Button variant="outline" size="sm" className="w-full gap-2" onClick={() => toast.info("Em breve.")}>
              <Pencil className="h-4 w-4" /> Editar salão
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" size="sm" className="w-full gap-2 text-destructive hover:text-destructive">
                  <Trash2 className="h-4 w-4" /> Excluir salão
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Excluir salão?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Os horários e a vinculação das mesas serão removidos. As mesas em si ficam
                    descomboinadas (sem salão) — você pode movê-las pra outro salão depois.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancelar</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() =>
                      removeHall.mutate(hall.id, {
                        onSuccess: () => {
                          toast.success("Salão excluído.");
                          navigate(`/g/${unitSlug}/reservas/saloes`);
                        },
                      })
                    }
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    Excluir
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </Card>

          <Card className="p-4 space-y-3">
            <header className="flex items-center gap-2">
              <Map className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-semibold">Mapa de mesas</h3>
            </header>
            <p className="text-xs text-muted-foreground">
              Visualização espacial das mesas. (Em breve.)
            </p>
            <Button variant="outline" size="sm" className="w-full" disabled>
              Criar mapa
            </Button>
          </Card>

          <Card className="p-4 space-y-3">
            <label className="flex items-center justify-between text-sm">
              <span>Cadeira vazia</span>
              <Switch
                checked={hall.allow_empty_seat}
                onCheckedChange={(allow) =>
                  updateHall.mutate({ id: hall.id, allow_empty_seat: allow })
                }
              />
            </label>
            <p className="text-xs text-muted-foreground">
              Com esta opção ativa, este salão oferece reservas mesmo se uma cadeira ficar vazia
              (ex: aceita 3 pessoas em mesa de 4).
            </p>
          </Card>
        </aside>
      </div>

      <HallScheduleSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        defaultDay={dayOfWeek}
        hallTables={hallTables ?? []}
        onSubmit={handleSubmitSchedule}
        onDeleteTable={handleDeleteTable}
      />
    </div>
  );
}
