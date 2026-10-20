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
import { recordPublicReservationConsent } from "./public-marketing-consent.ts";
import { initialNoDepositReservationState, type InitialReservationState } from "./initial-reservation-state.ts";

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
  marketing_opt_in?: unknown;
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
    const { data: unitRow, error: unitError } = await supabase
      .from("units")
      .select("id, organization_id, is_public")
      .eq("id", unitId)
      .maybeSingle();

    if (unitError) {
      jsonLog("error", { requestId, evt: "create_reservation_unit_lookup_failed", unitId });
      return jsonResponse({ success: false, reason: "dependency_unavailable", message: "Não foi possível conferir a unidade agora." }, 503);
    }
    if (!unitRow || unitRow.organization_id !== organizationId || unitRow.is_public !== true) {
      jsonLog("warn", { requestId, evt: "create_reservation_unit_mismatch", unitId });
      return jsonResponse({ success: false, reason: "unit_invalid", message: "Unidade inválida." }, 400);
    }

    // Billing check — bloquear novas reservas se org estiver blocked/suspended
    const { data: orgBilling, error: orgError } = await supabase
      .from("organizations")
      .select("is_public, billing_status")
      .eq("id", organizationId)
      .maybeSingle();

    if (orgError) {
      jsonLog("error", { requestId, evt: "create_reservation_org_lookup_failed", unitId });
      return jsonResponse({ success: false, reason: "dependency_unavailable", message: "Não foi possível conferir o restaurante agora." }, 503);
    }
    if (!orgBilling || orgBilling.is_public !== true) {
      jsonLog("warn", { requestId, evt: "create_reservation_unit_mismatch", unitId });
      return jsonResponse({ success: false, reason: "unit_invalid", message: "Unidade inválida." }, 400);
    }

    if (orgBilling && (orgBilling.billing_status === "blocked" || orgBilling.billing_status === "suspended")) {
      jsonLog("warn", { requestId, evt: "create_reservation_org_blocked", organizationId, status: orgBilling.billing_status });
      return jsonResponse({ success: false, reason: "org_blocked", message: "Este restaurante não está aceitando novas reservas no momento." }, 403);
    }

    // Rate limit por (phone, unit) — mesma RPC já usada no webhook
    const { data: allowed, error: rateError } = await supabase.rpc("check_rate_limit", {
      p_phone: phone,
      p_window_seconds: RATE_LIMIT_WINDOW_SECONDS,
      p_max: RATE_LIMIT_MAX,
      p_unit_id: unitId,
    });

    if (rateError || (allowed !== true && allowed !== false)) {
      jsonLog("error", { requestId, evt: "create_reservation_rate_limit_failed", unitId });
      return jsonResponse({ success: false, reason: "dependency_unavailable", message: "Não foi possível conferir o limite de tentativas agora." }, 503);
    }
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

    // Só reservas sem caução entram neste rollout. Conferimos a configuração
    // para o hall selecionado antes do INSERT; o trigger observa confirmed.
    let initialState: InitialReservationState | null = null;
    let result: Awaited<ReturnType<typeof reserveSlot>>;
    try {
      result = await reserveSlot(supabase, {
        unitId,
        hallId: body.hall_id ?? undefined,
        date: body.date!,
        time: body.time!,
        partySize: body.party_size!,
        customerId: customer.id,
        notes: body.notes ?? null,
        initialStateForSlot: async hallId => {
          const state = await initialNoDepositReservationState({ unitId, date: body.date!, time: body.time!, hallId }, {
            special: async (targetUnitId, date, selectedHallId) => {
              let query = supabase.from("special_dates").select("charge_enabled, charge_amount_cents")
                .eq("unit_id", targetUnitId).lte("date", date).gte("end_date", date)
                .eq("is_closed", false).eq("charge_enabled", true);
              query = selectedHallId
                ? query.or(`hall_id.is.null,hall_id.eq.${selectedHallId}`)
                : query.is("hall_id", null);
              const { data, error } = await query.limit(1).maybeSingle();
              if (error) throw new Error("charge_lookup_failed");
              return data;
            },
            schedule: async (selectedHallId, weekday, time) => {
              const { data, error } = await supabase.from("hall_schedules")
                .select("charge_enabled, charge_amount_cents")
                .eq("hall_id", selectedHallId).eq("day_of_week", weekday)
                .eq("charge_enabled", true).lte("open_time", time).gt("close_time", time)
                .limit(1).maybeSingle();
              if (error) throw new Error("charge_lookup_failed");
              return data;
            },
          });
          initialState = state;
          return state;
        },
      });
    } catch (err) {
      if (err instanceof Error && err.message === "prepaid_reservation_not_supported") {
        return jsonResponse({ success: false, reason: "deposit_unavailable",
          message: "Reservas com caução não estão disponíveis agora. Fale com o restaurante." }, 409);
      }
      throw err;
    }

    if (result.success && (initialState === null || result.reservationStatus !== "confirmed"
      || result.paymentStatus !== "not_required")) {
      jsonLog("error", { requestId, evt: "create_reservation_state_mismatch", unitId,
        reservationId: result.reservationId, status: result.reservationStatus,
        paymentStatus: result.paymentStatus });
      return jsonResponse({ success: false, reason: "state_unverified",
        message: "A reserva foi criada, mas o estado não pôde ser confirmado. Consulte o restaurante antes de tentar novamente." }, 409);
    }

    // Consentimento é independente da reserva: falha da RPC não desfaz o insert.
    await recordPublicReservationConsent(
      body.marketing_opt_in,
      result,
      unitId,
      customer.id,
      (name, args, signal) => supabase.rpc(name, args).abortSignal(signal),
      (reason) => jsonLog("error", {
        requestId,
        evt: "public_reservation_promotional_opt_in_failed",
        unitId,
        reservationId: result.success === true ? result.reservationId : null,
        reason,
      }),
    );

    // Persiste extras (custom_field_values) na reserva criada
    if (result.success && body.custom_field_values && Object.keys(body.custom_field_values).length) {
      await supabase
        .from("reservations")
        .update({ custom_field_values: body.custom_field_values })
        .eq("id", result.reservationId);
    }

    jsonLog("info", {
      requestId,
      evt: "create_reservation_attempt",
      unitId,
      phone: sanitizePhone(phone),
      success: result.success,
      reason: result.success ? undefined : result.reason,
      requires_payment: false,
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
      reservation_status: result.reservationStatus,
      requires_payment: false,
      payment_amount_cents: null,
      customer: {
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
        email: customer.email,
      },
      message: "Reserva confirmada.",
    }, 200);
  } catch (err) {
    jsonLog("error", { requestId, evt: "create_reservation_error", err: String(err) });
    return jsonResponse({ success: false, reason: "internal_error", message: "Erro interno." }, 500);
  }
});
