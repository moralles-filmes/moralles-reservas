import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAnonAddToWaitlist } from "@/hooks/useWaitlist";
import { formatPhone } from "@/lib/utils";
import { CheckCircle2, Smartphone } from "lucide-react";

const schema = z.object({
  name: z.string().min(2, "Nome deve ter ao menos 2 caracteres"),
  phone: z.string().min(10, "Telefone inválido").max(15),
  party_size: z.coerce.number().min(1).max(20),
  notes: z.string().optional(),
});

type FormData = z.infer<typeof schema>;

const PARTY_SIZES = Array.from({ length: 20 }, (_, i) => i + 1);

interface WaitlistFormPublicProps {
  unitId: string;
  onClose?: () => void;
}

export function WaitlistFormPublic({ unitId, onClose }: WaitlistFormPublicProps) {
  const addToWaitlist = useAnonAddToWaitlist(unitId);
  const [confirmed, setConfirmed] = useState(false);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { party_size: 2 },
  });

  const onSubmit = async (data: FormData) => {
    await addToWaitlist.mutateAsync({
      customer_name: data.name,
      customer_phone: data.phone,
      party_size: data.party_size,
      notes: data.notes?.trim() || null,
    });
    setConfirmed(true);
  };

  if (confirmed) {
    return (
      <div className="text-center py-6 space-y-4 animate-fade-up">
        <CheckCircle2 className="h-14 w-14 text-success mx-auto" />
        <div className="space-y-1">
          <h3 className="font-display text-2xl">Você está na fila</h3>
          <p className="text-sm text-muted-foreground max-w-xs mx-auto">
            Avisaremos no seu WhatsApp assim que sua mesa estiver pronta. Pode ficar
            tranquilo aí.
          </p>
        </div>
        <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <Smartphone className="h-3.5 w-3.5" />
          Mantenha o WhatsApp por perto
        </div>
        {onClose && (
          <Button variant="outline" onClick={onClose}>
            Fechar
          </Button>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-1">
        <Label htmlFor="wl-name">Nome *</Label>
        <Input id="wl-name" placeholder="Seu nome" {...register("name")} />
        {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
      </div>

      <div className="space-y-1">
        <Label htmlFor="wl-phone">WhatsApp *</Label>
        <Input
          id="wl-phone"
          placeholder="(11) 99999-9999"
          {...register("phone")}
          onChange={(e) => {
            const v = e.target.value.replace(/\D/g, "").slice(0, 11);
            setValue("phone", v);
          }}
          value={formatPhone(watch("phone") || "")}
        />
        {errors.phone && <p className="text-xs text-destructive">{errors.phone.message}</p>}
      </div>

      <div className="space-y-1">
        <Label>Quantas pessoas? *</Label>
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
        <Label htmlFor="wl-notes">Observações (opcional)</Label>
        <Textarea
          id="wl-notes"
          placeholder="Alergias, ocasião, preferências..."
          rows={2}
          {...register("notes")}
        />
      </div>

      <Button type="submit" className="w-full" disabled={isSubmitting}>
        {isSubmitting ? "Entrando na fila..." : "Entrar na fila"}
      </Button>

      <p className="text-xs text-muted-foreground text-center">
        Avisaremos pelo WhatsApp quando a mesa estiver pronta.
      </p>
    </form>
  );
}
