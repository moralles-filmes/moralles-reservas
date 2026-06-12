import { useMemo } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogBody,
  ResponsiveDialogFooter,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
} from "@/components/ui/responsive-dialog";
import { useCreateManualReserva } from "@/hooks/useReservas";
import { useHallsWithSchedules } from "@/hooks/useHalls";
import { PartySizeInput } from "@/components/reserva/wizard/PartySizeInput";
import { getSlotsForDate } from "@/components/reserva/wizard/availability-helpers";
import type { PublicHall } from "@/types/reserva";
import { formatPhone, todayLocalISO } from "@/lib/utils";

const FORM_ID = "manual-reserva-form";
const PARTY_SIZE_MAX = 30; // backend (create-manual-reservation) rejeita party_size > 30
const HALL_AUTO = "auto";

const schema = z.object({
  name: z.string().trim().min(2, "Nome deve ter ao menos 2 caracteres"),
  phone: z
    .string()
    .transform((v) => v.replace(/\D/g, ""))
    .refine((v) => v.length >= 10 && v.length <= 13, {
      message: "Telefone inválido. Informe DDD + número.",
    }),
  email: z.string().trim().email("E-mail inválido").optional().or(z.literal("")),
  date: z.string().min(1, "Informe a data"),
  time: z.string().regex(/^\d{2}:\d{2}$/, "Informe o horário"),
  party_size: z.coerce.number().int().min(1).max(30),
  hall_id: z.string().optional(),
  notes: z.string().optional(),
  source: z.enum(["whatsapp", "web"]),
  status: z.enum(["confirmed", "pending"]),
  notify: z.boolean(),
  override: z.boolean(),
});

type FormData = z.infer<typeof schema>;

interface ManualReservaDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  unitId: string;
  organizationId: string;
}

export function ManualReservaDialog({
  open,
  onOpenChange,
  unitId,
  organizationId,
}: ManualReservaDialogProps) {
  const createManual = useCreateManualReserva(unitId);
  const { data: halls } = useHallsWithSchedules(unitId);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: "",
      phone: "",
      email: "",
      date: todayLocalISO(),
      time: "",
      party_size: 2,
      hall_id: HALL_AUTO,
      notes: "",
      source: "whatsapp",
      status: "confirmed",
      notify: false,
      override: false,
    },
  });

  const source = watch("source");
  const status = watch("status");
  const notify = watch("notify");
  const override = watch("override");
  const date = watch("date");
  const partySize = watch("party_size");
  const time = watch("time");

  // Horários cadastrados (halls + hall_schedules) pra a data escolhida — mesma
  // fonte do wizard público. `override` libera horário livre (eventos fora do
  // expediente); unit sem schedules cai no fallback de input livre.
  const timeSlots = useMemo(
    () => (date && halls ? getSlotsForDate(halls as unknown as PublicHall[], date) : []),
    [date, halls],
  );
  const hasAnySchedule = halls?.some((h) => h.schedules.length > 0) ?? false;
  const restrictTimes = !override && hasAnySchedule;

  const onSubmit = async (data: FormData) => {
    try {
      const res = await createManual.mutateAsync({
        unit_id: unitId,
        organization_id: organizationId,
        hall_id: data.hall_id && data.hall_id !== HALL_AUTO ? data.hall_id : null,
        name: data.name,
        phone: data.phone,
        email: data.email || null,
        date: data.date,
        time: data.time,
        party_size: data.party_size,
        notes: data.notes?.trim() || null,
        source: data.source,
        status: data.status,
        notify: data.notify,
        override: data.override,
      });
      toast.success(
        `Reserva criada — código ${res.reservation_code}${res.table_id ? "" : " (sem mesa alocada)"}`,
      );
      reset();
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao criar reserva.");
    }
  };

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Nova reserva manual</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Lançe uma reserva diretamente pelo painel quando o site ou o WhatsApp
            falharem.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <ResponsiveDialogBody>
          <form id={FORM_ID} onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            {/* Cliente */}
            <div className="space-y-1">
              <Label htmlFor="mr-name">Nome *</Label>
              <Input id="mr-name" placeholder="Nome do cliente" {...register("name")} />
              {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="mr-phone">WhatsApp *</Label>
                <Input
                  id="mr-phone"
                  inputMode="tel"
                  placeholder="(11) 99999-9999"
                  {...register("phone")}
                  onChange={(e) => {
                    const v = e.target.value.replace(/\D/g, "").slice(0, 13);
                    setValue("phone", v, { shouldValidate: true });
                  }}
                  value={formatPhone(watch("phone") || "")}
                />
                {errors.phone && <p className="text-xs text-destructive">{errors.phone.message}</p>}
              </div>
              <div className="space-y-1">
                <Label htmlFor="mr-email">E-mail (opcional)</Label>
                <Input id="mr-email" type="email" placeholder="cliente@email.com" {...register("email")} />
                {errors.email && <p className="text-xs text-destructive">{errors.email.message}</p>}
              </div>
            </div>

            {/* Data / hora / pessoas */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="mr-date">Data *</Label>
                <Input
                  id="mr-date"
                  type="date"
                  {...register("date")}
                  onChange={(e) => {
                    setValue("date", e.target.value, { shouldValidate: true });
                    // Slots mudam com a data — limpa o horário pra não manter um
                    // valor inválido pro novo dia.
                    if (time) setValue("time", "");
                  }}
                />
                {errors.date && <p className="text-xs text-destructive">{errors.date.message}</p>}
              </div>
              <div className="space-y-1">
                <Label htmlFor="mr-time">Horário *</Label>
                {restrictTimes ? (
                  timeSlots.length === 0 ? (
                    <p className="text-xs text-muted-foreground border rounded-md px-3 py-2.5 bg-muted/30">
                      Nenhum horário disponível neste dia. Escolha outra data ou
                      ligue "Forçar reserva".
                    </p>
                  ) : (
                    <Select
                      value={time}
                      onValueChange={(v) => setValue("time", v, { shouldValidate: true })}
                    >
                      <SelectTrigger id="mr-time">
                        <SelectValue placeholder="Selecione" />
                      </SelectTrigger>
                      <SelectContent>
                        {timeSlots.map((s) => (
                          <SelectItem key={s.time} value={s.time}>
                            {s.time}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )
                ) : (
                  <Input id="mr-time" type="time" {...register("time")} />
                )}
                {errors.time && <p className="text-xs text-destructive">{errors.time.message}</p>}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="mr-party">Pessoas *</Label>
                <PartySizeInput
                  id="mr-party"
                  value={partySize}
                  onChange={(n) => setValue("party_size", n, { shouldValidate: true })}
                  max={PARTY_SIZE_MAX}
                />
              </div>
              {halls && halls.length > 0 && (
                <div className="space-y-1">
                  <Label>Salão (opcional)</Label>
                  <Select
                    defaultValue={HALL_AUTO}
                    onValueChange={(v) => setValue("hall_id", v)}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value={HALL_AUTO}>Automático</SelectItem>
                      {halls.map((h) => (
                        <SelectItem key={h.id} value={h.id}>{h.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            {/* Origem (relatório) */}
            <div className="space-y-1">
              <Label>Origem da reserva *</Label>
              <Select
                value={source}
                onValueChange={(v) => setValue("source", v as FormData["source"])}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="whatsapp">WhatsApp</SelectItem>
                  <SelectItem value="web">Site</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                Define onde a reserva aparece no relatório "Origem das reservas".
              </p>
            </div>

            <div className="space-y-1">
              <Label htmlFor="mr-notes">Observações (opcional)</Label>
              <Textarea
                id="mr-notes"
                rows={2}
                placeholder="Alergias, ocasião, preferências..."
                {...register("notes")}
              />
            </div>

            {/* Toggles */}
            <div className="space-y-3 rounded-lg border p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">Reserva confirmada</p>
                  <p className="text-[11px] text-muted-foreground">
                    Desligado entra como "Aguardando confirmação".
                  </p>
                </div>
                <Switch
                  checked={status === "confirmed"}
                  onCheckedChange={(c) => setValue("status", c ? "confirmed" : "pending")}
                />
              </div>

              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">Avisar cliente</p>
                  <p className="text-[11px] text-muted-foreground">
                    Envia a confirmação automática (WhatsApp/e-mail).
                  </p>
                </div>
                <Switch
                  checked={notify}
                  onCheckedChange={(c) => setValue("notify", c)}
                />
              </div>

              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">Forçar reserva</p>
                  <p className="text-[11px] text-muted-foreground">
                    Cria mesmo sem mesa disponível ou fora do horário.
                  </p>
                </div>
                <Switch
                  checked={override}
                  onCheckedChange={(c) => {
                    setValue("override", c);
                    // Alterna entre lista de horários e input livre — limpa o
                    // valor anterior pra não carregar um horário inválido pro modo.
                    setValue("time", "");
                  }}
                />
              </div>
            </div>
          </form>
        </ResponsiveDialogBody>

        <ResponsiveDialogFooter>
          <Button
            type="button"
            variant="outline"
            className="flex-1"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            Cancelar
          </Button>
          <Button type="submit" form={FORM_ID} className="flex-1" disabled={isSubmitting}>
            {isSubmitting ? "Criando..." : "Criar reserva"}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
