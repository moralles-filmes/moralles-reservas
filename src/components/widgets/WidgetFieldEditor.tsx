import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type {
  WidgetFieldConfig,
  WidgetFieldConfigMap,
  WidgetFieldKey,
} from "@/types/reserva";

const FIELD_LABELS: Record<WidgetFieldKey, string> = {
  experiencia: "Experiência",
  estado: "Estado",
  ocasiao: "Ocasião",
  data_nascimento: "Data de nascimento",
  cpf: "CPF",
  cep: "CEP",
  codigo_promocional: "Código promocional",
  observacao: "Observação",
};

const ORDER: WidgetFieldKey[] = [
  "experiencia",
  "estado",
  "ocasiao",
  "data_nascimento",
  "cpf",
  "cep",
  "codigo_promocional",
  "observacao",
];

const FIXED_FIELDS = [
  { label: "Nome completo", note: 'As configurações do campo "Nome completo" são pré-definidas e imutáveis.' },
  { label: "Email", note: 'As configurações do campo "Email" são pré-definidas e imutáveis.' },
  { label: "Celular", note: 'As configurações do campo "Celular" são pré-definidas e imutáveis.' },
];

type Props = {
  value: WidgetFieldConfigMap;
  onChange: (next: WidgetFieldConfigMap) => void;
};

export function WidgetFieldEditor({ value, onChange }: Props) {
  return (
    <div className="rounded-lg border divide-y">
      {FIXED_FIELDS.map((f) => (
        <FixedFieldRow key={f.label} label={f.label} note={f.note} />
      ))}
      {ORDER.map((key) => (
        <FieldRow
          key={key}
          fieldKey={key}
          label={FIELD_LABELS[key]}
          config={value[key]}
          onChange={(next) => onChange({ ...value, [key]: next })}
        />
      ))}
    </div>
  );
}

function FixedFieldRow({ label, note }: { label: string; note: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        className="w-full px-4 py-3 flex items-center gap-2 hover:bg-muted/50 transition-colors text-left"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", open && "rotate-180")} />
        <span className="text-sm">{label}</span>
      </button>
      {open && (
        <div className="px-12 pb-4 text-sm text-muted-foreground">
          {note.split("pré-definidas e imutáveis").map((p, i, arr) =>
            i === arr.length - 1 ? (
              <span key={i}>{p}</span>
            ) : (
              <span key={i}>
                {p}
                <strong className="font-semibold text-foreground">pré-definidas e imutáveis</strong>
              </span>
            ),
          )}
        </div>
      )}
    </div>
  );
}

function FieldRow({
  fieldKey,
  label,
  config,
  onChange,
}: {
  fieldKey: WidgetFieldKey;
  label: string;
  config: WidgetFieldConfig | undefined;
  onChange: (next: WidgetFieldConfig) => void;
}) {
  const [open, setOpen] = useState(false);
  const enabled = config?.enabled ?? false;
  const required = !(config?.required === false || config?.required === undefined);
  // Default: required true (não-opcional) quando habilitado.
  const isOptional = config?.enabled ? !required : true;
  const customLabel = config?.label ?? "";

  const update = (patch: Partial<WidgetFieldConfig>) => {
    onChange({
      enabled,
      required: !isOptional,
      label: customLabel || null,
      ...config,
      ...patch,
    });
  };

  return (
    <div>
      <button
        type="button"
        className="w-full px-4 py-3 flex items-center gap-2 hover:bg-muted/50 transition-colors text-left"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", open && "rotate-180")} />
        <span className="text-sm">{label}</span>
      </button>
      {open && (
        <div className="px-12 pb-4 space-y-3">
          <label className="flex items-center gap-3 cursor-pointer">
            <Switch
              checked={enabled}
              onCheckedChange={(checked) => update({ enabled: checked })}
            />
            <span className="text-sm">{enabled ? "Habilitado" : "Desabilitado"}</span>
          </label>

          {enabled && (
            <>
              <label className="flex items-center gap-3 cursor-pointer">
                <Switch
                  checked={isOptional}
                  onCheckedChange={(checked) => update({ required: !checked })}
                />
                <span className="text-sm">{isOptional ? "Opcional" : "Obrigatório"}</span>
              </label>

              {fieldKey === "observacao" && (
                <div className="space-y-1 max-w-md">
                  <Label className="text-xs">Título do campo</Label>
                  <Input
                    placeholder="Título do campo"
                    value={customLabel}
                    onChange={(e) => update({ label: e.target.value || null })}
                  />
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
