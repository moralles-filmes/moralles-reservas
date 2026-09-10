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
 * Stub mínimo do client Supabase: só o suficiente pra sustentar a cadeia
 * `.from(table).select(cols).eq(col, val)[.eq(col, val)].maybeSingle()` que
 * `hasUnitAccess` usa, gravando cada chamada pra inspeção posterior.
 */
function stubSupabase(responses: { unit_members: ReadResult; platform_admins: ReadResult }) {
  const calls: RecordedCall[] = [];

  function builderFor(table: "unit_members" | "platform_admins") {
    const record: RecordedCall = { table, select: "", eqCalls: [] };
    calls.push(record);
    const builder = {
      select(cols: string) {
        record.select = cols;
        return builder;
      },
      eq(col: string, val: unknown) {
        record.eqCalls.push([col, val]);
        return builder;
      },
      maybeSingle() {
        return Promise.resolve(responses[table]);
      },
    };
    return builder;
  }

  const supabase = {
    from(table: string) {
      return builderFor(table as "unit_members" | "platform_admins");
    },
  };

  return { supabase: supabase as unknown as Parameters<typeof hasUnitAccess>[0], calls };
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

    expect(membroCall?.eqCalls).toEqual([
      ["user_id", "user-42"],
      ["unit_id", "unit-99"],
    ]);
    expect(adminCall?.eqCalls).toEqual([["user_id", "user-42"]]);
  });
});
