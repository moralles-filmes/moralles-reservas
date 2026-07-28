// supabase/functions/_shared/whatsapp-service-gate.ts
/**
 * Camada de I/O do gate de serviço de WhatsApp: carrega do banco o que o núcleo
 * puro precisa e devolve a decisão já combinada com a flag de enforcement.
 *
 * DOIS CAMPOS, NÃO UM: `sendingBlocked` é o estado REAL (o núcleo sempre
 * calcula), `enforced.sending` é a CONSEQUÊNCIA (só verdadeira com a flag
 * ligada). O caller que bloqueia usa `enforced`; o caller que loga ou mostra
 * estado usa o campo real. Colapsar os dois num booleano só apagaria o modo
 * dry-run, que é justamente como esta fase vai a produção primeiro.
 *
 * CACHE POR INVOCAÇÃO: `orgCache`/`unitToOrg` são zerados no início de cada
 * invocação pelo caller (`clearWhatsAppGateCache()`), mesmo padrão do
 * `unitCache` dos workers — sem isso, um isolate quente serviria estado velho
 * depois de o cliente pagar.
 *
 * Sem consumidor nesta task (Task 13 é só a camada de I/O). As Tasks 14-17, 19
 * e 20 é que plugam este helper nos caminhos de envio, no agente, no
 * provisionamento e nos painéis — a linha do checklist de redeploy do
 * CLAUDE.md entra junto com o primeiro consumidor real.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jsonLog } from "./security.ts";
import { isFlagEnabled } from "./platform-flags.ts";
import {
  normalizeFinancialState,
  isBillingInvoiceStatus,
  type BillingInvoiceStatus,
} from "./billing-financial-state-core.ts";
import { decideWhatsAppGate, type WhatsAppGateDecision } from "./whatsapp-service-state-core.ts";

const WHATSAPP_CATEGORY = "WHATSAPP_SUBSCRIPTION";

export interface ServiceGateResult extends WhatsAppGateDecision {
  organizationId: string;
  enforcementEnabled: boolean;
  /** Consequência operacional: estado real E flag ligada. */
  enforced: { sending: boolean; newProvisioning: boolean };
  /**
   * true quando alguma das leituras falhou e a decisão foi montada com defaults
   * de quem não leu. Caller que BLOQUEIA pode ignorar (o default é permitir, e
   * permitir é o lado seguro aqui); caller que AFIRMA o estado pro cliente tem
   * que checar antes de responder 200 — mesmo contrato de
   * `OrgEntitlementsResult.readFailed`.
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

  const [orgRes, overridesRes, subRes, flagOn] = await Promise.all([
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
    isFlagEnabled("whatsapp_service_enforcement"),
  ]);

  // `let`, não `const`: a leitura de billing_invoices (mais abaixo, condicional
  // à existência de assinatura) e a validação do status da fatura também podem
  // marcar isto depois deste bloco.
  let readFailed = !!(orgRes.error || overridesRes.error || subRes.error);
  if (readFailed) {
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
      // uma real, o que já é coberto por `readFailed` (lado seguro: permite).
      readFailed = true;
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
        readFailed = true;
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

  const decision = decideWhatsAppGate({
    // Default 'active' quando a leitura falhou: o lado seguro aqui é PERMITIR.
    // Um erro transitório de banco não pode silenciar o WhatsApp do cliente.
    systemBillingStatus: (orgRes.data?.billing_status as string | undefined) ?? "active",
    financialState: financial.state,
    hasActiveWhatsAppOverride: overrides.some((o) => o.enabled),
    hasWhatsAppAdminBlock: overrides.some((o) => !o.enabled),
    isLegacyGrandfathered:
      orgRes.data?.whatsapp_legacy_grandfathered === true &&
      orgRes.data?.whatsapp_grandfather_revoked_at === null,
  });

  const result: ServiceGateResult = {
    ...decision,
    organizationId,
    enforcementEnabled: flagOn,
    enforced: {
      sending: flagOn && decision.sendingBlocked,
      newProvisioning: flagOn && decision.newProvisioningBlocked,
    },
    readFailed,
  };

  // Telemetria de dry-run: com a flag desligada, registra o que TERIA
  // acontecido. É a única fonte de métrica antes de ligar o enforcement.
  if (!flagOn && decision.sendingBlocked) {
    jsonLog("info", {
      evt: "whatsapp_enforcement_dryrun",
      org: organizationId,
      state: decision.state,
      would_block_sending: true,
      reason: decision.reason,
    });
  }

  orgCache.set(organizationId, result);
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
