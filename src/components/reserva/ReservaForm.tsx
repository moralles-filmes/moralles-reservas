import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useState } from "react";
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

const TIME_SLOTS = [
  "12:00", "12:30", "13:00", "13:30", "14:00",
  "19:00", "19:30", "20:00", "20:30", "21:00", "21:30", "22:00",
];

const PARTY_SIZES = Array.from({ length: 20 }, (_, i) => i + 1);

interface ReservaFormProps {
  onSuccess?: (reserva: Reserva) => void;
}

export function ReservaForm({ onSuccess }: ReservaFormProps) {
  const createReserva = useCreateReserva();
  const [confirmed, setConfirmed] = useState<Reserva | null>(null);

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
      const reserva = await createReserva.mutateAsync(data);
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
              <Select onValueChange={(v) => setValue("time", v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Selecione" />
                </SelectTrigger>
                <SelectContent>
                  {TIME_SLOTS.map((t) => (
                    <SelectItem key={t} value={t}>{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
