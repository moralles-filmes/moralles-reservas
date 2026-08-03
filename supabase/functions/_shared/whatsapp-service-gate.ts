// supabase/functions/_shared/whatsapp-service-gate.ts
/**
 * Camada de I/O do gate de serviço de WhatsApp: carrega do banco o que o núcleo
 * puro precisa e devolve a decisão já combinada com a flag de enforcement.
 *
 * A CONSEQUÊNCIA sobre uso existente (não o estado) é FAIL-OPEN — ver
 * `resolveEnforcement` em `whatsapp-service-state-core.ts`, o único lugar que
 * decide `enforced`. A elegibilidade para provisionar instância nova é
 * FAIL-CLOSED e vive em `resolveProvisioningEligibility`, separada de
 * propósito (não consulta a flag de enforcement) — ver o campo `provisioning`
 * abaixo. Este arquivo só lê o banco, valida o que lê, e repassa aos dois
 * núcleos; não reimplementa nenhuma lógica de consequência.
 *
 * QUAL ASSINATURA FINANCIA O WHATSAPP é decisão de um terceiro núcleo puro,
 * `whatsapp-subscription-resolver-core.ts`, compartilhado com
 * `process-whatsapp-enforcement/index.ts`. As duas queries eram campo-a-campo
 * idênticas por disciplina humana; agora a garantia é estrutural. Reintroduzir
 * aqui um filtro de categoria ou uma precedência de status local faz o worker
 * de suspensão e o gate de envio voltarem a discordar sobre quem está
 * inadimplente.
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
  resolveProvisioningEligibility,
  isSystemBillingStatus,
  type WhatsAppGateDecision,
  type ProvisioningEligibility,
} from "./whatsapp-service-state-core.ts";
import {
  resolveWhatsAppSubscription,
  type WhatsAppSubscriptionResolution,
} from "./whatsapp-subscription-resolver-core.ts";

// Re-exportado para callers que já importam deste módulo (ex.: manage-channels)
// tipar um `Record` exaustivo sobre os sete estados sem abrir um import novo
// direto pra whatsapp-service-state-core.ts — mantém o checklist de redeploy
// do CLAUDE.md ("manage-channels consome whatsapp-service-state-core.ts via
// whatsapp-service-gate.ts") verdadeiro.
export type { WhatsAppServiceState } from "./whatsapp-service-state-core.ts";

/**
 * Derivado do próprio núcleo, sem lista paralela: se a pendência ganhar um
 * segundo valor lá, este tipo acompanha e `tsc -b` cobra os callers.
 */
type WhatsAppAdminPendency = Extract<
  WhatsAppSubscriptionResolution,
  { kind: "RESOLVED" }
>["adminPendency"];

/**
 * Linha crua de `billing_subscriptions` com o plano embutido. A relação
 * aninhada volta do PostgREST como objeto OU array — normalizada abaixo, mesmo
 * padrão de `entitlements.ts`.
 *
 * `included_features` pode vir `null` quando a EF roda antes da migration 094;
 * `?? []` a trata como plano LEGADO, que é exatamente o que ela é nesse ponto
 * do rollout.
 */
interface SubscriptionPlanRef {
  category: string | null;
  included_features: string[] | null;
}

interface SubscriptionGateRow {
  id: string;
  status: string;
  canceled_at: string | null;
  suspended_at: string | null;
  billing_plans: SubscriptionPlanRef | SubscriptionPlanRef[] | null;
}

export interface ServiceGateResult extends WhatsAppGateDecision {
  organizationId: string;
  enforcementEnabled: boolean;
  /** Consequência operacional sobre uso existente — fail-open, ver o núcleo. */
  enforced: { sending: boolean };
  /**
   * Elegibilidade para provisionar instância nova. Calculada SEM a flag de
   * enforcement e fail-closed — ver `resolveProvisioningEligibility`. Não
   * confundir com `enforced`, que é o outro eixo (consequência gateada por
   * flag, fail-open).
   */
  provisioning: ProvisioningEligibility;
  /**
   * true quando ALGUMA leitura falhou — dado (organizations/overrides/
   * assinatura/fatura) OU a leitura da própria flag de enforcement. NÃO há um
   * "lado seguro" único para este campo agregado: `enforced.sending` já é
   * fail-open (uma falha aqui nunca vira bloqueio de envio) e
   * `provisioning.allowed` já é fail-closed (uma falha aqui SEMPRE bloqueia,
   * ver `provisioning.blockReason`). Nenhum caller de bloqueio deve decidir a
   * partir deste campo — ele é só diagnóstico agregado para
   * log/observabilidade; `enforced` e `provisioning` já carregam a
   * consequência certa para cada lado.
   */
  readFailed: boolean;
  /**
   * `due_date` da fatura em aberto mais antiga + `GRACE_PERIOD_DAYS`, já
   * calculado por `normalizeFinancialState` — repassado aqui só para a UI
   * (Task 20, `get_service_status`) não duplicar a conta. `null` fora de
   * `GRACE_PERIOD`/`SUSPENDED_UNPAID` (nenhuma fatura vencida em jogo).
   */
  graceEndsAt: string | null;
  /**
   * `billing_subscriptions.suspended_at` da assinatura WHATSAPP_SUBSCRIPTION —
   * coluna real, não derivada. Escrita só pelo worker `process-whatsapp-enforcement`
   * (gated pela flag), então pode ficar `null` mesmo com `state==="SUSPENDED_UNPAID"`
   * enquanto a flag estiver OFF ou o worker não tiver rodado ainda — quem
   * consome isto não pode tratar `null` aqui como "não está suspenso".
   */
  suspendedAt: string | null;
  /**
   * A fonte financeira do WhatsApp não é única e inequívoca — transição entre
   * o modelo antigo (`WHATSAPP_SUBSCRIPTION` separada) e o de dois planos
   * (plano de sistema que declara `whatsapp`), ou duplicidade inesperada na
   * mesma categoria. Vem de `resolveWhatsAppSubscription`.
   *
   * DELIBERADAMENTE ≠ `readFailed`: soluço técnico e pendência comercial são
   * estados diferentes, e colapsá-los faria uma transição legítima parecer
   * banco fora do ar. Sai daqui porque o painel da plataforma precisa vê-lo —
   * campo que não sai do adapter é decorativo.
   */
  subscriptionAmbiguous: boolean;
  /**
   * Obrigação administrativa pendente derivada da mesma resolução (hoje:
   * encerrar a assinatura legada de WhatsApp que ainda está aberta ao lado do
   * plano novo). `null` quando não há nada a fazer.
   */
  adminPendency: WhatsAppAdminPendency;
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
    // TODAS as candidatas, sem filtro de categoria e sem `.maybeSingle()`.
    //
    // Sem `.maybeSingle()` porque ele LANÇA com mais de uma linha, e a
    // transição entre o modelo antigo e o de dois planos produz exatamente
    // duas linhas elegíveis.
    //
    // Sem filtro de igualdade sobre a categoria do plano porque ele devolvia
    // ZERO linha para uma organização do Plano 2 — que paga pelo pacote de
    // automação dentro da mensalidade do sistema e cairia em `NOT_ENTITLED`.
    //
    // Qual delas financia o WhatsApp é decisão do NÚCLEO PURO
    // (`whatsapp-subscription-resolver-core.ts`), compartilhado com
    // `process-whatsapp-enforcement` — esta camada só lê e normaliza.
    supabase
      .from("billing_subscriptions")
      .select("id, status, canceled_at, suspended_at, billing_plans!inner(category, included_features)")
      .eq("organization_id", organizationId)
      .neq("status", "canceled"),
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

  const resolution = resolveWhatsAppSubscription({
    subscriptions: ((subRes.data ?? []) as unknown as SubscriptionGateRow[]).map((row) => {
      // PostgREST devolve relação aninhada como objeto OU array — normalizar.
      const plan = Array.isArray(row.billing_plans) ? row.billing_plans[0] : row.billing_plans;
      return {
        id: row.id,
        status: row.status,
        category: plan?.category ?? "SYSTEM_SUBSCRIPTION",
        includedFeatures: plan?.included_features ?? [],
        canceledAt: row.canceled_at,
        suspendedAt: row.suspended_at,
      };
    }),
  });

  // Ambiguidade COMERCIAL — deliberadamente separada de `dataReadFailed`.
  // Colapsar as duas faria uma transição legítima parecer banco fora do ar e
  // mandaria o motivo errado para a telemetria e para a UI.
  const subscriptionAmbiguous =
    resolution.kind === "AMBIGUOUS" ||
    (resolution.kind === "RESOLVED" && resolution.provisioningAmbiguous);

  const adminPendency: WhatsAppAdminPendency =
    resolution.kind === "RESOLVED" ? resolution.adminPendency : null;

  // Dois eventos distintos de propósito: duplicidade inesperada é defeito de
  // dados (warn), transição entre modelos é pendência administrativa esperada
  // (info). Só identificadores e contagens — nunca o payload das linhas.
  if (resolution.kind === "AMBIGUOUS") {
    jsonLog("warn", {
      evt: "whatsapp_gate_ambiguous_subscription",
      org: organizationId,
      reason: resolution.reasonCode,
      candidates: resolution.candidateIds.length,
    });
  } else if (resolution.kind === "RESOLVED" && resolution.adminPendency) {
    jsonLog("info", {
      evt: "whatsapp_gate_transition_pending",
      org: organizationId,
      pendency: resolution.adminPendency,
      source: resolution.source,
      chosen: resolution.subscriptionId,
      candidates: resolution.candidateIds.length,
    });
  }

  // Mesmo shape que o resto deste arquivo já consumia — a leitura de
  // `billing_invoices`, `normalizeFinancialState` e `decideWhatsAppGate` não
  // mudam. `null` = nenhuma fonte financeira (NONE ou AMBIGUOUS).
  const sub =
    resolution.kind === "RESOLVED"
      ? {
          id: resolution.subscriptionId,
          status: resolution.status,
          canceled_at: resolution.canceledAt,
          suspended_at: resolution.suspendedAt,
        }
      : null;

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
    // Não altera nenhum dos sete estados nem `sendingBlocked` — envio existente
    // falha ABERTO à ambiguidade. Vai junto porque a decisão é uma só.
    subscriptionAmbiguous,
  });

  const enforcement = resolveEnforcement({
    decision,
    flagEnabled: flagCheck.enabled,
    flagReadFailed: flagCheck.readFailed,
    dataReadFailed,
  });

  // `dataReadFailed`, não `readFailed` — a falha de leitura da flag de
  // enforcement não entra nesta conta (provisionamento nunca consulta a flag).
  const provisioning = resolveProvisioningEligibility({
    decision,
    dataReadFailed,
    subscriptionAmbiguous,
  });

  const readFailed = dataReadFailed || flagCheck.readFailed;

  const result: ServiceGateResult = {
    ...decision,
    organizationId,
    enforcementEnabled: enforcement.enforcementEnabled,
    enforced: enforcement.enforced,
    provisioning,
    readFailed,
    graceEndsAt: financial.graceEndsAt,
    suspendedAt: sub?.suspended_at ?? null,
    subscriptionAmbiguous,
    adminPendency,
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
