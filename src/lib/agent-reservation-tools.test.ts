import { describe, expect, it } from "vitest";
import {
  cancelReservationScoped,
  getReservationScoped,
  updateReservationScoped,
} from "../../supabase/functions/_shared/agent-reservation-tools";
import type { AvailabilityParams, AvailabilityResult } from "../../supabase/functions/_shared/availability";

type Call = [string, ...unknown[]];

type DbResult = { data: unknown; error: { code?: string; message?: string } | null };

// Cada .maybeSingle() consome o próximo resultado da fila (o último se repete).
function fakeDb(...results: DbResult[]) {
  const calls: Call[] = [];
  let next = 0;
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "update", "eq", "in", "order", "limit"]) {
    builder[method] = (...args: unknown[]) => {
      calls.push([method, ...args]);
      return builder;
    };
  }
  builder.maybeSingle = () => {
    calls.push(["maybeSingle"]);
    const r = results[Math.min(next, results.length - 1)];
    next += 1;
    return Promise.resolve(r);
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
  const CURRENT = { data: { id: "r1", date: "2026-10-24", time: "20:00:00", party_size: 4, table_id: "t-4a" }, error: null };
  const HALL = { data: { hall_id: "hall-1" }, error: null };
  const UPDATED = { data: { reservation_code: "ABCD2345" }, error: null };

  function availability(result: Partial<AvailabilityResult> = {}) {
    const seen: AvailabilityParams[] = [];
    return {
      seen,
      deps: {
        checkAvailability: async (p: AvailabilityParams): Promise<AvailabilityResult> => {
          seen.push(p);
          return { available: true, suggestedTableId: "t-4a", message: "ok", durationMinutes: 120, ...result };
        },
      },
    };
  }

  it("lê e grava só dentro da unidade, do cliente e do status ativo", async () => {
    const { db, calls } = fakeDb(CURRENT, HALL, UPDATED);
    const { deps } = availability();
    const res = await updateReservationScoped(db, { reservation_code: "abcd2345", party_size: 6 }, scope, deps);
    expectScoped(calls);
    expect(calls).toContainEqual(["eq", "reservation_code", "ABCD2345"]);
    expect(calls).toContainEqual(["eq", "id", "r1"]);
    expect(calls).toContainEqual(["select", "reservation_code"]);
    expect(res).toEqual({ success: true, message: "Reserva atualizada com sucesso!" });
  });

  it("mudar pessoas revalida no salão atual, ignorando a própria reserva e preferindo a mesa atual", async () => {
    const { db, calls } = fakeDb(CURRENT, HALL, UPDATED);
    const { deps, seen } = availability({ suggestedTableId: "t-6a" });
    await updateReservationScoped(db, { reservation_code: "ABCD2345", party_size: 6 }, scope, deps);
    expect(seen).toEqual([{
      unitId: "unit-a", hallId: "hall-1", date: "2026-10-24", time: "20:00", partySize: 6,
      excludeReservationId: "r1", preferTableId: "t-4a",
    }]);
    expect(calls).toContainEqual(["update", expect.objectContaining({ party_size: 6, table_id: "t-6a" })]);
  });

  it("sem vaga no novo horário não grava nada", async () => {
    const { db, calls } = fakeDb(CURRENT, HALL, UPDATED);
    const { deps } = availability({ available: false, reason: "no_capacity", message: "Salão: não há mesa disponível para esse horário." });
    const res = await updateReservationScoped(db, { reservation_code: "ABCD2345", time: "21:00" }, scope, deps);
    expect(res).toMatchObject({ success: false, available: false, reason: "no_capacity" });
    expect(calls.some((c) => c[0] === "update")).toBe(false);
  });

  it("overbooking sem mesa sugerida deixa a reserva flutuante", async () => {
    const { db, calls } = fakeDb(CURRENT, HALL, UPDATED);
    const { deps } = availability({ suggestedTableId: undefined });
    await updateReservationScoped(db, { reservation_code: "ABCD2345", time: "21:00" }, scope, deps);
    expect(calls).toContainEqual(["update", expect.objectContaining({ time: "21:00", table_id: null })]);
  });

  it("só observação não revalida disponibilidade nem mexe na mesa", async () => {
    const { db, calls } = fakeDb(CURRENT, UPDATED);
    const { deps, seen } = availability();
    const res = await updateReservationScoped(db, { reservation_code: "ABCD2345", notes: "aniversário" }, scope, deps);
    expect(res.success).toBe(true);
    expect(seen).toEqual([]);
    expect(calls).not.toContainEqual(["from", "tables"]);
    const update = calls.find((c) => c[0] === "update");
    expect(update?.[1]).not.toHaveProperty("table_id");
  });

  it("mesmo horário escrito com segundos não conta como mudança", async () => {
    const { db } = fakeDb(CURRENT, UPDATED);
    const { deps, seen } = availability();
    await updateReservationScoped(db, { reservation_code: "ABCD2345", time: "20:00", notes: "x" }, scope, deps);
    expect(seen).toEqual([]);
  });

  it("reserva de outra pessoa não é lida nem alterada", async () => {
    const { db, calls } = fakeDb({ data: null, error: null });
    const { deps, seen } = availability();
    const res = await updateReservationScoped(db, { reservation_code: "ZZZZ9999", party_size: 2 }, scope, deps);
    expect(res).toEqual({ success: false, error: "Reserva não encontrada ou já cancelada." });
    expect(seen).toEqual([]);
    expect(calls.some((c) => c[0] === "update")).toBe(false);
  });

  it("zero linhas no UPDATE nunca vira sucesso", async () => {
    const { db } = fakeDb(CURRENT, { data: null, error: null });
    const res = await updateReservationScoped(db, { reservation_code: "ABCD2345", notes: "x" }, scope, availability().deps);
    expect(res).toEqual({ success: false, error: "Reserva não encontrada ou já cancelada." });
  });

  it("mesa tomada entre a checagem e o UPDATE (23505) pede outro horário", async () => {
    const { db } = fakeDb(CURRENT, HALL, { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } });
    const res = await updateReservationScoped(db, { reservation_code: "ABCD2345", time: "21:00" }, scope, availability().deps);
    expect(res).toMatchObject({ success: false, available: false });
    expect(JSON.stringify(res)).not.toContain("duplicate key");
  });

  it("sem alteração não toca no banco", async () => {
    const { db, calls } = fakeDb({ data: null, error: null });
    const res = await updateReservationScoped(db, { reservation_code: "ABCD2345" }, scope, availability().deps);
    expect(res).toEqual({ success: false, message: "Nenhuma alteração informada." });
    expect(calls).toEqual([]);
  });

  it("código vazio não toca no banco", async () => {
    const { db, calls } = fakeDb({ data: null, error: null });
    const res = await updateReservationScoped(db, { reservation_code: "  ", party_size: 2 }, scope, availability().deps);
    expect(res.success).toBe(false);
    expect(calls).toEqual([]);
  });

  it("erro de banco não vaza a mensagem do Postgres", async () => {
    const { db } = fakeDb({ data: null, error: { code: "23514", message: "violates check constraint reservations_party" } });
    const res = await updateReservationScoped(db, { reservation_code: "ABCD2345", party_size: 2 }, scope, availability().deps);
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
