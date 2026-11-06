import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { SeatChoice, SeatMap, SeatMapResponse } from "@/types/reserva";

const useSeatMapMock = vi.fn();
vi.mock("@/components/planta/escolha/useSeatMap", () => ({
  useSeatMap: (input: unknown) => useSeatMapMock(input),
}));

// A cena real (3D/2D) é testada em CenaEscolha.test.tsx; aqui um stub que escolhe.
vi.mock("@/components/planta/escolha/CenaEscolha", () => ({
  CenaEscolha: ({ onChoose }: { onChoose: (c: SeatChoice, label: string) => void }) => (
    <div>
      <button type="button" onClick={() => onChoose({ kind: "table", id: "t12" }, "Mesa 12")}>escolher 12</button>
      <button type="button" onClick={() => onChoose({ kind: "combination", id: "c1" }, "Mesas 3+4+5")}>escolher 3+4+5</button>
    </div>
  ),
}));

const toastSuccess = vi.fn();
vi.mock("sonner", () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), error: vi.fn() } }));

import EscolherMesa from "./EscolherMesa";
import { buildChoiceMessage } from "@/components/planta/escolha/seat-label";

const map: SeatMap = {
  hall: { id: "h1", name: "Salão principal", plan: { widthCm: 800, depthCm: 600, entranceWall: null, entranceOffsetCm: null, windowWalls: [] } },
  tables: [{ id: "t12", number: 12, plan: { x: 10, y: 10, w: 80, h: 80, rotation: 0, shape: "square" }, bookable: true, available: true }],
  options: [{ choice: { kind: "table", id: "t12" }, tableIds: ["t12"], available: true, minCapacity: 1, maxCapacity: 4 }],
};

function okResponse(phone: string | null, over: Partial<Extract<SeatMapResponse, { ok: true }>> = {}): SeatMapResponse {
  return {
    ok: true, unit: { name: "Moralles Centro" }, hall_id: "h1", date: "2026-11-07", time: "20:00:00", party_size: 4, map,
    channel: "whatsapp", whatsapp_phone: phone, instagram_username: null, ...over,
  };
}
const instagram = (username: string | null) => okResponse(null, { channel: "instagram", instagram_username: username });

function setQuery(data: SeatMapResponse | undefined, extra: Record<string, unknown> = {}) {
  useSeatMapMock.mockReturnValue({ data, isLoading: false, isFetching: false, isError: false, refetch: vi.fn(), ...extra });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/mesa/tok-abc"]}>
      <Routes><Route path="/mesa/:token" element={<EscolherMesa />} /></Routes>
    </MemoryRouter>,
  );
}

const voltar = () => screen.getByRole("link", { name: "Voltar para o WhatsApp" });

describe("EscolherMesa", () => {
  beforeEach(() => {
    useSeatMapMock.mockReset();
    toastSuccess.mockReset();
  });

  it("monta a mensagem no singular e no plural", () => {
    expect(buildChoiceMessage("Mesa 12")).toBe("Quero a mesa 12");
    expect(buildChoiceMessage("Mesas 3+4+5")).toBe("Quero as mesas 3+4+5");
  });

  it("consulta o mapa só pelo token do link", () => {
    setQuery(okResponse("5511999998888"));
    renderPage();
    expect(useSeatMapMock).toHaveBeenCalled();
    for (const [input] of useSeatMapMock.mock.calls) expect(input).toEqual({ token: "tok-abc" });
  });

  it("mostra unidade, data, horário e pessoas do link", () => {
    setQuery(okResponse("5511999998888"));
    renderPage();
    expect(screen.getByRole("heading", { name: "Moralles Centro" })).toBeInTheDocument();
    expect(screen.getByText(/07\/11\/2026 · 20:00 · 4 pessoas/)).toBeInTheDocument();
  });

  it("antes de escolher, o botão de voltar aparece sem texto pronto", () => {
    setQuery(okResponse("5511999998888"));
    renderPage();
    expect(voltar()).toHaveAttribute("href", "https://wa.me/5511999998888");
  });

  it("depois de escolher, volta ao WhatsApp com 'Quero a mesa 12' codificado", () => {
    setQuery(okResponse("5511999998888"));
    renderPage();
    fireEvent.click(screen.getByText("escolher 12"));
    expect(screen.getByText("Mesa 12 escolhida")).toBeInTheDocument();
    expect(voltar()).toHaveAttribute("href", `https://wa.me/5511999998888?text=${encodeURIComponent("Quero a mesa 12")}`);
  });

  it("combinação gera 'Quero as mesas 3+4+5'", () => {
    setQuery(okResponse("5511999998888"));
    renderPage();
    fireEvent.click(screen.getByText("escolher 3+4+5"));
    expect(voltar().getAttribute("href")).toBe(`https://wa.me/5511999998888?text=${encodeURIComponent("Quero as mesas 3+4+5")}`);
  });

  it("sem número do canal, mostra a mensagem e o botão de copiar", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    setQuery(okResponse(null));
    renderPage();
    expect(screen.queryByRole("link", { name: "Voltar para o WhatsApp" })).toBeNull();
    fireEvent.click(screen.getByText("escolher 12"));
    expect(screen.getByText("Volte ao WhatsApp e envie: Quero a mesa 12")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copiar mensagem" }));
    expect(writeText).toHaveBeenCalledWith("Quero a mesa 12");
  });

  it("link expirado ou inválido mostra a mesma mensagem, sem barra de voltar", () => {
    setQuery({ ok: false, reason: "link_invalid" });
    renderPage();
    expect(screen.getByText("Este link expirou.")).toBeInTheDocument();
    expect(screen.getByText("Peça outro link na conversa.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Voltar para o WhatsApp" })).toBeNull();
  });

  it("escolha desligada pelo restaurante manda voltar ao WhatsApp", () => {
    setQuery({ ok: false, reason: "choice_disabled" });
    renderPage();
    expect(screen.getByText("A escolha de mesa não está disponível agora.")).toBeInTheDocument();
  });

  it("falha de carga oferece tentar de novo", () => {
    const refetch = vi.fn();
    setQuery(undefined, { isError: true, refetch });
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(refetch).toHaveBeenCalled();
  });

  it("sem mesa livre não mostra a cena", () => {
    setQuery({ ...okResponse("5511999998888"), map: { ...map, options: [{ ...map.options[0], available: false }] } } as SeatMapResponse);
    renderPage();
    expect(screen.getByText("Não há mesa livre para escolher nesse horário.")).toBeInTheDocument();
    expect(screen.queryByText("escolher 12")).toBeNull();
    // A barra não pede para escolher quando não há o que escolher.
    expect(screen.queryByText("Escolha a mesa ou volte quando quiser.")).toBeNull();
    expect(screen.getAllByText("Volte ao WhatsApp para seguir com a sua reserva.").length).toBeGreaterThan(0);
  });

  it("link do Instagram volta para o Direct da loja, sem texto pronto", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    setQuery(instagram("loja_moralles"));
    renderPage();
    const ig = () => screen.getByRole("link", { name: "Voltar para o Instagram" });
    expect(ig()).toHaveAttribute("href", "https://ig.me/m/loja_moralles");
    expect(screen.queryByRole("link", { name: "Voltar para o WhatsApp" })).toBeNull();
    fireEvent.click(screen.getByText("escolher 12"));
    expect(screen.getByText("Copie e envie no Instagram: Quero a mesa 12")).toBeInTheDocument();
    expect(ig()).toHaveAttribute("href", "https://ig.me/m/loja_moralles");
    fireEvent.click(screen.getByRole("button", { name: "Copiar mensagem" }));
    expect(writeText).toHaveBeenCalledWith("Quero a mesa 12");
  });

  it("Instagram sem @ (conta desconectada): sem botão de voltar, pede para enviar no Instagram", () => {
    setQuery(instagram(null));
    renderPage();
    expect(screen.queryByRole("link", { name: "Voltar para o Instagram" })).toBeNull();
    expect(screen.getByText("Escolha uma mesa e depois volte ao Instagram.")).toBeInTheDocument();
    fireEvent.click(screen.getByText("escolher 12"));
    expect(screen.getByText("Volte ao Instagram e envie: Quero a mesa 12")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copiar mensagem" })).toBeInTheDocument();
  });

  it("Instagram sem mesa livre manda voltar ao Instagram", () => {
    setQuery({ ...instagram("loja_moralles"), map: { ...map, options: [{ ...map.options[0], available: false }] } } as SeatMapResponse);
    renderPage();
    expect(screen.getAllByText("Volte ao Instagram para seguir com a sua reserva.").length).toBeGreaterThan(0);
  });

  it("sem canal conhecido, fala em voltar à conversa", () => {
    setQuery(okResponse(null, { channel: null }));
    renderPage();
    fireEvent.click(screen.getByText("escolher 12"));
    expect(screen.getByText("Volte à conversa e envie: Quero a mesa 12")).toBeInTheDocument();
  });

  it("carregando mostra o esqueleto", () => {
    setQuery(undefined, { isLoading: true });
    renderPage();
    expect(screen.getByLabelText("Carregando o salão")).toBeInTheDocument();
  });
});
