/**
 * State machine + integração de submit do wizard de reserva.
 *
 * O ReservaWizard cria essa instância e disponibiliza via WizardContext.
 * Cada step consome com `useReservaWizardContext()`.
 */

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { z } from "zod";
import { toast } from "sonner";
import { useCreateReserva } from "@/hooks/useReservas";
import type {
  PublicBlockedDate,
  PublicCustomField,
  PublicHall,
  PublicSpecialDate,
  Reserva,
  WidgetFieldConfigMap,
  WidgetFieldKey,
} from "@/types/reserva";
import {
  FALLBACK_TIME_SLOTS,
  getSlotsForDate,
  getUnavailableDateInfo,
  partitionHalls,
  type PartitionedHalls,
  type TimeSlot,
  type UnavailableDate,
} from "./availability-helpers";

export type WizardStep = 1 | 2 | 3 | "success";

export interface WizardState {
  step: WizardStep;
  // Step 1
  date: string;
  time: string;
  party_size: number;
  // Step 2
  hall_id: string;
  // Step 3
  name: string;
  email: string;
  phone: string;
  birthday: string;
  notes: string;
  extras: Partial<Record<WidgetFieldKey, string>>;
  custom_values: Record<string, string>;
  // Success
  confirmed: Reserva | null;
}

const INITIAL_STATE: WizardState = {
  step: 1,
  date: "",
  time: "",
  party_size: 2,
  hall_id: "",
  name: "",
  email: "",
  phone: "",
  birthday: "",
  notes: "",
  extras: {},
  custom_values: {},
  confirmed: null,
};

// ─── Zod schemas por step ──────────────────────────────────────────────────

export const step1Schema = z.object({
  party_size: z.number().int().min(1).max(50),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Selecione uma data válida"),
  time: z.string().regex(/^\d{2}:\d{2}$/, "Selecione um horário"),
});

export const step3Schema = z.object({
  name: z.string().trim().min(2, "Informe seu nome completo"),
  email: z.string().trim().email("E-mail inválido"),
  phone: z
    .string()
    .transform((v) => v.replace(/\D/g, ""))
    .pipe(z.string().min(10, "Telefone inválido").max(11, "Telefone inválido")),
  birthday: z.string().optional(),
  notes: z.string().optional(),
});

// ─── Context ───────────────────────────────────────────────────────────────

interface WizardInput {
  halls: PublicHall[];
  customFields: PublicCustomField[];
  widgetConfig: WidgetFieldConfigMap | undefined;
  widgetId: string | undefined;
  unit: { id: string; name: string; organization_id: string } | null;
  bookingWindowDays: number | undefined;
  /** Datas com bloqueio macro global (table_blocks com hall_id IS NULL e
   *  table_id IS NULL). O step 1 bloqueia a navegação quando o cliente escolhe
   *  uma dessas datas. */
  blockedDates?: PublicBlockedDate[];
  /** Special dates da unit — `is_closed=true` com `hall_id` null também trava
   *  o dia. Mesma lógica do availability.ts (cliente nunca passa do step 1). */
  specialDates?: PublicSpecialDate[];
  /** Conteúdo das regras/condições (do unit_settings) — exibido no step 3. */
  rulesAndConditions?: string;
  /** Info adicional — exibida no step 3. */
  additionalInfo?: string;
  /** Instruções específicas do widget (só no /w/:slug). */
  widgetInstructions?: string;
  /** Disparado depois de criar a reserva (ex: toast personalizado). */
  onSuccess?: (reserva: Reserva) => void;
}

export interface WizardComputed {
  /** Slots disponíveis no dia escolhido (UNION dos halls). */
  timeSlots: TimeSlot[];
  /** Halls particionados em compatible/alternative/closed. */
  partition: PartitionedHalls;
  /** Sortidos por sort_order. */
  customFieldsSorted: PublicCustomField[];
  /** Extras (widget) ordenados conforme FIELD_ORDER. */
  enabledExtras: Array<{ key: WidgetFieldKey; label: string; required: boolean }>;
  /** Se a data atual está totalmente bloqueada (bloqueio macro ou special_date
   *  fechado cobrindo a unit inteira). Não-null = step 1 inválido. */
  unavailableDate: UnavailableDate | null;
}

export interface WizardActions {
  set: <K extends keyof WizardState>(key: K, value: WizardState[K]) => void;
  setExtra: (key: WidgetFieldKey, value: string) => void;
  setCustomValue: (id: string, value: string) => void;
  goToStep: (step: WizardStep) => void;
  goNext: () => void;
  goBack: () => void;
  reset: () => void;
  submit: () => Promise<void>;
}

export interface WizardContextValue {
  state: WizardState;
  input: WizardInput;
  computed: WizardComputed;
  actions: WizardActions;
  isSubmitting: boolean;
}

const WizardContext = createContext<WizardContextValue | null>(null);

export function useReservaWizardContext(): WizardContextValue {
  const ctx = useContext(WizardContext);
  if (!ctx) throw new Error("useReservaWizardContext deve ser usado dentro de WizardContext.Provider");
  return ctx;
}

export { WizardContext };

// ─── Widget extras: ordem + labels default ─────────────────────────────────

const EXTRA_LABELS: Record<WidgetFieldKey, string> = {
  experiencia: "Experiência",
  estado: "Estado",
  ocasiao: "Ocasião",
  data_nascimento: "Data de nascimento",
  cpf: "CPF",
  cep: "CEP",
  codigo_promocional: "Código promocional",
  observacao: "Observação",
};

const EXTRA_ORDER: WidgetFieldKey[] = [
  "ocasiao",
  "data_nascimento",
  "cpf",
  "cep",
  "experiencia",
  "estado",
  "codigo_promocional",
  "observacao",
];

// ─── Hook principal ────────────────────────────────────────────────────────

export function useReservaWizard(input: WizardInput): WizardContextValue {
  const createReserva = useCreateReserva();
  const [state, setState] = useState<WizardState>(INITIAL_STATE);

  const set = useCallback(<K extends keyof WizardState>(key: K, value: WizardState[K]) => {
    setState((prev) => ({ ...prev, [key]: value }));
  }, []);

  const setExtra = useCallback((key: WidgetFieldKey, value: string) => {
    setState((prev) => ({ ...prev, extras: { ...prev.extras, [key]: value } }));
  }, []);

  const setCustomValue = useCallback((id: string, value: string) => {
    setState((prev) => ({ ...prev, custom_values: { ...prev.custom_values, [id]: value } }));
  }, []);

  const goToStep = useCallback((step: WizardStep) => {
    setState((prev) => ({ ...prev, step }));
  }, []);

  const reset = useCallback(() => {
    setState(INITIAL_STATE);
  }, []);

  // ─── Computed ────────────────────────────────────────────────────────────

  const computed = useMemo<WizardComputed>(() => {
    const timeSlots = state.date
      ? getSlotsForDate(input.halls, state.date)
      : FALLBACK_TIME_SLOTS;

    const partition = state.date && state.time && state.party_size
      ? partitionHalls(input.halls, state.date, state.time, state.party_size)
      : { compatible: input.halls, alternative: [], closed: [] };

    const customFieldsSorted = [...input.customFields].sort(
      (a, b) => a.sort_order - b.sort_order,
    );

    const widgetConfig = input.widgetConfig;
    const enabledExtras = EXTRA_ORDER
      .filter((key) => widgetConfig?.[key]?.enabled === true)
      .map((key) => ({
        key,
        label: widgetConfig?.[key]?.label?.trim() || EXTRA_LABELS[key],
        required: widgetConfig?.[key]?.required === true,
      }));

    const unavailableDate = getUnavailableDateInfo(
      state.date,
      input.blockedDates,
      input.specialDates,
    );

    return { timeSlots, partition, customFieldsSorted, enabledExtras, unavailableDate };
  }, [state.date, state.time, state.party_size, input.halls, input.customFields, input.widgetConfig, input.blockedDates, input.specialDates]);

  // ─── Validação por step ──────────────────────────────────────────────────

  const validateStep1 = useCallback((): boolean => {
    const result = step1Schema.safeParse({
      party_size: state.party_size,
      date: state.date,
      time: state.time,
    });
    if (!result.success) {
      const first = result.error.issues[0];
      toast.error(first?.message ?? "Preencha os campos do passo atual");
      return false;
    }
    // Bloqueio macro / special_date fechado cobrindo a unit inteira: trava o
    // step 1 com mensagem específica. Sem isso, o cliente preenche tudo e só
    // leva erro genérico no submit via create-reservation → reserveSlot.
    const unavailable = getUnavailableDateInfo(state.date, input.blockedDates, input.specialDates);
    if (unavailable) {
      toast.error(unavailable.message);
      return false;
    }
    return true;
  }, [state.party_size, state.date, state.time, input.blockedDates, input.specialDates]);

  const validateStep2 = useCallback((): boolean => {
    // Se há halls compatíveis, exige seleção. Se não há nenhum hall (legacy), pula.
    if (input.halls.length === 0) return true;
    if (computed.partition.compatible.length === 0) {
      toast.error("Nenhum ambiente disponível pra esse horário. Volte e ajuste.");
      return false;
    }
    if (!state.hall_id) {
      toast.error("Selecione um ambiente.");
      return false;
    }
    // Garante que o hall escolhido está entre os compatíveis (pode ter ficado stale)
    const ok = computed.partition.compatible.some((h) => h.id === state.hall_id);
    if (!ok) {
      toast.error("O ambiente escolhido não está mais disponível. Selecione outro.");
      return false;
    }
    return true;
  }, [input.halls.length, computed.partition.compatible, state.hall_id]);

  const validateStep3Required = useCallback((): boolean => {
    const result = step3Schema.safeParse({
      name: state.name,
      email: state.email,
      phone: state.phone,
      birthday: state.birthday,
      notes: state.notes,
    });
    if (!result.success) {
      const first = result.error.issues[0];
      toast.error(first?.message ?? "Preencha os campos obrigatórios");
      return false;
    }
    // Widget extras obrigatórios
    for (const f of computed.enabledExtras) {
      if (f.required && !(state.extras[f.key] ?? "").trim()) {
        toast.error(`Preencha: ${f.label}`);
        return false;
      }
    }
    // Custom fields obrigatórios
    for (const f of computed.customFieldsSorted) {
      if (f.required && !(state.custom_values[f.id] ?? "").trim()) {
        toast.error(`Preencha: ${f.label}`);
        return false;
      }
    }
    return true;
  }, [
    state.name, state.email, state.phone, state.birthday, state.notes,
    state.extras, state.custom_values,
    computed.enabledExtras, computed.customFieldsSorted,
  ]);

  // ─── Transições ──────────────────────────────────────────────────────────

  const goNext = useCallback(() => {
    if (state.step === 1) {
      if (!validateStep1()) return;
      // Se só 1 hall compatível, auto-seleciona pra simplificar
      const compat = state.date && state.time
        ? partitionHalls(input.halls, state.date, state.time, state.party_size).compatible
        : [];
      const nextHallId = compat.length === 1 ? compat[0].id : state.hall_id;
      setState((prev) => ({ ...prev, hall_id: nextHallId, step: 2 }));
      return;
    }
    if (state.step === 2) {
      if (!validateStep2()) return;
      setState((prev) => ({ ...prev, step: 3 }));
      return;
    }
  }, [state.step, state.date, state.time, state.party_size, state.hall_id, input.halls, validateStep1, validateStep2]);

  const goBack = useCallback(() => {
    if (state.step === 2) goToStep(1);
    else if (state.step === 3) goToStep(2);
    else if (state.step === "success") reset();
  }, [state.step, goToStep, reset]);

  // ─── Submit ──────────────────────────────────────────────────────────────

  const submit = useCallback(async () => {
    if (!input.unit) {
      toast.error("Restaurante não identificado. Recarregue a página.");
      return;
    }
    if (!validateStep3Required()) return;

    // Birthday: prioriza widget extra data_nascimento (se enabled), senão default field
    const widgetBirthday = computed.enabledExtras.some((f) => f.key === "data_nascimento")
      ? (state.extras.data_nascimento ?? "").trim()
      : state.birthday.trim();
    const birthday = widgetBirthday || null;

    // Notes: prioriza widget extra observacao (se enabled), senão default field
    const observacaoExtra = computed.enabledExtras.some((f) => f.key === "observacao")
      ? (state.extras.observacao ?? "").trim()
      : "";
    const baseNotes = (observacaoExtra || state.notes || "").trim();

    // Outros extras viram linhas em notes (preserva dados sem mudar schema)
    const extraLines = computed.enabledExtras
      .filter((f) => f.key !== "data_nascimento" && f.key !== "observacao")
      .map((f) => {
        const v = (state.extras[f.key] ?? "").trim();
        return v ? `${f.label}: ${v}` : "";
      })
      .filter(Boolean);
    const combinedNotes = [baseNotes, extraLines.join("\n")].filter(Boolean).join("\n\n") || undefined;

    // Custom field values
    const customPayload: Record<string, string> = {};
    for (const f of computed.customFieldsSorted) {
      const v = (state.custom_values[f.id] ?? "").trim();
      if (v) customPayload[f.id] = v;
    }

    try {
      const reserva = await createReserva.mutateAsync({
        name: state.name.trim(),
        email: state.email.trim(),
        phone: state.phone.replace(/\D/g, ""),
        date: state.date,
        time: state.time,
        party_size: state.party_size,
        notes: combinedNotes,
        unit_id: input.unit.id,
        organization_id: input.unit.organization_id,
        hall_id: state.hall_id || null,
        widget_id: input.widgetId,
        custom_field_values: Object.keys(customPayload).length ? customPayload : undefined,
        birthday,
      });
      setState((prev) => ({ ...prev, confirmed: reserva, step: "success" }));
      input.onSuccess?.(reserva);
      toast.success("Reserva criada! Você receberá a confirmação no WhatsApp.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erro ao criar reserva. Tente novamente.";
      toast.error(msg);
    }
  }, [
    input, state, computed.enabledExtras, computed.customFieldsSorted,
    validateStep3Required, createReserva,
  ]);

  const actions = useMemo<WizardActions>(
    () => ({ set, setExtra, setCustomValue, goToStep, goNext, goBack, reset, submit }),
    [set, setExtra, setCustomValue, goToStep, goNext, goBack, reset, submit],
  );

  return {
    state,
    input,
    computed,
    actions,
    isSubmitting: createReserva.isPending,
  };
}
