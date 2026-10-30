import { useEffect, useRef, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
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
import { normalizeBrPhone, validateBrPhone } from "@/lib/phone";
import type { WaitlistPriorityCategory } from "@/types/reserva";
import { Accessibility, Baby, CheckCircle2, Smartphone, UserCircle2 } from "lucide-react";

const PRIORITY_OPTIONS: Array<{
  value: WaitlistPriorityCategory;
  label: string;
}> = [
  { value: "normal", label: "Não sou prioritário" },
  { value: "senior", label: "Idoso (60+)" },
  { value: "pregnant", label: "Gestante" },
  { value: "disabled", label: "Pessoa com deficiência (PCD)" },
  { value: "other", label: "Outro caso prioritário" },
];

const schema = z.object({
  name: z.string().trim().min(2, "Nome deve ter ao menos 2 caracteres"),
  // .transform normaliza (tira 55/não-dígitos) e o validador BR barra DDD
  // inválido / celular sem o 9 — usuário pode colar "(11) 99998-8877".
  phone: z
    .string()
    .transform((v) => normalizeBrPhone(v))
    .superRefine((v, ctx) => {
      const r = validateBrPhone(v);
      if (!r.valid) ctx.addIssue({ code: z.ZodIssueCode.custom, message: r.reason ?? "Telefone inválido." });
    }),
  // .int() — Postgres rejeita decimais com 22P02 (erro confuso pro usuário).
  party_size: z.coerce.number().int().min(1).max(20),
  notes: z.string().optional(),
  priority_category: z
    .enum(["normal", "senior", "pregnant", "disabled", "other"])
    .default("normal"),
  marketing_opt_in: z.boolean().default(false),
});

type FormData = z.infer<typeof schema>;

const PARTY_SIZES = Array.from({ length: 20 }, (_, i) => i + 1);

interface WaitlistFormPublicProps {
  unitId: string;
  unitName: string;
  priorityEnabled?: boolean;
  onClose?: () => void;
}

export function WaitlistFormPublic({
  unitId,
  unitName,
  priorityEnabled = true,
  onClose,
}: WaitlistFormPublicProps) {
  const addToWaitlist = useAnonAddToWaitlist(unitId);
  const currentUnitId = useRef(unitId);
  currentUnitId.current = unitId;
  const [confirmedCode, setConfirmedCode] = useState<number | null | undefined>(
    undefined,
  );

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    control,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { party_size: 2, priority_category: "normal", marketing_opt_in: false },
  });

  useEffect(() => {
    reset({ party_size: 2, priority_category: "normal", marketing_opt_in: false });
    setConfirmedCode(undefined);
  }, [unitId, reset]);

  const onSubmit = async (data: FormData) => {
    const result = await addToWaitlist.mutateAsync({
      customer_name: data.name,
      customer_phone: data.phone,
      party_size: data.party_size,
      notes: data.notes?.trim() || null,
      priority_category: priorityEnabled ? data.priority_category : "normal",
      marketing_opt_in: data.marketing_opt_in === true,
    });
    if (currentUnitId.current === unitId) setConfirmedCode(result.code);
  };

  if (confirmedCode !== undefined) {
    return (
      <div className="surface rounded-card text-center p-5 sm:p-6 space-y-5">
        <CheckCircle2 className="h-16 w-16 text-success bg-success/10 rounded-full p-3 mx-auto" />
        <div className="space-y-3">
          <h3 className="font-display text-2xl font-semibold tracking-tight">Você está na fila</h3>
          {confirmedCode != null && (
            <div className="rounded-block bg-muted/50 p-4 space-y-1">
              <p className="text-xs text-tertiary">
                Sua senha
              </p>
              <p className="text-4xl font-semibold tracking-tight tabular">#{confirmedCode}</p>
            </div>
          )}
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
          <Button variant="outline" className="min-h-12 px-6" onClick={onClose}>
            Fechar
          </Button>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="wl-name">Nome *</Label>
        <Input id="wl-name" className="h-12 rounded-block bg-background" placeholder="Seu nome" {...register("name")} />
        {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
      </div>

      <div className="space-y-2">
        <Label htmlFor="wl-phone">WhatsApp *</Label>
        <Input
          id="wl-phone"
          className="h-12 rounded-block bg-background tabular"
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

      <div className="space-y-2">
        <Label htmlFor="wl-party-size">Quantas pessoas? *</Label>
        <Select
          value={String(watch("party_size") ?? 2)}
          onValueChange={(v) => setValue("party_size", Number(v))}
        >
          <SelectTrigger id="wl-party-size" className="h-12 rounded-block bg-background tabular">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PARTY_SIZES.map((n) => (
              <SelectItem key={n} value={String(n)} className="coarse:min-h-11 tabular">
                {n} {n === 1 ? "pessoa" : "pessoas"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {priorityEnabled && (
        <div className="space-y-2">
          <Label htmlFor="wl-priority" className="flex items-center gap-1.5">
            <Accessibility className="h-4 w-4 text-gold-ink" />
            Prioridade no atendimento
          </Label>
          <Select
            value={watch("priority_category") ?? "normal"}
            onValueChange={(v) =>
              setValue("priority_category", v as WaitlistPriorityCategory)
            }
          >
            <SelectTrigger id="wl-priority" className="h-12 rounded-block bg-background">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRIORITY_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value} className="coarse:min-h-11">
                  <span className="flex items-center gap-2">
                    {opt.value === "senior" && <UserCircle2 className="h-3.5 w-3.5" />}
                    {opt.value === "pregnant" && <Baby className="h-3.5 w-3.5" />}
                    {opt.value === "disabled" && (
                      <Accessibility className="h-3.5 w-3.5" />
                    )}
                    {opt.label}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs leading-relaxed text-tertiary">
            Atendimento prioritário conforme legislação (idosos, gestantes, PCDs).
          </p>
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="wl-notes">Observações (opcional)</Label>
        <Textarea
          id="wl-notes"
          className="min-h-24 rounded-block bg-background"
          placeholder="Alergias, ocasião, preferências..."
          rows={2}
          {...register("notes")}
        />
      </div>

      <div className="surface flex items-start gap-3 rounded-block p-4">
        <Controller
          name="marketing_opt_in"
          control={control}
          render={({ field }) => (
            <Checkbox
              id="wl-marketing-opt-in"
              checked={field.value}
              onCheckedChange={(checked) => field.onChange(checked === true)}
              className="mt-0.5 h-5 w-5 shrink-0"
            />
          )}
        />
        <Label htmlFor="wl-marketing-opt-in" className="text-sm leading-relaxed font-normal cursor-pointer">
          Quero receber ofertas e benefícios do {unitName} pelo WhatsApp. Posso cancelar quando quiser pelo link enviado em cada oferta.
        </Label>
      </div>

      <Button type="submit" className="w-full min-h-12 text-base" disabled={isSubmitting}>
        {isSubmitting ? "Entrando na fila..." : "Entrar na fila"}
      </Button>

      <p className="text-xs text-tertiary text-center">
        Avisaremos pelo WhatsApp quando a mesa estiver pronta.
      </p>
    </form>
  );
}
