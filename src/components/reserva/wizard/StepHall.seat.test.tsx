// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import type { PublicHall, SeatMap, SeatMapResponse } from "@/types/reserva";
import { StepHall } from "./StepHall";
import { WizardSummary } from "./WizardSummary";
import { WizardSuccess } from "./WizardSuccess";
import { useReservaWizard, WizardContext, type WizardContextValue } from "./useReservaWizard";

const { invoke, mutateAsync, toastError } = vi.hoisted(() => ({ invoke: vi.fn(), mutateAsync: vi.fn(), toastError: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ supabase: { functions: { invoke } } }));
vi.mock("@/hooks/useReservas", () => ({ useCreateReserva: () => ({ mutateAsync, isPending: false }) }));
vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }));
vi.mock("@/components/planta/escolha/CenaEscolha", () => ({ CenaEscolha: ({ onChoose, selected }) => (
  <button aria-pressed={selected?.id === "table-12"} onClick={() => onChoose({ kind: "table", id: "table-12" }, "Mesa 12")}>Mesa livre 12</button>
) }));
const map: SeatMap = {
  hall: { id: "hall", name: "Salão", plan: { widthCm: 500, depthCm: 500, entranceWall: null, entranceOffsetCm: null, windowWalls: [] } },
  tables: [{ id: "table-12", number: 12, plan: null, bookable: true, available: true }],
  options: [{ choice: { kind: "table", id: "table-12" }, tableIds: ["table-12"], available: true, minCapacity: 1, maxCapacity: 4 }],
};
const hall = { id: "hall", name: "Salão", schedules: [], tables: [] } as unknown as PublicHall;
const input = { unit: { id: "unit", name: "Restaurante", organization_id: "org" }, halls: [hall], customFields: [], widgetConfig: undefined, widgetId: undefined, bookingWindowDays: undefined };
let wizard: WizardContextValue;
function Harness() {
  wizard = useReservaWizard(input);
  // A disponibilidade tem testes próprios; aqui o salão escolhido já é compatível.
  const context = { ...wizard, computed: { ...wizard.computed, partition: { compatible: [hall], alternative: [], closed: [] } } };
  return <WizardContext.Provider value={context}><StepHall /><WizardSummary includeHall /><WizardSuccess /></WizardContext.Provider>;
}
async function setup(response: SeatMapResponse = { ok: true, map, unit: { name: "Restaurante" }, hall_id: "hall", date: "2026-11-20", time: "19:00", party_size: 2, whatsapp_phone: null }) {
  invoke.mockResolvedValue({ data: response, error: null });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>);
  act(() => {
    wizard.actions.set("date", "2026-11-20"); wizard.actions.set("time", "19:00");
    wizard.actions.set("hall_id", "hall"); wizard.actions.goToStep(3);
    wizard.actions.set("name", "Ana Silva"); wizard.actions.set("email", "ana@example.com"); wizard.actions.set("phone", "11999998888");
  });
  await waitFor(() => expect(invoke).toHaveBeenCalled());
  await waitFor(() => expect(client.isFetching()).toBe(0));
  return client;
}
async function choose() {
  fireEvent.click(await screen.findByRole("button", { name: "Ver o salão e escolher minha mesa" }));
  expect(screen.getByRole("button", { name: "Confirmar mesa" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Mesa livre 12" }));
  expect(screen.getByRole("button", { name: "Mesa livre 12" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "Confirmar mesa" }));
}
beforeEach(() => { invoke.mockReset(); mutateAsync.mockReset(); toastError.mockReset(); });
it("mostra as duas preferências, confirma o rascunho no passo e no resumo, envia só kind/id e mostra a mesa no sucesso", async () => {
  await setup();
  expect(screen.getByRole("button", { name: "Não tenho preferência" })).toHaveAttribute("aria-pressed", "true");
  await choose();
  expect(screen.getAllByText(/Mesa 12 · até 4 pessoas/)).toHaveLength(2);
  mutateAsync.mockResolvedValue({ status: "confirmed", payment_status: "not_required", reservation_code: "ABC", date: "2026-11-20", time: "19:00", party_size: 2 });
  await act(async () => wizard.actions.submit());
  expect(mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ seat: { kind: "table", id: "table-12" } }));
  expect(screen.getByText("Mesa")).toBeInTheDocument();
  expect(screen.getByText("Mesa 12")).toBeInTheDocument();
});
it.each(["time", "date", "party_size", "hall_id"] as const)("limpa a mesa só quando %s muda", async key => {
  await setup(); await choose();
  act(() => wizard.actions.set(key, wizard.state[key]));
  expect(wizard.state.seat).not.toBeNull();
  act(() => { if (key === "party_size") wizard.actions.set(key, 3); else wizard.actions.set(key, "changed"); });
  expect(wizard.state.seat).toBeNull();
});
it.each(["seat_unavailable", "seat_choice_disabled"])("volta ao passo 2 e limpa a mesa com %s", async reason => {
  await setup(); await choose();
  mutateAsync.mockRejectedValue(Object.assign(new Error("Escolha outra mesa."), { reason }));
  await act(async () => wizard.actions.submit());
  expect(wizard.state.step).toBe(2); expect(wizard.state.seat).toBeNull();
  expect(toastError).toHaveBeenCalledWith(reason === "seat_choice_disabled" ? "A escolha de mesa não está disponível agora. Siga sem preferência." : "Escolha outra mesa.");
});
it.each([false, true])("esconde as opções sem planta ou com a chave desligada (%s)", async disabled => {
  await setup(disabled ? { ok: false, reason: "choice_disabled" } : { ok: true, map: { ...map, hall: { ...map.hall, plan: null } }, unit: { name: "Restaurante" }, hall_id: "hall", date: "2026-11-20", time: "19:00", party_size: 2, whatsapp_phone: null });
  expect(screen.queryByRole("button", { name: "Ver o salão e escolher minha mesa" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Não tenho preferência" })).not.toBeInTheDocument();
});
it("solta a mesa quando o mapa refeito não a tem mais disponível", async () => {
  const client = await setup(); await choose();
  expect(wizard.state.seat).not.toBeNull();
  invoke.mockResolvedValue({ data: { ok: true, map: { ...map, options: [{ ...map.options[0], available: false }] }, unit: { name: "Restaurante" }, hall_id: "hall", date: "2026-11-20", time: "19:00", party_size: 2, whatsapp_phone: null }, error: null });
  await act(async () => { await client.invalidateQueries({ queryKey: ["seat-map"] }); });
  await waitFor(() => expect(wizard.state.seat).toBeNull());
  expect(toastError).toHaveBeenCalledWith("A mesa escolhida não está mais disponível. Escolha outra ou siga sem preferência.");
});
