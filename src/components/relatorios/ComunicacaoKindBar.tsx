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
import type { KindBucket } from "@/hooks/useComunicacao";

interface ComunicacaoKindBarProps {
  data: KindBucket[];
}

export function ComunicacaoKindBar({ data }: ComunicacaoKindBarProps) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart
        data={data}
        margin={{ top: 8, right: 12, bottom: 4, left: -8 }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis
          dataKey="label"
          stroke="hsl(var(--muted-foreground))"
          fontSize={10}
          tickLine={false}
          angle={-15}
          textAnchor="end"
          height={50}
          interval={0}
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
        <Bar dataKey="sent" name="Enviadas" stackId="a" fill="#10b981" />
        <Bar dataKey="failed" name="Falhas" stackId="a" fill="#ef4444" />
        <Bar dataKey="skipped" name="Ignoradas" stackId="a" fill="#94a3b8" />
      </BarChart>
    </ResponsiveContainer>
  );
}
