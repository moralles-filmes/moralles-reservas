import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Props {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  onCommit: (value: number) => void;
  disabled?: boolean;
}

/**
 * Campo numérico com rascunho: aplica ao sair do campo ou no Enter. Validar a cada tecla
 * impediria digitar 800 a partir de vazio (o "8" fica abaixo do mínimo e o campo volta).
 * Fora da faixa, o valor é preso ao limite; vazio ou inválido volta ao valor atual.
 */
export function CampoNumero({ id, label, value, min, max, onCommit, disabled }: Props) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);

  const commit = () => {
    const v = Number(draft);
    if (draft.trim() === "" || !Number.isFinite(v)) {
      setDraft(String(value));
      return;
    }
    const next = Math.round(Math.min(max, Math.max(min, v)));
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };

  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        disabled={disabled}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
      />
    </div>
  );
}
