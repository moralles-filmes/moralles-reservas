import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Trash2 } from "lucide-react";
import { DEFAULT_MENU_THEME, type MenuTheme } from "@/types/reserva";

const FIELDS: Array<{ key: keyof MenuTheme; label: string; clearable?: boolean }> = [
  { key: "font_primary",   label: "Cor primária da fonte" },
  { key: "font_secondary", label: "Cor secundária da fonte", clearable: true },
  { key: "bg_primary",     label: "Cor primária do fundo",   clearable: true },
  { key: "bg_secondary",   label: "Cor secundária do fundo" },
  { key: "accent",         label: "Cor para elementos diversos", clearable: true },
];

export interface ThemeEditorProps {
  value: MenuTheme;
  onChange: (next: MenuTheme) => void;
}

export function ThemeEditor({ value, onChange }: ThemeEditorProps) {
  const handleChange = (key: keyof MenuTheme, hex: string) => {
    onChange({ ...value, [key]: hex });
  };

  const handleClear = (key: keyof MenuTheme) => {
    onChange({ ...value, [key]: DEFAULT_MENU_THEME[key] });
  };

  const handleResetAll = () => {
    onChange({ ...DEFAULT_MENU_THEME });
  };

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold">Cores do cardápio</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Personalize a paleta aplicada na página pública do cardápio.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-3xl">
        {FIELDS.map((f) => (
          <div key={f.key} className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <Label className="text-sm">{f.label}</Label>
              {f.clearable && value[f.key] !== DEFAULT_MENU_THEME[f.key] && (
                <button
                  type="button"
                  onClick={() => handleClear(f.key)}
                  className="text-destructive hover:text-destructive/80"
                  title="Restaurar cor padrão"
                  aria-label={`Restaurar ${f.label}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <ColorRow
              hex={value[f.key]}
              onChange={(hex) => handleChange(f.key, hex)}
            />
          </div>
        ))}
      </div>

      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={handleResetAll}>
          Limpar todas as cores
        </Button>
      </div>
    </div>
  );
}

function ColorRow({
  hex,
  onChange,
}: {
  hex: string;
  onChange: (hex: string) => void;
}) {
  const safeHex = /^#[0-9A-Fa-f]{6}$/.test(hex) ? hex : "#000000";
  return (
    <div className="flex items-center gap-2 border rounded-md px-3 py-2 bg-background">
      <input
        type="color"
        value={safeHex}
        onChange={(e) => onChange(e.target.value.toUpperCase())}
        className="h-6 w-6 rounded shrink-0 border border-border cursor-pointer"
      />
      <Input
        value={hex}
        onChange={(e) => {
          const v = e.target.value.startsWith("#") ? e.target.value : `#${e.target.value}`;
          onChange(v.toUpperCase().slice(0, 7));
        }}
        className="border-0 shadow-none p-0 h-6 font-mono text-sm focus-visible:ring-0"
        placeholder="#000000"
      />
    </div>
  );
}
