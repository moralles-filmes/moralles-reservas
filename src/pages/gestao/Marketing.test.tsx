// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Marketing from "./Marketing";
import { saveMarketingDraft, type MarketingResults } from "@/features/marketing/api";

const mocks = vi.hoisted(() => ({
  unit: { unit_id: "a", unit_slug: "centro", isOwner: true, isGerente: true },
  admin: false, save: vi.fn(), archive: vi.fn(), refetch: vi.fn(), rpc: vi.fn(),
  query: { isLoading: false, isError: false, error: null, data: { drafts: [], rules: [] } as { drafts: unknown[]; rules: unknown[] } },
  results: { isLoading: false, isError: false, error: null, dataUpdatedAt: 1792500000000, data: { from: "2026-10-01", to: "2026-10-20", retention_start: "2026-07-20", legacy_available: false, managed_available: false, unknown_giftback_source: false, giftback: [], managed: [], legacy: { waitlist_feedback_sent: null } } as MarketingResults },
}));
vi.mock("@/lib/supabase", () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock("@/hooks/useCurrentUnit", () => ({ useCurrentUnit: () => mocks.unit }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ isPlatformAdmin: mocks.admin }) }));
vi.mock("@/hooks/useWaitlistSettings", () => ({ useWaitlistSettings: () => ({ isSuccess: true, data: { waitlist_feedback_enabled: false } }) }));
vi.mock("@/hooks/useWhatsappDispatchStatus", () => ({ useWhatsappDispatchStatus: () => ({ isSuccess: true, data: { entries: [
  { kind: "voucher_issued", readiness: "awaiting_dispatch" }, { kind: "waitlist_feedback", readiness: "pending_meta" },
] } }) }));
vi.mock("@/features/marketing/hooks", () => ({
  isMarketingPeriodValid: (from: string, to: string) => !!from && !!to && from <= to && (Date.parse(to) - Date.parse(from)) / 86400000 <= 365,
  useMarketingDrafts: () => ({ ...mocks.query, refetch: mocks.refetch }),
  useMarketingResults: () => ({ ...mocks.results, refetch: mocks.refetch }),
  useMarketingMutations: () => ({ save: { mutateAsync: mocks.save, isPending: false }, archive: { mutateAsync: mocks.archive, isPending: false } }),
}));
function SwitchUnit() {
  const navigate = useNavigate();
  return <button onClick={() => { mocks.unit = { ...mocks.unit, unit_id: "b", unit_slug: "praia" }; navigate("/g/praia/marketing/campanhas"); }}>Trocar unidade</button>;
}
function renderPage(section = "campanhas") {
  return render(<MemoryRouter initialEntries={[`/g/centro/marketing/${section}`]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><Routes><Route path="/g/:unitSlug/marketing/:section" element={<><SwitchUnit /><Marketing /></>} /></Routes></MemoryRouter>);
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.unit = { unit_id: "a", unit_slug: "centro", isOwner: true, isGerente: true };
  mocks.admin = false; mocks.query.isError = false; mocks.query.data = { drafts: [], rules: [] };
  mocks.save.mockResolvedValue({});
  mocks.results.data.giftback = []; mocks.results.data.managed = []; mocks.results.data.managed_available = false;
});
describe("Marketing", () => {
  it("salva pesquisa somente como rascunho e não oferece ativação ou envio", async () => {
    renderPage();
    expect(screen.getByText("Pesquisa pós-fila atual: desabilitada.")).toBeInTheDocument();
    expect(screen.getByText(/Aguardando análise da Meta/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Planejar rascunho" })[2]);
    fireEvent.click(screen.getByRole("button", { name: "Salvar rascunho" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith({ input: expect.objectContaining({ program: "waitlist_feedback", voucher_rule_id: null }), draft: undefined }));
    expect(screen.queryByRole("button", { name: /^(Ativar|Enviar|Submeter)/i })).toBeNull();
    expect(screen.getByText(/Custo Meta não apurado/)).toBeInTheDocument();
  });
  it.each(["gerente", "admin"])("%s consulta sem controles de escrita", (role) => {
    mocks.unit.isOwner = role === "admin";
    mocks.admin = role === "admin";
    renderPage();
    expect(screen.queryByRole("button", { name: "Planejar rascunho" })).toBeNull();
    expect(screen.getByText(/Somente o proprietário/)).toBeInTheDocument();
  });
  it("mostra validação de período sem chamar a gravação", async () => {
    renderPage();
    fireEvent.click(screen.getAllByRole("button", { name: "Planejar rascunho" })[2]);
    fireEvent.change(screen.getByLabelText("Início pretendido (opcional)"), { target: { value: "2026-10-20" } });
    fireEvent.change(screen.getByLabelText("Fim pretendido (opcional)"), { target: { value: "2026-10-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar rascunho" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Revise os campos");
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("operador não acessa a área", () => {
    mocks.unit.isOwner = false; mocks.unit.isGerente = false;
    renderPage();
    expect(screen.getByRole("alert")).toHaveTextContent("Você não tem acesso");
    expect(screen.queryByText("Campanhas")).toBeNull();
  });
  it("erro não vira estado vazio e permite tentar novamente", () => {
    mocks.query.isError = true;
    renderPage();
    expect(screen.queryByText(/Nenhum rascunho/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(mocks.refetch).toHaveBeenCalled();
  });
  it("fecha edição com revisão vencida após recarregar a lista", async () => {
    mocks.query.data = { drafts: [{ id: "draft", program: "waitlist_feedback", voucher_rule_id: null, title: "Pesquisa", status: "draft", revision: 1, start_date: null, end_date: null, proposed_daily_contacts: null, proposed_daily_messages: null }], rules: [] };
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: "40001", message: "stale" } });
    const conflict = await saveMarketingDraft("00000000-0000-4000-8000-000000000001", { program: "waitlist_feedback", voucher_rule_id: null, title: "Pesquisa", start_date: null, end_date: null, proposed_daily_contacts: null, proposed_daily_messages: null }).catch((error) => error);
    mocks.save.mockRejectedValueOnce(conflict);
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Editar rascunho" }));
    fireEvent.click(screen.getByRole("button", { name: "Salvar rascunho" }));
    await waitFor(() => expect(screen.queryByLabelText("Nome do rascunho")).toBeNull());
    expect(mocks.refetch).toHaveBeenCalled();
  });
  it("descarta formulário aberto ao trocar de unidade", () => {
    renderPage();
    fireEvent.click(screen.getAllByRole("button", { name: "Planejar rascunho" })[2]);
    fireEvent.change(screen.getByLabelText("Nome do rascunho"), { target: { value: "Plano da unidade A" } });
    fireEvent.click(screen.getByRole("button", { name: "Trocar unidade" }));
    expect(screen.queryByLabelText("Nome do rascunho")).toBeNull();
    expect(screen.queryByDisplayValue("Plano da unidade A")).toBeNull();
    expect(screen.getByRole("link", { name: "Campanhas" })).toHaveAttribute("href", "/g/praia/marketing/campanhas");
  });
  it("sinaliza regra alterada e exige nova seleção ao editar", async () => {
    mocks.query.data = {
      drafts: [{ id: "draft", program: "birthday_voucher", voucher_rule_id: "changed", voucher_rule_name: "Antigo aniversário", title: "Meu plano", status: "draft", start_date: null, end_date: null, proposed_daily_contacts: null, proposed_daily_messages: null }],
      rules: [{ id: "changed", name: "Agora frequência", trigger_type: "frequency", active: true }, { id: "available", name: "Aniversário atual", trigger_type: "birthday", active: true }],
    };
    renderPage();
    expect(screen.getByText("Regra removida ou alterada — selecione outra regra para este rascunho")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Editar rascunho" }));
    expect(screen.getByLabelText("Regra Giftback")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Salvar rascunho" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Revise os campos");
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("métrica fora da retenção aparece indisponível e legado fica separado", () => {
    renderPage("resultados");
    expect(screen.getByText(/Métricas gerenciadas indisponíveis/)).toBeInTheDocument();
    expect(screen.queryByText("Intenções únicas")).toBeNull();
    expect(screen.getByText("Histórico legado · pesquisa após a fila")).toBeInTheDocument();
  });
  it("agrupa Giftback por regra sem atribuir gatilho e preserva pesquisa ao filtrar regra", () => {
    mocks.results.data.managed_available = true;
    const ruleId = "00000000-0000-4000-8000-000000000004";
    mocks.results.data.giftback = [{ program: "giftback_rule", rule_id: ruleId, rule_name: "Benefício atual", issued: 6001, redeemed_cohort: 1, redeemed_in_period: 1 }];
    mocks.results.data.managed = [{ channel_kind: "official", program: "waitlist_feedback", rule_id: null, rule_name: null, intentions: 7, accepted: 6, delivered: 5, read: 4, uncertain: 1, pending: 0, failed: 0 }];
    renderPage("resultados");
    expect(screen.getByText(/classificação histórica por aniversário ou frequência não é verificável/)).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Aniversário com voucher" })).toBeNull();
    expect(screen.getByText("6.001")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Regra Giftback"), { target: { value: ruleId } });
    expect(screen.getByText("Intenções únicas")).toBeInTheDocument();
    expect(screen.getByText("Histórico legado · pesquisa após a fila")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Programa"), { target: { value: "waitlist_feedback" } });
    expect(screen.getByLabelText("Regra Giftback")).toBeDisabled();
    expect(screen.queryByText("Nenhum resultado Giftback para os filtros escolhidos.")).toBeNull();
  });
  it("separa provedores de texto dos oficiais e limpa a regra ao mudar o período", () => {
    const ruleId = "00000000-0000-4000-8000-000000000004";
    mocks.results.data.managed_available = true;
    mocks.results.data.giftback = [{ program: "giftback_rule", rule_id: ruleId, rule_name: "Regra atual", issued: 1, redeemed_cohort: 0, redeemed_in_period: 0 }];
    mocks.results.data.managed = [
      { channel_kind: "official", program: "waitlist_feedback", rule_id: null, rule_name: null, intentions: 2, accepted: 1, delivered: 0, read: 0, uncertain: 0, pending: 1, failed: 0 },
      { channel_kind: "text", program: "waitlist_feedback", rule_id: null, rule_name: null, intentions: 3, accepted: 2, delivered: 0, read: 0, uncertain: 0, pending: 1, failed: 0 },
    ];
    renderPage("resultados");
    expect(screen.getByText("WhatsApp oficial gerenciado")).toBeInTheDocument();
    expect(screen.getByText("Outros canais gerenciados")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Regra Giftback"), { target: { value: ruleId } });
    fireEvent.change(screen.getByLabelText("De"), { target: { value: "2026-10-02" } });
    expect(screen.getByLabelText("Regra Giftback")).toHaveValue("all");
  });
});
