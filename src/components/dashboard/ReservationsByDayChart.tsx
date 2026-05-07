import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

interface ReservationsByDayChartProps {
  data: Array<{ date: string; label: string; confirmed: number; lost: number }>;
}

export function ReservationsByDayChart({ data }: ReservationsByDayChartProps) {
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
      <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} allowDecimals={false} />
      <Tooltip
        contentStyle={{
          background: "hsl(var(--popover))",
          border: "1px solid hsl(var(--border))",
          borderRadius: "var(--radius)",
          fontSize: 12,
        }}
        labelStyle={{ color: "hsl(var(--foreground))" }}
      />
      <Legend wrapperStyle={{ fontSize: 12 }} />
      <Line
        type="monotone"
        dataKey="confirmed"
        name="Confirmadas"
        stroke="hsl(var(--primary))"
        strokeWidth={2}
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
      </LineChart>
    </ResponsiveContainer>
  );
}
