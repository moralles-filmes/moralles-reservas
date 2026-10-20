import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReservation, listCustomerReservations } from "../../supabase/functions/_shared/agent/tools";

// O que as ferramentas do agente devolvem chega ao LLM e, parafraseado, ao
// cliente: erro de banco vira frase fixa (o detalhe fica no log pelo `code`), e
// falha de leitura nunca se passa por resposta definitiva.

const PG_ERROR = { code: "XX000", message: "connection to db.synthetic.supabase.co failed: password authentication failed" };

type Call = [string, ...unknown[]];

function fakeDb(result: { data: unknown; error: unknown }) {
  const calls: Call[] = [];
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "gte", "order", "limit"]) {
    builder[method] = (...args: unknown[]) => { calls.push([method, ...args]); return builder; };
  }
  builder.maybeSingle = () => Promise.resolve(result);
  builder.then = (ok: (v: unknown) => unknown) => ok(result);
  return { db: { from: (table: string) => { calls.push(["from", table]); return builder; } }, calls };
}

function captureConsoleError() {
  const lines: string[] = [];
  vi.spyOn(console, "error").mockImplementation((line: unknown) => { lines.push(String(line)); });
  return lines;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("create_reservation: falha ao resolver o cliente", () => {
  it("devolve frase fixa ao LLM, sem o texto do PostgREST", async () => {
    const logged = captureConsoleError();
    const { db } = fakeDb({ data: null, error: PG_ERROR });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await createReservation(db as any, {
      date: "2030-03-15", time: "20:00", party_size: 2, customer_name: "Ana",
      phone: "11988887777", unit_id: "unit-a", organization_id: "org-a", source: "whatsapp",
    });
    expect(out).toEqual({ success: false, error: "Não foi possível registrar a reserva agora. Tente novamente em instantes." });
    expect(JSON.stringify(out)).not.toContain("password");
    expect(logged).toEqual([JSON.stringify({ evt: "agent_resolve_customer_failed", code: "XX000" })]);
  });
});

describe("list_customer_reservations", () => {
  it("erro de leitura não vira 'você não tem reservas'", async () => {
    const logged = captureConsoleError();
    const { db } = fakeDb({ data: null, error: PG_ERROR });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await listCustomerReservations(db as any, "cust-1", "unit-a");
    expect(out).toEqual({
      found: false,
      error: "unavailable",
      message: "Não consegui consultar suas reservas agora. Tente novamente em instantes.",
    });
    expect(logged).toEqual([JSON.stringify({ evt: "agent_list_reservations_failed", code: "XX000" })]);
  });

  it("sem reservas continua respondendo que não há reservas ativas", async () => {
    const { db } = fakeDb({ data: [], error: null });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await listCustomerReservations(db as any, "cust-1", "unit-a");
    expect(out).toEqual({ found: false, message: "Você não tem reservas ativas no momento." });
  });

  it("às 22h30 BRT o corte é o dia de hoje em BRT, não o dia UTC seguinte", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-24T01:30:00Z")); // 23/10 22:30 BRT
    const { db, calls } = fakeDb({ data: [], error: null });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await listCustomerReservations(db as any, "cust-1", "unit-a");
    expect(calls).toContainEqual(["gte", "date", "2026-10-23"]);
    expect(calls).toContainEqual(["eq", "customer_id", "cust-1"]);
    expect(calls).toContainEqual(["eq", "unit_id", "unit-a"]);
  });
});

describe("despacho de ferramentas no turno", () => {
  const turn = readFileSync(resolve(__dirname, "../..", "supabase/functions/_shared/agent/turn.ts"), "utf8").replace(/\r\n/g, "\n");

  it("o catch do onToolCall loga o erro e devolve ao LLM só uma frase fixa", () => {
    const at = turn.indexOf('evt: "tool_error"');
    expect(at).toBeGreaterThan(0);
    const tail = turn.slice(at, turn.indexOf("\n          }", at));
    const returned = tail.slice(tail.indexOf("return JSON.stringify("));
    expect(returned).toContain('return JSON.stringify({ error: "Não foi possível concluir esta ação agora. Tente novamente em instantes." });');
    expect(returned).not.toMatch(/\berr\b/);
  });
});
