// @vitest-environment node
/**
 * Cobertura COMPORTAMENTAL de `hasUnitAccess()` — complementa
 * `authz-ef-guard.test.ts`, que só prova que o padrão RPC não volta e que as
 * 4 Edge Functions importam o helper. Nenhum dos dois testes ali afirma que
 * o helper CONCEDE ou NEGA acesso corretamente — um `||` invertido, um
 * `membro`/`admin` trocado, um `Boolean()` esquecido ou o nome errado de
 * coluna passariam por tsc, eslint e pelo guardrail sem serem notados, e
 * mudariam silenciosamente quem recebe 403 em todo path de escrita
 * unit-scoped do sistema (loja real em produção).
 *
 * `authz.ts` importa `SupabaseClient` só com `import type` — apagado na
 * compilação — então, ao contrário dos `index.ts` de Edge Function (que
 * chamam `serve()` no carregamento e importam `deno.land`/`esm.sh` em
 * runtime), o módulo não tem nenhum import Deno-only em tempo de execução e
 * o vitest importa `hasUnitAccess` direto daqui.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { hasUnitAccess } from "../../supabase/functions/_shared/authz.ts";

interface ReadResult {
  data: { user_id: string } | null;
  error: { message: string } | null;
}

interface RecordedCall {
  table: string;
  select: string;
  eqCalls: Array<[string, unknown]>;
}

/**
 * SDK real com transporte fechado: avalia o Request PostgREST produzido pelo
 * helper e devolve apenas linhas/erros sintéticos. Nenhuma rede é acessada.
 */
function stubSupabase(responses: { unit_members: ReadResult; platform_admins: ReadResult }) {
  const calls: RecordedCall[] = [];

  const supabase = createClient("https://authz.fixture.invalid", "synthetic-anon", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      const request = new Request(input, init), url = new URL(request.url);
      const table = url.pathname.slice("/rest/v1/".length);
      if (url.origin !== "https://authz.fixture.invalid" || request.method !== "GET"
        || !url.pathname.startsWith("/rest/v1/") || (table !== "unit_members" && table !== "platform_admins")) {
        throw new Error("unexpected_authz_transport");
      }
      const record: RecordedCall = { table, select: url.searchParams.get("select") ?? "", eqCalls: [] };
      for (const [column, value] of url.searchParams) {
        if (column === "select") continue;
        if (!["user_id", "unit_id"].includes(column) || !value.startsWith("eq.")) throw new Error("unexpected_authz_filter");
        record.eqCalls.push([column, value.slice(3)]);
      }
      calls.push(record);
      const result = responses[table];
      return new Response(JSON.stringify(result.error
        ? { code: "XX000", message: result.error.message, details: null, hint: null }
        : result.data ? [result.data] : []), {
        status: result.error ? 500 : 200, headers: { "content-type": "application/json" },
      });
    } },
  });

  return { supabase, calls };
}

const okRow: ReadResult = { data: { user_id: "user-1" }, error: null };
const okEmpty: ReadResult = { data: null, error: null };
const dbError = (message: string): ReadResult => ({ data: null, error: { message } });

describe("hasUnitAccess", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("1. membro da unit, não platform_admin → true", async () => {
    const { supabase } = stubSupabase({ unit_members: okRow, platform_admins: okEmpty });
    await expect(hasUnitAccess(supabase, "user-1", "unit-1")).resolves.toBe(true);
  });

  it("2. platform_admin, não membro da unit → true", async () => {
    const { supabase } = stubSupabase({ unit_members: okEmpty, platform_admins: okRow });
    await expect(hasUnitAccess(supabase, "user-1", "unit-1")).resolves.toBe(true);
  });

  it("3. membro E platform_admin → true", async () => {
    const { supabase } = stubSupabase({ unit_members: okRow, platform_admins: okRow });
    await expect(hasUnitAccess(supabase, "user-1", "unit-1")).resolves.toBe(true);
  });

  it("4. nem membro nem platform_admin → false", async () => {
    const { supabase } = stubSupabase({ unit_members: okEmpty, platform_admins: okEmpty });
    await expect(hasUnitAccess(supabase, "user-1", "unit-1")).resolves.toBe(false);
  });

  it("5. erro de leitura em unit_members, sem linha de admin → false (fail-closed) e loga authz_member_read_error", async () => {
    const { supabase } = stubSupabase({
      unit_members: dbError("connection reset"),
      platform_admins: okEmpty,
    });
    await expect(hasUnitAccess(supabase, "user-1", "unit-1")).resolves.toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(consoleErrorSpy.mock.calls[0][0] as string);
    expect(logged).toEqual({ evt: "authz_member_read_error", message: "connection reset" });
  });

  it("6. erro de leitura em platform_admins, sem linha de membro → false (fail-closed) e loga authz_admin_read_error", async () => {
    const { supabase } = stubSupabase({
      unit_members: okEmpty,
      platform_admins: dbError("timeout"),
    });
    await expect(hasUnitAccess(supabase, "user-1", "unit-1")).resolves.toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(consoleErrorSpy.mock.calls[0][0] as string);
    expect(logged).toEqual({ evt: "authz_admin_read_error", message: "timeout" });
  });

  it("7. AMBAS as leituras erram → false, nunca lança (contrato fail-closed)", async () => {
    const { supabase } = stubSupabase({
      unit_members: dbError("boom member"),
      platform_admins: dbError("boom admin"),
    });
    await expect(hasUnitAccess(supabase, "user-1", "unit-1")).resolves.toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(2);
  });

  it("endereça as leituras às tabelas certas, carregando userId/unitId corretos", async () => {
    const { supabase, calls } = stubSupabase({ unit_members: okEmpty, platform_admins: okEmpty });
    await hasUnitAccess(supabase, "user-42", "unit-99");

    const membroCall = calls.find((c) => c.table === "unit_members");
    const adminCall = calls.find((c) => c.table === "platform_admins");
    expect(calls).toHaveLength(2);
    expect(calls.every(call => call.select === "user_id")).toBe(true);

    expect(membroCall?.eqCalls).toEqual([
      ["user_id", "user-42"],
      ["unit_id", "unit-99"],
    ]);
    expect(adminCall?.eqCalls).toEqual([["user_id", "user-42"]]);
  });
});
