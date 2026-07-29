// supabase/functions/_shared/whatsapp-service-gate.ts
/**
 * Camada de I/O do gate de serviço de WhatsApp: carrega do banco o que o núcleo
 * puro precisa e devolve a decisão já combinada com a flag de enforcement.
 *
 * A CONSEQUÊNCIA (não o estado) é quem tem a assimetria fail-open/fail-closed
 * — ver `resolveEnforcement` em `whatsapp-service-state-core.ts`, o único
 * lugar que decide `enforced`. Este arquivo só lê o banco, valida o que lê, e
 * repassa ao núcleo; não reimplementa a lógica de consequência.
 *
 * CACHE POR INVOCAÇÃO: `orgCache`/`unitToOrg` são zerados no início de cada
 * invocação pelo caller (`clearWhatsAppGateCache()`), mesmo padrão do
 * `unitCache` dos workers — sem isso, um isolate quente serviria estado velho
 * depois de o cliente pagar. Resultado com `readFailed=true` NUNCA é
 * cacheado — um soluço pontual não pode fixar o veredito de uma organização
 * pelo resto da invocação (a Task 17 varre muitas organizações numa só).
 *
 * Consumido por `whatsapp-send.ts` (Task 14) — ponto único de todo envio de
 * WhatsApp que não é do agente de IA (`send-whatsapp`, `send-confirmation`,
 * `send-cancellation`, `send-manual-message`). Caller zera o cache no início
 * de cada invocação via `clearWhatsAppGateCache()`, não este módulo.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jsonLog } from "./security.ts";
import { checkFlagEnabled } from "./platform-flags.ts";
import {
  normalizeFinancialState,
  isBillingInvoiceStatus,
  type BillingInvoiceStatus,
} from "./billing-financial-state-core.ts";
import {
  decideWhatsAppGate,
  resolveEnforcement,
  isSystemBillingStatus,
  type WhatsAppGateDecision,
  type ProvisioningBlockReason,
} from "./whatsapp-service-state-core.ts";

const WHATSAPP_CATEGORY = "WHATSAPP_SUBSCRIPTION";

export interface ServiceGateResult extends WhatsAppGateDecision {
  organizationId: string;
  enforcementEnabled: boolean;
  /** Consequência operacional — ver a assimetria fail-open/fail-closed no núcleo. */
  enforced: { sending: boolean; newProvisioning: boolean };
  /**
   * Por que `enforced.newProvisioning` está bloqueado — a UI/log usam isto
   * para dizer "não foi possível verificar agora"
   * (`ENFORCEMENT_FLAG_UNREADABLE`/`STATE_READ_FAILED`) em vez de "você não
   * tem direito" (`SERVICE_STATE`/`ENFORCEMENT_FLAG_OFF`). `"ALLOWED"` quando
   * não há bloqueio.
   */
  provisioningBlockReason: ProvisioningBlockReason;
  /**
   * true quando ALGUMA leitura falhou — dado (organizations/overrides/
   * assinatura/fatura) OU a leitura da própria flag de enforcement. NÃO há um
   * "lado seguro" único para este campo agregado: `enforced.sending` já é
   * fail-open (uma falha aqui nunca vira bloqueio de envio) e
   * `enforced.newProvisioning` já é fail-closed (uma falha aqui SEMPRE
   * bloqueia, ver `provisioningBlockReason`). Nenhum caller de bloqueio deve
   * decidir a partir deste campo — ele é só diagnóstico agregado para
   * log/observabilidade; `enforced` e `provisioningBlockReason` já carregam a
   * consequência certa para cada lado.
   */
  readFailed: boolean;
}

const orgCache = new Map<string, ServiceGateResult>();
const unitToOrg = new Map<string, string>();

export function clearWhatsAppGateCache(): void {
  orgCache.clear();
  unitToOrg.clear();
}

export async function resolveWhatsAppGateByOrg(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<ServiceGateResult> {
  const cached = orgCache.get(organizationId);
  if (cached) return cached;

  const nowIso = new Date().toISOString();

  const [orgRes, overridesRes, subRes, flagCheck] = await Promise.all([
    supabase
      .from("organizations")
      .select("billing_status, whatsapp_legacy_grandfathered, whatsapp_grandfather_revoked_at")
      .eq("id", organizationId)
      .maybeSingle(),
    supabase
      .from("organization_entitlement_overrides")
      .select("enabled, starts_at, ends_at")
      .eq("organization_id", organizationId)
      .eq("feature", "whatsapp")
      .is("revoked_at", null)
      .lte("starts_at", nowIso)
      .or(`ends_at.is.null,ends_at.gt.${nowIso}`),
    supabase
      .from("billing_subscriptions")
      .select("id, status, canceled_at, billing_plans!inner(category)")
      .eq("organization_id", organizationId)
      .eq("billing_plans.category", WHATSAPP_CATEGORY)
      .neq("status", "canceled")
      .maybeSingle(),
    checkFlagEnabled("whatsapp_service_enforcement"),
  ]);

  // `let`, não `const`: a leitura de billing_invoices (mais abaixo, condicional
  // à existência de assinatura) e a validação do status da fatura também podem
  // marcar isto depois deste bloco. Isto é a falha de DADO — a falha da FLAG
  // (`flagCheck.readFailed`) é uma dimensão separada, combinada só dentro de
  // `resolveEnforcement`.
  let dataReadFailed = !!(orgRes.error || overridesRes.error || subRes.error);
  if (dataReadFailed) {
    jsonLog("warn", {
      evt: "whatsapp_gate_read_failed",
      org: organizationId,
      orgErr: orgRes.error?.message ?? null,
      overridesErr: overridesRes.error?.message ?? null,
      subErr: subRes.error?.message ?? null,
    });
  }

  const overrides = (overridesRes.data ?? []) as { enabled: boolean }[];
  const sub = subRes.data as { id: string; status: string; canceled_at: string | null } | null;

  // Fatura em aberto mais antiga da assinatura, JÁ EXCLUINDO as retidas —
  // fatura em revisão administrativa não conta como atraso, por definição.
  let oldestOpenInvoice: { dueDate: string; status: BillingInvoiceStatus } | null = null;
  if (sub) {
    const { data: inv, error: invErr } = await supabase
      .from("billing_invoices")
      .select("due_date, status")
      .eq("billing_subscription_id", sub.id)
      .eq("status", "open")
      .eq("enforcement_hold", false)
      .not("due_date", "is", null)
      .order("due_date", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (invErr) {
      // Mesma direção de erro do resto do helper: uma leitura que falha aqui
      // não pode inventar uma fatura vencida — ela só pode DEIXAR de enxergar
      // uma real. O tratamento dessa incerteza (fail-open no envio, fail-closed
      // no provisionamento) é do núcleo, não daqui.
      dataReadFailed = true;
      jsonLog("warn", {
        evt: "whatsapp_gate_read_failed",
        org: organizationId,
        invoiceErr: invErr.message,
      });
    } else if (inv?.due_date) {
      // O CHECK `billing_invoices_status_check` já deveria garantir que
      // `status='open'` (filtrado acima) é sempre um BillingInvoiceStatus
      // válido — este guard é defesa em profundidade contra drift de schema,
      // não caminho esperado.
      if (isBillingInvoiceStatus(inv.status)) {
        oldestOpenInvoice = { dueDate: inv.due_date as string, status: inv.status };
      } else {
        dataReadFailed = true;
        jsonLog("warn", {
          evt: "whatsapp_gate_invalid_invoice_status",
          org: organizationId,
          status: inv.status,
        });
      }
    }
  }

  const financial = normalizeFinancialState({
    now: nowIso,
    subscriptionStatus: sub?.status ?? null,
    canceledAt: sub?.canceled_at ?? null,
    oldestOpenInvoice,
  });

  // Valida o `billing_status` lido contra o vocabulário fechado do CHECK do
  // banco. Não muda o comportamento em runtime — `decideWhatsAppGate` (via
  // `systemBlocksDependentServices`) já falha aberto para um valor
  // desconhecido — o ganho aqui é só telemetria: um 10º status no CHECK que
  // este núcleo ainda não classificou não pode entrar em silêncio.
  const billingStatusRaw = orgRes.data?.billing_status as string | undefined;
  if (billingStatusRaw !== undefined && !isSystemBillingStatus(billingStatusRaw)) {
    jsonLog("warn", {
      evt: "whatsapp_gate_invalid_billing_status",
      org: organizationId,
      status: billingStatusRaw,
    });
  }

  const decision = decideWhatsAppGate({
    // Default 'active' quando a leitura falhou: o lado seguro aqui é PERMITIR.
    // Um erro transitório de banco não pode silenciar o WhatsApp do cliente.
    systemBillingStatus: billingStatusRaw ?? "active",
    financialState: financial.state,
    hasActiveWhatsAppOverride: overrides.some((o) => o.enabled),
    hasWhatsAppAdminBlock: overrides.some((o) => !o.enabled),
    isLegacyGrandfathered:
      orgRes.data?.whatsapp_legacy_grandfathered === true &&
      orgRes.data?.whatsapp_grandfather_revoked_at === null,
  });

  const enforcement = resolveEnforcement({
    decision,
    flagEnabled: flagCheck.enabled,
    flagReadFailed: flagCheck.readFailed,
    dataReadFailed,
  });

  const readFailed = dataReadFailed || flagCheck.readFailed;

  const result: ServiceGateResult = {
    ...decision,
    organizationId,
    enforcementEnabled: enforcement.enforcementEnabled,
    enforced: enforcement.enforced,
    provisioningBlockReason: enforcement.provisioningBlockReason,
    readFailed,
  };

  // Log guiado pelo campo `telemetry` do núcleo — nunca os dois ao mesmo
  // tempo, e uma falha de leitura da flag NUNCA vira dry-run (contaminaria a
  // única métrica que sustenta a decisão de ligar o enforcement).
  if (enforcement.telemetry === "FLAG_READ_FAILED") {
    jsonLog("warn", {
      evt: "whatsapp_enforcement_flag_read_failed",
      org: organizationId,
      state: decision.state,
      reason: decision.reason,
    });
  } else if (enforcement.telemetry === "DRY_RUN_WOULD_BLOCK_SENDING") {
    jsonLog("info", {
      evt: "whatsapp_enforcement_dryrun",
      org: organizationId,
      state: decision.state,
      would_block_sending: true,
      reason: decision.reason,
    });
  }

  if (!readFailed) {
    orgCache.set(organizationId, result);
  }
  return result;
}

export async function resolveWhatsAppGateByUnit(
  supabase: SupabaseClient,
  unitId: string,
): Promise<ServiceGateResult | null> {
  let orgId = unitToOrg.get(unitId);
  if (!orgId) {
    const { data, error } = await supabase
      .from("units")
      .select("organization_id")
      .eq("id", unitId)
      .maybeSingle();
    if (error || !data?.organization_id) {
      jsonLog("warn", { evt: "whatsapp_gate_unit_unresolved", unit_id: unitId, err: error?.message ?? "not_found" });
      return null;
    }
    orgId = data.organization_id as string;
    unitToOrg.set(unitId, orgId);
  }
  return await resolveWhatsAppGateByOrg(supabase, orgId);
}
