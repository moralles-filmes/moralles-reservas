import { useEffect, useState } from "react";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import {
  WAITLIST_DEFAULTS,
  useUpdateWaitlistSettings,
  useWaitlistSettings,
  type WaitlistSettings,
} from "@/hooks/useWaitlistSettings";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { HelpCircle } from "lucide-react";
import { toast } from "sonner";
import { DownloadCard } from "@/components/share/DownloadCard";
import { BreadcrumbFila } from "./Comunicacao";

export default function FilaAjustes() {
  const unit = useCurrentUnit();
  const unitId = unit?.unit_id ?? "";
  const unitSlug = unit?.unit_slug ?? "";
  const { data: settings, isLoading } = useWaitlistSettings(unitId);
  const update = useUpdateWaitlistSettings(unitId);

  const [form, setForm] = useState<WaitlistSettings>(WAITLIST_DEFAULTS);

  useEffect(() => {
    if (settings) setForm(settings);
  }, [settings]);

  const handleSave = () => {
    if (form.waitlist_code_min < 1) {
      toast.error("Código mínimo deve ser ≥ 1.");
      return;
    }
    if (form.waitlist_code_max < form.waitlist_code_min) {
      toast.error("Código máximo deve ser ≥ código mínimo.");
      return;
    }
    if (form.waitlist_tolerance_minutes < 0) {
      toast.error("Tolerância deve ser ≥ 0.");
      return;
    }
    if (form.waitlist_remote_entry_limit < 0) {
      toast.error("Limite de entrada remota deve ser ≥ 0.");
      return;
    }
    update.mutate(form);
  };

  const queueUrl = unitSlug
    ? `${window.location.origin}/r/${unitSlug}?action=waitlist`
    : "";

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-60" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <BreadcrumbFila current="Ajustes" />
        <h1 className="text-2xl font-bold">Ajustes de fila</h1>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
        <Card className="p-6 space-y-8">
          {/* Controles - QR Code */}
          <section className="space-y-4">
            <h2 className="text-lg font-semibold">Controles - QR Code</h2>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <CheckboxField
                id="qr-enabled"
                label="Habilitar fila via QR Code"
                checked={form.waitlist_qr_enabled}
                onChange={(v) => setForm({ ...form, waitlist_qr_enabled: v })}
              />
              <CheckboxField
                id="menu-link"
                label="Habilitar link de cardápio no widget de fila"
                checked={form.waitlist_menu_link_enabled}
                onChange={(v) =>
                  setForm({ ...form, waitlist_menu_link_enabled: v })
                }
                help="Quando ativo, o widget de fila exibe um botão pra cardápio digital. (em breve)"
              />
              <CheckboxField
                id="priority-modal"
                label="Habilitar modal de prioritários"
                checked={form.waitlist_priority_enabled}
                onChange={(v) =>
                  setForm({ ...form, waitlist_priority_enabled: v })
                }
                help="Pergunta no formulário se o cliente é prioritário (idoso, gestante, PCD). Prioritários vão pro topo da fila."
              />
            </div>
          </section>

          {/* Configurações gerais */}
          <section className="space-y-4 border-t pt-6">
            <h2 className="text-lg font-semibold">Configurações gerais</h2>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-2xl">
              <div className="space-y-1">
                <LabelWithHelp
                  label="Código mínimo"
                  help="Senha inicial gerada pra primeiro cliente da fila. A numeração é cíclica."
                />
                <Input
                  type="number"
                  min={1}
                  value={form.waitlist_code_min}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      waitlist_code_min: parseInt(e.target.value, 10) || 0,
                    })
                  }
                />
              </div>
              <div className="space-y-1">
                <LabelWithHelp
                  label="Código máximo"
                  help="Quando atinge esse valor, a senha volta pro código mínimo (cíclica)."
                />
                <Input
                  type="number"
                  min={form.waitlist_code_min}
                  value={form.waitlist_code_max}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      waitlist_code_max: parseInt(e.target.value, 10) || 0,
                    })
                  }
                />
              </div>
              <div className="space-y-1">
                <LabelWithHelp
                  label="Tolerância (minutos)"
                  help="Tempo entre notificar o cliente e considerar que não veio."
                />
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={0}
                    max={60}
                    className="w-24"
                    value={form.waitlist_tolerance_minutes}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        waitlist_tolerance_minutes:
                          parseInt(e.target.value, 10) || 0,
                      })
                    }
                  />
                  <span className="text-xs text-muted-foreground">
                    Tempo de tolerância, em minutos.
                  </span>
                </div>
              </div>
            </div>
          </section>

          {/* Entrada remota */}
          <section className="space-y-4 border-t pt-6">
            <h2 className="text-lg font-semibold">Entrada remota</h2>

            <CheckboxField
              id="remote-entry"
              label="Habilitar entrada remota na fila de espera"
              checked={form.waitlist_remote_entry_enabled}
              onChange={(v) =>
                setForm({ ...form, waitlist_remote_entry_enabled: v })
              }
              help="Permite cliente entrar na fila pelo celular antes de chegar ao restaurante."
            />

            <div className="space-y-1 max-w-xs">
              <Label className="text-sm">Limite de pessoas</Label>
              <Input
                type="number"
                min={0}
                value={form.waitlist_remote_entry_limit}
                onChange={(e) =>
                  setForm({
                    ...form,
                    waitlist_remote_entry_limit:
                      parseInt(e.target.value, 10) || 0,
                  })
                }
                disabled={!form.waitlist_remote_entry_enabled}
              />
              <p className="text-xs text-muted-foreground">
                Máximo de clientes simultâneos via entrada remota.
              </p>
            </div>
          </section>

          <div className="flex items-center justify-between border-t pt-6">
            <p className="text-sm font-semibold">Tudo pronto? É só salvar!</p>
            <Button onClick={handleSave} disabled={update.isPending}>
              {update.isPending ? "Salvando…" : "Salvar alterações"}
            </Button>
          </div>
        </Card>

        {/* Sidebar QR */}
        <div className="space-y-3">
          <DownloadCard
            url={queueUrl}
            description="Faça o download do seu QR Code de fila, para utilizar em seu restaurante."
            fileName="qr-fila.png"
          />
        </div>
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function CheckboxField({
  id,
  label,
  checked,
  onChange,
  help,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  help?: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(v) => onChange(v === true)}
      />
      <Label
        htmlFor={id}
        className="text-sm cursor-pointer flex items-center gap-1.5 leading-tight"
      >
        {label}
        {help && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <HelpCircle className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">{help}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </Label>
    </div>
  );
}

function LabelWithHelp({ label, help }: { label: string; help: string }) {
  return (
    <Label className="text-sm flex items-center gap-1.5">
      {label}
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <HelpCircle className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">{help}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </Label>
  );
}
