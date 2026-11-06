import { CombinacoesPainel } from "@/components/planta/editor/CombinacoesPainel";
import { combinationKey, type DraftCombination } from "@/lib/table-combination-core";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import { hallPlanErrorMessage, useHallPlanData, useSaveHallPlan } from "@/hooks/useHallPlan";
import {
  GRID_CM,
  applyTablePatch,
  clampBox,
  hallPlanFrom,
  resolveTableBoxes,
  toSavePayload,
} from "@/lib/hall-plan-core";
import type { HallPlan, TableBox } from "@/lib/hall-plan-core";
import type { Mesa } from "@/types/reserva";
import { PlantaEditorCanvas } from "@/components/planta/editor/PlantaEditorCanvas";
import { MesaPropriedades } from "@/components/planta/editor/MesaPropriedades";
import { SalaoPropriedades } from "@/components/planta/editor/SalaoPropriedades";
import { BandejaSemPosicao } from "@/components/planta/editor/BandejaSemPosicao";
import { BreadcrumbReservas } from "./Saloes";
import { HALL_NOT_IN_UNIT_MESSAGE } from "@/lib/layout-errors";

/** Recalcula as sugestões das mesas fora da planta para nunca colidirem com as posicionadas. */
function relayout(plan: HallPlan, boxes: TableBox[], tables: Mesa[]): TableBox[] {
  const byId = new Map(boxes.map((b) => [b.tableId, b]));
  const mesas = tables.map((t) => {
    const b = byId.get(t.id);
    if (!b || !b.positioned) {
      return { ...t, bookable: b?.bookable ?? t.bookable, plan_x: null, plan_y: null, plan_w: null, plan_h: null, plan_rotation: null, plan_shape: null };
    }
    return {
      ...t,
      bookable: b.bookable,
      plan_x: b.x,
      plan_y: b.y,
      plan_w: b.w,
      plan_h: b.h,
      plan_rotation: b.rotation,
      plan_shape: b.shape,
    };
  }) as Mesa[];
  return resolveTableBoxes(plan, mesas);
}

export default function SalaoPlanta() {
  const { hallId = "" } = useParams<{ hallId: string }>();
  const unit = useCurrentUnit();
  const unitId = unit?.unit_id ?? "";
  const unitSlug = unit?.unit_slug ?? "";
  const readOnly = !unit?.isGerente;

  const { data, isLoading, isError, error, refetch } = useHallPlanData(unitId, hallId);
  const save = useSaveHallPlan(unitId, hallId);

  const [plan, setPlan] = useState<HallPlan | null>(null);
  const [boxes, setBoxes] = useState<TableBox[]>([]);
  const [combos, setCombos] = useState<DraftCombination[]>([]);
  const [combosTouched, setCombosTouched] = useState(false);
  const [joinMode, setJoinMode] = useState(false);
  const [multiSelectedIds, setMultiSelectedIds] = useState<string[]>([]);
  const [highlightedKey, setHighlightedKey] = useState<string | null>(null);
  const [initialJson, setInitialJson] = useState("");
  const [seenKey, setSeenKey] = useState("");
  const [revision, setRevision] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Reinicia o estado local quando chegam dados novos (salão, revisão ou lista de mesas) que
  // não são a revisão que esta tela acabou de salvar. Assim nem o cache antigo logo depois de
  // salvar nem o refetch da revisão salva apagam o que foi editado nesse meio-tempo.
  const tablesKey = (data?.tables ?? []).map((t) => `${t.id}:${t.number}`).join(",");
  const keyFor = (rev: string) => `${hallId}|${rev}|${tablesKey}`;
  const dataKey = data ? keyFor(data.hall.updated_at) : "";
  if (data && dataKey !== seenKey) {
    setSeenKey(dataKey);
    if (dataKey !== keyFor(revision)) {
      const p = hallPlanFrom(data.hall);
      const b = resolveTableBoxes(p, data.tables);
      setCombos((data.combinations ?? []).map(c => ({ key: combinationKey(c.table_ids), tableIds: c.table_ids, min: c.min_capacity, max: c.max_capacity })));
      setCombosTouched(false);
      setMultiSelectedIds([]);
      setHighlightedKey(null);
      setJoinMode(false);
      setPlan(p);
      setBoxes(b);
      setInitialJson(JSON.stringify(toSavePayload(p, b)));
      setRevision(data.hall.updated_at);
      setSelectedId(null);
    }
  }

  const dirty = useMemo(
    () => (plan ? JSON.stringify(toSavePayload(plan, boxes, combosTouched ? combos : null)) !== initialJson : false),
    [plan, boxes, combos, combosTouched, initialJson],
  );

  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const tables = data?.tables ?? [];
  const hallUrl = `/g/${unitSlug}/reservas/saloes/${hallId}`;

  const editBoxes = (id: string, fn: (b: TableBox) => TableBox) => {
    if (readOnly || !plan) return;
    setBoxes((prev) =>
      relayout(
        plan,
        prev.map((b) => (b.tableId === id ? clampBox(fn(b), plan) : b)),
        tables,
      ),
    );
  };

  // Os lugares sugeridos já saem sem sobreposição (resolveTableBoxes): só confirma.
  const placeAllPending = () => {
    if (readOnly || !plan) return;
    setBoxes((prev) =>
      relayout(
        plan,
        prev.map((b) => (b.positioned ? b : clampBox({ ...b, positioned: true }, plan))),
        tables,
      ),
    );
  };

  const moveBox = (id: string, x: number, y: number) =>
    editBoxes(id, (b) => ({ ...b, x, y, positioned: true }));

  const sendToTray = (id: string) => {
    if (readOnly || !plan) return;
    setBoxes((prev) => relayout(plan, prev.map((b) => (b.tableId === id ? { ...b, positioned: false } : b)), tables));
  };

  const changePlan = (next: HallPlan) => {
    if (readOnly) return;
    const clamped = boxes.map((b) => (b.positioned ? clampBox(b, next) : b));
    setPlan(next);
    setBoxes(relayout(next, clamped, tables));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (readOnly || !selectedId) return;
    // Só com o foco na lona ou numa mesa; atalhos do navegador (Ctrl+R etc.) passam.
    if (!(e.target as HTMLElement).closest?.("[data-planta-canvas]")) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const step = (e.shiftKey ? 5 : 1) * GRID_CM;
    switch (e.key) {
      case "ArrowLeft":
        e.preventDefault();
        editBoxes(selectedId, (b) => ({ ...b, x: b.x - step, positioned: true }));
        break;
      case "ArrowRight":
        e.preventDefault();
        editBoxes(selectedId, (b) => ({ ...b, x: b.x + step, positioned: true }));
        break;
      case "ArrowUp":
        e.preventDefault();
        editBoxes(selectedId, (b) => ({ ...b, y: b.y - step, positioned: true }));
        break;
      case "ArrowDown":
        e.preventDefault();
        editBoxes(selectedId, (b) => ({ ...b, y: b.y + step, positioned: true }));
        break;
      case "r":
      case "R":
        editBoxes(selectedId, (b) => ({ ...b, rotation: (b.rotation + 15) % 360, positioned: true }));
        break;
      case "Delete":
        e.preventDefault();
        sendToTray(selectedId);
        break;
      default:
    }
  };

  const handleSave = () => {
    if (readOnly || !data || !plan) return;
    const payload = toSavePayload(plan, boxes, combosTouched ? combos : null);
    save.mutate(
      { expectedUpdatedAt: revision, payload },
      {
        onSuccess: (newRevision) => {
          // A revisão nova vale já: o próximo salvamento não espera o refetch.
          setRevision(newRevision);
          setCombosTouched(false);
          setInitialJson(JSON.stringify(toSavePayload(plan, boxes, null)));
          toast.success("Planta salva.");
        },
        onError: (e) => toast.error(hallPlanErrorMessage(e)),
      },
    );
  };

  const confirmLeave = (e: React.MouseEvent) => {
    if (dirty && !window.confirm("Há alterações não salvas. Sair mesmo assim?")) e.preventDefault();
  };

  const hallName = data?.hall.name;
  const selected = boxes.find((b) => b.tableId === selectedId) ?? null;

  const header = (
    <header className="space-y-1">
      <BreadcrumbReservas current={hallName ? `Planta · ${hallName}` : "Planta"} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" asChild className="min-h-11 min-w-11">
            <Link to={hallUrl} aria-label="Voltar" onClick={confirmLeave}>
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <h1 className="text-2xl font-bold">{hallName ? `Planta · ${hallName}` : "Planta"}</h1>
        </div>
        <div className="flex items-center gap-3">
          {readOnly && <span className="text-xs text-muted-foreground">Somente leitura</span>}
          {!readOnly && (
            <Button
              type="button"
              className="min-h-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              disabled={!dirty || save.isPending}
              onClick={handleSave}
            >
              Salvar
            </Button>
          )}
        </div>
      </div>
    </header>
  );

  if (isLoading) {
    return (
      <div className="space-y-5">
        {header}
        <div className="flex flex-col gap-5 lg:flex-row">
          <Skeleton className="aspect-[4/3] w-full flex-1" />
          <Skeleton className="h-64 w-full lg:w-80" />
        </div>
      </div>
    );
  }

  // Salão de outra unidade (a RLS libera todas as do membro) ou inexistente: sem retry nem ação.
  if (!data && error?.message === HALL_NOT_IN_UNIT_MESSAGE) {
    return (
      <div className="space-y-5">
        {header}
        <div className="surface space-y-3 rounded-lg border border-border p-6">
          <p className="text-sm">{HALL_NOT_IN_UNIT_MESSAGE}</p>
          <Button asChild variant="outline" className="min-h-11">
            <Link to={`/g/${unitSlug}/reservas/saloes`}>Voltar para os salões</Link>
          </Button>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-5">
        {header}
        <div className="surface space-y-3 rounded-lg border border-border p-6">
          <p className="text-sm">Não foi possível carregar a planta.</p>
          <Button type="button" variant="outline" className="min-h-11" onClick={() => refetch()}>
            Tentar de novo
          </Button>
        </div>
      </div>
    );
  }

  if (tables.length === 0) {
    return (
      <div className="space-y-5">
        {header}
        <div className="surface space-y-3 rounded-lg border border-border p-6">
          <p className="text-sm">Cadastre mesas neste salão para montar a planta</p>
          <Button asChild variant="outline" className="min-h-11">
            <Link to={hallUrl}>Voltar ao salão</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5" onKeyDown={onKeyDown}>
      {header}
      {isError && (
        <p role="status" className="text-sm text-destructive">
          Não foi possível atualizar a planta agora. O que você editou continua aqui.
        </p>
      )}
      <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
        <div className="w-full flex-1">
          {plan && (
            <PlantaEditorCanvas
              plan={plan}
              boxes={boxes}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onMove={moveBox}
              onResize={(id, w, h) => editBoxes(id, (b) => ({ ...applyTablePatch(b, { w, h }), positioned: true }))}
              onEntranceChange={(entrance) => changePlan({ ...plan, entrance })}
              multiSelectedIds={multiSelectedIds}
              joinMode={joinMode}
              onToggleMulti={(id) => setMultiSelectedIds(prev => prev.includes(id) ? prev.filter(v => v !== id) : [...prev, id])}
              highlightCombination={combos.find(c => c.key === highlightedKey)?.tableIds ?? null}
              readOnly={readOnly}
            />
          )}
        </div>
        <div className="w-full space-y-4 lg:w-80">
          <MesaPropriedades
            box={selected}
            readOnly={readOnly}
            onChange={(patch) =>
              selected && editBoxes(selected.tableId, (b) => ({ ...applyTablePatch(b, patch), positioned: true }))
            }
            onBookableChange={(bookable) => {
              if (!selected || readOnly) return;
              const affected = combos.some(c => c.tableIds.includes(selected.tableId));
              if (!bookable && affected) {
                if (!window.confirm(`As combinações com a mesa ${selected.number} serão desfeitas. Continuar?`)) return;
                setCombos(prev => prev.filter(c => !c.tableIds.includes(selected.tableId)));
                setCombosTouched(true);
              }
              editBoxes(selected.tableId, b => ({ ...b, bookable }));
            }}
            onRemove={() => selected && sendToTray(selected.tableId)}
          />
          <CombinacoesPainel boxes={boxes} combinations={combos} joinMode={joinMode} onJoinModeChange={setJoinMode}
            multiSelectedIds={multiSelectedIds} onClearMulti={() => setMultiSelectedIds([])}
            onAdd={drafts => { setCombos(prev => [...prev, ...drafts]); setCombosTouched(true); }}
            onRemove={key => { setCombos(prev => prev.filter(c => c.key !== key)); setCombosTouched(true); if (highlightedKey === key) setHighlightedKey(null); }}
            highlightedKey={highlightedKey} onHighlight={setHighlightedKey} readOnly={readOnly} />
          <BandejaSemPosicao
            boxes={boxes}
            readOnly={readOnly}
            onPlace={(id) => editBoxes(id, (b) => ({ ...b, positioned: true }))}
            onPlaceAll={placeAllPending}
          />
          {plan && <SalaoPropriedades plan={plan} readOnly={readOnly} onChange={changePlan} />}
        </div>
      </div>
    </div>
  );
}
