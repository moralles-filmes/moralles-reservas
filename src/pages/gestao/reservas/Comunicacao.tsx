import { useState } from "react";
import { useParams } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { useWhatsappTemplates } from "@/hooks/useWhatsappTemplates";
import { TemplateStatus } from "@/components/whatsapp/OfficialAutomationTemplate";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import {
  RESERVATION_TEMPLATES,
  RESERVATION_VARIABLES,
  getReservationTemplateMeta,
  renderReservationTemplate,
  useReservationTemplates,
  useUpsertReservationTemplate,
  type ReservationVariableKey,
} from "@/hooks/useReservationTemplates";
import type { ReservationTemplateEvent } from "@/types/reserva";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { BreadcrumbReservas } from "./Saloes";

export default function ReservasComunicacao() {
  const unit = useCurrentUnit();
  const { unitSlug } = useParams();
  if (!unit || unit.unit_slug !== unitSlug) return <p role="status">Carregando unidade…</p>;
  const unitId = unit.unit_id;

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <BreadcrumbReservas current="Comunicação" />
        <h1 className="text-2xl font-bold">Comunicação</h1>
        <p className="text-sm text-muted-foreground">
          Confira as mensagens automáticas de WhatsApp enviadas aos clientes —
          lembrete no dia da reserva (10:00 BRT) e pesquisa de satisfação no dia seguinte
          (14:00 BRT). Habilite ou desabilite cada uma em{" "}
          <span className="font-medium">Reservas → Ajustes</span>.
        </p>
      </header>

      <Card className="p-6">
        <CustomizacaoTab key={unitId} unitId={unitId} />
      </Card>
    </div>
  );
}

function CustomizacaoTab({ unitId }: { unitId: string }) {
  const unit = useCurrentUnit();
  const { isPlatformAdmin } = useAuth();
  const controls = useWhatsappTemplates(unitId, unit?.role, isPlatformAdmin);
  const templatesQuery = useReservationTemplates(unitId);
  const { data: templates, isLoading } = templatesQuery;
  const upsert = useUpsertReservationTemplate(unitId);

  const [event, setEvent] = useState<ReservationTemplateEvent | "cancellation">("reminder_d1");
  const [drafts, setDrafts] = useState<Partial<Record<ReservationTemplateEvent, { customized: boolean; body: string }>>>({});

  const editorEvent = event === "cancellation" ? "reminder_d1" : event;
  const meta = getReservationTemplateMeta(editorEvent);
  const currentTemplate = templates?.find((t) => t.event === editorEvent);
  const draft = drafts[editorEvent] ?? { customized: currentTemplate?.customized ?? false, body: currentTemplate?.body || meta.defaultBody };
  const { customized, body } = draft;
  const setCustomized = (value: boolean) => setDrafts(prev => ({ ...prev, [editorEvent]: { ...draft, customized: value } }));
  const setBody = (value: string | ((previous: string) => string)) => setDrafts(prev => ({ ...prev, [editorEvent]: { ...draft, body: typeof value === 'function' ? value(draft.body) : value, customized: true } }));
  const textAllowed = event !== "cancellation" && controls.query.data?.mode === 'unofficial' && !controls.query.isError && !controls.query.isFetching && controls.canManage;

  const charCount = body.length;
  const overLimit = charCount > meta.maxLength;

  const handleInsertVar = (key: ReservationVariableKey) => {
    setBody(
      (prev) =>
        prev + (prev.endsWith(" ") || prev === "" ? "" : " ") + `{{${key}}}`,
    );
  };

  const handleSave = () => {
    if (!textAllowed || templatesQuery.isError || upsert.isPending) return;
    if (overLimit) {
      toast.error(`Mensagem ultrapassa ${meta.maxLength} caracteres.`);
      return;
    }
    upsert.mutate({
      event,
      customized,
      body: customized ? body : "",
    });
  };

  const previewVars =
    editorEvent === "reminder_d1"
      ? {
        cliente_nome: "Maria",
        horario: "20:30",
        party_size: 4,
        codigo: "ABC123",
        unidade_nome: unit?.unit_name ?? "Restaurante",
        link_acompanhamento: `${window.location.origin}/acompanhar/exemplo`,
      }
      : {
        cliente_nome: "Maria",
        codigo: "ABC123",
        unidade_nome: unit?.unit_name ?? "Restaurante",
      };

  const preview = renderReservationTemplate(
    customized ? body : meta.defaultBody,
    previewVars,
  );

  const allowedVariables = RESERVATION_VARIABLES.filter((v) =>
    meta.variables.includes(v.key),
  );

  if (isLoading && controls.query.data?.mode === 'unofficial') {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-60" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="space-y-2">
        <Label className="text-xs text-muted-foreground">Modelo de mensagem</Label>
        <Select
          value={event}
          onValueChange={(v) => setEvent(v as ReservationTemplateEvent)}
        >
          <SelectTrigger className="min-h-11 max-w-md">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RESERVATION_TEMPLATES.map((t) => (
              <SelectItem key={t.event} value={t.event}>
                {t.label}
              </SelectItem>
            ))}
            <SelectItem value="cancellation">Reserva cancelada</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{event === "cancellation" ? "Mensagem automática enviada quando uma reserva é cancelada." : meta.description}</p>
      </div>

      <TemplateStatus controls={controls} logicalIds={[event === 'reminder_d1' ? 'res_lembrete_dia_v1' : event === 'cancellation' ? 'res_cancelada_v1' : 'res_pesquisa_reserva_v1']} />

      {event !== "cancellation" && controls.query.data?.mode === 'unofficial' && !controls.query.isError && !controls.query.isFetching && <>
        {templatesQuery.isError ? <div role="alert"><p>Não foi possível carregar as mensagens salvas.</p><Button className="min-h-11" onClick={() => void templatesQuery.refetch()}>Recarregar mensagens</Button></div> : <>
          <div className="flex items-center gap-2 min-h-11">
            <Switch
              id="customized"
              checked={customized}
              onCheckedChange={setCustomized}
              disabled={!textAllowed}
            />
            <Label htmlFor="customized" className="flex min-h-11 items-center text-sm">
              Personalizar mensagem
            </Label>
          </div>

          <Card className="p-4 bg-muted/30">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-2 block">
              Mensagem
            </Label>
            <textarea
              aria-label="Mensagem"
              value={body}
              onChange={(e) => {
                setBody(e.target.value);
              }}
              disabled={!customized || !textAllowed}
              rows={7}
              className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60 disabled:cursor-not-allowed font-mono"
              placeholder={meta.defaultBody}
            />
            <div className="flex items-center justify-between mt-2">
              <p
                className={`text-xs ${overLimit ? "text-destructive" : "text-muted-foreground"}`}
              >
                {charCount}/{meta.maxLength}
              </p>
              {!customized && (
                <p className="text-xs text-muted-foreground italic">
                  Editando o texto, "Personalizar mensagem" será ativado automaticamente.
                </p>
              )}
            </div>

            <div className="mt-4 space-y-2">
              <Label className="text-xs font-semibold">Adicionar variável</Label>
              <div className="flex flex-wrap gap-2">
                {allowedVariables.map((v) => (
                  <button
                    key={v.key}
                    type="button"
                    onClick={() => handleInsertVar(v.key)}
                    disabled={!customized || !textAllowed}
                    className="min-h-11 text-xs px-3 py-1.5 rounded-md bg-background border border-input hover:bg-accent transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {v.label}
                  </button>
                ))}
              </div>
            </div>
          </Card>

          <div className="space-y-2">
            <Label className="text-sm font-semibold">Pré-visualização</Label>
            <Card className="p-4 bg-success/10 border-success/20">
              <p className="text-sm whitespace-pre-wrap font-sans">{preview}</p>
            </Card>
          </div>

          <div className="flex justify-end gap-2 flex-wrap">
            <Button className="min-h-11" variant="outline" disabled={!textAllowed} onClick={() => setDrafts(prev => ({ ...prev, [editorEvent]: { body: meta.defaultBody, customized: false } }))}>Restaurar padrão</Button>
            <Button className="min-h-11" onClick={handleSave} disabled={!textAllowed || upsert.isPending || overLimit}>
              {upsert.isPending ? "Salvando…" : "Salvar mensagem"}
            </Button>
          </div>
        </>}
      </>}
    </div>
  );
}
