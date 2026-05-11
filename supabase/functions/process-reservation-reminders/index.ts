// Processador diário do lembrete D-0 (dia da reserva).
//
// Chamado via pg_cron 1x ao dia (13:00 UTC = 10:00 BRT). Pra cada unit:
//   1. Verifica `settings.reminder_d1_enabled` (default true) — pula se off.
//   2. Carrega template de `reservation_message_templates` (event=reminder_d1)
//      ou usa DEFAULT_REMINDER_BODY se não houver / customized=false.
//   3. Chama RPC `get_reservations_for_reminder(hoje, unit_id)` — RPC já
//      filtra status='confirmed', do_not_contact=false e idempotência via
//      NOT EXISTS em notifications_sent.
//   4. Pra cada reserva elegível, dispara send-whatsapp com kind='reminder_d1'
//      e reservation_id. UNIQUE (reservation_id, kind) em notifications_sent
//      garante idempotência caso a função rode 2x.
//
// Auth via x-internal-key (mesmo padrão do voucher worker, outbox worker).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jsonLog, requireInternalAuth, sanitizePhone } from "../_shared/security.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const INTERNAL_API_KEY = Deno.env.get("INTERNAL_API_KEY") ?? "";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const DEFAULT_REMINDER_BODY =
  "Olá, {{cliente_nome}}! 👋\n\n" +
  "Lembrete da sua reserva hoje às {{horario}} para {{party_size}} pessoa(s) em {{unidade_nome}}.\n\n" +
  "Código: #{{codigo}}\n\n" +
  "Para alterar ou cancelar, é só responder esta mensagem. Te esperamos! 🍽️";

function renderTemplate(
  template: string,
  vars: {
    cliente_nome: string;
    horario: string;
    party_size: number;
    codigo: string;
    unidade_nome: string;
  },
): string {
  return template
    .replaceAll("{{cliente_nome}}", vars.cliente_nome)
    .replaceAll("{{horario}}", vars.horario)
    .replaceAll("{{party_size}}", String(vars.party_size))
    .replaceAll("{{codigo}}", vars.codigo)
    .replaceAll("{{unidade_nome}}", vars.unidade_nome);
}

function formatTime(timeStr: string): string {
  // RPC retorna time como "HH:MM:SS" — formata pra HH:MM.
  return (timeStr ?? "").slice(0, 5);
}

function todayDateBRT(): string {
  // Cron roda 13:00 UTC (10:00 BRT). Em BRT = UTC-3, o dia corrente em BRT
  // é a data UTC sem offset nesse horário (13:00 UTC = 10:00 BRT, mesmo dia).
  const d = new Date();
  // Aplica offset BRT (-3h) pra garantir a data correta em BRT
  d.setUTCHours(d.getUTCHours() - 3);
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
      .eq("key", "reminder_d1_enabled")
      .maybeSingle(),
    supabase
      .from("reservation_message_templates")
      .select("customized, body")
      .eq("unit_id", unitId)
      .eq("event", "reminder_d1")
      .maybeSingle(),
  ]);

  // settings.reminder_d1_enabled: default true. Aceita boolean nativo e string
  // "true"/"false" porque o campo é jsonb em settings.
  const rawEnabled = settingsRes.data?.value as unknown;
  const enabled = rawEnabled === false || rawEnabled === "false" ? false : true;

  const tpl = templateRes.data as { customized?: boolean; body?: string } | null;
  const body =
    tpl?.customized && tpl.body && tpl.body.trim()
      ? tpl.body
      : DEFAULT_REMINDER_BODY;

  return {
    unit_id: unitId,
    unit_name: (unitRes.data?.name as string) ?? "nosso restaurante",
    enabled,
    body,
  };
}

interface ReminderRow {
  reservation_id: string;
  unit_id: string;
  customer_phone: string;
  customer_name: string;
  reservation_time: string;
  party_size: number;
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

  const t0 = Date.now();
  const targetDate = todayDateBRT();
  const errors: string[] = [];
  let dispatched = 0;
  let failed = 0;
  let skippedUnits = 0;

  const { data: units, error: unitsErr } = await supabase
    .from("units")
    .select("id");
  if (unitsErr) {
    jsonLog("error", { evt: "reminder_units_load_failed", err: unitsErr.message });
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
      jsonLog("info", { evt: "reminder_unit_skipped", unit_id: unitId, reason: "disabled" });
      continue;
    }

    const { data: rows, error: rpcErr } = await supabase.rpc(
      "get_reservations_for_reminder",
      { p_target_date: targetDate, p_unit_id: unitId },
    );
    if (rpcErr) {
      errors.push(`unit=${unitId} rpc: ${rpcErr.message.slice(0, 150)}`);
      continue;
    }

    for (const row of (rows ?? []) as ReminderRow[]) {
      const message = renderTemplate(ctx.body, {
        cliente_nome: row.customer_name,
        horario: formatTime(row.reservation_time),
        party_size: row.party_size,
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
            kind: "reminder_d1",
            reservation_id: row.reservation_id,
          }),
        });

        if (sendRes.ok) {
          dispatched++;
          jsonLog("info", {
            evt: "reminder_dispatched",
            unit_id: unitId,
            reservation_id: row.reservation_id,
            phone: sanitizePhone(row.customer_phone),
          });
        } else {
          failed++;
          const errText = await sendRes.text().catch(() => "");
          jsonLog("warn", {
            evt: "reminder_send_failed",
            unit_id: unitId,
            reservation_id: row.reservation_id,
            status: sendRes.status,
            body: errText.slice(0, 200),
          });
        }
      } catch (err) {
        failed++;
        jsonLog("warn", {
          evt: "reminder_send_error",
          unit_id: unitId,
          reservation_id: row.reservation_id,
          err: String(err).slice(0, 200),
        });
      }
    }
  }

  jsonLog("info", {
    evt: "reminder_done",
    target_date: targetDate,
    dispatched,
    failed,
    skipped_units: skippedUnits,
    errors_count: errors.length,
    duration_ms: Date.now() - t0,
  });

  return new Response(
    JSON.stringify({
      target_date: targetDate,
      dispatched,
      failed,
      skipped_units: skippedUnits,
      errors,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
});
