import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import { useWidget, useUpdateWidget, useDeleteWidget } from "@/hooks/useWidgets";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
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
import { ArrowLeft, Trash2 } from "lucide-react";
import { WidgetFieldEditor } from "@/components/widgets/WidgetFieldEditor";
import { ShareCard } from "@/components/share/ShareCard";
import { toast } from "sonner";
import { BreadcrumbReservas } from "./Saloes";
import type { WidgetFieldConfigMap } from "@/types/reserva";

type Tab = "compartilhamento" | "personalizacao" | "integracoes";

export default function WidgetDetail() {
  const { widgetId } = useParams<{ widgetId: string }>();
  const unit = useCurrentUnit();
  const unitId = unit?.unit_id ?? "";
  const unitSlug = unit?.unit_slug ?? "";
  const navigate = useNavigate();

  const { data: widget, isLoading } = useWidget(widgetId);
  const updateWidget = useUpdateWidget(unitId);
  const deleteWidget = useDeleteWidget(unitId);

  const [tab, setTab] = useState<Tab>("compartilhamento");

  if (isLoading || !widget) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const publicUrl = `${window.location.origin}/w/${widget.slug}`;

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <BreadcrumbReservas current={widget.name} />
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" asChild>
              <Link to={`/g/${unitSlug}/reservas/widget`} aria-label="Voltar">
                <ArrowLeft className="h-4 w-4" />
              </Link>
            </Button>
            <h1 className="text-2xl font-bold">{widget.name}</h1>
          </div>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm" className="gap-2 text-destructive hover:text-destructive">
                <Trash2 className="h-4 w-4" /> Excluir widget
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Excluir widget?</AlertDialogTitle>
                <AlertDialogDescription>
                  O link público <code>/w/{widget.slug}</code> deixará de funcionar.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancelar</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={() =>
                    deleteWidget.mutate(widget.id, {
                      onSuccess: () => {
                        toast.success("Widget excluído.");
                        navigate(`/g/${unitSlug}/reservas/widget`);
                      },
                    })
                  }
                >
                  Excluir
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </header>

      <Card className="p-0 overflow-hidden">
        <div className="flex border-b">
          <TabButton active={tab === "compartilhamento"} onClick={() => setTab("compartilhamento")}>
            Compartilhamento
          </TabButton>
          <TabButton active={tab === "personalizacao"} onClick={() => setTab("personalizacao")}>
            Personalização
          </TabButton>
          <TabButton active={tab === "integracoes"} onClick={() => setTab("integracoes")}>
            Integrações
          </TabButton>
        </div>

        <div className="p-6">
          {tab === "compartilhamento" && (
            <ShareCard
              url={publicUrl}
              description="Utilize o link abaixo para compartilhar o widget."
            />
          )}
          {tab === "personalizacao" && (
            <PersonalizationTab
              fieldConfig={widget.field_config}
              clientInstructions={widget.client_instructions}
              onSave={(payload) =>
                updateWidget.mutate(
                  { id: widget.id, ...payload },
                  {
                    onSuccess: () => toast.success("Widget atualizado."),
                    onError: (err: Error) => toast.error(err.message ?? "Erro ao salvar."),
                  },
                )
              }
              saving={updateWidget.isPending}
            />
          )}
          {tab === "integracoes" && <IntegrationsTab />}
        </div>
      </Card>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-5 py-3 text-sm font-medium border-b-2 -mb-px transition-colors ${
        active
          ? "border-primary text-primary"
          : "border-transparent text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

// ─── Tab: Personalização ──────────────────────────────────────────────────────

function PersonalizationTab({
  fieldConfig,
  clientInstructions,
  onSave,
  saving,
}: {
  fieldConfig: WidgetFieldConfigMap;
  clientInstructions: string | null;
  onSave: (payload: { field_config: WidgetFieldConfigMap; client_instructions: string | null }) => void;
  saving: boolean;
}) {
  const [config, setConfig] = useState<WidgetFieldConfigMap>(fieldConfig);
  const [instructions, setInstructions] = useState(clientInstructions ?? "");

  useEffect(() => {
    setConfig(fieldConfig);
    setInstructions(clientInstructions ?? "");
  }, [fieldConfig, clientInstructions]);

  const dirty = useMemo(
    () =>
      JSON.stringify(config) !== JSON.stringify(fieldConfig) ||
      (clientInstructions ?? "") !== instructions,
    [config, instructions, fieldConfig, clientInstructions],
  );

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h3 className="text-base font-semibold">Personalizar Widget</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Personalize o widget de reserva conforme suas necessidades.
        </p>
      </div>

      <div className="space-y-2">
        <h4 className="text-sm font-semibold">Customização dos campos</h4>
        <WidgetFieldEditor value={config} onChange={setConfig} />
      </div>

      <div className="space-y-2">
        <h4 className="text-sm font-semibold">Personalização avançada</h4>
        <div className="space-y-1">
          <Label className="text-sm">Instruções para o cliente</Label>
          <Textarea
            rows={3}
            placeholder="Escreva aqui possíveis instruções"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Escreva aqui alguma informação ou recado para o seu cliente estar ciente no momento da
            reserva.
          </p>
        </div>
      </div>

      <div className="flex justify-end">
        <Button
          onClick={() =>
            onSave({
              field_config: config,
              client_instructions: instructions.trim() || null,
            })
          }
          disabled={!dirty || saving}
        >
          {saving ? "Salvando…" : "Salvar"}
        </Button>
      </div>
    </div>
  );
}

// ─── Tab: Integrações ─────────────────────────────────────────────────────────

function IntegrationsTab() {
  return (
    <div className="py-12 text-center text-muted-foreground space-y-2 max-w-md mx-auto">
      <p className="text-base font-medium text-foreground">Integrações</p>
      <p className="text-sm">
        Em breve: Google Tag Manager, Meta Pixel, e webhooks para eventos de reserva.
      </p>
    </div>
  );
}
