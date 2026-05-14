// Disparador único da mensagem "entrou na fila".
//
// Chamado por trigger SQL `dispatch_waitlist_entered` (AFTER INSERT em
// `waitlist`) via pg_net + INTERNAL_API_KEY do Vault. Recebe `{ waitlist_id }`,
// resolve o contexto da unidade, renderiza o template `entered` e dispara
// `send-whatsapp` com `kind='waitlist_entered'` + `waitlist_id`.
//
// Idempotência:
//   * UNIQUE parcial (waitlist_id, kind) em `notifications_sent` impede duplicar
//     mesmo que a trigger seja invocada 2x para a mesma entry.
//
// Skips (silenciosos, retorna 200):
//   * customer_phone vazio
//   * settings.waitlist_entered_enabled = false
//   * entry não existe / status != 'waiting'
//
// Auth: x-internal-key.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jsonLog, requireInternalAuth, sanitizePhone } from "../_shared/security.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const INTERNAL_API_KEY = Deno.env.get("INTERNAL_API_KEY") ?? "";
const APP_BASE_URL = Deno.env.get("APP_BASE_URL") ?? "https://reservas.moralles.com.br";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const DEFAULT_ENTERED_BODY =
  "Oi {{cliente_nome}}! Você entrou na fila de espera em {{unidade_nome}}. " +
  "Sua senha é #{{codigo_fila}}. Acompanhe em {{link_status}}";

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

  let body: { waitlist_id?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const waitlistId = body.waitlist_id;
  if (!waitlistId) {
    return new Response(JSON.stringify({ error: "waitlist_id_required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 1. Carrega entry
  const { data: entry, error: entryErr } = await supabase
    .from("waitlist")
    .select("id, unit_id, customer_name, customer_phone, party_size, code, status")
    .eq("id", waitlistId)
    .maybeSingle();

  if (entryErr) {
    jsonLog("error", { evt: "waitlist_entered_load_failed", waitlist_id: waitlistId, err: entryErr.message });
    return new Response(JSON.stringify({ error: entryErr.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!entry) {
    return new Response(JSON.stringify({ skipped: "entry_not_found" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Só dispara se acabou de entrar (waiting). Updates posteriores (notified,
  // seated, cancelled) não devem refazer envio.
  if (entry.status !== "waiting") {
    return new Response(JSON.stringify({ skipped: "status_not_waiting", status: entry.status }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!entry.customer_phone) {
    return new Response(JSON.stringify({ skipped: "no_phone" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const unitId = entry.unit_id as string;

  // 2. Carrega unit + settings + template em paralelo
  const [unitRes, settingsRes, templateRes, slugRes] = await Promise.all([
    supabase.from("units").select("name, slug").eq("id", unitId).maybeSingle(),
    supabase
      .from("settings")
      .select("value")
      .eq("unit_id", unitId)
      .eq("key", "waitlist_entered_enabled")
      .maybeSingle(),
    supabase
      .from("waitlist_message_templates")
      .select("customized, body")
      .eq("unit_id", unitId)
      .eq("event", "entered")
      .maybeSingle(),
    supabase.from("units").select("slug").eq("id", unitId).maybeSingle(),
  ]);

  const rawEnabled = settingsRes.data?.value as unknown;
  const enabled = rawEnabled === false || rawEnabled === "false" ? false : true;
  if (!enabled) {
    return new Response(JSON.stringify({ skipped: "disabled" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const tpl = templateRes.data as { customized?: boolean; body?: string } | null;
  const templateBody =
    tpl?.customized && tpl.body && tpl.body.trim() ? tpl.body : DEFAULT_ENTERED_BODY;

  const unitName = (unitRes.data?.name as string) ?? "nosso restaurante";
  const unitSlug = (slugRes.data?.slug as string) ?? "";
  const linkStatus = unitSlug ? `${APP_BASE_URL}/r/${unitSlug}` : APP_BASE_URL;

  const message = renderTemplate(templateBody, {
    cliente_nome: entry.customer_name as string,
    unidade_nome: unitName,
    party_size: entry.party_size as number,
    codigo_fila: (entry.code as number) ?? null,
    link_status: linkStatus,
  });

  // 3. Dispara send-whatsapp
  try {
    const sendRes = await fetch(`${SUPABASE_URL}/functions/v1/send-whatsapp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-key": INTERNAL_API_KEY,
      },
      body: JSON.stringify({
        phone: entry.customer_phone,
        message,
        unit_id: unitId,
        kind: "waitlist_entered",
        waitlist_id: waitlistId,
      }),
    });

    if (sendRes.ok) {
      jsonLog("info", {
        evt: "waitlist_entered_dispatched",
        unit_id: unitId,
        waitlist_id: waitlistId,
        phone: sanitizePhone(entry.customer_phone as string),
      });
      return new Response(JSON.stringify({ dispatched: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const errText = await sendRes.text().catch(() => "");
    jsonLog("warn", {
      evt: "waitlist_entered_send_failed",
      unit_id: unitId,
      waitlist_id: waitlistId,
      status: sendRes.status,
      body: errText.slice(0, 200),
    });
    return new Response(JSON.stringify({ dispatched: false, status: sendRes.status }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    jsonLog("warn", {
      evt: "waitlist_entered_send_error",
      unit_id: unitId,
      waitlist_id: waitlistId,
      err: String(err).slice(0, 200),
    });
    return new Response(JSON.stringify({ dispatched: false, error: String(err).slice(0, 200) }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
});
