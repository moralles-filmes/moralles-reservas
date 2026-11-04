import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type {
  PassanteDaily,
  PassanteDow,
  PassanteHour,
  PassantePartySize,
} from "@/lib/relatorio-passantes";
import { bucketLabel } from "./format";

const TOOLTIP_STYLE = {
  background: "hsl(var(--popover))",
  border: "1px solid hsl(var(--border))",
  borderRadius: "var(--radius)",
  fontSize: 12,
};
const AXIS = { stroke: "hsl(var(--muted-foreground))", fontSize: 11, tickLine: false } as const;
const C_GROUPS = "hsl(var(--chart-passante))";
const C_PEOPLE = "hsl(var(--chart-geral))";

export type Metric = "groups" | "people";
const METRIC_NAME: Record<Metric, string> = { groups: "Grupos", people: "Pessoas" };
const MARGIN = { top: 8, right: 12, bottom: 4, left: -8 };

export function DailyChart({ data }: { data: PassanteDaily[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ ...MARGIN, left: -16 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis dataKey="label" {...AXIS} interval="preserveStartEnd" minTickGap={20} />
        <YAxis {...AXIS} allowDecimals={false} />
        <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: "hsl(var(--foreground))" }} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Line type="monotone" dataKey="seatedGroups" name="Grupos sentados" stroke={C_GROUPS} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
        <Line type="monotone" dataKey="seatedPeople" name="Pessoas sentadas" stroke={C_PEOPLE} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function HourChart({ data, metric }: { data: PassanteHour[]; metric: Metric }) {
  // Só a faixa com dados, com 1h de folga de cada lado.
  const active = data.filter((h) => h.groups > 0).map((h) => h.hour);
  const lo = active.length ? Math.max(0, Math.min(...active) - 1) : 0;
  const hi = active.length ? Math.min(23, Math.max(...active) + 1) : 23;
  const series = data
    .filter((h) => h.hour >= lo && h.hour <= hi)
    .map((h) => ({ label: `${h.hour}h`, value: h[metric] }));
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={series} margin={MARGIN}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis dataKey="label" {...AXIS} />
        <YAxis {...AXIS} allowDecimals={false} />
        <Tooltip contentStyle={TOOLTIP_STYLE} />
        <Bar dataKey="value" name={METRIC_NAME[metric]} fill={C_GROUPS} radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function DowBarChart({ data, metric }: { data: PassanteDow[]; metric: Metric }) {
  const series = data.map((d) => ({ label: d.label, value: d[metric] }));
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={series} margin={MARGIN}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis dataKey="label" {...AXIS} />
        <YAxis {...AXIS} allowDecimals={false} />
        <Tooltip contentStyle={TOOLTIP_STYLE} />
        <Bar dataKey="value" name={METRIC_NAME[metric]} fill={C_GROUPS} radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function PartySizeBars({ data }: { data: PassantePartySize[] }) {
  const series = data.map((d) => ({ label: bucketLabel(d.bucket), groups: d.groups }));
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={series} margin={MARGIN}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis dataKey="label" {...AXIS} />
        <YAxis {...AXIS} allowDecimals={false} />
        <Tooltip contentStyle={TOOLTIP_STYLE} />
        <Bar dataKey="groups" name="Grupos" fill={C_GROUPS} radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function PartySizeTableTime({ data }: { data: PassantePartySize[] }) {
  const series = data.map((d) => ({
    label: bucketLabel(d.bucket),
    // Sem amostra = sem barra (null), não "0 min".
    minutes: d.avgTableSec == null ? null : Math.round(d.avgTableSec / 60),
  }));
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={series} margin={MARGIN}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis dataKey="label" {...AXIS} />
        <YAxis {...AXIS} allowDecimals={false} unit=" min" width={52} />
        <Tooltip contentStyle={TOOLTIP_STYLE} />
        <Bar dataKey="minutes" name="Tempo médio na mesa (min)" fill={C_PEOPLE} radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
