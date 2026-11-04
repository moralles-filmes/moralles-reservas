import { describe, expect, it, vi } from "vitest";
import { checkAvailability, reserveSlot } from "../../supabase/functions/_shared/availability";

// Banco em memória com os operadores que `availability.ts` usa.
type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;

function memoryDb(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      const filters: Filter[] = [];
      let orderBy: { col: string; asc: boolean } | null = null;
      const run = () => {
        let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        if (orderBy) {
          const { col, asc } = orderBy;
          rows = [...rows].sort((a, b) => ((a[col] as number) - (b[col] as number)) * (asc ? 1 : -1));
        }
        return rows;
      };
      const builder = {
        select: () => builder,
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), builder),
        in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), builder),
        is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), builder),
        lt: (c: string, v: string) => (filters.push((r) => String(r[c]) < v), builder),
        gt: (c: string, v: string) => (filters.push((r) => String(r[c]) > v), builder),
        lte: (c: string, v: string) => (filters.push((r) => String(r[c]) <= v), builder),
        gte: (c: string, v: unknown) => (filters.push((r) => (r[c] as number | string) >= (v as number | string)), builder),
        order: (col: string, opts?: { ascending?: boolean }) => ((orderBy = { col, asc: opts?.ascending !== false }), builder),
        limit: () => builder,
        maybeSingle: () => Promise.resolve({ data: run()[0] ?? null, error: null }),
        then: (resolve: (v: { data: Row[]; error: null }) => unknown) => resolve({ data: run(), error: null }),
      };
      return builder;
    },
  };
}

const UNIT = "unit-1";
const DATE = "2030-03-15"; // sexta-feira

function baseTables(reservations: Row[], opts: { overbooking?: boolean } = {}) {
  return {
    settings: opts.overbooking ? [{ unit_id: UNIT, key: "allow_overbooking", value: true }] : [],
    special_dates: [],
    table_blocks: [],
    halls: [{ id: "hall-1", name: "Salão", allow_empty_seat: false, unit_id: UNIT, active: true, sort_order: 1 }],
    hall_schedules: [{
      id: "s1", hall_id: "hall-1", day_of_week: new Date(`${DATE}T12:00:00`).getDay(),
      open_time: "18:00:00", close_time: "23:00:00", slot_minutes: 30, min_advance_minutes: 0, discount_percent: null,
    }],
    tables: [
      { id: "t-2a", unit_id: UNIT, hall_id: "hall-1", active: true, min_capacity: 1, max_capacity: 2 },
      { id: "t-4a", unit_id: UNIT, hall_id: "hall-1", active: true, min_capacity: 1, max_capacity: 4 },
      { id: "t-4b", unit_id: UNIT, hall_id: "hall-1", active: true, min_capacity: 1, max_capacity: 4 },
    ],
    reservations,
  };
}

function res(id: string, table_id: string | null, time: string, party_size: number): Row {
  return { id, unit_id: UNIT, date: DATE, time, party_size, table_id, status: "confirmed" };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const check = (db: ReturnType<typeof memoryDb>, p: Record<string, unknown>) => checkAvailability(db as any, { unitId: UNIT, date: DATE, ...p } as any);

describe("checkAvailability ao alterar uma reserva", () => {
  it("sem os parâmetros novos, a própria reserva ocupa a mesa (comportamento de reserva nova preservado)", async () => {
    const db = memoryDb(baseTables([res("r1", "t-4a", "20:00:00", 3), res("r2", "t-4b", "20:00:00", 4)]));
    const out = await check(db, { time: "20:00", partySize: 4 });
    expect(out.available).toBe(false);
  });

  it("ignora a reserva alterada e mantém a mesa atual se ela continua cabendo", async () => {
    const db = memoryDb(baseTables([res("r1", "t-4a", "20:00:00", 3), res("r2", "t-4b", "20:00:00", 4)]));
    const out = await check(db, { time: "20:00", partySize: 4, excludeReservationId: "r1", preferTableId: "t-4a" });
    expect(out.available).toBe(true);
    expect(out.suggestedTableId).toBe("t-4a");
  });

  it("mantém a mesa atual mesmo quando o first-fit escolheria outra", async () => {
    const db = memoryDb(baseTables([res("r1", "t-4b", "20:00:00", 2)]));
    const out = await check(db, { time: "21:00", partySize: 2, excludeReservationId: "r1", preferTableId: "t-4b" });
    expect(out.suggestedTableId).toBe("t-4b");
  });

  it("troca de mesa quando a atual está ocupada no novo horário", async () => {
    const db = memoryDb(baseTables([res("r1", "t-4a", "19:00:00", 3), res("r2", "t-4a", "21:00:00", 4)]));
    const out = await check(db, { time: "21:00", partySize: 3, excludeReservationId: "r1", preferTableId: "t-4a" });
    expect(out.available).toBe(true);
    expect(out.suggestedTableId).toBe("t-4b");
  });

  it("troca de mesa quando a atual não comporta o novo número de pessoas", async () => {
    const db = memoryDb(baseTables([res("r1", "t-2a", "20:00:00", 2)]));
    const out = await check(db, { time: "20:00", partySize: 4, excludeReservationId: "r1", preferTableId: "t-2a" });
    expect(out.suggestedTableId).toBe("t-4a");
  });

  it("recusa quando não há mesa no novo horário, mesmo ignorando a própria reserva", async () => {
    const db = memoryDb(baseTables([
      res("r1", "t-2a", "19:00:00", 2),
      res("r2", "t-4a", "21:00:00", 4),
      res("r3", "t-4b", "21:00:00", 4),
    ]));
    const out = await check(db, { time: "21:00", partySize: 4, excludeReservationId: "r1", preferTableId: "t-2a" });
    expect(out.available).toBe(false);
    expect(out.reason).toBe("no_capacity");
  });

  it("reserva flutuante alterada não conta contra si mesma", async () => {
    const db = memoryDb(baseTables([
      res("r1", null, "20:00:00", 4),
      res("r2", "t-4a", "20:00:00", 4),
    ]));
    const sem = await check(db, { time: "20:00", partySize: 4 });
    expect(sem.available).toBe(false);
    const com = await check(db, { time: "20:00", partySize: 4, excludeReservationId: "r1" });
    expect(com.suggestedTableId).toBe("t-4b");
  });
});

describe("reserveSlot quando o INSERT falha", () => {
  it("devolve mensagem fixa ao chamador e deixa só o code no log", async () => {
    const base = memoryDb(baseTables([]));
    const pgError = { code: "23514", message: 'new row for relation "reservations" violates check constraint "reservations_source_check"' };
    const db = {
      from(table: string) {
        const builder = base.from(table) as Record<string, unknown>;
        builder.insert = () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: pgError }) }) });
        return builder;
      },
    };
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => { logged.push(String(line)); });
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const out = await reserveSlot(db as any, { unitId: UNIT, date: DATE, time: "20:00", partySize: 2, customerId: "c1" } as any);
      expect(out).toEqual({
        success: false,
        reason: "insert_failed",
        message: "Não foi possível concluir a reserva agora. Tente novamente em instantes.",
      });
      expect(logged).toEqual([JSON.stringify({ evt: "reserve_slot_insert_failed", code: "23514" })]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("reserveSlot com o hook insertReservation (Task 4.0b)", () => {
  // Banco que registra os INSERTs diretos; o hook, quando existe, substitui só eles.
  function dbWithInsertSpy(tables: Record<string, Row[]>) {
    const base = memoryDb(tables);
    const inserts: Row[] = [];
    const db = {
      from(table: string) {
        const builder = base.from(table) as Record<string, unknown>;
        builder.insert = (row: Row) => {
          inserts.push(row);
          return { select: () => ({ single: () => Promise.resolve({ data: { id: "res-direto", status: row.status, payment_status: null }, error: null }) }) };
        };
        return builder;
      },
    };
    return { db, inserts };
  }
  const params = { unitId: UNIT, date: DATE, time: "20:00", partySize: 2, customerId: "c1", notes: "obs", status: "confirmed", source: "instagram" };

  it("com hook, a linha vai ao hook (mesma forma do INSERT direto, com table_choice) e o INSERT direto não acontece", async () => {
    const { db, inserts } = dbWithInsertSpy(baseTables([]));
    const rows: Row[] = [];
    const hook = vi.fn(async (row: Row) => { rows.push(row); return { data: { id: "res-hook", status: "confirmed", payment_status: null }, error: null }; });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await reserveSlot(db as any, { ...params, insertReservation: hook } as any);
    expect(inserts, "INSERT direto com o hook presente").toEqual([]);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ success: true, reservationId: "res-hook", reservationStatus: "confirmed", paymentStatus: null, tableId: "t-2a" });
    const { reservation_code, ...resto } = rows[0];
    expect(reservation_code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect((out as { reservationCode: string }).reservationCode).toBe(reservation_code);
    expect(resto).toEqual({
      customer_id: "c1", unit_id: UNIT, table_id: "t-2a", date: DATE, time: "20:00", party_size: 2,
      notes: "obs", status: "confirmed", applied_discount_percent: null, source: "instagram", table_choice: "system",
    });
  });

  it("sem hook, o INSERT direto de sempre, com a mesma linha mais table_choice", async () => {
    const { db, inserts } = dbWithInsertSpy(baseTables([]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await reserveSlot(db as any, params as any);
    expect(inserts).toHaveLength(1);
    expect(out).toMatchObject({ success: true, reservationId: "res-direto" });
    const { reservation_code: _code, ...resto } = inserts[0];
    expect(resto).toEqual({
      customer_id: "c1", unit_id: UNIT, table_id: "t-2a", date: DATE, time: "20:00", party_size: 2,
      notes: "obs", status: "confirmed", applied_discount_percent: null, source: "instagram", table_choice: "system",
    });
  });

  it("23505 vindo do hook dispara o retry: re-checa e tenta de novo", async () => {
    const { db, inserts } = dbWithInsertSpy(baseTables([]));
    const hook = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { code: "23505" } })
      .mockResolvedValueOnce({ data: { id: "res-2a-tentativa", status: "confirmed", payment_status: null }, error: null });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await reserveSlot(db as any, { ...params, insertReservation: hook } as any);
    expect(hook).toHaveBeenCalledTimes(2);
    expect(hook.mock.calls[0][0].reservation_code).not.toBe(hook.mock.calls[1][0].reservation_code);
    expect(inserts).toEqual([]);
    expect(out).toMatchObject({ success: true, reservationId: "res-2a-tentativa" });
  });

  it("erro do hook que não é 23505 encerra com a mensagem fixa e só o code no log", async () => {
    const { db, inserts } = dbWithInsertSpy(baseTables([]));
    const hook = vi.fn().mockResolvedValue({ data: null, error: { code: "42501" } });
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => { logged.push(String(line)); });
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const out = await reserveSlot(db as any, { ...params, insertReservation: hook } as any);
      expect(hook).toHaveBeenCalledTimes(1);
      expect(inserts).toEqual([]);
      expect(out).toEqual({ success: false, reason: "insert_failed", message: "Não foi possível concluir a reserva agora. Tente novamente em instantes." });
      expect(logged).toEqual([JSON.stringify({ evt: "reserve_slot_insert_failed", code: "42501" })]);
    } finally {
      spy.mockRestore();
    }
  });
});
