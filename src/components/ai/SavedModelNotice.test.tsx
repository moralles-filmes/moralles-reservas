// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SavedModelNotice } from "./SavedModelNotice";

afterEach(cleanup);

describe("SavedModelNotice", () => {
  it("aposentado: avisa o sucessor em uso e pede confirmação", () => {
    render(<SavedModelNotice provider="claude" saved="claude-haiku-4-5" />);
    const aviso = screen.getByRole("status");
    expect(aviso.textContent).toContain("claude-haiku-4-5");
    expect(aviso.textContent).toContain("aposentado — em uso: Claude Haiku 5.5 (confirme)");
  });

  it("desconhecido: avisa que está usando o padrão do provedor", () => {
    render(<SavedModelNotice provider="gemini" saved="gemini-2.0-flash" />);
    const aviso = screen.getByRole("status");
    expect(aviso.textContent).toContain("gemini-2.0-flash");
    expect(aviso.textContent).toContain("descontinuado — usando o padrão Gemini 2.5 Flash");
  });

  it("vazio com padrão não verificado: diz qual é o padrão e mostra o selo", () => {
    render(<SavedModelNotice provider="claude" saved={undefined} />);
    expect(screen.getByText("não testado em produção")).toBeTruthy();
    expect(screen.getByText(/padrão: Claude Haiku 5\.5/)).toBeTruthy();
  });

  it("vazio com padrão verificado: nada a avisar", () => {
    const { container } = render(<SavedModelNotice provider="gemini" saved="" />);
    expect(container.textContent).toBe("");
  });

  it("ativo que nunca rodou em produção: mostra o selo 'não testado em produção'", () => {
    render(<SavedModelNotice provider="gemini" saved="gemini-3.8-flash" />);
    expect(screen.getByText("não testado em produção")).toBeTruthy();
    expect(screen.queryByText(/aposentado/)).toBeNull();
    expect(screen.queryByText(/descontinuado/)).toBeNull();
  });

  it("ativo verificado em produção: não renderiza nada", () => {
    const { container } = render(<SavedModelNotice provider="gemini" saved="gemini-2.5-flash" />);
    expect(container.innerHTML).toBe("");
  });

  it("vazio (padrão): não renderiza nada", () => {
    const { container } = render(<SavedModelNotice provider="gemini" saved="" />);
    expect(container.innerHTML).toBe("");
    cleanup();
    const outro = render(<SavedModelNotice provider="gemini" saved={undefined} />);
    expect(outro.container.innerHTML).toBe("");
  });
});
