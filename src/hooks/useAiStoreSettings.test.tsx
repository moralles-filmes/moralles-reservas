// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAiStoreSettings, useSaveAiStoreSettings } from "./useAiStoreSettings";
import { AI_STORE_SETTING_KEYS } from "@/lib/ai-store-settings";
import { STORE_TEXT_LIMITS } from "../../supabase/functions/_shared/agent/global-prompt-core";

// Builder que registra a cadeia de cada `.from("settings")` e resolve o resultado do tipo de chamada.
const mocks = vi.hoisted(() => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const results = {
    read: { data: [], error: null } as { data: unknown; error: unknown },
    write: { data: [], error: null } as { data: unknown; error: unknown },
  };
  const from = vi.fn((_table: string) => {
    let writing = false;
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "upsert"]) {
      builder[m] = (...args: unknown[]) => {
        calls.push({ method: m, args });
        if (m === "upsert") writing = true;
        return builder;
      };
    }
    builder.then = (resolve: (v: unknown) => unknown) => resolve(writing ? results.write : results.read);
    return builder;
  });
  return { calls, results, from };
});

vi.mock("@/lib/supabase", () => ({ supabase: { from: mocks.from } }));

let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});

afterEach(() => {
  mocks.calls.length = 0;
  mocks.results.read = { data: [], error: null };
  mocks.results.write = { data: [], error: null };
  vi.clearAllMocks();
});

const callsOf = (m: string) => mocks.calls.filter((c) => c.method === m).map((c) => c.args);
const texts = { restaurant_menu: "cardápio", delivery_response: "só retirada", restaurant_extra_info: "estacionamento" };
const threeRows = AI_STORE_SETTING_KEYS.map((key) => ({ key }));

describe("useAiStoreSettings (leitura)", () => {
  it("lê as chaves da loja e o agent_mode da unidade, só dela", async () => {
    mocks.results.read = {
      data: [
        { key: "restaurant_menu", value: "cardápio" },
        { key: "agent_mode", value: "reservations_faq" },
      ],
      error: null,
    };
    const { result } = renderHook(() => useAiStoreSettings("unit-a"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(callsOf("eq")).toContainEqual(["unit_id", "unit-a"]);
    expect(callsOf("in")).toEqual([["key", [...AI_STORE_SETTING_KEYS, "agent_mode"]]]);
    expect(result.current.data).toEqual({
      texts: { restaurant_menu: "cardápio", delivery_response: "", restaurant_extra_info: "" },
      agentMode: "reservations_faq",
    });
  });

  it("agent_mode ausente ou desconhecido vira reservations; valor que não é string vira vazio", async () => {
    mocks.results.read = {
      data: [
        { key: "agent_mode", value: "outro" },
        { key: "delivery_response", value: { a: 1 } },
      ],
      error: null,
    };
    const { result } = renderHook(() => useAiStoreSettings("unit-a"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.agentMode).toBe("reservations");
    expect(result.current.data?.texts.delivery_response).toBe("");
  });

  it("erro de leitura vira isError", async () => {
    mocks.results.read = { data: null, error: { code: "XX", message: "x" } };
    const { result } = renderHook(() => useAiStoreSettings("unit-a"), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it("sem unitId não lê", () => {
    renderHook(() => useAiStoreSettings(""), { wrapper });
    expect(mocks.from).not.toHaveBeenCalled();
  });
});

describe("useSaveAiStoreSettings", () => {
  it("grava as 3 linhas num upsert só, normalizadas, com onConflict e .select()", async () => {
    mocks.results.write = { data: threeRows, error: null };
    const { result } = renderHook(() => useSaveAiStoreSettings("unit-a"), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ ...texts, restaurant_menu: "a\r\nb\rc" });
    });
    expect(callsOf("upsert")).toEqual([
      [
        [
          { unit_id: "unit-a", key: "restaurant_menu", value: "a\nb\nc" },
          { unit_id: "unit-a", key: "delivery_response", value: "só retirada" },
          { unit_id: "unit-a", key: "restaurant_extra_info", value: "estacionamento" },
        ],
        { onConflict: "unit_id,key" },
      ],
    ]);
    expect(callsOf("select")).toEqual([[]]);
  });

  it("sucesso invalida o prefixo ['settings', unitId]", async () => {
    mocks.results.write = { data: threeRows, error: null };
    const spy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useSaveAiStoreSettings("unit-a"), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(texts);
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["settings", "unit-a"] });
  });

  it.each([0, 2])("volta %i linhas em vez de 3: erro, mesmo com error nulo (zero linhas não é sucesso)", async (n) => {
    mocks.results.write = { data: threeRows.slice(0, n), error: null };
    const spy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useSaveAiStoreSettings("unit-a"), { wrapper });
    let thrown: unknown;
    await act(async () => {
      thrown = await result.current.mutateAsync(texts).catch((e) => e);
    });
    expect(thrown).toMatchObject({ code: "settings_not_written" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("data nulo também é erro", async () => {
    mocks.results.write = { data: null, error: null };
    const { result } = renderHook(() => useSaveAiStoreSettings("unit-a"), { wrapper });
    let thrown: unknown;
    await act(async () => {
      thrown = await result.current.mutateAsync(texts).catch((e) => e);
    });
    expect(thrown).toMatchObject({ code: "settings_not_written" });
  });

  it.each(["42501", "22023"])("relança o erro do PostgREST como está (code %s)", async (code) => {
    const err = { code, message: "trigger", details: null, hint: null };
    mocks.results.write = { data: null, error: err };
    const { result } = renderHook(() => useSaveAiStoreSettings("unit-a"), { wrapper });
    let thrown: unknown;
    await act(async () => {
      thrown = await result.current.mutateAsync(texts).catch((e) => e);
    });
    expect(thrown).toBe(err);
  });

  it.each([
    ["acima do limite", { ...texts, delivery_response: "a".repeat(STORE_TEXT_LIMITS.delivery_response + 1) }],
    ["com controle", { ...texts, restaurant_extra_info: "a\x01b" }],
  ])("texto %s: erro 22023 local e nenhuma chamada ao banco", async (_n, bad) => {
    const { result } = renderHook(() => useSaveAiStoreSettings("unit-a"), { wrapper });
    let thrown: unknown;
    await act(async () => {
      thrown = await result.current.mutateAsync(bad).catch((e) => e);
    });
    expect(thrown).toMatchObject({ code: "22023" });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("o limite vale depois de normalizar: \\r\\n conta como 1 caractere", async () => {
    mocks.results.write = { data: threeRows, error: null };
    const limit = STORE_TEXT_LIMITS.delivery_response;
    // Com CRLF contado como 2 estouraria o limite; normalizado, cabe exato.
    const exact = "a".repeat(limit - 1) + "\r\n";
    const { result } = renderHook(() => useSaveAiStoreSettings("unit-a"), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ ...texts, delivery_response: exact });
    });
    const rows = callsOf("upsert")[0][0] as Array<{ key: string; value: string }>;
    expect(rows.find((r) => r.key === "delivery_response")?.value).toBe("a".repeat(limit - 1) + "\n");
  });

  it("sem unitId não grava", async () => {
    const { result } = renderHook(() => useSaveAiStoreSettings(""), { wrapper });
    let thrown: unknown;
    await act(async () => {
      thrown = await result.current.mutateAsync(texts).catch((e) => e);
    });
    expect(thrown).toBeInstanceOf(Error);
    expect(mocks.from).not.toHaveBeenCalled();
  });
});
