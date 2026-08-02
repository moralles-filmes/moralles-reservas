// Worker do calendário do FORNECEDOR (Fase 6b). pg_cron 12:10 UTC (09:10 BRT).
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
import { nextDueFromAnchor, daysUntil } from "../_shared/whatsapp-instance-cycle-core.ts";
import {
  attributeRevenue,
  consolidateOrgMargin,
  type RevenueAttribution,
} from "../_shared/whatsapp-instance-revenue-core.ts";
import {
  EVENT_TYPE_BY_ALERT,
  resolveD1Reasons,
  shouldEmitD7,
  shouldEmitD1,
  dedupeKeyD7,
  dedupeKeyD1,
  dedupeKeyEndConfirmation,
  dedupeKeyDateReview,
  dedupeKeyEconomicImbalance,
  economicImbalanceHash,
  type AlertType,
} from "../_shared/whatsapp-instance-alerts-core.ts";
import {
  resolvePlatformAdminRecipients,
  enqueueBillingNotification,
} from "../_shared/billing-notify.ts";
import {
  detectChannelWithoutInstance,
  detectInstanceDivergences,
  type InstanceRow,
} from "../_shared/whatsapp-instance-divergence-core.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

/** Lembrete MENSAL e não diário: aviso diário treina o admin a ignorar. */
const REMINDER_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;

type StepSummary = { step: string; processed: number; failed: number };

let reqId = "";

/**
 * Destinatário administrativo, resolvido UMA vez por invocação.
 *
 * `resolvePlatformAdminRecipients` faz chamada ao Auth Admin por linha varrida;
 * resolvê-lo por alerta multiplicaria isso pelo número de alertas do lote sem
 * mudar a resposta. `undefined` = ainda não resolvido; `null` = resolvido e não
 * há destinatário.
 */
let adminRecipient: string | null | undefined;

async function resolveAdminRecipientOnce(): Promise<string | null> {
  if (adminRecipient !== undefined) return adminRecipient;
  const admins = await resolvePlatformAdminRecipients(supabase);
  adminRecipient = admins.length > 0 ? admins[0] : null;
  if (!adminRecipient) {
    jsonLog("error", {
      reqId,
      evt: "wa_alert_no_admin_recipient",
      needsAdminAction: true,
    });
  }
  return adminRecipient;
}

/**
 * Enfileira o aviso administrativo do alerta.
 *
 * SÓ é chamado quando o ledger diz `created` ou `reminded` — nunca em `seen`.
 * O índice UNIQUE de `billing_notifications` é PARCIAL e **não deduplica com
 * `invoice_id` nulo** (CLAUDE.md), e todos os avisos desta fase são sem fatura.
 * Enfileirar a cada passada do worker criaria uma linha nova por dia para o
 * mesmo fato — a cadência mensal do lembrete é o que evita isso, e ela vive no
 * ledger, não na fila.
 */
async function enqueueAlertNotification(
  alertType: AlertType,
  organizationId: string,
): Promise<void> {
  const recipient = await resolveAdminRecipientOnce();
  if (!recipient) return;

  await enqueueBillingNotification(supabase, {
    organizationId,
    eventType: EVENT_TYPE_BY_ALERT[alertType],
    // Aviso administrativo sobre instância não tem fatura por trás.
    invoiceId: null,
    recipient,
  });
}

/**
 * Cria o alerta ou incrementa o existente. O ledger é INDEPENDENTE da fila de
 * e-mail: com billing_notifications_dispatch OFF o alerta continua registrado,
 * e `dispatch_enabled_at_enqueue` diz se havia envio no momento — para que
 * ninguém leia "não recebi e-mail" como "não houve alerta".
 *
 * Lembrete REEMITE e incrementa `occurrences`; não cria linha nova.
 */
async function upsertAlert(a: {
  subjectType: "INSTANCE" | "ORGANIZATION";
  subjectId: string;
  organizationId: string;
  instanceId: string | null;
  channelId: string | null;
  alertType: AlertType;
  dedupeKey: string;
  payload: Record<string, unknown>;
}): Promise<"created" | "reminded" | "seen" | "failed"> {
  const nowIso = new Date().toISOString();

  const { data: existing, error: selErr } = await supabase
    .from("whatsapp_instance_alerts")
    .select("id, status, occurrences, last_reminder_at")
    .eq("subject_type", a.subjectType)
    .eq("subject_id", a.subjectId)
    .eq("alert_type", a.alertType)
    .eq("dedupe_key", a.dedupeKey)
    .maybeSingle();

  if (selErr) {
    jsonLog("error", {
      reqId, evt: "wa_alert_lookup_failed", alertType: a.alertType,
      err: selErr.message, needsAdminAction: true,
    });
    return "failed";
  }

  if (!existing) {
    const { error } = await supabase.from("whatsapp_instance_alerts").insert({
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
    });
    // 23505 = outra execução criou entre o SELECT e o INSERT. Dedupe silencioso.
    if (error && error.code !== "23505") {
      jsonLog("error", {
        reqId, evt: "wa_alert_insert_failed", alertType: a.alertType,
        err: error.message, needsAdminAction: true,
      });
      return "failed";
    }
    if (error) return "seen"; // 23505: outra execução criou; ela já enfileirou.
    // Enfileiramento acoplado à CRIAÇÃO no ledger, num ponto único: caller que
    // esqueça de enfileirar produziria alerta mudo, e o ledger é quem sabe se
    // o fato é novo.
    await enqueueAlertNotification(a.alertType, a.organizationId);
    return "created";
  }

  if (existing.status !== "OPEN") return "seen";

  const last = existing.last_reminder_at ? Date.parse(existing.last_reminder_at) : 0;
  const due = Date.now() - last >= REMINDER_INTERVAL_MS;

  const { error: updErr } = await supabase
    .from("whatsapp_instance_alerts")
    .update({
      last_seen_at: nowIso,
      occurrences: existing.occurrences + (due ? 1 : 0),
      last_reminder_at: due ? nowIso : existing.last_reminder_at,
      // Payload REESCRITO a cada passada. A chave do D-1 deixou de carregar os
      // motivos justamente para não abrir linha nova quando eles mudam — se o
      // payload não acompanhasse, o admin leria a lista do primeiro dia como se
      // ainda valesse.
      payload: a.payload,
    })
    .eq("id", existing.id);

  if (updErr) {
    jsonLog("error", {
      reqId, evt: "wa_alert_touch_failed", alertType: a.alertType,
      err: updErr.message, needsAdminAction: true,
    });
    return "failed";
  }
  if (!due) return "seen";
  await enqueueAlertNotification(a.alertType, a.organizationId);
  return "reminded";
}

/**
 * Receita da organização segundo a política de §7.3. Não escreve nada.
 *
 * A receita atribuível a uma instância é a assinatura da categoria
 * WHATSAPP_SUBSCRIPTION — NÃO a mensalidade do sistema. Somar a mensalidade do
 * sistema aqui misturaria dois produtos e faria toda organização parecer
 * lucrativa no WhatsApp.
 */
async function resolveRevenueForOrg(organizationId: string): Promise<RevenueAttribution> {
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

  // LANÇA em vez de degradar. `countRes.count ?? 0` viraria "zero instâncias"
  // e `subRes.data` nulo viraria "sem assinatura" — os dois se confundem com
  // estado real e alimentam tanto os motivos do D-1 quanto o desequilíbrio
  // econômico. Receita desconhecida por FALHA DE LEITURA não pode virar
  // receita desconhecida por ausência de contrato. O laço do caller tem
  // try/catch por item: a instância entra em `failed` e é revista amanhã.
  const revErr = countRes.error ?? subRes.error ?? overrideRes.error;
  if (revErr) throw new Error(`revenue_query_failed: ${revErr.message}`);

  const plan = (subRes.data as unknown as { billing_plans?: { amount_cents?: number } } | null)
    ?.billing_plans;

  return attributeRevenue({
    activeInstanceCount: countRes.count ?? 0,
    subscriptionAmountCents: typeof plan?.amount_cents === "number" ? plan.amount_cents : null,
    hasLifetimeWhatsappOverride: !!overrideRes.data,
  });
}

async function hasOpenDivergence(instanceId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("whatsapp_instance_alerts")
    .select("id")
    .eq("instance_id", instanceId)
    .eq("alert_type", "DIVERGENCE")
    .in("status", ["OPEN", "ACKNOWLEDGED"])
    .limit(1);
  // Falha de leitura devolveria `false` — "não há divergência aberta" — que é
  // justamente um dos motivos que tornam o D-1 acionável. Silenciar o motivo
  // por soluço de rede é pior que pular a instância nesta passada.
  if (error) throw new Error(`divergence_lookup_failed: ${error.message}`);
  return (data ?? []).length > 0;
}

/** Passo 1 — rolagem. PRECEDE tudo: muda as datas que os passos 2-3 leem. */
async function stepRollCycles(today: string): Promise<StepSummary> {
  const s: StepSummary = { step: "roll_cycles", processed: 0, failed: 0 };

  const { data: rows, error } = await supabase
    .from("whatsapp_instances")
    .select("id, provider_cycle_anchor_day, current_cycle_due_on, cycle_source")
    .in("lifecycle_state", ["ACTIVE", "CANCELLATION_REQUESTED"])
    .not("current_cycle_due_on", "is", null)
    .lte("current_cycle_due_on", today);

  if (error) {
    jsonLog("error", { reqId, evt: "wa_roll_query_failed", err: error.message, needsAdminAction: true });
    s.failed++;
    return s;
  }

  for (const r of rows ?? []) {
    // Falha em UMA instância não aborta as demais.
    try {
      if (!r.provider_cycle_anchor_day) {
        // Sem âncora não há rolagem honesta — a pendência de data já existe.
        jsonLog("warn", { reqId, evt: "wa_roll_skipped_no_anchor", instanceId: r.id });
        continue;
      }
      // A aritmética vem do núcleo puro; a RPC só persiste.
      const nextDue = nextDueFromAnchor(r.current_cycle_due_on, r.provider_cycle_anchor_day);
      const { data, error: rpcErr } = await supabase.rpc("roll_whatsapp_instance_cycle", {
        p_instance_id: r.id,
        p_today: today,
        p_next_due_on: nextDue,
      });
      if (rpcErr) {
        jsonLog("error", {
          reqId, evt: "wa_roll_failed", instanceId: r.id,
          err: rpcErr.message, needsAdminAction: true,
        });
        s.failed++;
        continue;
      }
      s.processed++;
      jsonLog("info", { reqId, evt: "wa_roll_done", instanceId: r.id, action: data?.[0]?.action });
    } catch (e) {
      jsonLog("error", {
        reqId, evt: "wa_roll_exception", instanceId: r.id,
        err: String(e), needsAdminAction: true,
      });
      s.failed++;
    }
  }
  return s;
}

/**
 * Passos 2 e 3 — D-7 sempre, D-1 condicional. D-3 não existe: três avisos para
 * a mesma data é a cadência que produz cegueira.
 */
async function stepCycleAlerts(today: string): Promise<StepSummary[]> {
  const d7: StepSummary = { step: "alerts_d7", processed: 0, failed: 0 };
  const d1: StepSummary = { step: "alerts_d1", processed: 0, failed: 0 };

  const { data: rows, error } = await supabase
    .from("whatsapp_instances")
    .select(
      "id, organization_id, lifecycle_state, cycle_source, current_cycle_started_on, current_cycle_due_on, current_monthly_cost_cents, provider_access_until",
    )
    .in("lifecycle_state", ["ACTIVE", "CANCELLATION_REQUESTED"])
    .not("current_cycle_due_on", "is", null);

  if (error) {
    jsonLog("error", { reqId, evt: "wa_alerts_query_failed", err: error.message, needsAdminAction: true });
    d7.failed++;
    return [d7, d1];
  }

  for (const r of rows ?? []) {
    try {
      // cycle_source UNKNOWN não emite D-7/D-1: a instância está na fila de
      // revisão de data e nenhum aviso pode AFIRMAR uma data que ninguém
      // confirmou. (O CHECK do banco já impede projeção com UNKNOWN; esta
      // guarda é a mesma regra dita no lado que emite o aviso.)
      if (r.cycle_source === "UNKNOWN") continue;

      const days = daysUntil(r.current_cycle_due_on, today);

      if (shouldEmitD7(days)) {
        const res = await upsertAlert({
          subjectType: "INSTANCE",
          subjectId: r.id,
          organizationId: r.organization_id,
          instanceId: r.id,
          channelId: null,
          alertType: "CYCLE_DUE_SOON",
          dedupeKey: dedupeKeyD7(r.current_cycle_started_on),
          payload: { days_until_due: days, due_on: r.current_cycle_due_on },
        });
        if (res === "failed") d7.failed++;
        else d7.processed++;
      }

      // Receita atribuída para distinguir "receita NULL prevista" de lacuna.
      const revenue = await resolveRevenueForOrg(r.organization_id);
      const reasons = resolveD1Reasons({
        costCents: r.current_monthly_cost_cents,
        hasOpenDivergence: await hasOpenDivergence(r.id),
        cancellationIntendedNotRegistered:
          r.lifecycle_state === "CANCELLATION_REQUESTED" && !r.provider_access_until,
        revenueSource: revenue.revenueSource,
        customerRevenueCents: revenue.customerRevenueCents,
      });

      if (shouldEmitD1(days, reasons)) {
        const res = await upsertAlert({
          subjectType: "INSTANCE",
          subjectId: r.id,
          organizationId: r.organization_id,
          instanceId: r.id,
          channelId: null,
          alertType: "CYCLE_DUE_TOMORROW",
          dedupeKey: dedupeKeyD1(r.current_cycle_started_on),
          payload: { days_until_due: days, reasons },
        });
        if (res === "failed") d1.failed++;
        else d1.processed++;
      }
    } catch (e) {
      jsonLog("error", {
        reqId, evt: "wa_alerts_exception", instanceId: r.id,
        err: String(e), needsAdminAction: true,
      });
      d7.failed++;
    }
  }
  return [d7, d1];
}

/**
 * Passo 4 — "worker propõe, admin confirma". O worker NÃO move para ENDED só
 * porque a data passou: afirmar um encerramento que o fornecedor não fez é a
 * família do bug 08.
 */
async function stepEndConfirmation(today: string): Promise<StepSummary> {
  const s: StepSummary = { step: "end_confirmation", processed: 0, failed: 0 };

  const { data: rows, error } = await supabase
    .from("whatsapp_instances")
    .select("id, organization_id, provider_access_until, end_confirmation_required_at")
    .eq("lifecycle_state", "CANCELLATION_REQUESTED")
    .not("provider_access_until", "is", null)
    .lte("provider_access_until", today);

  if (error) {
    jsonLog("error", { reqId, evt: "wa_end_query_failed", err: error.message, needsAdminAction: true });
    s.failed++;
    return s;
  }

  for (const r of rows ?? []) {
    try {
      if (!r.end_confirmation_required_at) {
        const { error: updErr } = await supabase
          .from("whatsapp_instances")
          .update({ end_confirmation_required_at: new Date().toISOString() })
          .eq("id", r.id)
          .is("end_confirmation_required_at", null);
        if (updErr) {
          jsonLog("error", {
            reqId, evt: "wa_end_stamp_failed", instanceId: r.id,
            err: updErr.message, needsAdminAction: true,
          });
          s.failed++;
          continue;
        }
      }

      // lifecycle_state PERMANECE CANCELLATION_REQUESTED. Só o admin move.
      const res = await upsertAlert({
        subjectType: "INSTANCE",
        subjectId: r.id,
        organizationId: r.organization_id,
        instanceId: r.id,
        channelId: null,
        alertType: "END_CONFIRMATION_REQUIRED",
        dedupeKey: dedupeKeyEndConfirmation(r.provider_access_until),
        payload: { provider_access_until: r.provider_access_until },
      });
      if (res === "failed") s.failed++;
      else s.processed++;
    } catch (e) {
      jsonLog("error", {
        reqId, evt: "wa_end_exception", instanceId: r.id,
        err: String(e), needsAdminAction: true,
      });
      s.failed++;
    }
  }
  return s;
}

/**
 * Passo 5a — divergências passivas. NENHUMA gera ação automática: não altera
 * lifecycle, não cancela instância, não bloqueia envio, e NENHUMA afirma que a
 * Z-API continua cobrando.
 */
async function stepDivergences(today: string): Promise<StepSummary> {
  const s: StepSummary = { step: "divergences", processed: 0, failed: 0 };
  const monthBrt = today.slice(0, 7);

  const { data: instances, error: instErr } = await supabase
    .from("whatsapp_instances")
    .select(
      "id, organization_id, lifecycle_state, channel_id, provider_instance_ref, ended_at, last_synced_at",
    )
    .neq("lifecycle_state", "AWAITING_PROVISION");

  if (instErr) {
    jsonLog("error", {
      reqId, evt: "wa_div_inst_query_failed", err: instErr.message, needsAdminAction: true,
    });
    s.failed++;
    // ABORTA O PASSO. Sem isto, `instances` fica undefined, `linked` nasce
    // vazio e TODO canal elegível vira CHANNEL_WITHOUT_INSTANCE — falso
    // positivo em massa que a chave mensal mantém OPEN por até um mês,
    // escondendo divergência real no meio do ruído.
    return s;
  }

  for (const r of instances ?? []) {
    try {
      // O identificador LEGADO vive em whatsapp_channels.credentials.instance_id.
      // Extrair SOMENTE o identificador — nunca copiar o objeto de credenciais
      // inteiro, nunca logar, nunca escrever de volta.
      let legacyRef: string | null = null;
      let channelState: string | null = null;
      let channelStateAgeDays: number | null = null;

      if (r.channel_id) {
        const { data: ch } = await supabase
          .from("whatsapp_channels")
          .select("credentials, status, updated_at")
          .eq("id", r.channel_id)
          .maybeSingle();
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

      const row: InstanceRow = {
        instanceId: r.id,
        organizationId: r.organization_id,
        lifecycleState: r.lifecycle_state,
        channelId: r.channel_id,
        providerInstanceRef: r.provider_instance_ref,
        legacyChannelInstanceRef: legacyRef,
        channelState,
        channelStateAgeDays,
        // Nesta fase não existe campo de explicação administrativa por
        // divergência: o admin resolve/dispensa o alerta com motivo, e o
        // dedupe impede reabertura. Passar `true` aqui sem esse campo seria
        // suprimir divergência sem registro.
        hasAdminExplanation: false,
        endedAtIso: r.ended_at,
        lastLocalSignalAtIso: r.last_synced_at,
      };

      for (const f of detectInstanceDivergences(row)) {
        const res = await upsertAlert({
          subjectType: "INSTANCE",
          subjectId: r.id,
          organizationId: f.organizationId,
          instanceId: f.instanceId,
          channelId: f.channelId,
          alertType: "DIVERGENCE",
          dedupeKey: f.dedupeKey,
          // Sem credencial, sem identificador legado, sem payload do provedor.
          payload: { kind: f.kind, detail: f.detail },
        });
        if (res === "failed") {
          s.failed++;
          continue;
        }
        s.processed++;

        await supabase.from("whatsapp_instances")
          .update({ last_divergence_kind: f.kind, last_divergence_at: new Date().toISOString() })
          .eq("id", r.id);
      }
    } catch (e) {
      jsonLog("error", {
        reqId, evt: "wa_div_exception", instanceId: r.id,
        err: String(e), needsAdminAction: true,
      });
      s.failed++;
    }
  }

  // CHANNEL_WITHOUT_INSTANCE — o custo invisível, o mais caro dos cinco.
  // whatsapp_channels não tem organization_id: a organização vem por units.
  const { data: channels, error: chErr } = await supabase
    .from("whatsapp_channels")
    .select("id, status, unit_id, credentials, last_event_at, units!inner(organization_id)");

  if (chErr) {
    jsonLog("error", {
      reqId, evt: "wa_div_chan_query_failed", err: chErr.message, needsAdminAction: true,
    });
    s.failed++;
    return s;
  }

  const linked = new Set((instances ?? []).map((i) => i.channel_id).filter(Boolean));

  for (const c of channels ?? []) {
    try {
      const row = c as unknown as {
        id: string;
        status: string | null;
        credentials: Record<string, unknown> | null;
        last_event_at: string | null;
        units?: { organization_id?: string };
      };
      const orgId = row.units?.organization_id;
      if (!orgId) continue;

      // Elegibilidade por EVIDÊNCIA PERSISTIDA, não por status transitório:
      // um canal com identificador de instância gravado, ou que já operou
      // (last_event_at), representa integração real que deveria estar no
      // inventário. Registro técnico incompleto — sem identificador e que
      // nunca operou — NÃO gera alerta. Na ambiguidade a resposta é não
      // inferir: nada aqui cria inventário automaticamente.
      const ref = (row.credentials ?? {})["instance_id"];
      const hasRef = typeof ref === "string" && ref.length > 0;
      const eligible = hasRef || !!row.last_event_at;

      const f = detectChannelWithoutInstance({
        channelId: row.id,
        organizationId: orgId,
        isEligibleInventoryChannel: eligible,
        hasLinkedInstance: linked.has(row.id),
        monthBrt,
      });
      if (!f) continue;

      const res = await upsertAlert({
        subjectType: "ORGANIZATION",
        subjectId: f.organizationId,
        organizationId: f.organizationId,
        instanceId: null,
        channelId: f.channelId,
        alertType: "DIVERGENCE",
        dedupeKey: f.dedupeKey,
        payload: { kind: f.kind, detail: f.detail },
      });
      if (res === "failed") s.failed++;
      else s.processed++;
    } catch (e) {
      jsonLog("error", {
        reqId, evt: "wa_div_chan_exception", err: String(e), needsAdminAction: true,
      });
      s.failed++;
    }
  }

  return s;
}

/** Passo 5b — pendências (data e custo) e desequilíbrio econômico da org. */
async function stepEconomics(today: string): Promise<StepSummary> {
  const s: StepSummary = { step: "economics", processed: 0, failed: 0 };
  const monthBrt = today.slice(0, 7);

  // Pendência de DATA: cycle_source UNKNOWN. O aviso NÃO afirma data nenhuma —
  // ele diz que a data falta, e o D-7 segue suprimido até a confirmação.
  // `dedupeKeyDateReview` leva o mês na frente, então cada mês abre UMA
  // ocorrência nova em vez de reemitir a mesma linha indefinidamente; a
  // confirmação da data resolve todas as ocorrências abertas da instância.
  //
  // Ausência de data NÃO é erro de implantação, NÃO bloqueia o uso da
  // instância existente e NÃO gera data padrão.
  const { data: unknownDate, error: unknownErr } = await supabase
    .from("whatsapp_instances")
    .select("id, organization_id")
    .eq("cycle_source", "UNKNOWN")
    .in("lifecycle_state", ["ACTIVE", "CANCELLATION_REQUESTED"]);

  // Sem capturar o erro, a falha vira `processed: 0, failed: 0` — indistinguível
  // de "nada a reportar". É exatamente o que o cabeçalho deste arquivo proíbe:
  // o sinal de falha é a TELEMETRIA, e ela não pode ser silêncio.
  if (unknownErr) {
    jsonLog("error", {
      reqId, evt: "wa_econ_unknown_date_query_failed",
      err: unknownErr.message, needsAdminAction: true,
    });
    s.failed++;
    return s;
  }

  for (const r of unknownDate ?? []) {
    const res = await upsertAlert({
      subjectType: "INSTANCE",
      subjectId: r.id,
      organizationId: r.organization_id,
      instanceId: r.id,
      channelId: null,
      alertType: "DATE_REVIEW_REQUIRED",
      dedupeKey: dedupeKeyDateReview(monthBrt, r.id),
      payload: { reason: "cycle_source UNKNOWN" },
    });
    if (res === "failed") s.failed++;
    else s.processed++;
  }

  // CUSTO DESCONHECIDO NÃO TEM ALERTA PRÓPRIO nesta fase. O ciclo em
  // PENDING_REVIEW aparece no painel e o fato entra como MOTIVO do D-1
  // (`COST_UNKNOWN` em resolveD1Reasons), que é quando ele é acionável — há
  // uma cobrança chegando. Criar um tipo só porque um valor está NULL
  // multiplicaria avisos sem multiplicar decisão.

  // Desequilíbrio pertence à ORGANIZAÇÃO.
  const { data: all, error: allErr } = await supabase
    .from("whatsapp_instances")
    .select("id, organization_id, current_monthly_cost_cents")
    .in("lifecycle_state", ["ACTIVE", "CANCELLATION_REQUESTED"]);

  // Esta é a base do ÚNICO mecanismo de detecção de prejuízo da fase. Falhar
  // em silêncio aqui é uma janela cega sobre desequilíbrio econômico.
  if (allErr) {
    jsonLog("error", {
      reqId, evt: "wa_econ_instances_query_failed",
      err: allErr.message, needsAdminAction: true,
    });
    s.failed++;
    return s;
  }

  const byOrg = new Map<string, { instanceId: string; costCents: number | null }[]>();
  for (const i of all ?? []) {
    const list = byOrg.get(i.organization_id) ?? [];
    list.push({ instanceId: i.id, costCents: i.current_monthly_cost_cents });
    byOrg.set(i.organization_id, list);
  }

  for (const [orgId, items] of byOrg) {
    try {
      const revenue = await resolveRevenueForOrg(orgId);

      // LIFETIME_OVERRIDE NÃO É ERRO: margem negativa do cliente cortesia é o
      // custo conhecido de uma decisão comercial. Aparece rotulada no painel e
      // nunca vira alerta de anomalia.
      if (revenue.revenueSource === "LIFETIME_OVERRIDE") continue;

      // Receita NULL por ambiguidade é DADO AUSENTE, não prejuízo.
      const isNoEntitlement = revenue.revenueSource === "NO_ENTITLEMENT";
      const cons = consolidateOrgMargin(items.map((i) => i.costCents), revenue.customerRevenueCents);
      const negative = cons.marginCents !== null && cons.marginCents < 0;

      if (!isNoEntitlement && !negative) continue;

      const res = await upsertAlert({
        subjectType: "ORGANIZATION",
        subjectId: orgId,
        organizationId: orgId,
        instanceId: null,
        channelId: null,
        alertType: "ECONOMIC_IMBALANCE",
        dedupeKey: dedupeKeyEconomicImbalance(
          monthBrt,
          economicImbalanceHash(items, revenue.customerRevenueCents),
        ),
        payload: {
          revenue_source: revenue.revenueSource,
          known_cost_cents: cons.knownCostCents,
          unknown_cost_instances: cons.unknownCostInstances,
          margin_cents: cons.marginCents,
        },
      });
      if (res === "failed") s.failed++;
      else s.processed++;
    } catch (e) {
      jsonLog("error", {
        reqId, evt: "wa_econ_exception", orgId, err: String(e), needsAdminAction: true,
      });
      s.failed++;
    }
  }

  return s;
}

serve(async (req) => {
  if (!requireInternalAuth(req)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  reqId = genRequestId();
  // Zerado a CADA invocação, pelo mesmo motivo que process-voucher-triggers
  // zera o unitCache: o isolate sobrevive entre execuções. Sem isto, um `null`
  // cacheado (nenhum platform_admin no momento da 1ª execução) sobreviveria à
  // criação de um admin e todo aviso nasceria mudo — sem erro, sem sinal.
  adminRecipient = undefined;
  const today = todayBrt();
  jsonLog("info", { reqId, evt: "wa_instance_cycles_start", today });

  const steps: StepSummary[] = [];
  let lockHeld = false;

  try {
    // Lock economiza trabalho; NÃO é o invariante. A correção vem da RPC
    // transacional + os dois UNIQUE. Falha aberta é aceitável.
    const { data: got } = await supabase.rpc("try_whatsapp_instance_cycles_lock");
    lockHeld = got === true;
    if (!lockHeld) jsonLog("warn", { reqId, evt: "wa_lock_not_acquired" });

    // Falha em um passo NÃO aborta os seguintes.
    steps.push(await stepRollCycles(today));
    steps.push(...(await stepCycleAlerts(today)));
    steps.push(await stepEndConfirmation(today));
    steps.push(await stepDivergences(today));
    steps.push(await stepEconomics(today));

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
