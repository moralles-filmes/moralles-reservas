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
import {
  resolveWhatsAppGateByUnit,
  clearWhatsAppGateCache,
} from "../_shared/whatsapp-service-gate.ts";

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
    body = { record: { id: row.reservation_id, unit_id: row.unit_id } };
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

  // Data e hora da reserva são horário local (BRT); comparar em BRT.
  // `r.time` chega do Postgres como "HH:MM:SS" (coluna `time`, mesmo padrão de
  // `formatTime` em process-reservation-reminders) — normaliza pra "HH:MM"
  // antes de montar o literal ISO. Sem o slice, o literal ficaria com dois
  // blocos de segundos ("...T19:00:00:00-03:00"), o `Date` resultante vira
  // Invalid Date (NaN) e a comparação `when < Date.now()` nunca é verdadeira
  // — a checagem de "reserva no passado" fica sempre desligada.
  const timeHHMM = (r.time ?? "23:59").slice(0, 5);
  const when = new Date(`${r.date}T${timeHHMM}:00-03:00`).getTime();
  if (when < Date.now()) return { ok: false, reason: "reservation_in_the_past" };

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

  try {
    // Pega lote de pendentes due — atomicamente marca como 'processing' pra
    // evitar duplo processamento se duas execuções concorrentes pegam o mesmo
    // job. UPDATE ... RETURNING garante que só um wins por linha.
    const { data: claimed, error: claimErr } = await supabase
      .from("notification_outbox")
      .update({ status: "processing", updated_at: new Date().toISOString() })
      .eq("status", "pending")
      .lte("next_attempt_at", new Date().toISOString())
      .select("id, reservation_id, unit_id, kind, attempts")
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
      const gate = await resolveWhatsAppGateByUnit(supabase, row.unit_id);
      if (gate?.enforced.sending) parked.push(row);
      else toDispatch.push(row);
    }

    if (parked.length > 0) {
      // ESTACIONAMENTO: volta a 'pending', adia uma hora e NÃO incrementa
      // `attempts`. Sem isso, o teto de 5 tentativas é consumido pela suspensão
      // e o job vira 'dead' por não ter sido enviado enquanto o cliente estava
      // suspenso — perdendo a mensagem de vez quando ele pagar.
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
        jsonLog("error", { evt: "outbox_park_failed", count: parked.length, err: parkErr.message });
      } else {
        jsonLog("info", { evt: "outbox_parked", count: parked.length });
      }
    }
    parkedCount = parked.length;

    for (const row of toDispatch) {
      // Revalidação só se aplica a 'confirmation' — para 'cancellation' o
      // status já ESPERADO é 'cancelled' (é por isso que a notificação existe),
      // então rodar o mesmo stillValid rejeitaria toda cancelação legítima.
      // Hoje 'cancellation' nunca é enfileirado (só o trigger de confirmation
      // insere no outbox) e dispatchOne já devolve erro permanente pra ele.
      if (row.kind === "confirmation") {
        const validity = await stillValid(row);
        if (!validity.ok) {
          await supabase
            .from("notification_outbox")
            .update({
              status: "done",
              last_error: `expired_after_suspension:${validity.reason}`,
              updated_at: new Date().toISOString(),
            })
            .eq("id", row.id);
          jsonLog("info", { evt: "outbox_expired", id: row.id, reason: validity.reason });
          expired++;
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
        expired,
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
      expired,
    });
    return new Response(JSON.stringify({ error: "internal_error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
