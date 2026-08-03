import { useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogBody,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
} from "@/components/ui/responsive-dialog";
import { toast } from "sonner";
import { cn, formatDateBR } from "@/lib/utils";
import { InstanceNotesPanel } from "@/components/platform/InstanceNotesPanel";
import {
  formatCents,
  formatMargin,
  lastAccessDayLabel,
  cycleSourceLabel,
  divergenceLabel,
} from "@/lib/whatsapp-instance-format";
import {
  useWhatsappInstances,
  useWhatsappInstance,
  useWhatsappInstanceAlerts,
  useWhatsappInstanceAction,
  usePartnerSimulation,
  type WhatsappInstance,
  type WhatsappInstanceAlert,
} from "@/hooks/useWhatsappInstances";
import { useAllUnits } from "@/hooks/useAllUnits";
import { RegisterInstanceDialog } from "@/components/platform/RegisterInstanceDialog";
import { UpdateInstanceDialog } from "@/components/platform/UpdateInstanceDialog";

const MIN_REASON_LENGTH = 5;

const LIFECYCLE_LABEL: Record<string, string> = {
  AWAITING_PROVISION: "aguardando provisionamento",
  ACTIVE: "ativa",
  CANCELLATION_REQUESTED: "cancelamento solicitado",
  ENDED: "encerrada",
};

const LIFECYCLE_BADGE: Record<string, string> = {
  AWAITING_PROVISION: "bg-muted text-muted-foreground",
  ACTIVE: "bg-success/10 text-success",
  CANCELLATION_REQUESTED: "bg-warning/10 text-warning",
  ENDED: "bg-muted text-muted-foreground",
};

/** Dias em que não dá para saber se houve ajuste de mês curto (§6.3). */
const AMBIGUOUS_ANCHOR_DAYS = [28, 29, 30];

const CYCLE_STATUS_LABEL: Record<string, string> = {
  OPEN: "em curso",
  CLOSED: "fechado",
  PENDING_REVIEW: "custo pendente",
};

/**
 * Histórico de ciclos de UMA instância, com estimado × realizado e margem.
 *
 * `LIFETIME_OVERRIDE` recebe rótulo próprio e NÃO é pintado como anomalia:
 * margem negativa do cliente cortesia é o custo conhecido de uma decisão
 * comercial, não erro — e essa distinção é o ponto da tela.
 */
function CyclesPanel({ instanceId }: { instanceId: string }) {
  const detail = useWhatsappInstance(instanceId);

  if (detail.isLoading) return <Skeleton className="h-24 w-full" />;

  if (detail.isError) {
    return (
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm">Não foi possível carregar os ciclos.</span>
        <Button variant="outline" size="sm" onClick={() => detail.refetch()}>
          Tentar de novo
        </Button>
      </div>
    );
  }

  const cycles = detail.data?.cycles ?? [];
  if (!cycles.length) {
    return (
      <p className="text-sm text-muted-foreground">
        Nenhum ciclo registrado ainda. Ele nasce quando a data da cobrança é confirmada.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {cycles.map((c) => {
        const courtesy = c.revenue_source === "LIFETIME_OVERRIDE";
        return (
          <div key={c.id} className="rounded-md border p-3 space-y-1 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">
                {formatDateBR(c.cycle_start)} → {formatDateBR(c.provider_due_on)}
              </span>
              <Badge variant="outline">{CYCLE_STATUS_LABEL[c.status] ?? c.status}</Badge>
              {courtesy && <Badge className="bg-info/10 text-info">cortesia vitalícia</Badge>}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
              <p>
                Custo: <strong>{formatCents(c.provider_cost_cents)}</strong>
              </p>
              <p>
                Receita: <strong>{formatCents(c.customer_revenue_cents)}</strong>
              </p>
              <p>
                Margem:{" "}
                <strong>{formatMargin(c.customer_revenue_cents, c.provider_cost_cents)}</strong>
              </p>
            </div>
            {c.status === "PENDING_REVIEW" && (
              <p className="text-xs text-warning">
                Ciclo terminou sem custo informado. Custo desconhecido não é zero — a margem fica
                indefinida até alguém informar.
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

type ReasonDialogKind =
  | { kind: "confirm_date"; instance: WhatsappInstance }
  | { kind: "set_cost"; instance: WhatsappInstance }
  | { kind: "cancel"; instance: WhatsappInstance }
  | { kind: "confirm_end"; instance: WhatsappInstance }
  | { kind: "reactivate"; instance: WhatsappInstance }
  | { kind: "resolve_alert"; alert: WhatsappInstanceAlert }
  | null;

export default function WhatsappInstances() {
  const instancesQuery = useWhatsappInstances();
  const alertsQuery = useWhatsappInstanceAlerts();
  const action = useWhatsappInstanceAction();
  const simulation = usePartnerSimulation();

  const unitsQuery = useAllUnits();

  /**
   * Nome da organização e da unidade a partir do inventário de unidades.
   *
   * `whatsapp_instances` guarda ids, e `manage-whatsapp-instances` devolve ids —
   * a EF não junta com `organizations` de propósito (projeção explícita). O
   * nome vem do hook que o painel já teria que carregar para o seletor de
   * unidade da Tela A.
   */
  const orgNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const u of unitsQuery.data ?? []) {
      if (u.organization_name) m.set(u.organization_id, u.organization_name);
    }
    return m;
  }, [unitsQuery.data]);

  const unitNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const u of unitsQuery.data ?? []) m.set(u.id, u.name);
    return m;
  }, [unitsQuery.data]);

  const [dialog, setDialog] = useState<ReasonDialogKind>(null);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [registerPrefill, setRegisterPrefill] =
    useState<{ organizationId: string; channelId: string | null } | null>(null);
  const [updateTarget, setUpdateTarget] = useState<WhatsappInstance | null>(null);

  function openRegister(prefill: { organizationId: string; channelId: string | null } | null) {
    setRegisterPrefill(prefill);
    setRegisterOpen(true);
  }
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [cycleStart, setCycleStart] = useState("");
  const [anchorDay, setAnchorDay] = useState("");
  const [costReais, setCostReais] = useState("");
  const [accessUntil, setAccessUntil] = useState("");
  const [partnerTargetReais, setPartnerTargetReais] = useState("");

  const openAlerts = useMemo(
    () => (alertsQuery.data ?? []).filter((a) => a.status === "OPEN" || a.status === "ACKNOWLEDGED"),
    [alertsQuery.data],
  );

  const dispatcherOff = useMemo(
    () => openAlerts.some((a) => a.dispatch_enabled_at_enqueue === false),
    [openAlerts],
  );

  function closeDialog() {
    setDialog(null);
    setReason("");
    setCycleStart("");
    setAnchorDay("");
    setCostReais("");
    setAccessUntil("");
  }

  function run(body: { action: string; [k: string]: unknown }, successMsg: string) {
    action.mutate(body, {
      onSuccess: () => {
        toast.success(successMsg);
        closeDialog();
      },
      // A EF devolve mensagem curta em PT-BR; o hook já a extraiu do corpo
      // non-2xx que o invoke mascara.
      onError: (e: Error) => toast.error(e.message),
    });
  }

  const reasonTooShort = reason.trim().length < MIN_REASON_LENGTH;
  const anchorNumber = Number(anchorDay);
  const anchorIsAmbiguous = AMBIGUOUS_ANCHOR_DAYS.includes(anchorNumber);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Instâncias de WhatsApp</h1>
          <p className="text-sm text-muted-foreground max-w-2xl">
            Inventário do que a plataforma paga ao fornecedor. Cancelar no painel da Z-API
            interrompe o <strong>custo da plataforma</strong>, não o serviço do cliente — quem
            interrompe o serviço é o enforcement por inadimplência.
          </p>
        </div>
        <Button onClick={() => openRegister(null)}>Registrar instância</Button>
      </div>

      {dispatcherOff && (
        <Card className="border-info/40 bg-info/5">
          <CardContent className="py-3 text-sm">
            O envio de e-mails de billing está desligado. <strong>Este painel é a superfície viva
            dos alertas</strong> — a fila acumula sem enviar, e ausência de e-mail não significa
            ausência de alerta.
          </CardContent>
        </Card>
      )}

      {/* ── Inventário ────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Inventário</h2>

        {instancesQuery.isLoading && (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        )}

        {/* isError é branch PRÓPRIO: silenciar erro como "lista vazia" já
            mascarou incidente em produção neste projeto. */}
        {instancesQuery.isError && (
          <Card className="border-destructive/40">
            <CardContent className="py-4 flex items-center justify-between gap-3">
              <span className="text-sm">Não foi possível carregar as instâncias.</span>
              <Button variant="outline" size="sm" onClick={() => instancesQuery.refetch()}>
                Tentar de novo
              </Button>
            </CardContent>
          </Card>
        )}

        {!instancesQuery.isLoading && !instancesQuery.isError && !instancesQuery.data?.length && (
          <Card>
            <CardContent className="py-6 text-sm text-muted-foreground">
              Nenhuma instância registrada. O registro é feito por <em>backfill</em> de instância
              que já existe no fornecedor — criação de instância nova está bloqueada até a Fase 6a.
              <div className="pt-3">
                <Button size="sm" onClick={() => openRegister(null)}>
                  Registrar instância existente
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {(instancesQuery.data ?? []).map((inst) => {
          const unknownDate = inst.cycle_source === "UNKNOWN";
          const busy = action.isPending &&
            (action.variables as { instance_id?: string } | undefined)?.instance_id === inst.id;

          return (
            <Card key={inst.id}>
              <CardContent className="py-4 space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge className={cn(LIFECYCLE_BADGE[inst.lifecycle_state])}>
                        {LIFECYCLE_LABEL[inst.lifecycle_state] ?? inst.lifecycle_state}
                      </Badge>
                      <span className="text-sm font-medium">{inst.provider}</span>
                      {inst.provider_instance_ref && (
                        <span className="text-xs text-muted-foreground font-mono">
                          {inst.provider_instance_ref}
                        </span>
                      )}
                      {inst.last_divergence_kind && (
                        <Badge className="bg-warning/10 text-warning">
                          {divergenceLabel(inst.last_divergence_kind)}
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {/* Ainda carregando ou organização fora do alcance de
                          `useAllUnits` (rede sem unidade): o id continua sendo
                          a identificação verdadeira, então ele aparece em vez
                          de um espaço em branco. */}
                      {orgNameById.get(inst.organization_id) ?? `Organização ${inst.organization_id}`}
                      {inst.unit_id && unitNameById.has(inst.unit_id) && (
                        <> · {unitNameById.get(inst.unit_id)}</>
                      )}
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
                  <div>
                    <p className="text-xs text-muted-foreground">Próxima cobrança</p>
                    {unknownDate ? (
                      <p className="font-medium text-warning">{cycleSourceLabel("UNKNOWN")}</p>
                    ) : (
                      <p className="font-medium">
                        {inst.current_cycle_due_on ? formatDateBR(inst.current_cycle_due_on) : "—"}{" "}
                        <span className="text-xs font-normal text-muted-foreground">
                          ({cycleSourceLabel(inst.cycle_source)})
                        </span>
                      </p>
                    )}
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Custo mensal</p>
                    <p className="font-medium">{formatCents(inst.current_monthly_cost_cents)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Acesso até</p>
                    <p className="font-medium">
                      {lastAccessDayLabel(inst.provider_access_until) ?? "—"}
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  {unknownDate && (
                    <Button size="sm" disabled={busy} onClick={() => setDialog({ kind: "confirm_date", instance: inst })}>
                      Confirmar data
                    </Button>
                  )}
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => setDialog({ kind: "set_cost", instance: inst })}>
                    Informar custo
                  </Button>
                  {inst.lifecycle_state === "ACTIVE" && (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => setDialog({ kind: "cancel", instance: inst })}>
                      Registrar cancelamento
                    </Button>
                  )}
                  {inst.lifecycle_state === "CANCELLATION_REQUESTED" && (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => setDialog({ kind: "confirm_end", instance: inst })}>
                      Confirmar encerramento
                    </Button>
                  )}
                  {/* Tela C — SÓ em CANCELLATION_REQUESTED. `ENDED` não mostra
                      nada: `canTransition` recusa mesmo com evidência, e
                      oferecer um botão que sempre falha é mentir para o
                      operador. Instância encerrada que reapareça no fornecedor
                      exige linha nova. */}
                  {inst.lifecycle_state === "CANCELLATION_REQUESTED" && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => setDialog({ kind: "reactivate", instance: inst })}
                    >
                      Reativar
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => setUpdateTarget(inst)}
                  >
                    Corrigir vínculo
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setExpandedId(expandedId === inst.id ? null : inst.id)}
                  >
                    {expandedId === inst.id ? "Ocultar detalhes" : "Ver ciclos, margem e histórico"}
                  </Button>
                </div>

                {expandedId === inst.id && (
                  <div className="border-t pt-3 space-y-4">
                    <div>
                      <h3 className="text-sm font-semibold mb-2">Ciclos e margem</h3>
                      <CyclesPanel instanceId={inst.id} />
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold mb-2">Histórico</h3>
                      <InstanceNotesPanel instanceId={inst.id} />
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </section>

      {/* ── Alertas ───────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Alertas abertos</h2>

        {alertsQuery.isError && (
          <Card className="border-destructive/40">
            <CardContent className="py-4 flex items-center justify-between gap-3">
              <span className="text-sm">Não foi possível carregar os alertas.</span>
              <Button variant="outline" size="sm" onClick={() => alertsQuery.refetch()}>
                Tentar de novo
              </Button>
            </CardContent>
          </Card>
        )}

        {!alertsQuery.isLoading && !alertsQuery.isError && !openAlerts.length && (
          <Card>
            <CardContent className="py-6 text-sm text-muted-foreground">
              Nenhum alerta aberto.
            </CardContent>
          </Card>
        )}

        {openAlerts.map((a) => {
          const busy = action.isPending &&
            (action.variables as { alert_id?: string } | undefined)?.alert_id === a.id;
          const kind = typeof a.payload?.kind === "string" ? a.payload.kind : null;
          const detail = typeof a.payload?.detail === "string" ? a.payload.detail : null;
          // A instância foi EXCLUÍDA fisicamente: a FK nulou `instance_id` e o
          // ledger sobreviveu — `subject_id` continua guardando de quem era o
          // alerta. Sem esta marcação, a linha pareceria um alerta de instância
          // que simplesmente não abre.
          const instanceGone = a.subject_type === "INSTANCE" && !a.instance_id;

          return (
            <Card key={a.id}>
              <CardContent className="py-4 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge className="bg-warning/10 text-warning">{a.alert_type}</Badge>
                  {kind && <Badge variant="outline">{divergenceLabel(kind)}</Badge>}
                  {instanceGone && (
                    <Badge variant="outline" className="text-muted-foreground">
                      instância removida
                    </Badge>
                  )}
                  <span className="text-xs text-muted-foreground">
                    desde {formatDateBR(a.first_detected_at.slice(0, 10))} · {a.occurrences}×
                  </span>
                </div>
                {detail && <p className="text-sm">{detail}</p>}
                <div className="flex flex-wrap gap-2">
                  {/* O alerta deixa de ser aviso e vira o começo da tarefa: ele
                      já carrega organização e canal, então o formulário abre
                      preenchido. */}
                  {a.alert_type === "DIVERGENCE" && kind === "CHANNEL_WITHOUT_INSTANCE" && (
                    <Button
                      size="sm"
                      onClick={() =>
                        openRegister({
                          organizationId: a.organization_id,
                          channelId: a.channel_id,
                        })
                      }
                    >
                      Registrar esta instância
                    </Button>
                  )}
                  {a.status === "OPEN" && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => run({ action: "acknowledge_alert", alert_id: a.id }, "Alerta reconhecido.")}
                    >
                      Reconhecer
                    </Button>
                  )}
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => setDialog({ kind: "resolve_alert", alert: a })}>
                    Resolver
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </section>

      {/* ── Simulador do Partner ──────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Simulador do Plano Partner</h2>
        <Card>
          <CardContent className="py-4 space-y-3">
            <p className="text-sm text-muted-foreground">
              <strong>Simulação.</strong> O sistema não conhece o preço do Plano Partner — a Z-API
              não o publicou para nós. O valor abaixo é informado por você e nada é gravado.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="partner-target">Preço-alvo mensal do Partner (R$)</Label>
                <Input
                  id="partner-target"
                  inputMode="decimal"
                  className="h-12 sm:h-10"
                  value={partnerTargetReais}
                  onChange={(e) => setPartnerTargetReais(e.target.value)}
                  placeholder="Ex.: 250,00"
                />
              </div>
              <div className="flex items-end">
                <Button
                  disabled={simulation.isPending || !partnerTargetReais.trim()}
                  onClick={() =>
                    simulation.mutate(
                      {
                        partner_monthly_target_cents: Math.round(
                          Number(partnerTargetReais.replace(/\./g, "").replace(",", ".")) * 100,
                        ),
                      },
                      { onError: (e: Error) => toast.error(e.message) },
                    )
                  }
                >
                  Simular
                </Button>
              </div>
            </div>

            {simulation.data && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm border-t pt-3">
                <p>
                  Custo conhecido hoje:{" "}
                  <strong>{formatCents(simulation.data.currentKnownCostCents)}</strong>
                </p>
                <p>
                  Instâncias sem custo informado:{" "}
                  <strong>{simulation.data.instancesWithUnknownCost}</strong>
                </p>
                <p>
                  {simulation.data.savingsCents >= 0 ? "Economia" : "Custo adicional"}:{" "}
                  <strong>{formatCents(Math.abs(simulation.data.savingsCents))}</strong>
                </p>
                <p>
                  Ponto de equilíbrio:{" "}
                  <strong>
                    {simulation.data.breakEvenInstances === null
                      ? "indisponível (sem custo conhecido)"
                      : `${simulation.data.breakEvenInstances} instâncias`}
                  </strong>
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      {/* ── Diálogo de ação, sempre com motivo obrigatório ───────────── */}
      <ResponsiveDialog open={!!dialog} onOpenChange={(o) => !o && closeDialog()}>
        <ResponsiveDialogContent>
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>
              {dialog?.kind === "confirm_date" && "Confirmar data do ciclo"}
              {dialog?.kind === "set_cost" && "Informar custo mensal"}
              {dialog?.kind === "cancel" && "Registrar cancelamento no fornecedor"}
              {dialog?.kind === "confirm_end" && "Confirmar encerramento"}
              {dialog?.kind === "reactivate" && "Reativar instância"}
              {dialog?.kind === "resolve_alert" && "Resolver alerta"}
            </ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              O motivo é obrigatório e será registrado permanentemente com autoria e data.
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>

          <ResponsiveDialogBody className="space-y-3">
            {dialog?.kind === "confirm_date" && (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label htmlFor="cycle-start">Início do ciclo atual</Label>
                    <Input
                      id="cycle-start"
                      type="date"
                      className="h-12 sm:h-10"
                      value={cycleStart}
                      onChange={(e) => setCycleStart(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="anchor-day">Dia-âncora da cobrança (1 a 31)</Label>
                    <Input
                      id="anchor-day"
                      inputMode="numeric"
                      className="h-12 sm:h-10"
                      value={anchorDay}
                      onChange={(e) => setAnchorDay(e.target.value)}
                    />
                  </div>
                </div>
                {anchorIsAmbiguous && (
                  <p className="text-sm text-warning">
                    Não é possível saber se houve ajuste de mês curto. Confirme o dia-âncora
                    original da cobrança — ele é preservado e nunca re-derivado.
                  </p>
                )}
              </>
            )}

            {dialog?.kind === "set_cost" && (
              <div className="space-y-1">
                <Label htmlFor="cost">Custo mensal (R$) — deixe vazio se desconhecido</Label>
                <Input
                  id="cost"
                  inputMode="decimal"
                  className="h-12 sm:h-10"
                  value={costReais}
                  onChange={(e) => setCostReais(e.target.value)}
                  placeholder="Ex.: 100,00"
                />
                <p className="text-xs text-muted-foreground">
                  Vazio grava <strong>desconhecido</strong>, nunca zero. E a mudança vale só para
                  ciclos futuros: o custo do ciclo corrente foi congelado na abertura.
                </p>
              </div>
            )}

            {dialog?.kind === "cancel" && (
              <div className="space-y-1">
                <Label htmlFor="access-until">Primeiro dia SEM acesso</Label>
                <Input
                  id="access-until"
                  type="date"
                  className="h-12 sm:h-10"
                  value={accessUntil}
                  onChange={(e) => setAccessUntil(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  {accessUntil
                    ? `O cliente mantém acesso até ${lastAccessDayLabel(accessUntil)}.`
                    : "A data informada é o primeiro dia NÃO coberto — o acesso vai até a véspera."}
                </p>
              </div>
            )}

            {dialog?.kind === "confirm_end" && (
              <p className="text-sm text-muted-foreground">
                Confirme apenas depois de verificar no painel do fornecedor que a instância
                realmente deixou de existir. O sistema não afirma encerramento que não observou.
              </p>
            )}

            {dialog?.kind === "reactivate" && (
              <p className="text-sm text-muted-foreground">
                Reverter o cancelamento exige <strong>evidência</strong> de que ele foi desfeito no
                fornecedor. Descreva o que você verificou no painel da Z-API — a data-limite de
                acesso registrada será apagada.
              </p>
            )}

            <div className="space-y-1">
              <Label htmlFor="reason">Motivo (fica registrado no histórico)</Label>
              <Textarea
                id="reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={closeDialog}>
                Cancelar
              </Button>
              <Button
                disabled={action.isPending || reasonTooShort}
                onClick={() => {
                  if (!dialog) return;
                  if (dialog.kind === "confirm_date") {
                    run(
                      {
                        action: "confirm_cycle_date",
                        instance_id: dialog.instance.id,
                        cycle_start: cycleStart,
                        provider_cycle_anchor_day: Number(anchorDay),
                        reason,
                      },
                      "Data do ciclo confirmada.",
                    );
                  } else if (dialog.kind === "set_cost") {
                    const trimmed = costReais.trim();
                    run(
                      {
                        action: "set_cost",
                        instance_id: dialog.instance.id,
                        current_monthly_cost_cents: trimmed
                          ? Math.round(Number(trimmed.replace(/\./g, "").replace(",", ".")) * 100)
                          : null,
                        reason,
                      },
                      "Custo atualizado.",
                    );
                  } else if (dialog.kind === "cancel") {
                    run(
                      {
                        action: "request_cancellation",
                        instance_id: dialog.instance.id,
                        provider_access_until: accessUntil,
                        reason,
                      },
                      "Cancelamento registrado.",
                    );
                  } else if (dialog.kind === "confirm_end") {
                    run(
                      { action: "confirm_end", instance_id: dialog.instance.id, reason },
                      "Encerramento confirmado.",
                    );
                  } else if (dialog.kind === "reactivate") {
                    run(
                      { action: "reactivate", instance_id: dialog.instance.id, reason },
                      "Cancelamento revertido.",
                    );
                  } else if (dialog.kind === "resolve_alert") {
                    run(
                      { action: "resolve_alert", alert_id: dialog.alert.id, reason },
                      "Alerta resolvido.",
                    );
                  }
                }}
              >
                Confirmar
              </Button>
            </div>
          </ResponsiveDialogBody>
        </ResponsiveDialogContent>
      </ResponsiveDialog>

      <RegisterInstanceDialog
        open={registerOpen}
        onOpenChange={setRegisterOpen}
        prefill={registerPrefill}
        onRegistered={(instance) => {
          // ENCADEAMENTO: a instância nasce em `cycle_source: "UNKNOWN"`, o que
          // faz o worker abrir DATE_REVIEW_REQUIRED na execução seguinte. Em vez
          // de esperar um dia, o fluxo emenda direto na confirmação da data —
          // foi assim que a instância do Ren Sushi foi operada, em dois passos
          // manuais.
          setRegisterPrefill(null);
          setDialog({ kind: "confirm_date", instance });
        }}
      />

      <UpdateInstanceDialog
        open={!!updateTarget}
        onOpenChange={(o) => !o && setUpdateTarget(null)}
        instance={updateTarget}
      />
    </div>
  );
}
