import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import {
  WAITLIST_TEMPLATES,
  WAITLIST_VARIABLES,
  getWaitlistTemplateMeta,
  renderWaitlistTemplate,
  useUpsertWaitlistTemplate,
  useWaitlistTemplates,
} from "@/hooks/useWaitlistTemplates";
import {
  useUpdateWaitlistSettings,
  useWaitlistSettings,
} from "@/hooks/useWaitlistSettings";
import type { WaitlistTemplateEvent } from "@/types/reserva";
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

type Tab = "customizacao" | "configuracoes";

export default function FilaComunicacao() {
  const unit = useCurrentUnit();
  const unitId = unit?.unit_id ?? "";
  const [tab, setTab] = useState<Tab>("customizacao");

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <BreadcrumbFila current="Comunicação" />
        <h1 className="text-2xl font-bold">Comunicação</h1>
      </header>

      <Card className="p-0 overflow-hidden">
        <div className="flex border-b">
          <TabButton active={tab === "customizacao"} onClick={() => setTab("customizacao")}>
            Customização de mensagens
          </TabButton>
          <TabButton active={tab === "configuracoes"} onClick={() => setTab("configuracoes")}>
            Configurações
          </TabButton>
        </div>

        <div className="p-6">
          {tab === "customizacao" && <CustomizacaoTab unitId={unitId} />}
          {tab === "configuracoes" && <ConfiguracoesTab unitId={unitId} />}
        </div>
      </Card>
    </div>
  );
}

// ─── Tab: Customização ────────────────────────────────────────────────────────

function CustomizacaoTab({ unitId }: { unitId: string }) {
  const unit = useCurrentUnit();
  const { data: templates, isLoading } = useWaitlistTemplates(unitId);
  const upsert = useUpsertWaitlistTemplate(unitId);

  const [event, setEvent] = useState<WaitlistTemplateEvent>("entered");
  const [customized, setCustomized] = useState(false);
  const [body, setBody] = useState("");

  const meta = getWaitlistTemplateMeta(event);
  const currentTemplate = useMemo(
    () => templates?.find((t) => t.event === event),
    [templates, event],
  );

  useEffect(() => {
    if (!templates) return;
    if (currentTemplate) {
      setCustomized(currentTemplate.customized);
      setBody(currentTemplate.body || meta.defaultBody);
    } else {
      setCustomized(false);
      setBody(meta.defaultBody);
    }
  }, [event, templates, currentTemplate, meta.defaultBody]);

  const charCount = body.length;
  const overLimit = charCount > meta.maxLength;

  const handleInsertVar = (key: string) => {
    setBody((prev) => prev + (prev.endsWith(" ") || prev === "" ? "" : " ") + `{{${key}}}`);
    setCustomized(true);
  };

  const handleSave = () => {
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

  const preview = renderWaitlistTemplate(customized ? body : meta.defaultBody, {
    cliente_nome: "Maria",
    unidade_nome: unit?.unit_name ?? "Restaurante",
    party_size: 4,
    codigo_fila: 12,
    link_status: `${window.location.origin}/r/${unit?.unit_slug ?? "exemplo"}`,
  });

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-60" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h2 className="text-base font-semibold">Customização de mensagens</h2>
        <p className="text-sm text-muted-foreground">
          Personalize as mensagens de WhatsApp para criar uma experiência única para seus
          clientes. Quando "Personalizar mensagem" estiver desligado, usamos o texto padrão.
        </p>
      </div>

      <div className="space-y-2">
        <Label className="text-sm font-semibold">Mensagem da fila</Label>
        <Label className="text-xs text-muted-foreground">Modelo de mensagem</Label>
        <Select value={event} onValueChange={(v) => setEvent(v as WaitlistTemplateEvent)}>
          <SelectTrigger className="max-w-md">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WAITLIST_TEMPLATES.map((t) => (
              <SelectItem key={t.event} value={t.event}>
                {t.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{meta.description}</p>
      </div>

      <div className="flex items-center gap-2">
        <Switch
          id="customized"
          checked={customized}
          onCheckedChange={setCustomized}
        />
        <Label htmlFor="customized" className="text-sm">
          Personalizar mensagem
        </Label>
      </div>

      <Card className="p-4 bg-muted/30">
        <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-2 block">
          Mensagem
        </Label>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          disabled={!customized}
          rows={5}
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
            {WAITLIST_VARIABLES.map((v) => (
              <button
                key={v.key}
                type="button"
                onClick={() => handleInsertVar(v.key)}
                disabled={!customized}
                className="text-xs px-3 py-1.5 rounded-md bg-background border border-input hover:bg-accent transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
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

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={upsert.isPending || overLimit}>
          {upsert.isPending ? "Salvando…" : "Salvar mensagem"}
        </Button>
      </div>
    </div>
  );
}

// ─── Tab: Configurações ───────────────────────────────────────────────────────

function ConfiguracoesTab({ unitId }: { unitId: string }) {
  const { data: settings, isLoading } = useWaitlistSettings(unitId);
  const update = useUpdateWaitlistSettings(unitId);

  if (isLoading || !settings) {
    return (
      <div className="space-y-3 max-w-2xl">
        <Skeleton className="h-6 w-60" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h2 className="text-base font-semibold">Disparos automáticos</h2>
        <p className="text-sm text-muted-foreground">
          Defina quais mensagens são enviadas automaticamente pelo sistema. A mensagem de mesa
          pronta continua sendo disparada manualmente pelo painel operacional.
        </p>
      </div>

      <ToggleRow
        title="Avisar quando o cliente entrar na fila"
        description="Mensagem disparada em segundos após o cliente entrar na fila (formulário público ou painel). Inclui a senha e o link de acompanhamento."
        checked={settings.waitlist_entered_enabled}
        disabled={update.isPending}
        onChange={(v) => update.mutate({ waitlist_entered_enabled: v })}
      />

      <ToggleRow
        title="Pesquisa de satisfação D+1"
        description="Enviada no dia seguinte às 14h00 (BRT) para todos os clientes que foram sentados pela fila no dia anterior. Edite o texto na aba 'Customização de mensagens'."
        checked={settings.waitlist_feedback_enabled}
        disabled={update.isPending}
        onChange={(v) => update.mutate({ waitlist_feedback_enabled: v })}
      />

      <p className="text-xs text-muted-foreground border-t pt-4">
        Lembrete: para qualquer mensagem ser enviada, é preciso que um canal WhatsApp esteja
        configurado em <span className="font-medium">Plataforma → Automação</span>.
      </p>
    </div>
  );
}

function ToggleRow({
  title,
  description,
  checked,
  disabled,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border rounded-lg p-4">
      <div className="space-y-1">
        <Label className="text-sm font-medium">{title}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

export function BreadcrumbFila({ current }: { current: string }) {
  const unit = useCurrentUnit();
  const unitSlug = unit?.unit_slug ?? "";
  return (
    <nav className="text-xs text-muted-foreground flex items-center gap-1.5">
      <Link to={`/g/${unitSlug}`} className="hover:text-foreground">
        {unit?.unit_name ?? "Unidade"}
      </Link>
      <span>/</span>
      <span>Fila de espera</span>
      <span>/</span>
      <span className="text-foreground">{current}</span>
    </nav>
  );
}
