import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Escolha de mesa no agente (plano Task 17): `get_table_choice_link` e
 * `create_reservation` com `table_choice`. O motor de disponibilidade fica
 * falso; o client falso aplica os filtros `eq`/`ilike`/`lt` de verdade, então
 * "só dentro da unidade" é medido pela linha que volta, não por um filtro na lista.
 */
const h = vi.hoisted(() => ({
  loadSeatMap: vi.fn(),
  reserveSlot: vi.fn(),
  checkAvailability: vi.fn(),
  loadSeatChoiceEnabled: vi.fn(),
  resolveOrCreateCustomer: vi.fn(),
}));
vi.mock("../../supabase/functions/_shared/availability", () => ({
  loadSeatMap: h.loadSeatMap,
  reserveSlot: h.reserveSlot,
  checkAvailability: h.checkAvailability,
}));
vi.mock("../../supabase/functions/_shared/adapters/hall-seating", () => ({
  loadSeatChoiceEnabled: h.loadSeatChoiceEnabled,
}));
vi.mock("../../supabase/functions/_shared/resolve-customer", () => ({
  resolveOrCreateCustomer: h.resolveOrCreateCustomer,
}));

import {
  agentTools,
  createReservation,
  getTableChoiceLink,
  TABLE_CHOICE_LINK_TOOL,
} from "../../supabase/functions/_shared/agent/tools";
import { hashSeatLinkToken } from "../../supabase/functions/_shared/seat-link-core";

type Row = Record<string, unknown>;

function fakeDb(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  const ops: Array<{ table: string; op: string; row?: Row; filters: string[] }> = [];
  const db = {
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      const labels: string[] = [];
      let op = "select";
      let payload: Row | null = null;
      const b: Record<string, unknown> = {};
      const chain = (name: string, fn?: (...a: unknown[]) => void) => {
        b[name] = (...args: unknown[]) => { fn?.(...args); return b; };
      };
      chain("select");
      chain("order");
      chain("eq", (c, v) => { labels.push(`eq:${c}=${v}`); filters.push((r) => r[c as string] === v); });
      chain("ilike", (c, v) => {
        const needle = String(v).replace(/%/g, "").toLowerCase();
        filters.push((r) => String(r[c as string] ?? "").toLowerCase().includes(needle));
      });
      chain("in", (c, vs) => filters.push((r) => (vs as unknown[]).includes(r[c as string])));
      chain("lt", (c, v) => { labels.push(`lt:${c}`); filters.push((r) => String(r[c as string]) < String(v)); });
      chain("delete", () => { op = "delete"; });
      const run = () => {
        const rows = tables[table] ?? [];
        if (op === "insert") {
          rows.push(payload!);
          tables[table] = rows;
          ops.push({ table, op, row: payload!, filters: labels });
          return [payload!];
        }
        const hit = rows.filter((r) => filters.every((f) => f(r)));
        if (op === "delete") {
          tables[table] = rows.filter((r) => !hit.includes(r));
          ops.push({ table, op, filters: labels });
        }
        return hit;
      };
      b.insert = (row: Row) => { op = "insert"; payload = row; return b; };
      b.maybeSingle = async () => ({ data: run()[0] ?? null, error: null });
      b.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
        Promise.resolve({ data: run(), error: null }).then(ok, ko);
      return b;
    },
  };
  return { db, tables, ops };
}

const UNIT = "unit-a";
const OTHER = "unit-b";

function seatMap(opts: { plan?: boolean; free?: boolean; hallId?: string } = {}) {
  const free = opts.free ?? true;
  return {
    hall: {
      id: opts.hallId ?? "hall-a",
      name: "Salão principal",
      plan: opts.plan === false ? null : { widthCm: 800, depthCm: 600, entranceWall: null, entranceOffsetCm: null, windowWalls: [] },
    },
    tables: [
      { id: "t3", number: 3, plan: null, bookable: true, available: free },
      { id: "t4", number: 4, plan: null, bookable: true, available: free },
      { id: "t5", number: 5, plan: null, bookable: true, available: free },
      { id: "t9", number: 9, plan: null, bookable: false, available: false },
      { id: "t12", number: 12, plan: null, bookable: true, available: free },
    ],
    options: [
      { choice: { kind: "table", id: "t3" }, tableIds: ["t3"], available: free, minCapacity: 1, maxCapacity: 4 },
      { choice: { kind: "table", id: "t12" }, tableIds: ["t12"], available: free, minCapacity: 1, maxCapacity: 4 },
      { choice: { kind: "combination", id: "c345" }, tableIds: ["t3", "t4", "t5"], available: free, minCapacity: 6, maxCapacity: 12 },
    ],
  };
}

function seed() {
  return {
    halls: [
      { id: "hall-a", unit_id: UNIT, name: "Salão principal", active: true, allow_empty_seat: false },
      { id: "hall-x", unit_id: OTHER, name: "Salão principal", active: true, allow_empty_seat: false },
    ],
    seat_choice_links: [
      { id: "old", unit_id: UNIT, expires_at: "2026-11-01T00:00:00.000Z" },
      { id: "alheio", unit_id: OTHER, expires_at: "2026-11-01T00:00:00.000Z" },
    ],
  };
}

const scope = (over: Record<string, unknown> = {}) => ({
  unitId: UNIT,
  channel: "whatsapp" as const,
  channelId: "chan-1",
  appBaseUrl: () => "https://reservas.exemplo.com.br/",
  now: () => new Date("2026-11-06T18:00:00.000Z"),
  ...over,
});
const input = { date: "2026-11-07", time: "20:00", party_size: 4 };

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
  h.loadSeatChoiceEnabled.mockResolvedValue(true);
  h.loadSeatMap.mockResolvedValue(seatMap());
});

describe("get_table_choice_link", () => {
  it("grava o link com unidade e canal da conversa e só o hash do token", async () => {
    const { db, tables } = fakeDb(seed());
    const r = await getTableChoiceLink(db as never, input, scope());
    expect(r.available).toBe(true);
    expect(r.expires_in_hours).toBe(6);
    const token = String(r.url).match(/^https:\/\/reservas\.exemplo\.com\.br\/mesa\/([A-Za-z0-9_-]{43})$/)?.[1];
    expect(token).toBeTruthy();
    const link = tables.seat_choice_links.find((l) => l.token_hash);
    expect(link).toMatchObject({
      unit_id: UNIT, hall_id: "hall-a", channel_id: "chan-1", date: "2026-11-07", time: "20:00", party_size: 4,
      expires_at: "2026-11-07T00:00:00.000Z",
    });
    expect(link!.token_hash).toBe(await hashSeatLinkToken(token!));
    expect(JSON.stringify(link)).not.toContain(token!);
    expect(h.loadSeatMap).toHaveBeenCalledWith(db, { unitId: UNIT, hallId: "hall-a", date: "2026-11-07", time: "20:00", partySize: 4 });
  });

  it("apaga só os links vencidos da própria unidade", async () => {
    const { db, tables } = fakeDb(seed());
    await getTableChoiceLink(db as never, input, scope());
    const ids = tables.seat_choice_links.map((l) => l.id);
    expect(ids).not.toContain("old");
    expect(ids).toContain("alheio");
  });

  it("salão sem planta → no_plan, sem gravar link", async () => {
    h.loadSeatMap.mockResolvedValue(seatMap({ plan: false }));
    const { db, ops } = fakeDb(seed());
    expect(await getTableChoiceLink(db as never, input, scope())).toEqual({ available: false, reason: "no_plan" });
    expect(ops.some((o) => o.op === "insert")).toBe(false);
  });

  it("chave da unidade desligada → disabled, sem ler o mapa", async () => {
    h.loadSeatChoiceEnabled.mockResolvedValue(false);
    const { db } = fakeDb(seed());
    expect(await getTableChoiceLink(db as never, input, scope())).toEqual({ available: false, reason: "disabled" });
    expect(h.loadSeatMap).not.toHaveBeenCalled();
  });

  it("Instagram (ou sem canal) → channel_unsupported", async () => {
    const { db } = fakeDb(seed());
    expect(await getTableChoiceLink(db as never, input, scope({ channel: "instagram" }))).toEqual({ available: false, reason: "channel_unsupported" });
    expect(await getTableChoiceLink(db as never, input, scope({ channelId: null }))).toEqual({ available: false, reason: "channel_unsupported" });
    expect(h.loadSeatChoiceEnabled).not.toHaveBeenCalled();
  });

  it("salão nomeado que não existe na unidade → no_hall", async () => {
    const { db } = fakeDb(seed());
    expect(await getTableChoiceLink(db as never, { ...input, hall_name: "terraço" }, scope())).toEqual({ available: false, reason: "no_hall" });
  });

  it("sem mesa livre → no_capacity; entrada inválida → invalid_input", async () => {
    h.loadSeatMap.mockResolvedValue(seatMap({ free: false }));
    const { db } = fakeDb(seed());
    expect(await getTableChoiceLink(db as never, input, scope())).toEqual({ available: false, reason: "no_capacity" });
    expect(await getTableChoiceLink(db as never, { ...input, date: "2026-02-30" }, scope())).toEqual({ available: false, reason: "invalid_input" });
    expect(await getTableChoiceLink(db as never, { ...input, party_size: 0 }, scope())).toEqual({ available: false, reason: "invalid_input" });
  });
});

const base = {
  customer_name: "Ana",
  date: "2026-11-07",
  time: "20:00",
  party_size: 8,
  customer: { id: "cust-1", phone: "11999998888" },
  claimedIdentity: false,
  unit_id: UNIT,
  organization_id: "org-a",
  source: "whatsapp" as const,
};

describe("create_reservation com table_choice", () => {
  beforeEach(() => {
    h.resolveOrCreateCustomer.mockResolvedValue({ id: "cust-1" });
    h.reserveSlot.mockResolvedValue({ success: true, reservationCode: "ABC123", reservationId: "res-1" });
  });

  it("\"3+4+5\" reserva a combinação, no salão da unidade, com source whatsapp", async () => {
    const { db } = fakeDb(seed());
    const r = await createReservation(db as never, { ...base, table_choice: "3+4+5" });
    expect(r.success).toBe(true);
    expect(h.reserveSlot).toHaveBeenCalledTimes(1);
    expect(h.reserveSlot.mock.calls[0][1]).toMatchObject({
      unitId: UNIT, hallId: "hall-a", choice: { kind: "combination", id: "c345" }, source: "whatsapp", status: "confirmed",
    });
  });

  it("\"mesa 12\" reserva a mesa", async () => {
    const { db } = fakeDb(seed());
    await createReservation(db as never, { ...base, party_size: 4, table_choice: "mesa 12" });
    expect(h.reserveSlot.mock.calls[0][1].choice).toEqual({ kind: "table", id: "t12" });
  });

  it("procura a mesa só nos salões da unidade do turno", async () => {
    const { db } = fakeDb(seed());
    await createReservation(db as never, { ...base, table_choice: "12" });
    const halls = h.loadSeatMap.mock.calls.map((c) => c[1]);
    expect(halls).toEqual([expect.objectContaining({ unitId: UNIT, hallId: "hall-a" })]);
  });

  it("mesa de outra unidade com o mesmo número não é resolvida", async () => {
    // A unidade do turno não tem a mesa 12; o salão da outra unidade nunca é lido.
    h.loadSeatMap.mockImplementation(async (_db: unknown, a: { hallId: string }) =>
      a.hallId === "hall-a" ? { ...seatMap(), tables: seatMap().tables.filter((t) => t.number !== 12) } : seatMap({ hallId: a.hallId }));
    const { db } = fakeDb(seed());
    const r = await createReservation(db as never, { ...base, table_choice: "12" });
    expect(r).toMatchObject({ success: false, reason: "seat_unavailable" });
    expect(h.reserveSlot).not.toHaveBeenCalled();
    expect(h.loadSeatMap.mock.calls.every((c) => c[1].unitId === UNIT)).toBe(true);
  });

  it("mesa não reservável ou conjunto sem combinação → seat_unavailable com opções, sem criar cliente", async () => {
    const { db } = fakeDb(seed());
    for (const text of ["9", "3+4"]) {
      const r = await createReservation(db as never, { ...base, table_choice: text });
      expect(r).toMatchObject({ success: false, reason: "seat_unavailable", options: ["Mesa 3", "Mesa 12", "Mesas 3+4+5"] });
    }
    expect(h.resolveOrCreateCustomer).not.toHaveBeenCalled();
    expect(h.reserveSlot).not.toHaveBeenCalled();
  });

  it("salão nomeado que não resolve → hall_required, sem procurar em outro salão", async () => {
    const { db } = fakeDb(seed());
    const r = await createReservation(db as never, { ...base, hall_name: "terraço", table_choice: "12" });
    expect(r).toMatchObject({ success: false, reason: "hall_required" });
    expect(h.loadSeatMap).not.toHaveBeenCalled();
    expect(h.reserveSlot).not.toHaveBeenCalled();
  });

  it("texto sem número → seat_unavailable pedindo o número", async () => {
    const { db } = fakeDb(seed());
    const r = await createReservation(db as never, { ...base, table_choice: "mesa doze" });
    expect(r).toMatchObject({ success: false, reason: "seat_unavailable" });
    expect(h.loadSeatMap).not.toHaveBeenCalled();
  });

  it("mesa ocupada no instante da reserva → seat_unavailable com opções livres", async () => {
    h.reserveSlot.mockResolvedValue({ success: false, reason: "seat_unavailable", message: "x" });
    const { db } = fakeDb(seed());
    const r = await createReservation(db as never, { ...base, table_choice: "12" });
    expect(r).toMatchObject({ success: false, reason: "seat_unavailable", options: ["Mesa 3", "Mesa 12", "Mesas 3+4+5"] });
  });

  it("sem table_choice, a reserva segue igual (sem choice nem leitura do mapa)", async () => {
    const { db } = fakeDb(seed());
    await createReservation(db as never, { ...base });
    expect(h.loadSeatMap).not.toHaveBeenCalled();
    expect(h.reserveSlot.mock.calls[0][1]).not.toHaveProperty("choice");
  });
});

describe("ferramentas oferecidas", () => {
  const DISPATCH_MODULE = "../../supabase/functions/_shared/agent/tool-dispatch";
  type Mod = {
    agentToolsFor(ctx: object, opts?: { tableChoice?: boolean }): typeof agentTools;
    createToolDispatcher(a: Record<string, unknown>): (name: string, input: unknown) => Promise<string>;
  };
  const load = async () => (await import(/* @vite-ignore */ DISPATCH_MODULE)) as Mod;

  it("sem a escolha, a lista é exatamente a de antes", async () => {
    const { agentToolsFor } = await load();
    expect(agentToolsFor({})).toBe(agentTools);
    expect(agentToolsFor({}, { tableChoice: false })).toBe(agentTools);
  });

  it("com a escolha, table_choice em create_reservation e a ferramenta do link logo depois", async () => {
    const { agentToolsFor } = await load();
    const tools = agentToolsFor({}, { tableChoice: true });
    const names = tools.map((t) => t.name);
    expect(names.indexOf("get_table_choice_link")).toBe(names.indexOf("create_reservation") + 1);
    expect(tools.find((t) => t.name === "create_reservation")!.parameters.properties).toHaveProperty("table_choice");
    expect(agentTools.find((t) => t.name === "create_reservation")!.parameters.properties).not.toHaveProperty("table_choice");
    expect(tools.find((t) => t.name === "get_table_choice_link")).toBe(TABLE_CHOICE_LINK_TOOL);
  });

  const ctx = {
    channel: "whatsapp", unitId: UNIT, organizationId: "org-a", channelId: "chan-1",
    reservationSource: "whatsapp", appBaseUrl: () => "https://reservas.exemplo.com.br",
  };
  const state = () => ({ mutatingToolUsed: false, lastMutationOutcome: null, customer: { id: "cust-1", phone: "11999998888" } });

  it("o link não liga mutatingToolUsed; sem a escolha no turno é ferramenta desconhecida", async () => {
    const { createToolDispatcher } = await load();
    const { db } = fakeDb(seed());
    const st = state();
    const on = createToolDispatcher({ supabase: db, requestId: "r", ctx, conv: { id: "conv" }, state: st, tableChoice: true });
    expect(JSON.parse(await on("get_table_choice_link", input)).available).toBe(true);
    expect(st.mutatingToolUsed).toBe(false);
    const off = createToolDispatcher({ supabase: db, requestId: "r", ctx, conv: { id: "conv" }, state: state() });
    expect(JSON.parse(await off("get_table_choice_link", input)).error).toMatch(/desconhecida/);
  });

  it("table_choice só chega à reserva com a escolha oferecida no turno", async () => {
    h.resolveOrCreateCustomer.mockResolvedValue({ id: "cust-1" });
    h.reserveSlot.mockResolvedValue({ success: true, reservationCode: "ABC123", reservationId: "res-1" });
    const { createToolDispatcher } = await load();
    const { db } = fakeDb(seed());
    const off = createToolDispatcher({ supabase: db, requestId: "r", ctx, conv: { id: "conv" }, state: state() });
    await off("create_reservation", { customer_name: "Ana", date: "2026-11-07", time: "20:00", party_size: 4, table_choice: "12" });
    expect(h.reserveSlot.mock.calls[0][1]).not.toHaveProperty("choice");
    const on = createToolDispatcher({ supabase: db, requestId: "r", ctx, conv: { id: "conv" }, state: state(), tableChoice: true });
    await on("create_reservation", { customer_name: "Ana", date: "2026-11-07", time: "20:00", party_size: 4, table_choice: "12" });
    expect(h.reserveSlot.mock.calls[1][1].choice).toEqual({ kind: "table", id: "t12" });
  });
});
