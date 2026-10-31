import { beforeEach, describe, expect, it, vi } from "vitest";
import { FunctionsHttpError } from "@supabase/supabase-js";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
}));

vi.mock("@/lib/supabase", () => ({
  supabase: { functions: { invoke: mocks.invoke }, rpc: mocks.rpc, from: mocks.from },
}));

import {
  connectCallback,
  connectStart,
  disconnectInstagram,
  readInstagramAccount,
  readInstagramDiagnostics,
  readInstagramSettings,
  readUnitModules,
  resubscribeInstagram,
  setUnitModule,
  updateInstagramDm,
} from "./api";
import { instagramKeys } from "./types";

const UNIT = "unit-1";

/** Builder encadeável e "thenable" que registra cada chamada. */
function chain(result: unknown) {
  const calls: Array<[string, unknown[]]> = [];
  const proxy: Record<string, unknown> = {};
  for (const m of ["select", "update", "eq"]) {
    proxy[m] = (...args: unknown[]) => {
      calls.push([m, args]);
      return proxy;
    };
  }
  proxy.maybeSingle = () => Promise.resolve(result);
  proxy.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(res, rej);
  return { proxy, calls };
}

function httpError(body: unknown) {
  return new FunctionsHttpError({ json: () => Promise.resolve(body) });
}

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.rpc.mockReset();
  mocks.from.mockReset();
});

describe("chaves TanStack", () => {
  it("todas começam por [instagram-<entidade>, unitId]", () => {
    expect(instagramKeys.module(UNIT)).toEqual(["instagram-module", UNIT]);
    expect(instagramKeys.account(UNIT)).toEqual(["instagram-account", UNIT]);
    expect(instagramKeys.settings(UNIT)).toEqual(["instagram-settings", UNIT]);
    expect(instagramKeys.diagnostics(UNIT)).toEqual(["instagram-diagnostics", UNIT]);
  });
});

describe("módulo da unidade", () => {
  it("readUnitModules chama a RPC com a unidade e devolve a flag do instagram", async () => {
    mocks.rpc.mockResolvedValue({
      data: [{ module: "instagram", active: true, granted_at: "2026-10-30T00:00:00Z" }],
      error: null,
    });
    const r = await readUnitModules(UNIT);
    expect(mocks.rpc).toHaveBeenCalledWith("get_unit_modules", { p_unit_id: UNIT });
    expect(r).toEqual({ instagram: { active: true, granted_at: "2026-10-30T00:00:00Z" } });
  });

  it("readUnitModules sem linha do instagram vira inativo (leitura bem-sucedida)", async () => {
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    expect(await readUnitModules(UNIT)).toEqual({ instagram: { active: false, granted_at: null } });
  });

  it("readUnitModules propaga erro de leitura (nunca vira OFF)", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(readUnitModules(UNIT)).rejects.toBeTruthy();
  });

  it("setUnitModule usa a RPC set_unit_module_grant", async () => {
    mocks.rpc.mockResolvedValue({
      data: [{ module: "instagram", active: true, granted_at: "x", revoked_at: null }],
      error: null,
    });
    const r = await setUnitModule(UNIT, true);
    expect(mocks.rpc).toHaveBeenCalledWith("set_unit_module_grant", {
      p_unit_id: UNIT,
      p_module: "instagram",
      p_active: true,
    });
    expect(r.active).toBe(true);
  });
});

describe("conta (EF status)", () => {
  it("readInstagramAccount chama instagram-connect action status com unit_id", async () => {
    mocks.invoke.mockResolvedValue({
      data: {
        account: {
          username: "loja",
          status: "connected",
          token_expires_at: null,
          connected_at: "x",
          subscribed: true,
          last_error_code: null,
        },
      },
      error: null,
    });
    const acc = await readInstagramAccount(UNIT);
    expect(mocks.invoke).toHaveBeenCalledWith("instagram-connect", {
      body: { action: "status", unit_id: UNIT },
    });
    expect(acc?.username).toBe("loja");
  });

  it("sem conta devolve null", async () => {
    mocks.invoke.mockResolvedValue({ data: { account: null }, error: null });
    expect(await readInstagramAccount(UNIT)).toBeNull();
  });

  it("extrai a mensagem do corpo do FunctionsHttpError", async () => {
    mocks.invoke.mockResolvedValue({ data: null, error: httpError({ error: "Sem permissão." }) });
    await expect(readInstagramAccount(UNIT)).rejects.toMatchObject({ message: "Sem permissão." });
  });
});

describe("configurações (tabela)", () => {
  it("readInstagramSettings filtra pela unidade", async () => {
    const { proxy, calls } = chain({
      data: { unit_id: UNIT, dm_enabled: true, updated_at: "x" },
      error: null,
    });
    mocks.from.mockReturnValue(proxy);
    const s = await readInstagramSettings(UNIT);
    expect(mocks.from).toHaveBeenCalledWith("instagram_settings");
    expect(calls).toContainEqual(["eq", ["unit_id", UNIT]]);
    expect(s?.dm_enabled).toBe(true);
  });

  it("updateInstagramDm filtra pela unidade e confere a linha", async () => {
    const { proxy, calls } = chain({ data: [{ unit_id: UNIT, dm_enabled: true }], error: null });
    mocks.from.mockReturnValue(proxy);
    await updateInstagramDm(UNIT, true);
    expect(calls).toContainEqual(["update", [{ dm_enabled: true }]]);
    expect(calls).toContainEqual(["eq", ["unit_id", UNIT]]);
    expect(calls.some(([m]) => m === "select")).toBe(true);
  });

  it("updateInstagramDm lança quando casa zero linhas", async () => {
    const { proxy } = chain({ data: [], error: null });
    mocks.from.mockReturnValue(proxy);
    await expect(updateInstagramDm(UNIT, false)).rejects.toThrow();
  });
});

describe("conexão OAuth", () => {
  it("connectStart devolve authorize_url e state", async () => {
    mocks.invoke.mockResolvedValue({ data: { authorize_url: "https://i/auth", state: "s1" }, error: null });
    expect(await connectStart(UNIT)).toEqual({ authorize_url: "https://i/auth", state: "s1" });
    expect(mocks.invoke).toHaveBeenCalledWith("instagram-connect", {
      body: { action: "start", unit_id: UNIT },
    });
  });

  it("connectCallback manda só code e state", async () => {
    mocks.invoke.mockResolvedValue({
      data: { unit_slug: "loja", username: "l", subscribed: false },
      error: null,
    });
    expect(await connectCallback("c", "s")).toEqual({ unit_slug: "loja", username: "l", subscribed: false });
    expect(mocks.invoke).toHaveBeenCalledWith("instagram-connect", {
      body: { action: "callback", code: "c", state: "s" },
    });
  });

  it("disconnect e resubscribe chamam a ação certa", async () => {
    mocks.invoke.mockResolvedValue({ data: {}, error: null });
    await disconnectInstagram(UNIT);
    await resubscribeInstagram(UNIT);
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "instagram-connect", {
      body: { action: "disconnect", unit_id: UNIT },
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "instagram-connect", {
      body: { action: "resubscribe", unit_id: UNIT },
    });
  });

  it("erro do corpo vira Error com a mensagem em PT-BR", async () => {
    mocks.invoke.mockResolvedValue({ data: null, error: httpError({ error: "Conta já conectada." }) });
    await expect(connectStart(UNIT)).rejects.toThrow("Conta já conectada.");
  });
});

describe("diagnóstico", () => {
  it("usa a RPC get_instagram_diagnostics com a unidade", async () => {
    mocks.rpc.mockResolvedValue({
      data: {
        last_event_at: null,
        queue: { received: 1, processing: 0, done_24h: 2, dead: 0 },
        oldest_pending_received_at: null,
        outcomes_24h: {},
      },
      error: null,
    });
    const d = await readInstagramDiagnostics(UNIT);
    expect(mocks.rpc).toHaveBeenCalledWith("get_instagram_diagnostics", { p_unit_id: UNIT });
    expect(d.queue.done_24h).toBe(2);
  });
});
