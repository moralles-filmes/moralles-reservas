// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { useRotateChannelSecret } from "./useWhatsAppChannels";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ supabase: { functions: { invoke: mocks.invoke } } }));
vi.mock("sonner", () => ({ toast: { success: mocks.success, error: mocks.error } }));
describe("Datafy secret rotation", () => {
  it("keeps the provider payload stable and explains the provider-specific next step", async () => {
    mocks.invoke.mockResolvedValue({ data: { success: true }, error: null });
    const client = new QueryClient();
    const { result } = renderHook(() => useRotateChannelSecret("unit-a"), { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
    await act(() => result.current.mutateAsync({ channelId: "channel-a", provider: "datafy", webhookSecret: "synthetic-secret" }));
    expect(mocks.invoke).toHaveBeenCalledWith("manage-channels", { body: { action: "rotate_secret", unit_id: "unit-a", channel_id: "channel-a", webhook_secret: "synthetic-secret" } });
    await waitFor(() => expect(mocks.success).toHaveBeenCalledWith("Segredo atualizado. Envie uma mensagem pelo celular e use Ativar."));
  });
});
