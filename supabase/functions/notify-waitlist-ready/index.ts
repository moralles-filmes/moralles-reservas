import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { hasUnitAccess } from "../_shared/authz.ts";
import { automationUuid, decodeAutomationDispatch, selectWaitlistAutomationRoute } from "../_shared/whatsapp-automation-producer-routing.ts";

const url = Deno.env.get("SUPABASE_URL")!;
const db = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors });
const validInstant = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) && Date.parse(value) <= Date.now();

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);
  const { data: auth, error: authError } = await db.auth.getUser(authHeader.slice(7));
  if (authError || !auth.user) return json({ error: "unauthorized" }, 401);
  let body: unknown;
  try { body = await req.json(); } catch { return json({ error: "invalid_request" }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).some(key => key !== "waitlist_id" && key !== "message")) return json({ error: "invalid_request" }, 400);
  const { waitlist_id: id, message } = body as { waitlist_id?: unknown; message?: unknown };
  if (!automationUuid(id) || (message !== undefined && (typeof message !== "string" || !message.trim() || message.length > 4000)))
    return json({ error: "invalid_request" }, 400);

  try {
    const { data: entry, error: readError } = await db.from("waitlist")
      .select("id,unit_id,status,notified_at,notified_server_at,customer_phone") .eq("id", id).maybeSingle();
    if (readError) throw new Error("waitlist_read_failed");
    if (!entry) return json({ error: "forbidden" }, 403);
    if (!(await hasUnitAccess(db, auth.user.id, entry.unit_id))) return json({ error: "forbidden" }, 403);

    const route = await selectWaitlistAutomationRoute(async (table, columns, predicates, cardinality) => {
      let query = db.from(table).select(columns);
      for (const [column, value] of predicates) query = query.eq(column, value);
      const result = await (cardinality === "single" ? query.maybeSingle() : query);
      if (result.error) throw new Error("route_read_failed");
      return result.data;
    }, { kind: "waitlist_table_ready", unitId: entry.unit_id, waitlistId: entry.id }, async (kind, resourceId) => {
      const { data, error } = await db.rpc("get_whatsapp_v2_service_route",
        { p_kind: kind, p_resource_id: resourceId });
      if (error) throw new Error("service_route_read_failed");
      return data;
    });
    if (route.path === "dependency") return json({ error: "automation_dependency_unavailable" }, 503);
    if (route.path === "disabled") return json({ success: false, sent: false,
      error: "service_not_enabled", skipped: "service_not_enabled", statusUpdated: false }, 200);
    if (route.path === "managed") {
      // O primeiro clique cria o fato no servidor. Um retry usa exatamente o
      // notified_at persistido, inclusive quando o despacho anterior falhou.
      // Job durável precede estado/telefone mutáveis: reconsulta seu resultado
      // mesmo que o cliente tenha sido sentado ou apagado desde o aceite.
      if (!route.existingJobId && entry.status === "waiting") {
        if (!entry.customer_phone) return json({ error: "no_phone" }, 409);
        const { data: updated, error: updateError } = await db.from("waitlist")
          .update({ status: "notified", notified_at: new Date().toISOString() })
          .eq("id", entry.id).eq("unit_id", entry.unit_id).eq("status", "waiting")
          .select("id,unit_id,status,notified_at,notified_server_at");
        if (updateError) throw new Error("waitlist_update_failed");
        if (updated?.length !== 1 || updated[0].status !== "notified"
          || !validInstant(updated[0].notified_at) || updated[0].notified_server_at !== updated[0].notified_at)
          return json({ error: "waitlist_status_changed" }, 409);
      } else if (!route.existingJobId && (entry.status !== "notified" || !validInstant(entry.notified_at)
        || entry.notified_server_at !== entry.notified_at)) {
        return json({ error: "waitlist_fact_unavailable" }, 409);
      }
      const internalKey = Deno.env.get("INTERNAL_API_KEY");
      if (!internalKey) throw new Error("internal_auth_unavailable");
      let outcome = null;
      try {
        const response = await fetch(`${url}/functions/v1/send-scheduled-whatsapp`, {
          method: "POST", headers: { "Content-Type": "application/json", "x-internal-key": internalKey, Authorization: authHeader },
          body: JSON.stringify({ action: "dispatch_operator", kind: "waitlist_table_ready", resource_id: entry.id, unit_id: entry.unit_id }),
          signal: AbortSignal.timeout(25_000),
        });
        outcome = response.ok ? decodeAutomationDispatch(await response.json()) : null;
      } catch { /* Falha fechada; o fato persistido permite retry. */ }
      if (!outcome) throw new Error("automation_dispatch_unavailable");
      const sent = outcome.state === "accepted" || outcome.state === "reconciled";
      return json({ success: sent, sent, statusUpdated: entry.status === "notified" || !route.existingJobId,
        existing: !!route.existingJobId, automation: outcome },
        sent ? 200 : outcome.state === "not_enqueued" ? 409 : 202);
    }

    if (entry.status !== "waiting") return json({ error: "waitlist_status_changed" }, 409);
    if (!entry.customer_phone) return json({ error: "no_phone" }, 409);
    if (typeof message !== "string") return json({ error: "message_required" }, 400);
    const internalKey = Deno.env.get("INTERNAL_API_KEY");
    if (!internalKey) throw new Error("internal_auth_unavailable");
    const response = await fetch(`${url}/functions/v1/send-whatsapp`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-internal-key": internalKey },
      body: JSON.stringify({ phone: entry.customer_phone, message, unit_id: entry.unit_id,
        kind: "waitlist_table_ready", waitlist_id: entry.id, fact_at: new Date().toISOString() }),
      signal: AbortSignal.timeout(25_000),
    });
    const result = await response.json().catch(() => null) as { success?: boolean; error?: string; warning?: string } | null;
    if (!response.ok || result?.success !== true) return json({ error: result?.error ?? "whatsapp_send_failed" }, 502);
    const { data: updated, error: updateError } = await db.from("waitlist")
      .update({ status: "notified", notified_at: new Date().toISOString() })
      .eq("id", entry.id).eq("unit_id", entry.unit_id).eq("status", "waiting")
      .select("id");
    return json({ success: true, sent: true, statusUpdated: !updateError && updated?.length === 1,
      warning: result.warning === "CONVERSATION_RECONCILIATION_REQUIRED" ? result.warning : undefined },
      response.status === 202 ? 202 : 200);
  } catch (error) {
    console.error("[notify-waitlist-ready]", error);
    return json({ error: "internal_error" }, 503);
  }
});
