// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import PlatformAutomacao from "./Automacao";

const mocks = vi.hoisted(() => ({ remove: vi.fn(), save: vi.fn() }));
vi.mock("@/hooks/useAllUnits", () => ({ useAllUnits: () => ({ data: [], isLoading: false }) }));
vi.mock("@/hooks/usePlatformSecrets", () => ({
  usePlatformSecrets: () => ({ isLoading: false, data: [{ key: "datafy_account_token", configured: true, last4: "test", updated_at: null }] }),
  useUpsertPlatformSecret: () => ({ mutate: mocks.save, isPending: false }),
  useDeletePlatformSecret: () => ({ mutate: mocks.remove, isPending: false }),
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe("Datafy platform secret", () => {
  it("groups the masked account token outside payments and uses the dedicated removal effect", () => {
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><PlatformAutomacao /></MemoryRouter>);
    const label = screen.getByText("WhatsApp oficial (Datafy)");
    const input = screen.getByLabelText("Token da conta Datafy");
    expect(input.getAttribute("placeholder")).toBe("sk_acct_...");
    expect(input.getAttribute("type")).toBe("password");
    expect(label.closest('[class*="rounded"]')?.textContent).not.toContain("Pagamentos");
    expect(screen.queryByText("datafy_account_token")).toBeNull();
    fireEvent.click(screen.getByTitle("Remover"));
    expect(screen.getByText(/a conexão oficial de novas lojas fica indisponível/)).toBeTruthy();
    expect(mocks.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remover" }));
    expect(mocks.remove).toHaveBeenCalledWith("datafy_account_token");
  });
});
