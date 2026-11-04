// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ cb: null as null | ((event: string, session: unknown) => void) }));
vi.mock("@/lib/supabase", () => {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.maybeSingle = async () => ({ data: null, error: null });
  chain.then = (fn: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(fn);
  const channel: Record<string, unknown> = {};
  channel.on = () => channel;
  channel.subscribe = () => channel;
  return {
    supabase: {
      auth: {
        onAuthStateChange: (cb: (event: string, session: unknown) => void) => {
          io.cb = cb;
          return { data: { subscription: { unsubscribe: vi.fn() } } };
        },
        signOut: vi.fn().mockResolvedValue({}),
      },
      from: () => chain,
      channel: () => channel,
      removeChannel: vi.fn(),
    },
  };
});
vi.mock("sonner", () => ({ toast: { info: vi.fn() } }));

import { AuthProvider } from "./AuthContext";

function setup() {
  const qc = new QueryClient();
  const clear = vi.spyOn(qc, "clear");
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AuthProvider>
          <div />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const emit = (event: string, id: string | null) =>
    act(async () => {
      io.cb!(event, id ? { user: { id } } : null);
    });
  return { clear, emit };
}

beforeEach(() => {
  io.cb = null;
});

describe("AuthProvider e o cache do TanStack Query", () => {
  it("não limpa no primeiro login", async () => {
    const { clear, emit } = setup();
    await emit("INITIAL_SESSION", null);
    await emit("SIGNED_IN", "a");
    expect(clear).not.toHaveBeenCalled();
  });

  it("limpa em SIGNED_OUT", async () => {
    const { clear, emit } = setup();
    await emit("SIGNED_IN", "a");
    await emit("SIGNED_OUT", null);
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("limpa quando o usuário troca de um id para outro", async () => {
    const { clear, emit } = setup();
    await emit("SIGNED_IN", "a");
    await emit("SIGNED_IN", "b");
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("não limpa em refresh do mesmo usuário", async () => {
    const { clear, emit } = setup();
    await emit("SIGNED_IN", "a");
    await emit("TOKEN_REFRESHED", "a");
    expect(clear).not.toHaveBeenCalled();
  });
});
