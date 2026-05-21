// Edge Function de edição de reserva pelo painel admin.
//
// Diferente de `useReservaStatus` (que só muda status), aqui o gerente pode
// mover date/time/party_size/table_id/hall_id/notes. SEMPRE revalida via
// `checkAvailability` para evitar deixar reservas em horários sem capacidade
// ou em mesas bloqueadas.
//
// Body:
//   {
//     reservation_id: string,
//     updates: { date?, time?, party_size?, table_id?, hall_id?, notes? },
//     override?: boolean  // se true, pula a checagem (escape hatch)
//   }
//
// Auth: JWT do member. Valida via `is_unit_member` na unit da reserva.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { checkAvailability } from "../_shared/availability.ts";
import { jsonLog } from "../_shared/security.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

interface UpdatePayload {
  reservation_id?: string;
  override?: boolean;
  updates?: {
    date?: string;
    time?: string;
    party_size?: number;
    table_id?: string | null;
    hall_id?: string | null;
    notes?: string | null;
  };
}

function validate(p: UpdatePayload): string | null {
  if (!p.reservation_id || typeof p.reservation_id !== "string") {
    return "reservation_id obrigatório.";
  }
  if (!p.updates || typeof p.updates !== "object") {
    return "updates obrigatório.";
  }
  const u = p.updates;
  if (u.date != null && !/^\d{4}-\d{2}-\d{2}$/.test(u.date)) {
    return "date inválida (YYYY-MM-DD).";
  }
  if (u.time != null && !/^\d{2}:\d{2}(:\d{2})?$/.test(u.time)) {
    return "time inválido (HH:MM).";
  }
  if (u.party_size != null && (typeof u.party_size !== "number" || u.party_size < 1 || u.party_size > 30)) {
    return "party_size inválido.";
  }
  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Método não permitido." }, 405);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  try {
    const payload = (await req.json()) as UpdatePayload;
    const err = validate(payload);
    if (err) return jsonResponse({ error: err }, 400);

    const { reservation_id, updates, override } = payload;

    // Carrega reserva e valida que o usuário é member da unit dela.
    const { data: reserva, error: rErr } = await supabase
      .from("reservations")
      .select("id, unit_id, date, time, party_size, status, table_id")
      .eq("id", reservation_id!)
      .maybeSingle();

    if (rErr || !reserva) {
      return jsonResponse({ error: "reserva não encontrada" }, 404);
    }

    // platform_admin opera unidades alheias via pseudo-membership fabricada em
    // useCurrentUnit.ts — backend tem que aceitar o paralelo, senão super-admin
    // recebe 403 mesmo com a UI mostrando "Proprietário".
    const [memberResult, adminResult] = await Promise.all([
      supabase.rpc("is_unit_member", { p_user_id: user.id, p_unit_id: reserva.unit_id }),
      supabase.rpc("is_platform_admin", { p_user_id: user.id }),
    ]);
    if (!memberResult.data && !adminResult.data) {
      return jsonResponse({ error: "forbidden" }, 403);
    }

    // Status terminal não pode ser editado pra evitar corromper relatórios.
    if (reserva.status === "cancelled" || reserva.status === "no_show") {
      return jsonResponse(
        { error: `reserva em status '${reserva.status}' não pode ser editada` },
        409,
      );
    }

    // Revalidação de disponibilidade quando date/time/party_size/hall mudam.
    // Skip quando override=true.
    const wantsAvailabilityCheck =
      !override &&
      (updates!.date != null ||
        updates!.time != null ||
        updates!.party_size != null ||
        updates!.hall_id != null);

    if (wantsAvailabilityCheck) {
      const nextDate = updates!.date ?? reserva.date;
      const nextTime = updates!.time ?? reserva.time;
      const nextParty = updates!.party_size ?? reserva.party_size;
      const nextHall = updates!.hall_id ?? undefined;

      const result = await checkAvailability(supabase, {
        unitId: reserva.unit_id,
        hallId: nextHall ?? undefined,
        date: nextDate,
        time: nextTime,
        partySize: nextParty,
      });

      if (!result.available) {
        jsonLog("info", {
          evt: "update_reservation_rejected",
          reservation_id,
          reason: result.reason,
        });
        return jsonResponse(
          {
            error: result.message,
            reason: result.reason ?? "no_capacity",
          },
          409,
        );
      }
    }

    // Aplica o UPDATE com apenas as colunas presentes em updates.
    const patch: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (updates!.date != null) patch.date = updates!.date;
    if (updates!.time != null) patch.time = updates!.time;
    if (updates!.party_size != null) patch.party_size = updates!.party_size;
    if (updates!.table_id !== undefined) patch.table_id = updates!.table_id;
    if (updates!.notes !== undefined) patch.notes = updates!.notes;

    const { data: updated, error: upErr } = await supabase
      .from("reservations")
      .update(patch)
      .eq("id", reservation_id!)
      .select("*, customer:customers(*), table:tables(*)")
      .single();

    if (upErr) {
      jsonLog("error", { evt: "update_reservation_failed", err: upErr.message });
      return jsonResponse({ error: upErr.message }, 500);
    }

    jsonLog("info", {
      evt: "update_reservation_success",
      reservation_id,
      override: !!override,
    });

    return jsonResponse({ success: true, reserva: updated });
  } catch (err) {
    jsonLog("error", { evt: "update_reservation_error", err: String(err) });
    return jsonResponse({ error: "internal_error" }, 500);
  }
});
