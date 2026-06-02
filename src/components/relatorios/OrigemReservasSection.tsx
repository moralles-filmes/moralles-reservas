import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Globe, MessageCircle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { KpiCard } from "@/components/dashboard/KpiCard";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type {
  CanalStat,
  OrigemData,
  ReservaCanal,
} from "@/hooks/useFluxoClientes";

// Cores por canal — tokens existentes em index.css (sem hex hardcoded).
const CANAL_COLOR: Record<ReservaCanal, string> = {
  whatsapp: "hsl(var(--chart-whatsapp))",
  web: "hsl(var(--chart-geral))",
  outros: "hsl(var(--muted-foreground))",
};

function formatBRL(cents: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(cents / 100);
}

function formatPct(pct: number): string {
  return `${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`;
}

function statOf(origem: OrigemData, canal: ReservaCanal): CanalStat | undefined {
  return origem.canais.find((c) => c.canal === canal);
}

interface OrigemReservasSectionProps {
  origem: OrigemData;
  hasTicketMedio: boolean;
  loading: boolean;
}

export function OrigemReservasSection({
  origem,
  hasTicketMedio,
  loading,
}: OrigemReservasSectionProps) {
  const whatsapp = statOf(origem, "whatsapp");
  const web = statOf(origem, "web");
  const isEmpty = origem.canais.length === 0;

  return (
    <Card>
      <CardContent className="p-4 space-y-4">
        <div>
          <h3 className="text-base font-semibold">Origem das reservas</h3>
          <p className="text-xs text-muted-foreground">
            Comparativo entre reservas feitas pelo WhatsApp e pelo site.
          </p>
        </div>

        {/* Cards por canal */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <KpiCard
            title="Reservas via WhatsApp"
            value={loading ? undefined : whatsapp?.reservas ?? 0}
            icon={MessageCircle}
            color="bg-muted text-muted-foreground"
          />
          <KpiCard
            title="Reservas via Site"
            value={loading ? undefined : web?.reservas ?? 0}
            icon={Globe}
            color="bg-muted text-muted-foreground"
          />
          <KpiCard
            title="Pessoas via WhatsApp"
            value={loading ? undefined : whatsapp?.pessoas ?? 0}
            icon={MessageCircle}
            color="bg-muted text-muted-foreground"
          />
          <KpiCard
            title="Pessoas via Site"
            value={loading ? undefined : web?.pessoas ?? 0}
            icon={Globe}
            color="bg-muted text-muted-foreground"
          />
        </div>

        {loading ? (
          <Skeleton className="h-72 w-full" />
        ) : isEmpty ? (
          <div className="h-40 flex items-center justify-center text-sm text-muted-foreground">
            Sem reservas no período.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Donut — % de reservas por canal */}
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">
                  Participação por canal (reservas)
                </p>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={origem.canais}
                        dataKey="reservas"
                        nameKey="label"
                        cx="50%"
                        cy="50%"
                        innerRadius={55}
                        outerRadius={90}
                        paddingAngle={2}
                      >
                        {origem.canais.map((c) => (
                          <Cell key={c.canal} fill={CANAL_COLOR[c.canal]} />
                        ))}
                      </Pie>
                      <Tooltip
                        contentStyle={{
                          background: "hsl(var(--popover))",
                          border: "1px solid hsl(var(--border))",
                          borderRadius: "var(--radius)",
                          fontSize: 12,
                        }}
                        formatter={(value: number, _name, item) => [
                          `${value} (${formatPct(
                            (item?.payload as CanalStat)?.pct_reservas ?? 0,
                          )})`,
                          (item?.payload as CanalStat)?.label,
                        ]}
                      />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Barras — reservas vs pessoas por canal */}
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">
                  Reservas e pessoas por canal
                </p>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={origem.canais}
                      margin={{ top: 8, right: 16, bottom: 4, left: 0 }}
                    >
                      <CartesianGrid
                        strokeDasharray="3 3"
                        stroke="hsl(var(--border))"
                      />
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
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar
                        dataKey="reservas"
                        name="Reservas"
                        fill="hsl(var(--chart-reserva))"
                        radius={[4, 4, 0, 0]}
                      />
                      <Bar
                        dataKey="pessoas"
                        name="Pessoas"
                        fill="hsl(var(--chart-fila))"
                        radius={[4, 4, 0, 0]}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>

            {/* Tabela resumida */}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Canal</TableHead>
                  <TableHead className="text-right">Reservas</TableHead>
                  <TableHead className="text-right">Pessoas</TableHead>
                  <TableHead className="text-right">% das reservas</TableHead>
                  <TableHead className="text-right">Receita estimada</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {origem.canais.map((c) => (
                  <TableRow key={c.canal}>
                    <TableCell className="font-medium">
                      <span className="inline-flex items-center gap-2">
                        <span
                          className="inline-block h-2.5 w-2.5 rounded-full shrink-0"
                          style={{ background: CANAL_COLOR[c.canal] }}
                        />
                        {c.label}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">{c.reservas}</TableCell>
                    <TableCell className="text-right">{c.pessoas}</TableCell>
                    <TableCell className="text-right">
                      {formatPct(c.pct_reservas)}
                    </TableCell>
                    <TableCell className="text-right">
                      {hasTicketMedio ? formatBRL(c.receita_centavos) : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </CardContent>
    </Card>
  );
}
