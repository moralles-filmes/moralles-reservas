import { Minus, Plus } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export const PARTY_SIZE_MIN = 1;
export const PARTY_SIZE_MAX = 50;

export function clampPartySize(
  n: number,
  min: number = PARTY_SIZE_MIN,
  max: number = PARTY_SIZE_MAX,
): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

interface PartySizeInputProps {
  value: number;
  onChange: (n: number) => void;
  id?: string;
  min?: number;
  max?: number;
}

export function PartySizeInput({
  value,
  onChange,
  id = "party_size",
  min = PARTY_SIZE_MIN,
  max = PARTY_SIZE_MAX,
}: PartySizeInputProps) {
  const current = clampPartySize(value, min, max);
  return (
    <div className="flex items-stretch rounded-md border border-input bg-background overflow-hidden">
      <button
        type="button"
        aria-label="Diminuir número de pessoas"
        onClick={() => onChange(clampPartySize(current - 1, min, max))}
        disabled={current <= min}
        className={cn(
          "flex h-12 sm:h-11 w-12 sm:w-11 items-center justify-center text-foreground transition-colors",
          "hover:bg-muted disabled:opacity-40 disabled:hover:bg-transparent",
        )}
      >
        <Minus className="h-4 w-4" />
      </button>
      <Input
        id={id}
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        aria-label="Número de pessoas"
        value={current}
        onChange={(e) => {
          const raw = e.target.value.replace(/\D/g, "");
          if (!raw) {
            onChange(min);
            return;
          }
          onChange(clampPartySize(Number(raw), min, max));
        }}
        className="h-12 sm:h-11 flex-1 rounded-none border-0 border-x border-input text-center text-base focus-visible:ring-0 focus-visible:ring-offset-0"
      />
      <button
        type="button"
        aria-label="Aumentar número de pessoas"
        onClick={() => onChange(clampPartySize(current + 1, min, max))}
        disabled={current >= max}
        className={cn(
          "flex h-12 sm:h-11 w-12 sm:w-11 items-center justify-center text-foreground transition-colors",
          "hover:bg-muted disabled:opacity-40 disabled:hover:bg-transparent",
        )}
      >
        <Plus className="h-4 w-4" />
      </button>
    </div>
  );
}
