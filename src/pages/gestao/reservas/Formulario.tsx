import { useState } from "react";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import {
  useCustomFields,
  useCreateCustomField,
  useUpdateCustomField,
  useDeleteCustomField,
  type CreateCustomFieldInput,
} from "@/hooks/useCustomFields";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { FileText, FormInput, ListChecks, Paperclip, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { BreadcrumbReservas } from "./Saloes";
import type { CustomFieldType, UnitCustomField } from "@/types/reserva";

const TYPE_META: Record<CustomFieldType, { label: string; description: string; icon: React.ComponentType<{ className?: string }> }> = {
  text: {
    label: "Texto",
    description: "Campo simples de texto aberto para escrita",
    icon: FileText,
  },
  options: {
    label: "Opções",
    description: "Campo com opções pré-definidas",
    icon: ListChecks,
  },
  file: {
    label: "Arquivo",
    description: "Campo para salvar arquivos na reserva",
    icon: Paperclip,
  },
};

export default function Formulario() {
  const unit = useCurrentUnit();
  const unitId = unit?.unit_id ?? "";
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<UnitCustomField | null>(null);

  const { data: fields, isLoading } = useCustomFields(unitId);
  const remove = useDeleteCustomField(unitId);

  const openNew = () => {
    setEditing(null);
    setModalOpen(true);
  };

  const openEdit = (f: UnitCustomField) => {
    setEditing(f);
    setModalOpen(true);
  };

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <BreadcrumbReservas current="Personalizar formulário de reserva" />
        <h1 className="text-2xl font-bold">Personalizar formulário de reserva</h1>
        <p className="text-sm text-muted-foreground">
          Crie campos extras pra coletar informações específicas dos clientes no momento da
          reserva. Aplica a todas as reservas via portal/widget desta unidade.
        </p>
      </header>

      <Card className="p-0 overflow-hidden">
        <div className="flex justify-end p-4 border-b">
          <Button size="sm" className="gap-2" onClick={openNew}>
            <Plus className="h-4 w-4" />
            Adicionar campo personalizado
          </Button>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Título</TableHead>
              <TableHead>Tipo de campo</TableHead>
              <TableHead>Preenchimento</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              [1, 2].map((i) => (
                <TableRow key={i}>
                  <TableCell colSpan={4}>
                    <Skeleton className="h-8 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : !fields?.length ? (
              <TableRow>
                <TableCell colSpan={4} className="h-32 text-center text-muted-foreground space-y-1">
                  <FormInput className="h-6 w-6 mx-auto opacity-30" />
                  <p>Não há dados</p>
                </TableCell>
              </TableRow>
            ) : (
              fields.map((f) => {
                const meta = TYPE_META[f.type];
                const Icon = meta.icon;
                return (
                  <TableRow
                    key={f.id}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => openEdit(f)}
                  >
                    <TableCell className="font-medium">{f.label}</TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-1.5 text-sm">
                        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                        {meta.label}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-[10px]">
                        {f.required ? "Obrigatório" : "Opcional"}
                      </Badge>
                      {!f.active && (
                        <Badge variant="outline" className="text-[10px] ml-1 text-muted-foreground">
                          Inativo
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8">
                            <Trash2 className="h-3.5 w-3.5 text-destructive" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Excluir campo?</AlertDialogTitle>
                            <AlertDialogDescription>
                              Reservas anteriores que usaram esse campo mantêm o valor gravado,
                              mas o campo deixa de aparecer no formulário público.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancelar</AlertDialogCancel>
                            <AlertDialogAction
                              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                              onClick={() => remove.mutate(f.id)}
                            >
                              Excluir
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </Card>

      {modalOpen && (
        <CustomFieldModal
          unitId={unitId}
          editing={editing}
          onClose={() => setModalOpen(false)}
        />
      )}
    </div>
  );
}

// ─── Modal ────────────────────────────────────────────────────────────────────

function CustomFieldModal({
  unitId,
  editing,
  onClose,
}: {
  unitId: string;
  editing: UnitCustomField | null;
  onClose: () => void;
}) {
  const create = useCreateCustomField(unitId);
  const update = useUpdateCustomField(unitId);

  const [type, setType] = useState<CustomFieldType | null>(editing?.type ?? null);
  const [label, setLabel] = useState(editing?.label ?? "");
  const [required, setRequired] = useState(editing?.required ?? false);
  const [options, setOptions] = useState<string[]>(editing?.options ?? []);
  const [newOption, setNewOption] = useState("");

  const submitting = create.isPending || update.isPending;

  const handleSave = () => {
    if (!type) {
      toast.error("Escolha o tipo do campo.");
      return;
    }
    if (!label.trim()) {
      toast.error("Informe o título do campo.");
      return;
    }
    if (type === "options" && options.length === 0) {
      toast.error("Adicione ao menos uma opção.");
      return;
    }

    const payload: CreateCustomFieldInput = {
      label: label.trim(),
      type,
      options: type === "options" ? options : null,
      required,
    };

    if (editing) {
      update.mutate(
        { id: editing.id, label: payload.label, options: payload.options ?? null, required: payload.required ?? false },
        {
          onSuccess: () => {
            toast.success("Campo atualizado.");
            onClose();
          },
          onError: (err: Error) => toast.error(err.message ?? "Erro ao salvar."),
        },
      );
    } else {
      create.mutate(payload, {
        onSuccess: () => {
          toast.success("Campo criado.");
          onClose();
        },
        onError: (err: Error) => toast.error(err.message ?? "Erro ao criar."),
      });
    }
  };

  const addOption = () => {
    const v = newOption.trim();
    if (!v) return;
    if (options.includes(v)) {
      toast.error("Opção duplicada.");
      return;
    }
    setOptions((prev) => [...prev, v]);
    setNewOption("");
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? "Editar campo personalizado" : "Novo campo personalizado"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-5">
          <div className="space-y-2">
            <Label className="text-xs">
              <span className="text-destructive">*</span> Tipo do campo
            </Label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {(["text", "options", "file"] as CustomFieldType[]).map((t) => {
                const meta = TYPE_META[t];
                const Icon = meta.icon;
                const active = type === t;
                const disabled = !!editing && editing.type !== t; // tipo é imutável no edit
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => !disabled && setType(t)}
                    disabled={disabled}
                    className={cn(
                      "text-left rounded-lg border p-4 transition-all",
                      active
                        ? "border-primary bg-primary/5"
                        : "border-border hover:border-foreground/30",
                      disabled && "opacity-40 cursor-not-allowed",
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <div
                        className={cn(
                          "mt-0.5 h-4 w-4 rounded-full border-2 shrink-0 flex items-center justify-center",
                          active ? "border-primary" : "border-muted-foreground/40",
                        )}
                      >
                        {active && <div className="h-2 w-2 rounded-full bg-primary" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 font-medium text-sm">
                          <Icon className="h-4 w-4" />
                          {meta.label}
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">{meta.description}</p>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
            {editing && (
              <p className="text-[11px] text-muted-foreground">
                O tipo do campo não pode ser alterado depois de criado.
              </p>
            )}
          </div>

          {type && (
            <>
              <div className="space-y-1">
                <Label className="text-xs">
                  <span className="text-destructive">*</span> Título do campo
                </Label>
                <Input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="Ex: Tipo de festa, Restrições alimentares…"
                />
              </div>

              {type === "options" && (
                <div className="space-y-2">
                  <Label className="text-xs">
                    <span className="text-destructive">*</span> Opções pré-definidas
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      value={newOption}
                      onChange={(e) => setNewOption(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addOption();
                        }
                      }}
                      placeholder="Digite uma opção e pressione Enter"
                    />
                    <Button type="button" variant="secondary" onClick={addOption}>
                      Adicionar
                    </Button>
                  </div>
                  {options.length > 0 && (
                    <div className="flex flex-wrap gap-2 pt-1">
                      {options.map((opt, i) => (
                        <Badge key={i} variant="secondary" className="gap-1 pr-1">
                          {opt}
                          <button
                            type="button"
                            onClick={() => setOptions((prev) => prev.filter((_, idx) => idx !== i))}
                            className="ml-0.5 rounded hover:bg-muted-foreground/20 p-0.5"
                            aria-label={`Remover ${opt}`}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {type === "file" && (
                <div className="rounded-md bg-warning/10 border border-warning/20 p-3 text-xs text-warning">
                  ⚠ Upload de arquivo está em fase beta — o campo aparece no formulário, mas a
                  retenção dos arquivos depende de configuração adicional do Storage. Pra MVP,
                  prefira tipos Texto ou Opções.
                </div>
              )}

              <label className="flex items-center gap-3 cursor-pointer">
                <Switch checked={required} onCheckedChange={setRequired} />
                <span className="text-sm">Preenchimento obrigatório</span>
              </label>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancelar
          </Button>
          <Button onClick={handleSave} disabled={submitting || !type}>
            {submitting ? "Salvando…" : "Salvar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
