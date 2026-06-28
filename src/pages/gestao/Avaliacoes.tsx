import { useState } from "react";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import { useAvaliacoes } from "@/hooks/useAvaliacoes";
import {
  DateRangePicker,
  presetRange,
} from "@/components/relatorios/DateRangePicker";
import type { DateRange } from "@/hooks/useFluxoClientes";
import { BreadcrumbRelatorios } from "./relatorios/FluxoClientes";
import { RatingsSummary } from "@/components/dashboard/RatingsSummary";
import { ResponseRateCard } from "@/components/relatorios/avaliacoes/ResponseRateCard";
import { LockedQuestionCard } from "@/components/relatorios/avaliacoes/LockedQuestionCard";
import { RespostasTable } from "@/components/relatorios/avaliacoes/RespostasTable";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Star } from "lucide-react";
import { exportAvaliacoesCsv } from "@/lib/exportCsv";
import { toast } from "sonner";

type Tab = "geral" | "respostas";

const TAB_LABEL: Record<Tab, string> = {
  geral: "Visão geral",
  respostas: "Respostas",
};

const SCALE_QUESTIONS = [
  { title: "Comida", hint: "Avalie a qualidade da comida" },
  { title: "Atendimento", hint: "Avalie a equipe de atendimento" },
  { title: "Preço", hint: "Avalie o custo-benefício" },
  { title: "Ambiente", hint: "Avalie o ambiente do local" },
];

const SINGLE_CHOICE_QUESTIONS = [
  { title: "Qual a sua idade?", hint: "Faixa etária do cliente" },
  { title: "Qual seu gênero?", hint: "Identidade de gênero" },
  { title: "Hoje é sua primeira visita?", hint: "Cliente novo ou recorrente" },
];

export default function Avaliacoes() {
  const unit = useCurrentUnit();
  const unitId = unit?.unit_id ?? "";

  const [tab, setTab] = useState<Tab>("geral");
  const [range, setRange] = useState<DateRange>(() => presetRange(30));

  const { data, isLoading } = useAvaliacoes(unitId, range);

  const handleExport = () => {
    if (!data || data.rows.length === 0) return;
    const result = exportAvaliacoesCsv(range, data.rows);
    toast.success(`${result.count} avaliação(ões) exportada(s)`);
  };

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <BreadcrumbRelatorios current="Avaliações" />
        <div className="flex items-center gap-2">
          <Star className="h-5 w-5 text-gold" />
          <h1 className="text-2xl font-bold">Avaliações</h1>
        </div>
      </header>

      <div className="flex border-b overflow-x-auto">
        {(Object.keys(TAB_LABEL) as Tab[]).map((t) => (
          <TabButton key={t} active={tab === t} onClick={() => setTab(t)}>
            {TAB_LABEL[t]}
          </TabButton>
        ))}
      </div>

      <DateRangePicker value={range} onChange={setRange} />

      {tab === "geral" ? (
        <VisaoGeral
          loading={isLoading}
          ratings={data?.rows.map((r) => r.rating) ?? []}
          total={data?.total ?? 0}
          surveysSent={data?.totalSurveysSent ?? 0}
          ratePct={data?.responseRatePct ?? null}
        />
      ) : (
        <RespostasTable
          rows={data?.rows ?? []}
          loading={isLoading}
          onExport={handleExport}
        />
      )}
    </div>
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
      className={`px-5 py-3 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap ${
        active
          ? "border-primary text-primary"
          : "border-transparent text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

interface VisaoGeralProps {
  loading: boolean;
  ratings: number[];
  total: number;
  surveysSent: number;
  ratePct: number | null;
}

function VisaoGeral({ loading, ratings, total, surveysSent, ratePct }: VisaoGeralProps) {
  if (loading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {total === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground space-y-2">
            <Star className="h-8 w-8 mx-auto opacity-30" />
            <p className="text-sm">Nenhuma avaliação no período selecionado.</p>
            <p className="text-xs">
              {surveysSent > 0
                ? `${surveysSent} pesquisa${surveysSent === 1 ? " foi enviada" : "s foram enviadas"} sem resposta.`
                : "Nenhuma pesquisa D+1 foi disparada — verifique o workflow N8N de pós-reserva."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <RatingsSummary ratings={ratings} />
          <ResponseRateCard total={total} surveysSent={surveysSent} ratePct={ratePct} />
        </div>
      )}

      <section className="space-y-2">
        <h2 className="text-base font-semibold">Perguntas de escala</h2>
        <p className="text-xs text-muted-foreground">
          Avaliações por dimensão (Comida, Atendimento, Preço, Ambiente) chegam em uma fase futura.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {SCALE_QUESTIONS.map((q) => (
            <LockedQuestionCard key={q.title} title={q.title} hint={q.hint} />
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">Perguntas de escolha única</h2>
        <p className="text-xs text-muted-foreground">
          Perfil demográfico do cliente (idade, gênero, primeira visita) chega em uma fase futura.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {SINGLE_CHOICE_QUESTIONS.map((q) => (
            <LockedQuestionCard key={q.title} title={q.title} hint={q.hint} />
          ))}
        </div>
      </section>
    </div>
  );
}
