import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import type { PlanShape, TableBox } from "@/lib/hall-plan-core";
import type { PlanWall, SeatChoice, SeatMap } from "@/types/reserva";
import { PlantaCena2D, type CenaProps, type SceneHall } from "../ao-vivo/PlantaCena2D";
import { PlantaCena3D } from "../ao-vivo/PlantaCena3D";
import { seatLabel } from "./seat-label";

interface Props {
  map: SeatMap;
  partySize: number;
  selected: SeatChoice | null;
  onChoose: (choice: SeatChoice, label: string) => void;
}

export function CenaEscolha({ map, partySize, selected, onChoose }: Props) {
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [topView, setTopView] = useState(false);
  const [optionTable, setOptionTable] = useState<string | null>(null);
  const plan = map.hall.plan;
  if (!plan) return null;

  const options = map.options.filter(option => option.available);
  const selectable = new Set(options.flatMap(option => option.tableIds));
  const chosen = options.find(option => option.choice.kind === selected?.kind && option.choice.id === selected?.id);
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
  const label = (option: SeatMap["options"][number]) => seatLabel(
    map.tables.filter(table => option.tableIds.includes(table.id)).map(table => table.number),
  );
  const choose = (option: SeatMap["options"][number]) => {
    onChoose(option.choice, label(option));
    setOptionTable(null);
  };
  const props: CenaProps = {
    halls: [hall], layout: { widthCm: plan.widthCm, depthCm: plan.depthCm }, showLabels: false,
    // Nunca a situação real: livre ou, fora das opções disponíveis, "Bloqueada" (sem dizer por quê).
    states: new Map(map.tables.map(table => [table.id, { situation: selectable.has(table.id) ? "free" : "blocked" }])),
    timeLabels: new Map(), selectedId: null, now: new Date(),
    pick: { selectable, selected: new Set(chosen?.tableIds ?? []) },
    onSelect: tableId => {
      const matches = options.filter(option => option.tableIds.includes(tableId));
      if (matches.length === 1) choose(matches[0]);
      else if (matches.length > 1) setOptionTable(tableId);
    },
  };
  return (
    <div>
      {!reducedMotion && <Button type="button" variant="outline" className="coarse:min-h-11 coarse:min-w-11" onClick={() => setTopView(value => !value)}>
        {topView ? "Ver inclinado" : "Ver de cima"}
      </Button>}
      {topView || reducedMotion ? <PlantaCena2D {...props} /> : <PlantaCena3D {...props} />}
      <Dialog open={optionTable !== null} onOpenChange={open => { if (!open) setOptionTable(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Escolha as mesas</DialogTitle>
            <DialogDescription>Opções disponíveis para {partySize} {partySize === 1 ? "pessoa" : "pessoas"}.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
          {options.filter(option => option.tableIds.includes(optionTable)).map(option => (
            <Button type="button" variant="outline" className="coarse:min-h-11" key={`${option.choice.kind}:${option.choice.id}`} onClick={() => choose(option)}>
              {label(option)}{option.choice.kind === "table" ? " sozinha" : ""} · até {option.maxCapacity}
            </Button>
          ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
