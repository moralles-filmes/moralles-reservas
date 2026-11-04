import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import Privacidade from "./Privacidade";
import PrivacidadeExclusao from "./PrivacidadeExclusao";
import { LEGAL_IDENTITY } from "./legal-identity";

function renderAt(ui: JSX.Element) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe("páginas de privacidade", () => {
  it("têm a identificação do responsável preenchida", () => {
    expect(LEGAL_IDENTITY.companyName.trim()).not.toBe("");
    expect(LEGAL_IDENTITY.cnpj).toMatch(/^\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}$/);
    expect(LEGAL_IDENTITY.privacyEmail).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
  });

  it("a política mostra o responsável, o contato e o link para a exclusão", () => {
    renderAt(<Privacidade />);
    expect(screen.getByRole("heading", { level: 1, name: "Política de privacidade" })).toBeInTheDocument();
    expect(screen.getByText(new RegExp(LEGAL_IDENTITY.cnpj.replace(/[./-]/g, "\\$&")))).toBeInTheDocument();
    expect(screen.getByRole("link", { name: LEGAL_IDENTITY.privacyEmail })).toHaveAttribute(
      "href",
      `mailto:${LEGAL_IDENTITY.privacyEmail}`,
    );
    expect(screen.getByRole("link", { name: "exclusão de dados" })).toHaveAttribute("href", "/privacidade/exclusao-de-dados");
  });

  it("a exclusão explica o pedido e volta para a política", () => {
    renderAt(<PrivacidadeExclusao />);
    expect(screen.getByRole("heading", { level: 1, name: "Exclusão de dados" })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: LEGAL_IDENTITY.privacyEmail }).length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "política de privacidade" })).toHaveAttribute("href", "/privacidade");
    expect(screen.getByText(/O identificador do Instagram, o @ e o nome do perfil/)).toBeInTheDocument();
  });
});
