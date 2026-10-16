// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
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

const renderAt = (url: string) =>
  render(
    <MemoryRouter initialEntries={[url]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <WhatsappInstances />
    </MemoryRouter>,
  );

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
});
