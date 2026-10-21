// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useActivateAiPromptVersion,
  useAiPromptSlot,
  useAiPromptVersionList,
  usePublishAiPromptVersion,
} from "./useAiPromptVersions";

// Builder que registra a cadeia de cada `.from(tabela)` e resolve por tabela.
const mocks = vi.hoisted(() => {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = [];
  const results = {
    slots: { data: null, error: null } as { data: unknown; error: unknown },
    versionById: { data: null, error: null } as { data: unknown; error: unknown },
    // Resposta da lista por início do range.
    listByStart: {} as Record<number, { data: unknown; error: unknown }>,
  };
  const rpc = vi.fn();
  const from = vi.fn((table: string) => {
    let rangeStart: number | null = null;
    let byId = false;
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "eq", "order", "range", "maybeSingle", "insert", "update", "upsert", "delete"]) {
      builder[m] = (...args: unknown[]) => {
        calls.push({ table, method: m, args });
        if (m === "range") rangeStart = args[0] as number;
        if (m === "eq" && args[0] === "id") byId = true;
        return builder;
      };
    }
    builder.then = (resolve: (v: unknown) => unknown) => {
      if (table === "ai_prompt_slots") return resolve(results.slots);
      if (rangeStart !== null) return resolve(results.listByStart[rangeStart] ?? { data: [], error: null });
      return resolve(byId ? results.versionById : { data: null, error: null });
    };
    return builder;
  });
  return { calls, results, rpc, from };
});

vi.mock("@/lib/supabase", () => ({ supabase: { from: mocks.from, rpc: mocks.rpc } }));

const row = (n: number, over: Record<string, unknown> = {}) => ({
  id: `v${n}`,
  slot: "global_persona",
  version: n,
  body: `corpo ${n}`,
  note: `motivo ${n}`,
  created_at: "2026-10-20T12:00:00Z",
  created_by: n === 1 ? null : "u-1",
  ...over,
});

let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});

afterEach(() => {
  mocks.calls.length = 0;
  mocks.results.slots = { data: null, error: null };
  mocks.results.versionById = { data: null, error: null };
  mocks.results.listByStart = {};
  vi.clearAllMocks();
});

const callsOf = (table: string, m: string) =>
  mocks.calls.filter((c) => c.table === table && c.method === m).map((c) => c.args);

describe("useAiPromptSlot", () => {
  it("lê o slot pelo nome e devolve a versão ativa com quando/quem ativou", async () => {
    mocks.results.slots = {
      data: { slot: "global_persona", active_version_id: "v2", activated_at: "2026-10-20T13:00:00Z", activated_by: "u-9" },
      error: null,
    };
    mocks.results.versionById = { data: row(2), error: null };
    const { result } = renderHook(() => useAiPromptSlot(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(callsOf("ai_prompt_slots", "eq")).toContainEqual(["slot", "global_persona"]);
    expect(callsOf("ai_prompt_slots", "maybeSingle")).toHaveLength(1);
    expect(callsOf("ai_prompt_versions", "eq")).toContainEqual(["id", "v2"]);
    expect(callsOf("ai_prompt_versions", "eq")).toContainEqual(["slot", "global_persona"]);
    expect(result.current.data).toEqual({
      activeVersionId: "v2",
      activatedAt: "2026-10-20T13:00:00Z",
      activatedBy: "u-9",
      active: row(2),
    });
  });

  it("slot ausente (antes do db push) devolve null, sem ler versões", async () => {
    const { result } = renderHook(() => useAiPromptSlot(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
    expect(mocks.from).not.toHaveBeenCalledWith("ai_prompt_versions");
  });

  it("erro de leitura do slot vira isError, não null", async () => {
    mocks.results.slots = { data: null, error: { code: "42P01", message: "x" } };
    const { result } = renderHook(() => useAiPromptSlot(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it("erro na leitura da versão ativa vira isError", async () => {
    mocks.results.slots = {
      data: { slot: "global_persona", active_version_id: "v2", activated_at: "t", activated_by: null },
      error: null,
    };
    mocks.results.versionById = { data: null, error: { code: "XX", message: "x" } };
    const { result } = renderHook(() => useAiPromptSlot(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe("useAiPromptVersionList", () => {
  it("lê 50 por página, da maior versão para a menor, sempre com .range", async () => {
    mocks.results.listByStart[0] = { data: [row(2), row(1)], error: null };
    const { result } = renderHook(() => useAiPromptVersionList(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(callsOf("ai_prompt_versions", "range")).toEqual([[0, 49]]);
    expect(callsOf("ai_prompt_versions", "order")).toEqual([["version", { ascending: false }]]);
    expect(callsOf("ai_prompt_versions", "eq")).toContainEqual(["slot", "global_persona"]);
    expect(result.current.data?.pages.flat().map((v) => v.version)).toEqual([2, 1]);
    // Página incompleta: não há próxima.
    expect(result.current.hasNextPage).toBe(false);
  });

  it("página cheia habilita carregar mais, que lê o range seguinte", async () => {
    mocks.results.listByStart[0] = { data: Array.from({ length: 50 }, (_, i) => row(120 - i)), error: null };
    mocks.results.listByStart[50] = { data: [row(70)], error: null };
    const { result } = renderHook(() => useAiPromptVersionList(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasNextPage).toBe(true);
    await act(async () => {
      await result.current.fetchNextPage();
    });
    expect(callsOf("ai_prompt_versions", "range")).toEqual([[0, 49], [50, 99]]);
    await waitFor(() => expect(result.current.data?.pages.flat()).toHaveLength(51));
    expect(result.current.hasNextPage).toBe(false);
  });

  it("nenhuma leitura de versões sai sem .range", async () => {
    mocks.results.listByStart[0] = { data: [], error: null };
    const { result } = renderHook(() => useAiPromptVersionList(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(callsOf("ai_prompt_versions", "select")).toHaveLength(callsOf("ai_prompt_versions", "range").length);
  });

  it("erro de leitura vira isError", async () => {
    mocks.results.listByStart[0] = { data: null, error: { code: "XX", message: "x" } };
    const { result } = renderHook(() => useAiPromptVersionList(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe("usePublishAiPromptVersion", () => {
  it("chama a RPC com o slot, o corpo normalizado e a versão ativa esperada", async () => {
    mocks.rpc.mockResolvedValue({ data: "novo-id", error: null });
    const { result } = renderHook(() => usePublishAiPromptVersion(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ body: "a\r\nb\rc", note: "tom", expectedActiveVersionId: "v2" });
    });
    expect(mocks.rpc).toHaveBeenCalledWith("publish_ai_prompt_version", {
      p_slot: "global_persona",
      p_body: "a\nb\nc",
      p_note: "tom",
      p_expected_active_version_id: "v2",
    });
  });

  it("sucesso invalida as queries do prefixo ai-prompt (slot e lista)", async () => {
    mocks.rpc.mockResolvedValue({ data: "novo-id", error: null });
    const spy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => usePublishAiPromptVersion(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ body: "a", note: "n", expectedActiveVersionId: "v2" });
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["ai-prompt"] });
  });

  it("lança o objeto do PostgREST (com code) e, em 40001, também invalida", async () => {
    const err = { code: "40001", message: "prompt_version_conflict", details: null, hint: null };
    mocks.rpc.mockResolvedValue({ data: null, error: err });
    const spy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => usePublishAiPromptVersion(), { wrapper });
    let thrown: unknown;
    await act(async () => {
      thrown = await result.current.mutateAsync({ body: "a", note: "n", expectedActiveVersionId: "v2" }).catch((e) => e);
    });
    expect(thrown).toBe(err);
    expect(spy).toHaveBeenCalledWith({ queryKey: ["ai-prompt"] });
  });

  it("erro que não é 40001 não invalida", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "22023", message: "prompt_body_invalid" } });
    const spy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => usePublishAiPromptVersion(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ body: "a", note: "n", expectedActiveVersionId: "v2" }).catch(() => undefined);
    });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("useActivateAiPromptVersion", () => {
  it("chama a RPC de restaurar com o id esperado e o motivo", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    const spy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useActivateAiPromptVersion(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ versionId: "v1", expectedActiveVersionId: "v3", note: "voltar" });
    });
    expect(mocks.rpc).toHaveBeenCalledWith("activate_ai_prompt_version", {
      p_slot: "global_persona",
      p_version_id: "v1",
      p_expected_active_version_id: "v3",
      p_note: "voltar",
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["ai-prompt"] });
  });

  it("40001 ao restaurar também invalida e lança o objeto do PostgREST", async () => {
    const err = { code: "40001", message: "prompt_version_conflict" };
    mocks.rpc.mockResolvedValue({ data: null, error: err });
    const spy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useActivateAiPromptVersion(), { wrapper });
    let thrown: unknown;
    await act(async () => {
      thrown = await result.current
        .mutateAsync({ versionId: "v1", expectedActiveVersionId: "v3", note: "n" })
        .catch((e) => e);
    });
    expect(thrown).toBe(err);
    expect(spy).toHaveBeenCalledWith({ queryKey: ["ai-prompt"] });
  });
});

describe("escrita só por RPC", () => {
  it("nenhum insert/update/upsert/delete é chamado em nenhuma tabela", async () => {
    mocks.rpc.mockResolvedValue({ data: "x", error: null });
    const publish = renderHook(() => usePublishAiPromptVersion(), { wrapper });
    const activate = renderHook(() => useActivateAiPromptVersion(), { wrapper });
    await act(async () => {
      await publish.result.current.mutateAsync({ body: "a", note: "n", expectedActiveVersionId: "v2" });
      await activate.result.current.mutateAsync({ versionId: "v1", expectedActiveVersionId: "v2", note: "n" });
    });
    const writes = mocks.calls.filter((c) => ["insert", "update", "upsert", "delete"].includes(c.method));
    expect(writes).toEqual([]);
    expect(mocks.from).not.toHaveBeenCalled();
  });
});
