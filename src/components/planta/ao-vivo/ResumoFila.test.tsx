// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WaitlistEntry } from "@/types/reserva";
import { ResumoFila } from "./ResumoFila";

const NOW = new Date("2026-11-03T18:00:00Z"); // 15:00 BRT
const entry = (id: string, created_at: string, name: string) =>
  ({ id, created_at, customer_name: name, party_size: 2 }) as unknown as WaitlistEntry;

describe("ResumoFila", () => {
  it("ignora entradas esquecidas de dias anteriores na espera média e no próximo", () => {
    render(
      <ResumoFila
        now={NOW}
        entries={[
          entry("velha", "2026-10-20T15:00:00Z", "Esquecida"),
          entry("a", "2026-11-03T17:00:00Z", "Ana"), // 60 min
          entry("b", "2026-11-03T17:40:00Z", "Beto"), // 20 min
        ]}
      />,
    );
    const resumo = screen.getByTestId("resumo-fila");
    expect(resumo).toHaveTextContent("2 grupos aguardando");
    expect(resumo).toHaveTextContent("Próximo: Ana");
    expect(resumo).not.toHaveTextContent("Esquecida");
    expect(resumo).toHaveTextContent("Espera média: 40 min");
  });

  it("só entradas antigas → Ninguém aguardando", () => {
    render(<ResumoFila now={NOW} entries={[entry("velha", "2026-10-20T15:00:00Z", "Esquecida")]} />);
    expect(screen.getByTestId("resumo-fila")).toHaveTextContent("Ninguém aguardando");
  });

  it("Chamar no WhatsApp chama onCall com o próximo; sem telefone fica desabilitado", () => {
    const onCall = vi.fn();
    const a = { ...entry("a", "2026-11-03T17:00:00Z", "Ana"), customer_phone: "11999999999" } as WaitlistEntry;
    const { unmount } = render(<ResumoFila now={NOW} entries={[a]} onCall={onCall} />);
    fireEvent.click(screen.getByRole("button", { name: "Chamar no WhatsApp" }));
    expect(onCall).toHaveBeenCalledWith(a);
    unmount();
    const b = { ...a, customer_phone: null } as WaitlistEntry;
    render(<ResumoFila now={NOW} entries={[b]} onCall={onCall} />);
    expect(screen.getByRole("button", { name: "Sem WhatsApp cadastrado" })).toBeDisabled();
  });
});
