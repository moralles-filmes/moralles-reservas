// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ArrivalsByHour3D } from "./ArrivalsByHour3D";
import type { ArrivalHour } from "@/lib/arrivals-today";

afterEach(cleanup);

const hours: ArrivalHour[] = [
  { hour: 19, label: "19h", reservations: 2, guests: 5, isPeak: true },
  { hour: 20, label: "20h", reservations: 1, guests: 1, isPeak: false },
];

describe("ArrivalsByHour3D", () => {
  it("lista acessível por hora", () => {
    render(<ArrivalsByHour3D hours={hours} />);
    expect(screen.getByText("19h: 2 reservas, 5 pessoas")).toBeInTheDocument();
    expect(screen.getByText("20h: 1 reserva, 1 pessoa")).toBeInTheDocument();
  });

  it("pico marcado", () => {
    const { container } = render(<ArrivalsByHour3D hours={hours} />);
    expect(container.querySelector('[data-hour="19"]')).toHaveAttribute("data-peak", "true");
    expect(container.querySelector('[data-hour="20"]')).toHaveAttribute("data-peak", "false");
  });

  it("animação só com movimento permitido", () => {
    const { container } = render(<ArrivalsByHour3D hours={hours} />);
    const bars = container.querySelectorAll("[data-hour]");
    bars.forEach((bar) => {
      const classes = Array.from(bar.classList);
      expect(classes).toContain("motion-safe:animate-rise");
      expect(classes.filter((name) => name.startsWith("animate-") && !name.startsWith("motion-safe:")).length).toBe(0);
    });
  });

  it("rótulo do gráfico", () => {
    render(<ArrivalsByHour3D hours={hours} />);
    expect(screen.getByRole("img")).toHaveAttribute("aria-label", "Pico às 19h, com 2 reservas");
  });
});
