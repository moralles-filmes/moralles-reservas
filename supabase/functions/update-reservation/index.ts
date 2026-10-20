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
// Auth: JWT do member. Valida membro da unit da reserva OU platform_admin via
// hasUnitAccess (_shared/authz.ts, consulta direta — os helpers saíram de `public`).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { checkAvailability } from "../_shared/availability.ts";
import { jsonLog } from "../_shared/security.ts";
import { hasUnitAccess } from "../_shared/authz.ts";

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
  if (u.table_id != null && typeof u.table_id !== "string") return "table_id inválido.";
  if (u.hall_id != null && typeof u.hall_id !== "string") return "hall_id inválido.";
  if (u.notes != null && typeof u.notes !== "string") return "notes inválido.";
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

    if (rErr) {
      jsonLog("error", { evt: "update_reservation_read_failed", code: rErr.code });
      return jsonResponse({ error: "internal_error" }, 500);
    }

    // platform_admin opera unidades alheias via pseudo-membership fabricada em
    // useCurrentUnit.ts — backend tem que aceitar o paralelo, senão super-admin
    // recebe 403 mesmo com a UI mostrando "Proprietário".
    // Reserva inexistente e reserva de outra unidade têm a MESMA resposta: um
    // 403 próprio confirmaria que o UUID existe em outro tenant.
    if (!reserva || !(await hasUnitAccess(supabase, user.id, reserva.unit_id))) {
      return jsonResponse({ error: "reserva não encontrada" }, 404);
    }

    // Status terminal não pode ser editado pra evitar corromper relatórios.
    if (reserva.status === "cancelled" || reserva.status === "no_show") {
      return jsonResponse(
        { error: `reserva em status '${reserva.status}' não pode ser editada` },
        409,
      );
    }

    // Mesa e salão do body só valem se forem da unidade DA RESERVA: o service
    // role ignora RLS e `reservations.table_id` é FK simples. Sem isto, um
    // membro da unidade A aponta a reserva para uma mesa da B, lê a linha dela
    // no retorno e ocupa o slot dela no índice único (table_id, date, time).
    if (updates!.table_id != null) {
      const { data: ownTable, error: otErr } = await supabase
        .from("tables")
        .select("id")
        .eq("id", updates!.table_id)
        .eq("unit_id", reserva.unit_id)
        .maybeSingle();
      if (otErr) {
        jsonLog("error", { evt: "update_reservation_table_check_failed", code: otErr.code });
        return jsonResponse({ error: "internal_error" }, 500);
      }
      if (!ownTable) return jsonResponse({ error: "Mesa inválida." }, 400);
    }
    if (updates!.hall_id != null) {
      const { data: ownHall, error: ohErr } = await supabase
        .from("halls")
        .select("id")
        .eq("id", updates!.hall_id)
        .eq("unit_id", reserva.unit_id)
        .maybeSingle();
      if (ohErr) {
        jsonLog("error", { evt: "update_reservation_hall_check_failed", code: ohErr.code });
        return jsonResponse({ error: "internal_error" }, 500);
      }
      if (!ownHall) return jsonResponse({ error: "Salão inválido." }, 400);
    }

    // Revalidação de disponibilidade quando date/time/party_size/hall mudam.
    // Skip quando override=true.
    const wantsAvailabilityCheck =
      !override &&
      (updates!.date != null ||
        updates!.time != null ||
        updates!.party_size != null ||
        updates!.hall_id != null);

    // Mesa decidida pela checagem quando o gerente não escolheu uma.
    let checkedTableId: string | null | undefined;

    if (wantsAvailabilityCheck) {
      const nextDate = updates!.date ?? reserva.date;
      const nextTime = updates!.time ?? reserva.time;
      const nextParty = updates!.party_size ?? reserva.party_size;
      // Sem salão pedido, mantém o salão da mesa atual (senão o first-fit
      // poderia mudar a reserva de ambiente em silêncio).
      let nextHall = updates!.hall_id ?? undefined;
      if (!nextHall && reserva.table_id) {
        const { data: currentTable, error: tErr } = await supabase
          .from("tables")
          .select("hall_id")
          .eq("id", reserva.table_id)
          .maybeSingle();
        if (tErr) {
          jsonLog("error", { evt: "update_reservation_table_lookup_failed", code: tErr.code });
          return jsonResponse({ error: "internal_error" }, 500);
        }
        nextHall = currentTable?.hall_id ?? undefined;
      }

      const result = await checkAvailability(supabase, {
        unitId: reserva.unit_id,
        hallId: nextHall,
        date: nextDate,
        time: nextTime,
        partySize: nextParty,
        // A própria reserva não ocupa mesa contra si mesma; a mesa atual é
        // mantida se continuar livre no novo horário.
        excludeReservationId: reserva.id,
        preferTableId: reserva.table_id,
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
      // Overbooking sem mesa sugerida = reserva flutuante (null).
      checkedTableId = result.suggestedTableId ?? null;
    }

    // Aplica o UPDATE com apenas as colunas presentes em updates.
    const patch: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (updates!.date != null) patch.date = updates!.date;
    if (updates!.time != null) patch.time = updates!.time;
    if (updates!.party_size != null) patch.party_size = updates!.party_size;
    if (updates!.table_id !== undefined) patch.table_id = updates!.table_id;
    else if (checkedTableId !== undefined) patch.table_id = checkedTableId;
    if (updates!.notes !== undefined) patch.notes = updates!.notes;

    const { data: updated, error: upErr } = await supabase
      .from("reservations")
      .update(patch)
      .eq("id", reservation_id!)
      // Mesmo escopo da leitura: a unidade conferida e um status editável. Um
      // cancelamento concorrente entre a leitura e o UPDATE casa zero linhas.
      .eq("unit_id", reserva.unit_id)
      .in("status", ["pending", "confirmed"])
      .select("*, customer:customers(*), table:tables(*)")
      .maybeSingle();

    if (upErr) {
      jsonLog("error", { evt: "update_reservation_failed", code: upErr.code, err: upErr.message });
      // UNIQUE (table_id, date, time) ativo: outra reserva pegou a mesa entre a checagem e o UPDATE.
      if (upErr.code === "23505") {
        return jsonResponse({ error: "Esse horário acabou de ser ocupado nesta mesa. Escolha outro horário ou mesa.", reason: "no_capacity" }, 409);
      }
      return jsonResponse({ error: "Não foi possível salvar a reserva. Tente novamente." }, 500);
    }
    if (!updated) {
      return jsonResponse({ error: "A reserva mudou de status e não pode mais ser editada." }, 409);
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
