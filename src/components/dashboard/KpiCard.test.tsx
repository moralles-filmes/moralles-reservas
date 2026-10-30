import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Activity } from "lucide-react";
import { KpiStat } from "./KpiStat";
import { KpiStrip } from "./KpiStrip";

describe("KpiStat", () => {
  it("null, NaN e Infinity viram —", () => {
    const { rerender } = render(
      <KpiStat title="Ocupação" value={null} icon={Activity} color="bg-muted text-foreground" suffix="%" />
    );
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText("%")).not.toBeInTheDocument();

    rerender(<KpiStat title="Ocupação" value={NaN} icon={Activity} color="bg-muted text-foreground" suffix="%" />);
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText("%")).not.toBeInTheDocument();

    rerender(<KpiStat title="Ocupação" value={Infinity} icon={Activity} color="bg-muted text-foreground" suffix="%" />);
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText("%")).not.toBeInTheDocument();
  });

  it("sufixo só com número finito", () => {
    render(<KpiStat title="Taxa" value={12.34} icon={Activity} color="bg-muted text-foreground" suffix="%" />);
    expect(screen.getByText("12.3")).toBeInTheDocument();
    expect(screen.getByText("%")).toBeInTheDocument();
  });
});

describe("KpiStrip", () => {
  it("agrupa itens", () => {
    render(
      <KpiStrip>
        <KpiStat title="Reservas hoje" value={10} icon={Activity} color="bg-muted text-foreground" />
        <KpiStat title="Ocupação" value={42} icon={Activity} color="bg-muted text-foreground" />
        <KpiStat title="No-show" value={3} icon={Activity} color="bg-muted text-foreground" />
      </KpiStrip>
    );
    expect(screen.getByText("Reservas hoje")).toBeInTheDocument();
    expect(screen.getByText("Ocupação")).toBeInTheDocument();
    expect(screen.getByText("No-show")).toBeInTheDocument();
  });
});
