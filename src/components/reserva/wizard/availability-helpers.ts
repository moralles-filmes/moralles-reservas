/**
 * Helpers puros pra calcular slots e filtrar halls compatíveis com data/hora/pessoas.
 *
 * IMPORTANTE: esta é uma checagem CLIENT-SIDE pra renderização do wizard.
 * A fonte de verdade final é `supabase/functions/_shared/availability.ts`,
 * rodada na Edge Function `create-reservation`. Aqui podem aparecer halls
 * que "parecem compatíveis" mas falham no submit por bloqueios/conflitos.
 */

import type { PublicHall, PublicHallSchedule } from "@/types/reserva";

export interface TimeSlot {
  time: string;
  discountPercent: number | null;
}

export const FALLBACK_TIME_SLOTS: TimeSlot[] = [
  "12:00", "12:30", "13:00", "13:30", "14:00",
  "19:00", "19:30", "20:00", "20:30", "21:00", "21:30", "22:00",
].map((time) => ({ time, discountPercent: null }));

export function generateTimeSlots(
  openTime: string,
  closeTime: string,
  intervalMins: number,
  discountPercent: number | null,
): TimeSlot[] {
  const slots: TimeSlot[] = [];
  const [openH, openM] = openTime.split(":").map(Number);
  const [closeH, closeM] = closeTime.split(":").map(Number);
  let current = openH * 60 + openM;
  const end = closeH * 60 + closeM;
  // close_time = última reserva aceita (inclusive). Sem buffer fixo.
  while (current <= end) {
    const h = Math.floor(current / 60);
    const m = current % 60;
    slots.push({
      time: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`,
      discountPercent,
    });
    current += intervalMins;
  }
  return slots;
}

export function parseTimeToMinutes(t: string): number {
  const [h, m] = t.split(":").map((n) => parseInt(n, 10));
  return h * 60 + m;
}

export function dayOfWeekOf(dateISO: string): number {
  // Meio-dia local pra evitar drift de fuso quando a data vira string
  return new Date(`${dateISO}T12:00:00`).getDay();
}

/** Gera todos os slots disponíveis (UNION entre halls) pra uma data. */
export function getSlotsForDate(halls: PublicHall[], dateISO: string): TimeSlot[] {
  if (!dateISO) return FALLBACK_TIME_SLOTS;
  const dow = dayOfWeekOf(dateISO);
  const byTime = new Map<string, number | null>();
  for (const hall of halls) {
    const windows = hall.schedules.filter((s) => s.day_of_week === dow);
    for (const w of windows) {
      const discount = w.discount_percent && w.discount_percent > 0 ? w.discount_percent : null;
      for (const s of generateTimeSlots(w.open_time, w.close_time, w.slot_minutes, discount)) {
        const existing = byTime.get(s.time);
        if (existing == null || (s.discountPercent ?? 0) > (existing ?? 0)) {
          byTime.set(s.time, s.discountPercent);
        }
      }
    }
  }
  return Array.from(byTime.entries())
    .map(([time, discountPercent]) => ({ time, discountPercent }))
    .sort((a, b) => a.time.localeCompare(b.time));
}

/** Encontra a janela do hall no DOW que cobre o horário pedido (HH:MM). */
export function findScheduleCoveringTime(
  hall: PublicHall,
  dateISO: string,
  timeHHMM: string,
): PublicHallSchedule | null {
  const dow = dayOfWeekOf(dateISO);
  const t = parseTimeToMinutes(timeHHMM);
  for (const s of hall.schedules) {
    if (s.day_of_week !== dow) continue;
    const o = parseTimeToMinutes(s.open_time);
    const c = parseTimeToMinutes(s.close_time);
    if (t >= o && t <= c) return s;
  }
  return null;
}

/** Hall comporta o party_size considerando allow_empty_seat. */
export function hallFitsPartySize(hall: PublicHall, partySize: number): boolean {
  const min = hall.min_capacity;
  const max = hall.max_capacity;
  // Sem capacidade informada (migration não aplicada ou hall sem mesas) → assume sim.
  if (min == null || max == null) return true;
  const lower = hall.allow_empty_seat ? Math.max(1, min - 1) : min;
  return partySize >= lower && partySize <= max;
}

/** Hall tem PELO MENOS UMA janela aberta no dia da semana. */
export function hallOpensOnDate(hall: PublicHall, dateISO: string): boolean {
  const dow = dayOfWeekOf(dateISO);
  return hall.schedules.some((s) => s.day_of_week === dow);
}

export interface PartitionedHalls {
  /** Hall abre no horário pedido E comporta o party_size. */
  compatible: PublicHall[];
  /** Hall abre no DOW (em outros horários) mas falha no slot/party_size pedidos. */
  alternative: PublicHall[];
  /** Hall não abre no DOW. */
  closed: PublicHall[];
}

/** Particiona halls em 3 buckets pra renderização no step 2. */
export function partitionHalls(
  halls: PublicHall[],
  dateISO: string,
  timeHHMM: string,
  partySize: number,
): PartitionedHalls {
  const out: PartitionedHalls = { compatible: [], alternative: [], closed: [] };
  for (const hall of halls) {
    if (!hallOpensOnDate(hall, dateISO)) {
      out.closed.push(hall);
      continue;
    }
    const covers = findScheduleCoveringTime(hall, dateISO, timeHHMM);
    const fits = hallFitsPartySize(hall, partySize);
    if (covers && fits) {
      out.compatible.push(hall);
    } else {
      out.alternative.push(hall);
    }
  }
  return out;
}
