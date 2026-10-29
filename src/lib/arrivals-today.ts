import type { ReservaStatus } from "@/types/reserva";

export interface ArrivalInput {
  id: string;
  time: string | null;
  status: ReservaStatus;
  party_size: number;
}

export interface ArrivalHour {
  hour: number;
  label: string;
  reservations: number;
  guests: number;
  isPeak: boolean;
}

const countsAsArrival = (status: ReservaStatus): boolean =>
  status === "pending" || status === "confirmed";

export function buildArrivalsByHour(
  reservas: ArrivalInput[],
  range: { min: number; max: number },
): ArrivalHour[] {
  const counts = new Map<number, { reservations: number; guests: number }>();
  let minHour = range.min;
  let maxHour = range.max;

  for (const reserva of reservas) {
    if (!countsAsArrival(reserva.status) || reserva.time === null) continue;
    const hour = Number(reserva.time.slice(0, 2));
    minHour = Math.min(minHour, hour);
    maxHour = Math.max(maxHour, hour);
    const current = counts.get(hour) ?? { reservations: 0, guests: 0 };
    current.reservations += 1;
    current.guests += reserva.party_size;
    counts.set(hour, current);
  }

  const peak = Math.max(0, ...Array.from(counts.values(), (count) => count.reservations));
  const hours: ArrivalHour[] = [];
  for (let hour = minHour; hour <= maxHour; hour += 1) {
    const count = counts.get(hour) ?? { reservations: 0, guests: 0 };
    hours.push({
      hour,
      label: `${hour}h`,
      ...count,
      isPeak: count.reservations === peak && peak > 0,
    });
  }
  return hours;
}

export function arrivalsSentence(hours: ArrivalHour[]): string | null {
  const max = Math.max(0, ...hours.map(({ reservations }) => reservations));
  if (max === 0) return null;
  const peaks = hours.filter(({ reservations }) => reservations === max);
  const labels = peaks.map(({ label }) => label);
  const joined = labels.length === 1
    ? labels[0]
    : `${labels.slice(0, -1).join(", ")} e ${labels[labels.length - 1]}`;

  if (peaks.length === 1) {
    const noun = max === 1 ? "reserva" : "reservas";
    return `Pico às ${joined}, com ${max} ${noun}`;
  }
  return `Pico às ${joined}, com ${max} reservas cada`;
}

export function upcomingArrivals<T extends ArrivalInput>(
  reservas: T[],
  nowHHMM: string,
  limit = 5,
): T[] {
  return reservas
    .filter((reserva) =>
      countsAsArrival(reserva.status) &&
      reserva.time !== null &&
      reserva.time.slice(0, 5) >= nowHHMM,
    )
    .sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""))
    .slice(0, limit);
}
