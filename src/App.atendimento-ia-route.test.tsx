import { render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import App from "./App";

// Mesmo arcabouço de App.preference-route.test.tsx: provedor de auth real sobre um supabase em memória.
const io = vi.hoisted(() => ({ role: "owner" as string }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      onAuthStateChange: (callback: (event: string, session: unknown) => void) => {
        callback("INITIAL_SESSION", { user: { id: "user" } });
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      },
      signOut: vi.fn().mockResolvedValue({}),
    },
    from: (table: string) => {
      const data =
        table === "platform_admins"
          ? null
          : [{ unit_id: "unit", role: io.role, unit: { slug: "unidade-a", name: "Unidade A", organization_id: "org", organization: { slug: "org" } } }];
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data, error: null }),
        then: (fn: (value: unknown) => unknown) => Promise.resolve({ data, error: null }).then(fn),
      };
      return chain;
    },
    channel: () => {
      const chain = { on: () => chain, subscribe: () => chain };
      return chain;
    },
    removeChannel: vi.fn(),
  },
}));
vi.mock("@/components/layouts/GestaoLayout", () => ({ GestaoLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/layouts/OperacionalLayout", () => ({ OperacionalLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/BillingGuard", () => ({ BillingGuard: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/ui/sonner", () => ({ Toaster: () => null }));
vi.mock("./pages/gestao/AtendimentoIa", () => ({ default: () => <h1>Tela do atendimento por IA</h1> }));
vi.mock("./pages/operacional/ReservasDia", () => ({ default: () => <h1>Painel operacional</h1> }));
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return {
    ...actual,
    BrowserRouter: (props: React.ComponentProps<typeof actual.BrowserRouter>) => (
      <actual.BrowserRouter {...props} future={{ v7_startTransition: true, v7_relativeSplatPath: true }} />
    ),
  };
});

beforeEach(() => {
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addListener: vi.fn(), removeListener: vi.fn() });
  io.role = "owner";
  window.history.pushState({}, "", "/g/unidade-a/atendimento-ia");
});

it.each(["owner", "gerente"])("/g/:unitSlug/atendimento-ia abre a tela para %s, atrás do GestaoGuard", async (role) => {
  io.role = role;
  render(<App />);
  expect(await screen.findByText("Tela do atendimento por IA")).toBeInTheDocument();
});

it("operador cai no painel operacional, nunca na tela (GestaoGuard)", async () => {
  io.role = "operador";
  render(<App />);
  expect(await screen.findByText("Painel operacional")).toBeInTheDocument();
  expect(screen.queryByText("Tela do atendimento por IA")).not.toBeInTheDocument();
});
