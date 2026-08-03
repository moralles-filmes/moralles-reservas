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
  /**
   * A assinatura que FINANCIA o WhatsApp desta organização não é única e
   * inequívoca — ou porque há transição entre o modelo antigo (assinatura
   * `WHATSAPP_SUBSCRIPTION` separada) e o de dois planos (plano de sistema que
   * inclui `whatsapp`), ou porque há duplicidade inesperada na mesma
   * categoria. Vem de `resolveWhatsAppSubscription`
   * (whatsapp-subscription-resolver-core.ts).
   *
   * DELIBERADAMENTE ≠ `dataReadFailed`: aquilo é soluço técnico, isto é estado
   * comercial. Colapsar os dois faria uma transição legítima parecer banco
   * fora do ar, e o motivo da negação sairia errado na telemetria.
   *
   * NÃO afeta nenhum dos sete estados nem `sendingBlocked` — envio existente
   * falha ABERTO à ambiguidade, pelo mesmo motivo que falha aberto ao soluço
   * técnico: nenhum dos dois pode silenciar o WhatsApp de quem paga. A única
   * consequência é sobre provisionamento NOVO, em
   * `resolveProvisioningEligibility`.
   *
   * Opcional (default `false`) para que todo caller anterior a esta task siga
   * válido sem mudança.
   */
  subscriptionAmbiguous?: boolean;
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
 *
 * `subscriptionAmbiguous` NÃO entra aqui, nem como oitava chave nem como
 * modificador: envio existente falha ABERTO à ambiguidade comercial pelo mesmo
 * motivo que falha aberto ao soluço técnico. Ambiguidade só afeta
 * `resolveProvisioningEligibility`.
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

/**
 * Combina a decisão de `decideWhatsAppGate` com o resultado da leitura da
 * flag de enforcement e da leitura de dados, e devolve a CONSEQUÊNCIA
 * operacional sobre uso EXISTENTE. Roda DEPOIS de `decideWhatsAppGate` e não
 * reimplementa nada dele — a flag controla só a APLICAÇÃO da consequência,
 * nunca o estado calculado (os sete estados e as duas perguntas acima ficam
 * intocados).
 *
 * `enforced` contém SOMENTE consequências submetidas à flag
 * `whatsapp_service_enforcement` — hoje, só o envio. A elegibilidade para
 * provisionar instância NOVA não é uma dessas consequências (ela nunca
 * consulta essa flag, nem para liberar nem para bloquear) e vive em
 * `resolveProvisioningEligibility`, função separada logo abaixo.
 *
 * FAIL-OPEN é a assimetria deste eixo: uma flag ilegível ou um dado que não
 * pôde ser lido NÃO pode suspender quem já está usando o WhatsApp por causa
 * de um soluço técnico. `enforced.sending` só fica `true` quando TUDO foi
 * lido com sucesso E a flag está ligada E o estado bloqueia.
 */
export interface EnforcementInput {
  decision: WhatsAppGateDecision;
  flagEnabled: boolean;
  flagReadFailed: boolean;
  /** Alguma das leituras de ESTADO (org, overrides, assinatura, fatura) falhou. */
  dataReadFailed: boolean;
}

/**
 * `"FLAG_READ_FAILED"` é distinto de `"NONE"` de propósito: uma leitura de
 * flag que falhou NUNCA pode contar como "flag OFF" na métrica de dry-run —
 * ela inflaria `whatsapp_enforcement_dryrun`, a única métrica que sustenta a
 * decisão de ligar o enforcement, com ruído de um soluço da tabela de flags.
 */
export type EnforcementTelemetry = "NONE" | "DRY_RUN_WOULD_BLOCK_SENDING" | "FLAG_READ_FAILED";

export interface EnforcementResult {
  enforcementEnabled: boolean;
  enforced: { sending: boolean };
  telemetry: EnforcementTelemetry;
}

export function resolveEnforcement(i: EnforcementInput): EnforcementResult {
  const enforcementEnabled = i.flagEnabled && !i.flagReadFailed;
  const anyReadFailed = i.flagReadFailed || i.dataReadFailed;

  const sending = i.decision.sendingBlocked && enforcementEnabled && !anyReadFailed;

  let telemetry: EnforcementTelemetry;
  if (i.flagReadFailed) telemetry = "FLAG_READ_FAILED";
  else if (!i.flagEnabled && !anyReadFailed && i.decision.sendingBlocked) telemetry = "DRY_RUN_WOULD_BLOCK_SENDING";
  else telemetry = "NONE";

  return {
    enforcementEnabled,
    enforced: { sending },
    telemetry,
  };
}

/**
 * Motivo do bloqueio de provisionamento, para a UI/log dizerem a coisa certa —
 * "não foi possível verificar agora", "sua assinatura está em transição" e
 * "você não tem direito" são três mensagens diferentes. Precedência FIXA:
 * transitório (leitura falhou) vence comercial (assinatura ambígua), que vence
 * definitivo (estado do serviço).
 *
 * `SUBSCRIPTION_AMBIGUOUS` é separado de `STATE_READ_FAILED` de propósito: um
 * é banco fora do ar, o outro é uma organização em transição entre o modelo
 * antigo e o de dois planos — ou com duplicidade inesperada de assinatura na
 * mesma categoria. Colapsá-los mandaria o operador procurar defeito de
 * infraestrutura onde há pendência comercial.
 *
 * NÃO HÁ motivo ligado à flag de enforcement, e a ausência é o contrato: essa
 * flag governa consequência sobre uso existente, nunca autorização de despesa
 * nova. Acrescentar um `ENFORCEMENT_FLAG_*` aqui reintroduz o acoplamento que
 * esta separação existe para impedir.
 */
export type ProvisioningBlockReason =
  | "ALLOWED"
  | "STATE_READ_FAILED"
  | "SUBSCRIPTION_AMBIGUOUS"
  | "SERVICE_STATE";

export interface ProvisioningEligibilityInput {
  decision: WhatsAppGateDecision;
  /** Alguma leitura de ESTADO (org, overrides, assinatura, fatura) falhou. */
  dataReadFailed: boolean;
  /**
   * A fonte financeira do WhatsApp não é única e inequívoca — mesmo campo de
   * `WhatsAppGateInput`, repetido aqui porque esta função recebe a DECISÃO já
   * pronta, e a decisão (de propósito) não carrega a ambiguidade: ela não
   * altera nenhum dos sete estados.
   *
   * Opcional (default `false`), mantendo válidos os callers anteriores a esta
   * task.
   */
  subscriptionAmbiguous?: boolean;
  // SEM campo de flag, de propósito — ver o comentário acima.
}

export interface ProvisioningEligibility {
  allowed: boolean;
  blockReason: ProvisioningBlockReason;
}

/**
 * Elegibilidade para gerar custo externo recorrente NOVO. Proteção permanente:
 * vale com qualquer valor de `whatsapp_service_enforcement`, inclusive
 * ilegível, porque não consulta a flag.
 *
 * FAIL-CLOSED aos DOIS tipos de incerteza (leitura que falhou e assinatura
 * ambígua), e a assimetria com o envio é deliberada: autorizar despesa
 * recorrente sem conseguir confirmar a autorização é pior do que recusar e
 * pedir para tentar de novo. Envio existente faz o oposto (fail-open aos dois)
 * — nem um soluço técnico nem uma transição comercial legítima podem suspender
 * quem está pagando.
 */
export function resolveProvisioningEligibility(i: ProvisioningEligibilityInput): ProvisioningEligibility {
  if (i.dataReadFailed) return { allowed: false, blockReason: "STATE_READ_FAILED" };
  if (i.subscriptionAmbiguous) return { allowed: false, blockReason: "SUBSCRIPTION_AMBIGUOUS" };
  if (i.decision.newProvisioningBlocked) return { allowed: false, blockReason: "SERVICE_STATE" };
  return { allowed: true, blockReason: "ALLOWED" };
}

/**
 * Resposta automática a mídia (áudio/imagem/sticker) recebida: responder ou
 * silenciar, e por quê. Função pura porque `supabase/functions/` não roda em
 * CI — sem ela, os seis casos exigidos não teriam onde ser testados.
 *
 * DUAS DIMENSÕES, NÃO UMA, e é o ponto todo: o bloqueio do sistema NÃO é
 * submetido a `whatsapp_service_enforcement` (é o mesmo tratamento não-gateado
 * que o fluxo de texto já dá ao `org_billing_blocked`), enquanto a suspensão
 * do WhatsApp é. Colapsar as duas num booleano faria o dry-run responder por
 * uma organização com o sistema bloqueado.
 */
export interface InboundAutoReplyInput {
  /** `WhatsAppGateDecision.systemBlocked` — estado real, nunca gateado por flag. */
  systemBlocked: boolean;
  /** `EnforcementResult.enforced.sending` — consequência, já gateada pela flag. */
  enforcedSending: boolean;
}

export type InboundAutoReply = "REPLY" | "SILENT_SYSTEM_BLOCKED" | "SILENT_WHATSAPP_SUSPENDED";

export function decideInboundAutoReply(i: InboundAutoReplyInput): InboundAutoReply {
  if (i.systemBlocked) return "SILENT_SYSTEM_BLOCKED";
  if (i.enforcedSending) return "SILENT_WHATSAPP_SUSPENDED";
  return "REPLY";
}
