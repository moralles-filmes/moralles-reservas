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
      customer: { id: "cust-1", phone: "11988887777" }, claimedIdentity: false, unit_id: "unit-a", organization_id: "org-a", source: "whatsapp",
    });
    expect(out).toEqual({ success: false, error: "Não foi possível registrar a reserva agora. Tente novamente em instantes." });
    expect(JSON.stringify(out)).not.toContain("password");
    // A busca do reenvio (F-002B) também falha neste banco falso: loga só o code e segue.
    expect(logged).toEqual([
      JSON.stringify({ evt: "reservation_replay_lookup_failed", code: "XX000" }),
      JSON.stringify({ evt: "agent_resolve_customer_failed", code: "XX000" }),
    ]);
    expect(logged.join(" ")).not.toContain("password");
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

describe("despacho de ferramentas", () => {
  // O `switch` e o seu catch saíram do `onToolCall` do `turn.ts` para
  // `tool-dispatch.ts` (Task 3.4); o turno só delega.
  const dispatch = readFileSync(resolve(__dirname, "../..", "supabase/functions/_shared/agent/tool-dispatch.ts"), "utf8").replace(/\r\n/g, "\n");

  it("o catch do despacho loga o erro e devolve ao LLM só uma frase fixa", () => {
    const at = dispatch.indexOf('evt: "tool_error"');
    expect(at).toBeGreaterThan(0);
    const tail = dispatch.slice(at, dispatch.indexOf("\n    }", at));
    const returned = tail.slice(tail.indexOf("return JSON.stringify("));
    expect(returned).toContain('return JSON.stringify({ error: "Não foi possível concluir esta ação agora. Tente novamente em instantes." });');
    expect(returned).not.toMatch(/\berr\b/);
  });
});

describe("núcleo do agente: logs de claim/CAS e ferramenta sem porta (Task 4.0a)", () => {
  const read = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8").replace(/\r\n/g, "\n");
  const turn = read("supabase/functions/_shared/agent/turn.ts");
  const dispatch = read("supabase/functions/_shared/agent/tool-dispatch.ts");

  it("logs do CAS do handoff e do claim da conversa gravam só a classe e o code, nunca a mensagem do erro", () => {
    for (const evt of [
      "handoff_auto_resolve_failed",
      "handoff_reminder_claim_failed",
      "handoff_reminder_revert_failed",
      "ai_lock_claim_failed",
    ]) {
      const lines = turn.split("\n").filter((l) => l.includes(`evt: "${evt}"`));
      expect(lines.length, evt).toBeGreaterThan(0);
      for (const l of lines) {
        expect(l, evt).toContain("...errorLogFields(");
        expect(l, evt).not.toMatch(/err: |\.message/);
      }
    }
    const helper = turn.slice(turn.indexOf("function errorLogFields"), turn.indexOf("function errorLogFields") + 400);
    expect(helper).toContain("errorClass");
    expect(helper).toContain("code");
    expect(helper).not.toContain("message");
  });

  it("link_customer_phone sem porta não tem ramo próprio: cai no default do despacho", () => {
    const at = dispatch.indexOf('case "link_customer_phone":');
    const body = dispatch.slice(at, dispatch.indexOf("default:", at));
    expect(body).toContain("if (port) {");
    expect(body).not.toContain("Tool desconhecida");
    // O último `break` do ramo fica dentro do `if (port)`: sem porta o fluxo cai no default.
    expect(body.trimEnd().endsWith("break;\n            }")).toBe(true);
  });
});
