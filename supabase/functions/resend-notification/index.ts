// Reenvio de mensagem WhatsApp a partir do painel "Entregas" (Operacional).
//
// Ponto ÚNICO de reenvio chamado pelo frontend (uma chamada cobre todos os
// kinds). Auth própria: JWT de unit member OU platform_admin da unit (espelha
// o authorize de send-whatsapp). Defense-in-depth: confere que o recurso
// (waitlist/reservation) pertence à unit antes de reenviar.
//
// Roteamento por kind:
//   * waitlist_entered / waitlist_table_ready → renderiza template (customizado
//     ou default) e chama send-whatsapp (x-internal-key). O UPSERT do
//     recordNotification (send-whatsapp) re-rastreia a entrega do novo envio.
//   * confirmation → re-invoca send-confirmation com resend_whatsapp_only=true
//     (não reenvia e-mail).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeadersFor } from "../_shared/cors.ts";
import { jsonLog } from "../_shared/security.ts";
import {
  DEFAULT_ENTERED_BODY,
  DEFAULT_TABLE_READY_BODY,
  renderWaitlistTemplate,
} from "../_shared/waitlist-defaults.ts";
import {
  decideMessageTtl,
  brtFactAt,
  type MessageTtlReason,
} from "../_shared/whatsapp-message-ttl-core.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const INTERNAL_API_KEY = Deno.env.get("INTERNAL_API_KEY") ?? "";
const APP_BASE_URL = Deno.env.get("APP_BASE_URL") ?? "https://reservas.moralles.com.br";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const RESENDABLE = new Set(["waitlist_entered", "waitlist_table_ready", "confirmation"]);

/**
 * ESTE é o caminho que o prazo de validade realmente protege.
 *
 * Depois de uma queda longa de canal, o painel Entregas fica cheio de
 * não-entregues antigos — em 2026-09-03 foram 88 de uma vez — e reenviar em
 * lote é um clique por linha. Sem esta guarda, a recuperação de um incidente de
 * bloqueio é uma segunda rajada de mensagens que já perderam o sentido.
 *
 * Mensagem em PT-BR porque quem lê é o operador no painel, não um worker.
 */
const EXPIRED_COPY: Record<string, string> = {
  waitlist_entered: "Este aviso de entrada na fila é antigo demais para ser reenviado.",
  waitlist_table_ready: "Este aviso de mesa pronta é antigo demais para ser reenviado.",
  confirmation: "A reserva desta confirmação já passou — o reenvio não faz mais sentido.",
};

function expiredResponse(kind: string, reason: MessageTtlReason, expiresAt: string | null) {
  return {
    success: false,
    discarded: true,
    reason,
    expires_at: expiresAt,
    // `error` segue sendo CÓDIGO, como no resto da EF — a UI tem um mapa de
    // códigos e quebraria se recebesse frase aqui. A frase vai em `message`,
    // que só esta recusa preenche, porque a copy útil é por kind e um código
    // único não consegue dizer "mesa pronta" versus "entrada na fila".
    error: "message_expired",
    message: EXPIRED_COPY[kind] ?? "Esta mensagem é antiga demais para ser reenviada.",
  };
}

// JWT de unit member OU platform_admin da unit. Espelha send-whatsapp.authorize.
async function authorizeMember(req: Request, unitId: string): Promise<boolean> {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt || !unitId) return false;
  const { data: userRes, error } = await supabase.auth.getUser(jwt);
  if (error || !userRes.user) return false;
  const userId = userRes.user.id;
  const [pa, member] = await Promise.all([
    supabase.from("platform_admins").select("user_id").eq("user_id", userId).maybeSingle(),
    supabase.from("unit_members").select("role").eq("user_id", userId).eq("unit_id", unitId).maybeSingle(),
  ]);
  return !!pa.data || !!member.data;
}

serve(async (req) => {
  const cors = corsHeadersFor(req);
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  let body: {
    kind?: string;
    unit_id?: string;
    waitlist_id?: string;
    reservation_id?: string;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const { kind, unit_id, waitlist_id, reservation_id } = body ?? {};
  if (!kind || !unit_id) return json({ error: "kind e unit_id são obrigatórios" }, 400);
  if (!RESENDABLE.has(kind)) return json({ error: "kind_not_resendable" }, 400);

  if (!(await authorizeMember(req, unit_id))) {
    return json({ error: "unauthorized" }, 401);
  }

  try {
    // Resolve the resource before consulting its pinned ledger. No caller job ID
    // or new producer fact is accepted by this existing resend entrypoint.
    if (kind === "confirmation" || kind === "waitlist_entered") {
      const resourceId = kind === "confirmation" ? reservation_id : waitlist_id;
      const resourceColumn = kind === "confirmation" ? "reservation_id" : "waitlist_id";
      if (!resourceId) return json({ error: "resource_required" }, 400);
      const resource = await supabase.from(kind === "confirmation" ? "reservations" : "waitlist")
        .select("id,unit_id").eq("id", resourceId).maybeSingle();
      if (resource.error) return json({ error: "dependency_unavailable" }, 503);
      if (!resource.data || resource.data.unit_id !== unit_id) return json({ error: "not_found_or_cross_tenant" }, 403);
      const job = await supabase.from("whatsapp_automation_jobs").select("id,state,provider_message_id,posting_started_at")
        .eq("unit_id", unit_id).eq("kind", kind).eq(resourceColumn, resourceId).maybeSingle();
      if (job.error) return json({ error: "dependency_unavailable" }, 503);
      if (job.data) {
        if (job.data.provider_message_id || job.data.posting_started_at || !["queued", "retry_wait", "blocked", "paused"].includes(job.data.state))
          return json({ success: false, error: "automation_resend_refused" }, 409);
        const response = await fetch(`${SUPABASE_URL}/functions/v1/send-scheduled-whatsapp`, {
          method: "POST", headers: { "Content-Type": "application/json", "x-internal-key": INTERNAL_API_KEY },
          body: JSON.stringify({ action: "dispatch_existing", job_id: job.data.id }),
        });
        const result = await response.json().catch(() => null);
        if (!response.ok) return json({ success: false, error: "dependency_unavailable" }, 503);
        return result?.state === "accepted" || result?.state === "reconciled"
          ? json({ success: true }) : json({ success: false, error: "automation_resend_refused" }, 409);
      }
      const adoption = await supabase.from("whatsapp_automation_adoptions").select("unit_id").eq("unit_id", unit_id).maybeSingle();
      if (adoption.error) return json({ error: "dependency_unavailable" }, 503);
      if (adoption.data) return json({ success: false, error: "automation_resend_refused" }, 409);
    }
    // ── Confirmação de reserva ────────────────────────────────────────────────
    if (kind === "confirmation") {
      if (!reservation_id) return json({ error: "reservation_id obrigatório" }, 400);
      const { data: r } = await supabase
        .from("reservations")
        .select("id, unit_id, date, time")
        .eq("id", reservation_id)
        .maybeSingle();
      if (!r || r.unit_id !== unit_id) return json({ error: "not_found_or_cross_tenant" }, 403);

      const ttl = decideMessageTtl({
        kind,
        factAt: brtFactAt(r.date as string, r.time as string),
        now: Date.now(),
      });
      if (ttl.decision === "discard") {
        jsonLog("info", {
          evt: "resend_expired_refused",
          kind,
          unit_id,
          reservation_id,
          expires_at: ttl.expiresAt,
        });
        return json(expiredResponse(kind, ttl.reason, ttl.expiresAt), 200);
      }

      const res = await fetch(`${SUPABASE_URL}/functions/v1/send-confirmation`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-internal-key": INTERNAL_API_KEY },
        body: JSON.stringify({ record: { id: reservation_id, unit_id }, resend_whatsapp_only: true }),
      });
      const data = (await res.json().catch(() => null)) as { success?: boolean } | null;
      if (!res.ok || data?.success !== true) {
        return json({ success: false, error: "send_failed" }, 502);
      }
      return json({ success: true });
    }

    // ── Fila: entrada / mesa pronta ───────────────────────────────────────────
    if (!waitlist_id) return json({ error: "waitlist_id obrigatório" }, 400);
    const { data: entry } = await supabase
      .from("waitlist")
      .select("id, unit_id, customer_name, customer_phone, party_size, code, created_at")
      .eq("id", waitlist_id)
      .maybeSingle();
    if (!entry || entry.unit_id !== unit_id) return json({ error: "not_found_or_cross_tenant" }, 403);
    if (!entry.customer_phone) return json({ success: false, error: "no_phone" }, 400);

    // O fato de `waitlist_entered` é a entrada na fila. O de `waitlist_table_ready`
    // é o instante em que o operador chamou a mesa — não existe coluna para isso,
    // e o melhor registro é o `sent_at` do envio original, que é justamente a
    // linha que o painel Entregas está oferecendo para reenvio. Sem essa linha
    // (reenvio de algo que nunca chegou a ser gravado), cai em `created_at`:
    // conservador, porque a chamada de mesa nunca antecede a entrada na fila.
    let factAt: string | null = entry.created_at as string;
    if (kind === "waitlist_table_ready") {
      const { data: original } = await supabase
        .from("notifications_sent")
        .select("sent_at")
        .eq("waitlist_id", waitlist_id)
        .eq("kind", kind)
        .maybeSingle();
      factAt = (original?.sent_at as string | undefined) ?? (entry.created_at as string);
    }

    const ttl = decideMessageTtl({ kind, factAt, now: Date.now() });
    if (ttl.decision === "discard") {
      jsonLog("info", {
        evt: "resend_expired_refused",
        kind,
        unit_id,
        waitlist_id,
        expires_at: ttl.expiresAt,
      });
      return json(expiredResponse(kind, ttl.reason, ttl.expiresAt), 200);
    }

    const event = kind === "waitlist_entered" ? "entered" : "table_ready";
    const [unitRes, tplRes] = await Promise.all([
      supabase.from("units").select("name").eq("id", unit_id).maybeSingle(),
      supabase
        .from("waitlist_message_templates")
        .select("customized, body")
        .eq("unit_id", unit_id)
        .eq("event", event)
        .maybeSingle(),
    ]);
    const def = event === "entered" ? DEFAULT_ENTERED_BODY : DEFAULT_TABLE_READY_BODY;
    const tpl = tplRes.data as { customized?: boolean; body?: string } | null;
    const tplBody = tpl?.customized && tpl.body && tpl.body.trim() ? tpl.body : def;

    const message = renderWaitlistTemplate(tplBody, {
      cliente_nome: entry.customer_name as string,
      unidade_nome: (unitRes.data?.name as string) ?? "nosso restaurante",
      party_size: entry.party_size as number,
      codigo_fila: (entry.code as number) ?? null,
      link_status: `${APP_BASE_URL}/acompanhar/${waitlist_id}`,
    });

    const res = await fetch(`${SUPABASE_URL}/functions/v1/send-whatsapp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-key": INTERNAL_API_KEY },
      body: JSON.stringify({ phone: entry.customer_phone, message, unit_id, kind, waitlist_id, fact_at: factAt }),
    });
    const data = (await res.json().catch(() => null)) as
      | { success?: boolean; error?: string; discarded?: boolean }
      | null;
    // `send-whatsapp` reavalia o mesmo prazo e pode descartar entre a checagem
    // acima e o envio. Descarte não é falha de envio: devolver 502 mostraria
    // "erro ao reenviar" para uma recusa deliberada.
    if (data?.discarded === true) {
      return json(expiredResponse(kind, "expired", null), 200);
    }
    if (!res.ok || data?.success === false) {
      return json({ success: false, error: data?.error ?? "send_failed" }, 502);
    }
    return json({ success: true });
  } catch (err) {
    jsonLog("error", { evt: "resend_notification_error", kind, err: String(err).slice(0, 200) });
    return json({ error: "internal_error" }, 500);
  }
});
