import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useCreateReserva } from "@/hooks/useReservas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import type {
  PublicCustomField,
  Reserva,
  WidgetFieldConfigMap,
  WidgetFieldKey,
} from "@/types/reserva";
import { formatDateBR, formatPhone } from "@/lib/utils";
import { CalendarIcon, CheckCircle, SquareStack, Users } from "lucide-react";

const schema = z.object({
  name: z.string().min(2, "Nome deve ter ao menos 2 caracteres"),
  phone: z.string().min(10, "Telefone inválido").max(15),
  email: z.string().email("E-mail inválido").optional().or(z.literal("")),
  date: z.string().min(1, "Selecione uma data"),
  time: z.string().min(1, "Selecione um horário"),
  party_size: z.coerce.number().min(1).max(20),
  notes: z.string().optional(),
});

type FormData = z.infer<typeof schema>;

const FALLBACK_TIME_SLOTS = [
  "12:00", "12:30", "13:00", "13:30", "14:00",
  "19:00", "19:30", "20:00", "20:30", "21:00", "21:30", "22:00",
];

const PARTY_SIZES = Array.from({ length: 20 }, (_, i) => i + 1);

function generateTimeSlots(openTime: string, closeTime: string, intervalMins = 30): string[] {
  const slots: string[] = [];
  const [openH, openM] = openTime.split(":").map(Number);
  const [closeH, closeM] = closeTime.split(":").map(Number);
  let current = openH * 60 + openM;
  const end = closeH * 60 + closeM;
  // Última reserva tem que ser pelo menos 30min antes do fechamento
  const cutoff = end - 30;
  while (current <= cutoff) {
    const h = Math.floor(current / 60);
    const m = current % 60;
    slots.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    current += intervalMins;
  }
  return slots;
}

interface UnitContext {
  id: string;
  name: string;
  organization_id: string;
}

interface PublicHallSchedule {
  day_of_week: number;
  open_time: string;
  close_time: string;
  slot_minutes: number;
  min_advance_minutes: number;
}

interface PublicHall {
  id: string;
  name: string;
  description: string | null;
  schedules: PublicHallSchedule[];
}

interface ReservaFormProps {
  onSuccess?: (reserva: Reserva) => void;
  unit?: UnitContext;
  halls?: PublicHall[];
  widgetConfig?: WidgetFieldConfigMap;
  widgetId?: string;
  customFields?: PublicCustomField[];
  /** Janela de reserva em dias (default 60). Limita o `max` do date input. */
  bookingWindowDays?: number;
}

const FIELD_LABELS: Record<WidgetFieldKey, string> = {
  experiencia: "Experiência",
  estado: "Estado",
  ocasiao: "Ocasião",
  data_nascimento: "Data de nascimento",
  cpf: "CPF",
  cep: "CEP",
  codigo_promocional: "Código promocional",
  observacao: "Observação",
};

const FIELD_ORDER: WidgetFieldKey[] = [
  "ocasiao",
  "data_nascimento",
  "cpf",
  "cep",
  "experiencia",
  "estado",
  "codigo_promocional",
  "observacao",
];

function fieldInputType(key: WidgetFieldKey): string {
  if (key === "data_nascimento") return "date";
  return "text";
}

export function ReservaForm({ onSuccess, unit, halls, widgetConfig, widgetId, customFields, bookingWindowDays }: ReservaFormProps) {
  const createReserva = useCreateReserva();

  const { data: defaultUnit } = useQuery({
    queryKey: ["default-unit"],
    queryFn: async () => {
      const { data } = await supabase
        .from("units")
        .select("id, name, organization_id")
        .limit(1)
        .maybeSingle();
      return data;
    },
    enabled: !unit,
    staleTime: 5 * 60 * 1000,
  });

  const effectiveUnit = unit ?? defaultUnit ?? null;
  const [confirmed, setConfirmed] = useState<Reserva | null>(null);

  const hallList = halls ?? [];
  const [hallId, setHallId] = useState<string>(() =>
    hallList.length === 1 ? hallList[0].id : "",
  );

  useEffect(() => {
    if (hallList.length === 1 && !hallId) setHallId(hallList[0].id);
  }, [hallList, hallId]);

  // Caminho legado: business_hours quando a unit não tem halls
  const { data: businessHours } = useQuery({
    queryKey: ["public_business_hours", effectiveUnit?.id],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_public_business_hours", {
        p_unit_id: effectiveUnit!.id,
      });
      if (error) throw error;
      return data as Array<{ day_of_week: number; open_time: string; close_time: string; is_closed: boolean }>;
    },
    enabled: !!effectiveUnit?.id && hallList.length === 0,
    staleTime: 5 * 60 * 1000,
  });

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { party_size: 2 },
  });

  // Estado dos campos extras configurados pelo widget
  const enabledExtras = useMemo(
    () =>
      FIELD_ORDER.filter((key) => widgetConfig?.[key]?.enabled === true).map((key) => ({
        key,
        label: widgetConfig?.[key]?.label?.trim() || FIELD_LABELS[key],
        required: widgetConfig?.[key]?.required === true,
      })),
    [widgetConfig],
  );
  const [extras, setExtras] = useState<Partial<Record<WidgetFieldKey, string>>>({});

  // Custom fields (definidos por unit em "Personalizar formulário")
  const sortedCustomFields = useMemo(
    () => [...(customFields ?? [])].sort((a, b) => a.sort_order - b.sort_order),
    [customFields],
  );
  const [customValues, setCustomValues] = useState<Record<string, string>>({});

  const selectedDate = watch("date");
  const selectedHall = useMemo(
    () => hallList.find((h) => h.id === hallId),
    [hallList, hallId],
  );

  // Slots disponíveis: hall_schedules → preferido; business_hours → legado
  const { timeSlots, isClosed } = useMemo<{ timeSlots: string[]; isClosed: boolean }>(() => {
    if (!selectedDate) {
      return { timeSlots: FALLBACK_TIME_SLOTS, isClosed: false };
    }
    const dow = new Date(`${selectedDate}T12:00:00`).getDay();

    // Caso 1: hall escolhido
    if (selectedHall) {
      const windows = selectedHall.schedules.filter((s) => s.day_of_week === dow);
      if (windows.length === 0) return { timeSlots: [], isClosed: true };
      const all: string[] = [];
      for (const w of windows) {
        all.push(...generateTimeSlots(w.open_time, w.close_time, w.slot_minutes));
      }
      return { timeSlots: Array.from(new Set(all)).sort(), isClosed: false };
    }

    // Caso 2: legado (sem halls)
    if (businessHours) {
      const entry = businessHours.find((bh) => bh.day_of_week === dow);
      if (entry?.is_closed) return { timeSlots: [], isClosed: true };
      if (entry) return { timeSlots: generateTimeSlots(entry.open_time, entry.close_time), isClosed: false };
    }
    return { timeSlots: FALLBACK_TIME_SLOTS, isClosed: false };
  }, [selectedDate, selectedHall, businessHours]);

  const onSubmit = async (data: FormData) => {
    if (hallList.length > 1 && !hallId) {
      toast.error("Selecione um salão.");
      return;
    }
    // Validar campos extras obrigatórios
    for (const f of enabledExtras) {
      if (f.required && !(extras[f.key] ?? "").trim()) {
        toast.error(`Preencha: ${f.label}`);
        return;
      }
    }
    // Validar custom fields obrigatórios
    for (const f of sortedCustomFields) {
      if (f.required && !(customValues[f.id] ?? "").trim()) {
        toast.error(`Preencha: ${f.label}`);
        return;
      }
    }
    // data_nascimento vai pro campo birthday do customer (não duplica em notes).
    // Demais extras seguem concatenados em notes pra preservar dados sem mudar schema.
    const birthday = (extras.data_nascimento ?? "").trim() || null;
    const extraLines = enabledExtras
      .filter((f) => f.key !== "data_nascimento")
      .map((f) => {
        const v = (extras[f.key] ?? "").trim();
        return v ? `${f.label}: ${v}` : "";
      })
      .filter(Boolean);
    const combinedNotes = [data.notes?.trim(), extraLines.join("\n")]
      .filter(Boolean)
      .join("\n\n") || undefined;

    // Custom field values (gravados em coluna JSONB dedicada)
    const customPayload: Record<string, string> = {};
    for (const f of sortedCustomFields) {
      const v = (customValues[f.id] ?? "").trim();
      if (v) customPayload[f.id] = v;
    }

    try {
      const reserva = await createReserva.mutateAsync({
        ...data,
        notes: combinedNotes,
        unit_id: effectiveUnit?.id ?? "",
        organization_id: effectiveUnit?.organization_id ?? "",
        hall_id: hallId || null,
        widget_id: widgetId,
        custom_field_values: Object.keys(customPayload).length ? customPayload : undefined,
        birthday,
      });
      setConfirmed(reserva);
      reset();
      setExtras({});
      setCustomValues({});
      onSuccess?.(reserva);
      toast.success("Reserva criada! Você receberá a confirmação no WhatsApp.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erro ao criar reserva. Tente novamente.";
      toast.error(msg);
    }
  };

  if (confirmed) {
    return (
      <Card className="max-w-lg mx-auto animate-fade-up">
        <CardContent className="pt-8 pb-8 text-center">
          <CheckCircle className="h-16 w-16 text-success mx-auto mb-4" />
          <h2 className="text-2xl font-semibold mb-2">Reserva Confirmada!</h2>
          <p className="text-muted-foreground mb-6">
            Você receberá a confirmação via WhatsApp em breve.
          </p>
          <div className="bg-muted rounded-lg p-4 text-left space-y-2 mb-6">
            <div className="flex justify-between">
              <span className="text-muted-foreground text-sm">Código</span>
              <span className="font-mono font-semibold">#{confirmed.reservation_code}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground text-sm">Data</span>
              <span className="font-medium">{formatDateBR(confirmed.date)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground text-sm">Horário</span>
              <span className="font-medium">{confirmed.time}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground text-sm">Pessoas</span>
              <span className="font-medium">{confirmed.party_size}</span>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Guarde seu código para consultar ou alterar a reserva.
          </p>
          <Button
            variant="outline"
            className="mt-4"
            onClick={() => setConfirmed(null)}
          >
            Fazer outra reserva
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="max-w-lg mx-auto">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarIcon className="h-5 w-5 text-primary" />
          Fazer Reserva
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          {hallList.length > 1 && (
            <div className="space-y-1">
              <Label className="flex items-center gap-1">
                <SquareStack className="h-3 w-3" /> Salão *
              </Label>
              <Select value={hallId} onValueChange={setHallId}>
                <SelectTrigger>
                  <SelectValue placeholder="Selecione o salão" />
                </SelectTrigger>
                <SelectContent>
                  {hallList.map((h) => (
                    <SelectItem key={h.id} value={h.id}>
                      {h.name}
                      {h.description ? ` · ${h.description}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1">
            <Label htmlFor="name">Nome completo *</Label>
            <Input id="name" placeholder="Seu nome" {...register("name")} />
            {errors.name && (
              <p className="text-xs text-destructive">{errors.name.message}</p>
            )}
          </div>

          <div className="space-y-1">
            <Label htmlFor="phone">WhatsApp *</Label>
            <Input
              id="phone"
              placeholder="(11) 99999-9999"
              {...register("phone")}
              onChange={(e) => {
                const v = e.target.value.replace(/\D/g, "").slice(0, 11);
                setValue("phone", v);
              }}
              value={formatPhone(watch("phone") || "")}
            />
            {errors.phone && (
              <p className="text-xs text-destructive">{errors.phone.message}</p>
            )}
          </div>

          <div className="space-y-1">
            <Label htmlFor="email">E-mail (opcional)</Label>
            <Input id="email" type="email" placeholder="seu@email.com" {...register("email")} />
            {errors.email && (
              <p className="text-xs text-destructive">{errors.email.message}</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="date">Data *</Label>
              <Input
                id="date"
                type="date"
                min={new Date().toISOString().split("T")[0]}
                max={(() => {
                  const days = bookingWindowDays && bookingWindowDays > 0 ? bookingWindowDays : 60;
                  const max = new Date();
                  max.setDate(max.getDate() + days);
                  return max.toISOString().split("T")[0];
                })()}
                {...register("date")}
              />
              {errors.date && (
                <p className="text-xs text-destructive">{errors.date.message}</p>
              )}
            </div>

            <div className="space-y-1">
              <Label>Horário *</Label>
              {isClosed ? (
                <p className="text-xs text-muted-foreground border rounded-md px-3 py-2">
                  {selectedHall ? `${selectedHall.name}: fechado` : "Restaurante fechado neste dia"}
                </p>
              ) : (
                <Select onValueChange={(v) => setValue("time", v)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Selecione" />
                  </SelectTrigger>
                  <SelectContent>
                    {timeSlots.map((t) => (
                      <SelectItem key={t} value={t}>{t}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {errors.time && (
                <p className="text-xs text-destructive">{errors.time.message}</p>
              )}
            </div>
          </div>

          <div className="space-y-1">
            <Label className="flex items-center gap-1">
              <Users className="h-3 w-3" /> Número de pessoas *
            </Label>
            <Select
              defaultValue="2"
              onValueChange={(v) => setValue("party_size", Number(v))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PARTY_SIZES.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n} {n === 1 ? "pessoa" : "pessoas"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {!enabledExtras.some((f) => f.key === "observacao") && (
            <div className="space-y-1">
              <Label htmlFor="notes">Observações (opcional)</Label>
              <Textarea
                id="notes"
                placeholder="Alergias, ocasião especial, preferências de mesa..."
                rows={3}
                {...register("notes")}
              />
            </div>
          )}

          {enabledExtras.map((f) => {
            const value = extras[f.key] ?? "";
            const setValue = (v: string) => setExtras((prev) => ({ ...prev, [f.key]: v }));
            const inputType = fieldInputType(f.key);
            return (
              <div key={f.key} className="space-y-1">
                <Label>
                  {f.label}
                  {f.required && <span className="text-destructive ml-1">*</span>}
                </Label>
                {f.key === "observacao" ? (
                  <Textarea
                    rows={3}
                    placeholder="Alergias, ocasião especial, preferências de mesa..."
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                  />
                ) : (
                  <Input
                    type={inputType}
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                  />
                )}
              </div>
            );
          })}

          {!enabledExtras.some((f) => f.key === "data_nascimento") && (
            <div className="space-y-1">
              <Label htmlFor="birthday">Aniversário (opcional)</Label>
              <Input
                id="birthday"
                type="date"
                max={new Date().toISOString().slice(0, 10)}
                value={extras.data_nascimento ?? ""}
                onChange={(e) => setExtras((prev) => ({ ...prev, data_nascimento: e.target.value }))}
              />
            </div>
          )}

          {sortedCustomFields.map((f) => {
            const value = customValues[f.id] ?? "";
            const setValue = (v: string) =>
              setCustomValues((prev) => ({ ...prev, [f.id]: v }));
            return (
              <div key={f.id} className="space-y-1">
                <Label>
                  {f.label}
                  {f.required && <span className="text-destructive ml-1">*</span>}
                </Label>
                {f.type === "options" ? (
                  <Select value={value} onValueChange={setValue}>
                    <SelectTrigger>
                      <SelectValue placeholder="Selecione" />
                    </SelectTrigger>
                    <SelectContent>
                      {(f.options ?? []).map((opt) => (
                        <SelectItem key={opt} value={opt}>
                          {opt}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : f.type === "file" ? (
                  <p className="text-xs text-muted-foreground border rounded-md px-3 py-2 bg-muted/30">
                    Upload de arquivo em breve.
                  </p>
                ) : (
                  <Input
                    type="text"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                  />
                )}
              </div>
            );
          })}

          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? "Criando reserva..." : "Confirmar Reserva"}
          </Button>

          <p className="text-xs text-muted-foreground text-center">
            Você receberá a confirmação via WhatsApp
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
