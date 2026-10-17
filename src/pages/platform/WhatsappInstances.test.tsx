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
  alerts: { isLoading: false, isError: false, data: [] as unknown } as {
    isLoading: boolean; isError: boolean; data: unknown;
  },
}));

vi.mock("@/hooks/useWhatsappInstances", () => ({
  useWhatsappInstances: () => ({ isLoading: false, isError: false, data: mocks.instances, refetch: vi.fn() }),
  useWhatsappInstance: () => ({ isLoading: false, isError: false, data: { cycles: [] }, refetch: vi.fn() }),
  useWhatsappInstanceAlerts: () => ({ ...mocks.alerts, refetch: vi.fn() }),
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
  mocks.alerts = { isLoading: false, isError: false, data: [] };
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

  const alertaDe = (instanceId: string, status: string) => ({
    id: `al-${instanceId}-${status}`, subject_type: "INSTANCE", subject_id: instanceId,
    instance_id: instanceId, alert_type: "DIVERGENCE", status, dispatch_enabled_at_enqueue: true,
    organization_id: "org-1", channel_id: null, dedupe_key: "k", first_detected_at: "2026-10-10T00:00:00Z",
    last_seen_at: "2026-10-10T00:00:00Z", occurrences: 1, resolution_note: null, payload: {},
  });

  it("encerrada sem custo com alerta aberto: sem botão Apagar e com o texto que manda resolver", () => {
    setInstances();
    mocks.alerts = { isLoading: false, isError: false, data: [alertaDe("i-teste", "OPEN")] };
    renderAt("/platform/instancias-whatsapp?aba=encerradas");
    expect(screen.queryByRole("button", { name: "Apagar" })).toBeNull();
    expect(screen.getByText("Resolva os alertas abertos para poder apagar.")).toBeTruthy();
  });

  it("alerta ACKNOWLEDGED também bloqueia; alerta RESOLVED não", () => {
    setInstances();
    mocks.alerts = { isLoading: false, isError: false, data: [alertaDe("i-teste", "ACKNOWLEDGED")] };
    renderAt("/platform/instancias-whatsapp?aba=encerradas");
    expect(screen.queryByRole("button", { name: "Apagar" })).toBeNull();
    cleanup();
    mocks.alerts = { isLoading: false, isError: false, data: [alertaDe("i-teste", "RESOLVED")] };
    renderAt("/platform/instancias-whatsapp?aba=encerradas");
    expect(screen.getByRole("button", { name: "Apagar" })).toBeTruthy();
    expect(screen.queryByText("Resolva os alertas abertos para poder apagar.")).toBeNull();
  });

  it("alerta aberto de OUTRA instância não esconde o Apagar desta", () => {
    setInstances();
    mocks.alerts = { isLoading: false, isError: false, data: [alertaDe("i-custo", "OPEN")] };
    renderAt("/platform/instancias-whatsapp?aba=encerradas");
    expect(screen.getAllByRole("button", { name: "Apagar" })).toHaveLength(1);
    expect(screen.queryByText("Resolva os alertas abertos para poder apagar.")).toBeNull();
  });

  it("alertas carregando ou com erro: fail-closed, sem botão Apagar e sem o texto", () => {
    setInstances();
    mocks.alerts = { isLoading: true, isError: false, data: undefined };
    renderAt("/platform/instancias-whatsapp?aba=encerradas");
    expect(screen.queryByRole("button", { name: "Apagar" })).toBeNull();
    expect(screen.queryByText("Resolva os alertas abertos para poder apagar.")).toBeNull();
    cleanup();
    // Erro de refetch mantém o dado velho no react-query: o alerta aberto ainda
    // está em `data`, e mesmo assim a tela não pode afirmar nada (fail-closed).
    mocks.alerts = { isLoading: false, isError: true, data: [alertaDe("i-teste", "OPEN")] };
    renderAt("/platform/instancias-whatsapp?aba=encerradas");
    expect(screen.queryByRole("button", { name: "Apagar" })).toBeNull();
    expect(screen.queryByText("Resolva os alertas abertos para poder apagar.")).toBeNull();
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
