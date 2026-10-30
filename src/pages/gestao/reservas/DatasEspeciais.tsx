import { useState } from "react";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import {
  useSpecialDates,
  useUpsertSpecialDate,
  useDeleteSpecialDate,
  type SpecialDateInput,
} from "@/hooks/useSpecialDates";
import { useHalls } from "@/hooks/useHalls";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { CalendarPlus, HelpCircle, Pencil, Trash2 } from "lucide-react";
import { formatDateBR } from "@/lib/utils";
import type { SpecialDate } from "@/types/reserva";
import { toast } from "sonner";
import { BreadcrumbReservas } from "./Saloes";

const SLOT_OPTIONS = [5, 10, 15, 20, 30, 45, 60];
const ADVANCE_OPTIONS = [0, 15, 30, 60, 120, 240, 360, 720, 1440];
const DISCOUNT_OPTIONS = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50];
const ALL_HALLS_VALUE = "__all__";

export default function DatasEspeciais() {
  const unit = useCurrentUnit();
  const unitId = unit?.unit_id ?? "";
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");
  const [editing, setEditing] = useState<SpecialDate | null>(null);
  const [open, setOpen] = useState(false);

  const { data: dates, isLoading } = useSpecialDates(unitId, {
    from: filterFrom || undefined,
    to: filterTo || undefined,
  });
  const { data: halls } = useHalls(unitId, { includeInactive: true });
  const remove = useDeleteSpecialDate(unitId);

  const handleEdit = (d: SpecialDate) => {
    setEditing(d);
    setOpen(true);
  };

  const handleNew = () => {
    setEditing(null);
    setOpen(true);
  };

  const hallNameById: Record<string, string> = Object.fromEntries(
    (halls ?? []).map((h) => [h.id, h.name]),
  );

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <BreadcrumbReservas current="Datas especiais" />
        <h1 className="text-2xl font-bold">Datas especiais</h1>
      </header>

      <Card className="p-0 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 p-4 border-b">
          <div className="flex items-center gap-2 text-sm">
            <Label htmlFor="datas-especiais-filtro-inicio" className="text-xs text-muted-foreground">Data inicial</Label>
            <Input
              type="date"
              className="w-40"
              id="datas-especiais-filtro-inicio"
              value={filterFrom}
              onChange={(e) => setFilterFrom(e.target.value)}
            />
            <span className="text-muted-foreground">→</span>
            <Label htmlFor="datas-especiais-filtro-fim" className="text-xs text-muted-foreground">Data final</Label>
            <Input
              type="date"
              className="w-40"
              id="datas-especiais-filtro-fim"
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
            <CalendarPlus className="h-4 w-4" />
            Nova data
          </Button>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Data</TableHead>
              <TableHead>Título</TableHead>
              <TableHead>Horário de início</TableHead>
              <TableHead>Horário de término</TableHead>
              <TableHead>Salão</TableHead>
              <TableHead>Tipo</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              [1, 2].map((i) => (
                <TableRow key={i}>
                  <TableCell colSpan={7}>
                    <Skeleton className="h-8 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : !dates?.length ? (
              <TableRow>
                <TableCell colSpan={7} className="h-32 text-center text-muted-foreground">
                  Não há dados
                </TableCell>
              </TableRow>
            ) : (
              dates.map((d) => (
                <TableRow key={d.id}>
                  <TableCell className="font-medium">{formatDateRange(d)}</TableCell>
                  <TableCell>{d.name}</TableCell>
                  <TableCell>{d.is_closed ? "—" : d.open_time?.slice(0, 5) ?? "—"}</TableCell>
                  <TableCell>{d.is_closed ? "—" : d.close_time?.slice(0, 5) ?? "—"}</TableCell>
                  <TableCell>
                    {d.hall_id ? hallNameById[d.hall_id] ?? "—" : "Todos os salões"}
                  </TableCell>
                  <TableCell>
                    {d.is_closed ? (
                      <Badge variant="outline" className="text-[10px] text-destructive border-destructive/30">
                        Fechado
                      </Badge>
                    ) : d.discount_percent && d.discount_percent > 0 ? (
                      <Badge variant="outline" className="text-[10px] text-success border-success/40">
                        Promoção {d.discount_percent}%
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-[10px]">Override</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => handleEdit(d)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Excluir data especial">
                            <Trash2 className="h-3.5 w-3.5 text-destructive" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Excluir data especial?</AlertDialogTitle>
                            <AlertDialogDescription>
                              O horário desta data voltará ao padrão da semana.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancelar</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => remove.mutate(d.id)}
                              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            >
                              Excluir
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      {open && (
        <SpecialDateModal
          unitId={unitId}
          halls={(halls ?? []).map((h) => ({ id: h.id, name: h.name }))}
          editing={editing}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function formatDateRange(d: SpecialDate): string {
  if (d.end_date && d.end_date !== d.date) {
    return `${formatDateBR(d.date)} → ${formatDateBR(d.end_date)}`;
  }
  return formatDateBR(d.date);
}

// ─── Modal ────────────────────────────────────────────────────────────────────

function SpecialDateModal({
  unitId,
  halls,
  editing,
  onClose,
}: {
  unitId: string;
  halls: Array<{ id: string; name: string }>;
  editing: SpecialDate | null;
  onClose: () => void;
}) {
  const upsert = useUpsertSpecialDate(unitId);

  const [name, setName] = useState(editing?.name ?? "");
  const [hallId, setHallId] = useState<string>(editing?.hall_id ?? ALL_HALLS_VALUE);
  const [startDate, setStartDate] = useState(editing?.date ?? "");
  const [endDate, setEndDate] = useState(editing?.end_date ?? editing?.date ?? "");
  const [isClosed, setIsClosed] = useState(editing?.is_closed ?? false);
  const [openTime, setOpenTime] = useState(editing?.open_time?.slice(0, 5) ?? "12:00");
  const [closeTime, setCloseTime] = useState(editing?.close_time?.slice(0, 5) ?? "22:00");
  const [maxPartySize, setMaxPartySize] = useState<string>(
    editing?.max_party_size ? String(editing.max_party_size) : "",
  );
  const [slotMinutes, setSlotMinutes] = useState<string>(
    editing?.slot_minutes ? String(editing.slot_minutes) : "30",
  );
  const [advance, setAdvance] = useState<string>(
    editing?.min_advance_minutes != null ? String(editing.min_advance_minutes) : "",
  );
  const [discount, setDiscount] = useState<string>(
    editing?.discount_percent ? String(editing.discount_percent) : "",
  );
  const [chargeEnabled, setChargeEnabled] = useState(editing?.charge_enabled ?? false);
  const [chargeAmount, setChargeAmount] = useState<string>(
    editing?.charge_amount_cents ? (editing.charge_amount_cents / 100).toFixed(2) : "",
  );
  const [notes, setNotes] = useState(editing?.notes ?? "");

  const handleSave = () => {
    if (!name.trim()) {
      toast.error("Informe um título.");
      return;
    }
    if (!startDate || !endDate) {
      toast.error("Defina as datas.");
      return;
    }
    if (endDate < startDate) {
      toast.error("Data final não pode ser anterior à inicial.");
      return;
    }
    if (!isClosed && (!openTime || !closeTime || closeTime <= openTime)) {
      toast.error("Defina horário de início e fim válidos, ou marque como fechado.");
      return;
    }
    const payload: SpecialDateInput = {
      id: editing?.id,
      hall_id: hallId === ALL_HALLS_VALUE ? null : hallId,
      date: startDate,
      end_date: endDate,
      name: name.trim(),
      is_closed: isClosed,
      open_time: isClosed ? null : openTime,
      close_time: isClosed ? null : closeTime,
      max_party_size: !isClosed && maxPartySize ? Number(maxPartySize) : null,
      slot_minutes: !isClosed ? Number(slotMinutes) : null,
      min_advance_minutes: !isClosed && advance !== "" ? Number(advance) : null,
      discount_percent: !isClosed && discount !== "" ? Number(discount) : null,
      charge_enabled: !isClosed && chargeEnabled,
      charge_amount_cents:
        !isClosed && chargeEnabled && chargeAmount
          ? Math.round(Number(chargeAmount.replace(",", ".")) * 100)
          : null,
      notes: notes.trim() || null,
    };
    upsert.mutate(payload, {
      onSuccess: () => {
        toast.success("Data salva.");
        onClose();
      },
      onError: (err: Error) => toast.error(err.message ?? "Erro ao salvar."),
    });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? "Editar data especial" : "Adicionar data especial"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-5">
          <div className="space-y-1">
            <Label className="text-xs">
              <span className="text-destructive">*</span> Título
            </Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ex: Natal, Réveillon, Show de Jazz…"
            />
          </div>

          <div className="space-y-1">
            <Label className="text-xs">
              <span className="text-destructive">*</span> Salão
            </Label>
            <Select value={hallId} onValueChange={setHallId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_HALLS_VALUE}>Todos os salões</SelectItem>
                {halls.map((h) => (
                  <SelectItem key={h.id} value={h.id}>
                    {h.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="datas-especiais-data-inicial" className="text-xs">
                <span className="text-destructive">*</span> Data inicial
              </Label>
              <Input
                type="date"
                id="datas-especiais-data-inicial"
                value={startDate}
                onChange={(e) => {
                  setStartDate(e.target.value);
                  if (!endDate || endDate < e.target.value) setEndDate(e.target.value);
                }}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="datas-especiais-data-final" className="text-xs">
                <span className="text-destructive">*</span> Data final
              </Label>
              <Input
                type="date"
                id="datas-especiais-data-final"
                value={endDate}
                min={startDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
          </div>

          <label className="flex items-center gap-3 text-sm cursor-pointer">
            <Switch checked={isClosed} onCheckedChange={setIsClosed} />
            <span>Fechado neste período</span>
          </label>

          {!isClosed && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">
                    <span className="text-destructive">*</span> Início
                  </Label>
                  <Input type="time" value={openTime} onChange={(e) => setOpenTime(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">
                    <span className="text-destructive">*</span> Final
                  </Label>
                  <Input type="time" value={closeTime} onChange={(e) => setCloseTime(e.target.value)} />
                </div>
              </div>

              <div className="space-y-1">
                <Label className="text-xs">Quantidade máxima de pessoas</Label>
                <Input
                  type="number"
                  min={1}
                  max={100}
                  placeholder="Ex: 20 (deixe vazio pra usar o padrão)"
                  value={maxPartySize}
                  onChange={(e) => setMaxPartySize(e.target.value)}
                />
              </div>

              <div>
                <LabelWithHelp
                  label="Escala"
                  required
                  help="Divisão do tempo dentro da janela. Ex: 15 min → horários 10:00, 10:15, 10:30…"
                />
                <Select value={slotMinutes} onValueChange={setSlotMinutes}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SLOT_OPTIONS.map((m) => (
                      <SelectItem key={m} value={String(m)}>
                        {m} minutos
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <LabelWithHelp
                  label="Antecedência mínima"
                  help="Quantos minutos antes do horário desejado o cliente precisa reservar."
                />
                <Select value={advance} onValueChange={setAdvance}>
                  <SelectTrigger>
                    <SelectValue placeholder="--" />
                  </SelectTrigger>
                  <SelectContent>
                    {ADVANCE_OPTIONS.map((m) => (
                      <SelectItem key={m} value={String(m)}>
                        {m === 0 ? "Sem antecedência" : `${m} min`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label className="text-xs">Desconto</Label>
                <Select value={discount} onValueChange={setDiscount}>
                  <SelectTrigger>
                    <SelectValue placeholder="--" />
                  </SelectTrigger>
                  <SelectContent>
                    {DISCOUNT_OPTIONS.map((d) => (
                      <SelectItem key={d} value={String(d)}>
                        {d === 0 ? "Sem desconto" : `${d}%`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <label className="flex items-center gap-3 cursor-pointer">
                  <Switch checked={chargeEnabled} onCheckedChange={setChargeEnabled} />
                  <span className="text-sm">Reserva com cobrança</span>
                </label>
                {chargeEnabled && (
                  <div>
                    <Label className="text-xs">Valor da cobrança (R$)</Label>
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="0,00"
                      value={chargeAmount}
                      onChange={(e) => setChargeAmount(e.target.value)}
                    />
                  </div>
                )}
              </div>
            </>
          )}

          <div className="space-y-1">
            <Label className="text-xs">Observação (opcional)</Label>
            <Input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Ex: menu fixo, entrada com lista…"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={handleSave} disabled={upsert.isPending}>
            {upsert.isPending ? "Salvando…" : "Salvar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LabelWithHelp({
  label,
  required,
  help,
}: {
  label: string;
  required?: boolean;
  help: string;
}) {
  return (
    <Label className="text-xs flex items-center gap-1">
      {required && <span className="text-destructive">*</span>}
      {label}
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <HelpCircle className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">{help}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </Label>
  );
}
