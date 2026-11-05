import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { Maximize2, Minimize2 } from "lucide-react";
import { useFullscreen } from "@/hooks/useFullscreen";
import { useViewportHeight } from "@/components/planta/ao-vivo/useContainerWidth";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useNow } from "@/hooks/useNow";
import { useSalaoAoVivo } from "@/hooks/useSalaoAoVivo";
import { useWalkIns } from "@/hooks/useWalkIns";
import { useNotifyWaitlist } from "@/hooks/useWaitlist";
import { useWaitlistTemplates } from "@/hooks/useWaitlistTemplates";
import { buildWaitlistMessage } from "@/lib/waitlist-message";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { hallPlanFrom, resolveTableBoxes } from "@/lib/hall-plan-core";
import { brtNow, deriveTableStates } from "@/lib/table-situation-core";
import type { TableSituation } from "@/lib/table-situation-core";
import type { Mesa, WaitlistEntry } from "@/types/reserva";
import { SITUATION_ORDER } from "@/components/planta/situation-labels";
import { arrangeHalls } from "@/lib/hall-arrange-core";
import { PlantaCena2D, type SceneHall } from "@/components/planta/ao-vivo/PlantaCena2D";
import { PlantaCena3D } from "@/components/planta/ao-vivo/PlantaCena3D";
import { LegendaSituacoes } from "@/components/planta/ao-vivo/LegendaSituacoes";
import { PainelMesa } from "@/components/planta/ao-vivo/PainelMesa";
import { AcoesMesa } from "@/components/planta/ao-vivo/AcoesMesa";
import { ProximasChegadas } from "@/components/planta/ao-vivo/ProximasChegadas";
import { ResumoFila } from "@/components/planta/ao-vivo/ResumoFila";
import { WaitlistEntryDialog } from "@/components/waitlist/WaitlistEntryDialog";

const ALL_HALLS = "all";
/** Padding da camada + da section + espaço entre blocos + folga para avisos, em px. */
const FULLSCREEN_CHROME_PX = 120;
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
  const [pickedReservationId, setPickedReservationId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const fullscreen = useFullscreen();
  const viewportH = useViewportHeight();
  const topRef = useRef<HTMLDivElement>(null);
  const [topH, setTopH] = useState(0);
  useEffect(() => {
    const el = topRef.current;
    if (!fullscreen.active || !el) return;
    const measure = () => setTopH(el.offsetHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fullscreen.active]);
  const [focus, setFocus] = useState<{ tableId: string; nonce: number } | undefined>(undefined);
  const walkInsAtivos = useWalkIns(unitId);
  const waitingWalkIns = useMemo(
    () => (walkInsAtivos.data ?? []).filter((w) => w.status === "waiting"),
    [walkInsAtivos.data],
  );
  const { data: templates } = useWaitlistTemplates(unitId);
  const notify = useNotifyWaitlist(unitId);

  const callNext = (entry: WaitlistEntry) => {
    if (!entry.customer_phone || (notify.isPending && notify.variables?.id === entry.id)) return;
    const message = buildWaitlistMessage(entry, "table_ready", {
      templates,
      unitName: unit?.unit_name,
      origin: window.location.origin,
    });
    notify.mutate({ id: entry.id, message });
  };

  // O inicializador do useState roda uma vez: ao trocar de unidade, relê a preferência dela.
  useEffect(() => {
    setHallPref(readStoredHall(unitId));
    setSelectedId(null);
    setPickedReservationId(null);
  }, [unitId]);

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
        occupantTables: data.occupantTables,
      }),
    [tables, data.reservations, data.walkIns, data.waitlistSeated, data.blocks, now, data.durationMinutes, data.occupantTables],
  );

  const viewAll = halls.length > 1 && hallPref === ALL_HALLS;
  const visibleHalls = useMemo(() => (viewAll ? halls : hall ? [hall] : []), [viewAll, halls, hall]);
  const hallTables = useMemo(() => {
    const ids = new Set(visibleHalls.map((h) => h.id));
    return tables.filter((t) => t.hall_id && ids.has(t.hall_id));
  }, [tables, visibleHalls]);

  const scene = useMemo(() => {
    const items: SceneHall[] = visibleHalls.map((h) => {
      const plan = hallPlanFrom(h);
      return {
        id: h.id,
        name: h.name,
        plan,
        boxes: resolveTableBoxes(
          plan,
          tables.filter((t) => t.hall_id === h.id),
        ),
        xCm: 0,
        yCm: 0,
        undrawn: h.plan_width_cm == null,
      };
    });
    if (!viewAll) {
      const only = items[0];
      return { halls: items, layout: only ? { widthCm: only.plan.widthCm, depthCm: only.plan.depthCm } : null };
    }
    const arranged = arrangeHalls(items.map((i) => ({ id: i.id, widthCm: i.plan.widthCm, depthCm: i.plan.depthCm })));
    return {
      halls: items.map((i) => ({ ...i, ...arranged.placements.get(i.id)! })),
      layout: { widthCm: arranged.widthCm, depthCm: arranged.depthCm },
    };
  }, [visibleHalls, tables, viewAll]);

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

  const applyHall = (id: string) => {
    setHallPref(id);
    try {
      localStorage.setItem(hallKey(unitId), id);
    } catch {
      /* armazenamento indisponível: a escolha vale só nesta sessão */
    }
  };

  // Troca pelo seletor limpa a mesa selecionada (ela pode ser de outro salão).
  const chooseHall = (id: string) => {
    applyHall(id);
    setSelectedId(null);
    setPickedReservationId(null);
    setFocus(undefined);
  };

  // Vindo de próximas chegadas, a troca de salão mantém a mesa recém escolhida.
  const pickTable = (t: Mesa, reservationId: string) => {
    if (viewAll) {
      setFocus({ tableId: t.id, nonce: Date.now() });
    } else if (t.hall_id) {
      applyHall(t.hall_id);
    }
    setSelectedId(t.id);
    setPickedReservationId(reservationId);
  };

  const selectedTable = tables.find((t) => t.id === selectedId) ?? null;
  const selectedState = selectedTable ? (states.get(selectedTable.id) ?? null) : null;

  let content: React.ReactNode;
  if (!unitId) {
    content = <Skeleton className="h-[360px] w-full rounded-lg" />;
  } else if (data.isError && !data.hasData) {
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
  } else if (!hall || tables.length === 0 || !scene.layout) {
    content = (
      <p className="py-8 text-center text-sm text-muted-foreground">Cadastre salões e mesas na Gestão</p>
    );
  } else {
    const Cena = narrow || reduced ? PlantaCena2D : PlantaCena3D;
    content = (
      <>
        {data.isError && (
          <p
            role="status"
            className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-muted-foreground"
          >
            Dados desatualizados
            <Button type="button" size="sm" variant="outline" onClick={data.refetch}>
              Tentar de novo
            </Button>
          </p>
        )}
        {!viewAll && hall.plan_width_cm == null && (
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
          key={viewAll ? ALL_HALLS : hall.id}
          halls={scene.halls}
          layout={scene.layout}
          showLabels={viewAll}
          focus={focus}
          onFocusHandled={() => setFocus(undefined)}
          states={states}
          timeLabels={timeLabels}
          selectedId={selectedId}
          onSelect={(id) => {
            setSelectedId(id);
            setPickedReservationId(null);
          }}
          now={now}
          maxHeightPx={fullscreen.active ? Math.max(240, viewportH - topH - FULLSCREEN_CHROME_PX) : undefined}
        />
      </>
    );
  }

  const page = (
    <div className={cn("grid gap-4 lg:grid-cols-[minmax(0,1fr)_372px]", fullscreen.active && "lg:h-full")}>
      <section className={cn("glass space-y-4 rounded-xl p-4 sm:p-5", fullscreen.active && "lg:h-full lg:overflow-hidden")}>
        <div ref={topRef} className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-[28px] font-semibold tracking-[-0.02em]">Salão ao vivo</h1>
          <span className="rounded-full border border-border px-2.5 py-0.5 text-xs text-muted-foreground">
            {`${hallTables.length} ${hallTables.length === 1 ? "mesa" : "mesas"}`}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-pressed={fullscreen.active}
            className="ml-auto coarse:min-h-[44px]"
            onClick={fullscreen.active ? fullscreen.exit : fullscreen.enter}
          >
            {fullscreen.active ? (
              <Minimize2 className="mr-1.5 h-4 w-4" aria-hidden="true" />
            ) : (
              <Maximize2 className="mr-1.5 h-4 w-4" aria-hidden="true" />
            )}
            {fullscreen.active ? "Sair da tela cheia" : "Tela cheia"}
          </Button>
        </div>
        {halls.length > 1 && (
          <div role="group" aria-label="Ambiente" className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant={viewAll ? "default" : "outline"}
              aria-pressed={viewAll}
              className={cn("coarse:min-h-[44px]")}
              onClick={() => chooseHall(ALL_HALLS)}
            >
              Todos
            </Button>
            {halls.map((h) => (
              <Button
                key={h.id}
                type="button"
                size="sm"
                variant={!viewAll && h.id === hall?.id ? "default" : "outline"}
                aria-pressed={!viewAll && h.id === hall?.id}
                className={cn("coarse:min-h-[44px]")}
                onClick={() => chooseHall(h.id)}
              >
                {h.name}
              </Button>
            ))}
          </div>
        )}
        <LegendaSituacoes counts={counts} />
        </div>
        {content}
      </section>
      <aside className={cn("space-y-4", fullscreen.active && "lg:h-full lg:overflow-y-auto")}>
        <PainelMesa
          table={selectedTable}
          state={selectedState}
          reservations={data.reservations}
          tables={tables}
          states={states}
          occupantTables={data.occupantTables}
          walkIns={data.walkIns}
          waitlistSeated={data.waitlistSeated}
          now={now}
          durationMinutes={data.durationMinutes}
          pickedReservationId={pickedReservationId}
          actions={
            selectedTable && selectedState ? (
              <AcoesMesa
                unitId={unitId}
                basePath={unit?.unit_slug ? `/o/${unit.unit_slug}` : undefined}
                table={selectedTable}
                state={selectedState}
                now={now}
                reservations={data.reservations}
                waitlistSeated={data.waitlistSeated}
                waitlistActive={data.waitlistActive}
                waitingWalkIns={waitingWalkIns}
                blocks={data.blocks}
              />
            ) : undefined
          }
        />
        <ProximasChegadas reservations={data.reservations} tables={tables} today={today} onPick={pickTable} />
        <ResumoFila
          entries={data.waitlistActive}
          now={now}
          onCall={callNext}
          callingId={notify.isPending ? (notify.variables?.id ?? null) : null}
          onAdd={unitId ? () => setAddOpen(true) : undefined}
        />
      </aside>
    </div>
  );

  // O diálogo fica fora da subárvore que muda de pai na tela cheia: sair dela (Esc do
  // navegador) não remonta o formulário nem perde o que o atendente digitou.
  const dialog = <WaitlistEntryDialog unitId={unitId} open={addOpen} onOpenChange={setAddOpen} />;
  if (!fullscreen.active) {
    return (
      <>
        {page}
        {dialog}
      </>
    );
  }
  // Camada no body em z-50, igual ao menu lateral do AdminShell: vem depois do #root no DOM, então cobre o menu;
  // Dialog, Select e Popover abrem depois (portais posteriores no body) e ficam por cima dela.
  const inset = (side: string) => `max(12px, env(safe-area-inset-${side}))`;
  const layer = createPortal(
    <div
      data-testid="salao-tela-cheia"
      className="fixed inset-0 z-50 overflow-y-auto bg-background lg:overflow-hidden"
      style={{
        paddingTop: inset("top"),
        paddingRight: inset("right"),
        paddingBottom: inset("bottom"),
        paddingLeft: inset("left"),
      }}
    >
      {page}
    </div>,
    document.body,
  );
  return (
    <>
      {layer}
      {dialog}
    </>
  );
}
