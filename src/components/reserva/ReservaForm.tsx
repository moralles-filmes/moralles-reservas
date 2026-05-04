import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useState } from "react";
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
import type { Reserva } from "@/types/reserva";
import { formatDateBR, formatPhone } from "@/lib/utils";
import { CalendarIcon, CheckCircle, Users } from "lucide-react";

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
  while (current < end) {
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

interface ReservaFormProps {
  onSuccess?: (reserva: Reserva) => void;
  unit?: UnitContext;
}

export function ReservaForm({ onSuccess, unit }: ReservaFormProps) {
  const createReserva = useCreateReserva();

  // Load default unit if none provided (backwards compat for Index page)
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

  const { data: businessHours } = useQuery({
    queryKey: ["business_hours", effectiveUnit?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("business_hours")
        .select("day_of_week, open_time, close_time, is_closed")
        .eq("unit_id", effectiveUnit!.id)
        .order("day_of_week");
      if (error) throw error;
      return data as Array<{ day_of_week: number; open_time: string; close_time: string; is_closed: boolean }>;
    },
    enabled: !!effectiveUnit?.id,
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

  const onSubmit = async (data: FormData) => {
    try {
      const reserva = await createReserva.mutateAsync({
        ...data,
        unit_id: effectiveUnit?.id ?? "",
        organization_id: effectiveUnit?.organization_id ?? "",
      });
      setConfirmed(reserva);
      reset();
      onSuccess?.(reserva);
      toast.success("Reserva criada! Você receberá a confirmação no WhatsApp.");
    } catch (err: any) {
      toast.error(err?.message || "Erro ao criar reserva. Tente novamente.");
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
                {...register("date")}
              />
              {errors.date && (
                <p className="text-xs text-destructive">{errors.date.message}</p>
              )}
            </div>

            <div className="space-y-1">
              <Label>Horário *</Label>
              {(() => {
                const selectedDate = watch("date");
                let timeSlots = FALLBACK_TIME_SLOTS;
                let isClosed = false;
                if (businessHours && selectedDate) {
                  // JS getDay(): 0=Sunday … 6=Saturday; same convention as DB
                  const dow = new Date(`${selectedDate}T12:00:00`).getDay();
                  const entry = businessHours.find((bh) => bh.day_of_week === dow);
                  if (entry) {
                    if (entry.is_closed) {
                      isClosed = true;
                      timeSlots = [];
                    } else {
                      timeSlots = generateTimeSlots(entry.open_time, entry.close_time);
                    }
                  }
                }
                if (isClosed) {
                  return (
                    <p className="text-xs text-muted-foreground border rounded-md px-3 py-2">
                      Restaurante fechado neste dia
                    </p>
                  );
                }
                return (
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
                );
              })()}
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

          <div className="space-y-1">
            <Label htmlFor="notes">Observações (opcional)</Label>
            <Textarea
              id="notes"
              placeholder="Alergias, ocasião especial, preferências de mesa..."
              rows={3}
              {...register("notes")}
            />
          </div>

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
