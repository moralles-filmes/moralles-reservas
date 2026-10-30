import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

interface OccupancyByHourChartProps {
  data: Array<{ hour: string; count: number }>;
}

export function OccupancyByHourChart({ data }: OccupancyByHourChartProps) {
  const summary = data.length
    ? `Ocupação por horário, ${data.length} ${data.length === 1 ? "horário" : "horários"}`
    : "Sem dados de ocupação por horário";
  return (
    <>
      <div role="img" aria-label={summary} className="h-full w-full">
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: -16 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
        <XAxis
          dataKey="hour"
          tick={{ fill: "hsl(var(--muted-foreground))" }}
          fontSize={11}
          tickLine={false}
          axisLine={{ stroke: "hsl(var(--border))" }}
        />
        <YAxis
          tick={{ fill: "hsl(var(--muted-foreground))" }}
          fontSize={11}
          tickLine={false}
          axisLine={{ stroke: "hsl(var(--border))" }}
          allowDecimals={false}
        />
        <Tooltip
          cursor={{ fill: "hsl(var(--muted))" }}
          contentStyle={{
            background: "hsl(var(--popover))",
            border: "1px solid hsl(var(--border))",
            borderRadius: 16,
            color: "hsl(var(--popover-foreground))",
            fontSize: 12,
          }}
          labelStyle={{ color: "hsl(var(--popover-foreground))" }}
          formatter={(value: number) => [value, "Reservas"]}
        />
        <Bar dataKey="count" fill="hsl(var(--chart-reserva))" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
      </div>
    <ul className="sr-only">
      {data.map(({ hour, count }) => <li key={hour}>{`${hour}: ${count} ${count === 1 ? "reserva" : "reservas"}`}</li>)}
    </ul>
    </>
  );
}
