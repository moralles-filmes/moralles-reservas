// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Automacao from "./Automacao";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), admin: true }));

vi.mock("@/lib/supabase", () => ({ supabase: { functions: { invoke: mocks.invoke } } }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ isPlatformAdmin: mocks.admin }) }));
vi.mock("@/hooks/useAllUnits", () => ({ useUnitBySlug: () => ({ isLoading: false, data: { id: "unit-a", name: "Unidade A", organization_id: "org-a", organization_name: "Org", default_whatsapp_provider: "datafy" } }) }));
vi.mock("@/components/billing/WhatsappServiceBanner", () => ({ WhatsappServiceBanner: () => null }));
vi.mock("@/components/whatsapp/DatafyAdminCard", () => ({ DatafyAdminCard: () => null }));
vi.mock("@/components/instagram/InstagramAdminCard", () => ({ InstagramAdminCard: ({ unitId }: { unitId: string }) => <div data-testid="instagram-card" data-unit-id={unitId}>Cartão Instagram</div> }));

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  mocks.admin = true;
  mocks.invoke.mockReset();
  mocks.invoke.mockResolvedValue({ error: null, data: { channels: [], providers: [] } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function view() {
  return <MemoryRouter><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Automacao /></QueryClientProvider></MemoryRouter>;
}

describe("Aba Instagram na página da unidade", () => {
  it("aparece para platform_admin e abre o cartão da unidade", async () => {
    render(view());
    expect(screen.queryByTestId("instagram-card")).toBeNull();
    await userEvent.setup().click(screen.getByRole("tab", { name: "Instagram" }));
    expect(screen.getByTestId("instagram-card").getAttribute("data-unit-id")).toBe("unit-a");
  });

  it("não aparece para quem não é platform_admin", () => {
    mocks.admin = false;
    render(view());
    expect(screen.queryByRole("tab", { name: "Instagram" })).toBeNull();
  });
});
