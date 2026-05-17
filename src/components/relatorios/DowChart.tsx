import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { DowFlow } from "@/hooks/useFluxoClientes";
import type { FluxoTabKey } from "./FluxoLineChart";

const COLORS = {
  reserva: "hsl(var(--chart-reserva))",
  fila: "hsl(var(--chart-fila))",
  passante: "hsl(var(--chart-passante))",
};

interface DowChartProps {
  data: DowFlow[];
  tab: FluxoTabKey;
  /** "mesas" ou "pessoas" — toggle do header da Get In. */
  unit: "mesas" | "pessoas";
}

export function DowChart({ data, tab, unit }: DowChartProps) {
  const series = data.map((d) => ({
    label: d.label,
    reserva: unit === "mesas" ? d.reserva_mesas : d.reserva_pessoas,
    fila: unit === "mesas" ? d.fila_mesas : d.fila_pessoas,
    passante: unit === "mesas" ? d.passante_mesas : d.passante_pessoas,
  }));

  const showAll = tab === "geral";

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={series} margin={{ top: 8, right: 12, bottom: 4, left: -8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis
          dataKey="label"
          stroke="hsl(var(--muted-foreground))"
          fontSize={11}
          tickLine={false}
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
        />
        {showAll && <Legend wrapperStyle={{ fontSize: 12 }} />}
        {showAll ? (
          <>
            <Bar dataKey="reserva" name="Reservas" stackId="a" fill={COLORS.reserva} />
            <Bar dataKey="fila" name="Filas" stackId="a" fill={COLORS.fila} />
            <Bar dataKey="passante" name="Passantes" stackId="a" fill={COLORS.passante} />
          </>
        ) : (
          <Bar
            dataKey={tab}
            name={tab}
            fill={
              tab === "reserva"
                ? COLORS.reserva
                : tab === "fila"
                ? COLORS.fila
                : COLORS.passante
            }
          />
        )}
      </BarChart>
    </ResponsiveContainer>
  );
}
