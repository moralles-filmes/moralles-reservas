// Processador do notification_outbox.
//
// Pega itens pendentes (até MAX_BATCH por execução), marca como 'processing',
// dispara a Edge Function correspondente (send-confirmation/send-cancellation)
// e atualiza outcome via mark_outbox_done / mark_outbox_failed.
//
// Agendado pelo Supabase Cron a cada 1-2 minutos. Authentication via
// `x-internal-key` (mesmo INTERNAL_API_KEY usado pelas outras Edge Functions
// internas).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jsonLog, requireInternalAuth } from "../_shared/security.ts";
import { selectReservationAutomationRoute, automationUuid, decodeAutomationDispatch, decodeOutboxAutomationObservation } from "../_shared/whatsapp-automation-producer-routing.ts";
import { parseAutomationLedger } from "../_shared/whatsapp-automation-core.ts";
import {
  resolveWhatsAppGateByUnit,
  clearWhatsAppGateCache,
} from "../_shared/whatsapp-service-gate.ts";
import {
  decideMessageTtl,
  brtFactAt,
} from "../_shared/whatsapp-message-ttl-core.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const INTERNAL_API_KEY = Deno.env.get("INTERNAL_API_KEY") ?? "";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const MAX_BATCH = 20;
const FUNCTION_TIMEOUT_MS = 25_000;

interface OutboxRow {
  id: string;
  reservation_id: string;
  unit_id: string;
  kind: "confirmation" | "cancellation";
  attempts: number;
  automation_job_id: string | null;
  automation_initial_token: string | null;
}

/** Resolve only the original unpinned intent. Email ownership and delivery stay elsewhere. */
async function recoverOriginalIntent(row: OutboxRow): Promise<boolean> {
  try {
    const ledger = await supabase.from('whatsapp_automation_jobs').select('*')
      .eq('unit_id', row.unit_id).eq('reservation_id', row.reservation_id).eq('kind', 'confirmation').maybeSingle();
    if (ledger.error) return false;
    let jobId: string;
    if (ledger.data !== null) {
      if (!ledger.data || ledger.data.unit_id !== row.unit_id || ledger.data.reservation_id !== row.reservation_id
        || ledger.data.kind !== 'confirmation') return false;
      jobId = parseAutomationLedger(ledger.data).jobId;
    } else {
      const response = await fetch(`${SUPABASE_URL}/functions/v1/send-scheduled-whatsapp`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-internal-key': INTERNAL_API_KEY },
        body: JSON.stringify({ action: 'enqueue', kind: 'confirmation', resource_id: row.reservation_id,
          unit_id: row.unit_id, outbox_id: row.id }), signal: AbortSignal.timeout(FUNCTION_TIMEOUT_MS),
      });
      const result = response.ok ? decodeAutomationDispatch(await response.json()) : null;
      if (!result) return false;
      // SQL rederives positive suppression; transport never settles the outbox.
      if (result.jobId === null) return result.reason === 'producer_before_adoption' || result.reason === 'legacy_already_accepted';
      jobId = result.jobId;
    }
    const pinned = await supabase.rpc('delegate_notification_outbox_automation', { p_id: row.id, p_job_id: jobId });
    return !pinned.error && pinned.data === true;
  } catch { return false; }
}

async function dispatchOne(row: OutboxRow): Promise<{ ok: boolean; error?: string }> {
  const fnName = row.kind === "confirmation" ? "send-confirmation" : "send-cancellation";
  const url = `${SUPABASE_URL}/functions/v1/${fnName}`;

  // send-confirmation aceita `record` no body (formato do database webhook).
  // send-cancellation aceita `reservation_id`. Ambos exigem auth — confirmation
  // via `x-internal-key`, cancellation via `Authorization: Bearer <jwt>`.
  let body: Record<string, unknown>;
  let headers: Record<string, string> = { "Content-Type": "application/json" };

  if (row.kind === "confirmation") {
    body = { record: { id: row.reservation_id, unit_id: row.unit_id }, outbox_id: row.id };
    headers["x-internal-key"] = INTERNAL_API_KEY;
  } else {
    // send-cancellation requer auth de user — não dá pra rodar via cron.
    // Por hora retorna erro permanente (não retry).
    return { ok: false, error: "cancellation_not_supported_in_outbox" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FUNCTION_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (res.ok) return { ok: true };

    const errBody = await res.text().catch(() => "");
    return { ok: false, error: `http_${res.status}: ${errBody.slice(0, 200)}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Um job estacionado pode ter perdido a validade enquanto o serviço estava
 * suspenso. NÃO SE REENVIA TUDO AUTOMATICAMENTE: confirmação de reserva que já
 * aconteceu é ruído para o cliente e custo para o lojista.
 *
 * Vale também fora da suspensão — um job represado por 5 tentativas de falha
 * tem o mesmo problema. Por isso a checagem é do despacho, não do desestaciona.
 */
async function stillValid(row: OutboxRow): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { data: r } = await supabase
    .from("reservations")
    .select("id, date, time, status")
    .eq("id", row.reservation_id)
    .maybeSingle();

  if (!r) return { ok: false, reason: "reservation_missing" };
  if (r.status === "cancelled") return { ok: false, reason: "reservation_cancelled" };

  // "Reserva no passado" deixou de ser conta local e passou a ser o prazo de
  // validade compartilhado (`confirmation` vence no horário da reserva). A
  // regra vive num lugar só — este arquivo e `send-whatsapp` divergiriam no
  // primeiro que fosse editado, e os dois decidem sobre a MESMA mensagem.
  //
  // `brtFactAt` carrega o gotcha que este bloco resolvia à mão: coluna `time`
  // volta como "HH:MM:SS" e interpolar direto geraria dois blocos de segundos
  // → Invalid Date → comparação sempre falsa, com a checagem desligada em
  // silêncio. Sem hora, cai em "23:59" para não vencer a reserva cedo demais.
  const factAt = brtFactAt(r.date as string, (r.time as string) ?? "23:59");
  const ttl = decideMessageTtl({ kind: "confirmation", factAt, now: Date.now() });
  if (ttl.decision === "discard") return { ok: false, reason: "reservation_in_the_past" };

  const { data: sent } = await supabase
    .from("notifications_sent")
    .select("id")
    .eq("reservation_id", row.reservation_id)
    .eq("kind", row.kind)
    .maybeSingle();
  if (sent) return { ok: false, reason: "already_sent" };

  return { ok: true };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  if (!requireInternalAuth(req)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const t0 = Date.now();
  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let expired = 0;
  let parkedCount = 0;
  let parkWriteFailed = 0;
  let expireWriteFailed = 0;
  let automationPending = 0;
  let automationDependency = 0;
  let automationWriteFailed = 0;
  let recovered = 0;

  try {
    const recovery = await supabase.rpc('recover_delegated_notification_outbox', { p_limit: MAX_BATCH });
    if (recovery.error || !Array.isArray(recovery.data) || recovery.data.length > MAX_BATCH
      || recovery.data.some(id => !automationUuid(id)) || new Set(recovery.data).size !== recovery.data.length) {
      automationWriteFailed++;
      jsonLog('warn', { evt: 'outbox_automation_recovery_failed' });
    } else recovered = recovery.data.length;
    // Pega lote de pendentes due — atomicamente marca como 'processing' pra
    // evitar duplo processamento se duas execuções concorrentes pegam o mesmo
    // job. UPDATE ... RETURNING garante que só um wins por linha.
    const { data: claimed, error: claimErr } = await supabase
      .from("notification_outbox")
      .update({ status: "processing", updated_at: new Date().toISOString() })
      .eq("status", "pending")
      .lte("next_attempt_at", new Date().toISOString())
      .select("id, reservation_id, unit_id, kind, attempts, automation_job_id, automation_initial_token")
      .limit(MAX_BATCH);

    if (claimErr) {
      jsonLog("error", { evt: "outbox_claim_failed", err: claimErr.message });
      return new Response(JSON.stringify({ error: claimErr.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Cache do gate é por invocação — zera aqui, mesmo padrão do unitCache dos
    // outros workers, senão um isolate quente serve estado de suspensão velho
    // pra um cliente que acabou de pagar.
    clearWhatsAppGateCache();

    const rows = (claimed ?? []) as OutboxRow[];
    processed = rows.length;

    const toDispatch: OutboxRow[] = [];
    const parked: OutboxRow[] = [];

    for (const row of rows) {
      if (row.kind === 'confirmation') {
        const hasMarker = row.automation_job_id !== null || row.automation_initial_token !== null;
        const route = hasMarker ? { path: 'managed' as const }
          : await selectReservationAutomationRoute(async (table, columns, predicates, cardinality) => {
            let query = supabase.from(table).select(columns);
            for (const [column, value] of predicates) query = query.eq(column, value);
            const result = await (cardinality === 'single' ? query.maybeSingle() : query);
            if (result.error) throw result.error;
            return result.data;
          }, { kind: 'confirmation', unitId: row.unit_id, reservationId: row.reservation_id });
        if (route.path !== 'legacy') {
          // Initial ownership is never renewed. Recover only an unpinned original intent;
          // all outcomes, including enqueue suppression, are still projected by SQL.
          const recoveryFailed = row.automation_initial_token !== null && row.automation_job_id === null
            && !await recoverOriginalIntent(row);
          if (route.path === 'dependency' || recoveryFailed) {
            const deferred = await supabase.rpc('defer_notification_outbox_automation_dependency', { p_id: row.id });
            if (!deferred.error && deferred.data === true) automationDependency++;
            else automationWriteFailed++;
            continue;
          }
          if (row.automation_initial_token === null) await dispatchOne(row);
          const polled = await supabase.rpc('poll_notification_outbox_automation', { p_id: row.id });
          const observation = polled.error ? null : decodeOutboxAutomationObservation(polled.data);
          if (!observation || observation.outbox_status === 'processing') {
            const deferred = await supabase.rpc('defer_notification_outbox_automation_dependency', { p_id: row.id });
            if (!deferred.error && deferred.data === true) automationDependency++;
            else automationWriteFailed++;
          } else if (observation.disposition === 'accepted') succeeded++;
          else if (observation.disposition === 'discarded' || observation.disposition === 'suppressed') expired++;
          else if (observation.outbox_status === 'dead') failed++;
          else if (observation.disposition === 'dependency') automationDependency++;
          else automationPending++;
          continue;
        }
      }
      const gate = await resolveWhatsAppGateByUnit(supabase, row.unit_id);
      if (gate?.enforced.sending) parked.push(row);
      else toDispatch.push(row);
    }

    if (parked.length > 0) {
      // ESTACIONAMENTO: volta a 'pending', adia uma hora e NÃO incrementa
      // `attempts`. Sem isso, o teto de 5 tentativas é consumido pela suspensão
      // e o job vira 'dead' por não ter sido enviado enquanto o cliente estava
      // suspenso — perdendo a mensagem de vez quando ele pagar.
      //
      // Não há reaper pra linhas presas em 'processing' nesta tabela (diferente
      // de `processed_messages`, que tem janela de staleness de 90s — aqui
      // 'processing' só aparece no CHECK constraint e neste arquivo). Se este
      // UPDATE falhar, as linhas claimed acima ficam presas pra sempre: o
      // próximo claim só pega 'pending', então elas somem do pipeline. O log
      // abaixo é a única forma de recuperá-las à mão (reset manual pra
      // 'pending').
      const { error: parkErr } = await supabase
        .from("notification_outbox")
        .update({
          status: "pending",
          next_attempt_at: new Date(Date.now() + 3_600_000).toISOString(),
          last_error: "whatsapp_service_suspended",
          updated_at: new Date().toISOString(),
        })
        .in("id", parked.map((r) => r.id));
      if (parkErr) {
        jsonLog("error", {
          evt: "outbox_park_write_failed",
          count: parked.length,
          ids: parked.map((r) => r.id),
          err: parkErr.message,
        });
        parkWriteFailed = parked.length;
      } else {
        jsonLog("info", { evt: "outbox_parked", count: parked.length });
        parkedCount = parked.length;
      }
    }

    for (const row of toDispatch) {
      // Revalidação só se aplica a 'confirmation' — para 'cancellation' o
      // status já ESPERADO é 'cancelled' (é por isso que a notificação existe),
      // então rodar o mesmo stillValid rejeitaria toda cancelação legítima.
      // Hoje 'cancellation' nunca é enfileirado (só o trigger de confirmation
      // insere no outbox) e dispatchOne já devolve erro permanente pra ele.
      if (row.kind === "confirmation") {
        const validity = await stillValid(row);
        if (!validity.ok) {
          // Rótulo sem "after_suspension": este caminho roda pra QUALQUER job
          // de `toDispatch` que falhe a revalidação, inclusive um job que
          // nunca foi estacionado — 5 tentativas de backoff (1m+5m+15m+1h+4h
          // ≈ 5.5h) bastam pra uma reserva próxima virar passado sem nenhuma
          // suspensão envolvida. `validity.reason` já carrega a causa real.
          const { error: expireErr } = await supabase
            .from("notification_outbox")
            .update({
              status: "done",
              last_error: `expired:${validity.reason}`,
              updated_at: new Date().toISOString(),
            })
            .eq("id", row.id);
          if (expireErr) {
            // Mesma lacuna do park (sem reaper pra 'processing'): se este
            // UPDATE falhar, a linha fica presa em 'processing' pra sempre —
            // o log é a única forma de recuperá-la à mão.
            jsonLog("error", {
              evt: "outbox_expire_write_failed",
              id: row.id,
              reason: validity.reason,
              err: expireErr.message,
            });
            expireWriteFailed++;
          } else {
            jsonLog("info", { evt: "outbox_expired", id: row.id, reason: validity.reason });
            expired++;
          }
          continue;
        }
      }

      const result = await dispatchOne(row);
      if (result.ok) {
        await supabase.rpc("mark_outbox_done", { p_id: row.id });
        succeeded++;
        jsonLog("info", {
          evt: "outbox_dispatched",
          id: row.id,
          kind: row.kind,
          reservation_id: row.reservation_id,
          attempts: row.attempts + 1,
        });
      } else {
        await supabase.rpc("mark_outbox_failed", {
          p_id: row.id,
          p_error: result.error ?? "unknown",
        });
        failed++;
        jsonLog("warn", {
          evt: "outbox_dispatch_failed",
          id: row.id,
          kind: row.kind,
          reservation_id: row.reservation_id,
          attempts: row.attempts + 1,
          error: result.error,
        });
      }
    }

    return new Response(
      JSON.stringify({
        processed,
        succeeded,
        failed,
        parked: parkedCount,
        parkWriteFailed,
        expired,
        expireWriteFailed,
        automationPending, automationDependency, automationWriteFailed, recovered,
        duration_ms: Date.now() - t0,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    jsonLog("error", {
      evt: "outbox_processor_error",
      err: String(err),
      processed,
      succeeded,
      failed,
      parked: parkedCount,
      parkWriteFailed,
      expired,
      expireWriteFailed,
    });
    return new Response(JSON.stringify({ error: "internal_error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
