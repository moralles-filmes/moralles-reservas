import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

export type TablesRangeValue = {
  count: number;
  min: number;
  max: number;
};

type Props = {
  value: TablesRangeValue;
  onChange: (next: TablesRangeValue) => void;
  /** Mostra o campo de quantidade ("X mesas"). Em modo de edição de 1 mesa pode ocultar. */
  showCount?: boolean;
};

export function TablesRangeInput({ value, onChange, showCount = true }: Props) {
  const [isRange, setIsRange] = useState(value.max > value.min);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2 text-sm">
        {showCount && (
          <Field label="Mesas">
            <Input
              type="number"
              min={1}
              className="w-20"
              value={value.count}
              onChange={(e) => onChange({ ...value, count: Number(e.target.value) || 0 })}
              onBlur={() => {
                if (value.count < 1) onChange({ ...value, count: 1 });
              }}
            />
          </Field>
        )}
        <span className="pb-2 text-muted-foreground">de</span>
        <Field label="Mínimo">
          <Input
            type="number"
            min={1}
            className="w-20"
            value={value.min}
            onChange={(e) => onChange({ ...value, min: Number(e.target.value) || 0 })}
            onBlur={() => {
              const min = Math.max(1, value.min);
              const max = isRange ? Math.max(min, value.max) : min;
              if (min !== value.min || max !== value.max) onChange({ ...value, min, max });
            }}
          />
        </Field>
        {isRange && (
          <>
            <span className="pb-2 text-muted-foreground">a</span>
            <Field label="Máximo">
              <Input
                type="number"
                min={1}
                className="w-20"
                value={value.max}
                onChange={(e) => onChange({ ...value, max: Number(e.target.value) || 0 })}
                onBlur={() => {
                  if (value.max < value.min) onChange({ ...value, max: value.min });
                }}
              />
            </Field>
          </>
        )}
        <span className="pb-2 text-muted-foreground">lugares</span>
      </div>

      <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
        <Switch
          checked={isRange}
          onCheckedChange={(checked) => {
            setIsRange(checked);
            onChange({ ...value, max: checked ? Math.max(value.min + 1, value.max) : value.min });
          }}
        />
        Capacidade variável (ex: 4 a 6 lugares)
      </label>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
