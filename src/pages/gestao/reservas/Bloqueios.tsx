import { useState } from "react";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import {
  useTableBlocks,
  useCreateTableBlock,
  useUpdateTableBlock,
  useDeleteTableBlock,
  useOverbookingFlag,
} from "@/hooks/useTableBlocks";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { BreadcrumbReservas } from "./Saloes";
import type { TableBlock } from "@/types/reserva";

export default function Bloqueios() {
  const unit = useCurrentUnit();
  const unitId = unit?.unit_id ?? "";
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");
  const [editing, setEditing] = useState<TableBlock | null>(null);
  const [open, setOpen] = useState(false);

  const { data: blocks, isLoading } = useTableBlocks(unitId, {
    from: filterFrom || undefined,
    to: filterTo || undefined,
  });
  const deleteBlock = useDeleteTableBlock(unitId);
  const overbooking = useOverbookingFlag(unitId);

  const handleNew = () => {
    setEditing(null);
    setOpen(true);
  };

  const handleEdit = (b: TableBlock) => {
    setEditing(b);
    setOpen(true);
  };

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <BreadcrumbReservas current="Bloqueios" />
        <h1 className="text-2xl font-bold">Bloqueios</h1>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-5 items-start">
        <Card className="p-0 overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 p-4 border-b">
            <div className="flex items-center gap-2 text-sm">
              <Label className="text-xs text-muted-foreground">Data inicial</Label>
              <Input
                type="date"
                className="w-40"
                value={filterFrom}
                onChange={(e) => setFilterFrom(e.target.value)}
              />
              <span className="text-muted-foreground">→</span>
              <Label className="text-xs text-muted-foreground">Data final</Label>
              <Input
                type="date"
                className="w-40"
                value={filterTo}
                onChange={(e) => setFilterTo(e.target.value)}
              />
              {(filterFrom || filterTo) && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setFilterFrom("");
                    setFilterTo("");
                  }}
                >
                  Limpar
                </Button>
              )}
            </div>
            <Button size="sm" onClick={handleNew} className="gap-2">
              <Plus className="h-4 w-4" />
              Novo bloqueio
            </Button>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Data do bloqueio</TableHead>
                <TableHead>Título</TableHead>
                <TableHead>Horário de início</TableHead>
                <TableHead>Horário de término</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                [1, 2].map((i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={5}>
                      <Skeleton className="h-8 w-full" />
                    </TableCell>
                  </TableRow>
                ))
              ) : !blocks?.length ? (
                <TableRow>
                  <TableCell
                    colSpan={5}
                    className="h-32 text-center text-muted-foreground"
                  >
                    Não há bloqueios cadastrados.
                  </TableCell>
                </TableRow>
              ) : (
                blocks.map((b) => {
                  const from = new Date(b.blocked_from);
                  const to = new Date(b.blocked_to);
                  const isMacro = !b.table_id;
                  return (
                    <TableRow key={b.id}>
                      <TableCell className="font-medium">{formatDateRange(from, to)}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {b.title ?? b.reason ?? <span className="text-muted-foreground">—</span>}
                          {!isMacro && (
                            <Badge variant="outline" className="text-[10px]">
                              Mesa {b.table?.number ?? "?"}
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>{formatTime(from)}</TableCell>
                      <TableCell>{formatTime(to)}</TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => handleEdit(b)}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-7 w-7">
                                <Trash2 className="h-3.5 w-3.5 text-destructive" />
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Remover bloqueio?</AlertDialogTitle>
                                <AlertDialogDescription>
                                  As reservas voltarão a poder ser feitas no período.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancelar</AlertDialogCancel>
                                <AlertDialogAction
                                  onClick={() => deleteBlock.mutate(b.id)}
                                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                >
                                  Remover
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </Card>

        <Card className="p-4 space-y-3">
          <header className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold">Permitir overbooking</h3>
            <Switch
              checked={overbooking.value}
              onCheckedChange={(v) => overbooking.set(v)}
            />
          </header>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Com esta opção ativa, o painel de reservas <strong>permite</strong> que sejam criadas
            reservas acima da capacidade do salão quando todas as mesas compatíveis estão
            ocupadas — a reserva fica sem mesa atribuída até o operador alocar manualmente.
          </p>
          <p className="text-[11px] text-muted-foreground">
            Não atravessa datas fechadas, bloqueios ativos ou party_size maior que a maior mesa.
          </p>
        </Card>
      </div>

      {open && (
        <BloqueioModal
          unitId={unitId}
          editing={editing}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function formatDateRange(from: Date, to: Date): string {
  const fmt = (d: Date) => d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
  if (sameDay(from, to)) return fmt(from);
  return `${fmt(from)} → ${fmt(to)}`;
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

// ─── Modal ────────────────────────────────────────────────────────────────────

function BloqueioModal({
  unitId,
  editing,
  onClose,
}: {
  unitId: string;
  editing: TableBlock | null;
  onClose: () => void;
}) {
  const create = useCreateTableBlock(unitId);
  const update = useUpdateTableBlock(unitId);

  const initial = parseBlockToForm(editing);
  const [title, setTitle] = useState(initial.title);
  const [startDate, setStartDate] = useState(initial.startDate);
  const [endDate, setEndDate] = useState(initial.endDate);
  const [allDay, setAllDay] = useState(initial.allDay);
  const [startTime, setStartTime] = useState(initial.startTime);
  const [endTime, setEndTime] = useState(initial.endTime);

  const submitting = create.isPending || update.isPending;

  const handleSave = () => {
    if (!title.trim()) {
      toast.error("Informe um título.");
      return;
    }
    if (!startDate || !endDate) {
      toast.error("Defina data inicial e final.");
      return;
    }
    if (endDate < startDate) {
      toast.error("Data final não pode ser anterior à inicial.");
      return;
    }
    const fromTime = allDay ? "00:00" : startTime;
    const toTime = allDay ? "23:59" : endTime;
    if (!fromTime || !toTime) {
      toast.error("Defina horário de início e fim.");
      return;
    }

    const blocked_from = new Date(`${startDate}T${fromTime}:00`).toISOString();
    const blocked_to = new Date(`${endDate}T${toTime}:00`).toISOString();
    if (new Date(blocked_to) <= new Date(blocked_from)) {
      toast.error("Fim do bloqueio precisa ser posterior ao início.");
      return;
    }

    const payload = {
      title: title.trim(),
      blocked_from,
      blocked_to,
    };

    if (editing) {
      update.mutate(
        { id: editing.id, ...payload },
        {
          onSuccess: () => {
            toast.success("Bloqueio atualizado.");
            onClose();
          },
          onError: (err: Error) => toast.error(err.message ?? "Erro ao salvar."),
        },
      );
    } else {
      create.mutate(payload, {
        onSuccess: () => {
          toast.success("Bloqueio criado.");
          onClose();
        },
        onError: (err: Error) => toast.error(err.message ?? "Erro ao criar bloqueio."),
      });
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "Editar exceção" : "Adicionar exceção"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1">
            <Label className="text-xs">Título</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Ex: Dia dos namorados, evento privado…"
            />
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Data</Label>
            <div className="grid grid-cols-2 gap-3">
              <Input
                type="date"
                value={startDate}
                onChange={(e) => {
                  setStartDate(e.target.value);
                  if (!endDate || endDate < e.target.value) setEndDate(e.target.value);
                }}
                placeholder="Data inicial"
              />
              <Input
                type="date"
                value={endDate}
                min={startDate}
                onChange={(e) => setEndDate(e.target.value)}
                placeholder="Data final"
              />
            </div>
          </div>

          <label className="flex items-center gap-3 cursor-pointer">
            <Switch checked={allDay} onCheckedChange={setAllDay} />
            <span className="text-sm">Bloquear o dia inteiro</span>
          </label>

          {!allDay && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">
                  <span className="text-destructive">*</span> Início
                </Label>
                <Input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">
                  <span className="text-destructive">*</span> Final
                </Label>
                <Input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancelar
          </Button>
          <Button onClick={handleSave} disabled={submitting}>
            {submitting ? "Salvando…" : "Salvar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function parseBlockToForm(b: TableBlock | null) {
  if (!b) {
    return {
      title: "",
      startDate: "",
      endDate: "",
      allDay: false,
      startTime: "12:00",
      endTime: "22:00",
    };
  }
  const from = new Date(b.blocked_from);
  const to = new Date(b.blocked_to);
  const startTime = `${String(from.getHours()).padStart(2, "0")}:${String(from.getMinutes()).padStart(2, "0")}`;
  const endTime = `${String(to.getHours()).padStart(2, "0")}:${String(to.getMinutes()).padStart(2, "0")}`;
  const allDay = startTime === "00:00" && (endTime === "23:59" || endTime === "23:00");
  return {
    title: b.title ?? b.reason ?? "",
    startDate: localDateString(from),
    endDate: localDateString(to),
    allDay,
    startTime,
    endTime,
  };
}

function localDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
