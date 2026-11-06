import { afterEach, describe, expect, it, vi } from "vitest";
import { createReservation } from "../../supabase/functions/_shared/agent/tools";

// F-002B no agente: o mesmo pedido (cliente, data, hora, pessoas, 15 min)
// devolve a reserva que já existe e não chega ao INSERT. Com identidade
// declarada (Instagram), só o ledger do contato.

type Call = [string, ...unknown[]];

function fakeDb(rows: unknown[]) {
  const calls: Call[] = [];
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "gte", "order", "insert"]) {
    builder[method] = (...args: unknown[]) => { calls.push([method, ...args]); return builder; };
  }
  builder.limit = (...args: unknown[]) => { calls.push(["limit", ...args]); return Promise.resolve({ data: rows, error: null }); };
  return { db: { from: (table: string) => { calls.push(["from", table]); return builder; } }, calls };
}

const recent = (over: Record<string, unknown> = {}) => ({
  id: "res-1", reservation_code: "ABCD2345", status: "confirmed", payment_status: "not_required",
  table_id: "t1", time: "20:00:00", party_size: 2, created_at: new Date(Date.now() - 60_000).toISOString(),
  occupant_tables: [], ...over,
});

const base = {
  date: "2030-03-15", time: "20:00", party_size: 2, customer_name: "Ana",
  customer: { id: "cust-1", phone: "11988887777" }, unit_id: "unit-a", organization_id: "org-a",
} as const;

afterEach(() => vi.restoreAllMocks());

describe("create_reservation: reenvio do mesmo pedido", () => {
  it("WhatsApp: devolve a reserva existente sem criar cliente nem reserva", async () => {
    const { db, calls } = fakeDb([recent()]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await createReservation(db as any, { ...base, claimedIdentity: false, source: "whatsapp", table_choice: "6" });
    expect(out).toMatchObject({ success: true, already_existed: true, reservation_code: "ABCD2345", reservationId: "res-1" });
    expect(out.message).toContain("já estava criada");
    expect(calls.filter(c => c[0] === "from")).toEqual([["from", "reservations"]]);
    expect(calls).toContainEqual(["eq", "unit_id", "unit-a"]);
    expect(calls).toContainEqual(["eq", "customer_id", "cust-1"]);
    expect(calls.some(c => c[0] === "insert")).toBe(false);
  });

  it("reserva existente não confirmada: não afirma confirmação nem cria outra", async () => {
    const { db } = fakeDb([recent({ status: "pending" })]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await createReservation(db as any, { ...base, claimedIdentity: false, source: "whatsapp" });
    expect(out).toMatchObject({ success: false, reason: "reservation_already_exists" });
  });

  it("Instagram: restringe a busca ao ledger do contato", async () => {
    const insertReservation = vi.fn();
    const { db, calls } = fakeDb([recent()]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await createReservation(db as any, {
      ...base, claimedIdentity: true, source: "instagram", insertReservation, replayReservationIds: ["res-1"],
    });
    expect(out).toMatchObject({ success: true, already_existed: true });
    expect(calls).toContainEqual(["in", "id", ["res-1"]]);
    expect(insertReservation).not.toHaveBeenCalled();
  });

  it("Instagram com ledger ilegível ou vazio: não procura reserva", async () => {
    for (const replayReservationIds of [null, []]) {
      const { db, calls } = fakeDb([recent()]);
      // Sem hook de INSERT o núcleo falha fechado logo depois: basta provar que a busca não rodou.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await createReservation(db as any, { ...base, claimedIdentity: true, source: "instagram", replayReservationIds });
      expect(calls.some(c => c[0] === "from" && c[1] === "reservations")).toBe(false);
    }
  });
});
