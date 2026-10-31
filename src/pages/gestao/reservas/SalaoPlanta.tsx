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

/** Recalcula as sugestões das mesas fora da planta para nunca colidirem com as posicionadas. */
function relayout(plan: HallPlan, boxes: TableBox[], tables: Mesa[]): TableBox[] {
  const byId = new Map(boxes.map((b) => [b.tableId, b]));
  const mesas = tables.map((t) => {
    const b = byId.get(t.id);
    if (!b || !b.positioned) {
      return { ...t, plan_x: null, plan_y: null, plan_w: null, plan_h: null, plan_rotation: null, plan_shape: null };
    }
    return {
      ...t,
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

  const { data, isLoading, isError, refetch } = useHallPlanData(unitId, hallId);
  const save = useSaveHallPlan(unitId, hallId);

  const [plan, setPlan] = useState<HallPlan | null>(null);
  const [boxes, setBoxes] = useState<TableBox[]>([]);
  const [initialJson, setInitialJson] = useState("");
  const [initKey, setInitKey] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Reinicia o estado local quando chega o salão (ou uma nova revisão depois de salvar).
  const dataKey = data ? `${data.hall.id}|${data.hall.updated_at}` : "";
  if (data && dataKey !== initKey) {
    const p = hallPlanFrom(data.hall);
    const b = resolveTableBoxes(p, data.tables);
    setPlan(p);
    setBoxes(b);
    setInitialJson(JSON.stringify(toSavePayload(p, b)));
    setInitKey(dataKey);
    setSelectedId(null);
  }

  const dirty = useMemo(
    () => (plan ? JSON.stringify(toSavePayload(plan, boxes)) !== initialJson : false),
    [plan, boxes, initialJson],
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
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
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
      case "Backspace":
        e.preventDefault();
        sendToTray(selectedId);
        break;
      default:
    }
  };

  const handleSave = () => {
    if (readOnly || !data || !plan) return;
    save.mutate(
      { expectedUpdatedAt: data.hall.updated_at, payload: toSavePayload(plan, boxes) },
      {
        onSuccess: () => toast.success("Planta salva."),
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

  if (isError || !data) {
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
      <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
        <div className="w-full flex-1">
          {plan && (
            <PlantaEditorCanvas
              plan={plan}
              boxes={boxes}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onMove={moveBox}
              readOnly={readOnly}
            />
          )}
        </div>
        <div className="w-full space-y-4 lg:w-80">
          <MesaPropriedades
            box={selected}
            readOnly={readOnly}
            onChange={(patch) => selected && editBoxes(selected.tableId, (b) => ({ ...b, ...patch, positioned: true }))}
            onRemove={() => selected && sendToTray(selected.tableId)}
          />
          <BandejaSemPosicao
            boxes={boxes}
            readOnly={readOnly}
            onPlace={(id) => editBoxes(id, (b) => ({ ...b, positioned: true }))}
          />
          {plan && <SalaoPropriedades plan={plan} readOnly={readOnly} onChange={changePlan} />}
        </div>
      </div>
    </div>
  );
}
