// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OUTSIDE_SERVICE_WINDOW_MESSAGE, useSendManualMessage } from "./useSendManualMessage";

const io = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ supabase: { functions: { invoke: io.invoke } } }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "caller" } }) }));

beforeEach(() => { io.invoke.mockReset(); });

describe("manual send 409", () => {
  it("shows Portuguese service-window copy, rolls back optimistic text, and refetches detail and channel", async () => {
    io.invoke.mockResolvedValue({ data: null, error: new FunctionsHttpError(new Response(
      JSON.stringify({ error: "OUTSIDE_SERVICE_WINDOW" }), { status: 409 },
    )) });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const conversationId = "conversation";
    const before = { id: conversationId, status: "human_active", messages: [] };
    client.setQueryData(["conversation-detail", conversationId], before);
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useSendManualMessage("unit"), { wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync({ conversationId, message: "Mensagem" })).rejects.toThrow(OUTSIDE_SERVICE_WINDOW_MESSAGE);
    });
    await waitFor(() => expect(client.getQueryData(["conversation-detail", conversationId])).toEqual(before));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["whatsapp-templates", "unit"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["conversation-detail", conversationId] });
  });
});
