import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { CampoNumero } from "./CampoNumero";
import type { TableBox } from "@/lib/hall-plan-core";
import { combinationKey, defaultCombinationRange, suggestRowCombinations, validateCombinations, type DraftCombination } from "@/lib/table-combination-core";

interface Props {
  boxes: TableBox[];
  combinations: DraftCombination[];
  joinMode: boolean;
  onJoinModeChange: (v: boolean) => void;
  multiSelectedIds: string[];
  onClearMulti: () => void;
  onAdd: (drafts: DraftCombination[]) => void;
  onRemove: (key: string) => void;
  highlightedKey: string | null;
  onHighlight: (key: string | null) => void;
  readOnly?: boolean;
}
const errors = {
  too_few: "Escolha pelo menos 2 mesas",
  not_bookable: "Há mesa fora de reserva na combinação",
  range: "Faixa de pessoas inválida",
  duplicate: "Essa combinação já existe",
};
export function CombinacoesPainel({ boxes, combinations, joinMode, onJoinModeChange, multiSelectedIds, onClearMulti, onAdd, onRemove, highlightedKey, onHighlight, readOnly }: Props) {
  const [draft, setDraft] = useState<DraftCombination | null>(null);
  const [suggestions, setSuggestions] = useState<DraftCombination[] | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [error, setError] = useState("");
  if (readOnly) return null;
  const label = (d: DraftCombination) => `Mesas ${d.tableIds.map(id => boxes.find(b => b.tableId === id)?.number).sort((a, b) => a - b).join(" + ")}`;
  const add = (drafts: DraftCombination[]) => {
    const invalid = validateCombinations([...combinations, ...drafts], boxes)[0];
    if (invalid) { setError(errors[invalid.error]); return; }
    onAdd(drafts); onClearMulti(); setDraft(null); setSuggestions(null); setError("");
  };
  return <section className="surface space-y-3 rounded-lg border border-border p-4">
    <h3 className="text-sm font-semibold">Juntar mesas</h3>
    <Button className="min-h-11" variant="outline" aria-pressed={joinMode} onClick={() => onJoinModeChange(!joinMode)}>Modo juntar</Button>
    {multiSelectedIds.length >= 2 && <Button className="min-h-11" onClick={() => { setError(""); setDraft({ key: combinationKey(multiSelectedIds), tableIds: [...multiSelectedIds], ...defaultCombinationRange(boxes, multiSelectedIds) }); }}>Juntar {multiSelectedIds.length} mesas</Button>}
    {draft && <div className="space-y-2">
      <CampoNumero id="combinacao-min" label="Mínimo de pessoas" value={draft.min} min={1} max={10000} onCommit={min => setDraft({ ...draft, min })} />
      <CampoNumero id="combinacao-max" label="Máximo de pessoas" value={draft.max} min={1} max={10000} onCommit={max => setDraft({ ...draft, max })} />
      <Button className="min-h-11" onClick={() => add([draft])}>Adicionar</Button>
    </div>}
    <Button className="min-h-11" variant="outline" onClick={() => {
      setSuggestions(suggestRowCombinations(boxes, multiSelectedIds.length ? multiSelectedIds : boxes.map(b => b.tableId)).filter(d => !combinations.some(c => c.key === d.key)));
      setChecked([]); setError("");
    }}>Sugerir combinações</Button>
    {suggestions && <div className="space-y-2">
      {!suggestions.length && <p className="text-xs text-muted-foreground">Nenhuma sugestão disponível.</p>}
      {suggestions.map(d => <label key={d.key} className="flex min-h-11 items-center gap-2 text-sm"><Checkbox checked={checked.includes(d.key)} onCheckedChange={v => setChecked(prev => v === true ? [...prev, d.key] : prev.filter(k => k !== d.key))} />{label(d)}</label>)}
      <Button className="min-h-11" disabled={!checked.length} onClick={() => add(suggestions.filter(d => checked.includes(d.key)))}>Adicionar selecionadas</Button>
    </div>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!combinations.length && <p className="text-xs text-muted-foreground">Nenhuma combinação. Marque mesas vizinhas e junte.</p>}
    {combinations.map(d => <div key={d.key} className="space-y-1">
      <button type="button" className="min-h-11 w-full rounded text-left text-sm focus-visible:ring-2 focus-visible:ring-ring" aria-pressed={highlightedKey === d.key} onClick={() => onHighlight(highlightedKey === d.key ? null : d.key)}>{label(d)}<span className="block text-xs text-muted-foreground">Servem de {d.min} a {d.max} pessoas</span></button>
      <Button variant="outline" className="min-h-11" onClick={() => onRemove(d.key)}>Desfazer combinação</Button>
    </div>)}
  </section>;
}
