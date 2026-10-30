import { useState } from "react";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import { useUnitPublicContent } from "@/hooks/useUnitPublicContent";
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
import { OrigemReservasSection } from "@/components/relatorios/OrigemReservasSection";
import { PageHeader } from "@/components/PageHeader";
import { Breadcrumb } from "@/components/Breadcrumb";
import { KpiCard } from "@/components/dashboard/KpiCard";
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
  geral: "bg-info/15 text-info",
  reserva: "bg-success/15 text-success",
  fila: "bg-warning/15 text-warning",
  passante: "bg-muted text-muted-foreground",
};

function formatTime(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((v) => String(v).padStart(2, "0")).join(":");
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

  const { data: unitContent } = useUnitPublicContent(unitId);
  const ticketMedio = unitContent?.price_range_max ?? null;
  const hasTicketMedio = !!ticketMedio && ticketMedio > 0;

  const { data, isLoading } = useFluxoClientes(unitId, range, ticketMedio);
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
      <PageHeader
        breadcrumb={[
          { label: unit?.unit_name ?? "Unidade", to: `/g/${unit?.unit_slug ?? ""}` },
          { label: "Relatórios" },
          { label: "Fluxo de clientes" },
        ]}
        title="Fluxo de Clientes"
      >
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
      </PageHeader>

      <div className="flex border-b overflow-x-auto">
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
      <KpiGrid tab={tab} kpis={kpis} loading={isLoading} hasTicketMedio={hasTicketMedio} />

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

      {tab === "reserva" && (
        <OrigemReservasSection
          origem={data.origem}
          hasTicketMedio={hasTicketMedio}
          loading={isLoading}
        />
      )}

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

const ICON_COLOR = "bg-muted text-muted-foreground";
const PCT_DECIMAL_FORMATTER = (value: number) =>
  Number.isInteger(value) ? value : Number(value.toFixed(1));

/** Wrapper sobre KpiCard que respeita "—" quando taxa é null e formata 1 casa decimal. */
function pctValue(
  pct: number | null,
  loading: boolean,
): number | null | undefined {
  if (loading) return undefined;
  if (pct == null) return null;
  return PCT_DECIMAL_FORMATTER(pct);
}

function KpiGrid({
  tab,
  kpis,
  loading,
  hasTicketMedio,
}: {
  tab: Tab;
  kpis: KpiSet;
  loading: boolean;
  hasTicketMedio: boolean;
}) {
  const receita = loading ? undefined : formatBRL(kpis.receita_centavos);
  const receitaCard = (
    <ReceitaEstimadaCard value={receita} hasTicketMedio={hasTicketMedio} />
  );

  if (tab === "geral") {
    return (
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          title="Total de mesas"
          value={loading ? undefined : kpis.total_mesas}
          icon={LayoutGrid}
          color={ICON_COLOR}
        />
        <KpiCard
          title="Total de pessoas"
          value={loading ? undefined : kpis.total_pessoas}
          icon={Users}
          color={ICON_COLOR}
        />
        <KpiCard
          title="Taxa de não comparecimento"
          value={pctValue(kpis.taxa_no_show_pct, loading)}
          suffix="%"
          icon={UserX}
          color={ICON_COLOR}
        />
        {receitaCard}
      </div>
    );
  }

  if (tab === "reserva") {
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <KpiCard
            title="Total de mesas"
            value={loading ? undefined : kpis.total_mesas}
            icon={LayoutGrid}
            color={ICON_COLOR}
          />
          <KpiCard
            title="Total de pessoas"
            value={loading ? undefined : kpis.total_pessoas}
            icon={Users}
            color={ICON_COLOR}
          />
          <KpiCard
            title="Média de pessoas por mesa"
            value={loading ? undefined : Math.round(kpis.media_pessoas_por_mesa)}
            icon={TrendingUp}
            color={ICON_COLOR}
          />
          <KpiCard
            title="Taxa de cancelamento"
            value={pctValue(kpis.taxa_cancelamento_pct, loading)}
            suffix="%"
            icon={XCircle}
            color={ICON_COLOR}
          />
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
          <KpiCard
            title="Taxa de não comparecimento"
            value={pctValue(kpis.taxa_no_show_pct, loading)}
            suffix="%"
            icon={UserX}
            color={ICON_COLOR}
          />
          <KpiCard
            title="Pessoas sentadas"
            value={loading ? undefined : kpis.pessoas_sentadas}
            icon={UserCheck}
            color={ICON_COLOR}
          />
          {receitaCard}
        </div>
      </div>
    );
  }

  if (tab === "fila") {
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <KpiCard
            title="Total de mesas"
            value={loading ? undefined : kpis.total_mesas}
            icon={LayoutGrid}
            color={ICON_COLOR}
          />
          <KpiCard
            title="Total de pessoas"
            value={loading ? undefined : kpis.total_pessoas}
            icon={Users}
            color={ICON_COLOR}
          />
          <KpiCard
            title="Tempo médio de espera"
            value={loading ? undefined : formatTime(kpis.tempo_medio_espera_seg)}
            icon={Clock}
            color={ICON_COLOR}
          />
          <KpiCard
            title="Média de pessoas por mesa"
            value={loading ? undefined : Math.round(kpis.media_pessoas_por_mesa)}
            icon={TrendingUp}
            color={ICON_COLOR}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <KpiCard
            title="Taxa de não comparecimento"
            value={pctValue(kpis.taxa_no_show_pct, loading)}
            suffix="%"
            icon={UserX}
            color={ICON_COLOR}
          />
          {receitaCard}
        </div>
      </div>
    );
  }

  // Passante
  return (
    <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
      <KpiCard
        title="Total de mesas"
        value={loading ? undefined : kpis.total_mesas}
        icon={LayoutGrid}
        color={ICON_COLOR}
      />
      <KpiCard
        title="Total de pessoas"
        value={loading ? undefined : kpis.total_pessoas}
        icon={Users}
        color={ICON_COLOR}
      />
      <KpiCard
        title="Média de pessoas por mesa"
        value={loading ? undefined : Math.round(kpis.media_pessoas_por_mesa)}
        icon={TrendingUp}
        color={ICON_COLOR}
      />
    </div>
  );
}

function ReceitaEstimadaCard({
  value,
  hasTicketMedio,
}: {
  value: string | undefined;
  hasTicketMedio: boolean;
}) {
  const card = (
    <KpiCard
      title="Receita estimada"
      value={value}
      icon={DollarSign}
      color={ICON_COLOR}
    />
  );
  if (hasTicketMedio) return card;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div>{card}</div>
        </TooltipTrigger>
        <TooltipContent>
          Cadastre o ticket médio em <strong>Conta › Categoria e operação</strong> para ver a estimativa.
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
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
    <Breadcrumb
      items={[
        { label: unit?.unit_name ?? "Unidade", to: `/g/${unitSlug}` },
        { label: "Relatórios" },
        { label: current },
      ]}
    />
  );
}
