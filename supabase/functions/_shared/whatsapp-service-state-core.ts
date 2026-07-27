/**
 * Núcleo PURO do estado do serviço de WhatsApp de uma organização.
 *
 * POR QUE NÃO É UM BOOLEANO: `entitlements.whatsapp.allowed` é `false` tanto
 * para quem foi suspenso por não pagar quanto para quem nunca comprou a
 * instância — e as duas situações exigem tratamentos opostos. Ligar o gate de
 * envio por `!allowed` silenciaria, na hora, todo cliente que já usa WhatsApp e
 * nunca contratou. Os sete estados existem para essa distinção não se perder.
 *
 * Importa apenas outro núcleo puro (billing-financial-state-core.ts).
 */

import type { FinancialState } from "./billing-financial-state-core.ts";

export type WhatsAppServiceState =
  | "ACTIVE"
  | "GRACE_PERIOD"
  | "OVERRIDE_ACTIVE"
  | "LEGACY_GRANDFATHERED"
  | "NOT_ENTITLED"
  | "SUSPENDED_UNPAID"
  | "ADMIN_BLOCKED";

export interface WhatsAppGateInput {
  /** organizations.billing_status — coluna autoritativa. */
  systemBillingStatus: string;
  /** Estado financeiro da assinatura WHATSAPP_SUBSCRIPTION (Task 6). */
  financialState: FinancialState;
  /** Override de `whatsapp` com enabled=true, válido agora. */
  hasActiveWhatsAppOverride: boolean;
  /** Override de `whatsapp` com enabled=false, válido agora. */
  hasWhatsAppAdminBlock: boolean;
  /** `whatsapp_legacy_grandfathered AND whatsapp_grandfather_revoked_at IS NULL`. */
  isLegacyGrandfathered: boolean;
}

export interface WhatsAppGateDecision {
  state: WhatsAppServiceState;
  systemBlocked: boolean;
  sendingBlocked: boolean;
  newProvisioningBlocked: boolean;
  /** Motivo machine-readable, para log e telemetria de dry-run. */
  reason: string;
}

/**
 * Vocabulário fechado de `organizations.billing_status`. Fonte: CHECK
 * `organizations_billing_status_check` em
 * supabase/migrations/20260528000000_billing_module.sql:28-31 — os mesmos
 * nove valores documentados na seção "Banco de dados" do CLAUDE.md.
 */
export type SystemBillingStatus =
  | "active"
  | "trialing"
  | "pending_payment"
  | "past_due"
  | "grace_period"
  | "blocked"
  | "canceled"
  | "manual_override"
  | "suspended";

/**
 * Classificação EXAUSTIVA de `SystemBillingStatus` quanto a bloquear serviços
 * dependentes (WhatsApp, etc.) — `true` bloqueia. `Record` completo por
 * design, mesmo padrão de `IS_LIVE_DEBT` em billing-financial-state-core.ts:
 * um 10º valor futuro no CHECK do banco, acrescentado sem atualizar esta
 * linha, quebra `tsc -b --noEmit` em vez de cair silenciosamente em "não
 * bloqueia". Hoje só `blocked`, `suspended` e `canceled` bloqueiam —
 * `grace_period` e `past_due` são tolerância, não bloqueio.
 */
const BLOCKS_DEPENDENT_SERVICES_BY_STATUS: Record<SystemBillingStatus, boolean> = {
  active: false,
  trialing: false,
  pending_payment: false,
  past_due: false,
  grace_period: false,
  blocked: true,
  canceled: true,
  manual_override: false,
  suspended: true,
};

/**
 * Type guard derivado do MESMO Record acima (nenhuma lista paralela) — mesma
 * técnica de `isBillingInvoiceStatus` em billing-financial-state-core.ts.
 * Existe para a camada de I/O (Task 13) validar a `string` lida do banco
 * ANTES de decidir se o valor é conhecido; não é usado por este núcleo.
 */
export function isSystemBillingStatus(value: unknown): value is SystemBillingStatus {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(BLOCKS_DEPENDENT_SERVICES_BY_STATUS, value);
}

/**
 * O acesso ao sistema é gate PAI: um override de WhatsApp cobre o custo da
 * instância, não o direito de operar um sistema bloqueado.
 *
 * Lê `organizations.billing_status` DE PROPÓSITO, e não
 * `entitlements.system.allowed`: aquele campo é `false` para organização legada
 * com `billing_status='active'` e sem assinatura de sistema, o que bloquearia
 * exatamente quem nunca deveria ser bloqueado. Os três valores que bloqueiam
 * são os mesmos que o BillingGuard já trata como acesso negado no frontend e
 * que create-reservation e webhook-whatsapp já recusam no servidor.
 *
 * Assinatura mantida `(billingStatus: string): boolean` DE PROPÓSITO — é a
 * assinatura mandatada pelo plano e importada literalmente pelas Tasks 13-17,
 * não pode virar `SystemBillingStatus` sem quebrar esse contrato. Por dentro,
 * valor conhecido consulta o Record acima; valor DESCONHECIDO (um 10º status
 * que este arquivo ainda não viu) retorna `false` — falha ABERTA de
 * propósito: um status novo não pode silenciar um cliente que está pagando.
 * O ganho desta task é em compilação (o Record obriga a classificar todo
 * membro do union), não em runtime — em runtime, desconhecido sempre libera,
 * exatamente como antes desta refatoração.
 */
export function systemBlocksDependentServices(billingStatus: string): boolean {
  return isSystemBillingStatus(billingStatus) && BLOCKS_DEPENDENT_SERVICES_BY_STATUS[billingStatus];
}

/**
 * Mapeamento EXAUSTIVO de `FinancialState` para o estado do WhatsApp quando
 * há vínculo financeiro claro. `null` marca os dois casos ("CANCELED" e
 * "NO_SUBSCRIPTION") em que a resposta depende do flag de legado — resolvidos
 * fora deste mapa. `Record` completo por design, no mesmo padrão de
 * `IS_LIVE_DEBT` em billing-financial-state-core.ts: acrescentar um 6º
 * `FinancialState` sem atualizar esta linha quebra `tsc -b --noEmit`
 * (propriedade faltando) em vez de cair num default silencioso.
 */
const STATE_BY_FINANCIAL_STATE: Record<FinancialState, WhatsAppServiceState | null> = {
  PAID: "ACTIVE",
  IN_GRACE: "GRACE_PERIOD",
  OVERDUE_BEYOND_GRACE: "SUSPENDED_UNPAID",
  CANCELED: null,
  NO_SUBSCRIPTION: null,
};

/**
 * Só o estado do WhatsApp, sem o gate pai. Exportado para log e para a UI.
 *
 * Ordem de precedência, fixa: bloqueio administrativo → override → estado
 * financeiro → legado. Cada `if` abaixo é um degrau dessa escada na mesma
 * ordem — reordenar os `if`s reordena a precedência.
 */
export function resolveWhatsAppServiceState(i: WhatsAppGateInput): WhatsAppServiceState {
  if (i.hasWhatsAppAdminBlock) return "ADMIN_BLOCKED";
  if (i.hasActiveWhatsAppOverride) return "OVERRIDE_ACTIVE";

  const mapped = STATE_BY_FINANCIAL_STATE[i.financialState];
  if (mapped !== null) return mapped;

  return i.isLegacyGrandfathered ? "LEGACY_GRANDFATHERED" : "NOT_ENTITLED";
}

/**
 * Classificação EXAUSTIVA de `WhatsAppServiceState` quanto a bloquear envio já
 * existente. `Record` completo por design (mesmo padrão de `IS_LIVE_DEBT`):
 * acrescentar ou remover um estado do union sem atualizar esta linha quebra
 * `tsc -b --noEmit` — nunca um `Set` solto, que aceitaria silenciosamente um
 * estado novo como "não bloqueia".
 *
 * POLARIDADE (não confundir com o Record seguinte, forma idêntica):
 * `true` = BLOQUEIA envio.
 */
const SENDING_BLOCKED_BY_STATE: Record<WhatsAppServiceState, boolean> = {
  ACTIVE: false,
  GRACE_PERIOD: false,
  OVERRIDE_ACTIVE: false,
  LEGACY_GRANDFATHERED: false,
  NOT_ENTITLED: false,
  SUSPENDED_UNPAID: true,
  ADMIN_BLOCKED: true,
};

/**
 * Classificação EXAUSTIVA de `WhatsAppServiceState` quanto a autorizar custo
 * externo NOVO (provisionamento de instância). Mesmo raciocínio do Record
 * acima: só ACTIVE e OVERRIDE_ACTIVE liberam.
 *
 * POLARIDADE (não confundir com o Record anterior, forma idêntica):
 * `true` = LIBERA provisionamento — invertida em relação ao Record acima.
 */
const NEW_PROVISIONING_ALLOWED_BY_STATE: Record<WhatsAppServiceState, boolean> = {
  ACTIVE: true,
  GRACE_PERIOD: false,
  OVERRIDE_ACTIVE: true,
  LEGACY_GRANDFATHERED: false,
  NOT_ENTITLED: false,
  SUSPENDED_UNPAID: false,
  ADMIN_BLOCKED: false,
};

/**
 * Decisão completa. Uma função só, e não dois predicados soltos, porque o gate
 * pai precisa entrar nas DUAS respostas — deixar o caller montar a conjunção é
 * deixá-lo esquecer metade dela.
 */
export function decideWhatsAppGate(i: WhatsAppGateInput): WhatsAppGateDecision {
  const state = resolveWhatsAppServiceState(i);
  const systemBlocked = systemBlocksDependentServices(i.systemBillingStatus);

  const sendingBlocked = systemBlocked || SENDING_BLOCKED_BY_STATE[state];
  const newProvisioningBlocked = systemBlocked || !NEW_PROVISIONING_ALLOWED_BY_STATE[state];

  const reason = systemBlocked ? "system_blocked" : `whatsapp_${state.toLowerCase()}`;

  return { state, systemBlocked, sendingBlocked, newProvisioningBlocked, reason };
}
