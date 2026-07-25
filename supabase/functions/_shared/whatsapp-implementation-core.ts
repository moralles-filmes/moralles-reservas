/**
 * Núcleo PURO da implantação do WhatsApp (Fase 5a).
 *
 * ZERO imports — importável tanto pelas Edge Functions quanto pelo vitest a
 * partir de src/ (mesmo contrato de entitlements-core.ts e
 * billing-delinquency-core.ts). Um import de https://esm.sh/..., mesmo só de
 * tipo, quebra a resolução do Vite e derruba a suíte inteira.
 *
 * As mesmas regras existem como CHECK constraint na migration 071. A duplicação
 * é deliberada: o banco é a garantia, este módulo é a mensagem de erro decente.
 */

export type ImplementationOrigin =
  | "ASAAS"
  | "EXTERNAL_PAYMENT"
  | "COURTESY"
  | "ADMIN_OVERRIDE";

export type ImplementationPaymentStatus =
  | "PENDING"
  | "CONFIRMED"
  | "WAIVED"
  | "REFUNDED"
  | "CHARGEBACK"
  | "CANCELED";

export type ImplementationOperationalStatus =
  | "NOT_STARTED"
  | "SCHEDULED"
  | "IN_PROGRESS"
  | "WAITING_CUSTOMER"
  | "COMPLETED"
  | "CANCELED";

/**
 * Matriz origem × pagamento. Espelha whatsapp_impl_origin_payment_chk.
 *
 * Pagamento externo é CONFIRMED com valor e data reais (entra em relatório
 * financeiro); cortesia e override são WAIVED (não entram). Trocar um pelo
 * outro falsifica o faturamento nas duas direções.
 */
export const ORIGIN_PAYMENT_MATRIX: Readonly<
  Record<ImplementationOrigin, readonly ImplementationPaymentStatus[]>
> = {
  ASAAS: ["PENDING", "CONFIRMED", "REFUNDED", "CHARGEBACK", "CANCELED"],
  EXTERNAL_PAYMENT: ["CONFIRMED", "REFUNDED", "CANCELED"],
  COURTESY: ["WAIVED", "CANCELED"],
  ADMIN_OVERRIDE: ["WAIVED", "CANCELED"],
};

export function validateOriginPayment(
  origin: ImplementationOrigin,
  paymentStatus: ImplementationPaymentStatus,
): boolean {
  return (ORIGIN_PAYMENT_MATRIX[origin] ?? []).includes(paymentStatus);
}

/**
 * Pagamento "resolvido": a entrega pode ser dada como concluída, ou já foi.
 *
 * REFUNDED e CHARGEBACK estão aqui porque estorno DEPOIS da entrega não desfaz
 * o trabalho — a linha continua COMPLETED e o dinheiro é tratado como caso
 * comercial. A TRANSIÇÃO para COMPLETED é mais estrita (ver
 * canTransitionOperational): só CONFIRMED ou WAIVED autorizam concluir.
 */
export const SETTLED_PAYMENT_STATUSES: ReadonlySet<ImplementationPaymentStatus> =
  new Set(["CONFIRMED", "WAIVED", "REFUNDED", "CHARGEBACK"]);

/** Pagamento que autoriza CONCLUIR a implantação agora. */
const COMPLETABLE_PAYMENT_STATUSES: ReadonlySet<ImplementationPaymentStatus> =
  new Set(["CONFIRMED", "WAIVED"]);

/** Grafo de transições. COMPLETED e CANCELED são terminais. */
export const OPERATIONAL_TRANSITIONS: Readonly<
  Record<ImplementationOperationalStatus, readonly ImplementationOperationalStatus[]>
> = {
  NOT_STARTED: ["SCHEDULED", "IN_PROGRESS", "CANCELED"],
  SCHEDULED: ["IN_PROGRESS", "WAITING_CUSTOMER", "CANCELED"],
  IN_PROGRESS: ["WAITING_CUSTOMER", "COMPLETED", "CANCELED"],
  WAITING_CUSTOMER: ["IN_PROGRESS", "COMPLETED", "CANCELED"],
  COMPLETED: [],
  CANCELED: [],
};

export function canTransitionOperational(
  from: ImplementationOperationalStatus,
  to: ImplementationOperationalStatus,
  paymentStatus: ImplementationPaymentStatus,
): { ok: boolean; reason: string | null } {
  if (!(OPERATIONAL_TRANSITIONS[from] ?? []).includes(to)) {
    return { ok: false, reason: "invalid_transition" };
  }
  if (to === "COMPLETED" && !COMPLETABLE_PAYMENT_STATUSES.has(paymentStatus)) {
    return { ok: false, reason: "payment_not_settled" };
  }
  return { ok: true, reason: null };
}

export type InstanceBlockReason =
  | "flag_off"
  | "implementation_incomplete"
  | "system_not_allowed"
  | "already_subscribed"
  | "override_active";

export interface CanContractInstanceInput {
  flagEnabled: boolean;
  /** null = organização sem nenhuma implantação registrada. */
  implementationOperationalStatus: ImplementationOperationalStatus | null;
  systemAllowed: boolean;
  hasActiveWhatsappSubscription: boolean;
  hasActiveWhatsappOverride: boolean;
}

/**
 * Ordem das checagens importa: a razão devolvida vira mensagem para o operador,
 * e "a flag está desligada" é mais útil que "seu sistema está bloqueado" quando
 * as duas coisas são verdade.
 */
export function canContractInstance(
  i: CanContractInstanceInput,
): { ok: boolean; reason: InstanceBlockReason | null } {
  if (!i.flagEnabled) return { ok: false, reason: "flag_off" };
  if (i.implementationOperationalStatus !== "COMPLETED") {
    return { ok: false, reason: "implementation_incomplete" };
  }
  if (!i.systemAllowed) return { ok: false, reason: "system_not_allowed" };
  if (i.hasActiveWhatsappSubscription) return { ok: false, reason: "already_subscribed" };
  // Cobrar quem já tem cortesia é pior que negar a venda.
  if (i.hasActiveWhatsappOverride) return { ok: false, reason: "override_active" };
  return { ok: true, reason: null };
}

export type ClientImplementationState =
  | "NOT_REQUESTED"
  | "AWAITING_PAYMENT"
  | "PAID_NOT_STARTED"
  | "IN_PROGRESS"
  | "WAITING_CUSTOMER"
  | "COMPLETED"
  | "CANCELED";

/** Subconjunto da linha que a projeção lê. Campos internos podem vir junto —
 *  a projeção existe justamente para descartá-los. */
export interface ImplementationRowLike {
  payment_status: ImplementationPaymentStatus;
  operational_status: ImplementationOperationalStatus;
  amount_cents: number | null;
  paid_at: string | null;
  scheduled_for: string | null;
  started_at: string | null;
  completed_at: string | null;
  [key: string]: unknown;
}

export interface ClientImplementationView {
  state: ClientImplementationState;
  payment_status: ImplementationPaymentStatus | null;
  operational_status: ImplementationOperationalStatus | null;
  amount_cents: number | null;
  paid_at: string | null;
  scheduled_for: string | null;
  started_at: string | null;
  completed_at: string | null;
  /** Frase para o cliente. NUNCA promete prazo — a operação é manual. */
  next_step: string;
}

const NEXT_STEP: Record<ClientImplementationState, string> = {
  NOT_REQUESTED:
    "Contrate a implantação para ativar o atendimento automático no WhatsApp.",
  AWAITING_PAYMENT:
    "Estamos aguardando a confirmação do pagamento. Assim que ela chegar, avisamos por aqui.",
  PAID_NOT_STARTED:
    "Pagamento confirmado. Nossa equipe vai entrar em contato para combinar a configuração.",
  IN_PROGRESS: "A configuração do seu WhatsApp está em andamento.",
  WAITING_CUSTOMER: "Precisamos de uma informação sua para continuar a configuração.",
  COMPLETED: "Implantação concluída.",
  CANCELED: "Esta implantação foi cancelada. Fale com o suporte para retomar.",
};

/**
 * Projeção SEGURA para o cliente. Constrói um objeto novo campo a campo — nunca
 * spread da linha — porque a tabela carrega notas internas, motivo da cortesia,
 * referência de pagamento e responsáveis. Um `...row` aqui vazaria tudo isso no
 * primeiro campo novo que alguém adicionar.
 */
export function buildClientImplementationView(
  row: ImplementationRowLike | null,
): ClientImplementationView {
  if (!row) {
    return {
      state: "NOT_REQUESTED",
      payment_status: null,
      operational_status: null,
      amount_cents: null,
      paid_at: null,
      scheduled_for: null,
      started_at: null,
      completed_at: null,
      next_step: NEXT_STEP.NOT_REQUESTED,
    };
  }

  let state: ClientImplementationState;
  if (row.operational_status === "CANCELED" || row.payment_status === "CANCELED") {
    state = "CANCELED";
  } else if (row.operational_status === "COMPLETED") {
    state = "COMPLETED";
  } else if (row.payment_status === "PENDING") {
    state = "AWAITING_PAYMENT";
  } else if (row.operational_status === "IN_PROGRESS") {
    state = "IN_PROGRESS";
  } else if (row.operational_status === "WAITING_CUSTOMER") {
    state = "WAITING_CUSTOMER";
  } else {
    state = "PAID_NOT_STARTED";
  }

  return {
    state,
    payment_status: row.payment_status,
    operational_status: row.operational_status,
    amount_cents: row.amount_cents,
    paid_at: row.paid_at,
    scheduled_for: row.scheduled_for,
    started_at: row.started_at,
    completed_at: row.completed_at,
    next_step: NEXT_STEP[state],
  };
}

export interface MonthlyCostInput {
  systemMonthlyCents: number | null;
  instanceMonthlyCents: number | null;
  implementationOneTimeCents: number | null;
  hasActiveInstanceSubscription: boolean;
  /** Override de whatsapp ativo — a plataforma banca o custo. */
  whatsappSponsored: boolean;
  /** payment_status ∈ SETTLED_PAYMENT_STATUSES. */
  implementationSettled: boolean;
  /** Override de system ativo (cortesia vitalícia). */
  systemSponsored: boolean;
}

export interface MonthlyCostSummary {
  currentMonthlyCents: number;
  projectedMonthlyCents: number;
  oneTimeDueCents: number;
  /** O custo de IA é consumo, não assinatura — a tela mostra "variável". */
  aiVariable: true;
}

/** Os quatro números do resumo consolidado da tela de cobrança. */
export function summarizeMonthlyCosts(i: MonthlyCostInput): MonthlyCostSummary {
  const systemPart = i.systemSponsored ? 0 : (i.systemMonthlyCents ?? 0);
  const instancePrice = i.instanceMonthlyCents ?? 0;
  const instanceNow = i.hasActiveInstanceSubscription && !i.whatsappSponsored
    ? instancePrice
    : 0;

  return {
    currentMonthlyCents: systemPart + instanceNow,
    projectedMonthlyCents: systemPart + (i.whatsappSponsored ? 0 : instancePrice),
    oneTimeDueCents: i.implementationSettled ? 0 : (i.implementationOneTimeCents ?? 0),
    aiVariable: true,
  };
}
