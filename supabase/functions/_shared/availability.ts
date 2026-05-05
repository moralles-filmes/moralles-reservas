// Lógica única de disponibilidade + criação de reserva.
// Consumido pelo bot WhatsApp (webhook-whatsapp) e pela Edge Function pública
// create-reservation (chamada pelo portal e painel).
//
// Por que aqui em vez de cada caller fazer o seu: garantir que a regra
// "esta reserva é viável?" tenha um único ponto de verdade. Mudanças
// futuras (mesa preferida, regras de feriado, etc.) só precisam tocar
// este arquivo.

// deno-lint-ignore-file no-explicit-any

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export type AvailabilityReason =
  | "closed_day"
  | "outside_hours"
  | "no_capacity"
  | "all_blocked";

export interface AvailabilityParams {
  unitId: string;
  date: string;   // YYYY-MM-DD
  time: string;   // HH:MM (ou HH:MM:SS — só o HH:MM importa)
  partySize: number;
}

export interface AvailabilityResult {
  available: boolean;
  suggestedTableId?: string;
  reason?: AvailabilityReason;
  message: string;
  durationMinutes: number;
}

const DEFAULT_DURATION_MINUTES = 90;

// HH:MM[:SS] → minutos desde meia-noite
function parseTimeToMinutes(t: string): number {
  const [h, m] = t.split(":").map((n) => parseInt(n, 10));
  return h * 60 + m;
}

// Dia da semana 0=domingo … 6=sábado, em UTC neutro (evita DST)
function dayOfWeek(dateStr: string): number {
  return new Date(`${dateStr}T12:00:00Z`).getUTCDay();
}

async function loadDurationMinutes(
  supabase: SupabaseClient,
  unitId: string,
): Promise<number> {
  const { data } = await supabase
    .from("settings")
    .select("value")
    .eq("unit_id", unitId)
    .eq("key", "reservation_duration_minutes")
    .maybeSingle();

  const raw = data?.value;
  // value é JSONB: pode chegar como número, string, ou { minutes: 90 } — aceita os 3
  if (typeof raw === "number" && raw > 0) return Math.floor(raw);
  if (typeof raw === "string") {
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  if (raw && typeof raw === "object" && "minutes" in raw) {
    const v = (raw as any).minutes;
    if (typeof v === "number" && v > 0) return Math.floor(v);
  }
  return DEFAULT_DURATION_MINUTES;
}

export async function checkAvailability(
  supabase: SupabaseClient,
  params: AvailabilityParams,
): Promise<AvailabilityResult> {
  const { unitId, date, partySize } = params;
  const time = params.time.slice(0, 5); // HH:MM
  const requestedMin = parseTimeToMinutes(time);
  const duration = await loadDurationMinutes(supabase, unitId);

  // ── 1. special_dates ───────────────────────────────────────────────────────
  const { data: specialRow } = await supabase
    .from("special_dates")
    .select("is_closed, open_time, close_time, max_party_size")
    .eq("unit_id", unitId)
    .eq("date", date)
    .maybeSingle();

  if (specialRow?.is_closed) {
    return {
      available: false,
      reason: "closed_day",
      message: "Estamos fechados nesta data.",
      durationMinutes: duration,
    };
  }

  if (specialRow?.max_party_size != null && partySize > specialRow.max_party_size) {
    return {
      available: false,
      reason: "no_capacity",
      message: `Nesta data o tamanho máximo de grupo é ${specialRow.max_party_size}.`,
      durationMinutes: duration,
    };
  }

  // Override de horário: se há special_date com open/close, usa eles; senão business_hours
  let openMin: number | null = null;
  let closeMin: number | null = null;

  if (specialRow?.open_time && specialRow?.close_time) {
    openMin = parseTimeToMinutes(specialRow.open_time);
    closeMin = parseTimeToMinutes(specialRow.close_time);
  } else {
    // ── 2. business_hours ────────────────────────────────────────────────────
    const dow = dayOfWeek(date);
    const { data: hour } = await supabase
      .from("business_hours")
      .select("open_time, close_time, is_closed")
      .eq("unit_id", unitId)
      .eq("day_of_week", dow)
      .maybeSingle();

    if (!hour || hour.is_closed) {
      return {
        available: false,
        reason: "closed_day",
        message: "Estamos fechados neste dia da semana.",
        durationMinutes: duration,
      };
    }
    openMin = parseTimeToMinutes(hour.open_time);
    closeMin = parseTimeToMinutes(hour.close_time);
  }

  // Última reserva tem que terminar antes do fechamento — exigimos pelo menos
  // 30min entre a chegada e o close para não receber cliente já no fim.
  const latestStart = closeMin - 30;
  if (requestedMin < openMin || requestedMin > latestStart) {
    return {
      available: false,
      reason: "outside_hours",
      message: "Este horário está fora do nosso atendimento.",
      durationMinutes: duration,
    };
  }

  // ── 3. Mesas ativas com capacidade suficiente ───────────────────────────────
  const { data: tablesRaw } = await supabase
    .from("tables")
    .select("id, capacity")
    .eq("unit_id", unitId)
    .eq("active", true)
    .gte("capacity", partySize)
    .order("capacity", { ascending: true });

  const tables: Array<{ id: string; capacity: number }> = tablesRaw ?? [];
  if (tables.length === 0) {
    return {
      available: false,
      reason: "no_capacity",
      message: `Não temos mesa para ${partySize} pessoa(s).`,
      durationMinutes: duration,
    };
  }

  // ── 4. Excluir mesas bloqueadas (table_blocks) que cobrem a janela ─────────
  const startISO = new Date(`${date}T${time}:00`).toISOString();
  const endISO = new Date(
    new Date(`${date}T${time}:00`).getTime() + duration * 60 * 1000,
  ).toISOString();

  const tableIds = tables.map((t) => t.id);
  const { data: blocksRaw } = await supabase
    .from("table_blocks")
    .select("table_id, blocked_from, blocked_to")
    .in("table_id", tableIds)
    .lt("blocked_from", endISO)
    .gt("blocked_to", startISO);

  const blockedTableIds = new Set((blocksRaw ?? []).map((b: any) => b.table_id));
  const usableTables = tables.filter((t) => !blockedTableIds.has(t.id));

  if (usableTables.length === 0) {
    return {
      available: false,
      reason: "all_blocked",
      message: "Todas as mesas estão bloqueadas neste horário.",
      durationMinutes: duration,
    };
  }

  // ── 5. Reservas conflitantes (mesma data, janela de tempo) ──────────────────
  const { data: existingRaw } = await supabase
    .from("reservations")
    .select("id, time, party_size, table_id")
    .eq("unit_id", unitId)
    .eq("date", date)
    .in("status", ["pending", "confirmed"]);

  const conflicting = (existingRaw ?? []).filter((r: any) => {
    const otherMin = parseTimeToMinutes(r.time);
    return Math.abs(otherMin - requestedMin) < duration;
  });

  // ── 6. Alocação first-fit ──────────────────────────────────────────────────
  // Ordem: respeita reservas que já têm table_id atribuído antes (operador
  // alocou manualmente, intencional). Depois aloca as sem table_id, das maiores
  // pras menores, na menor mesa que sirva.
  const occupied = new Set<string>();

  // 6a. Reservas com mesa atribuída — fixam aquela mesa
  for (const r of conflicting) {
    if (r.table_id) occupied.add(r.table_id);
  }

  // 6b. Reservas sem table_id — aloca first-fit, maiores primeiro
  const floating = conflicting
    .filter((r: any) => !r.table_id)
    .sort((a: any, b: any) => b.party_size - a.party_size);

  for (const r of floating) {
    const fit = usableTables.find(
      (t) => !occupied.has(t.id) && t.capacity >= r.party_size,
    );
    if (fit) occupied.add(fit.id);
    // Se não couber, ignora — o sistema já está overbooked nesse caso, mas
    // a contabilidade pra a nova reserva continua justa: contou a mesa
    // como ocupada implicitamente.
  }

  // ── 7. Mesa para a nova reserva ────────────────────────────────────────────
  const suggested = usableTables.find(
    (t) => !occupied.has(t.id) && t.capacity >= partySize,
  );

  if (!suggested) {
    return {
      available: false,
      reason: "no_capacity",
      message: "Não há mesa disponível para esse horário.",
      durationMinutes: duration,
    };
  }

  return {
    available: true,
    suggestedTableId: suggested.id,
    message: `Há mesa disponível para ${partySize} pessoa(s) em ${date} às ${time}.`,
    durationMinutes: duration,
  };
}

// ─── Reservar slot (valida + insere atomicamente do ponto de vista do caller) ─

export interface ReserveSlotParams extends AvailabilityParams {
  customerId: string;
  notes?: string | null;
  status?: "pending" | "confirmed";
}

export type ReserveSlotResult =
  | {
      success: true;
      reservationId: string;
      reservationCode: string;
      tableId: string;
      durationMinutes: number;
    }
  | {
      success: false;
      reason: AvailabilityReason | "insert_failed";
      message: string;
    };

function generateReservationCode(): string {
  // 8 chars: alfanumérico, evita 0/O/1/I para reduzir confusão verbal
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

export async function reserveSlot(
  supabase: SupabaseClient,
  params: ReserveSlotParams,
): Promise<ReserveSlotResult> {
  const check = await checkAvailability(supabase, params);
  if (!check.available || !check.suggestedTableId) {
    return {
      success: false,
      reason: check.reason ?? "no_capacity",
      message: check.message,
    };
  }

  const code = generateReservationCode();
  const status = params.status ?? "confirmed";

  const { data, error } = await supabase
    .from("reservations")
    .insert({
      customer_id: params.customerId,
      unit_id: params.unitId,
      table_id: check.suggestedTableId,
      date: params.date,
      time: params.time,
      party_size: params.partySize,
      notes: params.notes ?? null,
      reservation_code: code,
      status,
    })
    .select("id")
    .single();

  if (error || !data) {
    return {
      success: false,
      reason: "insert_failed",
      message: error?.message ?? "Falha ao criar reserva.",
    };
  }

  return {
    success: true,
    reservationId: data.id,
    reservationCode: code,
    tableId: check.suggestedTableId,
    durationMinutes: check.durationMinutes,
  };
}
