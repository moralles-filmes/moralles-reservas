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
 * Receita da organização segundo a política de §7.3. Não escreve nada.
 *
 * A receita atribuível a uma instância é a assinatura da categoria
 * WHATSAPP_SUBSCRIPTION — NÃO a mensalidade do sistema. Somar a mensalidade do
 * sistema aqui misturaria dois produtos e faria toda organização parecer
 * lucrativa no WhatsApp.
 */
async function resolveRevenueForOrg(organizationId: string): Promise<Fetch<RevenueAttribution>> {
  const [countRes, subRes, overrideRes] = await Promise.all([
    supabase.from("whatsapp_instances").select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId).eq("lifecycle_state", "ACTIVE"),
    supabase.from("billing_subscriptions")
      .select("id, billing_plans!inner(amount_cents, category)")
      .eq("organization_id", organizationId)
      .eq("status", "active")
      .eq("billing_plans.category", "WHATSAPP_SUBSCRIPTION")
      .maybeSingle(),
    supabase.from("organization_entitlement_overrides").select("id")
      .eq("organization_id", organizationId)
      .eq("feature", "whatsapp")
      .eq("grant_type", "LIFETIME")
      .eq("enabled", true)
      .is("revoked_at", null)
      .maybeSingle(),
  ]);

  // FALHA em vez de degradar. `countRes.count ?? 0` viraria "zero instâncias" e
  // `subRes.data` nulo viraria "sem assinatura" — os dois se confundem com
  // estado real e alimentam tanto os motivos do D-1 quanto o desequilíbrio
  // econômico. Receita desconhecida por FALHA DE LEITURA não pode virar receita
  // desconhecida por ausência de contrato.
  const revErr = countRes.error ?? subRes.error ?? overrideRes.error;
  if (revErr) return { ok: false, message: revErr.message };

  const plan = (subRes.data as unknown as { billing_plans?: { amount_cents?: number } } | null)
    ?.billing_plans;

  return {
    ok: true,
    value: attributeRevenue({
      activeInstanceCount: countRes.count ?? 0,
      subscriptionAmountCents: typeof plan?.amount_cents === "number" ? plan.amount_cents : null,
      hasLifetimeWhatsappOverride: !!overrideRes.data,
    }),
  };
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
