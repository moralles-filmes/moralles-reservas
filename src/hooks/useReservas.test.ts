import { describe, it, expect } from "vitest";
import { mapRpcRowToReserva } from "./useReservas";

describe("mapRpcRowToReserva", () => {
  it("returns null for null/undefined input", () => {
    expect(mapRpcRowToReserva(null)).toBeNull();
    expect(mapRpcRowToReserva(undefined)).toBeNull();
  });

  it("flattens RPC row into Reserva shape with nested customer", () => {
    const row = {
      id: "11111111-1111-1111-1111-111111111111",
      reservation_code: "AB1C2D",
      date: "2026-05-01",
      time: "20:00",
      party_size: 4,
      status: "confirmed" as const,
      notes: "aniversário",
      created_at: "2026-04-27T10:00:00Z",
      updated_at: "2026-04-27T10:00:00Z",
      customer_name: "João da Silva",
      customer_phone: "11999887766",
      customer_email: "joao@example.com",
    };

    const reserva = mapRpcRowToReserva(row);
    expect(reserva).not.toBeNull();
    expect(reserva!.id).toBe(row.id);
    expect(reserva!.reservation_code).toBe("AB1C2D");
    expect(reserva!.party_size).toBe(4);
    expect(reserva!.status).toBe("confirmed");
    expect(reserva!.customer).toEqual({
      id: "",
      name: "João da Silva",
      phone: "11999887766",
      email: "joao@example.com",
      created_at: "2026-04-27T10:00:00Z",
    });
    // RPC não retorna customer_id/table_id; defaults sentinelas mantêm o tipo Reserva.
    expect(reserva!.customer_id).toBe("");
    expect(reserva!.table_id).toBeNull();
  });

  it("preserves null email when customer has no email", () => {
    const reserva = mapRpcRowToReserva({
      id: "id",
      reservation_code: "CODE12",
      date: "2026-05-01",
      time: "20:00",
      party_size: 2,
      status: "pending",
      notes: null,
      created_at: "2026-04-27T10:00:00Z",
      updated_at: "2026-04-27T10:00:00Z",
      customer_name: "Maria",
      customer_phone: "11999887766",
      customer_email: null,
    });
    expect(reserva!.customer!.email).toBeNull();
  });
});
