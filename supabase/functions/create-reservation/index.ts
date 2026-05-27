// Edge Function pública para criar reserva via portal/painel.
// Centraliza a mesma lógica usada pelo bot WhatsApp (_shared/availability.ts):
// valida horário, conflitos, mesas bloqueadas e atribui table_id automaticamente.
//
// Sem JWT: portal `/r/<slug>` é anônimo. Rate limit por phone (mesma RPC do bot).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { genRequestId, jsonLog, sanitizePhone } from "../_shared/security.ts";
import { reserveSlot } from "../_shared/availability.ts";
import { resolveOrCreateCustomer } from "../_shared/resolve-customer.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_MAX = 5;

interface CreateReservationBody {
  unit_id?: string;
  organization_id?: string;
  hall_id?: string | null;
  widget_id?: string | null;
  custom_field_values?: Record<string, string> | null;
  customer?: {
    name?: string;
    phone?: string;
    email?: string | null;
    birthday?: string | null;
  };
  date?: string;
  time?: string;
  party_size?: number;
  notes?: string | null;
}

function validateBody(b: CreateReservationBody): string | null {
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
  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ success: false, message: "Método não permitido." }, 405);
  }

  const requestId = genRequestId();

  try {
    const body = (await req.json()) as CreateReservationBody;
    const validationError = validateBody(body);
    if (validationError) {
      return jsonResponse({ success: false, reason: "invalid_input", message: validationError }, 400);
    }

    const phone = (body.customer!.phone ?? "").replace(/\D/g, "");
    const unitId = body.unit_id!;
    const organizationId = body.organization_id!;

    // Validar que unit_id existe e pertence à organization_id (defesa contra
    // payload adulterado pelo cliente).
    const { data: unitRow } = await supabase
      .from("units")
      .select("id, organization_id, is_public")
      .eq("id", unitId)
      .maybeSingle();

    if (!unitRow || unitRow.organization_id !== organizationId) {
      jsonLog("warn", { requestId, evt: "create_reservation_unit_mismatch", unitId });
      return jsonResponse({ success: false, reason: "unit_invalid", message: "Unidade inválida." }, 400);
    }

    // Rate limit por (phone, unit) — mesma RPC já usada no webhook
    const { data: allowed } = await supabase.rpc("check_rate_limit", {
      p_phone: phone,
      p_window_seconds: RATE_LIMIT_WINDOW_SECONDS,
      p_max: RATE_LIMIT_MAX,
      p_unit_id: unitId,
    });

    if (allowed === false) {
      jsonLog("warn", { requestId, evt: "create_reservation_rate_limited", unitId, phone: sanitizePhone(phone) });
      return jsonResponse(
        { success: false, reason: "rate_limited", message: "Muitas tentativas. Aguarde um instante e tente novamente." },
        429,
      );
    }

    // Resolve customer com merge preservando dados:
    //   - lookup por (organization_id, phone)
    //   - se existe: PRESERVA nome cadastrado, append em emails[], birthday só se null
    //   - se não existe: cria
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
      jsonLog("error", { requestId, evt: "create_reservation_customer_failed", err: String(err) });
      return jsonResponse({ success: false, reason: "customer_failed", message: "Falha ao registrar cliente." }, 500);
    }

    // reserveSlot valida disponibilidade + insere com table_id atribuído
    const result = await reserveSlot(supabase, {
      unitId,
      hallId: body.hall_id ?? undefined,
      date: body.date!,
      time: body.time!,
      partySize: body.party_size!,
      customerId: customer.id,
      notes: body.notes ?? null,
      status: "pending",
    });

    // Persiste extras (custom_field_values) na reserva criada
    if (result.success && body.custom_field_values && Object.keys(body.custom_field_values).length) {
      await supabase
        .from("reservations")
        .update({ custom_field_values: body.custom_field_values })
        .eq("id", result.reservationId);
    }

    // Detectar caução: buscar schedule do hall/data/hora selecionados
    let requiresPayment = false;
    let paymentAmountCents: number | null = null;

    if (result.success && body.hall_id) {
      const dateObj = new Date(`${body.date}T12:00:00`);
      const dow = dateObj.getDay();

      // Checar special_date override primeiro
      const { data: specialRow } = await supabase
        .from("special_dates")
        .select("charge_enabled, charge_amount_cents")
        .eq("unit_id", unitId)
        .lte("date", body.date!)
        .gte("end_date", body.date!)
        .eq("is_closed", false)
        .eq("charge_enabled", true)
        .or(`hall_id.is.null,hall_id.eq.${body.hall_id}`)
        .limit(1)
        .maybeSingle();

      if (specialRow?.charge_enabled && specialRow.charge_amount_cents > 0) {
        paymentAmountCents = specialRow.charge_amount_cents;
      } else {
        // Checar hall_schedule
        const { data: schedRow } = await supabase
          .from("hall_schedules")
          .select("charge_enabled, charge_amount_cents, open_time, close_time")
          .eq("hall_id", body.hall_id)
          .eq("day_of_week", dow)
          .eq("charge_enabled", true)
          .lte("open_time", body.time!)
          .gt("close_time", body.time!)
          .limit(1)
          .maybeSingle();

        if (schedRow?.charge_enabled && schedRow.charge_amount_cents > 0) {
          paymentAmountCents = schedRow.charge_amount_cents;
        }
      }

      if (paymentAmountCents && paymentAmountCents > 0) {
        requiresPayment = true;
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        await supabase
          .from("reservations")
          .update({
            payment_status: "pending_payment",
            payment_amount_cents: paymentAmountCents,
            payment_expires_at: expiresAt,
          })
          .eq("id", result.reservationId);
      }
    }

    jsonLog("info", {
      requestId,
      evt: "create_reservation_attempt",
      unitId,
      phone: sanitizePhone(phone),
      success: result.success,
      reason: result.success ? undefined : result.reason,
      requires_payment: requiresPayment,
    });

    if (!result.success) {
      return jsonResponse({
        success: false,
        reason: result.reason,
        message: result.message,
      }, 200);
    }

    return jsonResponse({
      success: true,
      reservation_id: result.reservationId,
      reservation_code: result.reservationCode,
      table_id: result.tableId,
      requires_payment: requiresPayment,
      payment_amount_cents: paymentAmountCents,
      customer: {
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
        email: customer.email,
      },
      message: requiresPayment ? "Reserva criada. Pagamento pendente." : "Reserva criada.",
    }, 200);
  } catch (err) {
    jsonLog("error", { requestId, evt: "create_reservation_error", err: String(err) });
    return jsonResponse({ success: false, reason: "internal_error", message: "Erro interno." }, 500);
  }
});
