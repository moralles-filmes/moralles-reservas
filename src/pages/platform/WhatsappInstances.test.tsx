// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import WhatsappInstances from "./WhatsappInstances";

const base = {
  organization_id: "org-1", unit_id: null, channel_id: null, provider: "zapi",
  provider_cycle_anchor_day: null, current_cycle_started_on: null, current_cycle_due_on: null,
  cycle_source: "ADMIN_CONFIRMED", current_monthly_cost_cents: null, cost_source: null, cost_note: null,
  cancellation_requested_at: null, cancellation_reason: null, provider_access_until: null,
  end_confirmation_required_at: null, ended_at: null, planned_provision_on: null,
  last_divergence_kind: null, last_divergence_at: null, notes: null,
  created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
};

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  instances: [] as unknown[],
}));

vi.mock("@/hooks/useWhatsappInstances", () => ({
  useWhatsappInstances: () => ({ isLoading: false, isError: false, data: mocks.instances, refetch: vi.fn() }),
  useWhatsappInstance: () => ({ isLoading: false, isError: false, data: { cycles: [] }, refetch: vi.fn() }),
  useWhatsappInstanceAlerts: () => ({ isLoading: false, isError: false, data: [], refetch: vi.fn() }),
  useWhatsappInstanceAction: () => ({ mutate: mocks.mutate, isPending: false, variables: undefined }),
  usePartnerSimulation: () => ({ mutate: vi.fn(), isPending: false, data: undefined, reset: vi.fn() }),
}));
vi.mock("@/hooks/useAllUnits", () => ({
  useAllUnits: () => ({ data: [], isLoading: false, isError: false, refetch: vi.fn() }),
}));
vi.mock("@/components/platform/InstanceNotesPanel", () => ({ InstanceNotesPanel: () => null }));
vi.mock("@/components/platform/RegisterInstanceDialog", () => ({ RegisterInstanceDialog: () => null }));
vi.mock("@/components/platform/UpdateInstanceDialog", () => ({ UpdateInstanceDialog: () => null }));

// Expõe a query string atual para os testes de URL.
function LocationProbe() {
  return <span data-testid="search">{useLocation().search}</span>;
}

let queryClient: QueryClient;

const renderAt = (url: string) => {
  queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[url]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <WhatsappInstances />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

const searchNow = () => screen.getByTestId("search").textContent;

function openDeleteDialog() {
  fireEvent.click(screen.getByRole("button", { name: "Apagar" }));
  fireEvent.change(screen.getByLabelText(/Motivo/), { target: { value: "era instância de teste" } });
  fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
  // Callbacks que a página passou ao `mutate` (onSuccess/onError).
  return mocks.mutate.mock.calls[0][1] as {
    onSuccess: (data: unknown) => void;
    onError: (e: Error) => void;
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const setInstances = () => {
  mocks.instances = [
    { ...base, id: "i-ativa", provider_instance_ref: "REF-ATIVA", lifecycle_state: "ACTIVE", has_cost_history: false },
    { ...base, id: "i-teste", provider_instance_ref: "REF-TESTE", lifecycle_state: "ENDED",
      ended_at: "2026-10-14T00:00:00Z", has_cost_history: false },
    { ...base, id: "i-custo", provider_instance_ref: "REF-CUSTO", lifecycle_state: "ENDED",
      ended_at: "2026-10-14T00:00:00Z", current_monthly_cost_cents: 9990, has_cost_history: true },
  ];
};

describe("Instâncias de WhatsApp — abas e exclusão", () => {
  it("sem ?aba mostra só as ativas, com as duas contagens", () => {
    setInstances();
    renderAt("/platform/instancias-whatsapp");
    expect(screen.getByRole("tab", { name: "Ativas (1)" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Encerradas (2)" })).toBeTruthy();
    expect(screen.getByText("REF-ATIVA")).toBeTruthy();
    expect(screen.queryByText("REF-TESTE")).toBeNull();
    expect(screen.queryByRole("button", { name: "Apagar" })).toBeNull();
  });

  it("?aba=encerradas mostra as encerradas e oferece Apagar só na sem custo", () => {
    setInstances();
    renderAt("/platform/instancias-whatsapp?aba=encerradas");
    expect(screen.getByText("REF-TESTE")).toBeTruthy();
    expect(screen.getByText("REF-CUSTO")).toBeTruthy();
    expect(screen.queryByText("REF-ATIVA")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Apagar" })).toHaveLength(1);
  });

  it("Apagar pede motivo e envia delete_instance com o id certo", () => {
    setInstances();
    renderAt("/platform/instancias-whatsapp?aba=encerradas");
    fireEvent.click(screen.getByRole("button", { name: "Apagar" }));
    fireEvent.change(screen.getByLabelText(/Motivo/), { target: { value: "era instância de teste" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.mutate.mock.calls[0][0]).toEqual({
      action: "delete_instance",
      instance_id: "i-teste",
      reason: "era instância de teste",
    });
  });

  it("aba sem instância diz isso, em vez de área em branco", () => {
    mocks.instances = [{ ...base, id: "i-ativa", provider_instance_ref: "REF-ATIVA", lifecycle_state: "ACTIVE", has_cost_history: false }];
    renderAt("/platform/instancias-whatsapp?aba=encerradas");
    expect(screen.getByText("Nenhuma instância encerrada.")).toBeTruthy();
  });

  it("clicar em Encerradas põe aba=encerradas na URL e preserva os outros parâmetros; Ativas remove só aba", async () => {
    setInstances();
    const user = userEvent.setup();
    renderAt("/platform/instancias-whatsapp?x=1");
    expect(searchNow()).toBe("?x=1");

    await user.click(screen.getByRole("tab", { name: "Encerradas (2)" }));
    const afterEnded = new URLSearchParams(searchNow() ?? "");
    expect(afterEnded.get("aba")).toBe("encerradas");
    expect(afterEnded.get("x")).toBe("1");

    await user.click(screen.getByRole("tab", { name: "Ativas (1)" }));
    const afterActive = new URLSearchParams(searchNow() ?? "");
    expect(afterActive.has("aba")).toBe(false);
    expect(afterActive.get("x")).toBe("1");
  });

  it("Confirmar do diálogo de exclusão só habilita com motivo de 5+ caracteres após trim", () => {
    setInstances();
    renderAt("/platform/instancias-whatsapp?aba=encerradas");
    fireEvent.click(screen.getByRole("button", { name: "Apagar" }));
    const confirmBtn = () => screen.getByRole("button", { name: "Confirmar" }) as HTMLButtonElement;
    const motivo = screen.getByLabelText(/Motivo/);

    expect(confirmBtn().disabled).toBe(true);
    fireEvent.change(motivo, { target: { value: "  abc  " } });
    expect(confirmBtn().disabled).toBe(true);
    fireEvent.change(motivo, { target: { value: "  abcde  " } });
    expect(confirmBtn().disabled).toBe(false);
  });

  it("com todas as instâncias encerradas, a aba Ativas diz que não há ativa", () => {
    mocks.instances = [
      { ...base, id: "i-teste", provider_instance_ref: "REF-TESTE", lifecycle_state: "ENDED",
        ended_at: "2026-10-14T00:00:00Z", has_cost_history: false },
    ];
    renderAt("/platform/instancias-whatsapp");
    expect(screen.getByText("Nenhuma instância ativa.")).toBeTruthy();
  });

  it("o diálogo de exclusão avisa sobre ciclo com custo pendente e confirma em destrutivo", () => {
    setInstances();
    renderAt("/platform/instancias-whatsapp?aba=encerradas");
    fireEvent.click(screen.getByRole("button", { name: "Apagar" }));
    expect(screen.getByText(/Ciclos com custo ainda não informado também somem/)).toBeTruthy();
    // `buttonVariants` destrutivo pinta com bg-destructive; o "Apagar" do cartão
    // também é destrutivo, então só o Confirmar do diálogo é medido aqui.
    expect(screen.getByRole("button", { name: "Confirmar" }).className).toContain("bg-destructive");
  });

  it("o Confirmar dos outros diálogos NÃO é destrutivo", () => {
    setInstances();
    renderAt("/platform/instancias-whatsapp");
    fireEvent.click(screen.getByRole("button", { name: "Registrar cancelamento" }));
    expect(screen.getByRole("button", { name: "Confirmar" }).className).not.toContain("bg-destructive");
  });

  it.each([404, 409])("delete_instance com erro %i fecha o diálogo", (status) => {
    setInstances();
    renderAt("/platform/instancias-whatsapp?aba=encerradas");
    const { onError } = openDeleteDialog();
    expect(screen.queryByText("Apagar instância")).not.toBeNull();
    act(() => onError(Object.assign(new Error("Instância já tem custo."), { httpStatus: status })));
    expect(screen.queryByText("Apagar instância")).toBeNull();
  });

  it("delete_instance com erro 500 mantém o diálogo aberto para nova tentativa", () => {
    setInstances();
    renderAt("/platform/instancias-whatsapp?aba=encerradas");
    const { onError } = openDeleteDialog();
    act(() => onError(Object.assign(new Error("Erro interno."), { httpStatus: 500 })));
    expect(screen.queryByText("Apagar instância")).not.toBeNull();
  });

  it("sucesso do delete recolhe o detalhe da instância apagada e remove a query dele do cache", () => {
    setInstances();
    renderAt("/platform/instancias-whatsapp?aba=encerradas");
    // Expande o cartão da instância sem custo (única com Apagar) e semeia o cache.
    const card = screen.getByText("REF-TESTE").closest("div.space-y-3") as HTMLElement;
    queryClient.setQueryData(["whatsapp-instance", "i-teste"], { cycles: [] });
    queryClient.setQueryData(["whatsapp-instance", "outra"], { cycles: [] });
    fireEvent.click(
      Array.from(card.querySelectorAll("button")).find((b) => b.textContent === "Ver ciclos, margem e histórico")!,
    );
    expect(screen.queryByText("Ciclos e margem")).not.toBeNull();

    const { onSuccess } = openDeleteDialog();
    act(() => onSuccess({ deleted: true }));

    expect(screen.queryByText("Ciclos e margem")).toBeNull();
    expect(queryClient.getQueryData(["whatsapp-instance", "i-teste"])).toBeUndefined();
    // Só a key da instância apagada sai; a de outra instância fica.
    expect(queryClient.getQueryData(["whatsapp-instance", "outra"])).toBeDefined();
  });
});
