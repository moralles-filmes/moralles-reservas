import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { HelpCircle, Plus, Trash2 } from "lucide-react";
import { TablesRangeInput, type TablesRangeValue } from "./TablesRangeInput";
import type { HallSchedule, Mesa } from "@/types/reserva";

const DAY_INITIALS = ["D", "S", "T", "Q", "Q", "S", "S"];
const SLOT_OPTIONS = [5, 10, 15, 20, 30, 45, 60];
const ADVANCE_OPTIONS = [0, 15, 30, 60, 120, 240, 360, 720, 1440];
const DISCOUNT_OPTIONS = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50];

export type HallScheduleSheetSubmit = {
  /** Presente quando editando uma schedule existente. */
  id?: string;
  days: number[];
  open_time: string;
  close_time: string;
  slot_minutes: number;
  min_advance_minutes: number;
  discount_percent: number;
  charge_enabled: boolean;
  charge_amount_cents: number | null;
  /** Mesas a criar nesse momento (atalho do modal). */
  newTables: TablesRangeValue[];
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultDay: number;
  hallTables: Mesa[];
  onSubmit: (payload: HallScheduleSheetSubmit) => Promise<void> | void;
  onDeleteTable?: (table: Mesa) => Promise<void> | void;
  /** Quando presente, o modal entra em modo edição. */
  editingSchedule?: HallSchedule | null;
};

export function HallScheduleSheet({
  open,
  onOpenChange,
  defaultDay,
  hallTables,
  onSubmit,
  onDeleteTable,
  editingSchedule,
}: Props) {
  const isEditing = Boolean(editingSchedule);
  const [days, setDays] = useState<number[]>([defaultDay]);
  const [openTime, setOpenTime] = useState("08:00");
  const [closeTime, setCloseTime] = useState("18:00");
  const [slotMinutes, setSlotMinutes] = useState(5);
  const [advance, setAdvance] = useState<number | "">("");
  const [discount, setDiscount] = useState<number | "">("");
  const [chargeEnabled, setChargeEnabled] = useState(false);
  const [chargeAmount, setChargeAmount] = useState("");
  const [newTables, setNewTables] = useState<TablesRangeValue[]>([]);
  const [pendingTable, setPendingTable] = useState<TablesRangeValue>({ count: 1, min: 4, max: 4 });
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (editingSchedule) {
      setDays([editingSchedule.day_of_week]);
      setOpenTime(editingSchedule.open_time.slice(0, 5));
      setCloseTime(editingSchedule.close_time.slice(0, 5));
      setSlotMinutes(editingSchedule.slot_minutes);
      setAdvance(editingSchedule.min_advance_minutes || 0);
      setDiscount(editingSchedule.discount_percent || 0);
      setChargeEnabled(editingSchedule.charge_enabled);
      setChargeAmount(
        editingSchedule.charge_amount_cents != null
          ? (editingSchedule.charge_amount_cents / 100).toFixed(2).replace(".", ",")
          : "",
      );
    } else {
      setDays([defaultDay]);
      setOpenTime("08:00");
      setCloseTime("18:00");
      setSlotMinutes(5);
      setAdvance("");
      setDiscount("");
      setChargeEnabled(false);
      setChargeAmount("");
    }
    setNewTables([]);
    setPendingTable({ count: 1, min: 4, max: 4 });
  }, [open, defaultDay, editingSchedule]);

  const toggleDay = (dow: number) => {
    if (isEditing) return;
    setDays((prev) => (prev.includes(dow) ? prev.filter((d) => d !== dow) : [...prev, dow].sort()));
  };

  const addPending = () => {
    if (pendingTable.count <= 0 || pendingTable.min <= 0) return;
    setNewTables((prev) => [...prev, pendingTable]);
    setPendingTable({ count: 1, min: 4, max: 4 });
  };

  const handleSubmit = async () => {
    if (days.length === 0) return;
    if (closeTime <= openTime) return;
    setSubmitting(true);
    try {
      await onSubmit({
        ...(editingSchedule ? { id: editingSchedule.id } : {}),
        days,
        open_time: openTime,
        close_time: closeTime,
        slot_minutes: slotMinutes,
        min_advance_minutes: advance === "" ? 0 : Number(advance),
        discount_percent: discount === "" ? 0 : Number(discount),
        charge_enabled: chargeEnabled,
        charge_amount_cents:
          chargeEnabled && chargeAmount
            ? Math.round(Number(chargeAmount.replace(",", ".")) * 100)
            : null,
        newTables,
      });
      onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Editar horário" : "Adicionar novo horário"}</DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Coluna esquerda: parâmetros do schedule */}
          <div className="space-y-5">
            <div>
              <div className="flex gap-1 rounded-md border p-1 w-fit">
                {DAY_INITIALS.map((label, dow) => {
                  const active = days.includes(dow);
                  return (
                    <button
                      key={dow}
                      type="button"
                      onClick={() => toggleDay(dow)}
                      disabled={isEditing}
                      className={`h-9 w-9 rounded-md text-sm font-medium transition-colors ${
                        active
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:bg-muted"
                      } ${isEditing ? "cursor-not-allowed opacity-80" : ""}`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
              {isEditing && (
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  Pra mover pra outro dia, exclua e recrie.
                </p>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">
                  <span className="text-destructive">*</span> Início
                </Label>
                <Input type="time" value={openTime} onChange={(e) => setOpenTime(e.target.value)} />
              </div>
              <div>
                <Label className="text-xs">
                  <span className="text-destructive">*</span> Final
                </Label>
                <Input type="time" value={closeTime} onChange={(e) => setCloseTime(e.target.value)} />
              </div>
            </div>

            <div>
              <LabelWithHelp
                label="Escala"
                required
                help="A escala representa a divisão do tempo dentro da janela de horário. Ex: em uma escala de 15 minutos os horários serão exibidos assim: 10:00, 10:15, 10:30, 10:45, etc."
              />
              <Select value={String(slotMinutes)} onValueChange={(v) => setSlotMinutes(Number(v))}>
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
                label="Antecedência mínima (min)"
                help="Quantidade de minutos que o cliente precisa reservar antes do horário desejado. Ex: se o cliente quiser fazer uma reserva às 11:00 e a antecedência for 30 min, ele poderá reservar até 10:29."
              />
              <Select
                value={advance === "" ? "" : String(advance)}
                onValueChange={(v) => setAdvance(v === "" ? "" : Number(v))}
              >
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
              <Select
                value={discount === "" ? "" : String(discount)}
                onValueChange={(v) => setDiscount(v === "" ? "" : Number(v))}
              >
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
          </div>

          {/* Coluna direita: mesas do salão */}
          <div className="space-y-4">
            <div>
              <h3 className="text-sm font-semibold mb-2">Mesas do salão</h3>
              <div className="border rounded-md min-h-[120px] divide-y">
                {hallTables.length === 0 && newTables.length === 0 ? (
                  <div className="p-6 text-center text-sm text-muted-foreground">Não há mesas</div>
                ) : (
                  <>
                    {hallTables.map((t) => (
                      <div key={t.id} className="flex items-center justify-between gap-3 p-3 text-sm">
                        <span>
                          Mesa {t.number} · {t.min_capacity}
                          {t.max_capacity > t.min_capacity ? `–${t.max_capacity}` : ""} lugares
                        </span>
                        {onDeleteTable && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-muted-foreground hover:text-destructive"
                            onClick={() => onDeleteTable(t)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    ))}
                    {newTables.map((nt, idx) => (
                      <div
                        key={`new-${idx}`}
                        className="flex items-center justify-between gap-3 p-3 text-sm bg-muted/40"
                      >
                        <span>
                          {nt.count} mesa{nt.count > 1 ? "s" : ""} de {nt.min}
                          {nt.max > nt.min ? ` a ${nt.max}` : ""} lugares
                          <span className="ml-2 text-[10px] text-muted-foreground">(será criada)</span>
                        </span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                          onClick={() => setNewTables((prev) => prev.filter((_, i) => i !== idx))}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    ))}
                  </>
                )}
              </div>
            </div>

            <div className="space-y-3">
              <h3 className="text-sm font-semibold">Adicionar mesas</h3>
              <TablesRangeInput
                key={newTables.length}
                value={pendingTable}
                onChange={setPendingTable}
              />
              <Button onClick={addPending} variant="outline" size="sm" className="gap-2">
                <Plus className="h-4 w-4" />
                Adicionar à lista
              </Button>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancelar
          </Button>
          <Button onClick={handleSubmit} disabled={submitting || days.length === 0 || closeTime <= openTime}>
            {submitting ? "Salvando…" : "Salvar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LabelWithHelp({ label, required, help }: { label: string; required?: boolean; help: string }) {
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
