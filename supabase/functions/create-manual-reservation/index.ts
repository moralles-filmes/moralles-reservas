// Edge Function AUTENTICADA para o operador lançar uma reserva manual pelo painel
// (quando o site ou o WhatsApp falham). Reusa a mesma lógica de disponibilidade
// (_shared/availability.ts) e merge de cliente (_shared/resolve-customer.ts) da
// create-reservation pública, mas:
//
//   - Exige JWT e valida membro da unit OU platform_admin via hasUnitAccess
//     (_shared/authz.ts, consulta direta às tabelas — os helpers saíram de `public`).
//   - Aceita `source` ('web'|'whatsapp') — escolhido pelo operador SÓ pra relatório
//     "Origem das reservas". A notificação é DESACOPLADA da origem (ver abaixo).
//   - SEM rate-limit (operador autenticado) e SEM caução/Stripe (reserva isenta).
//   - `override`: força a reserva mesmo sem mesa/fora de horário (flutuante).
//   - `notify`: controla o disparo da confirmação automática INDEPENDENTE da origem.
//
// Desacoplamento da notificação: o trigger enqueue_confirmation_notification (mig 028)
// só enfileira em notification_outbox quando source <> 'whatsapp'. Como aqui a origem
// é livre, reconciliamos o outbox manualmente conforme `notify`.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { genRequestId, jsonLog, sanitizePhone } from "../_shared/security.ts";
import { reserveSlot } from "../_shared/availability.ts";
import { resolveOrCreateCustomer } from "../_shared/resolve-customer.ts";
import { corsHeadersFor } from "../_shared/cors.ts";
import { hasUnitAccess } from "../_shared/authz.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

interface ManualReservationBody {
  unit_id?: string;
  organization_id?: string;
  hall_id?: string | null;
  customer?: {
    name?: string;
    phone?: string;
    email?: string | null;
    birthday?: string | null;
  };
  date?: string; // YYYY-MM-DD
  time?: string; // HH:MM
  party_size?: number;
  notes?: string | null;
  source?: "web" | "whatsapp";
  status?: "confirmed";
  notify?: boolean;
  override?: boolean;
}

function validateBody(b: ManualReservationBody): string | null {
  if (!b.unit_id || typeof b.unit_id !== "string") return "unit_id obrigatório.";
  if (!b.organization_id || typeof b.organization_id !== "string") return "organization_id obrigatório.";
  if (!b.customer || typeof b.customer !== "object") return "customer obrigatório.";
  if (!b.customer.name || b.customer.name.trim().length < 2) return "Nome inválido.";
  const digits = (b.customer.phone ?? "").replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 13) return "Telefone inválido.";
  if (b.customer.birthday) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.customer.birthday)) return "Aniversário inválido (use YYYY-MM-DD).";
    const ms = Date.parse(b.customer.birthday + "T00:00:00Z");
    if (Number.isNaN(ms) || ms > Date.now()) return "Aniversário inválido.";
    const year = parseInt(b.customer.birthday.slice(0, 4), 10);
    if (year < 1900) return "Aniversário inválido.";
  }
  if (!b.date || !/^\d{4}-\d{2}-\d{2}$/.test(b.date)) return "Data inválida (use YYYY-MM-DD).";
  if (!b.time || !/^\d{2}:\d{2}(:\d{2})?$/.test(b.time)) return "Horário inválido (use HH:MM).";
  if (typeof b.party_size !== "number" || b.party_size < 1 || b.party_size > 30) return "party_size inválido.";
  if (b.source !== undefined && b.source !== "web" && b.source !== "whatsapp") return "Origem inválida.";
  if (b.status !== undefined && b.status !== "confirmed") return "Novas reservas não exigem confirmação manual.";
  return null;
}

serve(async (req) => {
  const corsHeaders = corsHeadersFor(req);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ success: false, message: "Método não permitido." }, 405);
  }

  const requestId = genRequestId();

  // Auth: JWT obrigatório
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return json({ success: false, message: "Não autorizado." }, 401);
  }
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) {
    return json({ success: false, message: "Não autorizado." }, 401);
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  try {
    const body = (await req.json()) as ManualReservationBody;
    const validationError = validateBody(body);
    if (validationError) {
      return json({ success: false, reason: "invalid_input", message: validationError }, 400);
    }

    const phone = (body.customer!.phone ?? "").replace(/\D/g, "");
    const unitId = body.unit_id!;
    const organizationId = body.organization_id!;
    const source = body.source ?? "web";
    const status = "confirmed";
    const notify = body.notify === true;
    const override = body.override === true;

    // Validar que unit existe e pertence à org (defesa contra payload adulterado).
    const { data: unitRow } = await supabase
      .from("units")
      .select("id, organization_id")
      .eq("id", unitId)
      .maybeSingle();

    if (!unitRow || unitRow.organization_id !== organizationId) {
      jsonLog("warn", { requestId, evt: "manual_reservation_unit_mismatch", unitId });
      return json({ success: false, reason: "unit_invalid", message: "Unidade inválida." }, 400);
    }

    // Autorização: membro da unit OU platform_admin. useCurrentUnit.ts fabrica
    // pseudo-membership "owner" pra super-admin; sem o paralelo, write é bloqueada.
    if (!(await hasUnitAccess(supabase, user.id, unitId))) {
      jsonLog("warn", { requestId, evt: "manual_reservation_forbidden", unitId, userId: user.id });
      return json({ success: false, reason: "forbidden", message: "Sem permissão nesta unidade." }, 403);
    }

    // Billing: bloquear se org blocked/suspended (mesmo guard da create-reservation).
    const { data: orgBilling } = await supabase
      .from("organizations")
      .select("billing_status")
      .eq("id", organizationId)
      .single();

    if (orgBilling && (orgBilling.billing_status === "blocked" || orgBilling.billing_status === "suspended")) {
      jsonLog("warn", { requestId, evt: "manual_reservation_org_blocked", organizationId, status: orgBilling.billing_status });
      return json({ success: false, reason: "org_blocked", message: "Este restaurante não está aceitando novas reservas no momento." }, 403);
    }

    // Resolve customer (dedupe por (org, phone), preserva nome, append emails[]).
    let customer;
    try {
      customer = await resolveOrCreateCustomer(supabase, {
        organizationId,
        phone,
        name: body.customer!.name!.trim(),
        email: body.customer!.email ?? null,
        birthday: body.customer!.birthday ?? null,
      });
    } catch (err) {
      jsonLog("error", { requestId, evt: "manual_reservation_customer_failed", err: String(err) });
      return json({ success: false, reason: "customer_failed", message: "Falha ao registrar cliente." }, 500);
    }

    // reserveSlot valida disponibilidade + insere com table_id atribuído.
    // override=true cria flutuante (sem mesa) se a validação recusar.
    const result = await reserveSlot(supabase, {
      unitId,
      hallId: body.hall_id ?? undefined,
      date: body.date!,
      time: body.time!,
      partySize: body.party_size!,
      customerId: customer.id,
      notes: body.notes ?? null,
      status,
      source,
      override,
    });

    if (!result.success) {
      jsonLog("info", {
        requestId,
        evt: "manual_reservation_rejected",
        unitId,
        phone: sanitizePhone(phone),
        reason: result.reason,
      });
      return json({ success: false, reason: result.reason, message: result.message }, 200);
    }

    if (result.reservationStatus !== "confirmed") {
      jsonLog("error", { requestId, evt: "manual_reservation_state_mismatch", unitId,
        reservationId: result.reservationId, status: result.reservationStatus });
      return json({ success: false, reason: "state_unverified",
        message: "A reserva foi criada, mas o estado não pôde ser confirmado. Atualize a lista antes de tentar novamente." }, 409);
    }

    // Reconciliação da notificação — DESACOPLA do `source`.
    // O trigger (mig 028) enfileira confirmação só quando source <> 'whatsapp'.
    //   notify=true  → garante 1 linha no outbox (cobre source='whatsapp', onde o trigger NÃO enfileirou).
    //   notify=false → remove a linha pendente (cobre source='web', onde o trigger JÁ enfileirou).
    if (notify) {
      const { error: outboxErr } = await supabase
        .from("notification_outbox")
        .insert({ reservation_id: result.reservationId, unit_id: unitId, kind: "confirmation" });
      // 23505 = já existe (trigger já enfileirou) → ok, dedupe silencioso.
      if (outboxErr && (outboxErr as { code?: string }).code !== "23505") {
        jsonLog("error", { requestId, evt: "manual_reservation_outbox_insert_failed", err: outboxErr.message });
      }
    } else {
      const { error: delErr } = await supabase
        .from("notification_outbox")
        .delete()
        .eq("reservation_id", result.reservationId)
        .eq("kind", "confirmation")
        .eq("status", "pending");
      if (delErr) {
        jsonLog("error", { requestId, evt: "manual_reservation_outbox_delete_failed", err: delErr.message });
      }
    }

    jsonLog("info", {
      requestId,
      evt: "manual_reservation_created",
      unitId,
      userId: user.id,
      phone: sanitizePhone(phone),
      source,
      status,
      notify,
      override,
      floating: result.tableId === undefined,
    });

    return json({
      success: true,
      reservation_id: result.reservationId,
      reservation_code: result.reservationCode,
      table_id: result.tableId ?? null,
      reservation_status: result.reservationStatus,
      customer: {
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
        email: customer.email,
      },
      message: "Reserva criada.",
    }, 200);
  } catch (err) {
    jsonLog("error", { requestId, evt: "manual_reservation_error", err: String(err) });
    return json({ success: false, reason: "internal_error", message: "Erro interno." }, 500);
  }
});
