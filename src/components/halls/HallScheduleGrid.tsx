import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { DAY_NAMES, type HallSchedule } from "@/types/reserva";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type Props = {
  schedules: HallSchedule[];
  /** Dia da semana selecionado (0=domingo). */
  dayOfWeek: number;
  onChangeDay: (dow: number) => void;
  onAdd: () => void;
  onEdit: (schedule: HallSchedule) => void;
  onDelete: (schedule: HallSchedule) => void;
  loading?: boolean;
};

export function HallScheduleGrid({ schedules, dayOfWeek, onChangeDay, onAdd, onEdit, onDelete, loading }: Props) {
  const filtered = useMemo(
    () => schedules.filter((s) => s.day_of_week === dayOfWeek),
    [schedules, dayOfWeek],
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1 border-b border-border">
        {DAY_NAMES.map((label, dow) => {
          const active = dow === dayOfWeek;
          const has = schedules.some((s) => s.day_of_week === dow);
          return (
            <button
              key={dow}
              type="button"
              onClick={() => onChangeDay(dow)}
              className={`relative px-3 py-2 text-sm transition-colors ${
                active
                  ? "text-primary font-medium border-b-2 border-primary -mb-px"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {label}
              {has && !active && (
                <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-primary/50 align-middle" />
              )}
            </button>
          );
        })}
      </div>

      <div className="flex justify-end">
        <Button onClick={onAdd} size="sm" className="gap-2">
          <Plus className="h-4 w-4" />
          Novo horário
        </Button>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Horário</TableHead>
            <TableHead>Escala</TableHead>
            <TableHead>Antecedência</TableHead>
            <TableHead>Desconto</TableHead>
            <TableHead>Tipo</TableHead>
            <TableHead className="w-20" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            <TableRow>
              <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                Carregando…
              </TableCell>
            </TableRow>
          ) : filtered.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                Não há horários configurados para {DAY_NAMES[dayOfWeek].toLowerCase()}.
              </TableCell>
            </TableRow>
          ) : (
            filtered.map((schedule) => (
              <TableRow key={schedule.id}>
                <TableCell className="font-medium">
                  {schedule.open_time.slice(0, 5)} – {schedule.close_time.slice(0, 5)}
                </TableCell>
                <TableCell>{schedule.slot_minutes} min</TableCell>
                <TableCell>
                  {schedule.min_advance_minutes > 0 ? `${schedule.min_advance_minutes} min` : "—"}
                </TableCell>
                <TableCell>
                  {schedule.discount_percent > 0 ? `${schedule.discount_percent}%` : "—"}
                </TableCell>
                <TableCell>
                  {schedule.charge_enabled ? (
                    <span className="text-amber-700">Com cobrança</span>
                  ) : (
                    <span className="text-muted-foreground">Sem cobrança</span>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-foreground"
                      onClick={() => onEdit(schedule)}
                      aria-label="Editar horário"
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      onClick={() => onDelete(schedule)}
                      aria-label="Remover horário"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
