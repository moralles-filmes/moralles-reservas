import { useState } from "react";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import { useGiftbackRelatorio } from "@/hooks/useGiftbackRelatorio";
import {
  DateRangePicker,
  presetRange,
} from "@/components/relatorios/DateRangePicker";
import type { DateRange } from "@/hooks/useFluxoClientes";
import { BreadcrumbRelatorios } from "./FluxoClientes";
import { KpiCard } from "@/components/dashboard/KpiCard";
import { VoucherStatusBadge } from "@/components/giftback/VoucherStatusBadge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Gift, Send, CheckCircle2, Percent, XCircle } from "lucide-react";
import { formatPhone } from "@/lib/utils";

const TRIGGER_COLOR: Record<string, string> = {
  after_rating: "hsl(var(--chart-trigger-rating))",
  manual: "hsl(var(--chart-trigger-manual))",
  birthday: "hsl(var(--chart-trigger-birthday))",
  frequency: "hsl(var(--chart-trigger-frequency))",
  manual_avulso: "hsl(var(--chart-trigger-other))",
};

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
  });
}

export default function Giftback() {
  const unit = useCurrentUnit();
  const unitId = unit?.unit_id ?? "";

  const [range, setRange] = useState<DateRange>(() => presetRange(30));
  const { data, isLoading } = useGiftbackRelatorio(unitId, range);

  const empty = !isLoading && data && data.kpis.total_issued === 0;

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <BreadcrumbRelatorios current="Giftback" />
        <div className="flex items-center gap-2">
          <Gift className="h-5 w-5 text-rose-500" />
          <h1 className="text-2xl font-bold">Giftback</h1>
        </div>
      </header>

      <DateRangePicker value={range} onChange={setRange} />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          title="Emitidos"
          value={isLoading ? undefined : data?.kpis.total_issued ?? 0}
          icon={Send}
          color="bg-rose-50 text-rose-600"
        />
        <KpiCard
          title="Usados"
          value={isLoading ? undefined : data?.kpis.total_used ?? 0}
          icon={CheckCircle2}
          color="bg-emerald-50 text-emerald-600"
        />
        <KpiCard
          title="Conversão"
          value={
            isLoading
              ? undefined
              : data?.kpis.conversion_pct ?? null
          }
          suffix="%"
          icon={Percent}
          color="bg-blue-50 text-blue-600"
        />
        <KpiCard
          title="Cancelados"
          value={isLoading ? undefined : data?.kpis.total_cancelled ?? 0}
          icon={XCircle}
          color="bg-rose-50 text-rose-600"
        />
      </div>

      {empty ? (
        <Card>
          <CardContent className="py-16 text-center text-muted-foreground space-y-2">
            <Gift className="h-8 w-8 mx-auto opacity-30" />
            <p className="text-sm">Nenhum voucher emitido no período selecionado.</p>
            <p className="text-xs">
              Crie regras em <code className="px-1 bg-muted rounded">/giftback/regras</code> ou
              emita manualmente em <code className="px-1 bg-muted rounded">/giftback/vouchers</code>.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardContent className="p-4 space-y-3">
              <div>
                <h3 className="text-base font-semibold">Emissões vs. usos por dia</h3>
                <p className="text-xs text-muted-foreground">
                  Vouchers criados vs. consumidos em cada dia do período.
                </p>
              </div>
              <div className="h-72">
                {isLoading ? (
                  <Skeleton className="h-full w-full" />
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={data?.daily ?? []} margin={{ top: 8, right: 12, bottom: 4, left: -16 }}>
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
                      <Line
                        type="monotone"
                        dataKey="issued"
                        name="Emitidos"
                        stroke="hsl(var(--chart-issued))"
                        strokeWidth={2}
                        dot={false}
                        activeDot={{ r: 4 }}
                      />
                      <Line
                        type="monotone"
                        dataKey="used"
                        name="Usados"
                        stroke="hsl(var(--chart-used))"
                        strokeWidth={2}
                        dot={false}
                        activeDot={{ r: 4 }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4 space-y-3">
              <div>
                <h3 className="text-base font-semibold">Por gatilho</h3>
                <p className="text-xs text-muted-foreground">
                  Quantos vouchers vieram de cada origem.
                </p>
              </div>
              <div className="h-60">
                {isLoading ? (
                  <Skeleton className="h-full w-full" />
                ) : (data?.byTrigger ?? []).length === 0 ? (
                  <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
                    Sem dados.
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data?.byTrigger ?? []} margin={{ top: 8, right: 12, bottom: 4, left: -16 }}>
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
                      <Bar dataKey="count" name="Vouchers">
                        {(data?.byTrigger ?? []).map((entry, idx) => (
                          <Cell
                            key={`cell-${idx}`}
                            fill={TRIGGER_COLOR[entry.trigger] ?? "hsl(var(--chart-trigger-other))"}
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4 space-y-3">
              <div>
                <h3 className="text-base font-semibold">Últimos vouchers</h3>
                <p className="text-xs text-muted-foreground">
                  Os 20 mais recentes do período.
                </p>
              </div>
              {isLoading ? (
                <Skeleton className="h-32 w-full" />
              ) : (data?.recent ?? []).length === 0 ? (
                <div className="py-8 text-center text-sm text-muted-foreground">
                  Sem vouchers no período.
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Código</TableHead>
                      <TableHead>Cliente</TableHead>
                      <TableHead>Desconto</TableHead>
                      <TableHead>Origem</TableHead>
                      <TableHead>Emitido</TableHead>
                      <TableHead>Validade</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(data?.recent ?? []).map((v) => (
                      <TableRow key={v.id}>
                        <TableCell className="font-mono font-semibold">{v.code}</TableCell>
                        <TableCell>
                          <div className="space-y-0.5 min-w-0">
                            <p className="text-sm font-medium truncate">
                              {v.customer_name || "—"}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {v.customer_phone ? formatPhone(v.customer_phone) : ""}
                            </p>
                          </div>
                        </TableCell>
                        <TableCell className="font-semibold text-rose-600">
                          {v.discount_percent}%
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {v.trigger
                            ? v.trigger === "after_rating"
                              ? "Após avaliação"
                              : v.trigger === "manual"
                              ? "Manual"
                              : v.trigger === "birthday"
                              ? "Aniversário"
                              : "Frequência"
                            : "Manual avulso"}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {formatDateTime(v.issued_at)}
                        </TableCell>
                        <TableCell className="text-xs">
                          {formatDate(v.expires_at)}
                        </TableCell>
                        <TableCell>
                          <VoucherStatusBadge status={v.status} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
