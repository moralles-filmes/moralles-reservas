import { describe, expect, it } from "vitest";
import {
  cancelReservationScoped,
  getReservationScoped,
  updateReservationScoped,
} from "../../supabase/functions/_shared/agent-reservation-tools";

type Call = [string, ...unknown[]];

function fakeDb(result: { data: unknown; error: { code?: string; message?: string } | null }) {
  const calls: Call[] = [];
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "update", "eq", "in", "order", "limit"]) {
    builder[method] = (...args: unknown[]) => {
      calls.push([method, ...args]);
      return builder;
    };
  }
  builder.maybeSingle = () => {
    calls.push(["maybeSingle"]);
    return Promise.resolve(result);
  };
  const db = {
    from: (table: string) => {
      calls.push(["from", table]);
      return builder;
    },
  };
  return { db, calls };
}

const scope = { unitId: "unit-a", customerId: "cust-1" };

function expectScoped(calls: Call[]) {
  expect(calls).toContainEqual(["eq", "unit_id", "unit-a"]);
  expect(calls).toContainEqual(["eq", "customer_id", "cust-1"]);
  expect(calls).toContainEqual(["in", "status", ["confirmed", "pending"]]);
}

const ROW = {
  reservation_code: "ABCD2345",
  date: "2026-10-24",
  time: "20:00:00",
  party_size: 4,
  status: "confirmed",
  notes: null,
};

describe("getReservationScoped", () => {
  it("busca por código dentro da unidade e do cliente do turno", async () => {
    const { db, calls } = fakeDb({ data: ROW, error: null });
    const res = await getReservationScoped(db, { reservation_code: " abcd2345 " }, scope);
    expectScoped(calls);
    expect(calls).toContainEqual(["eq", "reservation_code", "ABCD2345"]);
    expect(res).toMatchObject({ found: true, reservation_code: "ABCD2345", date: "24/10/2026", party_size: 4 });
  });

  it("sem código pega a mais recente do cliente, sem consultar customers por telefone", async () => {
    const { db, calls } = fakeDb({ data: ROW, error: null });
    await getReservationScoped(db, {}, scope);
    expectScoped(calls);
    expect(calls).toContainEqual(["order", "created_at", { ascending: false }]);
    expect(calls).toContainEqual(["limit", 1]);
    expect(calls.filter((c) => c[0] === "from")).toEqual([["from", "reservations"]]);
  });

  it("código de outra pessoa ou de outra loja volta como não encontrada", async () => {
    const { db } = fakeDb({ data: null, error: null });
    const res = await getReservationScoped(db, { reservation_code: "ZZZZ9999" }, scope);
    expect(res).toEqual({ found: false, message: "Reserva não encontrada ou já cancelada." });
  });

  it("erro de banco não vaza a mensagem do Postgres", async () => {
    const { db } = fakeDb({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } });
    const res = await getReservationScoped(db, { reservation_code: "ABCD2345" }, scope);
    expect(res.found).toBe(false);
    expect(JSON.stringify(res)).not.toContain("statement timeout");
  });
});

describe("updateReservationScoped", () => {
  it("aplica unidade, cliente e status e confere a linha alterada", async () => {
    const { db, calls } = fakeDb({ data: { reservation_code: "ABCD2345" }, error: null });
    const res = await updateReservationScoped(db, { reservation_code: "abcd2345", party_size: 6 }, scope);
    expectScoped(calls);
    expect(calls).toContainEqual(["eq", "reservation_code", "ABCD2345"]);
    expect(calls).toContainEqual(["select", "reservation_code"]);
    expect(res).toEqual({ success: true, message: "Reserva atualizada com sucesso!" });
  });

  it("zero linhas nunca vira sucesso", async () => {
    const { db } = fakeDb({ data: null, error: null });
    const res = await updateReservationScoped(db, { reservation_code: "ZZZZ9999", notes: "x" }, scope);
    expect(res).toEqual({ success: false, error: "Reserva não encontrada ou já cancelada." });
  });

  it("sem alteração não toca no banco", async () => {
    const { db, calls } = fakeDb({ data: null, error: null });
    const res = await updateReservationScoped(db, { reservation_code: "ABCD2345" }, scope);
    expect(res).toEqual({ success: false, message: "Nenhuma alteração informada." });
    expect(calls).toEqual([]);
  });

  it("código vazio não toca no banco", async () => {
    const { db, calls } = fakeDb({ data: null, error: null });
    const res = await updateReservationScoped(db, { reservation_code: "  ", party_size: 2 }, scope);
    expect(res.success).toBe(false);
    expect(calls).toEqual([]);
  });

  it("erro de banco não vaza a mensagem do Postgres", async () => {
    const { db } = fakeDb({ data: null, error: { code: "23514", message: "violates check constraint reservations_party" } });
    const res = await updateReservationScoped(db, { reservation_code: "ABCD2345", party_size: 2 }, scope);
    expect(res.success).toBe(false);
    expect(JSON.stringify(res)).not.toContain("constraint");
  });
});

describe("cancelReservationScoped", () => {
  it("aplica unidade, cliente e status", async () => {
    const { db, calls } = fakeDb({ data: { reservation_code: "ABCD2345" }, error: null });
    const res = await cancelReservationScoped(db, "abcd2345", scope);
    expectScoped(calls);
    expect(calls).toContainEqual(["update", expect.objectContaining({ status: "cancelled" })]);
    expect(calls).toContainEqual(["select", "reservation_code"]);
    expect(res).toEqual({ success: true, message: "Reserva #ABCD2345 cancelada." });
  });

  it("código de outra pessoa não cancela nada", async () => {
    const { db } = fakeDb({ data: null, error: null });
    const res = await cancelReservationScoped(db, "ZZZZ9999", scope);
    expect(res).toEqual({ success: false, error: "Reserva não encontrada ou já cancelada." });
  });

  it("código vazio devolve a orientação existente sem tocar no banco", async () => {
    const { db, calls } = fakeDb({ data: null, error: null });
    const res = await cancelReservationScoped(db, "", scope);
    expect(res.error).toContain("get_reservation");
    expect(calls).toEqual([]);
  });

  it("erro de banco não vaza a mensagem do Postgres", async () => {
    const { db } = fakeDb({ data: null, error: { code: "42501", message: "permission denied for table reservations" } });
    const res = await cancelReservationScoped(db, "ABCD2345", scope);
    expect(res.success).toBe(false);
    expect(JSON.stringify(res)).not.toContain("permission denied");
  });
});
