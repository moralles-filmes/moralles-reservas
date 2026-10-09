// Processador diário da pesquisa de satisfação D+1.
//
// Chamado via pg_cron 1x ao dia (17:00 UTC = 14:00 BRT). Pra cada unit:
//   1. Verifica `settings.survey_d1_enabled` (default true) — pula se off.
//   2. Carrega template de `reservation_message_templates` (event=survey_d1)
//      ou usa DEFAULT_SURVEY_BODY se não houver / customized=false.
//   3. Chama RPC `get_reservations_for_survey(ontem, unit_id)` — RPC já filtra
//      status='confirmed', do_not_contact=false, satisfaction_rating IS NULL e
//      idempotência via NOT EXISTS em notifications_sent.
//   4. Pra cada reserva elegível, dispara send-whatsapp com kind='survey_d1' e
//      reservation_id. UNIQUE (reservation_id, kind) garante idempotência.
//
// A RESPOSTA do cliente (1-5) é interceptada pelo webhook-whatsapp em
// supabase/functions/webhook-whatsapp/index.ts (rating intercept ~linha 800),
// que grava `reservations.satisfaction_rating` e dispara giftback after_rating
// se houver rule. O comentário em texto livre dentro de 30min após a nota
// também é capturado e grava `satisfaction_comment`.
//
// Auth via x-internal-key. Substitui o workflow N8N survey-d1
// (docs/n8n/workflow-survey-d1.json).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jsonLog, requireInternalAuth, sanitizePhone } from "../_shared/security.ts";
import {
  resolveWhatsAppGateByUnit,
  clearWhatsAppGateCache,
} from "../_shared/whatsapp-service-gate.ts";
import { selectReservationAutomationRoute, decodeAutomationDispatch } from "../_shared/whatsapp-automation-producer-routing.ts";
import { brtFactAt } from "../_shared/whatsapp-message-ttl-core.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const INTERNAL_API_KEY = Deno.env.get("INTERNAL_API_KEY") ?? "";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const DEFAULT_SURVEY_BODY =
  "Oi, {{cliente_nome}}! 🙂\n\n" +
  "Esperamos que tenha gostado da sua visita ao {{unidade_nome}} ontem.\n\n" +
  "De 1 a 5, como você avalia sua experiência? (responda só o número)\n\n" +
  "Obrigado por nos ajudar a melhorar! 💛";

function renderTemplate(
  template: string,
  vars: { cliente_nome: string; codigo: string; unidade_nome: string },
): string {
  return template
    .replaceAll("{{cliente_nome}}", vars.cliente_nome)
    .replaceAll("{{codigo}}", vars.codigo)
    .replaceAll("{{unidade_nome}}", vars.unidade_nome);
}

function yesterdayDateBRT(): string {
  // Cron roda 17:00 UTC (14:00 BRT). UTC - 1 dia equivale a "ontem em BRT"
  // nesse horário (BRT = UTC-3, calendário ainda casa).
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

interface UnitContext {
  unit_id: string;
  unit_name: string;
  enabled: boolean;
  body: string;
}

async function loadUnitContext(unitId: string): Promise<UnitContext> {
  const [unitRes, settingsRes, templateRes] = await Promise.all([
    supabase.from("units").select("name").eq("id", unitId).maybeSingle(),
    supabase
      .from("settings")
      .select("value")
      .eq("unit_id", unitId)
      .eq("key", "survey_d1_enabled")
      .maybeSingle(),
    supabase
      .from("reservation_message_templates")
      .select("customized, body")
      .eq("unit_id", unitId)
      .eq("event", "survey_d1")
      .maybeSingle(),
  ]);

  const rawEnabled = settingsRes.data?.value as unknown;
  const enabled = rawEnabled === false || rawEnabled === "false" ? false : true;

  const tpl = templateRes.data as { customized?: boolean; body?: string } | null;
  const body =
    tpl?.customized && tpl.body && tpl.body.trim()
      ? tpl.body
      : DEFAULT_SURVEY_BODY;

  return {
    unit_id: unitId,
    unit_name: (unitRes.data?.name as string) ?? "nosso restaurante",
    enabled,
    body,
  };
}

interface SurveyRow {
  reservation_id: string;
  unit_id: string;
  customer_phone: string;
  customer_name: string;
  code: string;
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

  // Cache do gate é por invocação — zera aqui, mesmo padrão do unitCache que
  // outros workers já fazem, senão um isolate quente serve estado de
  // suspensão velho pra um cliente que acabou de pagar.
  clearWhatsAppGateCache();

  const t0 = Date.now();
  const targetDate = yesterdayDateBRT();
  const errors: string[] = [];
  let dispatched = 0;
  let failed = 0;
  let skippedUnits = 0;
  let skippedSuspended = 0;

  const { data: units, error: unitsErr } = await supabase
    .from("units")
    .select("id");
  if (unitsErr) {
    jsonLog("error", { evt: "survey_units_load_failed", err: unitsErr.message });
    return new Response(JSON.stringify({ error: unitsErr.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  for (const u of (units ?? []) as Array<{ id: string }>) {
    const unitId = u.id;

    let ctx: UnitContext;
    try {
      ctx = await loadUnitContext(unitId);
    } catch (err) {
      errors.push(`unit=${unitId} ctx: ${String(err).slice(0, 150)}`);
      continue;
    }

    if (!ctx.enabled) {
      skippedUnits++;
      jsonLog("info", { evt: "survey_unit_skipped", unit_id: unitId, reason: "disabled" });
      continue;
    }

    const { data: rows, error: rpcErr } = await supabase.rpc(
      "get_reservations_for_survey",
      { p_target_date: targetDate, p_unit_id: unitId },
    );
    if (rpcErr) {
      errors.push(`unit=${unitId} rpc: ${rpcErr.message.slice(0, 150)}`);
      continue;
    }

    for (const row of (rows ?? []) as SurveyRow[]) {
      const route = await selectReservationAutomationRoute(async (table, columns, predicates, cardinality) => {
        let query = supabase.from(table).select(columns);
        for (const [column, value] of predicates) query = query.eq(column, value);
        const result = await (cardinality === 'single' ? query.maybeSingle() : query);
        if (result.error) throw result.error;
        return result.data;
      }, { kind: 'survey_d1', unitId, reservationId: row.reservation_id });
      if (route.path !== 'legacy') {
        if (route.path === 'dependency') { failed++; continue; }
        try {
          const response = await fetch(`${SUPABASE_URL}/functions/v1/send-scheduled-whatsapp`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'x-internal-key': INTERNAL_API_KEY },
            body: JSON.stringify(route.existingJobId ? { action: 'dispatch_existing', job_id: route.existingJobId }
              : { action: 'dispatch', kind: 'survey_d1', resource_id: row.reservation_id, unit_id: unitId, target_date: targetDate }),
            signal: AbortSignal.timeout(25_000),
          });
          const outcome = response.ok ? decodeAutomationDispatch(await response.json()) : null;
          if (outcome?.state === 'accepted' || outcome?.state === 'reconciled') dispatched++;
          else failed++;
        } catch { failed++; }
        continue;
      }
      const gate = await resolveWhatsAppGateByUnit(supabase, unitId);
      if (gate?.enforced.sending) {
        skippedSuspended++;
        jsonLog('info', { evt: 'worker_skipped_whatsapp_suspended', unit_id: unitId, state: gate.state });
        continue;
      }
      const message = renderTemplate(ctx.body, {
        cliente_nome: row.customer_name,
        codigo: row.code,
        unidade_nome: ctx.unit_name,
      });

      try {
        const sendRes = await fetch(`${SUPABASE_URL}/functions/v1/send-whatsapp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-internal-key": INTERNAL_API_KEY,
          },
          body: JSON.stringify({
            phone: row.customer_phone,
            message,
            unit_id: unitId,
            kind: "survey_d1",
            reservation_id: row.reservation_id,
            // A RPC não devolve a hora da reserva, só a data. Fim do dia dá ao
            // prazo de 48h a folga máxima dentro do dia certo — arredondar para
            // o início encurtaria a validade por um detalhe de shape da query.
            fact_at: brtFactAt(targetDate, "23:59"),
          }),
        });

        if (sendRes.ok) {
          dispatched++;
          jsonLog("info", {
            evt: "survey_dispatched",
            unit_id: unitId,
            reservation_id: row.reservation_id,
            phone: sanitizePhone(row.customer_phone),
          });
        } else {
          failed++;
          const errText = await sendRes.text().catch(() => "");
          jsonLog("warn", {
            evt: "survey_send_failed",
            unit_id: unitId,
            reservation_id: row.reservation_id,
            status: sendRes.status,
            body: errText.slice(0, 200),
          });
        }
      } catch (err) {
        failed++;
        jsonLog("warn", {
          evt: "survey_send_error",
          unit_id: unitId,
          reservation_id: row.reservation_id,
          err: String(err).slice(0, 200),
        });
      }
    }
  }

  jsonLog("info", {
    evt: "survey_done",
    target_date: targetDate,
    dispatched,
    failed,
    skipped_units: skippedUnits,
    skipped_suspended: skippedSuspended,
    errors_count: errors.length,
    duration_ms: Date.now() - t0,
  });

  return new Response(
    JSON.stringify({
      target_date: targetDate,
      dispatched,
      failed,
      skipped_units: skippedUnits,
      skipped_suspended: skippedSuspended,
      errors,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
});
