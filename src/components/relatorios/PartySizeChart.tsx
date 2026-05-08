import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { PartySizeBucket } from "@/hooks/useFluxoClientes";
import type { FluxoTabKey } from "./FluxoLineChart";

const COLORS = {
  reserva: "#10b981",
  fila: "#f97316",
  passante: "#374151",
};

interface PartySizeChartProps {
  data: PartySizeBucket[];
  tab: FluxoTabKey;
}

export function PartySizeChart({ data, tab }: PartySizeChartProps) {
  const showAll = tab === "geral";

  // Pra tab única, geramos só uma série + colore as barras pelo tipo
  const singleSeries = data.map((d) => ({
    bucket: d.bucket,
    value:
      tab === "reserva"
        ? d.reserva
        : tab === "fila"
        ? d.fila
        : tab === "passante"
        ? d.passante
        : 0,
  }));

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart
        data={showAll ? data : singleSeries}
        layout="vertical"
        margin={{ top: 8, right: 24, bottom: 4, left: 24 }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis
          type="number"
          stroke="hsl(var(--muted-foreground))"
          fontSize={11}
          tickLine={false}
          allowDecimals={false}
        />
        <YAxis
          type="category"
          dataKey="bucket"
          stroke="hsl(var(--muted-foreground))"
          fontSize={11}
          tickLine={false}
          width={50}
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
            <Bar dataKey="reserva" name="Reserva" stackId="a" fill={COLORS.reserva} />
            <Bar dataKey="fila" name="Fila" stackId="a" fill={COLORS.fila} />
            <Bar dataKey="passante" name="Passante" stackId="a" fill={COLORS.passante} />
          </>
        ) : (
          <Bar dataKey="value" name={tab}>
            {singleSeries.map((_, i) => (
              <Cell
                key={i}
                fill={
                  tab === "reserva"
                    ? COLORS.reserva
                    : tab === "fila"
                    ? COLORS.fila
                    : COLORS.passante
                }
              />
            ))}
          </Bar>
        )}
      </BarChart>
    </ResponsiveContainer>
  );
}
