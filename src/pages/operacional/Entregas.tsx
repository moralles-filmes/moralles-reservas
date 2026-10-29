import { useMemo, useState } from "react";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import {
  useUndeliveredNotifications,
  useAutomationDeliveryState,
  useResendNotification,
  isResendableKind,
  type UndeliveredNotification,
} from "@/hooks/useUndeliveredNotifications";
import {
  deriveDeliveryState,
  deliveryTooltip,
} from "@/hooks/useNotificationDeliveries";
import { DeliveryBadge } from "@/components/notifications/DeliveryBadge";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/PageHeader";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateBR, formatPhone } from "@/lib/utils";
import { AlertCircle, MailWarning, Phone, Send } from "lucide-react";

const KIND_LABEL: Record<string, string> = {
  waitlist_entered: "Entrada na fila",
  waitlist_table_ready: "Aviso de mesa pronta",
  confirmation: "Confirmação de reserva",
  cancellation: "Cancelamento de reserva",
  reminder_d1: "Lembrete de reserva",
  survey_d1: "Pesquisa de satisfação",
  voucher_issued: "Voucher / giftback",
  waitlist_feedback: "Pesquisa da fila",
};

const FILA_KINDS = new Set(["waitlist_entered", "waitlist_table_ready"]);

type Category = "todas" | "fila" | "reservas";

const AUTOMATION_LABEL: Record<string, string> = {
  queued: "Aguardando envio", claimed: "Em preparação", posting: "Enviando", accepted: "Envio aceito; atualizando registros",
  blocked: "Aguardando configuração ou condição", expired: "Prazo encerrado", uncertain: "Aguardando confirmação do envio",
  retry_wait: "Aguardando nova tentativa segura", needs_review: "Precisa de revisão da configuração", failed: "Precisa de verificação",
  reconciled: "Registros atualizados", paused: "Envio pausado", rejected: "Envio recusado",
};
function AutomationDeliveryPanel({ unitId }: { unitId: string }) {
  const [page, setPage] = useState(0);
  const query = useAutomationDeliveryState(unitId, page);
  const data = query.data;
  const minutes = data?.oldest_nonterminal_at
    ? Math.max(0, Math.floor((Date.parse(data.generated_at) - Date.parse(data.oldest_nonterminal_at)) / 60_000)) : null;
  return <section aria-label="Automações de WhatsApp" className="space-y-3">
    <h2 className="text-lg font-semibold">Automações de WhatsApp</h2>
    <p className="text-xs text-muted-foreground">Acompanhamento dos envios programados e da atualização dos registros.</p>
    {query.isLoading ? <Skeleton className="h-20 w-full rounded-block" /> : query.isError ? <div className="surface rounded-card border-destructive/40 py-8 flex flex-col items-center gap-3 text-center">
      <p>Não foi possível carregar as automações.</p><Button variant="outline" onClick={() => query.refetch()}>Tentar novamente</Button>
    </div> : data && <>
      <p className="text-sm">{data.counts.outstanding} pendentes de processamento de {data.counts.total} registros.
        {minutes !== null && <span className="text-muted-foreground"> Mais antiga: {minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h`} (observação local).</span>}</p>
      {!data.rows.length ? <p className="text-sm text-muted-foreground">Nenhuma automação nesta página.</p> : data.rows.map(row => <div key={row.job_id} className="surface rounded-block p-4 space-y-1">
        <div className="flex flex-wrap gap-2 items-center"><span className="font-medium text-sm">{KIND_LABEL[row.kind]}</span>
          <span className="rounded-full border px-2 py-0.5 text-xs font-medium bg-muted text-muted-foreground border-border">{AUTOMATION_LABEL[row.state]}</span></div>
        {row.pin_phase === "preconfiguration" && <p className="text-xs text-muted-foreground">Configuração inicial pendente.</p>}
        {row.has_pending_receipt && <p className="text-xs text-muted-foreground">Confirmação recebida; atualizando o registro de entrega.</p>}
        {row.reason === "unknown_reason" && <p className="text-xs text-muted-foreground">Este registro precisa de verificação.</p>}
        <p className="text-xs text-muted-foreground">Criada em <span className="tabular">{new Date(row.created_at).toLocaleString("pt-BR")}</span> · Prazo <span className="tabular">{new Date(row.expires_at).toLocaleString("pt-BR")}</span></p>
      </div>)}
      <div className="flex items-center gap-3"><Button variant="outline" disabled={page === 0} onClick={() => setPage(p => p - 1)}>Anterior</Button>
        <span className="text-sm">Página {page + 1}</span><Button variant="outline" disabled={!data.has_more} onClick={() => setPage(p => p + 1)}>Próxima</Button></div>
    </>}
  </section>;
}

function rowCategory(kind: string): Exclude<Category, "todas"> {
  return FILA_KINDS.has(kind) ? "fila" : "reservas";
}

// Rótulo de contexto: "Fila #12" / "Reserva 13/06 #A1B2" / "Voucher".
function contextLabel(row: UndeliveredNotification): string {
  if (FILA_KINDS.has(row.kind)) {
    return row.ref_code ? `Fila #${row.ref_code}` : "Fila de espera";
  }
  if (row.ref_date) {
    const code = row.ref_code ? ` #${row.ref_code}` : "";
    return `Reserva ${formatDateBR(row.ref_date, { day: "2-digit", month: "2-digit" })}${code}`;
  }
  return row.ref_code ? `#${row.ref_code}` : "—";
}

export default function Entregas() {
  const unit = useCurrentUnit();
  const unitId = unit?.unit_id ?? "";

  const [filter, setFilter] = useState<Category>("todas");

  const { data: rows, isLoading, isError, refetch } = useUndeliveredNotifications(unitId);
  const resend = useResendNotification(unitId);

  const filtered = useMemo(() => {
    if (!rows) return [];
    if (filter === "todas") return rows;
    return rows.filter((r) => rowCategory(r.kind) === filter);
  }, [rows, filter]);

  const isRowResending = (row: UndeliveredNotification) =>
    resend.isPending &&
    (FILA_KINDS.has(row.kind)
      ? resend.variables?.waitlist_id === row.waitlist_id
      : resend.variables?.reservation_id === row.reservation_id);

  const handleResend = (row: UndeliveredNotification) => {
    resend.mutate({
      kind: row.kind,
      waitlist_id: row.waitlist_id,
      reservation_id: row.reservation_id,
    });
  };

  const FILTERS: Array<{ key: Category; label: string }> = [
    { key: "todas", label: "Todas" },
    { key: "fila", label: "Fila" },
    { key: "reservas", label: "Reservas" },
  ];

  return (
    <div className="space-y-5">
      <PageHeader title="Mensagens não entregues">
        {rows && rows.length > 0 && <span className="rounded-full border px-2 py-0.5 text-xs font-medium tabular bg-warning/10 text-warning border-warning/20">{rows.length}</span>}
        <div className="flex gap-1">
          {FILTERS.map((f) => (
            <Button
              key={f.key}
              size="sm"
              variant={filter === f.key ? "default" : "outline"}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </Button>
          ))}
        </div>
      </PageHeader>

      <p className="text-xs text-muted-foreground -mt-2">
        Mensagens que o WhatsApp não confirmou entrega (ou falharam) nos últimos 7 dias.
      </p>

      {isLoading ? (
        <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-20 w-full rounded-block" />)}</div>
      ) : isError ? (
        <div className="surface rounded-card border-destructive/40 py-8 flex flex-col items-center gap-3 text-center">
            <AlertCircle className="h-8 w-8 text-destructive" />
            <p className="text-sm font-medium">Erro ao carregar as entregas.</p>
            <p className="text-xs text-muted-foreground">Verifique sua conexão e tente novamente.</p>
            <Button size="sm" variant="outline" onClick={() => refetch()}>
              Tentar de novo
            </Button>
        </div>
      ) : !filtered.length ? (
        <div className="surface rounded-card py-12 text-center text-muted-foreground text-sm">
            <MailWarning className="h-8 w-8 mx-auto mb-2 opacity-30" />
            {rows && rows.length > 0
              ? "Nenhuma mensagem neste filtro."
              : "Tudo certo — nenhuma mensagem pendente de entrega. 🎉"}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((row) => {
            const state = deriveDeliveryState(row, !!row.customer_phone);
            const resendable = isResendableKind(row.kind) && (row.kind === "waitlist_table_ready" || !row.provider_message_id)
              && !row.delivered_at && !row.read_at;
            return (
              <div key={row.id} className="surface rounded-block p-4 flex items-start gap-4 flex-wrap">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <p className="font-medium text-sm">{row.customer_name || "Cliente sem nome"}</p>
                      <DeliveryBadge state={state} title={deliveryTooltip(row)} />
                      <Badge variant="outline" className="text-[11px] bg-muted text-foreground border-border">
                        {contextLabel(row)}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                      <span>{KIND_LABEL[row.kind] ?? row.kind}</span>
                      {row.customer_phone && (
                        <span className="flex items-center gap-1">
                          <Phone className="h-3 w-3" />
                          {formatPhone(row.customer_phone)}
                        </span>
                      )}
                      {row.sent_at && (
                        <span>
                          enviada{" "}
                          <span className="tabular">{new Date(row.sent_at).toLocaleString("pt-BR", {
                            day: "2-digit",
                            month: "2-digit",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}</span>
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {resendable && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-1"
                        onClick={() => handleResend(row)}
                        disabled={!row.customer_phone || isRowResending(row)}
                        title={
                          row.customer_phone
                            ? "Reenviar esta mensagem"
                            : "Cliente sem WhatsApp — edite o número primeiro"
                        }
                      >
                        <Send className="h-3 w-3" />
                        Reenviar
                      </Button>
                    )}
                  </div>
              </div>
            );
          })}
        </div>
      )}
      <AutomationDeliveryPanel key={unitId} unitId={unitId} />
    </div>
  );
}
