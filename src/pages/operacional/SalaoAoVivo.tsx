import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useNow } from "@/hooks/useNow";
import { useSalaoAoVivo } from "@/hooks/useSalaoAoVivo";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { hallPlanFrom, resolveTableBoxes } from "@/lib/hall-plan-core";
import { brtNow, deriveTableStates } from "@/lib/table-situation-core";
import type { TableSituation } from "@/lib/table-situation-core";
import type { Mesa } from "@/types/reserva";
import { SITUATION_ORDER } from "@/components/planta/situation-labels";
import { PlantaCena2D } from "@/components/planta/ao-vivo/PlantaCena2D";
import { PlantaCena3D } from "@/components/planta/ao-vivo/PlantaCena3D";
import { LegendaSituacoes } from "@/components/planta/ao-vivo/LegendaSituacoes";
import { PainelMesa } from "@/components/planta/ao-vivo/PainelMesa";
import { ProximasChegadas } from "@/components/planta/ao-vivo/ProximasChegadas";
import { ResumoFila } from "@/components/planta/ao-vivo/ResumoFila";

const hallKey = (unitId: string) => `salao-ao-vivo:hall:${unitId}`;

function readStoredHall(unitId: string): string | null {
  try {
    return localStorage.getItem(hallKey(unitId));
  } catch {
    return null;
  }
}

export default function SalaoAoVivo() {
  const unit = useCurrentUnit();
  const unitId = unit?.unit_id ?? "";
  const data = useSalaoAoVivo(unitId);
  const now = useNow();
  const narrow = useMediaQuery("(max-width: 639px)");
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [hallPref, setHallPref] = useState<string | null>(() => readStoredHall(unitId));
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const halls = useMemo(() => data.halls.filter((h) => h.active), [data.halls]);
  const tables = useMemo(() => data.tables.filter((t) => t.active && t.hall_id), [data.tables]);
  const hall = halls.find((h) => h.id === hallPref) ?? halls[0] ?? null;
  const today = brtNow(now).date;

  const states = useMemo(
    () =>
      deriveTableStates({
        tables,
        reservations: data.reservations,
        walkIns: data.walkIns,
        waitlistSeated: data.waitlistSeated,
        blocks: data.blocks,
        now,
        durationMinutes: data.durationMinutes,
      }),
    [tables, data.reservations, data.walkIns, data.waitlistSeated, data.blocks, now, data.durationMinutes],
  );

  const hallTables = useMemo(() => tables.filter((t) => t.hall_id === hall?.id), [tables, hall]);
  const plan = useMemo(() => (hall ? hallPlanFrom(hall) : null), [hall]);
  const boxes = useMemo(() => (plan ? resolveTableBoxes(plan, hallTables) : []), [plan, hallTables]);

  const counts = useMemo(() => {
    const c = Object.fromEntries(SITUATION_ORDER.map((s) => [s, 0])) as Record<TableSituation, number>;
    for (const t of hallTables) {
      const s = states.get(t.id);
      if (s) c[s.situation] += 1;
    }
    return c;
  }, [hallTables, states]);

  const timeLabels = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of hallTables) {
      const id = states.get(t.id)?.focusReservationId;
      const r = id ? data.reservations.find((x) => x.id === id) : undefined;
      if (r) m.set(t.id, r.time.slice(0, 5));
    }
    return m;
  }, [hallTables, states, data.reservations]);

  const chooseHall = (id: string) => {
    setHallPref(id);
    try {
      localStorage.setItem(hallKey(unitId), id);
    } catch {
      /* armazenamento indisponível: a escolha vale só nesta sessão */
    }
  };

  const pickTable = (t: Mesa) => {
    if (t.hall_id) chooseHall(t.hall_id);
    setSelectedId(t.id);
  };

  const selectedTable = tables.find((t) => t.id === selectedId) ?? null;

  let content: React.ReactNode;
  if (data.isError) {
    content = (
      <div className="space-y-3 py-8 text-center">
        <p className="text-sm text-muted-foreground">Não foi possível carregar o salão.</p>
        <Button variant="outline" onClick={data.refetch}>
          Tentar de novo
        </Button>
      </div>
    );
  } else if (data.isLoading) {
    content = <Skeleton className="h-[360px] w-full rounded-lg" />;
  } else if (!hall || tables.length === 0 || !plan) {
    content = (
      <p className="py-8 text-center text-sm text-muted-foreground">Cadastre salões e mesas na Gestão</p>
    );
  } else {
    const Cena = narrow || reduced ? PlantaCena2D : PlantaCena3D;
    content = (
      <>
        {hall.plan_width_cm == null && (
          <p className="rounded-md border border-border px-3 py-2 text-sm text-muted-foreground">
            Planta ainda não desenhada; as mesas aparecem em grade automática.
            {unit?.isGerente && (
              <>
                {" "}
                <Link
                  className="font-medium text-foreground underline"
                  to={`/g/${unit.unit_slug}/reservas/saloes/${hall.id}/planta`}
                >
                  Desenhar a planta
                </Link>
              </>
            )}
          </p>
        )}
        <Cena
          plan={plan}
          boxes={boxes}
          states={states}
          timeLabels={timeLabels}
          selectedId={selectedId}
          onSelect={(id) => setSelectedId(id)}
          now={now}
        />
      </>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_372px]">
      <section className="glass space-y-4 rounded-xl p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-[28px] font-semibold tracking-[-0.02em]">Salão ao vivo</h1>
          <span className="rounded-full border border-border px-2.5 py-0.5 text-xs text-muted-foreground">
            {`${hallTables.length} ${hallTables.length === 1 ? "mesa" : "mesas"}`}
          </span>
        </div>
        {halls.length > 1 && (
          <div role="group" aria-label="Ambiente" className="flex flex-wrap gap-2">
            {halls.map((h) => (
              <Button
                key={h.id}
                type="button"
                size="sm"
                variant={h.id === hall?.id ? "default" : "outline"}
                aria-pressed={h.id === hall?.id}
                className={cn("coarse:min-h-[44px]")}
                onClick={() => chooseHall(h.id)}
              >
                {h.name}
              </Button>
            ))}
          </div>
        )}
        <LegendaSituacoes counts={counts} />
        {content}
      </section>
      <aside className="space-y-4">
        <PainelMesa
          table={selectedTable}
          state={selectedTable ? (states.get(selectedTable.id) ?? null) : null}
          reservations={data.reservations}
          walkIns={data.walkIns}
          waitlistSeated={data.waitlistSeated}
        />
        <ProximasChegadas reservations={data.reservations} tables={tables} today={today} onPick={pickTable} />
        <ResumoFila entries={data.waitlistActive} now={now} />
      </aside>
    </div>
  );
}
