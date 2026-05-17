import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { DailyEnvio } from "@/hooks/useComunicacao";

interface ComunicacaoLineChartProps {
  data: DailyEnvio[];
  /** Se true, renderiza 2 linhas (WhatsApp + Email). Senão só total. */
  multiSeries?: boolean;
}

export function ComunicacaoLineChart({
  data,
  multiSeries = true,
}: ComunicacaoLineChartProps) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: -16 }}>
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
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        {multiSeries ? (
          <>
            <Line
              type="monotone"
              dataKey="whatsapp"
              name="WhatsApp"
              stroke="hsl(var(--chart-whatsapp))"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
            <Line
              type="monotone"
              dataKey="email"
              name="E-mail"
              stroke="hsl(var(--chart-email))"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
          </>
        ) : (
          <Line
            type="monotone"
            dataKey="total"
            name="Envios"
            stroke="hsl(var(--chart-passante))"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
          />
        )}
      </LineChart>
    </ResponsiveContainer>
  );
}
