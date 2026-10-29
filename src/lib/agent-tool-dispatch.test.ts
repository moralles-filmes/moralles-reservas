import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentCustomer,
  ChannelContext,
  ClaimedIdentityPort,
  LinkPhoneResult,
} from "../../supabase/functions/_shared/agent/channel-context";
import { agentTools } from "../../supabase/functions/_shared/agent/tools";

/**
 * Despacho das ferramentas do agente (`_shared/agent/tool-dispatch.ts`, Task 3.4).
 *
 * O canal de identidade DECLARADA (Instagram: telefone digitado no Direct) entra
 * pela porta `ClaimedIdentityPort`; aqui ela é falsa. O client falso guarda uma
 * tabela `reservations` em memória e aplica os filtros `eq`/`in`/`gte` de verdade,
 * então "fora do ledger não escreve" é medido pela linha que mudou, não pela
 * presença de um filtro na lista.
 */

// O motor de disponibilidade e o resolvedor de cliente ficam fora: o despacho
// é o que se testa, e a cadeia `reserveSlot` tem teste próprio.
const h = vi.hoisted(() => ({
  resolveOrCreateCustomer: vi.fn(),
  reserveSlot: vi.fn(),
  checkAvailability: vi.fn(),
}));
vi.mock("../../supabase/functions/_shared/resolve-customer", () => ({
  resolveOrCreateCustomer: h.resolveOrCreateCustomer,
}));
vi.mock("../../supabase/functions/_shared/availability", () => ({
  reserveSlot: h.reserveSlot,
  checkAvailability: h.checkAvailability,
}));

// Import dinâmico com caminho em variável: o grafo de `tool-dispatch.ts` inclui
// `security.ts` (usa `Deno`), que o `tsc -b` do front não deve tipar.
const DISPATCH_MODULE = "../../supabase/functions/_shared/agent/tool-dispatch";
type DispatchState = { mutatingToolUsed: boolean; lastMutationOutcome: string | null; customer: AgentCustomer | null };
type DispatchModule = {
  agentToolsFor(ctx: { claimedIdentity?: ClaimedIdentityPort }): typeof agentTools;
  createToolDispatcher(a: {
    supabase: unknown; requestId: string; ctx: ChannelContext; conv: ChannelContext["conversation"]; state: DispatchState;
  }): (name: string, input: unknown) => Promise<string>;
  NEED_PHONE_RESULT: Record<string, unknown>;
};
const load = async () => (await import(/* @vite-ignore */ DISPATCH_MODULE)) as DispatchModule;

type Row = Record<string, unknown>;
type Call = [string, ...unknown[]];

/** Client falso: `reservations` em memória com filtros reais; o resto vazio. */
function fakeDb(rows: Row[] = []) {
  const calls: Call[] = [];
  const db = {
    from(table: string) {
      calls.push(["from", table]);
      const filters: Array<(r: Row) => boolean> = [];
      let patch: Row | null = null;
      let limit = Infinity;
      const builder: Record<string, unknown> = {};
      const chain = (name: string, fn?: (...a: unknown[]) => void) => {
        builder[name] = (...args: unknown[]) => { calls.push([name, ...args]); fn?.(...args); return builder; };
      };
      chain("select");
      chain("order");
      chain("limit", (n) => { limit = n as number; });
      chain("eq", (col, val) => filters.push((r) => r[col as string] === val));
      chain("in", (col, vals) => filters.push((r) => (vals as unknown[]).includes(r[col as string])));
      chain("gte", (col, val) => filters.push((r) => String(r[col as string]) >= String(val)));
      chain("update", (p) => { patch = p as Row; });
      const run = () => {
        if (table !== "reservations") return [] as Row[];
        const hit = rows.filter((r) => filters.every((f) => f(r))).slice(0, limit);
        if (patch) for (const r of hit) Object.assign(r, patch);
        return hit;
      };
      builder.maybeSingle = async () => { calls.push(["maybeSingle"]); const hit = run(); return { data: hit[0] ?? null, error: null }; };
      builder.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
        Promise.resolve({ data: run(), error: null }).then(ok, ko);
      return builder;
    },
  };
  return { db, calls, rows };
}

function fakePort(opts: { ledger?: string[]; link?: LinkPhoneResult; recordFails?: boolean } = {}) {
  const ledger = [...(opts.ledger ?? [])];
  const seen = { reads: 0, recorded: [] as string[], links: [] as unknown[] };
  const port: ClaimedIdentityPort = {
    reservationIds: async () => { seen.reads += 1; return [...ledger]; },
    recordReservation: async (id: string) => {
      if (opts.recordFails) throw new Error("ledger indisponível");
      seen.recorded.push(id);
      ledger.push(id);
    },
    linkPhone: async (input) => { seen.links.push(input); return opts.link ?? { ok: false, reason: "unavailable" }; },
  };
  return { port, seen };
}

const LINKED: AgentCustomer = { id: "cust-ligado", phone: "11988887777", name: "Fulana Cadastrada", allergies: "ALERGIA_PRIVADA" };

function makeCtx(over: Partial<ChannelContext> = {}): ChannelContext {
  return {
    channel: "instagram", unitId: "unit-a", organizationId: "org-a",
    unit: { row: null, name: "Exemplo", slug: null, address: "", ticketMax: null },
    conversation: { id: "conv-1", messages: [], status: "ai_active" },
    customer: null, phone: null,
    identityLine: "ID.", formattingRules: "F", channelLabel: "Instagram", channelRules: "",
    sanitize: (t) => t, send: async () => ({ ok: true }),
    reservationSource: "instagram", appBaseUrl: () => "https://exemplo.invalid", channelId: null,
    ...over,
  };
}

async function setup(opts: { ctx?: Partial<ChannelContext>; rows?: Row[]; port?: ReturnType<typeof fakePort> | null } = {}) {
  const { createToolDispatcher } = await load();
  const { db, calls, rows } = fakeDb(opts.rows);
  const port = opts.port === undefined ? fakePort() : opts.port;
  const ctx = makeCtx({ claimedIdentity: port?.port, ...opts.ctx });
  const state: DispatchState = { mutatingToolUsed: false, lastMutationOutcome: null, customer: ctx.customer };
  const dispatch = createToolDispatcher({ supabase: db, requestId: "req-1", ctx, conv: ctx.conversation, state });
  const call = async (name: string, input: unknown = {}) => JSON.parse(await dispatch(name, input));
  return { call, calls, rows, state, port, ctx };
}

const reservation = (id: string, code: string, over: Row = {}): Row => ({
  id, reservation_code: code, unit_id: "unit-a", customer_id: LINKED.id, status: "confirmed",
  date: "2099-01-10", time: "20:00:00", party_size: 2, notes: "ALERGIA NA RESERVA", created_at: "2026-10-01T00:00:00Z", ...over,
});

let logs: string[] = [];
beforeEach(() => {
  logs = [];
  const capture = (line: unknown) => { logs.push(String(line)); };
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "warn").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
  h.resolveOrCreateCustomer.mockReset();
  h.reserveSlot.mockReset();
  h.checkAvailability.mockReset();
});
afterEach(() => { vi.restoreAllMocks(); });

describe("agentToolsFor", () => {
  it("sem porta é exatamente agentTools", async () => {
    const { agentToolsFor } = await load();
    expect(agentToolsFor({})).toEqual(agentTools);
    expect(agentToolsFor({}).map((t) => t.name)).not.toContain("link_customer_phone");
  });

  it("com porta termina em link_customer_phone { phone, name }, ambos obrigatórios, sem mexer em agentTools", async () => {
    const { agentToolsFor } = await load();
    const before = JSON.stringify(agentTools);
    const tools = agentToolsFor({ claimedIdentity: fakePort().port });
    expect(tools.slice(0, -1)).toEqual(agentTools);
    const link = tools[tools.length - 1];
    expect(link.name).toBe("link_customer_phone");
    expect(link.parameters).toEqual({
      type: "object",
      properties: {
        phone: { type: "string", description: "WhatsApp do cliente com DDD" },
        name: { type: "string", description: "Nome do cliente" },
      },
      required: ["phone", "name"],
    });
    expect(JSON.stringify(agentTools)).toBe(before);
  });
});

describe("cliente nulo (identidade declarada sem telefone)", () => {
  const TOOLS: Array<[string, Record<string, unknown>]> = [
    ["create_reservation", { customer_name: "Ana", date: "2099-01-10", time: "20:00", party_size: 2 }],
    ["get_reservation", { reservation_code: "ABCD2345" }],
    ["update_reservation", { reservation_code: "ABCD2345", party_size: 3 }],
    ["cancel_reservation", { reservation_code: "ABCD2345" }],
    ["list_customer_reservations", {}],
  ];
  for (const [name, input] of TOOLS) {
    it(`${name} devolve need_phone sem I/O e sem ligar mutatingToolUsed`, async () => {
      const { NEED_PHONE_RESULT } = await load();
      const { call, calls, state, port } = await setup();
      expect(await call(name, input)).toEqual(NEED_PHONE_RESULT);
      expect(calls).toEqual([]);
      expect(port!.seen.reads).toBe(0);
      expect(h.resolveOrCreateCustomer).not.toHaveBeenCalled();
      expect(h.reserveSlot).not.toHaveBeenCalled();
      expect(state.mutatingToolUsed).toBe(false);
      expect(state.lastMutationOutcome).toBeNull();
    });
  }

  it("need_phone tem o texto exato do contrato", async () => {
    const { NEED_PHONE_RESULT } = await load();
    expect(NEED_PHONE_RESULT).toEqual({
      success: false, found: false, reason: "need_phone",
      message: "Antes de reservar ou consultar, peça o número de WhatsApp do cliente (com DDD) e registre com link_customer_phone.",
    });
  });
});

describe("link_customer_phone", () => {
  it("válido seguido de create_reservation reserva para o cliente ligado e registra no ledger", async () => {
    const port = fakePort({ link: { ok: true, customer: LINKED } });
    const { call, state } = await setup({ port });
    h.resolveOrCreateCustomer.mockResolvedValue({ id: LINKED.id, name: "Fulana Cadastrada", phone: LINKED.phone });
    h.reserveSlot.mockResolvedValue({ success: true, reservationId: "res-nova", reservationCode: "NOVA2345" });

    expect(await call("link_customer_phone", { phone: "(11) 98888-7777", name: "Ana" })).toEqual({ success: true, message: "Número registrado." });
    expect(port.seen.links).toEqual([{ phone: "(11) 98888-7777", name: "Ana" }]);
    expect(state.customer).toEqual(LINKED);
    expect(state.mutatingToolUsed, "link_customer_phone é idempotente e não desliga o retry").toBe(false);

    const out = await call("create_reservation", { customer_name: "Ana", date: "2099-01-10", time: "20:00", party_size: 2 });
    expect(h.resolveOrCreateCustomer).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ organizationId: "org-a", phone: LINKED.phone, name: "Ana" }));
    expect(h.reserveSlot).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ unitId: "unit-a", customerId: LINKED.id, source: "instagram" }));
    expect(port.seen.recorded).toEqual(["res-nova"]);
    expect(out).toMatchObject({ success: true, reservation_code: "NOVA2345" });
    const json = JSON.stringify(out);
    expect(json, "o id interno da reserva chegou ao LLM").not.toContain("res-nova");
    expect(json).not.toContain("reservationId");
    expect(json, "o nome gravado no cadastro chegou ao LLM").not.toContain("Fulana");
    expect(state.mutatingToolUsed).toBe(true);
    expect(state.lastMutationOutcome).toBe("COMPLETED");
  });

  it("invalid_phone devolve a orientação do contrato e não muda o cliente", async () => {
    const { call, state } = await setup({ port: fakePort({ link: { ok: false, reason: "invalid_phone" } }) });
    expect(await call("link_customer_phone", { phone: "123", name: "Ana" })).toEqual({
      success: false, reason: "invalid_phone", message: "O número parece incompleto. Peça o WhatsApp com DDD.",
    });
    expect(state.customer).toBeNull();
    expect(state.mutatingToolUsed).toBe(false);
  });

  it("sem porta a ferramenta não existe", async () => {
    const { call, state } = await setup({ port: null, ctx: { channel: "whatsapp", customer: LINKED, phone: LINKED.phone, reservationSource: "whatsapp" } });
    expect(await call("link_customer_phone", { phone: "11977776666", name: "X" })).toEqual({ error: "Tool desconhecida: link_customer_phone" });
    expect(state.customer).toEqual(LINKED);
  });

  it("a reserva criada no turno fica visível às ferramentas seguintes do mesmo turno; o ledger é lido uma vez", async () => {
    const port = fakePort({ ledger: [], link: { ok: true, customer: LINKED } });
    const rows: Row[] = [];
    const { call } = await setup({ port, rows });
    await call("link_customer_phone", { phone: LINKED.phone, name: "Ana" });
    expect(await call("get_reservation", { reservation_code: "NOVA2345" })).toMatchObject({ found: false });
    h.resolveOrCreateCustomer.mockResolvedValue({ id: LINKED.id, phone: LINKED.phone });
    h.reserveSlot.mockImplementation(async () => {
      rows.push(reservation("res-nova", "NOVA2345"));
      return { success: true, reservationId: "res-nova", reservationCode: "NOVA2345" };
    });
    await call("create_reservation", { customer_name: "Ana", date: "2099-01-10", time: "20:00", party_size: 2 });
    expect(await call("get_reservation", { reservation_code: "NOVA2345" })).toMatchObject({ found: true, reservation_code: "NOVA2345" });
    expect(port.seen.reads, "reservationIds() relido no mesmo turno").toBe(1);
  });

  it("falha ao registrar no ledger só vai ao log e não abre a reserva no turno", async () => {
    const port = fakePort({ ledger: [], link: { ok: true, customer: LINKED }, recordFails: true });
    const rows: Row[] = [];
    const { call } = await setup({ port, rows });
    await call("link_customer_phone", { phone: LINKED.phone, name: "Ana" });
    h.resolveOrCreateCustomer.mockResolvedValue({ id: LINKED.id, phone: LINKED.phone });
    h.reserveSlot.mockImplementation(async () => {
      rows.push(reservation("res-nova", "NOVA2345"));
      return { success: true, reservationId: "res-nova", reservationCode: "NOVA2345" };
    });
    const out = await call("create_reservation", { customer_name: "Ana", date: "2099-01-10", time: "20:00", party_size: 2 });
    expect(out).toMatchObject({ success: true, reservation_code: "NOVA2345" });
    expect(logs.some((l) => l.includes('"evt":"agent_reservation_ledger_record_failed"'))).toBe(true);
    expect(await call("get_reservation", { reservation_code: "NOVA2345" })).toMatchObject({ found: false });
  });
});

describe("identidade declarada só alcança reservas do ledger", () => {
  // Duas reservas ativas do MESMO cliente na mesma unidade: só uma foi feita por
  // este contato do Instagram.
  const rowsDoTelefone = () => [reservation("res-1", "LEDG2345"), reservation("res-2", "FORA2345")];
  const linked = () => ({ customer: LINKED, phone: LINKED.phone });

  it("get_reservation com código do cliente fora do ledger dá não encontrada, com o filtro de ids", async () => {
    const { call, calls } = await setup({ ctx: linked(), rows: rowsDoTelefone(), port: fakePort({ ledger: ["res-1"] }) });
    expect(await call("get_reservation", { reservation_code: "FORA2345" })).toEqual({ found: false, message: "Reserva não encontrada ou já cancelada." });
    expect(calls).toContainEqual(["in", "id", ["res-1"]]);
    expect(calls).toContainEqual(["eq", "unit_id", "unit-a"]);
    expect(calls).toContainEqual(["eq", "customer_id", LINKED.id]);
    expect(await call("get_reservation", { reservation_code: "LEDG2345" })).toMatchObject({ found: true, reservation_code: "LEDG2345" });
  });

  it("list_customer_reservations filtra pelos ids do ledger", async () => {
    const { call, calls } = await setup({ ctx: linked(), rows: rowsDoTelefone(), port: fakePort({ ledger: ["res-1"] }) });
    const out = await call("list_customer_reservations");
    expect(calls).toContainEqual(["in", "id", ["res-1"]]);
    expect(out.reservations.map((r: Row) => r.reservation_code)).toEqual(["LEDG2345"]);
  });

  it("cancel_reservation fora do ledger não escreve", async () => {
    const { call, rows } = await setup({ ctx: linked(), rows: rowsDoTelefone(), port: fakePort({ ledger: ["res-1"] }) });
    expect(await call("cancel_reservation", { reservation_code: "FORA2345" })).toEqual({ success: false, error: "Reserva não encontrada ou já cancelada." });
    expect(rows.find((r) => r.id === "res-2")?.status, "a reserva fora do ledger foi cancelada").toBe("confirmed");
  });

  it("update_reservation fora do ledger não escreve", async () => {
    const { call, rows } = await setup({ ctx: linked(), rows: rowsDoTelefone(), port: fakePort({ ledger: ["res-1"] }) });
    const out = await call("update_reservation", { reservation_code: "FORA2345", notes: "x" });
    expect(out).toEqual({ success: false, error: "Reserva não encontrada ou já cancelada." });
    expect(rows.find((r) => r.id === "res-2")?.notes).toBe("ALERGIA NA RESERVA");
  });

  it("ledger vazio: não encontrada sem nenhuma consulta", async () => {
    const { call, calls } = await setup({ ctx: linked(), rows: rowsDoTelefone(), port: fakePort({ ledger: [] }) });
    expect(await call("get_reservation", {})).toMatchObject({ found: false });
    expect(await call("list_customer_reservations")).toMatchObject({ found: false });
    expect(await call("cancel_reservation", { reservation_code: "LEDG2345" })).toMatchObject({ success: false });
    expect(await call("update_reservation", { reservation_code: "LEDG2345", party_size: 3 })).toMatchObject({ success: false });
    expect(calls).toEqual([]);
  });

  it("com porta, as leituras devolvidas ao LLM não trazem notes da reserva", async () => {
    const { call } = await setup({ ctx: linked(), rows: rowsDoTelefone(), port: fakePort({ ledger: ["res-1"] }) });
    const get = await call("get_reservation", { reservation_code: "LEDG2345" });
    expect(get.found).toBe(true);
    expect(get).not.toHaveProperty("notes");
    const list = await call("list_customer_reservations");
    expect(list.reservations[0]).not.toHaveProperty("notes");
    const upd = await call("update_reservation", { reservation_code: "LEDG2345", notes: "y" });
    const cancel = await call("cancel_reservation", { reservation_code: "LEDG2345" });
    for (const out of [get, list, upd, cancel]) {
      const json = JSON.stringify(out);
      for (const privado of ["ALERGIA", "Fulana", "notes", "allergies", "cust-ligado", "res-1"]) {
        expect(json, `vazou "${privado}"`).not.toContain(privado);
      }
    }
  });

  it("controle: sem porta (WhatsApp) as leituras continuam com notes e sem filtro de ids", async () => {
    const { call, calls } = await setup({
      port: null, rows: rowsDoTelefone(),
      ctx: { channel: "whatsapp", customer: LINKED, phone: LINKED.phone, reservationSource: "whatsapp" },
    });
    expect(await call("get_reservation", { reservation_code: "FORA2345" })).toMatchObject({ found: true, notes: "ALERGIA NA RESERVA" });
    expect(calls.some((c) => c[0] === "in" && c[1] === "id")).toBe(false);
  });
});

describe("create_reservation", () => {
  it("identidade divergente dá erro genérico, sem reserveSlot e sem ledger", async () => {
    const port = fakePort();
    const { call, state } = await setup({ ctx: { customer: LINKED, phone: LINKED.phone }, port });
    h.resolveOrCreateCustomer.mockResolvedValue({ id: "outro-cliente", phone: LINKED.phone });
    const out = await call("create_reservation", { customer_name: "Ana", date: "2099-01-10", time: "20:00", party_size: 2 });
    expect(out).toEqual({ success: false, error: "Não foi possível registrar a reserva agora. Tente novamente em instantes." });
    expect(h.reserveSlot).not.toHaveBeenCalled();
    expect(port.seen.recorded).toEqual([]);
    expect(logs.some((l) => l.includes('"evt":"agent_customer_identity_mismatch"'))).toBe(true);
    expect(JSON.stringify(logs)).not.toContain(LINKED.phone);
    expect(state.mutatingToolUsed).toBe(true);
    expect(state.lastMutationOutcome).toBe("UNKNOWN");
  });

  it("sem porta (WhatsApp) não chama ledger e a origem é a do canal", async () => {
    const { call } = await setup({ port: null, ctx: { channel: "whatsapp", customer: LINKED, phone: LINKED.phone, reservationSource: "whatsapp" } });
    h.resolveOrCreateCustomer.mockResolvedValue({ id: LINKED.id, phone: LINKED.phone });
    h.reserveSlot.mockResolvedValue({ success: true, reservationId: "res-wa", reservationCode: "WAWA2345" });
    const out = await call("create_reservation", { customer_name: "Ana", date: "2099-01-10", time: "20:00", party_size: 2 });
    expect(h.reserveSlot).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ source: "whatsapp", customerId: LINKED.id }));
    expect(out).toEqual({ success: true, reservation_code: "WAWA2345", message: "Reserva criada! Código: #WAWA2345. Data: 10/01/2099 às 20:00 para 2 pessoas." });
  });
});
