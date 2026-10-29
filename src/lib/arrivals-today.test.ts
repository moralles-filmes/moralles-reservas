import { describe, expect, it } from "vitest";
import {
  arrivalsSentence,
  buildArrivalsByHour,
  upcomingArrivals,
  type ArrivalInput,
} from "./arrivals-today";

const reserva = (
  id: string,
  time: string | null,
  status: ArrivalInput["status"],
  party_size = 1,
): ArrivalInput => ({ id, time, status, party_size });

describe("chegadas de hoje", () => {
  it("conta só pendente e confirmada", () => {
    const hours = buildArrivalsByHour([
      reserva("1", "20:00", "confirmed", 4),
      reserva("2", "20:15", "pending", 2),
      reserva("3", "20:30", "cancelled", 6),
      reserva("4", "20:45", "no_show", 3),
    ], { min: 18, max: 22 });

    expect(hours.find(({ hour }) => hour === 20)).toMatchObject({ reservations: 2, guests: 6 });
  });

  it("estende a faixa para reserva fora do horário", () => {
    const hours = buildArrivalsByHour([reserva("1", "23:30:00", "confirmed")], { min: 18, max: 22 });
    expect(hours.find(({ hour }) => hour === 23)).toMatchObject({ hour: 23, label: "23h", reservations: 1 });
    expect(hours.map(({ hour }) => hour)).toEqual([18, 19, 20, 21, 22, 23]);
  });

  it("dia vazio não tem pico nem frase", () => {
    for (const entradas of [[], [reserva("1", "20:00", "cancelled")]]) {
      const hours = buildArrivalsByHour(entradas, { min: 18, max: 22 });
      expect(hours.every(({ isPeak }) => !isPeak)).toBe(true);
      expect(arrivalsSentence(hours)).toBeNull();
    }
  });

  it("frase com um pico", () => {
    const hours = buildArrivalsByHour([
      ...Array.from({ length: 14 }, (_, i) => reserva(String(i), "20:00", "confirmed")),
      reserva("menor", "19:00", "pending"),
    ], { min: 18, max: 22 });
    expect(arrivalsSentence(hours)).toBe("Pico às 20h, com 14 reservas");

    const uma = buildArrivalsByHour([reserva("1", "20:00", "confirmed")], { min: 18, max: 22 });
    expect(arrivalsSentence(uma)).toBe("Pico às 20h, com 1 reserva");
  });

  it("frase com empate", () => {
    const duas = buildArrivalsByHour([
      ...Array.from({ length: 6 }, (_, i) => reserva(`19-${i}`, "19:00", "confirmed")),
      ...Array.from({ length: 6 }, (_, i) => reserva(`20-${i}`, "20:00", "confirmed")),
    ], { min: 18, max: 22 });
    expect(arrivalsSentence(duas)).toBe("Pico às 19h e 20h, com 6 reservas cada");

    const tres = buildArrivalsByHour([
      ...[18, 19, 20].flatMap((hour) =>
        Array.from({ length: 6 }, (_, i) => reserva(`${hour}-${i}`, `${hour}:00`, "confirmed")),
      ),
    ], { min: 18, max: 22 });
    expect(arrivalsSentence(tres)).toBe("Pico às 18h, 19h e 20h, com 6 reservas cada");
  });

  it("próximas chegadas", () => {
    const entradas = [
      reserva("antes", "19:30", "confirmed"),
      reserva("dentro", "19:45", "pending"),
      reserva("cancelada", "20:00", "cancelled"),
      ...Array.from({ length: 7 }, (_, i) => reserva(`válida-${i}`, `20:${String(i).padStart(2, "0")}`, "confirmed")),
    ];
    const chegadas = upcomingArrivals(entradas, "19:40", 5);
    expect(chegadas).toHaveLength(5);
    expect(chegadas.map(({ id }) => id)).toEqual(["dentro", "válida-0", "válida-1", "válida-2", "válida-3"]);
  });
});
