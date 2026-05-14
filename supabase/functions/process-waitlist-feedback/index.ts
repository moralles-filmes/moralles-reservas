// Processador diário da pesquisa pós-fila (waitlist feedback) D+1.
//
// Chamado via pg_cron 1x ao dia (17:00 UTC = 14:00 BRT). Pra cada unit:
//   1. Verifica `settings.waitlist_feedback_enabled` (default true) — pula se off.
//   2. Carrega template de `waitlist_message_templates` (event=feedback)
//      ou usa DEFAULT_FEEDBACK_BODY se não houver / customized=false.
//   3. Chama RPC `get_waitlist_for_feedback(ontem, unit_id)` — RPC já filtra
//      status='seated', seated_at = ontem (BRT), customer_phone IS NOT NULL e
//      idempotência via NOT EXISTS em notifications_sent.
//   4. Pra cada entry elegível, dispara send-whatsapp com kind='waitlist_feedback'
//      + waitlist_id. UNIQUE parcial (waitlist_id, kind) garante idempotência.
//
// Espelha process-satisfaction-surveys. Auth via x-internal-key.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jsonLog, requireInternalAuth, sanitizePhone } from "../_shared/security.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const INTERNAL_API_KEY = Deno.env.get("INTERNAL_API_KEY") ?? "";
const APP_BASE_URL = Deno.env.get("APP_BASE_URL") ?? "https://reservas.moralles.com.br";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const DEFAULT_FEEDBACK_BODY =
  "Obrigado por escolher {{unidade_nome}}, {{cliente_nome}}! " +
  "Conte pra gente como foi sua experiência: {{link_status}}";

function renderTemplate(
  template: string,
  vars: {
    cliente_nome: string;
    unidade_nome: string;
    party_size: number | null;
    codigo_fila: number | null;
    link_status: string;
  },
): string {
  return template
    .replaceAll("{{cliente_nome}}", vars.cliente_nome)
    .replaceAll("{{unidade_nome}}", vars.unidade_nome)
    .replaceAll("{{party_size}}", vars.party_size != null ? String(vars.party_size) : "")
    .replaceAll("{{codigo_fila}}", vars.codigo_fila != null ? String(vars.codigo_fila) : "")
    .replaceAll("{{link_status}}", vars.link_status);
}

function yesterdayDateBRT(): string {
  // Cron roda 17:00 UTC (14:00 BRT). UTC - 1 dia equivale a "ontem em BRT".
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

interface UnitContext {
  unit_id: string;
  unit_name: string;
  unit_slug: string;
  enabled: boolean;
  body: string;
}

async function loadUnitContext(unitId: string): Promise<UnitContext> {
  const [unitRes, settingsRes, templateRes] = await Promise.all([
    supabase.from("units").select("name, slug").eq("id", unitId).maybeSingle(),
    supabase
      .from("settings")
      .select("value")
      .eq("unit_id", unitId)
      .eq("key", "waitlist_feedback_enabled")
      .maybeSingle(),
    supabase
      .from("waitlist_message_templates")
      .select("customized, body")
      .eq("unit_id", unitId)
      .eq("event", "feedback")
      .maybeSingle(),
  ]);

  const rawEnabled = settingsRes.data?.value as unknown;
  const enabled = rawEnabled === false || rawEnabled === "false" ? false : true;

  const tpl = templateRes.data as { customized?: boolean; body?: string } | null;
  const body =
    tpl?.customized && tpl.body && tpl.body.trim()
      ? tpl.body
      : DEFAULT_FEEDBACK_BODY;

  return {
    unit_id: unitId,
    unit_name: (unitRes.data?.name as string) ?? "nosso restaurante",
    unit_slug: (unitRes.data?.slug as string) ?? "",
    enabled,
    body,
  };
}

interface FeedbackRow {
  waitlist_id: string;
  unit_id: string;
  customer_phone: string;
  customer_name: string;
  party_size: number;
  code: number | null;
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
  const targetDate = yesterdayDateBRT();
  const errors: string[] = [];
  let dispatched = 0;
  let failed = 0;
  let skippedUnits = 0;

  const { data: units, error: unitsErr } = await supabase
    .from("units")
    .select("id");
  if (unitsErr) {
    jsonLog("error", { evt: "waitlist_feedback_units_load_failed", err: unitsErr.message });
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
      jsonLog("info", { evt: "waitlist_feedback_unit_skipped", unit_id: unitId, reason: "disabled" });
      continue;
    }

    const { data: rows, error: rpcErr } = await supabase.rpc(
      "get_waitlist_for_feedback",
      { p_target_date: targetDate, p_unit_id: unitId },
    );
    if (rpcErr) {
      errors.push(`unit=${unitId} rpc: ${rpcErr.message.slice(0, 150)}`);
      continue;
    }

    const linkStatus = ctx.unit_slug ? `${APP_BASE_URL}/r/${ctx.unit_slug}` : APP_BASE_URL;

    for (const row of (rows ?? []) as FeedbackRow[]) {
      const message = renderTemplate(ctx.body, {
        cliente_nome: row.customer_name,
        unidade_nome: ctx.unit_name,
        party_size: row.party_size,
        codigo_fila: row.code,
        link_status: linkStatus,
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
            kind: "waitlist_feedback",
            waitlist_id: row.waitlist_id,
          }),
        });

        if (sendRes.ok) {
          dispatched++;
          jsonLog("info", {
            evt: "waitlist_feedback_dispatched",
            unit_id: unitId,
            waitlist_id: row.waitlist_id,
            phone: sanitizePhone(row.customer_phone),
          });
        } else {
          failed++;
          const errText = await sendRes.text().catch(() => "");
          jsonLog("warn", {
            evt: "waitlist_feedback_send_failed",
            unit_id: unitId,
            waitlist_id: row.waitlist_id,
            status: sendRes.status,
            body: errText.slice(0, 200),
          });
        }
      } catch (err) {
        failed++;
        jsonLog("warn", {
          evt: "waitlist_feedback_send_error",
          unit_id: unitId,
          waitlist_id: row.waitlist_id,
          err: String(err).slice(0, 200),
        });
      }
    }
  }

  jsonLog("info", {
    evt: "waitlist_feedback_done",
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
