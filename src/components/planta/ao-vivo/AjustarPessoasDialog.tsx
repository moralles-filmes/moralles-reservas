import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { PartySizeInput } from "@/components/reserva/wizard/PartySizeInput";

interface Props {
  open: boolean;
  onOpenChange(open: boolean): void;
  label: string;
  current: number;
  capacity: number;
  busy: boolean;
  onSave(n: number): void;
  onMove(): void;
  onJoin(): void;
}

/** Ajusta o número de pessoas do ocupante; acima da capacidade oferece trocar ou juntar mesas. */
export function AjustarPessoasDialog({
  open,
  onOpenChange,
  label,
  current,
  capacity,
  busy,
  onSave,
  onMove,
  onJoin,
}: Props) {
  const [value, setValue] = useState(current);
  useEffect(() => {
    if (open) setValue(current);
  }, [open, current]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Ajustar pessoas</DialogTitle>
          <DialogDescription>{label}</DialogDescription>
        </DialogHeader>
        <fieldset disabled={busy}>
          <PartySizeInput value={value} onChange={setValue} min={1} max={50} />
        </fieldset>
        {value > capacity && (
          <div>
            <p className="text-sm text-muted-foreground">Não cabe na mesa atual</p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                className="coarse:min-h-[44px]"
                disabled={busy}
                onClick={() => {
                  onOpenChange(false);
                  onMove();
                }}
              >
                Trocar mesa
              </Button>
              <Button
                variant="outline"
                className="coarse:min-h-[44px]"
                disabled={busy}
                onClick={() => {
                  onOpenChange(false);
                  onJoin();
                }}
              >
                Juntar mesas
              </Button>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button className="coarse:min-h-[44px]" disabled={value === current || busy} onClick={() => onSave(value)}>
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
