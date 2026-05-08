import { useState } from "react";
import { Link } from "react-router-dom";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import {
  useFluxoClientes,
  type DateRange,
  type KpiSet,
} from "@/hooks/useFluxoClientes";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  CalendarRange,
  Clock,
  Download,
  ExternalLink,
  HelpCircle,
  LayoutGrid,
  TrendingUp,
  UserCheck,
  UserX,
  Users,
  XCircle,
  DollarSign,
} from "lucide-react";
import {
  DateRangePicker,
  presetRange,
} from "@/components/relatorios/DateRangePicker";
import { FluxoLineChart, type FluxoTabKey } from "@/components/relatorios/FluxoLineChart";
import { PartySizeChart } from "@/components/relatorios/PartySizeChart";
import { DowChart } from "@/components/relatorios/DowChart";
import { exportClientesCsv } from "@/lib/exportCsv";
import { toast } from "sonner";

type Tab = FluxoTabKey;

const TAB_LABELS: Record<Tab, string> = {
  geral: "Visão geral",
  reserva: "Reserva",
  fila: "Fila",
  passante: "Passante",
};

const TAB_ACCENT: Record<Tab, string> = {
  geral: "bg-blue-500/15 text-blue-700",
  reserva: "bg-emerald-500/15 text-emerald-700",
  fila: "bg-orange-500/15 text-orange-700",
  passante: "bg-slate-500/15 text-slate-700",
};

function formatTime(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((v) => String(v).padStart(2, "0")).join(":");
}

function formatPct(value: number): string {
  if (!Number.isFinite(value)) return "0 %";
  return `${value.toFixed(2).replace(/\.?0+$/, "")} %`;
}

function formatBRL(cents: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(cents / 100);
}

export default function FluxoClientes() {
  const unit = useCurrentUnit();
  const unitId = unit?.unit_id ?? "";

  const [tab, setTab] = useState<Tab>("geral");
  const [range, setRange] = useState<DateRange>(() => presetRange(30));
  const [dowUnit, setDowUnit] = useState<"mesas" | "pessoas">("mesas");
  const [exporting, setExporting] = useState(false);

  const { data, isLoading } = useFluxoClientes(unitId, range);
  const kpis = data.kpis[tab];

  const handleExport = async () => {
    if (!unitId) return;
    setExporting(true);
    try {
      const { count } = await exportClientesCsv(unitId, range);
      toast.success(`Base exportada (${count} ${count === 1 ? "cliente" : "clientes"}).`);
    } catch (err) {
      console.error(err);
      toast.error("Erro ao exportar base.");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <BreadcrumbRelatorios current="Fluxo de clientes" />
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <h1 className="text-2xl font-bold">Fluxo de Clientes</h1>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleExport}
              disabled={exporting || !unitId}
              className="gap-2"
            >
              <Download className="h-4 w-4" />
              {exporting ? "Exportando…" : "Exportar base de clientes"}
            </Button>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="default"
                    size="sm"
                    disabled
                    className="gap-2"
                  >
                    <ExternalLink className="h-4 w-4" />
                    Relatórios avançados
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  Em breve — integração com BI externo.
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </div>
      </header>

      <div className="flex border-b">
        {(Object.keys(TAB_LABELS) as Tab[]).map((t) => (
          <TabButton key={t} active={tab === t} onClick={() => setTab(t)}>
            {TAB_LABELS[t]}
          </TabButton>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <DateRangePicker value={range} onChange={setRange} />
      </div>

      {/* KPIs */}
      <KpiGrid tab={tab} kpis={kpis} loading={isLoading} />

      {/* Fluxo geral / Fluxo de Consumidores */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <h3 className="text-base font-semibold">
                {tab === "geral" ? "Fluxo geral" : "Fluxo de Consumidores"}
              </h3>
              <p className="text-xs text-muted-foreground">
                Mesas atendidas por dia no período.
              </p>
            </div>
            <div className="flex gap-6">
              <KpiInline label="Mesas sentadas" value={kpis.mesas_sentadas} />
              <KpiInline label="Pessoas sentadas" value={kpis.pessoas_sentadas} />
            </div>
          </div>
          <div className="h-72">
            {isLoading ? (
              <Skeleton className="h-full w-full" />
            ) : (
              <FluxoLineChart data={data.daily} tab={tab} />
            )}
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardContent className="p-4 space-y-3">
            <div>
              <h3 className="text-base font-semibold">Tamanho médio de mesa</h3>
              <p className="text-xs text-muted-foreground">
                Distribuição por quantidade de pessoas.
              </p>
            </div>
            <div className="h-72">
              {isLoading ? (
                <Skeleton className="h-full w-full" />
              ) : data.partySize.length === 0 ? (
                <EmptyState />
              ) : (
                <PartySizeChart data={data.partySize} tab={tab} />
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <h3 className="text-base font-semibold">Fluxo por dia da semana</h3>
                <p className="text-xs text-muted-foreground">
                  Volume agregado pelo dia da semana.
                </p>
              </div>
              <div className="flex gap-1">
                <ToggleChip active={dowUnit === "mesas"} onClick={() => setDowUnit("mesas")}>
                  Mesas
                </ToggleChip>
                <ToggleChip
                  active={dowUnit === "pessoas"}
                  onClick={() => setDowUnit("pessoas")}
                >
                  Pessoas
                </ToggleChip>
              </div>
            </div>
            <div className="h-72">
              {isLoading ? (
                <Skeleton className="h-full w-full" />
              ) : (
                <DowChart data={data.dow} tab={tab} unit={dowUnit} />
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <p className="text-xs text-muted-foreground">
        <span
          className={`inline-block px-2 py-0.5 rounded text-[10px] font-medium mr-1 ${TAB_ACCENT[tab]}`}
        >
          {TAB_LABELS[tab]}
        </span>
        Dados agregados em tempo real a partir de reservas, fila de espera e
        passantes da unidade.
      </p>
    </div>
  );
}

// ─── KPI Grid ─────────────────────────────────────────────────────────────────

function KpiGrid({
  tab,
  kpis,
  loading,
}: {
  tab: Tab;
  kpis: KpiSet;
  loading: boolean;
}) {
  if (tab === "geral") {
    return (
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi
          icon={LayoutGrid}
          label="Total de mesas"
          value={kpis.total_mesas}
          loading={loading}
        />
        <Kpi
          icon={Users}
          label="Total de pessoas"
          value={kpis.total_pessoas}
          loading={loading}
        />
        <Kpi
          icon={UserX}
          label="Taxa de não comparecimento"
          value={formatPct(kpis.taxa_no_show_pct)}
          loading={loading}
        />
        <KpiReceita value={kpis.receita_centavos} loading={loading} />
      </div>
    );
  }

  if (tab === "reserva") {
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Kpi icon={LayoutGrid} label="Total de mesas" value={kpis.total_mesas} loading={loading} />
          <Kpi icon={Users} label="Total de pessoas" value={kpis.total_pessoas} loading={loading} />
          <Kpi
            icon={TrendingUp}
            label="Média de pessoas por mesa"
            value={Math.round(kpis.media_pessoas_por_mesa)}
            loading={loading}
          />
          <Kpi
            icon={XCircle}
            label="Taxa de cancelamento"
            value={formatPct(kpis.taxa_cancelamento_pct)}
            loading={loading}
          />
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
          <Kpi
            icon={UserX}
            label="Taxa de não comparecimento"
            value={formatPct(kpis.taxa_no_show_pct)}
            loading={loading}
          />
          <Kpi
            icon={UserCheck}
            label="Pessoas sentadas via Get In"
            value={kpis.pessoas_sentadas}
            loading={loading}
          />
          <KpiReceita value={kpis.receita_centavos} loading={loading} />
        </div>
      </div>
    );
  }

  if (tab === "fila") {
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Kpi icon={LayoutGrid} label="Total de mesas" value={kpis.total_mesas} loading={loading} />
          <Kpi icon={Users} label="Total de pessoas" value={kpis.total_pessoas} loading={loading} />
          <Kpi
            icon={Clock}
            label="Tempo médio de espera"
            value={formatTime(kpis.tempo_medio_espera_seg)}
            loading={loading}
          />
          <Kpi
            icon={TrendingUp}
            label="Média de pessoas por mesa"
            value={Math.round(kpis.media_pessoas_por_mesa)}
            loading={loading}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Kpi
            icon={UserX}
            label="Taxa de não comparecimento"
            value={formatPct(kpis.taxa_no_show_pct)}
            loading={loading}
          />
          <KpiReceita value={kpis.receita_centavos} loading={loading} />
        </div>
      </div>
    );
  }

  // Passante
  return (
    <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
      <Kpi icon={LayoutGrid} label="Total de mesas" value={kpis.total_mesas} loading={loading} />
      <Kpi icon={Users} label="Total de pessoas" value={kpis.total_pessoas} loading={loading} />
      <Kpi
        icon={TrendingUp}
        label="Média de pessoas por mesa"
        value={Math.round(kpis.media_pessoas_por_mesa)}
        loading={loading}
      />
    </div>
  );
}

// ─── Kpi components ──────────────────────────────────────────────────────────

function Kpi({
  icon: Icon,
  label,
  value,
  loading,
}: {
  icon: React.ElementType;
  label: string;
  value: number | string;
  loading: boolean;
}) {
  return (
    <Card>
      <CardContent className="pt-5 pb-5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted-foreground truncate">{label}</p>
            {loading ? (
              <Skeleton className="h-8 w-20 mt-1" />
            ) : (
              <p className="text-2xl font-bold mt-1">{value}</p>
            )}
          </div>
          <Icon className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
        </div>
      </CardContent>
    </Card>
  );
}

function KpiReceita({
  value,
  loading,
}: {
  value: number;
  loading: boolean;
}) {
  return (
    <Card>
      <CardContent className="pt-5 pb-5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted-foreground truncate flex items-center gap-1">
              Receita gerada via Get In
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <HelpCircle className="h-3 w-3 cursor-help" />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    Em breve — ative pagamentos nas configurações de reserva
                    pra começar a contabilizar receita aqui.
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </p>
            {loading ? (
              <Skeleton className="h-8 w-24 mt-1" />
            ) : (
              <p className="text-2xl font-bold mt-1">{formatBRL(value)}</p>
            )}
          </div>
          <DollarSign className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
        </div>
      </CardContent>
    </Card>
  );
}

function KpiInline({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="text-right">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="text-xl font-bold">{value}</p>
    </div>
  );
}

function ToggleChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
        active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:bg-accent"
      }`}
    >
      {children}
    </button>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-5 py-3 text-sm font-medium border-b-2 -mb-px transition-colors ${
        active
          ? "border-primary text-primary"
          : "border-transparent text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function EmptyState() {
  return (
    <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
      <CalendarRange className="h-5 w-5 opacity-30 mr-2" />
      Sem dados no período.
    </div>
  );
}

export function BreadcrumbRelatorios({ current }: { current: string }) {
  const unit = useCurrentUnit();
  const unitSlug = unit?.unit_slug ?? "";
  return (
    <nav className="text-xs text-muted-foreground flex items-center gap-1.5">
      <Link to={`/g/${unitSlug}`} className="hover:text-foreground">
        {unit?.unit_name ?? "Unidade"}
      </Link>
      <span>/</span>
      <span>Relatórios</span>
      <span>/</span>
      <span className="text-foreground">{current}</span>
    </nav>
  );
}
