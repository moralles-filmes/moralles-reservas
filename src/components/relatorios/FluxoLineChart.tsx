import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { DailyFlow } from "@/hooks/useFluxoClientes";

export type FluxoTabKey = "geral" | "reserva" | "fila" | "passante";

const COLORS: Record<FluxoTabKey, string> = {
  geral: "hsl(var(--chart-geral))",
  reserva: "hsl(var(--chart-reserva))",
  fila: "hsl(var(--chart-fila))",
  passante: "hsl(var(--chart-passante))",
};

const LABELS: Record<FluxoTabKey, string> = {
  geral: "Mesas",
  reserva: "Reservas",
  fila: "Fila",
  passante: "Passante",
};

interface FluxoLineChartProps {
  data: DailyFlow[];
  tab: FluxoTabKey;
}

function valueFor(d: DailyFlow, tab: FluxoTabKey): number {
  switch (tab) {
    case "reserva":
      return d.reserva_mesas;
    case "fila":
      return d.fila_mesas;
    case "passante":
      return d.passante_mesas;
    case "geral":
      return d.reserva_mesas + d.fila_mesas + d.passante_mesas;
  }
}

export function FluxoLineChart({ data, tab }: FluxoLineChartProps) {
  const series = data.map((d) => ({
    label: d.label,
    value: valueFor(d, tab),
  }));

  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={series} margin={{ top: 8, right: 12, bottom: 4, left: -16 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis
          dataKey="label"
          stroke="hsl(var(--muted-foreground))"
          fontSize={11}
          tickLine={false}
          interval="preserveStartEnd"
          minTickGap={20}
        />
        <YAxis
          stroke="hsl(var(--muted-foreground))"
          fontSize={11}
          tickLine={false}
          allowDecimals={false}
        />
        <Tooltip
          contentStyle={{
            background: "hsl(var(--popover))",
            border: "1px solid hsl(var(--border))",
            borderRadius: "var(--radius)",
            fontSize: 12,
          }}
          labelStyle={{ color: "hsl(var(--foreground))" }}
        />
        <Line
          type="monotone"
          dataKey="value"
          name={LABELS[tab]}
          stroke={COLORS[tab]}
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4 }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
