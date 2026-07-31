// Import type-only cross-boundary, reexportado abaixo (`WhatsAppServiceState`)
// — mesmo padrão de `whatsapp-implementation-core.ts` (importado direto por
// `WhatsappImplementations.tsx` e testado a partir de `src/lib/*.test.ts`).
// Uma cópia divergente do union é pior que um import fora do padrão comum de
// `src/`: se um oitavo estado for acrescentado no backend e este tipo não
// acompanhar, nada quebra a compilação — a cadeia exaustiva do banner cai em
// silêncio no `return null` final, escondendo justamente o aviso que devia
// aparecer. `import type` é apagado no bundle (Vite/esbuild), então este
// arquivo nunca carrega runtime de Deno.
import type { WhatsAppServiceState } from "../../supabase/functions/_shared/whatsapp-service-state-core";
export type { WhatsAppServiceState };

export type BillingStatus =
  | "active"
  | "trialing"
  | "pending_payment"
  | "past_due"
  | "grace_period"
  | "blocked"
  | "canceled"
  | "manual_override"
  | "suspended";

export type SubscriptionStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "paused";

export type InvoiceStatus =
  | "draft"
  | "open"
  | "paid"
  | "void"
  | "uncollectible";

export type PaymentMethod = "card" | "boleto" | "pix" | "manual";

export type OverrideType = "grant_access" | "block_access" | "extend_trial";

// ─── Multi-provider (Fase 1 billing-asaas — migration 063) ───────────────────

export type PlanCategory =
  | "SYSTEM_SUBSCRIPTION"
  | "WHATSAPP_IMPLEMENTATION"
  | "WHATSAPP_SUBSCRIPTION"
  | "AI_CREDIT_PACKAGE"
  | "TRIAL"
  | "CUSTOM";

export type BillingProviderName = "stripe" | "asaas" | "manual" | "lifetime";

export type PlanBillingType = "recurring" | "one_time";

export type EntitlementFeature = "system" | "whatsapp" | "ai";

export type EntitlementGrantType = "LIFETIME" | "TEMPORARY" | "PROMOTIONAL" | "MANUAL_OVERRIDE";

export interface OrganizationEntitlementOverride {
  id: string;
  organization_id: string;
  feature: EntitlementFeature;
  enabled: boolean;
  grant_type: EntitlementGrantType;
  starts_at: string;
  ends_at: string | null;
  reason: string;
  granted_by: string;
  created_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
}

export interface BillingPlan {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  stripe_price_id_card: string | null;
  stripe_price_id_boleto: string | null;
  stripe_price_id_pix: string | null;
  amount_cents: number;
  currency: string;
  interval: "month" | "year";
  max_units: number | null;
  max_members_per_unit: number | null;
  // Migration 20260528020000 passou features pra array de strings (bullets na
  // pricing table pública). Legado pode vir como '{}' jsonb — parsePlanFeatures()
  // normaliza isso.
  features: string[] | Record<string, unknown>;
  trial_days: number;
  /**
   * @deprecated Legado. O destaque canônico é `recommended` (migration 063) —
   * é ele que a PricingCard e o painel renderizam. A coluna continua no banco
   * pra não quebrar linha antiga, mas a UI não escreve mais nela.
   */
  popular: boolean;
  // Marca o plano "trial automático" aplicado a toda nova organization criada.
  // Cliente NUNCA escolhe esse plano manualmente (PricingTable filtra).
  // Máximo 1 ativo por vez (UNIQUE PARTIAL no banco).
  is_trial: boolean;
  active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
  // Multi-provider (migration 063) — opcionais até a Fase 3 atualizar o painel;
  // manage-billing pode não devolvê-los em versões antigas deployadas.
  category?: PlanCategory;
  provider?: BillingProviderName;
  billing_type?: PlanBillingType;
  amount_credited_cents?: number | null;
  recommended?: boolean;
  requires_plan_id?: string | null;
  provider_metadata?: Record<string, unknown> | null;
  /**
   * Contagem de organizations com assinatura não-cancelada neste plano.
   * Calculada por `manage-billing` (action list_plans) — não é coluna do banco,
   * e só vem pra platform_admin. Ausente = EF antiga deployada.
   */
  active_subscriptions?: number;
}

export interface PaymentMethodSummary {
  id: string;
  brand: string | null;
  last4: string | null;
  exp_month: number | null;
  exp_year: number | null;
  is_default: boolean;
}

export interface PlanChangePreview {
  amount_due: number;
  amount_remaining: number;
  currency: string;
  period_start: string | null;
  period_end: string | null;
}

/** Normaliza features pra string[] — trata '{}' legado e qualquer outro shape como []. */
export function parsePlanFeatures(features: BillingPlan["features"] | null | undefined): string[] {
  if (!features) return [];
  if (Array.isArray(features)) return features.filter((f): f is string => typeof f === "string");
  return [];
}

export interface BillingCustomer {
  id: string;
  organization_id: string;
  stripe_customer_id: string | null;
  name: string | null;
  email: string | null;
  tax_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface BillingSubscription {
  id: string;
  organization_id: string;
  billing_customer_id: string;
  billing_plan_id: string;
  stripe_subscription_id: string | null;
  status: SubscriptionStatus;
  payment_method: PaymentMethod;
  current_period_start: string | null;
  current_period_end: string | null;
  trial_end: string | null;
  cancel_at_period_end: boolean;
  canceled_at: string | null;
  created_at: string;
  updated_at: string;
  plan?: BillingPlan | null;
  // Multi-provider (migration 063) — opcional pelo mesmo motivo do BillingPlan:
  // uma versão antiga de manage-billing pode não devolver a coluna. A UI usa
  // `provider` para não prometer fim de período onde ele não existe (Asaas).
  provider?: BillingProviderName;
}

export interface BillingInvoice {
  id: string;
  organization_id: string;
  billing_subscription_id: string | null;
  stripe_invoice_id: string | null;
  number: string | null;
  status: InvoiceStatus;
  amount_cents: number;
  currency: string;
  payment_method: PaymentMethod | null;
  hosted_invoice_url: string | null;
  invoice_pdf: string | null;
  due_date: string | null;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
  // Retenção pra revisão administrativa (migration 077, Fase 5b Task 11).
  // Opcionais: linhas antigas da EF podem não devolver ainda em deploy
  // intermediário — mesma convenção de `system_allowed` acima.
  enforcement_hold?: boolean;
  enforcement_hold_reason?: EnforcementHoldReason | null;
  enforcement_held_at?: string | null;
  enforcement_released_at?: string | null;
  enforcement_released_by?: string | null;
  ingestion_source?: string | null;
  /** Presente só quando `list_invoices` embute o join (painel da plataforma). */
  organizations?: { name: string; slug: string } | { name: string; slug: string }[] | null;
}

/** Espelha o CHECK `billing_invoices_hold_reason_chk` (migration 077). */
export type EnforcementHoldReason =
  | "INITIAL_BACKFILL"
  | "PRE_GO_LIVE_INVOICE"
  | "CORRELATION_AMBIGUITY"
  | "VALUE_MISMATCH"
  | "MANUAL_REVIEW";

export const ENFORCEMENT_HOLD_REASON_LABEL: Record<EnforcementHoldReason, string> = {
  INITIAL_BACKFILL: "Backfill inicial",
  PRE_GO_LIVE_INVOICE: "Cobrança anterior ao go-live da ingestão",
  CORRELATION_AMBIGUITY: "Ambiguidade de correlação",
  VALUE_MISMATCH: "Divergência de valor",
  MANUAL_REVIEW: "Revisão manual",
};

/** Espelha o CHECK `organizations_wa_grandfather_revoke_chk` (migration 079). */
export type WhatsappGrandfatherRevokedReason =
  | "FIRST_PAID_SUBSCRIPTION"
  | "ADMIN_MIGRATION"
  | "REPLACED_BY_OVERRIDE"
  | "ADMIN_REVOCATION";

export const WHATSAPP_GRANDFATHER_REVOKED_REASON_LABEL: Record<WhatsappGrandfatherRevokedReason, string> = {
  FIRST_PAID_SUBSCRIPTION: "Primeira assinatura paga da instância",
  ADMIN_MIGRATION: "Migrada para o modelo comercial",
  REPLACED_BY_OVERRIDE: "Substituída por override formal",
  ADMIN_REVOCATION: "Revogação administrativa",
};

export interface BillingAccessOverride {
  id: string;
  organization_id: string;
  override_type: OverrideType;
  reason: string;
  granted_by: string;
  valid_until: string | null;
  active: boolean;
  created_at: string;
}

export interface BillingNotification {
  id: string;
  organization_id: string;
  event_type: string;
  channel: string;
  recipient: string;
  status: string;
  error: string | null;
  sent_at: string;
}

export interface OrgBillingRow {
  id: string;
  name: string;
  slug: string;
  plan: string | null;
  billing_status: BillingStatus;
  billing_email: string | null;
  trial_ends_at: string | null;
  blocked_at: string | null;
  blocked_reason: string | null;
  created_at: string;
  billing_customer: BillingCustomer | null;
  subscription: (BillingSubscription & { plan: BillingPlan | null }) | null;
}

/**
 * Resposta de `manage-billing` action `get_organization_billing`, que tem DUAS
 * formas: platform_admin recebe tudo; owner/gerente recebe uma versão moldada,
 * porque o payload admin agrega histórico administrativo SOBRE o cliente.
 *
 * As chaves só-de-admin são OPCIONAIS e vêm OMITIDAS (não vazias) pro cliente:
 * `[]` afirmaria "esta organização não tem fatura nenhuma", e alguém montaria
 * "Suas faturas" em cima disso mostrando lista vazia pra quem tem fatura
 * vencida. `undefined` obriga a decidir. Quando alguma tela de cliente precisar
 * de uma dessas listas, o certo é moldá-la no servidor — nunca devolver `*`.
 */
export interface OrgBillingDetail {
  /** Pro cliente vêm só `id`, `name`, `billing_status` e `trial_ends_at`. */
  organization: {
    id: string;
    name: string;
    slug?: string;
    plan?: string | null;
    billing_status: BillingStatus;
    billing_email?: string | null;
    trial_ends_at: string | null;
    blocked_at?: string | null;
    blocked_reason?: string | null;
  };
  /** Sempre presente. Pro cliente, sem os ids do provedor. */
  subscriptions: BillingSubscription[];
  active_plan: BillingPlan | null;
  customer?: BillingCustomer | null;
  invoices?: BillingInvoice[];
  overrides?: BillingAccessOverride[];
  notifications?: BillingNotification[];
  units_count?: number | null;
}

export const BILLING_STATUS_LABEL: Record<BillingStatus, string> = {
  active: "Ativo",
  trialing: "Trial",
  pending_payment: "Aguardando pgto",
  past_due: "Vencido",
  grace_period: "Carência",
  blocked: "Bloqueado",
  canceled: "Cancelado",
  manual_override: "Override manual",
  suspended: "Suspenso",
};

export const BILLING_STATUS_VARIANT: Record<BillingStatus, string> = {
  active: "bg-success/10 text-success",
  trialing: "bg-info/10 text-info",
  pending_payment: "bg-warning/10 text-warning",
  past_due: "bg-warning/10 text-warning",
  grace_period: "bg-warning/10 text-warning",
  blocked: "bg-destructive/10 text-destructive",
  canceled: "bg-muted text-muted-foreground",
  manual_override: "bg-info/10 text-info",
  suspended: "bg-destructive/10 text-destructive",
};

export const PLAN_CATEGORY_LABEL: Record<PlanCategory, string> = {
  SYSTEM_SUBSCRIPTION: "Sistema",
  WHATSAPP_IMPLEMENTATION: "Implantação WhatsApp",
  WHATSAPP_SUBSCRIPTION: "Instância WhatsApp",
  AI_CREDIT_PACKAGE: "Crédito de IA",
  TRIAL: "Trial",
  CUSTOM: "Personalizado",
};

export const PLAN_CATEGORY_VARIANT: Record<PlanCategory, string> = {
  SYSTEM_SUBSCRIPTION: "bg-info/10 text-info",
  WHATSAPP_IMPLEMENTATION: "bg-success/10 text-success",
  WHATSAPP_SUBSCRIPTION: "bg-success/10 text-success",
  AI_CREDIT_PACKAGE: "bg-warning/10 text-warning",
  TRIAL: "bg-warning/10 text-warning",
  CUSTOM: "bg-muted text-muted-foreground",
};

export const BILLING_PROVIDER_LABEL: Record<BillingProviderName, string> = {
  stripe: "Stripe",
  asaas: "Asaas",
  manual: "Manual",
  lifetime: "Vitalício",
};

export const PLAN_BILLING_TYPE_LABEL: Record<PlanBillingType, string> = {
  recurring: "Recorrente",
  one_time: "Cobrança única",
};

export const INVOICE_STATUS_LABEL: Record<InvoiceStatus, string> = {
  draft: "Rascunho",
  open: "Aberta",
  paid: "Paga",
  void: "Anulada",
  uncollectible: "Incobrável",
};

export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  card: "Cartão",
  boleto: "Boleto",
  pix: "PIX",
  manual: "Manual",
};

export function formatCentsBRL(cents: number): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);
}

// ─── Implantação do WhatsApp (Fase 5a) ───────────────────────────────────────

export type ImplementationOrigin =
  | "ASAAS" | "EXTERNAL_PAYMENT" | "COURTESY" | "ADMIN_OVERRIDE";

export type ImplementationPaymentStatus =
  | "PENDING" | "CONFIRMED" | "WAIVED" | "REFUNDED" | "CHARGEBACK" | "CANCELED";

export type ImplementationOperationalStatus =
  | "NOT_STARTED" | "SCHEDULED" | "IN_PROGRESS" | "WAITING_CUSTOMER" | "COMPLETED" | "CANCELED";

export type ClientImplementationState =
  | "NOT_REQUESTED" | "AWAITING_PAYMENT" | "PAID_NOT_STARTED"
  | "IN_PROGRESS" | "WAITING_CUSTOMER" | "COMPLETED" | "CANCELED";

// `WhatsAppServiceState` importado no topo do arquivo (cross-boundary) e
// reexportado aqui — ver o comentário junto ao import.

export interface WhatsappServiceStatus {
  /**
   * Task 20. A UI (WhatsappServiceBanner) escolhe o banner por ESTE campo —
   * nunca por `sendingBlocked`, que é a consequência gateada pela flag
   * `whatsapp_service_enforcement` (nasce OFF; um banner keyado nela nunca
   * apareceria).
   *
   * OPCIONAL de propósito, mesma convenção de `system_allowed` abaixo: o
   * frontend sobe pela Vercel automaticamente enquanto a Edge Function é
   * implantada à mão (`supabase functions deploy`) — na janela entre os dois
   * deploys a resposta chega SEM este campo. `WhatsappServiceBanner` trata
   * ausência como "não renderizar nada", nunca como um estado específico.
   */
  serviceState?: WhatsAppServiceState;
  /** Consequência REAL sobre o envio agora, já considerando a flag de
   *  enforcement — diagnóstico, não usado pra decidir o banner. Opcional pelo
   *  mesmo motivo de `serviceState`. */
  sendingBlocked?: boolean;
  /** `due_date` da fatura mais antiga em aberto + dias de carência. `null`
   *  fora de GRACE_PERIOD/SUSPENDED_UNPAID. Opcional pelo mesmo motivo de
   *  `serviceState`. */
  graceEndsAt?: string | null;
  /** `billing_subscriptions.suspended_at` — coluna real, escrita só pelo
   *  worker de enforcement. Pode ser `null` mesmo em SUSPENDED_UNPAID
   *  enquanto a flag estiver OFF; a UI cai pra `graceEndsAt` nesse caso.
   *  Opcional pelo mesmo motivo de `serviceState`. */
  suspendedAt?: string | null;
  implementation: {
    state: ClientImplementationState;
    payment_status: ImplementationPaymentStatus | null;
    operational_status: ImplementationOperationalStatus | null;
    amount_cents: number | null;
    paid_at: string | null;
    scheduled_for: string | null;
    started_at: string | null;
    completed_at: string | null;
    next_step: string;
  };
  subscription: { has_instance: boolean; status: string | null; next_due: string | null };
  override: { active: boolean; grant_type: string | null; ends_at: string | null };
  costs: {
    currentMonthlyCents: number;
    projectedMonthlyCents: number;
    oneTimeDueCents: number;
    aiVariable: true;
  };
  /**
   * `true` quando `manage-whatsapp-implementations` não conseguiu ler o
   * catálogo de planos: os 3 preços caem para `null` e `summarizeMonthlyCosts`
   * colapsa `null` em 0 — indistinguível do zero legítimo de cortesia. A UI
   * NUNCA renderiza os valores de `costs` como R$ 0,00 quando este campo vem
   * `true`; renderiza "—" (mesma convenção de `KpiCard.formatValue`). Quem
   * garante isso é o helper `money()` dentro de `ResumoCustos`, em
   * `src/components/gestao/AutomacaoWhatsappCard.tsx`.
   */
  prices_unavailable: boolean;
  flags: { implementation_flow: boolean; subscription_checkout: boolean };
  has_system_subscription: boolean;
  /**
   * Espelha `entitlements.system.allowed` (Rodada de correção 1, I2) — usado
   * SÓ para o gate do CTA "Contratar instância" replicar
   * `canContractInstance`/`create-billing-checkout/eligibility.ts` do
   * servidor (que recusa com 409 se o sistema não estiver liberado).
   * `has_system_subscription` não serve pra isso: cortesia de sistema tem
   * `system_allowed=true` e `has_system_subscription=false`. Nenhum outro
   * campo do objeto `entitlements` é exposto — só este booleano.
   *
   * OPCIONAL de propósito: o campo nasceu depois da EF já estar no ar, e o
   * frontend sobe pela Vercel automaticamente enquanto a Edge Function é
   * implantada à mão. Na janela entre os dois deploys a resposta chega SEM
   * ele. Quem consumir compara com `?? false` — nunca `=== false`, que
   * trataria o ausente como "liberado".
   */
  system_allowed?: boolean;
}

/**
 * Rótulos de UI dos grant types. Mapa ÚNICO, deliberadamente separado dos
 * valores do banco: o CHECK da migration 062 não é ampliado só para criar
 * sinônimos ("cortesia" é como se fala de PROMOTIONAL, não um valor novo).
 */
export const ENTITLEMENT_GRANT_TYPE_LABEL: Record<EntitlementGrantType, string> = {
  LIFETIME: "Acesso vitalício",
  TEMPORARY: "Acesso temporário",
  PROMOTIONAL: "Cortesia",
  MANUAL_OVERRIDE: "Override administrativo",
};

export const IMPLEMENTATION_ORIGIN_LABEL: Record<ImplementationOrigin, string> = {
  ASAAS: "Cobrança Asaas",
  EXTERNAL_PAYMENT: "Pagamento externo",
  COURTESY: "Cortesia",
  ADMIN_OVERRIDE: "Override administrativo",
};

export const IMPLEMENTATION_PAYMENT_LABEL: Record<ImplementationPaymentStatus, string> = {
  PENDING: "Aguardando pagamento",
  CONFIRMED: "Pago",
  WAIVED: "Sem cobrança",
  REFUNDED: "Estornado",
  CHARGEBACK: "Chargeback",
  CANCELED: "Cancelado",
};

export const IMPLEMENTATION_OPERATIONAL_LABEL: Record<ImplementationOperationalStatus, string> = {
  NOT_STARTED: "Não iniciada",
  SCHEDULED: "Agendada",
  IN_PROGRESS: "Em andamento",
  WAITING_CUSTOMER: "Aguardando cliente",
  COMPLETED: "Concluída",
  CANCELED: "Cancelada",
};
