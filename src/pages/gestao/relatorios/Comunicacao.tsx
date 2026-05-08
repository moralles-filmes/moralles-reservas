import { useState } from "react";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import {
  useComunicacao,
  kindLabel,
  type ComunicacaoTab,
  type KpiSet,
} from "@/hooks/useComunicacao";
import {
  DateRangePicker,
  presetRange,
} from "@/components/relatorios/DateRangePicker";
import { ComunicacaoLineChart } from "@/components/relatorios/ComunicacaoLineChart";
import { ComunicacaoKindBar } from "@/components/relatorios/ComunicacaoKindBar";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { AlertTriangle, Mail, Send } from "lucide-react";
import type { DateRange } from "@/hooks/useFluxoClientes";
import { BreadcrumbRelatorios } from "./FluxoClientes";

type Tab = ComunicacaoTab | "marketing" | "giftback";

const TAB_LABEL: Record<Tab, string> = {
  geral: "Visão geral",
  reserva: "Reserva",
  fila: "Fila",
  marketing: "Marketing",
  avaliacao: "Avaliação",
  giftback: "Giftback",
};

const LOCKED: Tab[] = ["marketing", "giftback"];

function formatPct(value: number): string {
  if (!Number.isFinite(value)) return "0 %";
  return `${value.toFixed(1).replace(/\.0$/, "")} %`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function Comunicacao() {
  const unit = useCurrentUnit();
  const unitId = unit?.unit_id ?? "";

  const [tab, setTab] = useState<Tab>("geral");
  const [range, setRange] = useState<DateRange>(() => presetRange(30));

  const { data, isLoading } = useComunicacao(unitId, range);

  const activeTab: ComunicacaoTab =
    tab === "marketing" || tab === "giftback" ? "geral" : tab;

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <BreadcrumbRelatorios current="Comunicação" />
        <h1 className="text-2xl font-bold">Comunicação</h1>
      </header>

      <div className="flex border-b overflow-x-auto">
        {(Object.keys(TAB_LABEL) as Tab[]).map((t) => (
          <TabButton
            key={t}
            active={tab === t}
            locked={LOCKED.includes(t)}
            onClick={() => setTab(t)}
          >
            {TAB_LABEL[t]}
          </TabButton>
        ))}
      </div>

      {LOCKED.includes(tab) ? (
        <LockedTab tab={tab} />
      ) : (
        <>
          <DateRangePicker value={range} onChange={setRange} />

          <KpiGrid tab={activeTab} kpis={data.kpis[activeTab]} loading={isLoading} />

          <Card>
            <CardContent className="p-4 space-y-3">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <h3 className="text-base font-semibold">Envios</h3>
                  <p className="text-xs text-muted-foreground">
                    Mensagens enviadas com sucesso por dia.
                  </p>
                </div>
                <div className="flex gap-6">
                  <KpiInline label="WhatsApp" value={data.kpis[activeTab].whatsapp} />
                  <KpiInline label="E-mail" value={data.kpis[activeTab].email} />
                  <KpiInline label="Total" value={data.kpis[activeTab].total} />
                </div>
              </div>
              <div className="h-72">
                {isLoading ? (
                  <Skeleton className="h-full w-full" />
                ) : data.daily.every((d) => d.total === 0) ? (
                  <EmptyState />
                ) : (
                  <ComunicacaoLineChart data={data.daily} multiSeries />
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4 space-y-3">
              <div>
                <h3 className="text-base font-semibold">Por tipo de mensagem</h3>
                <p className="text-xs text-muted-foreground">
                  Volume agrupado por tipo, com sucesso/falha/ignoradas.
                </p>
              </div>
              <div className="h-72">
                {isLoading ? (
                  <Skeleton className="h-full w-full" />
                ) : data.byKind.length === 0 ? (
                  <EmptyState />
                ) : (
                  <ComunicacaoKindBar
                    data={data.byKind.filter((b) =>
                      activeTab === "geral"
                        ? true
                        : kindMatchesTab(b.kind, activeTab),
                    )}
                  />
                )}
              </div>
            </CardContent>
          </Card>

          {activeTab === "geral" && data.recentFailures.length > 0 && (
            <FailuresCard failures={data.recentFailures} />
          )}
        </>
      )}
    </div>
  );
}

// ─── KPI grid ─────────────────────────────────────────────────────────────────

function KpiGrid({
  tab,
  kpis,
  loading,
}: {
  tab: ComunicacaoTab;
  kpis: KpiSet;
  loading: boolean;
}) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <Kpi
        icon={Send}
        label="WhatsApps enviados"
        value={kpis.whatsapp}
        loading={loading}
      />
      <Kpi
        icon={Mail}
        label="E-mails enviados"
        value={kpis.email}
        loading={loading}
      />
      <Kpi
        icon={Send}
        label="Taxa de entrega"
        value={formatPct(kpis.success_rate_pct)}
        loading={loading}
        tooltip="Sucesso / (Sucesso + Falhas). Não inclui ignoradas (skipped)."
      />
      <Kpi
        icon={AlertTriangle}
        label={tab === "geral" ? "Falhas" : "Falhas no escopo"}
        value={kpis.failed}
        loading={loading}
      />
    </div>
  );
}

function Kpi({
  icon: Icon,
  label,
  value,
  loading,
  tooltip,
}: {
  icon: React.ElementType;
  label: string;
  value: number | string;
  loading: boolean;
  tooltip?: string;
}) {
  const labelEl = tooltip ? (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-help underline decoration-dotted underline-offset-2">
            {label}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  ) : (
    label
  );

  return (
    <Card>
      <CardContent className="pt-5 pb-5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted-foreground truncate">{labelEl}</p>
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

// ─── Falhas recentes ──────────────────────────────────────────────────────────

function FailuresCard({
  failures,
}: {
  failures: ReturnType<typeof useComunicacao>["data"]["recentFailures"];
}) {
  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-destructive" />
          <h3 className="text-base font-semibold">Últimas falhas</h3>
          <span className="text-xs text-muted-foreground">
            ({failures.length} {failures.length === 1 ? "registro" : "registros"})
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-muted-foreground border-b">
                <th className="text-left font-medium py-2">Tipo</th>
                <th className="text-left font-medium py-2">Cliente</th>
                <th className="text-left font-medium py-2">Telefone</th>
                <th className="text-left font-medium py-2">Erro</th>
                <th className="text-left font-medium py-2">Quando</th>
              </tr>
            </thead>
            <tbody>
              {failures.map((f) => (
                <tr key={f.id} className="border-b last:border-0">
                  <td className="py-2 font-medium">{kindLabel(f.kind)}</td>
                  <td className="py-2 text-muted-foreground">
                    {f.customer_name ?? "—"}
                  </td>
                  <td className="py-2 font-mono text-xs">
                    {f.customer_phone ?? "—"}
                  </td>
                  <td className="py-2 font-mono text-xs text-destructive">
                    {f.error ?? "—"}
                  </td>
                  <td className="py-2 text-xs text-muted-foreground">
                    {formatTime(f.sent_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground">
          Pra diagnosticar canal WhatsApp / chave de IA, abra
          <code className="mx-1 px-1 rounded bg-muted">/platform/automacao</code>
          → Diagnóstico (super-admin).
        </p>
      </CardContent>
    </Card>
  );
}

// ─── Tabs / locked / empty ────────────────────────────────────────────────────

function TabButton({
  active,
  locked,
  onClick,
  children,
}: {
  active: boolean;
  locked: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-5 py-3 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap ${
        active
          ? "border-primary text-primary"
          : "border-transparent text-muted-foreground hover:text-foreground"
      } ${locked ? "opacity-60" : ""}`}
    >
      {children}
      {locked && (
        <span className="ml-1 text-[9px] uppercase tracking-wider bg-amber-50 text-amber-700 border border-amber-200 rounded px-1 py-0.5">
          em breve
        </span>
      )}
    </button>
  );
}

function LockedTab({ tab }: { tab: Tab }) {
  return (
    <Card>
      <CardContent className="py-16 text-center text-muted-foreground space-y-3 max-w-md mx-auto">
        <h2 className="text-base font-medium text-foreground">
          {TAB_LABEL[tab]} — em breve
        </h2>
        <p className="text-sm">
          {tab === "marketing"
            ? "Campanhas WhatsApp em massa, segmentação por hábitos de cliente, e métricas de conversão chegam em uma fase futura."
            : "Cashback / programa de fidelidade ainda não está disponível no Moralles."}
        </p>
      </CardContent>
    </Card>
  );
}

function EmptyState() {
  return (
    <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
      Sem envios no período.
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

import type { NotificationKind } from "@/hooks/useComunicacao";

function kindMatchesTab(kind: NotificationKind, tab: ComunicacaoTab): boolean {
  if (tab === "reserva")
    return ["confirmation", "confirmation_email", "cancellation", "reminder_d1"].includes(
      kind,
    );
  if (tab === "fila")
    return ["waitlist_entered", "waitlist_table_ready", "waitlist_feedback"].includes(
      kind,
    );
  if (tab === "avaliacao") return kind === "survey_d1";
  return true;
}
