// Testes do núcleo do worker de ciclos (Fase 6b).
//
// Estes testes existem porque o worker NÃO era importável por vitest: ele chama
// `serve()` no carregamento e importa `deno.land`/`esm.sh`. Cada correção nele
// só podia ser verificada por leitura — e leitura deixou passar um
// `ReferenceError` no caminho de autorização e um conflito FK × CHECK por duas
// auditorias seguidas.
//
// NÃO SUBSTITUEM TESTE DE BANCO. CHECK, FK, índice parcial, RLS, grant,
// SECURITY DEFINER, trigger e concorrência real da RPC continuam
// ENVIRONMENT_BLOCKED — sem Docker, nada disso é declarável verde.

import { describe, it, expect } from "vitest";
import {
  REMINDER_INTERVAL_MS,
  runCycleAlertsStep,
  runDivergencesStep,
  runEconomicsStep,
  runEndConfirmationStep,
  runRollCyclesStep,
  upsertAlert,
  type AlertInput,
  type AlertRepo,
  type ExistingAlert,
  type WorkerDeps,
  type WorkerRepo,
} from "../../supabase/functions/_shared/whatsapp-instance-worker-core";

// ─────────────────────────────────────────────────────────────────────────
// Bancada
// ─────────────────────────────────────────────────────────────────────────

const ORG = "11111111-1111-4111-8111-111111111111";
const INST = "22222222-2222-4222-8222-222222222222";
const DAY = 24 * 60 * 60 * 1000;

type Log = { level: string; evt: string; e: Record<string, unknown> };

function makeBench(opts: {
  nowMs?: number;
  existing?: ExistingAlert | null;
  findThrows?: boolean;
  insert?: AlertRepo["insert"];
  touchMatched?: number;
  touchFails?: string;
  stampFails?: string;
  recipient?: string | null;
  recipientSequence?: (string | null)[];
  enqueueOk?: boolean;
  repo?: Partial<WorkerRepo>;
}) {
  const logs: Log[] = [];
  const enqueued: { org: string; eventType: string }[] = [];
  const touches: { lastReminderAt: string | null; occurrences: number; payload: unknown }[] = [];
  const stamps: { nowIso: string; occurrences?: number }[] = [];
  const inserted: AlertInput[] = [];
  let recipientCalls = 0;

  const nowMs = opts.nowMs ?? Date.parse("2026-08-02T12:00:00.000Z");

  /**
   * "Banco" MUTÁVEL, e não um `find()` que devolve sempre o mesmo objeto.
   *
   * Com mock estático, chamar `upsertAlert` duas vezes seguidas produzia duas
   * invocações independentes lendo o mesmo estado inicial — nada a ver com
   * reexecução, que é ler DEPOIS de a primeira ter gravado. O teste de
   * "reexecução não duplica" passaria com o defeito presente.
   */
  let row: ExistingAlert | null = opts.existing ?? null;

  const alerts: AlertRepo = {
    async find() {
      if (opts.findThrows) throw new Error("boom");
      return row;
    },
    insert: opts.insert ??
      (async (a) => {
        inserted.push(a);
        row = { id: "alert-1", status: "OPEN", occurrences: 1, lastReminderAt: null };
        return { ok: true, id: "alert-1" };
      }),
    async touch(t) {
      if (opts.touchFails) return { ok: false, message: opts.touchFails };
      const matched = opts.touchMatched ?? 1;
      touches.push({
        lastReminderAt: t.lastReminderAt,
        occurrences: t.occurrences,
        payload: t.payload,
      });
      if (matched > 0 && row) {
        row = { ...row, occurrences: t.occurrences, lastReminderAt: t.lastReminderAt };
      }
      return { ok: true, matched };
    },
    async stampReminder(t) {
      if (opts.stampFails) return { ok: false, message: opts.stampFails };
      stamps.push({ nowIso: t.nowIso, occurrences: t.occurrences });
      if (row) {
        row = {
          ...row,
          lastReminderAt: t.nowIso,
          occurrences: t.occurrences ?? row.occurrences,
        };
      }
      return { ok: true, matched: 1 };
    },
  };

  const deps: WorkerDeps = {
    clock: { nowMs: () => nowMs, nowIso: () => new Date(nowMs).toISOString() },
    telemetry: {
      info: (e) => logs.push({ level: "info", evt: String(e.evt), e }),
      warn: (e) => logs.push({ level: "warn", evt: String(e.evt), e }),
      error: (e) => logs.push({ level: "error", evt: String(e.evt), e }),
    },
    alerts,
    notifier: {
      async enqueue(org, eventType) {
        if (opts.enqueueOk === false) return false;
        enqueued.push({ org, eventType });
        return true;
      },
    },
    recipients: {
      async resolve() {
        const seq = opts.recipientSequence;
        // `?? "admin@x"` colapsaria "sem admin" (null EXPLÍCITO) em "com admin"
        // — e o teste de ausência de destinatário passaria testando o oposto.
        const fallback = "recipient" in opts ? opts.recipient! : "admin@x";
        const v = seq ? seq[Math.min(recipientCalls, seq.length - 1)] : fallback;
        recipientCalls++;
        return v;
      },
    },
    repo: {
      listRollCandidates: async () => ({ ok: true, rows: [] }),
      rollCycle: async () => ({ ok: true, value: "rolled" }),
      listCycleInstances: async () => ({ ok: true, rows: [] }),
      resolveRevenue: async () => ({
        ok: true,
        value: { customerRevenueCents: 10000, revenueSource: "SUBSCRIPTION_SOLE_INSTANCE" },
      }),
      hasOpenDivergence: async () => ({ ok: true, value: false }),
      listEndConfirmationCandidates: async () => ({ ok: true, rows: [] }),
      stampEndConfirmationRequired: async () => ({ ok: true }),
      listDivergenceInstances: async () => ({ ok: true, rows: [] }),
      listInventoryChannels: async () => ({ ok: true, rows: [] }),
      recordDivergenceKind: async () => ({ ok: true }),
      listDateReviewPending: async () => ({ ok: true, rows: [] }),
      listEconomicInstances: async () => ({ ok: true, rows: [] }),
      ...(opts.repo ?? {}),
    } as WorkerRepo,
    reqId: "req-test",
  };

  return { deps, logs, enqueued, touches, stamps, inserted, nowMs,
    recipientCalls: () => recipientCalls };
}

const ALERT: AlertInput = {
  subjectType: "INSTANCE",
  subjectId: INST,
  organizationId: ORG,
  instanceId: INST,
  channelId: null,
  alertType: "CYCLE_DUE_TOMORROW",
  dedupeKey: "cycle_d1:2026-08-01",
  payload: { reasons: ["COST_UNKNOWN"] },
};

function openAlert(over: Partial<ExistingAlert> = {}): ExistingAlert {
  return { id: "alert-1", status: "OPEN", occurrences: 1, lastReminderAt: null, ...over };
}

const evts = (logs: Log[]) => logs.map((l) => l.evt);

// ─────────────────────────────────────────────────────────────────────────
// A — cache de destinatário por invocação
// ─────────────────────────────────────────────────────────────────────────

describe("A — destinatário administrativo", () => {
  it("alerta nasce mudo quando não há admin, e o ledger registra o fato", async () => {
    const b = makeBench({ existing: null, recipient: null });
    const out = await upsertAlert(b.deps, ALERT);

    expect(out).toBe("created");
    expect(b.inserted).toHaveLength(1);
    expect(b.enqueued).toHaveLength(0);
    expect(evts(b.logs)).toContain("wa_alert_created_enqueue_failed");
    // Sem enfileiramento, o slot NÃO é carimbado: a próxima passada tenta de novo.
    expect(b.stamps).toHaveLength(0);
  });

  it("o resolver é do adapter — o núcleo o consulta, nunca o memoriza entre invocações", async () => {
    // Primeira invocação sem admin, segunda com: o núcleo não guarda estado
    // entre chamadas, então a segunda enfileira. É o defeito do `adminRecipient`
    // como `let` de módulo, agora impossível por construção.
    const semAdmin = makeBench({ existing: null, recipient: null });
    expect(await upsertAlert(semAdmin.deps, ALERT)).toBe("created");
    expect(semAdmin.enqueued).toHaveLength(0);

    const comAdmin = makeBench({ existing: null, recipient: "admin@x" });
    expect(await upsertAlert(comAdmin.deps, ALERT)).toBe("created");
    expect(comAdmin.enqueued).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// B — lembrete sem destinatário
// ─────────────────────────────────────────────────────────────────────────

describe("B — lembrete vencido sem destinatário", () => {
  it("não avança last_reminder_at, não consome a janela, não incrementa contador", async () => {
    const antes = new Date(Date.parse("2026-08-02T12:00:00.000Z") - REMINDER_INTERVAL_MS - DAY)
      .toISOString();
    const b = makeBench({
      existing: openAlert({ occurrences: 3, lastReminderAt: antes }),
      recipient: null,
    });

    const out = await upsertAlert(b.deps, ALERT);

    expect(out).toBe("seen");
    expect(b.enqueued).toHaveLength(0);
    expect(b.touches[0].lastReminderAt).toBe(antes);
    expect(b.touches[0].occurrences).toBe(3);
    expect(evts(b.logs)).toContain("wa_alert_reminder_no_recipient");
  });

  it("permanece elegível — o mesmo alerta lembra assim que o admin existe", async () => {
    const antes = new Date(Date.parse("2026-08-02T12:00:00.000Z") - REMINDER_INTERVAL_MS - DAY)
      .toISOString();
    const b = makeBench({
      existing: openAlert({ occurrences: 3, lastReminderAt: antes }),
      recipient: "admin@x",
    });

    expect(await upsertAlert(b.deps, ALERT)).toBe("reminded");
    // O incremento vive no CARIMBO, não no toque: o toque é o pedágio de
    // escrita que acontece antes de qualquer enfileiramento.
    expect(b.touches[0].occurrences).toBe(3);
    expect(b.stamps[0].occurrences).toBe(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// C — criação consome o slot (F-12)
// ─────────────────────────────────────────────────────────────────────────

describe("C — a criação consome o slot mensal", () => {
  it("carimba last_reminder_at ao criar com enfileiramento confirmado", async () => {
    const b = makeBench({ existing: null, recipient: "admin@x" });

    expect(await upsertAlert(b.deps, ALERT)).toBe("created");
    expect(b.enqueued).toHaveLength(1);
    expect(b.stamps).toHaveLength(1);
    expect(b.stamps[0].nowIso).toBe(new Date(b.nowMs).toISOString());
    // A criação NÃO incrementa: a linha nasce em `occurrences = 1`.
    expect(b.stamps[0].occurrences).toBeUndefined();
  });

  it("sem o carimbo, o lembrete 'mensal' dispararia no dia seguinte", async () => {
    // Prova do defeito que o carimbo fecha: `lastReminderAt` nulo faz `last=0`,
    // e qualquer data real satisfaz `now - 0 >= 30 dias`.
    const b = makeBench({ existing: openAlert({ lastReminderAt: null }), recipient: "admin@x" });
    expect(await upsertAlert(b.deps, ALERT)).toBe("reminded");
  });

  it("dentro da janela mensal não relembra", async () => {
    const ontem = new Date(Date.parse("2026-08-02T12:00:00.000Z") - DAY).toISOString();
    const b = makeBench({ existing: openAlert({ lastReminderAt: ontem }), recipient: "admin@x" });

    expect(await upsertAlert(b.deps, ALERT)).toBe("seen");
    expect(b.enqueued).toHaveLength(0);
    expect(b.touches[0].lastReminderAt).toBe(ontem);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// D — falha de enfileiramento (F-08)
// ─────────────────────────────────────────────────────────────────────────

describe("D — falha de enfileiramento não consome o lembrete", () => {
  it("janela preservada: last_reminder_at e occurrences ficam onde estavam", async () => {
    const antes = new Date(Date.parse("2026-08-02T12:00:00.000Z") - REMINDER_INTERVAL_MS - DAY)
      .toISOString();
    const b = makeBench({
      existing: openAlert({ occurrences: 2, lastReminderAt: antes }),
      recipient: "admin@x",
      enqueueOk: false,
    });

    const out = await upsertAlert(b.deps, ALERT);

    expect(out).toBe("seen");
    expect(b.touches[0].lastReminderAt).toBe(antes);
    expect(b.touches[0].occurrences).toBe(2);
    expect(evts(b.logs)).toContain("wa_alert_enqueue_failed_window_preserved");
  });

  it("retry na passada seguinte, sem duplicar linha no ledger", async () => {
    const antes = new Date(Date.parse("2026-08-02T12:00:00.000Z") - REMINDER_INTERVAL_MS - DAY)
      .toISOString();
    const b = makeBench({
      existing: openAlert({ occurrences: 2, lastReminderAt: antes }),
      recipient: "admin@x",
    });

    expect(await upsertAlert(b.deps, ALERT)).toBe("reminded");
    expect(b.enqueued).toHaveLength(1);
    expect(b.inserted).toHaveLength(0);
  });

  it("criação com enfileiramento falho devolve created e deixa o slot livre", async () => {
    const b = makeBench({ existing: null, recipient: "admin@x", enqueueOk: false });

    expect(await upsertAlert(b.deps, ALERT)).toBe("created");
    expect(b.stamps).toHaveLength(0);
    expect(evts(b.logs)).toContain("wa_alert_created_enqueue_failed");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// E — payload do D-1
// ─────────────────────────────────────────────────────────────────────────

describe("E — payload reescrito a cada passada", () => {
  it("motivos mudam no lembrete sem abrir linha nova", async () => {
    const antes = new Date(Date.parse("2026-08-02T12:00:00.000Z") - REMINDER_INTERVAL_MS - DAY)
      .toISOString();
    const b = makeBench({
      existing: openAlert({ occurrences: 1, lastReminderAt: antes }),
      recipient: "admin@x",
    });

    const out = await upsertAlert(b.deps, {
      ...ALERT,
      payload: { reasons: ["OPEN_DIVERGENCE", "REVENUE_UNKNOWN"] },
    });

    expect(out).toBe("reminded");
    expect(b.touches[0].payload).toEqual({ reasons: ["OPEN_DIVERGENCE", "REVENUE_UNKNOWN"] });
    // MESMA ocorrência: nenhum INSERT, a chave do D-1 não carrega motivos.
    expect(b.inserted).toHaveLength(0);
  });

  it("payload também é reescrito quando NÃO há lembrete", async () => {
    const ontem = new Date(Date.parse("2026-08-02T12:00:00.000Z") - DAY).toISOString();
    const b = makeBench({ existing: openAlert({ lastReminderAt: ontem }), recipient: "admin@x" });

    await upsertAlert(b.deps, { ...ALERT, payload: { reasons: ["COST_UNKNOWN", "OPEN_DIVERGENCE"] } });

    expect(b.touches[0].payload).toEqual({ reasons: ["COST_UNKNOWN", "OPEN_DIVERGENCE"] });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// F — contadores por sub-passo
// ─────────────────────────────────────────────────────────────────────────

describe("F — contadores creditam a etapa real", () => {
  const inst = {
    id: INST,
    organizationId: ORG,
    lifecycleState: "ACTIVE",
    cycleSource: "ADMIN_CONFIRMED",
    cycleStartedOn: "2026-07-03",
    cycleDueOn: "2026-08-03",
    monthlyCostCents: 1000,
    providerAccessUntil: null,
    anchorDay: 3,
  };

  it("falha exclusiva do D-1 incrementa d1.failed e deixa d7.failed zerado", async () => {
    const b = makeBench({
      // due = 2026-08-03, hoje 2026-08-02 ⇒ 1 dia: D-7 e D-1 ambos elegíveis.
      existing: null,
      repo: {
        listCycleInstances: async () => ({ ok: true, rows: [inst] }),
        // A leitura de divergência só alimenta o D-1.
        hasOpenDivergence: async () => ({ ok: false, message: "rede caiu" }),
      },
    });

    const [d7, d1] = await runCycleAlertsStep(b.deps, "2026-08-02");

    expect(d7.processed).toBe(1);
    expect(d7.failed).toBe(0);
    expect(d1.failed).toBe(1);
    const exc = b.logs.find((l) => l.evt === "wa_alerts_exception");
    expect(exc?.e.phase).toBe("d1");
  });

  it("falha da consulta de instâncias credita o D-7 e não inventa D-1", async () => {
    const b = makeBench({
      repo: { listCycleInstances: async () => ({ ok: false, message: "timeout" }) },
    });

    const [d7, d1] = await runCycleAlertsStep(b.deps, "2026-08-02");

    expect(d7.failed).toBe(1);
    expect(d1.processed).toBe(0);
    expect(d1.failed).toBe(0);
  });

  it("pendência de data NÃO é reportada como desequilíbrio econômico", async () => {
    const b = makeBench({
      existing: null,
      repo: {
        listDateReviewPending: async () => ({
          ok: true,
          rows: [
            { id: "i1", organizationId: ORG },
            { id: "i2", organizationId: ORG },
            { id: "i3", organizationId: ORG },
          ],
        }),
        listEconomicInstances: async () => ({ ok: true, rows: [] }),
      },
    });

    const s = await runEconomicsStep(b.deps, "2026-08-02");
    const done = b.logs.find((l) => l.evt === "wa_econ_scan_done");

    expect(done?.e.dateReviewPending).toBe(3);
    expect(done?.e.dateReviewProcessed).toBe(3);
    // O número que antes dizia "3": três pendências de DATA lidas como três
    // desequilíbrios econômicos, num passo cuja função é detectar prejuízo.
    expect(done?.e.imbalancesReported).toBe(0);
    expect(s.processed).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// G — divergências
// ─────────────────────────────────────────────────────────────────────────

describe("G — divergências com visão parcial", () => {
  it("falha na leitura de instâncias aborta o passo, sem CHANNEL_WITHOUT_INSTANCE falso", async () => {
    const b = makeBench({
      repo: {
        listDivergenceInstances: async () => ({ ok: false, message: "conexão perdida" }),
        listInventoryChannels: async () => ({
          ok: true,
          rows: [{ channelId: "c1", organizationId: ORG, hasLegacyRef: true, hasEverOperated: true }],
        }),
      },
    });

    const s = await runDivergencesStep(b.deps, "2026-08-02");

    expect(s.failed).toBe(1);
    expect(s.processed).toBe(0);
    // Nenhum alerta: o canal elegível NÃO foi declarado órfão a partir de uma
    // lista de instâncias que nunca chegou.
    expect(b.enqueued).toHaveLength(0);
    expect(evts(b.logs)).toContain("wa_div_inst_query_failed");
    expect(evts(b.logs)).not.toContain("wa_div_chan_query_failed");
  });

  it("falha ao espelhar a divergência na instância é observável, sem invalidar o alerta", async () => {
    const b = makeBench({
      existing: null,
      repo: {
        listDivergenceInstances: async () => ({
          ok: true,
          rows: [
            {
              instanceId: INST,
              organizationId: ORG,
              lifecycleState: "ACTIVE",
              channelId: null,
              providerInstanceRef: "abc",
              legacyChannelInstanceRef: null,
              channelState: null,
              channelStateAgeDays: null,
              hasAdminExplanation: false,
              endedAtIso: null,
              lastLocalSignalAtIso: null,
            },
          ],
        }),
        recordDivergenceKind: async () => ({ ok: false, message: "rls negou" }),
      },
    });

    const s = await runDivergencesStep(b.deps, "2026-08-02");

    // O alerta ESTÁ no ledger: o espelho na instância é secundário.
    expect(s.processed).toBeGreaterThan(0);
    expect(s.failed).toBe(0);
    // Mas o painel dizer "sem divergência recente" com o ledger aberto não pode
    // acontecer em silêncio.
    expect(evts(b.logs)).toContain("wa_div_record_kind_failed");
  });

  it("falha na leitura de canais não apaga o que as instâncias já produziram", async () => {
    const b = makeBench({
      existing: null,
      repo: {
        listDivergenceInstances: async () => ({
          ok: true,
          rows: [
            {
              instanceId: INST,
              organizationId: ORG,
              lifecycleState: "ACTIVE",
              channelId: null,
              providerInstanceRef: "abc",
              legacyChannelInstanceRef: null,
              channelState: null,
              channelStateAgeDays: null,
              hasAdminExplanation: false,
              endedAtIso: null,
              lastLocalSignalAtIso: null,
            },
          ],
        }),
        listInventoryChannels: async () => ({ ok: false, message: "timeout" }),
      },
    });

    const s = await runDivergencesStep(b.deps, "2026-08-02");

    expect(s.processed).toBeGreaterThan(0);
    expect(s.failed).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// H — economia
// ─────────────────────────────────────────────────────────────────────────

describe("H — economia distingue ausência de silêncio", () => {
  it("falha na consulta de pendência de data aborta e é afirmada", async () => {
    const b = makeBench({
      repo: { listDateReviewPending: async () => ({ ok: false, message: "erro" }) },
    });

    const s = await runEconomicsStep(b.deps, "2026-08-02");

    expect(s.failed).toBe(1);
    expect(evts(b.logs)).toContain("wa_econ_unknown_date_query_failed");
  });

  it("falha na consulta econômica preserva o que a pendência de data já contou", async () => {
    const b = makeBench({
      existing: null,
      repo: {
        listDateReviewPending: async () => ({ ok: true, rows: [{ id: "i1", organizationId: ORG }] }),
        listEconomicInstances: async () => ({ ok: false, message: "erro" }),
      },
    });

    const s = await runEconomicsStep(b.deps, "2026-08-02");

    expect(s.processed).toBe(1);
    expect(s.failed).toBe(1);
    expect(evts(b.logs)).toContain("wa_econ_instances_query_failed");
  });

  it("zero organizações elegíveis é AFIRMADO, não silêncio", async () => {
    const b = makeBench({});
    await runEconomicsStep(b.deps, "2026-08-02");

    const done = b.logs.find((l) => l.evt === "wa_econ_scan_done");
    expect(done?.e.eligibleOrgs).toBe(0);
    expect(done?.e.imbalancesReported).toBe(0);
  });

  it("LIFETIME_OVERRIDE com margem negativa não vira alerta", async () => {
    const b = makeBench({
      existing: null,
      repo: {
        listEconomicInstances: async () => ({
          ok: true,
          rows: [{ id: INST, organizationId: ORG, costCents: 14900 }],
        }),
        resolveRevenue: async () => ({
          ok: true,
          value: { customerRevenueCents: null, revenueSource: "LIFETIME_OVERRIDE" },
        }),
      },
    });

    const s = await runEconomicsStep(b.deps, "2026-08-02");

    expect(s.processed).toBe(0);
    expect(b.enqueued).toHaveLength(0);
  });

  it("NO_ENTITLEMENT abre alerta: custo sem contrato é desequilíbrio", async () => {
    const b = makeBench({
      existing: null,
      repo: {
        listEconomicInstances: async () => ({
          ok: true,
          rows: [{ id: INST, organizationId: ORG, costCents: 14900 }],
        }),
        resolveRevenue: async () => ({
          ok: true,
          value: { customerRevenueCents: null, revenueSource: "NO_ENTITLEMENT" },
        }),
      },
    });

    const s = await runEconomicsStep(b.deps, "2026-08-02");
    expect(s.processed).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// I — isolamento
// ─────────────────────────────────────────────────────────────────────────

describe("I — isolamento entre itens e entre etapas", () => {
  it("falha em uma instância não derruba o lote", async () => {
    let n = 0;
    const b = makeBench({
      existing: null,
      repo: {
        listRollCandidates: async () => ({
          ok: true,
          rows: [1, 2, 3].map((i) => ({
            id: `i${i}`,
            organizationId: ORG,
            lifecycleState: "ACTIVE",
            cycleSource: "ADMIN_CONFIRMED",
            cycleStartedOn: "2026-07-03",
            cycleDueOn: "2026-08-02",
            monthlyCostCents: 1000,
            providerAccessUntil: null,
            anchorDay: 3,
          })),
        }),
        rollCycle: async () => {
          n++;
          if (n === 2) return { ok: false, message: "conflito" };
          return { ok: true, value: "rolled" };
        },
      },
    });

    const s = await runRollCyclesStep(b.deps, "2026-08-02");

    expect(s.processed).toBe(2);
    expect(s.failed).toBe(1);
  });

  it("instância sem âncora é pulada sem contar como falha", async () => {
    const b = makeBench({
      repo: {
        listRollCandidates: async () => ({
          ok: true,
          rows: [{
            id: INST, organizationId: ORG, lifecycleState: "ACTIVE",
            cycleSource: "UNKNOWN", cycleStartedOn: null, cycleDueOn: "2026-08-02",
            monthlyCostCents: null, providerAccessUntil: null, anchorDay: null,
          }],
        }),
      },
    });

    const s = await runRollCyclesStep(b.deps, "2026-08-02");

    expect(s.processed).toBe(0);
    expect(s.failed).toBe(0);
    expect(evts(b.logs)).toContain("wa_roll_skipped_no_anchor");
  });

  it("falha ao carimbar o encerramento não emite o alerta daquela instância", async () => {
    const b = makeBench({
      existing: null,
      repo: {
        listEndConfirmationCandidates: async () => ({
          ok: true,
          rows: [{
            id: INST, organizationId: ORG, lifecycleState: "CANCELLATION_REQUESTED",
            cycleSource: "ADMIN_CONFIRMED", cycleStartedOn: "2026-07-03",
            cycleDueOn: "2026-08-03", monthlyCostCents: 1000,
            providerAccessUntil: "2026-08-01", anchorDay: 3,
            endConfirmationRequiredAt: null,
          }],
        }),
        stampEndConfirmationRequired: async () => ({ ok: false, message: "erro" }),
      },
    });

    const s = await runEndConfirmationStep(b.deps, "2026-08-02");

    expect(s.failed).toBe(1);
    expect(b.enqueued).toHaveLength(0);
  });

  it("cycle_source UNKNOWN não emite D-7 nem D-1", async () => {
    const b = makeBench({
      existing: null,
      repo: {
        listCycleInstances: async () => ({
          ok: true,
          rows: [{
            id: INST, organizationId: ORG, lifecycleState: "ACTIVE",
            cycleSource: "UNKNOWN", cycleStartedOn: "2026-07-03",
            cycleDueOn: "2026-08-03", monthlyCostCents: null,
            providerAccessUntil: null, anchorDay: 3,
          }],
        }),
      },
    });

    const [d7, d1] = await runCycleAlertsStep(b.deps, "2026-08-02");

    expect(d7.processed).toBe(0);
    expect(d1.processed).toBe(0);
    expect(b.enqueued).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// K — decisão de enfileirar
// ─────────────────────────────────────────────────────────────────────────

describe("K — só created e reminded enfileiram", () => {
  it("created enfileira", async () => {
    const b = makeBench({ existing: null });
    expect(await upsertAlert(b.deps, ALERT)).toBe("created");
    expect(b.enqueued).toEqual([{ org: ORG, eventType: "admin_zapi_cycle_d1_action_required" }]);
  });

  it("reminded enfileira", async () => {
    const antes = new Date(Date.parse("2026-08-02T12:00:00.000Z") - REMINDER_INTERVAL_MS - DAY)
      .toISOString();
    const b = makeBench({ existing: openAlert({ lastReminderAt: antes }) });
    expect(await upsertAlert(b.deps, ALERT)).toBe("reminded");
    expect(b.enqueued).toHaveLength(1);
  });

  it("seen dentro da janela NÃO enfileira", async () => {
    const ontem = new Date(Date.parse("2026-08-02T12:00:00.000Z") - DAY).toISOString();
    const b = makeBench({ existing: openAlert({ lastReminderAt: ontem }) });
    expect(await upsertAlert(b.deps, ALERT)).toBe("seen");
    expect(b.enqueued).toHaveLength(0);
  });

  it("corrida no INSERT (23505) não duplica o aviso — quem criou já enfileirou", async () => {
    const b = makeBench({
      existing: null,
      insert: async () => ({ ok: false, duplicate: true, message: "duplicate key" }),
    });

    expect(await upsertAlert(b.deps, ALERT)).toBe("seen");
    expect(b.enqueued).toHaveLength(0);
  });

  it("reexecução LÊ o que a passada anterior gravou e não relembra", async () => {
    // Bancada com estado mutável: a 2ª chamada enxerga o `last_reminder_at`
    // que a 1ª carimbou. Com `find()` estático isto seriam duas invocações
    // idênticas e independentes — nada a ver com reexecução.
    const antes = new Date(Date.parse("2026-08-02T12:00:00.000Z") - REMINDER_INTERVAL_MS - DAY)
      .toISOString();
    const b = makeBench({ existing: openAlert({ occurrences: 1, lastReminderAt: antes }) });

    expect(await upsertAlert(b.deps, ALERT)).toBe("reminded");
    expect(await upsertAlert(b.deps, ALERT)).toBe("seen");
    expect(await upsertAlert(b.deps, ALERT)).toBe("seen");

    // UM aviso para o fato, não três.
    expect(b.enqueued).toHaveLength(1);
    expect(b.stamps).toHaveLength(1);
  });

  it("criação seguida de reexecução no mesmo dia não relembra", async () => {
    const b = makeBench({ existing: null });

    expect(await upsertAlert(b.deps, ALERT)).toBe("created");
    // A 2ª passada encontra a linha JÁ carimbada pela criação — é exatamente o
    // que o F-12 fecha: sem o carimbo, `last = 0` e o lembrete "mensal"
    // dispararia aqui.
    expect(await upsertAlert(b.deps, ALERT)).toBe("seen");
    expect(b.enqueued).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// L — zero linhas casadas no UPDATE (F-02)
// ─────────────────────────────────────────────────────────────────────────

describe("L — UPDATE que não casa linha nenhuma é falha, não sucesso", () => {
  it("zero linhas ⇒ failed, e nada é enfileirado depois disso", async () => {
    const antes = new Date(Date.parse("2026-08-02T12:00:00.000Z") - REMINDER_INTERVAL_MS - DAY)
      .toISOString();
    const b = makeBench({
      existing: openAlert({ lastReminderAt: antes }),
      touchMatched: 0,
    });

    const out = await upsertAlert(b.deps, ALERT);

    expect(out).toBe("failed");
    expect(evts(b.logs)).toContain("wa_alert_touch_no_rows");
    // A ASSERÇÃO QUE FALTAVA — e sem a qual o título era falso. O toque é o
    // pedágio: se ele não casa linha, o aviso não entra na fila. Na ordem
    // anterior (enfileirar primeiro) este `expect` reprovaria, e uma falha de
    // escrita persistente enfileiraria um aviso idêntico por dia, sem teto: o
    // índice UNIQUE de `billing_notifications` é parcial e não deduplica com
    // `invoice_id` nulo, que é o caso de TODO aviso desta fase.
    expect(b.enqueued).toHaveLength(0);
  });

  it("falha persistente de escrita não enfileira nada em N passadas", async () => {
    const antes = new Date(Date.parse("2026-08-02T12:00:00.000Z") - REMINDER_INTERVAL_MS - DAY)
      .toISOString();
    const b = makeBench({
      existing: openAlert({ lastReminderAt: antes }),
      touchFails: "deadlock detected",
    });

    for (let i = 0; i < 5; i++) {
      expect(await upsertAlert(b.deps, ALERT)).toBe("failed");
    }
    expect(b.enqueued).toHaveLength(0);
  });

  it("erro explícito do UPDATE também é failed", async () => {
    const b = makeBench({
      existing: openAlert(),
      touchFails: "permission denied",
    });

    expect(await upsertAlert(b.deps, ALERT)).toBe("failed");
    expect(evts(b.logs)).toContain("wa_alert_touch_failed");
  });

  it("falha na leitura do ledger é failed, nunca 'não existe'", async () => {
    const b = makeBench({ findThrows: true });

    expect(await upsertAlert(b.deps, ALERT)).toBe("failed");
    expect(evts(b.logs)).toContain("wa_alert_lookup_failed");
    // Não pode ter criado nada a partir de uma leitura que falhou.
    expect(b.inserted).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// M — supressão por ledger encerrado (F-05)
// ─────────────────────────────────────────────────────────────────────────

describe("M — chave já encerrada no ledger", () => {
  it("RESOLVED não reabre, e a supressão é registrada", async () => {
    const b = makeBench({ existing: openAlert({ status: "RESOLVED" }) });

    const out = await upsertAlert(b.deps, ALERT);

    expect(out).toBe("suppressed");
    expect(b.enqueued).toHaveLength(0);
    expect(b.touches).toHaveLength(0);
    const log = b.logs.find((l) => l.evt === "wa_alert_suppressed_by_closed_ledger");
    expect(log?.e.ledgerStatus).toBe("RESOLVED");
  });

  it("ACKNOWLEDGED interrompe o lembrete sem fechar o fato", async () => {
    const b = makeBench({ existing: openAlert({ status: "ACKNOWLEDGED" }) });

    expect(await upsertAlert(b.deps, ALERT)).toBe("suppressed");
    expect(b.enqueued).toHaveLength(0);
  });

  it("suprimido NÃO conta como falha no passo", async () => {
    const b = makeBench({
      existing: openAlert({ status: "RESOLVED" }),
      repo: {
        listDateReviewPending: async () => ({ ok: true, rows: [{ id: INST, organizationId: ORG }] }),
      },
    });

    const s = await runEconomicsStep(b.deps, "2026-08-02");

    expect(s.failed).toBe(0);
    expect(s.processed).toBe(1);
  });
});
