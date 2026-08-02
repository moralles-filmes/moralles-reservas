// Núcleo do worker de ciclos da instância (Fase 6b) — decisão e fluxo.
//
// POR QUE ESTE ARQUIVO EXISTE: o worker chama `serve()` no carregamento do
// módulo e importa `deno.land` e `esm.sh`, então vitest não consegue importá-lo.
// Toda correção nele só podia ser verificada por LEITURA — e leitura foi
// exatamente o que deixou passar um `ReferenceError` no caminho de autorização
// e um conflito FK × CHECK por duas auditorias seguidas. Com o núcleo separado,
// contador, política de lembrete, decisão de enfileirar e isolamento entre
// passos passam a ser afirmados por teste.
//
// NÃO IMPORTA Supabase, Deno, fetch, variável de ambiente nem cliente de
// provedor. Tudo que toca o mundo entra por injeção (`WorkerDeps`).
//
// NUNCA CHAMA A Z-API — nem aqui, nem no adapter. Divergência nesta fase é
// comparação entre fatos já persistidos.
//
// NÃO ESCREVE em organizations.billing_status, billing_subscriptions,
// organization_entitlement_overrides nem whatsapp_channels.

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
} from "./whatsapp-instance-alerts-core.ts";
import { nextDueFromAnchor, daysUntil } from "./whatsapp-instance-cycle-core.ts";
import {
  consolidateOrgMargin,
  type RevenueAttribution,
} from "./whatsapp-instance-revenue-core.ts";
import {
  detectChannelWithoutInstance,
  detectInstanceDivergences,
  type InstanceRow,
} from "./whatsapp-instance-divergence-core.ts";

/** Lembrete MENSAL e não diário: aviso diário treina o admin a ignorar. */
export const REMINDER_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────
// Contadores
// ─────────────────────────────────────────────────────────────────────────

export type StepSummary = { step: string; processed: number; failed: number };

export function tally(step: string): StepSummary {
  return { step, processed: 0, failed: 0 };
}

// ─────────────────────────────────────────────────────────────────────────
// Dependências injetadas
// ─────────────────────────────────────────────────────────────────────────

export type Clock = { nowMs(): number; nowIso(): string };

export type Telemetry = {
  info(e: Record<string, unknown>): void;
  warn(e: Record<string, unknown>): void;
  error(e: Record<string, unknown>): void;
};

/**
 * `matched` é o que distingue "atualizei" de "o predicado não casou".
 *
 * PostgREST devolve `error: null` num UPDATE que não casa LINHA NENHUMA. Sem
 * esta contagem, um alerta de outra organização (predicado de tenant negando)
 * era indistinguível de sucesso — e o worker seguia enfileirando o e-mail.
 */
export type TouchResult =
  | { ok: true; matched: number }
  | { ok: false; message: string };

/**
 * O `id` volta do INSERT porque a criação precisa carimbar o slot de lembrete
 * logo em seguida — e reler a linha pela chave de dedupe para descobrir o id
 * seria uma segunda ida ao banco por um dado que o INSERT já tem.
 */
export type InsertResult =
  | { ok: true; id: string }
  | { ok: false; duplicate: boolean; message: string };

export type ExistingAlert = {
  id: string;
  status: string;
  occurrences: number;
  lastReminderAt: string | null;
};

export type AlertKey = {
  subjectType: "INSTANCE" | "ORGANIZATION";
  subjectId: string;
  alertType: AlertType;
  dedupeKey: string;
};

export type AlertInput = AlertKey & {
  organizationId: string;
  instanceId: string | null;
  channelId: string | null;
  payload: Record<string, unknown>;
};

export type AlertRepo = {
  find(k: AlertKey): Promise<ExistingAlert | null>;
  insert(a: AlertInput & { nowIso: string }): Promise<InsertResult>;
  /** Reescreve payload e `last_seen_at`; avança lembrete só quando `remind`. */
  touch(t: {
    id: string;
    organizationId: string;
    nowIso: string;
    occurrences: number;
    lastReminderAt: string | null;
    payload: Record<string, unknown>;
  }): Promise<TouchResult>;
  /** Carimba o slot de lembrete consumido pela CRIAÇÃO. */
  stampReminder(t: { id: string; organizationId: string; nowIso: string }): Promise<TouchResult>;
};

export type Notifier = {
  /** `true` = está na fila (inclusive por dedupe). `false` = não está. */
  enqueue(organizationId: string, eventType: string): Promise<boolean>;
};

export type RecipientResolver = {
  /** Resolvido UMA vez por invocação pelo adapter. `null` = não há para quem avisar. */
  resolve(): Promise<string | null>;
};

export type CycleInstance = {
  id: string;
  organizationId: string;
  lifecycleState: string;
  cycleSource: string | null;
  cycleStartedOn: string | null;
  cycleDueOn: string | null;
  monthlyCostCents: number | null;
  providerAccessUntil: string | null;
  anchorDay: number | null;
};

export type ChannelForDivergence = {
  channelId: string;
  organizationId: string | null;
  hasLegacyRef: boolean;
  hasEverOperated: boolean;
};

export type Query<T> = { ok: true; rows: T[] } | { ok: false; message: string };
export type Fetch<T> = { ok: true; value: T } | { ok: false; message: string };

export type WorkerRepo = {
  listRollCandidates(today: string): Promise<Query<CycleInstance>>;
  rollCycle(a: { instanceId: string; today: string; nextDueOn: string }): Promise<Fetch<string | null>>;

  listCycleInstances(): Promise<Query<CycleInstance>>;
  resolveRevenue(organizationId: string): Promise<Fetch<RevenueAttribution>>;
  hasOpenDivergence(instanceId: string): Promise<Fetch<boolean>>;

  listEndConfirmationCandidates(today: string): Promise<Query<CycleInstance & { endConfirmationRequiredAt: string | null }>>;
  stampEndConfirmationRequired(instanceId: string, nowIso: string): Promise<{ ok: true } | { ok: false; message: string }>;

  listDivergenceInstances(): Promise<Query<InstanceRow>>;
  listInventoryChannels(): Promise<Query<ChannelForDivergence>>;
  recordDivergenceKind(instanceId: string, kind: string, nowIso: string): Promise<void>;

  listDateReviewPending(): Promise<Query<{ id: string; organizationId: string }>>;
  listEconomicInstances(): Promise<Query<{ id: string; organizationId: string; costCents: number | null }>>;
};

export type WorkerDeps = {
  clock: Clock;
  telemetry: Telemetry;
  alerts: AlertRepo;
  notifier: Notifier;
  recipients: RecipientResolver;
  repo: WorkerRepo;
  reqId: string;
};

// ─────────────────────────────────────────────────────────────────────────
// Decisão do alerta — o coração da política
// ─────────────────────────────────────────────────────────────────────────

export type AlertOutcome =
  | "created"
  /** Lembrete reemitido: o slot mensal foi consumido E o aviso está na fila. */
  | "reminded"
  /** Registrado, sem lembrete: dentro da janela mensal. */
  | "seen"
  /** Chave já encerrada no ledger — nada é reaberto, mas o fato é logado. */
  | "suppressed"
  | "failed";

/**
 * Cria o alerta ou reemite o lembrete. O ledger é INDEPENDENTE da fila de
 * e-mail: com `billing_notifications_dispatch` OFF o alerta continua
 * registrado, e `dispatch_enabled_at_enqueue` diz se havia envio no momento —
 * para que ninguém leia "não recebi e-mail" como "não houve alerta".
 *
 * DUAS REGRAS GOVERNAM O SLOT MENSAL, e as duas nasceram de defeito real:
 *
 *  1. O slot só é consumido se houver PARA QUEM avisar. Avançar
 *     `last_reminder_at` antes de saber disso empurra o próximo lembrete real
 *     por 30 dias sem que e-mail nenhum tenha saído.
 *  2. O slot só é consumido se o enfileiramento CONFIRMAR. `enqueue` devolve
 *     `false` quando a linha não entrou na fila; gravar "lembrado" em cima
 *     disso é a mesma perda, por outro caminho.
 *
 * A CRIAÇÃO também consome o slot. Sem isso, `last_reminder_at` nascia NULL, o
 * cálculo `nowMs - 0 >= 30 dias` dava verdadeiro na execução seguinte, e o
 * lembrete "mensal" disparava no DIA SEGUINTE ao nascimento do alerta.
 */
export async function upsertAlert(deps: WorkerDeps, a: AlertInput): Promise<AlertOutcome> {
  const nowIso = deps.clock.nowIso();
  const key: AlertKey = {
    subjectType: a.subjectType,
    subjectId: a.subjectId,
    alertType: a.alertType,
    dedupeKey: a.dedupeKey,
  };

  let existing: ExistingAlert | null;
  try {
    existing = await deps.alerts.find(key);
  } catch (e) {
    deps.telemetry.error({
      reqId: deps.reqId, evt: "wa_alert_lookup_failed", alertType: a.alertType,
      err: String(e), needsAdminAction: true,
    });
    return "failed";
  }

  if (!existing) return await createAlert(deps, a, nowIso);

  if (existing.status !== "OPEN") {
    // Fato que reincide sob uma chave já ACKNOWLEDGED/RESOLVED/SUPERSEDED NÃO
    // reabre — a dedupe é deliberada. Mas o silêncio não era: `"seen"` mudo
    // tornava impossível distinguir "nada mudou" de "o alerta está suprimido
    // por uma decisão administrativa anterior".
    deps.telemetry.info({
      reqId: deps.reqId, evt: "wa_alert_suppressed_by_closed_ledger",
      alertType: a.alertType, alertId: existing.id, ledgerStatus: existing.status,
    });
    return "suppressed";
  }

  const last = existing.lastReminderAt ? Date.parse(existing.lastReminderAt) : 0;
  const due = deps.clock.nowMs() - last >= REMINDER_INTERVAL_MS;

  const recipient = due ? await deps.recipients.resolve() : null;
  if (due && !recipient) {
    deps.telemetry.error({
      reqId: deps.reqId, evt: "wa_alert_reminder_no_recipient",
      alertType: a.alertType, needsAdminAction: true,
    });
  }

  // O enfileiramento vem ANTES da escrita do lembrete: só o que entrou na fila
  // pode consumir o slot. A ordem inversa gravava "lembrado" sobre um envio que
  // podia nunca ter sido enfileirado.
  let enqueued = false;
  if (due && recipient) {
    enqueued = await enqueueAlert(deps, a.alertType, a.organizationId);
    if (!enqueued) {
      deps.telemetry.error({
        reqId: deps.reqId, evt: "wa_alert_enqueue_failed_window_preserved",
        alertType: a.alertType, needsAdminAction: true,
      });
    }
  }
  const remind = due && !!recipient && enqueued;

  const touched = await deps.alerts.touch({
    id: existing.id,
    organizationId: a.organizationId,
    nowIso,
    occurrences: existing.occurrences + (remind ? 1 : 0),
    // Payload REESCRITO a cada passada. A chave do D-1 deixou de carregar os
    // motivos justamente para não abrir linha nova quando eles mudam — se o
    // payload não acompanhasse, o admin leria a lista do primeiro dia como se
    // ainda valesse.
    lastReminderAt: remind ? nowIso : existing.lastReminderAt,
    payload: a.payload,
  });

  if (touched.ok === false) {
    deps.telemetry.error({
      reqId: deps.reqId, evt: "wa_alert_touch_failed", alertType: a.alertType,
      err: touched.message, needsAdminAction: true,
    });
    return "failed";
  }

  if (touched.matched === 0) {
    // Zero linhas casadas com `error: null`. O predicado inclui
    // `organization_id`: chegar aqui significa que o alerta não pertence à
    // organização informada, ou sumiu entre o SELECT e o UPDATE. Nos dois
    // casos, nada foi escrito — tratar como sucesso enfileiraria um aviso
    // sobre um registro que este worker não tocou.
    deps.telemetry.error({
      reqId: deps.reqId, evt: "wa_alert_touch_no_rows", alertType: a.alertType,
      alertId: existing.id, needsAdminAction: true,
    });
    return "failed";
  }

  return remind ? "reminded" : "seen";
}

async function createAlert(
  deps: WorkerDeps,
  a: AlertInput,
  nowIso: string,
): Promise<AlertOutcome> {
  const res = await deps.alerts.insert({ ...a, nowIso });

  if (res.ok === false) {
    if (res.duplicate) {
      // Outra execução criou entre o SELECT e o INSERT — ela já enfileirou.
      return "seen";
    }
    deps.telemetry.error({
      reqId: deps.reqId, evt: "wa_alert_insert_failed", alertType: a.alertType,
      err: res.message, needsAdminAction: true,
    });
    return "failed";
  }

  // Enfileiramento acoplado à CRIAÇÃO no ledger, num ponto único: caller que
  // esqueça de enfileirar produziria alerta mudo, e o ledger é quem sabe se o
  // fato é novo.
  const enqueued = await enqueueAlert(deps, a.alertType, a.organizationId);
  if (!enqueued) {
    // Alerta existe, aviso não saiu. `last_reminder_at` fica NULL de propósito:
    // a próxima passada encontra a linha aberta, vê a janela vencida e tenta
    // enfileirar de novo. Retry sem duplicar registro.
    deps.telemetry.error({
      reqId: deps.reqId, evt: "wa_alert_created_enqueue_failed",
      alertType: a.alertType, needsAdminAction: true,
    });
    return "created";
  }

  const stamped = await deps.alerts.stampReminder({
    id: res.id,
    organizationId: a.organizationId,
    nowIso,
  });
  if (stamped.ok === false) {
    deps.telemetry.warn({
      reqId: deps.reqId, evt: "wa_alert_stamp_reminder_failed",
      alertType: a.alertType, err: stamped.message,
    });
  }
  return "created";
}

async function enqueueAlert(
  deps: WorkerDeps,
  alertType: AlertType,
  organizationId: string,
): Promise<boolean> {
  const recipient = await deps.recipients.resolve();
  if (!recipient) return false;
  return await deps.notifier.enqueue(organizationId, EVENT_TYPE_BY_ALERT[alertType]);
}

// ─────────────────────────────────────────────────────────────────────────
// Passo 1 — rolagem. PRECEDE tudo: muda as datas que os passos 2-3 leem.
// ─────────────────────────────────────────────────────────────────────────

export async function runRollCyclesStep(deps: WorkerDeps, today: string): Promise<StepSummary> {
  const s = tally("roll_cycles");

  const q = await deps.repo.listRollCandidates(today);
  if (q.ok === false) {
    deps.telemetry.error({
      reqId: deps.reqId, evt: "wa_roll_query_failed", err: q.message, needsAdminAction: true,
    });
    s.failed++;
    return s;
  }

  for (const r of q.rows) {
    // Falha em UMA instância não aborta as demais.
    try {
      if (!r.anchorDay || !r.cycleDueOn) {
        // Sem âncora não há rolagem honesta — a pendência de data já existe.
        deps.telemetry.warn({ reqId: deps.reqId, evt: "wa_roll_skipped_no_anchor", instanceId: r.id });
        continue;
      }
      // A aritmética vem do núcleo puro; a RPC só persiste.
      const nextDue = nextDueFromAnchor(r.cycleDueOn, r.anchorDay);
      const res = await deps.repo.rollCycle({ instanceId: r.id, today, nextDueOn: nextDue });
      if (res.ok === false) {
        deps.telemetry.error({
          reqId: deps.reqId, evt: "wa_roll_failed", instanceId: r.id,
          err: res.message, needsAdminAction: true,
        });
        s.failed++;
        continue;
      }
      s.processed++;
      deps.telemetry.info({ reqId: deps.reqId, evt: "wa_roll_done", instanceId: r.id, action: res.value });
    } catch (e) {
      deps.telemetry.error({
        reqId: deps.reqId, evt: "wa_roll_exception", instanceId: r.id,
        err: String(e), needsAdminAction: true,
      });
      s.failed++;
    }
  }
  return s;
}

// ─────────────────────────────────────────────────────────────────────────
// Passos 2 e 3 — D-7 sempre, D-1 condicional. D-3 não existe: três avisos para
// a mesma data é a cadência que produz cegueira.
// ─────────────────────────────────────────────────────────────────────────

export async function runCycleAlertsStep(deps: WorkerDeps, today: string): Promise<StepSummary[]> {
  const d7 = tally("alerts_d7");
  const d1 = tally("alerts_d1");

  const q = await deps.repo.listCycleInstances();
  if (q.ok === false) {
    deps.telemetry.error({
      reqId: deps.reqId, evt: "wa_alerts_query_failed", err: q.message, needsAdminAction: true,
    });
    d7.failed++;
    return [d7, d1];
  }

  for (const r of q.rows) {
    // Fase corrente da iteração. Tudo depois do bloco D-7 — inclusive a leitura
    // de receita e de divergência, que só alimentam o D-1 — precisa cair no
    // contador do D-1. Creditar sempre ao D-7 fazia o resumo dizer
    // `alerts_d1: { failed: 0 }` justamente quando o D-1 falhou, e o D-1 é o
    // aviso urgente: há cobrança chegando amanhã.
    let phase: "d7" | "d1" = "d7";
    try {
      // cycle_source UNKNOWN não emite D-7/D-1: a instância está na fila de
      // revisão de data e nenhum aviso pode AFIRMAR uma data que ninguém
      // confirmou.
      if (r.cycleSource === "UNKNOWN" || !r.cycleDueOn) continue;

      const days = daysUntil(r.cycleDueOn, today);

      if (shouldEmitD7(days)) {
        const res = await upsertAlert(deps, {
          subjectType: "INSTANCE",
          subjectId: r.id,
          organizationId: r.organizationId,
          instanceId: r.id,
          channelId: null,
          alertType: "CYCLE_DUE_SOON",
          dedupeKey: dedupeKeyD7(r.cycleStartedOn ?? ""),
          payload: { days_until_due: days, due_on: r.cycleDueOn },
        });
        if (res === "failed") d7.failed++;
        else d7.processed++;
      }

      phase = "d1";

      // Receita atribuída para distinguir "receita NULL prevista" de lacuna.
      const revenue = await deps.repo.resolveRevenue(r.organizationId);
      if (revenue.ok === false) throw new Error(`revenue_query_failed: ${revenue.message}`);

      const divergence = await deps.repo.hasOpenDivergence(r.id);
      // Falha de leitura devolveria `false` — "não há divergência aberta" — que
      // é justamente um dos motivos que tornam o D-1 acionável. Silenciar o
      // motivo por soluço de rede é pior que pular a instância nesta passada.
      if (divergence.ok === false) throw new Error(`divergence_lookup_failed: ${divergence.message}`);

      const reasons = resolveD1Reasons({
        costCents: r.monthlyCostCents,
        hasOpenDivergence: divergence.value,
        cancellationIntendedNotRegistered:
          r.lifecycleState === "CANCELLATION_REQUESTED" && !r.providerAccessUntil,
        revenueSource: revenue.value.revenueSource,
        customerRevenueCents: revenue.value.customerRevenueCents,
      });

      if (shouldEmitD1(days, reasons)) {
        const res = await upsertAlert(deps, {
          subjectType: "INSTANCE",
          subjectId: r.id,
          organizationId: r.organizationId,
          instanceId: r.id,
          channelId: null,
          alertType: "CYCLE_DUE_TOMORROW",
          dedupeKey: dedupeKeyD1(r.cycleStartedOn ?? ""),
          payload: { days_until_due: days, reasons },
        });
        if (res === "failed") d1.failed++;
        else d1.processed++;
      }
    } catch (e) {
      deps.telemetry.error({
        reqId: deps.reqId, evt: "wa_alerts_exception", instanceId: r.id, phase,
        err: String(e), needsAdminAction: true,
      });
      if (phase === "d1") d1.failed++;
      else d7.failed++;
    }
  }
  return [d7, d1];
}

// ─────────────────────────────────────────────────────────────────────────
// Passo 4 — "worker propõe, admin confirma". O worker NÃO move para ENDED só
// porque a data passou: afirmar um encerramento que o fornecedor não fez é a
// família do bug 08.
// ─────────────────────────────────────────────────────────────────────────

export async function runEndConfirmationStep(deps: WorkerDeps, today: string): Promise<StepSummary> {
  const s = tally("end_confirmation");

  const q = await deps.repo.listEndConfirmationCandidates(today);
  if (q.ok === false) {
    deps.telemetry.error({
      reqId: deps.reqId, evt: "wa_end_query_failed", err: q.message, needsAdminAction: true,
    });
    s.failed++;
    return s;
  }

  for (const r of q.rows) {
    try {
      if (!r.endConfirmationRequiredAt) {
        const stamp = await deps.repo.stampEndConfirmationRequired(r.id, deps.clock.nowIso());
        if (stamp.ok === false) {
          deps.telemetry.error({
            reqId: deps.reqId, evt: "wa_end_stamp_failed", instanceId: r.id,
            err: stamp.message, needsAdminAction: true,
          });
          s.failed++;
          continue;
        }
      }

      // lifecycle_state PERMANECE CANCELLATION_REQUESTED. Só o admin move.
      const res = await upsertAlert(deps, {
        subjectType: "INSTANCE",
        subjectId: r.id,
        organizationId: r.organizationId,
        instanceId: r.id,
        channelId: null,
        alertType: "END_CONFIRMATION_REQUIRED",
        dedupeKey: dedupeKeyEndConfirmation(r.providerAccessUntil ?? ""),
        payload: { provider_access_until: r.providerAccessUntil },
      });
      if (res === "failed") s.failed++;
      else s.processed++;
    } catch (e) {
      deps.telemetry.error({
        reqId: deps.reqId, evt: "wa_end_exception", instanceId: r.id,
        err: String(e), needsAdminAction: true,
      });
      s.failed++;
    }
  }
  return s;
}

// ─────────────────────────────────────────────────────────────────────────
// Passo 5a — divergências passivas. NENHUMA gera ação automática.
// ─────────────────────────────────────────────────────────────────────────

export async function runDivergencesStep(deps: WorkerDeps, today: string): Promise<StepSummary> {
  const s = tally("divergences");
  const monthBrt = today.slice(0, 7);

  const inst = await deps.repo.listDivergenceInstances();
  if (inst.ok === false) {
    deps.telemetry.error({
      reqId: deps.reqId, evt: "wa_div_inst_query_failed", err: inst.message, needsAdminAction: true,
    });
    s.failed++;
    // ABORTA O PASSO. Sem isto, a lista de instâncias nasce vazia e TODO canal
    // elegível vira CHANNEL_WITHOUT_INSTANCE — falso positivo em massa que a
    // chave mensal mantém OPEN por até um mês, escondendo divergência real no
    // meio do ruído.
    return s;
  }

  for (const row of inst.rows) {
    try {
      for (const f of detectInstanceDivergences(row)) {
        const res = await upsertAlert(deps, {
          subjectType: "INSTANCE",
          subjectId: row.instanceId,
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
        await deps.repo.recordDivergenceKind(row.instanceId, f.kind, deps.clock.nowIso());
      }
    } catch (e) {
      deps.telemetry.error({
        reqId: deps.reqId, evt: "wa_div_exception", instanceId: row.instanceId,
        err: String(e), needsAdminAction: true,
      });
      s.failed++;
    }
  }

  // CHANNEL_WITHOUT_INSTANCE — o custo invisível, o mais caro dos cinco.
  const chans = await deps.repo.listInventoryChannels();
  if (chans.ok === false) {
    deps.telemetry.error({
      reqId: deps.reqId, evt: "wa_div_chan_query_failed", err: chans.message, needsAdminAction: true,
    });
    s.failed++;
    return s;
  }

  const linked = new Set(inst.rows.map((i) => i.channelId).filter(Boolean));

  for (const c of chans.rows) {
    try {
      if (!c.organizationId) continue;

      // Elegibilidade por EVIDÊNCIA PERSISTIDA, não por status transitório: um
      // canal com identificador de instância gravado, ou que já operou,
      // representa integração real que deveria estar no inventário. Registro
      // técnico incompleto NÃO gera alerta — na ambiguidade a resposta é não
      // inferir; nada aqui cria inventário automaticamente.
      const f = detectChannelWithoutInstance({
        channelId: c.channelId,
        organizationId: c.organizationId,
        isEligibleInventoryChannel: c.hasLegacyRef || c.hasEverOperated,
        hasLinkedInstance: linked.has(c.channelId),
        monthBrt,
      });
      if (!f) continue;

      const res = await upsertAlert(deps, {
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
      deps.telemetry.error({
        reqId: deps.reqId, evt: "wa_div_chan_exception", err: String(e), needsAdminAction: true,
      });
      s.failed++;
    }
  }

  return s;
}

// ─────────────────────────────────────────────────────────────────────────
// Passo 5b — pendências (data) e desequilíbrio econômico da organização.
// ─────────────────────────────────────────────────────────────────────────

export async function runEconomicsStep(deps: WorkerDeps, today: string): Promise<StepSummary> {
  const s = tally("economics");
  const monthBrt = today.slice(0, 7);

  // CONTADORES SEPARADOS por sub-passo. Um contador único fazia o resumo dizer
  // `imbalancesReported: 3` quando o que existiam eram três pendências de DATA
  // — num passo cuja função é detectar prejuízo, isso é um número inventado.
  const dateReview = { processed: 0, failed: 0 };
  const imbalance = { processed: 0, failed: 0 };

  // Pendência de DATA: cycle_source UNKNOWN. O aviso NÃO afirma data nenhuma —
  // ele diz que a data falta, e o D-7 segue suprimido até a confirmação.
  // Ausência de data NÃO é erro de implantação, NÃO bloqueia o uso da instância
  // existente e NÃO gera data padrão.
  const pending = await deps.repo.listDateReviewPending();
  if (pending.ok === false) {
    // Sem capturar o erro, a falha vira `processed: 0, failed: 0` —
    // indistinguível de "nada a reportar". O sinal de falha é a TELEMETRIA, e
    // ela não pode ser silêncio.
    deps.telemetry.error({
      reqId: deps.reqId, evt: "wa_econ_unknown_date_query_failed",
      err: pending.message, needsAdminAction: true,
    });
    s.failed++;
    return s;
  }

  for (const r of pending.rows) {
    try {
      const res = await upsertAlert(deps, {
        subjectType: "INSTANCE",
        subjectId: r.id,
        organizationId: r.organizationId,
        instanceId: r.id,
        channelId: null,
        alertType: "DATE_REVIEW_REQUIRED",
        dedupeKey: dedupeKeyDateReview(monthBrt, r.id),
        payload: { reason: "cycle_source UNKNOWN" },
      });
      if (res === "failed") dateReview.failed++;
      else dateReview.processed++;
    } catch (e) {
      deps.telemetry.error({
        reqId: deps.reqId, evt: "wa_econ_date_review_exception", instanceId: r.id,
        err: String(e), needsAdminAction: true,
      });
      dateReview.failed++;
    }
  }

  // CUSTO DESCONHECIDO NÃO TEM ALERTA PRÓPRIO nesta fase. O ciclo em
  // PENDING_REVIEW aparece no painel e o fato entra como MOTIVO do D-1
  // (`COST_UNKNOWN`), que é quando ele é acionável — há uma cobrança chegando.

  const all = await deps.repo.listEconomicInstances();
  // Esta é a base do ÚNICO mecanismo de detecção de prejuízo da fase. Falhar em
  // silêncio aqui é uma janela cega sobre desequilíbrio econômico.
  if (all.ok === false) {
    deps.telemetry.error({
      reqId: deps.reqId, evt: "wa_econ_instances_query_failed",
      err: all.message, needsAdminAction: true,
    });
    s.processed = dateReview.processed;
    s.failed = dateReview.failed + 1;
    return s;
  }

  const byOrg = new Map<string, { instanceId: string; costCents: number | null }[]>();
  for (const i of all.rows) {
    const list = byOrg.get(i.organizationId) ?? [];
    list.push({ instanceId: i.id, costCents: i.costCents });
    byOrg.set(i.organizationId, list);
  }

  for (const [orgId, items] of byOrg) {
    try {
      const revenue = await deps.repo.resolveRevenue(orgId);
      if (revenue.ok === false) throw new Error(`revenue_query_failed: ${revenue.message}`);

      // LIFETIME_OVERRIDE NÃO É ERRO: margem negativa do cliente cortesia é o
      // custo conhecido de uma decisão comercial. Aparece rotulada no painel e
      // nunca vira alerta de anomalia.
      if (revenue.value.revenueSource === "LIFETIME_OVERRIDE") continue;

      // Receita NULL por ambiguidade é DADO AUSENTE, não prejuízo.
      const isNoEntitlement = revenue.value.revenueSource === "NO_ENTITLEMENT";
      const cons = consolidateOrgMargin(
        items.map((i) => i.costCents),
        revenue.value.customerRevenueCents,
      );
      const negative = cons.marginCents !== null && cons.marginCents < 0;

      if (!isNoEntitlement && !negative) continue;

      const res = await upsertAlert(deps, {
        subjectType: "ORGANIZATION",
        subjectId: orgId,
        organizationId: orgId,
        instanceId: null,
        channelId: null,
        alertType: "ECONOMIC_IMBALANCE",
        dedupeKey: dedupeKeyEconomicImbalance(
          monthBrt,
          economicImbalanceHash(items, revenue.value.customerRevenueCents),
        ),
        payload: {
          revenue_source: revenue.value.revenueSource,
          known_cost_cents: cons.knownCostCents,
          unknown_cost_instances: cons.unknownCostInstances,
          margin_cents: cons.marginCents,
        },
      });
      if (res === "failed") imbalance.failed++;
      else imbalance.processed++;
    } catch (e) {
      deps.telemetry.error({
        reqId: deps.reqId, evt: "wa_econ_exception", orgId, err: String(e), needsAdminAction: true,
      });
      imbalance.failed++;
    }
  }

  // "Nenhuma organização elegível" e "nenhum desequilíbrio" produziam o MESMO
  // `{processed: 0, failed: 0}`. Num passo cuja função é detectar prejuízo,
  // silêncio ambíguo não é resultado — os dois casos passam a ser afirmados.
  deps.telemetry.info({
    reqId: deps.reqId,
    evt: "wa_econ_scan_done",
    eligibleOrgs: byOrg.size,
    dateReviewPending: pending.rows.length,
    dateReviewProcessed: dateReview.processed,
    imbalancesReported: imbalance.processed,
  });

  s.processed = dateReview.processed + imbalance.processed;
  s.failed = dateReview.failed + imbalance.failed;
  return s;
}

// ─────────────────────────────────────────────────────────────────────────
// Orquestração dos cinco passos
// ─────────────────────────────────────────────────────────────────────────

/**
 * A ORDEM É SIGNIFICATIVA: a rolagem precede tudo porque muda as datas que os
 * alertas leem. Falha em um passo NÃO aborta os seguintes — cada um devolve o
 * próprio resumo e o sinal de falha é a telemetria, não o corte do fluxo.
 */
export async function runAllSteps(deps: WorkerDeps, today: string): Promise<StepSummary[]> {
  const steps: StepSummary[] = [];
  steps.push(await runRollCyclesStep(deps, today));
  steps.push(...(await runCycleAlertsStep(deps, today)));
  steps.push(await runEndConfirmationStep(deps, today));
  steps.push(await runDivergencesStep(deps, today));
  steps.push(await runEconomicsStep(deps, today));
  return steps;
}
