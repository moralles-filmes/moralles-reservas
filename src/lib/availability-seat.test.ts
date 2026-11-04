import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkAvailability, loadSeatMap, reserveSlot } from "../../supabase/functions/_shared/availability";

// Banco em memória com os operadores que `availability.ts` usa, mais `rpc`.
type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;
type RpcHandler = (args: Record<string, unknown>) => { data: unknown; error: { code?: string } | null };

function memoryDb(tables: Record<string, Row[]>, rpcs: Record<string, RpcHandler> = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const inserts: Row[] = [];
  const db = {
    calls,
    inserts,
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      const h = rpcs[name];
      return Promise.resolve(h ? h(args) : { data: null, error: { code: "PGRST202" } });
    },
    from(table: string) {
      const filters: Filter[] = [];
      const run = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      const builder = {
        select: () => builder,
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), builder),
        in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), builder),
        is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), builder),
        lt: (c: string, v: string) => (filters.push((r) => String(r[c]) < v), builder),
        gt: (c: string, v: string) => (filters.push((r) => String(r[c]) > v), builder),
        lte: (c: string, v: string) => (filters.push((r) => String(r[c]) <= v), builder),
        gte: (c: string, v: unknown) => (filters.push((r) => (r[c] as number | string) >= (v as number | string)), builder),
        order: () => builder,
        limit: () => builder,
        maybeSingle: () => Promise.resolve({ data: run()[0] ?? null, error: null }),
        single: () => Promise.resolve({ data: run()[0] ?? null, error: run()[0] ? null : { code: "PGRST116" } }),
        insert: (row: Row) => {
          inserts.push(row);
          return { select: () => ({ single: () => Promise.resolve({ data: { id: "res-direto", status: row.status, payment_status: null }, error: null }) }) };
        },
        then: (resolve: (v: { data: Row[]; error: null }) => unknown) => resolve({ data: run(), error: null }),
      };
      return builder;
    },
  };
  return db;
}

const UNIT = "unit-1";
const OTHER_UNIT = "unit-2";
const DATE = "2030-03-15"; // sexta-feira
// "Agora" = 20:00 BRT do mesmo dia: passante sentado e janela de hoje.
const NOW = new Date(`${DATE}T20:00:00-03:00`);

function table(id: string, number: number, min: number, max: number, extra: Row = {}): Row {
  return { id, unit_id: UNIT, hall_id: "hall-1", number, active: true, bookable: true, min_capacity: min, max_capacity: max, ...extra };
}

function base(opts: { overbooking?: boolean; reservations?: Row[]; occupants?: Row[]; walkIns?: Row[]; plan?: boolean } = {}) {
  return {
    settings: opts.overbooking ? [{ unit_id: UNIT, key: "allow_overbooking", value: true }] : [],
    special_dates: [],
    table_blocks: [],
    halls: [
      {
        id: "hall-1", name: "Salão", allow_empty_seat: false, unit_id: UNIT, active: true, sort_order: 1,
        plan_width_cm: opts.plan ? 1000 : null, plan_depth_cm: opts.plan ? 800 : null,
        plan_entrance_wall: null, plan_entrance_offset_cm: null, plan_window_walls: [],
      },
      { id: "hall-x", name: "Outra", allow_empty_seat: false, unit_id: OTHER_UNIT, active: true, sort_order: 1 },
    ],
    hall_schedules: [{
      id: "s1", hall_id: "hall-1", day_of_week: new Date(`${DATE}T12:00:00Z`).getUTCDay(),
      open_time: "12:00:00", close_time: "23:00:00", slot_minutes: 30, min_advance_minutes: 0, discount_percent: null,
    }],
    tables: [
      table("t-a", 1, 2, 4, opts.plan ? { plan_x: 100, plan_y: 100, plan_w: 80, plan_h: 80, plan_rotation: 0, plan_shape: "square" } : {}),
      table("t-b", 2, 2, 4),
      table("t-x", 9, 2, 4, { unit_id: OTHER_UNIT, hall_id: "hall-x" }),
    ],
    table_combinations: [{ id: "c-ab", unit_id: UNIT, hall_id: "hall-1", active: true, min_capacity: 5, max_capacity: 8 }],
    table_combination_members: [
      { combination_id: "c-ab", table_id: "t-a", unit_id: UNIT },
      { combination_id: "c-ab", table_id: "t-b", unit_id: UNIT },
    ],
    reservations: opts.reservations ?? [],
    occupant_tables: opts.occupants ?? [],
    walk_ins: opts.walkIns ?? [],
    waitlist: [],
  };
}

function res(id: string, table_id: string | null, time: string, party_size: number, extra: Row = {}): Row {
  return { id, unit_id: UNIT, date: DATE, time, party_size, table_id, status: "confirmed", ...extra };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const check = (db: ReturnType<typeof memoryDb>, p: Record<string, unknown>) => checkAvailability(db as any, { unitId: UNIT, hallId: "hall-1", date: DATE, ...p } as any);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("ocupação lida de occupant_tables", () => {
  it("combinação ocupada bloqueia o membro que não é o table_id principal", async () => {
    const occupants = [
      { unit_id: UNIT, reservation_id: "r1", table_id: "t-a" },
      { unit_id: UNIT, reservation_id: "r1", table_id: "t-b" },
    ];
    const db = memoryDb(base({ reservations: [res("r1", "t-a", "21:00:00", 6)], occupants }));
    const out = await check(db, { time: "21:00", partySize: 2 });
    expect(out.available).toBe(false);
    expect(out.reason).toBe("no_capacity");
  });

  it("sem a linha extra, o outro membro fica livre", async () => {
    const db = memoryDb(base({ reservations: [res("r1", "t-a", "21:00:00", 2)], occupants: [{ unit_id: UNIT, reservation_id: "r1", table_id: "t-a" }] }));
    const out = await check(db, { time: "21:00", partySize: 2 });
    expect(out.suggestedTableIds).toEqual(["t-b"]);
  });

  it("reserva liberada não ocupa", async () => {
    const db = memoryDb(base({ reservations: [res("r1", "t-a", "21:00:00", 2, { released_at: "2030-03-15T23:10:00Z" })] }));
    const out = await check(db, { time: "21:00", partySize: 2 });
    expect(out.suggestedTableIds).toEqual(["t-a"]);
  });

  it("grupo que só cabe na combinação recebe as duas mesas", async () => {
    const db = memoryDb(base());
    const out = await check(db, { time: "21:00", partySize: 6 });
    expect(out).toMatchObject({ available: true, suggestedTableId: "t-a", suggestedTableIds: ["t-a", "t-b"], combinationId: "c-ab" });
  });
});

describe("passante sentado conta", () => {
  const seated = (extra: Row = {}): Row => ({
    id: "w1", unit_id: UNIT, table_id: "t-a", status: "seated", released_at: null,
    seated_at: "2030-03-15T22:30:00.000Z", arrived_at: "2030-03-15T22:25:00.000Z", created_at: "2030-03-15T22:25:00.000Z", ...extra,
  });

  it("ocupa de seated_at até seated_at + duração", async () => {
    // Sentou 19:30 BRT; duração 90 → até 21:00. Pedido 20:30 cruza.
    const db = memoryDb(base({ walkIns: [seated()], occupants: [{ unit_id: UNIT, walk_in_id: "w1", table_id: "t-a" }] }));
    const out = await check(db, { time: "20:30", partySize: 2 });
    expect(out.suggestedTableIds).toEqual(["t-b"]);
  });

  it("mesa juntada ao passante também fica ocupada", async () => {
    const db = memoryDb(base({
      walkIns: [seated()],
      occupants: [{ unit_id: UNIT, walk_in_id: "w1", table_id: "t-a" }, { unit_id: UNIT, walk_in_id: "w1", table_id: "t-b" }],
    }));
    const out = await check(db, { time: "20:30", partySize: 2 });
    expect(out.available).toBe(false);
  });

  it("depois da ocupação prevista a mesa volta a valer", async () => {
    const db = memoryDb(base({ walkIns: [seated()] }));
    const out = await check(db, { time: "21:30", partySize: 2 });
    expect(out.suggestedTableIds).toEqual(["t-a"]);
  });

  it("passante liberado não ocupa", async () => {
    const db = memoryDb(base({ walkIns: [seated({ released_at: "2030-03-15T23:00:00Z" })] }));
    const out = await check(db, { time: "20:30", partySize: 2 });
    expect(out.suggestedTableIds).toEqual(["t-a"]);
  });
});

describe("escolha do cliente", () => {
  it("escolha livre vira suggestedTableIds da própria escolha", async () => {
    const db = memoryDb(base());
    const out = await check(db, { time: "21:00", partySize: 2, choice: { kind: "table", id: "t-b" } });
    expect(out).toMatchObject({ available: true, suggestedTableIds: ["t-b"], combinationId: null });
  });

  it("escolha ocupada devolve seat_unavailable, nunca overbooking", async () => {
    const db = memoryDb(base({ overbooking: true, reservations: [res("r1", "t-b", "21:00:00", 2)] }));
    const out = await check(db, { time: "21:00", partySize: 2, choice: { kind: "table", id: "t-b" } });
    expect(out.available).toBe(false);
    expect(out.reason).toBe("seat_unavailable");
  });

  it("mesa de outro salão ou unidade é indisponível", async () => {
    const db = memoryDb(base());
    const out = await check(db, { time: "21:00", partySize: 2, choice: { kind: "table", id: "t-x" } });
    expect(out.reason).toBe("seat_unavailable");
  });

  it("sem escolha e sem mesa, overbooking ativo cria flutuante (comportamento de hoje)", async () => {
    const db = memoryDb(base({ overbooking: true, reservations: [res("r1", "t-a", "21:00:00", 2), res("r2", "t-b", "21:00:00", 2)] }));
    const out = await check(db, { time: "21:00", partySize: 2 });
    expect(out).toMatchObject({ available: true, suggestedTableId: undefined, suggestedTableIds: [] });
  });
});

describe("falha de leitura", () => {
  it("erro ao ler bloqueios de mesa falha fechado (nunca mesa bloqueada como livre)", async () => {
    const db = memoryDb(base());
    const realFrom = db.from.bind(db);
    db.from = (t: string) => {
      const b = realFrom(t) as Record<string, unknown>;
      if (t === "table_blocks") {
        b.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: { code: "57014" } });
      }
      return b as ReturnType<typeof realFrom>;
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(check(db, { time: "21:00", partySize: 2 })).rejects.toThrow("availability_read_failed");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("salão de outra unidade", () => {
  it("hall_id alheio dá no_capacity e não cai no caminho legado", async () => {
    const db = memoryDb(base());
    const out = await check(db, { hallId: "hall-x", time: "21:00", partySize: 2 });
    expect(out.available).toBe(false);
    expect(out.reason).toBe("no_capacity");
  });
});

describe("reserveSlot com várias mesas", () => {
  const params = { unitId: UNIT, hallId: "hall-1", date: DATE, time: "21:00", partySize: 6, customerId: "c1", status: "confirmed", source: "web" };

  it("2+ mesas vão pela RPC insert_reservation_with_tables, sem table_id na linha", async () => {
    const tables = base();
    const db = memoryDb(tables, {
      insert_reservation_with_tables: () => {
        tables.reservations.push(res("r-new", "t-a", "21:00:00", 6));
        return { data: "r-new", error: null };
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await reserveSlot(db as any, { ...params, choice: { kind: "combination", id: "c-ab" } } as any);
    expect(out).toMatchObject({ success: true, reservationId: "r-new", tableId: "t-a", tableIds: ["t-a", "t-b"] });
    expect(db.inserts).toEqual([]);
    const call = db.calls.find((c) => c.name === "insert_reservation_with_tables")!;
    expect(call.args.p_table_ids).toEqual(["t-a", "t-b"]);
    expect(call.args.p_row).not.toHaveProperty("table_id");
    expect(call.args.p_row).toMatchObject({ table_choice: "customer", unit_id: UNIT, party_size: 6 });
  });

  it("seat_unavailable em 23P01: re-checa e, com escolha, não cai em outra mesa", async () => {
    const tables = base();
    const db = memoryDb(tables, {
      insert_reservation_with_tables: () => {
        // Outra reserva pegou a mesa B entre a checagem e o INSERT.
        tables.reservations.push(res("r-outra", "t-b", "21:00:00", 2));
        return { data: null, error: { code: "23P01" } };
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await reserveSlot(db as any, { ...params, choice: { kind: "combination", id: "c-ab" } } as any);
    expect(out).toMatchObject({ success: false, reason: "seat_unavailable" });
    expect(db.calls.filter((c) => c.name === "insert_reservation_with_tables")).toHaveLength(1);
  });

  it("23P01 no INSERT direto também dispara o retry", async () => {
    const tables = base();
    let first = true;
    const db = memoryDb(tables);
    const realFrom = db.from.bind(db);
    db.from = (t: string) => {
      const b = realFrom(t) as Record<string, unknown>;
      if (t === "reservations") {
        b.insert = (row: Row) => ({
          select: () => ({
            single: () => {
              if (first) {
                first = false;
                tables.reservations.push(res("r-outra", "t-a", "21:00:00", 2));
                return Promise.resolve({ data: null, error: { code: "23P01" } });
              }
              db.inserts.push(row);
              return Promise.resolve({ data: { id: "r-2a", status: "confirmed", payment_status: null }, error: null });
            },
          }),
        });
      }
      return b as ReturnType<typeof realFrom>;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await reserveSlot(db as any, { ...params, partySize: 2 } as any);
    expect(out).toMatchObject({ success: true, reservationId: "r-2a", tableIds: ["t-b"] });
    expect(db.inserts[0]).toMatchObject({ table_id: "t-b", table_choice: "system" });
  });

  it("com o hook do Instagram, mesas juntas vão na linha (table_ids + table_choice)", async () => {
    const db = memoryDb(base());
    const hook = vi.fn(async (_row: Record<string, unknown>) => ({ data: { id: "r-ig", status: "confirmed", payment_status: null }, error: null }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await reserveSlot(db as any, { ...params, source: "instagram", insertReservation: hook } as any);
    expect(out).toMatchObject({ success: true, reservationId: "r-ig", tableIds: ["t-a", "t-b"] });
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook.mock.calls[0][0]).toMatchObject({ table_id: "t-a", table_ids: ["t-a", "t-b"], table_choice: "system" });
    expect(db.calls).toEqual([]);
  });

  it("com o hook, escolha do cliente de mesa sozinha vai como customer, sem table_ids", async () => {
    const db = memoryDb(base());
    const hook = vi.fn(async (_row: Record<string, unknown>) => ({ data: { id: "r-ig", status: "confirmed", payment_status: null }, error: null }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reserveSlot(db as any, { ...params, partySize: 2, source: "instagram", choice: { kind: "table", id: "t-b" }, insertReservation: hook } as any);
    const row = hook.mock.calls[0][0] as Record<string, unknown>;
    expect(row).toMatchObject({ table_id: "t-b", table_choice: "customer" });
    expect(row).not.toHaveProperty("table_ids");
  });

  it("23P01 vindo do hook do Instagram re-checa como o 23505", async () => {
    const tables = base();
    const db = memoryDb(tables);
    const hook = vi.fn()
      .mockImplementationOnce(async () => {
        tables.reservations.push(res("r-outra", "t-a", "21:00:00", 2));
        return { data: null, error: { code: "23P01" } };
      })
      .mockResolvedValueOnce({ data: { id: "r-ig2", status: "confirmed", payment_status: null }, error: null });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await reserveSlot(db as any, { ...params, partySize: 2, source: "instagram", insertReservation: hook } as any);
    expect(hook).toHaveBeenCalledTimes(2);
    expect(hook.mock.calls[1][0]).toMatchObject({ table_id: "t-b" });
    expect(out).toMatchObject({ success: true, reservationId: "r-ig2" });
  });
});

describe("loadSeatMap", () => {
  it("sem planta → hall.plan === null", async () => {
    const db = memoryDb(base());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const map = await loadSeatMap(db as any, { unitId: UNIT, hallId: "hall-1", date: DATE, time: "21:00", partySize: 2 });
    expect("error" in map).toBe(false);
    if ("error" in map) return;
    expect(map.hall.plan).toBeNull();
  });

  it("com planta, só as chaves do contrato e sem dado de reserva", async () => {
    const db = memoryDb(base({ plan: true, reservations: [res("r1", "t-b", "21:00:00", 2, { customer_id: "cust-secreto" })] }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const map = await loadSeatMap(db as any, { unitId: UNIT, hallId: "hall-1", date: DATE, time: "21:00", partySize: 2 });
    if ("error" in map) throw new Error(map.error);
    expect(Object.keys(map).sort()).toEqual(["hall", "options", "tables"]);
    expect(Object.keys(map.hall).sort()).toEqual(["id", "name", "plan"]);
    expect(map.hall.plan).toEqual({ widthCm: 1000, depthCm: 800, entranceWall: null, entranceOffsetCm: null, windowWalls: [] });
    for (const t of map.tables) expect(Object.keys(t).sort()).toEqual(["available", "bookable", "id", "number", "plan"]);
    expect(map.tables.find((t) => t.id === "t-b")?.available).toBe(false);
    expect(map.tables.find((t) => t.id === "t-a")?.available).toBe(true);
    expect(JSON.stringify(map)).not.toMatch(/r1|cust-secreto|21:00/);
  });

  it("salão de outra unidade → erro, sem mapa", async () => {
    const db = memoryDb(base());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const map = await loadSeatMap(db as any, { unitId: UNIT, hallId: "hall-x", date: DATE, time: "21:00", partySize: 2 });
    expect(map).toEqual({ error: "no_capacity" });
  });

  it("fora do horário → erro com a mesma regra do tryHall", async () => {
    const db = memoryDb(base());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const map = await loadSeatMap(db as any, { unitId: UNIT, hallId: "hall-1", date: DATE, time: "23:30", partySize: 2 });
    expect(map).toEqual({ error: "outside_hours" });
  });
});
