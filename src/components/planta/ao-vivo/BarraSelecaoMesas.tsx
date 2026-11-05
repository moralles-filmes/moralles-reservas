import { useEffect } from "react";
import { Button } from "@/components/ui/button";

interface Props {
  mode: "move" | "join";
  label: string;
  selectedNumbers: number[];
  canConfirm: boolean;
  busy: boolean;
  onConfirm(): void;
  onCancel(): void;
}

/** Barra da escolha de mesas: confirma ou cancela; Esc também cancela. */
export function BarraSelecaoMesas({ mode, label, selectedNumbers, canConfirm, busy, onConfirm, onCancel }: Props) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onCancel]);
  return (
    <div
      role="region"
      aria-label="Seleção de mesas"
      className="surface space-y-2 rounded-lg p-3 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-2"
    >
      <p>{mode === "move" ? `Escolha a nova mesa de ${label}` : `Escolha as mesas para juntar (${label})`}</p>
      <p>{selectedNumbers.length > 0 && `${selectedNumbers.length === 1 ? "Mesa " : "Mesas "}${selectedNumbers.join("+")}`}</p>
      <div className="flex flex-wrap gap-2">
        <Button className="coarse:min-h-[44px]" disabled={!canConfirm || busy} onClick={onConfirm}>
          Confirmar
        </Button>
        <Button variant="outline" className="coarse:min-h-[44px]" onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </div>
  );
}
