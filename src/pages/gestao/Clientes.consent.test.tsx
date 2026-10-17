import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Clientes, { CustomerPromotionalConsentStatus } from "./Clientes";

const io = vi.hoisted(() => ({
  invoke: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
  unit: { unit_id: "10000000-0000-4000-8000-000000000001", organization_id: "30000000-0000-4000-8000-000000000001", isGerente: true, role: "owner" },
}));
vi.mock("@/lib/supabase", () => ({ supabase: { functions: { invoke: io.invoke }, from: io.from, rpc: io.rpc } }));
vi.mock("@/hooks/useCurrentUnit", () => ({ useCurrentUnit: () => io.unit }));
vi.mock("@/hooks/useCustomers", () => ({
  useUpdateCustomer: () => ({ isPending: false, mutate: vi.fn() }),
  useAnonymizeCustomer: () => ({ isPending: false, mutate: vi.fn() }),
  useCustomerStats: () => ({ data: null, isLoading: false, isError: false, refetch: vi.fn() }),
}));
vi.mock("@/components/gestao/CustomerStatsBlock", () => ({ CustomerStatsBlock: () => null }));

const unitA = "10000000-0000-4000-8000-000000000001";
const unitB = "10000000-0000-4000-8000-000000000002";
const customerA = "20000000-0000-4000-8000-000000000001";
const customerB = "20000000-0000-4000-8000-000000000002";
const consent = (status: "opt_in" | "opt_out" | "unknown") => ({
  data: { purpose: "promotional", status, revision: status === "unknown" ? null : 1 },
  error: null,
});

let client: QueryClient;
function show(unitId = unitA, customerId = customerA, canRead = true, doNotContact = false) {
  const props = { unitId, customerId, canRead, doNotContact };
  const view = render(
    <QueryClientProvider client={client}>
      <CustomerPromotionalConsentStatus {...props} />
    </QueryClientProvider>,
  );
  return (next = props) => view.rerender(
    <QueryClientProvider client={client}>
      <CustomerPromotionalConsentStatus {...next} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", class {
    observe() { /* jsdom does not observe layout */ }
    unobserve() { /* no-op */ }
    disconnect() { /* no-op */ }
  });
  io.invoke.mockReset();
  io.from.mockReset();
  io.rpc.mockReset();
  io.unit.unit_id = unitA;
  io.unit.role = "owner";
  io.unit.isGerente = true;
  client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
});
afterEach(() => { cleanup(); client.clear(); vi.unstubAllGlobals(); });

describe("status promocional no detalhe de Clientes", () => {
  it.each([
    ["opt_in", "Autorizou ofertas por WhatsApp nesta unidade."],
    ["opt_out", "Não autorizou ofertas por WhatsApp nesta unidade."],
    ["unknown", "Nenhuma escolha sobre ofertas registrada nesta unidade."],
  ] as const)("exibe %s sem oferecer gravação", async (status, label) => {
    io.invoke.mockResolvedValue(consent(status));
    show();
    expect(screen.getByText("Consultando escolha do cliente…")).toBeInTheDocument();
    expect(await screen.findByText(label)).toBeInTheDocument();
    expect(io.invoke).toHaveBeenCalledWith("manage-whatsapp-templates", {
      body: { action: "consent_snapshot", unit_id: unitA, customer_id: customerA, purpose: "promotional" },
    });
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("não consulta nem exibe ao operador e aceita owner, gerente ou admin com papel owner", async () => {
    const rerender = show(unitA, customerA, false);
    expect(screen.queryByLabelText("Consentimento para ofertas")).not.toBeInTheDocument();
    expect(io.invoke).not.toHaveBeenCalled();
    io.invoke.mockResolvedValue(consent("opt_in"));
    rerender({ unitId: unitA, customerId: customerA, canRead: true, doNotContact: true });
    expect(await screen.findByText("Autorizou ofertas por WhatsApp nesta unidade.")).toBeInTheDocument();
    expect(screen.getByText(/Cliente marcado como “Não contatar”/)).toBeInTheDocument();
  });

  it("esconde o resultado anterior imediatamente ao trocar cliente e unidade", async () => {
    io.invoke.mockImplementation((_name, { body }) =>
      body.unit_id === unitA && body.customer_id === customerA
        ? Promise.resolve(consent("opt_in"))
        : new Promise(() => undefined),
    );
    const rerender = show();
    expect(await screen.findByText("Autorizou ofertas por WhatsApp nesta unidade.")).toBeInTheDocument();

    rerender({ unitId: unitA, customerId: customerB, canRead: true, doNotContact: false });
    expect(screen.getByText("Consultando escolha do cliente…")).toBeInTheDocument();
    expect(screen.queryByText("Autorizou ofertas por WhatsApp nesta unidade.")).not.toBeInTheDocument();

    rerender({ unitId: unitB, customerId: customerB, canRead: true, doNotContact: false });
    expect(screen.getByText("Consultando escolha do cliente…")).toBeInTheDocument();
    expect(screen.queryByText("Autorizou ofertas por WhatsApp nesta unidade.")).not.toBeInTheDocument();
    await waitFor(() => expect(io.invoke).toHaveBeenCalledWith("manage-whatsapp-templates", {
      body: { action: "consent_snapshot", unit_id: unitB, customer_id: customerB, purpose: "promotional" },
    }));
  });

  it("falha fechada e permite consultar novamente", async () => {
    io.invoke.mockResolvedValueOnce({ data: null, error: new Error("offline") }).mockResolvedValueOnce(consent("opt_out"));
    show();
    expect(await screen.findByText("Não foi possível consultar a escolha do cliente.")).toBeInTheDocument();
    expect(screen.queryByText("Nenhuma escolha sobre ofertas registrada nesta unidade.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(await screen.findByText("Não autorizou ofertas por WhatsApp nesta unidade.")).toBeInTheDocument();
  });

  it.each([
    ["owner", true, true],
    ["gerente", true, true],
    ["operador", false, false],
  ] as const)("respeita a visibilidade no detalhe para %s", async (role, isGerente, visible) => {
    io.unit.role = role;
    io.unit.isGerente = isGerente;
    io.invoke.mockResolvedValue(consent("opt_in"));
    io.rpc.mockResolvedValue({ data: [], error: null });
    io.from.mockImplementation(() => {
      let countOnly = false;
      const chain = {
        select: (_columns: string, options?: { head?: boolean }) => { countOnly = !!options?.head; return chain; },
        eq: () => chain,
        is: () => chain,
        order: () => chain,
        range: () => chain,
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(countOnly
          ? { count: 1, error: null }
          : { data: [{ id: customerA, name: "Cliente teste", phone: "11999990000", created_at: "2026-10-01", do_not_contact: false, emails: [] }], error: null }).then(resolve),
      };
      return chain;
    });
    render(<QueryClientProvider client={client}><Clientes /></QueryClientProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /Cliente teste/ }));
    if (visible) {
      expect(await screen.findByText("Autorizou ofertas por WhatsApp nesta unidade.")).toBeInTheDocument();
      expect(io.invoke).toHaveBeenCalledWith("manage-whatsapp-templates", {
        body: { action: "consent_snapshot", unit_id: unitA, customer_id: customerA, purpose: "promotional" },
      });
    } else {
      expect(screen.queryByLabelText("Consentimento para ofertas")).not.toBeInTheDocument();
      expect(io.invoke).not.toHaveBeenCalled();
    }
  });
});
