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
  popular: boolean;
  // Marca o plano "trial automático" aplicado a toda nova organization criada.
  // Cliente NUNCA escolhe esse plano manualmente (PricingTable filtra).
  // Máximo 1 ativo por vez (UNIQUE PARTIAL no banco).
  is_trial: boolean;
  active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
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
}

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

export interface OrgBillingDetail {
  organization: {
    id: string;
    name: string;
    slug: string;
    plan: string | null;
    billing_status: BillingStatus;
    billing_email: string | null;
    trial_ends_at: string | null;
    blocked_at: string | null;
    blocked_reason: string | null;
  };
  customer: BillingCustomer | null;
  subscriptions: BillingSubscription[];
  active_plan: BillingPlan | null;
  invoices: BillingInvoice[];
  overrides: BillingAccessOverride[];
  notifications: BillingNotification[];
  units_count: number | null;
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
  active: "bg-emerald-100 text-emerald-800",
  trialing: "bg-blue-100 text-blue-800",
  pending_payment: "bg-amber-100 text-amber-800",
  past_due: "bg-orange-100 text-orange-800",
  grace_period: "bg-orange-100 text-orange-800",
  blocked: "bg-red-100 text-red-800",
  canceled: "bg-gray-100 text-gray-800",
  manual_override: "bg-purple-100 text-purple-800",
  suspended: "bg-red-100 text-red-800",
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
