// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import PlatformIntegracoes from "./Integracoes";

const mocks = vi.hoisted(() => ({
  remove: vi.fn(),
  save: vi.fn(),
  refetch: vi.fn(),
  query: {
    isLoading: false,
    isError: false,
    error: null as Error | null,
    data: [
      { key: "datafy_account_token", configured: true, last4: "test", updated_at: null },
      { key: "stripe_secret_key", configured: true, last4: "68HP", updated_at: null },
      { key: "asaas_api_key", configured: false, last4: null, updated_at: null },
    ] as unknown[],
  },
}));

vi.mock("@/hooks/usePlatformSecrets", () => ({
  usePlatformSecrets: () => ({ ...mocks.query, refetch: mocks.refetch }),
  useUpsertPlatformSecret: () => ({ mutate: mocks.save, isPending: false }),
  useDeletePlatformSecret: () => ({ mutate: mocks.remove, isPending: false }),
}));
vi.mock("@/components/whatsapp/TemplateAutoPolicyCard", () => ({ TemplateAutoPolicyCard: () => <div>Política dos modelos</div> }));

const renderPage = () =>
  render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <PlatformIntegracoes />
    </MemoryRouter>,
  );

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.query.isError = false;
  mocks.query.error = null;
});

describe("Integrações e chaves", () => {
  it("separa o token Datafy dos pagamentos e usa o efeito de remoção dedicado", () => {
    renderPage();
    const label = screen.getByText("WhatsApp oficial (Datafy)");
    const input = screen.getByLabelText("Token da conta Datafy");
    expect(input.getAttribute("placeholder")).toBe("sk_acct_...");
    expect(input.getAttribute("type")).toBe("password");
    const card = label.closest('[class*="rounded"]');
    expect(card?.textContent).not.toContain("Stripe");
    expect(card?.textContent).not.toContain("Asaas");
    expect(screen.queryByText("datafy_account_token")).toBeNull();

    fireEvent.click(screen.getAllByTitle("Remover")[0]);
    expect(screen.getByText(/a conexão oficial de novas lojas fica indisponível/)).toBeTruthy();
    expect(mocks.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remover" }));
    expect(mocks.remove).toHaveBeenCalledWith("datafy_account_token");
  });

  it("dá a cada fornecedor um cartão próprio e aponta o Stripe Connect para Unidades", () => {
    renderPage();
    expect(screen.getByText("Stripe")).toBeTruthy();
    expect(screen.getByText("Asaas")).toBeTruthy();
    expect(screen.getByLabelText("Chave secreta (Secret Key)")).toBeTruthy();
    expect(screen.getByLabelText("Chave da API (Access Token)")).toBeTruthy();
    expect(screen.getByText(/Unidades › Configurar › Pagamentos/)).toBeTruthy();
  });

  it("falha ao carregar não vira tela vazia", () => {
    mocks.query.isError = true;
    mocks.query.error = new Error("boom");
    renderPage();
    expect(screen.queryByLabelText("Token da conta Datafy")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(mocks.refetch).toHaveBeenCalled();
  });
});
