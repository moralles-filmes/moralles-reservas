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

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const INTERNAL_API_KEY = Deno.env.get("INTERNAL_API_KEY") ?? "";
const APP_BASE_URL = Deno.env.get("APP_BASE_URL") ?? "https://reservas.moralles.com.br";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const RESENDABLE = new Set(["waitlist_entered", "waitlist_table_ready", "confirmation"]);

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
    // ── Confirmação de reserva ────────────────────────────────────────────────
    if (kind === "confirmation") {
      if (!reservation_id) return json({ error: "reservation_id obrigatório" }, 400);
      const { data: r } = await supabase
        .from("reservations")
        .select("id, unit_id")
        .eq("id", reservation_id)
        .maybeSingle();
      if (!r || r.unit_id !== unit_id) return json({ error: "not_found_or_cross_tenant" }, 403);

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
      .select("id, unit_id, customer_name, customer_phone, party_size, code")
      .eq("id", waitlist_id)
      .maybeSingle();
    if (!entry || entry.unit_id !== unit_id) return json({ error: "not_found_or_cross_tenant" }, 403);
    if (!entry.customer_phone) return json({ success: false, error: "no_phone" }, 400);

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
      body: JSON.stringify({ phone: entry.customer_phone, message, unit_id, kind, waitlist_id }),
    });
    const data = (await res.json().catch(() => null)) as { success?: boolean; error?: string } | null;
    if (!res.ok || data?.success === false) {
      return json({ success: false, error: data?.error ?? "send_failed" }, 502);
    }
    return json({ success: true });
  } catch (err) {
    jsonLog("error", { evt: "resend_notification_error", kind, err: String(err).slice(0, 200) });
    return json({ error: "internal_error" }, 500);
  }
});
