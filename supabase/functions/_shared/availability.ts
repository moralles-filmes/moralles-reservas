// Lógica única de disponibilidade + criação de reserva.
// Consumido pelo bot WhatsApp (webhook-whatsapp) e pela Edge Function pública
// create-reservation (chamada pelo portal e painel).
//
// Modelo: a partir da migration 030, cada unidade tem 1+ "salões" (halls);
// cada salão tem `hall_schedules` (múltiplas janelas por dia da semana, com
// escala/antecedência/desconto/cobrança) + `tables` vinculadas via hall_id.
// `business_hours` ainda existe como fallback transicional pra units que
// ainda não foram migradas.

// deno-lint-ignore-file no-explicit-any

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export type AvailabilityReason =
  | "closed_day"
  | "outside_hours"
  | "outside_window"
  | "below_min_advance"
  | "no_capacity"
  | "all_blocked"
  | "ambiguous_hall";

export interface AvailabilityParams {
  unitId: string;
  /** Opcional: se ausente e a unit tem 2+ halls ativos com encaixe, retorna ambiguous_hall. */
  hallId?: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:MM (ou HH:MM:SS — só HH:MM importa)
  partySize: number;
}

export interface AvailabilityResult {
  available: boolean;
  suggestedTableId?: string;
  suggestedHallId?: string;
  reason?: AvailabilityReason;
  message: string;
  durationMinutes: number;
}

interface HallRow {
  id: string;
  name: string;
  allow_empty_seat: boolean;
}

interface HallScheduleRow {
  id: string;
  hall_id: string;
  open_time: string;
  close_time: string;
  slot_minutes: number;
  min_advance_minutes: number;
}

interface TableRow {
  id: string;
  hall_id: string | null;
  min_capacity: number;
  max_capacity: number;
}

const DEFAULT_DURATION_MINUTES = 90;

function parseTimeToMinutes(t: string): number {
  const [h, m] = t.split(":").map((n) => parseInt(n, 10));
  return h * 60 + m;
}

function dayOfWeek(dateStr: string): number {
  return new Date(`${dateStr}T12:00:00Z`).getUTCDay();
}

function minutesUntil(dateStr: string, time: string): number {
  const target = new Date(`${dateStr}T${time}:00`).getTime();
  return Math.round((target - Date.now()) / 60_000);
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

async function loadOverbookingFlag(
  supabase: SupabaseClient,
  unitId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("settings")
    .select("value")
    .eq("unit_id", unitId)
    .eq("key", "allow_overbooking")
    .maybeSingle();
  const raw = data?.value;
  return raw === true || raw === "true" || raw === 1;
}

async function loadBookingWindowDays(
  supabase: SupabaseClient,
  unitId: string,
): Promise<number | null> {
  const { data } = await supabase
    .from("settings")
    .select("value")
    .eq("unit_id", unitId)
    .eq("key", "booking_window_days")
    .maybeSingle();
  const raw = data?.value;
  if (typeof raw === "number" && raw > 0) return Math.floor(raw);
  if (typeof raw === "string") {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/** Bloqueio macro ativo no intervalo `[startISO, endISO]` que afeta o hall.
 *  Retorna o título do bloqueio (pra mensagem) ou null se não há macro ativo. */
async function findActiveMacroBlock(
  supabase: SupabaseClient,
  unitId: string,
  hallId: string | null,
  startISO: string,
  endISO: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("table_blocks")
    .select("title, reason, hall_id")
    .eq("unit_id", unitId)
    .is("table_id", null)
    .lt("blocked_from", endISO)
    .gt("blocked_to", startISO);

  for (const row of data ?? []) {
    // Macro global (hall_id null) bloqueia todos os halls.
    // Macro de hall específico só bloqueia se hallId === row.hall_id.
    if (row.hall_id === null || row.hall_id === hallId) {
      return row.title ?? row.reason ?? "Bloqueio";
    }
  }
  return null;
}

/** Override de uma special_date que se aplica à reserva. */
type SpecialOverride =
  | {
      closed: true;
      maxPartySize: number | null;
      hallId: string | null;
    }
  | {
      closed: false;
      openMin: number;
      closeMin: number;
      maxPartySize: number | null;
      hallId: string | null;
      slotMinutes: number | null;
      minAdvanceMinutes: number | null;
    };

/** Carrega special_dates ativas pra `date` na unit. Pode haver várias
 *  (ex: 1 por hall + 1 global). Caller decide qual aplica. */
async function loadSpecialDateOverrides(
  supabase: SupabaseClient,
  unitId: string,
  date: string,
): Promise<SpecialOverride[]> {
  const { data } = await supabase
    .from("special_dates")
    .select(
      "hall_id, is_closed, open_time, close_time, max_party_size, slot_minutes, min_advance_minutes",
    )
    .eq("unit_id", unitId)
    .lte("date", date)
    .gte("end_date", date);

  const out: SpecialOverride[] = [];
  for (const row of data ?? []) {
    if (row.is_closed) {
      out.push({
        closed: true,
        maxPartySize: row.max_party_size,
        hallId: row.hall_id,
      });
    } else if (row.open_time && row.close_time) {
      out.push({
        closed: false,
        openMin: parseTimeToMinutes(row.open_time),
        closeMin: parseTimeToMinutes(row.close_time),
        maxPartySize: row.max_party_size,
        hallId: row.hall_id,
        slotMinutes: row.slot_minutes,
        minAdvanceMinutes: row.min_advance_minutes,
      });
    }
  }
  return out;
}

/** Match override pra um hall específico: prioriza override do próprio hall,
 *  fallback pra override global (hall_id NULL). */
function pickOverrideForHall(overrides: SpecialOverride[], hallId: string | null): SpecialOverride | null {
  if (hallId) {
    const specific = overrides.find((o) => o.hallId === hallId);
    if (specific) return specific;
  }
  return overrides.find((o) => o.hallId === null) ?? null;
}

export async function checkAvailability(
  supabase: SupabaseClient,
  params: AvailabilityParams,
): Promise<AvailabilityResult> {
  const { unitId, hallId, date, partySize } = params;
  const time = params.time.slice(0, 5);
  const requestedMin = parseTimeToMinutes(time);
  const [duration, allowOverbooking, bookingWindowDays] = await Promise.all([
    loadDurationMinutes(supabase, unitId),
    loadOverbookingFlag(supabase, unitId),
    loadBookingWindowDays(supabase, unitId),
  ]);

  // ── 0. Janela de reserva (booking_window_days) ──────────────────────────────
  if (bookingWindowDays != null) {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const target = new Date(`${date}T00:00:00Z`);
    const diffDays = Math.floor((target.getTime() - today.getTime()) / 86_400_000);
    if (diffDays > bookingWindowDays) {
      return {
        available: false,
        reason: "outside_window",
        message: `Esta data está além da janela de reserva configurada (${bookingWindowDays} dias).`,
        durationMinutes: duration,
      };
    }
  }

  // ── 1. special_dates: pode haver várias (por hall + global). ────────────────
  const overrides = await loadSpecialDateOverrides(supabase, unitId, date);

  // Override global fechado (hall_id NULL) trava a unit toda
  const globalClosed = overrides.find((o) => o.closed && o.hallId === null);
  if (globalClosed) {
    return {
      available: false,
      reason: "closed_day",
      message: "Estamos fechados nesta data.",
      durationMinutes: duration,
    };
  }

  // ── 2. Halls candidatos ─────────────────────────────────────────────────────
  let hallsQuery = supabase
    .from("halls")
    .select("id, name, allow_empty_seat")
    .eq("unit_id", unitId)
    .eq("active", true)
    .order("sort_order", { ascending: true });
  if (hallId) hallsQuery = hallsQuery.eq("id", hallId);

  const { data: hallsData } = await hallsQuery;
  const halls: HallRow[] = (hallsData ?? []) as HallRow[];

  // Caminho legacy: nenhum hall configurado — cai pra business_hours
  if (halls.length === 0) {
    const fallbackOverride = overrides.find((o) => o.hallId === null) ?? null;
    return checkAvailabilityLegacy(supabase, params, duration, fallbackOverride);
  }

  // ── 3. Iterar halls e tentar encaixar ───────────────────────────────────────
  const dow = dayOfWeek(date);
  let lastReason: AvailabilityReason = "closed_day";
  let lastMessage = "Não há disponibilidade neste horário.";

  for (const hall of halls) {
    const override = pickOverrideForHall(overrides, hall.id);

    // Override fechado pra este hall específico → pula
    if (override?.closed) {
      lastReason = "closed_day";
      lastMessage = `${hall.name}: fechado nesta data.`;
      continue;
    }

    // Override aberto: tem maxPartySize? valida.
    if (override && !override.closed && override.maxPartySize != null && partySize > override.maxPartySize) {
      lastReason = "no_capacity";
      lastMessage = `${hall.name}: nesta data o máximo é ${override.maxPartySize} pessoa(s).`;
      continue;
    }

    const result = await tryHall({
      supabase,
      hall,
      unitId,
      date,
      dow,
      time,
      requestedMin,
      partySize,
      duration,
      allowOverbooking,
      specialOverride:
        override && !override.closed
          ? {
              openMin: override.openMin,
              closeMin: override.closeMin,
              slotMinutes: override.slotMinutes,
              minAdvanceMinutes: override.minAdvanceMinutes,
            }
          : null,
    });

    if (result.available) return result;
    lastReason = result.reason ?? lastReason;
    lastMessage = result.message;
  }

  return {
    available: false,
    reason: lastReason,
    message: lastMessage,
    durationMinutes: duration,
  };
}

async function tryHall(args: {
  supabase: SupabaseClient;
  hall: HallRow;
  unitId: string;
  date: string;
  dow: number;
  time: string;
  requestedMin: number;
  partySize: number;
  duration: number;
  allowOverbooking: boolean;
  specialOverride: {
    openMin: number;
    closeMin: number;
    slotMinutes?: number | null;
    minAdvanceMinutes?: number | null;
  } | null;
}): Promise<AvailabilityResult> {
  const { supabase, hall, unitId, date, dow, time, requestedMin, partySize, duration, allowOverbooking, specialOverride } = args;

  // 3.1 — Determinar janela: special_date override > hall_schedule
  let openMin: number;
  let closeMin: number;
  let minAdvance = 0;

  if (specialOverride) {
    openMin = specialOverride.openMin;
    closeMin = specialOverride.closeMin;
    if (specialOverride.minAdvanceMinutes != null) {
      minAdvance = specialOverride.minAdvanceMinutes;
    }
  } else {
    const { data: schedules } = await supabase
      .from("hall_schedules")
      .select("id, hall_id, open_time, close_time, slot_minutes, min_advance_minutes")
      .eq("hall_id", hall.id)
      .eq("day_of_week", dow);

    const sched: HallScheduleRow[] = (schedules ?? []) as HallScheduleRow[];
    if (sched.length === 0) {
      return {
        available: false,
        reason: "closed_day",
        message: `${hall.name}: fechado neste dia da semana.`,
        durationMinutes: duration,
      };
    }

    // Encontrar a janela que contém o horário pedido
    const matched = sched.find((s) => {
      const o = parseTimeToMinutes(s.open_time);
      const c = parseTimeToMinutes(s.close_time);
      return requestedMin >= o && requestedMin <= c - 30;
    });

    if (!matched) {
      return {
        available: false,
        reason: "outside_hours",
        message: `${hall.name}: este horário está fora das janelas configuradas.`,
        durationMinutes: duration,
      };
    }

    openMin = parseTimeToMinutes(matched.open_time);
    closeMin = parseTimeToMinutes(matched.close_time);
    minAdvance = matched.min_advance_minutes;
  }

  // Última reserva tem que terminar 30min antes do close
  const latestStart = closeMin - 30;
  if (requestedMin < openMin || requestedMin > latestStart) {
    return {
      available: false,
      reason: "outside_hours",
      message: `${hall.name}: este horário está fora do atendimento.`,
      durationMinutes: duration,
    };
  }

  // 3.2 — Antecedência mínima
  if (minAdvance > 0) {
    const remaining = minutesUntil(date, time);
    if (remaining < minAdvance) {
      return {
        available: false,
        reason: "below_min_advance",
        message: `${hall.name}: precisa reservar com no mínimo ${minAdvance} min de antecedência.`,
        durationMinutes: duration,
      };
    }
  }

  // 3.3 — Mesas do hall com capacidade compatível
  const minRequired = hall.allow_empty_seat ? Math.max(1, partySize) : partySize;
  // allow_empty_seat: aceita mesa cuja min_capacity seja partySize+1 (sobra 1 cadeira)
  // Lógica de filtro:
  //   sem flag: min_capacity <= partySize <= max_capacity
  //   com flag: (min_capacity - 1) <= partySize <= max_capacity   (admite 1 cadeira vazia)
  const { data: tablesRaw } = await supabase
    .from("tables")
    .select("id, hall_id, min_capacity, max_capacity")
    .eq("hall_id", hall.id)
    .eq("active", true)
    .gte("max_capacity", partySize)
    .order("max_capacity", { ascending: true });

  const tables: TableRow[] = (tablesRaw ?? []).filter((t: TableRow) => {
    const lower = hall.allow_empty_seat ? t.min_capacity - 1 : t.min_capacity;
    return partySize >= Math.max(1, lower) && partySize <= t.max_capacity;
  });

  if (tables.length === 0) {
    return {
      available: false,
      reason: "no_capacity",
      message: `${hall.name}: sem mesa compatível para ${partySize} pessoa(s).`,
      durationMinutes: duration,
    };
  }
  void minRequired; // reservado para uso futuro

  // 3.4 — Bloqueios
  const startISO = new Date(`${date}T${time}:00`).toISOString();
  const endISO = new Date(
    new Date(`${date}T${time}:00`).getTime() + duration * 60 * 1000,
  ).toISOString();

  // 3.4a — Bloqueio macro (sem table_id) afetando este hall: trava tudo.
  const macroTitle = await findActiveMacroBlock(supabase, unitId, hall.id, startISO, endISO);
  if (macroTitle) {
    return {
      available: false,
      reason: "closed_day",
      message: `${hall.name}: bloqueado neste horário (${macroTitle}).`,
      durationMinutes: duration,
    };
  }

  // 3.4b — Bloqueios de mesa específica
  const tableIds = tables.map((t) => t.id);
  const { data: blocksRaw } = await supabase
    .from("table_blocks")
    .select("table_id")
    .in("table_id", tableIds)
    .lt("blocked_from", endISO)
    .gt("blocked_to", startISO);

  const blockedTableIds = new Set((blocksRaw ?? []).map((b: any) => b.table_id));
  const usableTables = tables.filter((t) => !blockedTableIds.has(t.id));

  if (usableTables.length === 0) {
    return {
      available: false,
      reason: "all_blocked",
      message: `${hall.name}: todas as mesas estão bloqueadas neste horário.`,
      durationMinutes: duration,
    };
  }

  // 3.5 — Reservas conflitantes (com table_id no hall + floating na unit)
  const { data: pinnedRaw } = await supabase
    .from("reservations")
    .select("id, time, party_size, table_id")
    .eq("unit_id", unitId)
    .eq("date", date)
    .in("status", ["pending", "confirmed"])
    .in("table_id", tableIds);

  const conflicting = (pinnedRaw ?? []).filter((r: any) => {
    const otherMin = parseTimeToMinutes(r.time);
    return Math.abs(otherMin - requestedMin) < duration;
  });

  const { data: floatingRaw } = await supabase
    .from("reservations")
    .select("id, time, party_size")
    .eq("unit_id", unitId)
    .eq("date", date)
    .is("table_id", null)
    .in("status", ["pending", "confirmed"]);

  const floatingConflict = (floatingRaw ?? []).filter((r: any) => {
    const otherMin = parseTimeToMinutes(r.time);
    return Math.abs(otherMin - requestedMin) < duration;
  });

  // 3.6 — Alocação first-fit
  const occupied = new Set<string>();
  for (const r of conflicting) if (r.table_id) occupied.add(r.table_id);

  const sortedFloating = [...floatingConflict].sort(
    (a: any, b: any) => b.party_size - a.party_size,
  );
  for (const r of sortedFloating) {
    const fit = usableTables.find(
      (t) => !occupied.has(t.id) && t.max_capacity >= r.party_size,
    );
    if (fit) occupied.add(fit.id);
  }

  const suggested = usableTables.find(
    (t) => !occupied.has(t.id) && t.max_capacity >= partySize,
  );

  if (!suggested) {
    if (allowOverbooking) {
      // Overbooking: cria reserva floating (sem table_id) — operador aloca depois.
      return {
        available: true,
        suggestedTableId: undefined,
        suggestedHallId: hall.id,
        message: `${hall.name}: sem mesa disponível, mas overbooking está habilitado — reserva criada como flutuante.`,
        durationMinutes: duration,
      };
    }
    return {
      available: false,
      reason: "no_capacity",
      message: `${hall.name}: não há mesa disponível para esse horário.`,
      durationMinutes: duration,
    };
  }

  return {
    available: true,
    suggestedTableId: suggested.id,
    suggestedHallId: hall.id,
    message: `Há mesa disponível em ${hall.name} para ${partySize} pessoa(s) em ${date} às ${time}.`,
    durationMinutes: duration,
  };
}

/** Caminho legado (units sem halls). Mantém comportamento pré-migration 030. */
async function checkAvailabilityLegacy(
  supabase: SupabaseClient,
  params: AvailabilityParams,
  duration: number,
  special: SpecialOverride | null,
): Promise<AvailabilityResult> {
  const { unitId, date, partySize } = params;
  const time = params.time.slice(0, 5);
  const requestedMin = parseTimeToMinutes(time);

  if (special?.closed) {
    return {
      available: false,
      reason: "closed_day",
      message: "Estamos fechados nesta data.",
      durationMinutes: duration,
    };
  }
  if (special && !special.closed && special.maxPartySize != null && partySize > special.maxPartySize) {
    return {
      available: false,
      reason: "no_capacity",
      message: `Nesta data o tamanho máximo de grupo é ${special.maxPartySize}.`,
      durationMinutes: duration,
    };
  }

  let openMin: number | null = null;
  let closeMin: number | null = null;

  if (special && special.closed === false) {
    openMin = special.openMin;
    closeMin = special.closeMin;
  } else {
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

  const latestStart = closeMin - 30;
  if (requestedMin < openMin || requestedMin > latestStart) {
    return {
      available: false,
      reason: "outside_hours",
      message: "Este horário está fora do nosso atendimento.",
      durationMinutes: duration,
    };
  }

  const { data: tablesRaw } = await supabase
    .from("tables")
    .select("id, max_capacity")
    .eq("unit_id", unitId)
    .eq("active", true)
    .gte("max_capacity", partySize)
    .order("max_capacity", { ascending: true });

  const tables: Array<{ id: string; max_capacity: number }> = tablesRaw ?? [];
  if (tables.length === 0) {
    return {
      available: false,
      reason: "no_capacity",
      message: `Não temos mesa para ${partySize} pessoa(s).`,
      durationMinutes: duration,
    };
  }

  const startISO = new Date(`${date}T${time}:00`).toISOString();
  const endISO = new Date(
    new Date(`${date}T${time}:00`).getTime() + duration * 60 * 1000,
  ).toISOString();
  const tableIds = tables.map((t) => t.id);

  const { data: blocksRaw } = await supabase
    .from("table_blocks")
    .select("table_id")
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

  const occupied = new Set<string>();
  for (const r of conflicting) if (r.table_id) occupied.add(r.table_id);

  const floating = conflicting
    .filter((r: any) => !r.table_id)
    .sort((a: any, b: any) => b.party_size - a.party_size);
  for (const r of floating) {
    const fit = usableTables.find(
      (t) => !occupied.has(t.id) && t.max_capacity >= r.party_size,
    );
    if (fit) occupied.add(fit.id);
  }

  const suggested = usableTables.find(
    (t) => !occupied.has(t.id) && t.max_capacity >= partySize,
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
      /** Pode ser undefined em casos de overbooking (reserva floating). */
      tableId: string | undefined;
      hallId?: string;
      durationMinutes: number;
    }
  | {
      success: false;
      reason: AvailabilityReason | "insert_failed";
      message: string;
    };

function generateReservationCode(): string {
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
  if (!check.available) {
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
      table_id: check.suggestedTableId ?? null,
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
    hallId: check.suggestedHallId,
    durationMinutes: check.durationMinutes,
  };
}
