import { useId } from "react";
import {
  Area,
  ComposedChart,
  CartesianGrid,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

interface ReservationsByDayChartProps {
  data: Array<{ date: string; label: string; confirmed: number; lost: number }>;
}

const formatTick = { fill: "hsl(var(--muted-foreground))" };
export function ReservationsByDayChart({ data }: ReservationsByDayChartProps) {
  // useId tem ":" — inválido em url(#...) sem escape
  const gradientId = `reservas-dia-${useId().replace(/:/g, "")}`;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: -16 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="hsl(var(--chart-reserva))" stopOpacity={0.35} />
            <stop offset="100%" stopColor="hsl(var(--chart-reserva))" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis
          dataKey="label"
          tick={formatTick}
          fontSize={11}
          tickLine={false}
          axisLine={{ stroke: "hsl(var(--border))" }}
          interval="preserveStartEnd"
          minTickGap={20}
        />
        <YAxis
          tick={formatTick}
          fontSize={11}
          tickLine={false}
          axisLine={{ stroke: "hsl(var(--border))" }}
          allowDecimals={false}
        />
        <Tooltip
          contentStyle={{
            background: "hsl(var(--popover))",
            border: "1px solid hsl(var(--border))",
            borderRadius: 16,
            color: "hsl(var(--popover-foreground))",
            fontSize: 12,
          }}
          labelStyle={{ color: "hsl(var(--popover-foreground))" }}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Area
          type="monotone"
          dataKey="confirmed"
          name="Confirmadas"
          stroke="hsl(var(--chart-reserva))"
          strokeWidth={2}
          fill={`url(#${gradientId})`}
          dot={false}
          activeDot={{ r: 4 }}
        />
        <Line
          type="monotone"
          dataKey="lost"
          name="Cancel./No-show"
          stroke="hsl(var(--destructive))"
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4 }}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
