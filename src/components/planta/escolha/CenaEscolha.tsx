import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import type { PlanShape, TableBox } from "@/lib/hall-plan-core";
import type { TableState } from "@/lib/table-situation-core";
import type { PlanWall, SeatChoice, SeatMap } from "@/types/reserva";
import { PlantaCena2D, type CenaProps, type SceneHall } from "../ao-vivo/PlantaCena2D";
import { PlantaCena3D } from "../ao-vivo/PlantaCena3D";
import { seatLabel } from "./seat-label";

type SeatOption = SeatMap["options"][number];

interface Props {
  map: SeatMap;
  partySize: number;
  selected: SeatChoice | null;
  onChoose: (choice: SeatChoice, label: string) => void;
}

const NO_TIME_LABELS = new Map<string, string>();

export function CenaEscolha({ map, partySize, selected, onChoose }: Props) {
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [topView, setTopView] = useState(false);
  const [optionTable, setOptionTable] = useState<string | null>(null);
  const now = useMemo(() => new Date(), []);

  // Cena montada uma vez por mapa: tocar numa mesa só muda a seleção.
  const scene = useMemo(() => {
    const plan = map.hall.plan;
    if (!plan) return null;
    const options = map.options.filter(option => option.available);
    const selectable = new Set(options.flatMap(option => option.tableIds));
    const hall: SceneHall = {
      id: map.hall.id, name: map.hall.name, xCm: 0, yCm: 0, undrawn: false,
      plan: {
        widthCm: plan.widthCm, depthCm: plan.depthCm,
        entrance: plan.entranceWall ? { wall: plan.entranceWall as PlanWall, offsetCm: plan.entranceOffsetCm ?? 0 } : null,
        windowWalls: plan.windowWalls as PlanWall[],
      },
      boxes: map.tables.flatMap((table): TableBox[] => table.plan ? [{
        ...table.plan, shape: table.plan.shape as PlanShape, tableId: table.id, number: table.number,
        capacity: map.options.find(option => option.choice.kind === "table" && option.choice.id === table.id)?.maxCapacity ?? 0,
        positioned: true, bookable: table.bookable,
      }] : []),
    };
    // Nunca a situação real: livre ou, fora das opções disponíveis, "Bloqueada" (sem dizer por quê).
    const states = new Map<string, TableState>(
      map.tables.map(table => [table.id, { situation: selectable.has(table.id) ? "free" : "blocked" }]),
    );
    return { plan, options, selectable, hall, states };
  }, [map]);

  if (!scene) return null;
  const { plan, options, selectable, hall, states } = scene;

  const chosen = options.find(option => option.choice.kind === selected?.kind && option.choice.id === selected?.id);
  const label = (option: SeatOption) => seatLabel(
    map.tables.filter(table => option.tableIds.includes(table.id)).map(table => table.number),
  );
  const choose = (option: SeatOption) => {
    onChoose(option.choice, label(option));
    setOptionTable(null);
  };
  const props: CenaProps = {
    halls: [hall], layout: { widthCm: plan.widthCm, depthCm: plan.depthCm }, showLabels: false,
    states, timeLabels: NO_TIME_LABELS, selectedId: null, now,
    pick: { selectable, selected: new Set(chosen?.tableIds ?? []) },
    onSelect: tableId => {
      const matches = options.filter(option => option.tableIds.includes(tableId));
      if (matches.length === 1) choose(matches[0]);
      else if (matches.length > 1) setOptionTable(tableId);
    },
  };
  const optionsOfTable = optionTable ? options.filter(option => option.tableIds.includes(optionTable)) : [];

  return (
    <div className="space-y-3">
      {!reducedMotion && <Button type="button" variant="outline" className="coarse:min-h-11 coarse:min-w-11" onClick={() => setTopView(value => !value)}>
        {topView ? "Ver inclinado" : "Ver de cima"}
      </Button>}
      {topView || reducedMotion ? <PlantaCena2D {...props} /> : <PlantaCena3D {...props} />}
      {/* Lista na própria página (não um diálogo dentro do diálogo do wizard). */}
      {optionsOfTable.length > 1 && (
        <div role="group" aria-label="Escolha as mesas" className="surface rounded-card space-y-2 p-3">
          <p className="text-sm text-muted-foreground">
            Opções para {partySize} {partySize === 1 ? "pessoa" : "pessoas"}:
          </p>
          <div className="flex flex-col gap-2">
            {optionsOfTable.map(option => (
              <Button type="button" variant="outline" className="min-h-11" key={`${option.choice.kind}:${option.choice.id}`} onClick={() => choose(option)}>
                {label(option)}{option.choice.kind === "table" ? " sozinha" : ""} · até {option.maxCapacity}
              </Button>
            ))}
            <Button type="button" variant="ghost" className="min-h-11" onClick={() => setOptionTable(null)}>Cancelar</Button>
          </div>
        </div>
      )}
    </div>
  );
}
