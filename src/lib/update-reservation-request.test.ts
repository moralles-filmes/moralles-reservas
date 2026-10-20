// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createEdgeRequestHarness } from "../test/fixtures/edge-request-harness";

// `update-reservation` real (handler, authz e validações) contra um banco em
// memória fechado: tabela fora da lista acima ou filtro desconhecido derruba o
// teste, então "parou antes da checagem de disponibilidade" é afirmação, não
// suposição.

type Row = Record<string, unknown>;
type Filter = [op: "eq" | "in", column: string, value: unknown];

const ENV = {
  SUPABASE_URL: "https://synthetic.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "synthetic-service",
  SUPABASE_ANON_KEY: "synthetic-anon",
};

function seed() {
  return {
    reservations: [
      { id: "res-a", unit_id: "unit-a", date: "2026-10-24", time: "20:00:00", party_size: 4, status: "confirmed", table_id: "mesa-a1", notes: null },
      { id: "res-b", unit_id: "unit-b", date: "2026-10-24", time: "20:00:00", party_size: 2, status: "confirmed", table_id: "mesa-b1", notes: null },
    ] as Row[],
    tables: [
      { id: "mesa-a1", unit_id: "unit-a", hall_id: "salao-a", name: "A1" },
      { id: "mesa-a2", unit_id: "unit-a", hall_id: "salao-a", name: "A2" },
      { id: "mesa-b1", unit_id: "unit-b", hall_id: "salao-b", name: "B1" },
    ] as Row[],
    halls: [
      { id: "salao-a", unit_id: "unit-a" },
      { id: "salao-b", unit_id: "unit-b" },
    ] as Row[],
    unit_members: [{ user_id: "gerente-a", unit_id: "unit-a" }] as Row[],
    platform_admins: [] as Row[],
  };
}

function createDb(options: { beforeUpdate?: (db: ReturnType<typeof seed>) => void } = {}) {
  const data = seed();
  const updates: { patch: Row; filters: Filter[] }[] = [];
  const unexpected: string[] = [];
  const matches = (row: Row, filters: Filter[]) => filters.every(([op, col, val]) =>
    op === "eq" ? row[col] === val : (val as unknown[]).includes(row[col]));

  function from(table: string) {
    if (!(table in data)) unexpected.push(`table:${table}`);
    const rows = (data as Record<string, Row[]>)[table] ?? [];
    const filters: Filter[] = [];
    let patch: Row | null = null;
    const builder = {
      select: () => builder,
      update: (p: Row) => { patch = p; return builder; },
      eq: (col: string, val: unknown) => { filters.push(["eq", col, val]); return builder; },
      in: (col: string, vals: unknown[]) => { filters.push(["in", col, vals]); return builder; },
      maybeSingle: async () => {
        if (patch) {
          options.beforeUpdate?.(data);
          updates.push({ patch, filters: [...filters] });
          const hit = rows.filter((r) => matches(r, filters));
          if (hit.length === 0) return { data: null, error: null };
          Object.assign(hit[0], patch);
          const table = data.tables.find((t) => t.id === hit[0].table_id) ?? null;
          return { data: { ...hit[0], customer: null, table }, error: null };
        }
        const hit = rows.filter((r) => matches(r, filters));
        return { data: hit[0] ?? null, error: null };
      },
      // PostgREST: `.single()` sem linha é erro PGRST116.
      single: async () => {
        const r = await builder.maybeSingle();
        return r.data ? r : { data: null, error: { code: "PGRST116", message: "0 rows" } };
      },
    };
    return builder;
  }

  const createClient = (_url: string, key: string, opts?: { global?: { headers?: Record<string, string> } }) => ({
    auth: {
      getUser: async () => {
        const auth = opts?.global?.headers?.Authorization ?? "";
        const userId = key === ENV.SUPABASE_ANON_KEY && auth.startsWith("Bearer ") ? auth.slice(7) : null;
        return userId ? { data: { user: { id: userId } }, error: null } : { data: { user: null }, error: { message: "no" } };
      },
    },
    from,
  });
  return { data, updates, unexpected, createClient };
}

async function call(db: ReturnType<typeof createDb>, body: unknown, userId = "gerente-a") {
  const harness = createEdgeRequestHarness({ env: ENV, createClient: db.createClient });
  try {
    const response = await harness.request("update-reservation", new Request(`${ENV.SUPABASE_URL}/functions/v1/update-reservation`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${userId}` },
      body: JSON.stringify(body),
    }));
    harness.assertNoUnexpectedIo();
    return { status: response.status, body: await response.json() };
  } finally {
    harness.dispose();
  }
}

describe("update-reservation (painel) — ids do body presos à unidade da reserva", () => {
  it("mesa de outra unidade é recusada sem gravar nem devolver a linha dela", async () => {
    const db = createDb();
    const res = await call(db, { reservation_id: "res-a", updates: { table_id: "mesa-b1" } });
    expect(res).toEqual({ status: 400, body: { error: "Mesa inválida." } });
    expect(db.updates).toEqual([]);
    expect(db.data.reservations[0].table_id).toBe("mesa-a1");
    expect(db.unexpected).toEqual([]);
  });

  it("mesa da própria unidade é gravada, com o UPDATE escopado por unidade e status editável", async () => {
    const db = createDb();
    const res = await call(db, { reservation_id: "res-a", updates: { table_id: "mesa-a2" } });
    expect(res.status).toBe(200);
    expect(res.body.reserva).toMatchObject({ id: "res-a", table_id: "mesa-a2", table: { id: "mesa-a2", unit_id: "unit-a" } });
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0].filters).toEqual([
      ["eq", "id", "res-a"],
      ["eq", "unit_id", "unit-a"],
      ["in", "status", ["pending", "confirmed"]],
    ]);
    expect(db.unexpected).toEqual([]);
  });

  it("salão de outra unidade é recusado antes da checagem de disponibilidade", async () => {
    const db = createDb();
    const res = await call(db, { reservation_id: "res-a", updates: { hall_id: "salao-b" } });
    expect(res).toEqual({ status: 400, body: { error: "Salão inválido." } });
    expect(db.updates).toEqual([]);
    // Nenhuma leitura de hall_schedules/business_hours: o banco fechado acusaria.
    expect(db.unexpected).toEqual([]);
  });

  it("reserva de outra unidade e reserva inexistente têm a mesma resposta", async () => {
    const alheia = await call(createDb(), { reservation_id: "res-b", updates: { notes: "x" } });
    const inexistente = await call(createDb(), { reservation_id: "nao-existe", updates: { notes: "x" } });
    expect(alheia).toEqual({ status: 404, body: { error: "reserva não encontrada" } });
    expect(inexistente).toEqual(alheia);
  });

  it("cancelamento entre a leitura e o UPDATE vira 409, sem reescrever a cancelada", async () => {
    const db = createDb({ beforeUpdate: (d) => { d.reservations[0].status = "cancelled"; } });
    const res = await call(db, { reservation_id: "res-a", updates: { notes: "mesa perto da janela" } });
    expect(res).toEqual({ status: 409, body: { error: "A reserva mudou de status e não pode mais ser editada." } });
    expect(db.data.reservations[0].notes).toBeNull();
  });

  it("table_id que não é texto é recusado na validação", async () => {
    const db = createDb();
    const res = await call(db, { reservation_id: "res-a", updates: { table_id: { id: "mesa-b1" } } });
    expect(res).toEqual({ status: 400, body: { error: "table_id inválido." } });
    expect(db.updates).toEqual([]);
  });
});
