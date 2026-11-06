import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ResponsiveDialog, ResponsiveDialogContent, ResponsiveDialogHeader, ResponsiveDialogTitle, ResponsiveDialogDescription, ResponsiveDialogBody, ResponsiveDialogFooter } from "@/components/ui/responsive-dialog";
import { CenaEscolha } from "@/components/planta/escolha/CenaEscolha";
import { seatLabel } from "@/components/planta/escolha/seat-label";
import type { SeatChoice, SeatMap } from "@/types/reserva";
import type { WizardState } from "./useReservaWizard";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  map: SeatMap;
  partySize: number;
  initial: SeatChoice | null;
  onConfirm: (seat: NonNullable<WizardState["seat"]>) => void;
}

export function EscolherMesaDialog({ open, onOpenChange, map, partySize, initial, onConfirm }: Props) {
  const [draft, setDraft] = useState(initial);
  const option = map.options.find(o => o.available && o.choice.kind === draft?.kind && o.choice.id === draft?.id);
  const label = option ? seatLabel(map.tables.filter(t => option.tableIds.includes(t.id)).map(t => t.number)) : "";
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-3xl">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Escolha sua mesa</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>Toque numa mesa livre.</ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody>
          <CenaEscolha map={map} partySize={partySize} selected={draft} onChoose={choice => setDraft(choice)} />
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter className="flex-wrap">
          {option && <p className="w-full text-sm text-foreground">{label} · até {option.maxCapacity} pessoas</p>}
          {draft && !option && <p role="status" className="w-full text-sm text-warning">Essa mesa não está mais livre. Escolha outra.</p>}
          <Button type="button" variant="outline" className="min-h-11" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button type="button" className="min-h-11" disabled={!option} onClick={() => {
            if (!option) return;
            onConfirm({ ...option.choice, label, maxCapacity: option.maxCapacity });
            onOpenChange(false);
          }}>Confirmar mesa</Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
