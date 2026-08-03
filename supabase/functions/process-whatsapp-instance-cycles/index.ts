// Worker do calendário do FORNECEDOR (Fase 6b). pg_cron 12:10 UTC (09:10 BRT).
//
// ESTE ARQUIVO É O ADAPTER. Toda decisão — política de lembrete, contadores,
// classificação por sub-passo, ordem dos cinco passos, quando enfileirar aviso
// — vive em _shared/whatsapp-instance-worker-core.ts, que vitest importa e
// testa. Aqui ficam só cliente Supabase, queries, relógio real, telemetria e
// resposta HTTP. Regra de decisão que aparecer NESTE arquivo é regra que
// ninguém consegue testar.
//
// UM worker e não vários porque os cinco passos leem o mesmo conjunto de
// instâncias e ciclos: separá-los faria três varreduras da mesma tabela
// decidindo sobre estados que o passo anterior acabou de mudar.
//
// NUNCA CHAMA A Z-API. Não importa cliente do provedor e não faz fetch externo
// — divergência aqui é comparação entre fatos já persistidos. A chamada real ao
// fornecedor continua exclusiva do caminho acionado por humano
// (manage-channels action `test`, whatsapp-health).
//
// NÃO ESCREVE em organizations.billing_status, billing_subscriptions,
// organization_entitlement_overrides nem whatsapp_channels.
//
// Responde 200 com o resumo por passo MESMO com falha parcial: pg_net é
// fire-and-forget e não faz retry por status, então 500 não recuperaria nada e
// apagaria o resumo. O sinal de falha é a TELEMETRIA, não o código HTTP.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireInternalAuth, genRequestId, jsonLog } from "../_shared/security.ts";
import { todayBrt } from "../_shared/billing-delinquency-core.ts";
import {
  attributeRevenue,
  type RevenueAttribution,
} from "../_shared/whatsapp-instance-revenue-core.ts";
import {
  resolveWhatsAppSubscription,
  type WhatsAppSubscriptionFact,
} from "../_shared/whatsapp-subscription-resolver-core.ts";
import {
  resolvePlatformAdminRecipients,
  enqueueBillingNotification,
} from "../_shared/billing-notify.ts";
import type { InstanceRow } from "../_shared/whatsapp-instance-divergence-core.ts";
import {
  runAllSteps,
  type AlertRepo,
  type ChannelForDivergence,
  type CycleInstance,
  type Fetch,
  type Query,
  type StepSummary,
  type WorkerDeps,
  type WorkerRepo,
} from "../_shared/whatsapp-instance-worker-core.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const ACTIVE_STATES = ["ACTIVE", "CANCELLATION_REQUESTED"];

/**
 * Destinatário administrativo, resolvido UMA vez por invocação.
 *
 * `resolvePlatformAdminRecipients` faz chamada ao Auth Admin por linha varrida;
 * resolvê-lo por alerta multiplicaria isso pelo número de alertas do lote sem
 * mudar a resposta. `undefined` = ainda não resolvido; `null` = resolvido e não
 * há destinatário.
 *
 * O ESTADO É DA INVOCAÇÃO, e por isso nasce dentro do `serve` — não como `let`
 * de módulo. O isolate sobrevive entre execuções: um `null` cacheado (nenhum
 * platform_admin no momento da primeira execução) sobreviveria à criação de um
 * admin e todo aviso nasceria mudo, sem erro e sem sinal.
 */
function makeRecipientResolver(reqId: string) {
  let cached: string | null | undefined;
  return {
    async resolve(): Promise<string | null> {
      if (cached !== undefined) return cached;
      const admins = await resolvePlatformAdminRecipients(supabase);
      cached = admins.length > 0 ? admins[0] : null;
      if (!cached) {
        jsonLog("error", { reqId, evt: "wa_alert_no_admin_recipient", needsAdminAction: true });
      }
      return cached;
    },
  };
}

function toCycleInstance(r: Record<string, unknown>): CycleInstance {
  return {
    id: r.id as string,
    organizationId: r.organization_id as string,
    lifecycleState: (r.lifecycle_state as string) ?? "",
    cycleSource: (r.cycle_source as string) ?? null,
    cycleStartedOn: (r.current_cycle_started_on as string) ?? null,
    cycleDueOn: (r.current_cycle_due_on as string) ?? null,
    monthlyCostCents: (r.current_monthly_cost_cents as number) ?? null,
    providerAccessUntil: (r.provider_access_until as string) ?? null,
    anchorDay: (r.provider_cycle_anchor_day as number) ?? null,
  };
}

/**
 * Linha crua de `billing_subscriptions` com o plano embutido. A relação
 * aninhada volta do PostgREST como objeto OU array — normalizada abaixo, mesmo
 * padrão de `whatsapp-service-gate.ts` e `entitlements.ts`.
 *
 * `included_features` pode vir `null` numa base anterior à migration 094; `?? []`
 * a trata como plano LEGADO, que é exatamente o que ela é nesse ponto do rollout.
 */
interface SubscriptionPlanRef {
  category: string | null;
  included_features: string[] | null;
  amount_cents: number | null;
  whatsapp_component_cents: number | null;
}

interface SubscriptionRevenueRow {
  id: string;
  status: string;
  canceled_at: string | null;
  suspended_at: string | null;
  billing_plans: SubscriptionPlanRef | SubscriptionPlanRef[] | null;
}

/**
 * Receita da organização segundo a política de §7.3. Não escreve nada.
 *
 * QUAL ASSINATURA FINANCIA O WHATSAPP é decisão do núcleo puro compartilhado
 * `whatsapp-subscription-resolver-core.ts` — o mesmo que `whatsapp-service-gate.ts`
 * e `process-whatsapp-enforcement` usam. Uma terceira query com regra própria
 * aqui é como duas fontes de verdade nascem: o gate diria que a organização tem
 * assinatura e o worker diria que não, sobre a mesma linha e no mesmo dia.
 *
 * DUAS ORIGENS DE RECEITA, e a distinção é o coração da task:
 *  - assinatura de categoria WHATSAPP_SUBSCRIPTION → `amount_cents` É a receita
 *    de WhatsApp (modelo legado, produto separado);
 *  - plano de SISTEMA que declara `whatsapp` em `included_features` → o
 *    `amount_cents` é a mensalidade do SISTEMA e NUNCA entra aqui; a parcela
 *    atribuível é `whatsapp_component_cents`, declarada no contrato.
 * Confundir as duas faria toda organização do Plano 2 parecer lucrativa no
 * WhatsApp pelo valor inteiro da mensalidade.
 */
async function resolveRevenueForOrg(organizationId: string): Promise<Fetch<RevenueAttribution>> {
  const [countRes, subRes, overrideRes] = await Promise.all([
    supabase.from("whatsapp_instances").select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId).eq("lifecycle_state", "ACTIVE"),
    // TODAS as candidatas, sem filtro de categoria e sem `.maybeSingle()` —
    // campo-a-campo a mesma forma da query do gate. `.maybeSingle()` LANÇA com
    // duas linhas, e a transição entre o modelo antigo e o de dois planos produz
    // exatamente duas; o filtro por categoria devolvia ZERO linha para uma
    // organização do Plano 2, que paga pelo pacote dentro da mensalidade.
    supabase.from("billing_subscriptions")
      .select(
        "id, status, canceled_at, suspended_at, billing_plans!inner(category, included_features, amount_cents, whatsapp_component_cents)",
      )
      .eq("organization_id", organizationId)
      .neq("status", "canceled"),
    supabase.from("organization_entitlement_overrides").select("id")
      .eq("organization_id", organizationId)
      .eq("feature", "whatsapp")
      .eq("grant_type", "LIFETIME")
      .eq("enabled", true)
      .is("revoked_at", null)
      .maybeSingle(),
  ]);

  // FALHA em vez de degradar. `countRes.count ?? 0` viraria "zero instâncias" e
  // uma lista vazia viraria "sem assinatura" — os dois se confundem com estado
  // real e alimentam tanto os motivos do D-1 quanto o desequilíbrio econômico.
  // Receita desconhecida por FALHA DE LEITURA não pode virar receita
  // desconhecida por ausência de contrato.
  const revErr = countRes.error ?? subRes.error ?? overrideRes.error;
  if (revErr) return { ok: false, message: revErr.message };

  // O resolvedor devolve `subscriptionId`, não a linha do plano. A correlação de
  // volta é por CHAVE, nunca por posição: o PostgREST não garante ordem sem
  // ORDER BY, e um índice de array casaria o componente de um plano com a
  // assinatura de outro sem que nada reclamasse.
  const planBySubscriptionId = new Map<string, SubscriptionPlanRef>();
  const facts: WhatsAppSubscriptionFact[] = (
    (subRes.data ?? []) as unknown as SubscriptionRevenueRow[]
  ).map((row) => {
    const plan = Array.isArray(row.billing_plans) ? row.billing_plans[0] : row.billing_plans;
    if (plan) planBySubscriptionId.set(row.id, plan);
    return {
      id: row.id,
      status: row.status,
      category: plan?.category ?? "SYSTEM_SUBSCRIPTION",
      includedFeatures: plan?.included_features ?? [],
      canceledAt: row.canceled_at,
      suspendedAt: row.suspended_at,
    };
  });

  const resolution = resolveWhatsAppSubscription({ subscriptions: facts });

  // Ambiguidade COMERCIAL não é `NO_ENTITLEMENT`: "existe fonte, não sei qual" é
  // diferente de "não existe fonte", e a segunda é uma ACUSAÇÃO que abre
  // ECONOMIC_IMBALANCE. Sai como falha de resolução — o passo credita a
  // organização como não avaliada e o admin decide, que é o mesmo destino que a
  // query antiga com `.maybeSingle()` dava a duas linhas na mesma categoria.
  if (resolution.kind === "AMBIGUOUS") {
    jsonLog("warn", {
      evt: "wa_revenue_ambiguous_subscription",
      organizationId,
      reason: resolution.reasonCode,
      candidates: resolution.candidateIds.length,
      needsAdminAction: true,
    });
    return { ok: false, message: `revenue_subscription_ambiguous:${resolution.reasonCode}` };
  }

  const chosen =
    resolution.kind === "RESOLVED" ? planBySubscriptionId.get(resolution.subscriptionId) : null;

  // `!inner` garante o plano; chegar aqui sem ele significa que a correlação não
  // fechou. Cair no caminho de baixo com `chosen` vazio afirmaria "sem contrato"
  // sobre uma assinatura que o resolvedor acabou de escolher.
  if (resolution.kind === "RESOLVED" && !chosen) {
    jsonLog("error", {
      evt: "wa_revenue_plan_not_correlated",
      organizationId,
      subscriptionId: resolution.subscriptionId,
      needsAdminAction: true,
    });
    return { ok: false, message: "revenue_plan_not_correlated" };
  }

  const attribution = attributeRevenue({
    activeInstanceCount: countRes.count ?? 0,
    // Só a categoria WHATSAPP_SUBSCRIPTION tem `amount_cents` de WhatsApp.
    subscriptionAmountCents:
      chosen?.category === "WHATSAPP_SUBSCRIPTION" && typeof chosen.amount_cents === "number"
        ? chosen.amount_cents
        : null,
    hasLifetimeWhatsappOverride: !!overrideRes.data,
    // Componente contratual do pacote de automação, quando o plano o declara.
    planWhatsappComponentCents:
      typeof chosen?.whatsapp_component_cents === "number"
        ? chosen.whatsapp_component_cents
        : null,
  });

  // A união segue INTEIRA para o núcleo: o que fazer com `INVALID_INPUT` é
  // decisão, e decisão não mora no adapter — aqui ela seria inauditável.
  return { ok: true, value: attribution };
}

const alertRepo: AlertRepo = {
  async find(k) {
    const { data, error } = await supabase
      .from("whatsapp_instance_alerts")
      .select("id, status, occurrences, last_reminder_at")
      .eq("subject_type", k.subjectType)
      .eq("subject_id", k.subjectId)
      .eq("alert_type", k.alertType)
      .eq("dedupe_key", k.dedupeKey)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    return {
      id: data.id,
      status: data.status,
      occurrences: data.occurrences,
      lastReminderAt: data.last_reminder_at,
    };
  },

  async insert(a) {
    const { data, error } = await supabase
      .from("whatsapp_instance_alerts")
      .insert({
        subject_type: a.subjectType,
        subject_id: a.subjectId,
        organization_id: a.organizationId,
        instance_id: a.instanceId,
        channel_id: a.channelId,
        alert_type: a.alertType,
        dedupe_key: a.dedupeKey,
        status: "OPEN",
        payload: a.payload,
        // Flag do dispatcher está OFF nesta fase; o painel é a superfície viva.
        dispatch_enabled_at_enqueue: false,
      })
      .select("id")
      .single();
    // 23505 = outra execução criou entre o SELECT e o INSERT. Dedupe silencioso.
    if (error) {
      return { ok: false, duplicate: error.code === "23505", message: error.message };
    }
    return { ok: true, id: data.id };
  },

  async touch(t) {
    const { data, error } = await supabase
      .from("whatsapp_instance_alerts")
      .update({
        last_seen_at: t.nowIso,
        occurrences: t.occurrences,
        last_reminder_at: t.lastReminderAt,
        payload: t.payload,
      })
      .eq("id", t.id)
      // Defesa em profundidade: a guarda de tenant das filhas dispara em
      // `update of organization_id, instance_id`, e este UPDATE não toca
      // nenhuma das duas — então ela NÃO cobre esta escrita. O predicado cobre.
      .eq("organization_id", t.organizationId)
      // `.select()` é o que torna a negativa VISÍVEL: sem ele o PostgREST
      // devolve `error: null` mesmo casando zero linhas.
      .select("id");
    if (error) return { ok: false, message: error.message };
    return { ok: true, matched: (data ?? []).length };
  },

  async stampReminder(t) {
    const patch: Record<string, unknown> = { last_reminder_at: t.nowIso };
    if (typeof t.occurrences === "number") patch.occurrences = t.occurrences;
    const { data, error } = await supabase
      .from("whatsapp_instance_alerts")
      .update(patch)
      .eq("id", t.id)
      .eq("organization_id", t.organizationId)
      .select("id");
    if (error) return { ok: false, message: error.message };
    return { ok: true, matched: (data ?? []).length };
  },
};

const repo: WorkerRepo = {
  async listRollCandidates(today) {
    const { data, error } = await supabase
      .from("whatsapp_instances")
      .select("id, organization_id, lifecycle_state, provider_cycle_anchor_day, current_cycle_due_on, cycle_source")
      .in("lifecycle_state", ACTIVE_STATES)
      .not("current_cycle_due_on", "is", null)
      .lte("current_cycle_due_on", today);
    if (error) return { ok: false, message: error.message };
    return { ok: true, rows: (data ?? []).map(toCycleInstance) };
  },

  async rollCycle(a) {
    const { data, error } = await supabase.rpc("roll_whatsapp_instance_cycle", {
      p_instance_id: a.instanceId,
      p_today: a.today,
      p_next_due_on: a.nextDueOn,
    });
    if (error) return { ok: false, message: error.message };
    return { ok: true, value: data?.[0]?.action ?? null };
  },

  async listCycleInstances() {
    const { data, error } = await supabase
      .from("whatsapp_instances")
      .select(
        "id, organization_id, lifecycle_state, cycle_source, current_cycle_started_on, current_cycle_due_on, current_monthly_cost_cents, provider_access_until, provider_cycle_anchor_day",
      )
      .in("lifecycle_state", ACTIVE_STATES)
      .not("current_cycle_due_on", "is", null);
    if (error) return { ok: false, message: error.message };
    return { ok: true, rows: (data ?? []).map(toCycleInstance) };
  },

  resolveRevenue: resolveRevenueForOrg,

  async hasOpenDivergence(instanceId) {
    const { data, error } = await supabase
      .from("whatsapp_instance_alerts")
      .select("id")
      .eq("instance_id", instanceId)
      .eq("alert_type", "DIVERGENCE")
      .in("status", ["OPEN", "ACKNOWLEDGED"])
      .limit(1);
    if (error) return { ok: false, message: error.message };
    return { ok: true, value: (data ?? []).length > 0 };
  },

  async listEndConfirmationCandidates(today) {
    const { data, error } = await supabase
      .from("whatsapp_instances")
      .select("id, organization_id, lifecycle_state, provider_access_until, end_confirmation_required_at")
      .eq("lifecycle_state", "CANCELLATION_REQUESTED")
      .not("provider_access_until", "is", null)
      .lte("provider_access_until", today);
    if (error) return { ok: false, message: error.message };
    return {
      ok: true,
      rows: (data ?? []).map((r) => ({
        ...toCycleInstance(r),
        endConfirmationRequiredAt: (r.end_confirmation_required_at as string) ?? null,
      })),
    };
  },

  async stampEndConfirmationRequired(instanceId, nowIso) {
    const { error } = await supabase
      .from("whatsapp_instances")
      .update({ end_confirmation_required_at: nowIso })
      .eq("id", instanceId)
      .is("end_confirmation_required_at", null);
    if (error) return { ok: false, message: error.message };
    return { ok: true };
  },

  async listDivergenceInstances(): Promise<Query<InstanceRow>> {
    const { data, error } = await supabase
      .from("whatsapp_instances")
      .select(
        "id, organization_id, lifecycle_state, channel_id, provider_instance_ref, ended_at, last_synced_at",
      )
      .neq("lifecycle_state", "AWAITING_PROVISION");
    if (error) return { ok: false, message: error.message };

    const rows: InstanceRow[] = [];
    for (const r of data ?? []) {
      // O identificador LEGADO vive em whatsapp_channels.credentials.instance_id.
      // Extrair SOMENTE o identificador — nunca copiar o objeto de credenciais
      // inteiro, nunca logar, nunca escrever de volta.
      let legacyRef: string | null = null;
      let channelState: string | null = null;
      let channelStateAgeDays: number | null = null;

      if (r.channel_id) {
        const { data: ch, error: chErr } = await supabase
          .from("whatsapp_channels")
          .select("credentials, status, updated_at")
          .eq("id", r.channel_id)
          .maybeSingle();
        // Erro descartado aqui virava `legacyRef = null`, que o detector lê
        // como "o canal não tem identificador" — e isso produz ou suprime um
        // INSTANCE_REF_MISMATCH a partir de um soluço de rede. Aborta o passo:
        // decidir sobre divergência com visão parcial é pior que não decidir.
        if (chErr) return { ok: false, message: chErr.message };
        if (ch) {
          // jsonb volta como OBJETO: nunca interpolar em template literal.
          const creds = (ch.credentials ?? {}) as Record<string, unknown>;
          const raw = creds["instance_id"];
          legacyRef = typeof raw === "string" && raw.length > 0 ? raw : null;
          channelState = ch.status ?? null;
          channelStateAgeDays = ch.updated_at
            ? Math.floor((Date.now() - Date.parse(ch.updated_at)) / 86400000)
            : null;
        }
      }

      rows.push({
        instanceId: r.id,
        organizationId: r.organization_id,
        lifecycleState: r.lifecycle_state,
        channelId: r.channel_id,
        providerInstanceRef: r.provider_instance_ref,
        legacyChannelInstanceRef: legacyRef,
        channelState,
        channelStateAgeDays,
        // Nesta fase não existe campo de explicação administrativa por
        // divergência: o admin resolve/dispensa o alerta com motivo, e o dedupe
        // impede reabertura. Passar `true` aqui sem esse campo seria suprimir
        // divergência sem registro.
        hasAdminExplanation: false,
        endedAtIso: r.ended_at,
        lastLocalSignalAtIso: r.last_synced_at,
      });
    }
    return { ok: true, rows };
  },

  async listInventoryChannels(): Promise<Query<ChannelForDivergence>> {
    // whatsapp_channels não tem organization_id: a organização vem por units.
    const { data, error } = await supabase
      .from("whatsapp_channels")
      .select("id, status, unit_id, credentials, last_event_at, units!inner(organization_id)");
    if (error) return { ok: false, message: error.message };

    return {
      ok: true,
      rows: (data ?? []).map((c) => {
        const row = c as unknown as {
          id: string;
          credentials: Record<string, unknown> | null;
          last_event_at: string | null;
          units?: { organization_id?: string };
        };
        const ref = (row.credentials ?? {})["instance_id"];
        return {
          channelId: row.id,
          organizationId: row.units?.organization_id ?? null,
          hasLegacyRef: typeof ref === "string" && ref.length > 0,
          hasEverOperated: !!row.last_event_at,
        };
      }),
    };
  },

  async recordDivergenceKind(instanceId, kind, nowIso) {
    const { error } = await supabase.from("whatsapp_instances")
      .update({ last_divergence_kind: kind, last_divergence_at: nowIso })
      .eq("id", instanceId);
    if (error) return { ok: false, message: error.message };
    return { ok: true };
  },

  async listDateReviewPending() {
    const { data, error } = await supabase
      .from("whatsapp_instances")
      .select("id, organization_id")
      .eq("cycle_source", "UNKNOWN")
      .in("lifecycle_state", ACTIVE_STATES);
    if (error) return { ok: false, message: error.message };
    return {
      ok: true,
      rows: (data ?? []).map((r) => ({ id: r.id, organizationId: r.organization_id })),
    };
  },

  async listEconomicInstances() {
    const { data, error } = await supabase
      .from("whatsapp_instances")
      .select("id, organization_id, current_monthly_cost_cents")
      .in("lifecycle_state", ACTIVE_STATES);
    if (error) return { ok: false, message: error.message };
    return {
      ok: true,
      rows: (data ?? []).map((r) => ({
        id: r.id,
        organizationId: r.organization_id,
        costCents: r.current_monthly_cost_cents ?? null,
      })),
    };
  },
};

serve(async (req) => {
  if (!requireInternalAuth(req)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  const reqId = genRequestId();
  const today = todayBrt();
  jsonLog("info", { reqId, evt: "wa_instance_cycles_start", today });

  // UM resolver, compartilhado entre `recipients` e `notifier`. Dois resolvers
  // teriam dois caches e refariam a chamada ao Auth Admin — o custo que o cache
  // existe para evitar.
  const recipients = makeRecipientResolver(reqId);

  const deps: WorkerDeps = {
    clock: { nowMs: () => Date.now(), nowIso: () => new Date().toISOString() },
    telemetry: {
      info: (e) => jsonLog("info", e),
      warn: (e) => jsonLog("warn", e),
      error: (e) => jsonLog("error", e),
    },
    alerts: alertRepo,
    notifier: {
      async enqueue(organizationId, eventType) {
        const recipient = await recipients.resolve();
        // O núcleo já checou o destinatário antes de chamar; esta guarda existe
        // para que a fila nunca receba linha com recipient vazio se um caller
        // futuro chamar direto.
        if (!recipient) return false;
        return await enqueueBillingNotification(supabase, {
          organizationId,
          eventType,
          // Aviso administrativo sobre instância não tem fatura por trás.
          invoiceId: null,
          recipient,
        });
      },
    },
    recipients,
    repo,
    reqId,
  };

  let steps: StepSummary[] = [];
  let lockHeld = false;

  try {
    // Lock economiza trabalho; NÃO é o invariante. A correção vem da RPC
    // transacional + os dois UNIQUE. Falha aberta é aceitável.
    const { data: got } = await supabase.rpc("try_whatsapp_instance_cycles_lock");
    lockHeld = got === true;
    if (!lockHeld) jsonLog("warn", { reqId, evt: "wa_lock_not_acquired" });

    steps = await runAllSteps(deps, today);

    jsonLog("info", { reqId, evt: "wa_instance_cycles_done", steps });
    return new Response(JSON.stringify({ success: true, today, steps }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    jsonLog("error", {
      reqId, evt: "wa_instance_cycles_error", err: String(err), steps, needsAdminAction: true,
    });
    // 200 mesmo assim: o resumo por passo é mais útil que um 500 que pg_net
    // ignora de qualquer forma.
    return new Response(JSON.stringify({ success: false, today, steps }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } finally {
    if (lockHeld) {
      try {
        await supabase.rpc("release_whatsapp_instance_cycles_lock");
      } catch {
        // Release best-effort: o lock tem escopo de sessão e cai sozinho.
      }
    }
  }
});
