import { CreditCard } from "lucide-react";
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
import { formatPhone, todayLocalISO } from "@/lib/utils";
import { useReservaWizardContext } from "./useReservaWizard";
import { WizardSummary } from "./WizardSummary";
import type { WidgetFieldKey } from "@/types/reserva";

/**
 * Passo 3 — Dados pessoais + resumo + regras/condições.
 *
 * E-mail é obrigatório (mudança de regra desta versão).
 * Aniversário e Observação aparecem por default a menos que o widget
 * tenha overrides desses campos (que terão prioridade).
 */
export function StepGuestInfo() {
  const { state, input, computed, actions } = useReservaWizardContext();

  const hasWidgetBirthday = computed.enabledExtras.some((f) => f.key === "data_nascimento");
  const hasWidgetObservacao = computed.enabledExtras.some((f) => f.key === "observacao");

  const otherExtras = computed.enabledExtras.filter(
    (f) => f.key !== "data_nascimento" && f.key !== "observacao",
  );

  const todayISO = todayLocalISO();

  return (
    <div className="space-y-5">
      <WizardSummary includeHall />

      {computed.chargeInfo && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 flex items-start gap-2.5 text-sm text-amber-900">
          <CreditCard className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <p className="font-medium">
              Caução de R$ {(computed.chargeInfo.amountCents / 100).toFixed(2).replace(".", ",")}
            </p>
            <p className="text-xs text-amber-800 mt-0.5">
              Após confirmar seus dados, você será redirecionado para o pagamento seguro via Stripe.
            </p>
          </div>
        </div>
      )}

      <div className="space-y-4">
        <h3 className="text-sm font-semibold text-foreground">Seus dados</h3>

        <Field id="wizard-name" label="Nome Completo" required>
          <Input
            id="wizard-name"
            type="text"
            autoComplete="name"
            placeholder="Seu nome"
            value={state.name}
            onChange={(e) => actions.set("name", e.target.value)}
            className="h-12 sm:h-11 text-base"
          />
        </Field>

        <Field id="wizard-email" label="E-mail" required>
          <Input
            id="wizard-email"
            type="email"
            autoComplete="email"
            inputMode="email"
            placeholder="seu@email.com"
            value={state.email}
            onChange={(e) => actions.set("email", e.target.value)}
            className="h-12 sm:h-11 text-base"
          />
        </Field>

        <Field id="wizard-phone" label="Celular" required>
          <Input
            id="wizard-phone"
            type="tel"
            autoComplete="tel"
            inputMode="tel"
            placeholder="(11) 99999-9999"
            value={formatPhone(state.phone)}
            onChange={(e) => {
              const digits = e.target.value.replace(/\D/g, "").slice(0, 11);
              actions.set("phone", digits);
            }}
            className="h-12 sm:h-11 text-base"
          />
        </Field>

        {/* Birthday: default OU widget override (não os dois) */}
        {hasWidgetBirthday ? (
          <Field id="wizard-extra-birthday" label={extraLabel(computed.enabledExtras, "data_nascimento")} required={extraRequired(computed.enabledExtras, "data_nascimento")}>
            <Input
              id="wizard-extra-birthday"
              type="date"
              max={todayISO}
              value={state.extras.data_nascimento ?? ""}
              onChange={(e) => actions.setExtra("data_nascimento", e.target.value)}
              className="h-12 sm:h-11 text-base"
            />
          </Field>
        ) : (
          <Field id="wizard-birthday" label="Data de nascimento" hint="(opcional)">
            <Input
              id="wizard-birthday"
              type="date"
              max={todayISO}
              value={state.birthday}
              onChange={(e) => actions.set("birthday", e.target.value)}
              className="h-12 sm:h-11 text-base"
            />
          </Field>
        )}

        {/* Notes: default OU widget override */}
        {hasWidgetObservacao ? (
          <Field id="wizard-extra-obs" label={extraLabel(computed.enabledExtras, "observacao")} required={extraRequired(computed.enabledExtras, "observacao")}>
            <Textarea
              id="wizard-extra-obs"
              rows={3}
              placeholder="Alergias, ocasião especial, preferências de mesa..."
              value={state.extras.observacao ?? ""}
              onChange={(e) => actions.setExtra("observacao", e.target.value)}
              className="text-base"
            />
          </Field>
        ) : (
          <Field id="wizard-notes" label="Observação" hint="(opcional)">
            <Textarea
              id="wizard-notes"
              rows={3}
              placeholder="Alergias, ocasião especial, preferências de mesa..."
              value={state.notes}
              onChange={(e) => actions.set("notes", e.target.value)}
              className="text-base"
            />
          </Field>
        )}

        {/* Demais widget extras */}
        {otherExtras.map((f) => (
          <Field key={f.key} id={`wizard-extra-${f.key}`} label={f.label} required={f.required}>
            <Input
              id={`wizard-extra-${f.key}`}
              type="text"
              value={state.extras[f.key] ?? ""}
              onChange={(e) => actions.setExtra(f.key, e.target.value)}
              className="h-12 sm:h-11 text-base"
            />
          </Field>
        ))}

        {/* Custom fields da unit */}
        {computed.customFieldsSorted.map((f) => (
          <Field key={f.id} id={`wizard-cf-${f.id}`} label={f.label} required={f.required}>
            {f.type === "options" ? (
              <Select
                value={state.custom_values[f.id] ?? ""}
                onValueChange={(v) => actions.setCustomValue(f.id, v)}
              >
                <SelectTrigger id={`wizard-cf-${f.id}`} className="h-12 sm:h-11 text-base">
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
                id={`wizard-cf-${f.id}`}
                type="text"
                value={state.custom_values[f.id] ?? ""}
                onChange={(e) => actions.setCustomValue(f.id, e.target.value)}
                className="h-12 sm:h-11 text-base"
              />
            )}
          </Field>
        ))}
      </div>

      {/* Card "Sobre a Reserva" — regras + instruções do widget */}
      {(input.rulesAndConditions || input.additionalInfo || input.widgetInstructions) && (
        <div className="rounded-xl border bg-card p-4 space-y-3">
          <h4 className="text-sm font-semibold text-foreground">Sobre a Reserva</h4>
          {input.widgetInstructions && (
            <div className="rounded-md bg-amber-50 border border-amber-200 p-3 text-xs text-amber-900 whitespace-pre-line">
              {input.widgetInstructions}
            </div>
          )}
          {input.rulesAndConditions && (
            <div className="rounded-md bg-amber-50 border border-amber-200 p-3 text-xs text-amber-900 whitespace-pre-line">
              <strong className="block mb-1">Regras e Condições</strong>
              {input.rulesAndConditions}
            </div>
          )}
          {input.additionalInfo && (
            <div className="rounded-md bg-muted/50 border p-3 text-xs whitespace-pre-line">
              {input.additionalInfo}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Field({
  id,
  label,
  required,
  hint,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-sm">
        {label}
        {required && <span className="text-destructive ml-1">*</span>}
        {hint && <span className="text-muted-foreground ml-1.5 font-normal">{hint}</span>}
      </Label>
      {children}
    </div>
  );
}

function extraLabel(
  extras: ReturnType<typeof useReservaWizardContext>["computed"]["enabledExtras"],
  key: WidgetFieldKey,
): string {
  return extras.find((e) => e.key === key)?.label ?? key;
}

function extraRequired(
  extras: ReturnType<typeof useReservaWizardContext>["computed"]["enabledExtras"],
  key: WidgetFieldKey,
): boolean {
  return extras.find((e) => e.key === key)?.required ?? false;
}
