import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogBody,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
} from "@/components/ui/responsive-dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { ExternalLink } from "lucide-react";
import { formatDateBR } from "@/lib/utils";
import {
  formatCentsBRL,
  IMPLEMENTATION_ORIGIN_LABEL,
  IMPLEMENTATION_PAYMENT_LABEL,
  IMPLEMENTATION_OPERATIONAL_LABEL,
  type ImplementationOrigin,
  type ImplementationPaymentStatus,
  type ImplementationOperationalStatus,
} from "@/types/billing";
import {
  useImplementations,
  useSetOperationalStatus,
  useCancelImplementation,
  useRegisterExternalPayment,
  useCreateImplementation,
} from "@/hooks/useWhatsappImplementation";
import { useOrganizationsBilling, useBillingPlans } from "@/hooks/useBilling";
import { useAuth } from "@/contexts/AuthContext";
import { parseAmountReaisToCents } from "@/lib/billing-amount";
/**
 * Núcleo puro do backend (ZERO imports — Deno E vitest a partir de src/ já o
 * consomem, ver src/lib/whatsapp-implementation-core.test.ts:9). A máquina de
 * estados da implantação mora AQUI, não numa cópia no frontend — reimplementar
 * o grafo de transições (ou o gate de "pagamento resolvido pra concluir") é
 * defeito mesmo quando o resultado bate, porque as duas cópias divergem no
 * dia em que só uma for atualizada. Import relativo (fora de `src/`) é o
 * mesmo padrão já validado pelo teste acima; `tsc -b` resolve por follow de
 * import, não pelo glob `include` do tsconfig.
 */
import {
  OPERATIONAL_TRANSITIONS,
  canTransitionOperational,
} from "../../../supabase/functions/_shared/whatsapp-implementation-core";

const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: "all", label: "Todas" },
  { value: "NOT_STARTED", label: "Não iniciadas" },
  { value: "SCHEDULED", label: "Agendadas" },
  { value: "IN_PROGRESS", label: "Em andamento" },
  { value: "WAITING_CUSTOMER", label: "Aguardando cliente" },
  { value: "COMPLETED", label: "Concluídas" },
  { value: "CANCELED", label: "Canceladas" },
];

/** Linha administrativa completa — projeção de ADMIN_COLUMNS na Edge Function
 *  (manage-whatsapp-implementations, action "list"/"get"). Tipo local: a
 *  página é a única consumidora, e o hook (Task 15) devolve Record<string,
 *  unknown> de propósito (não força shape aqui). */
interface AdminImplementationRow {
  id: string;
  organization_id: string;
  origin: ImplementationOrigin;
  payment_status: ImplementationPaymentStatus;
  operational_status: ImplementationOperationalStatus;
  amount_cents: number | null;
  payment_method: string | null;
  external_payment_reference: string | null;
  reason: string | null;
  notes: string | null;
  owner_admin_id: string | null;
  scheduled_for: string | null;
  paid_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  canceled_at: string | null;
  cancel_reason: string | null;
  created_at: string;
  updated_at: string;
  organizations: { name: string; slug: string } | { name: string; slug: string }[] | null;
}

function orgOf(row: AdminImplementationRow) {
  return Array.isArray(row.organizations) ? row.organizations[0] : row.organizations;
}

/**
 * Destinos válidos a partir da etapa atual, direto de OPERATIONAL_TRANSITIONS
 * (núcleo puro) — SEM o destino CANCELED (ação própria — set_operational_status
 * recusa CANCELED com 400 mandando usar `cancel`). `?? []` cobre um status
 * fora do grafo (não deveria acontecer, mas não estoura o `.map` do Select).
 */
function nextDestinations(
  status: ImplementationOperationalStatus,
): ImplementationOperationalStatus[] {
  return (OPERATIONAL_TRANSITIONS[status] ?? []).filter((d) => d !== "CANCELED");
}

/** Origens que a action `create` aceita — ASAAS é recusada (tem ação própria,
 *  create_asaas_charge, fora do escopo deste painel) e EXTERNAL_PAYMENT tem
 *  campos próprios (valor/forma/data), por isso vira o modo "Pagamento
 *  externo" do mesmo formulário em vez de aparecer aqui separado do resto. */
const CREATE_ORIGINS: ImplementationOrigin[] = ["EXTERNAL_PAYMENT", "COURTESY", "ADMIN_OVERRIDE"];

const PAYMENT_BADGE_CLASS: Record<ImplementationPaymentStatus, string> = {
  PENDING: "bg-warning/10 text-warning",
  CONFIRMED: "bg-success/10 text-success",
  WAIVED: "bg-info/10 text-info",
  REFUNDED: "bg-muted text-muted-foreground",
  CHARGEBACK: "bg-destructive/10 text-destructive",
  CANCELED: "bg-muted text-muted-foreground",
};

const OPERATIONAL_BADGE_CLASS: Record<ImplementationOperationalStatus, string> = {
  NOT_STARTED: "bg-muted text-muted-foreground",
  SCHEDULED: "bg-info/10 text-info",
  IN_PROGRESS: "bg-warning/10 text-warning",
  WAITING_CUSTOMER: "bg-warning/10 text-warning",
  COMPLETED: "bg-success/10 text-success",
  CANCELED: "bg-destructive/10 text-destructive",
};

export default function WhatsappImplementations() {
  const [status, setStatus] = useState("all");
  const [selected, setSelected] = useState<AdminImplementationRow | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const { data, isLoading, isError, refetch } = useImplementations(
    status === "all" ? {} : { status },
  );
  // M-4 (Rodada de correção 1): o valor da configuração assistida vem do
  // catálogo (`billing_plans`, slug "implementacao-whatsapp") — hardcoded na
  // copy, a frase mentiria no dia em que o preço mudasse no painel de planos.
  const { data: plans } = useBillingPlans();
  const implPlan = (plans ?? []).find((p) => p.slug === "implementacao-whatsapp");

  const rows = (data?.implementations ?? []) as unknown as AdminImplementationRow[];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Implantações de WhatsApp</h1>
          <p className="text-sm text-muted-foreground max-w-2xl">
            Registra COMO a configuração assistida{implPlan ? ` (${formatCentsBRL(implPlan.amount_cents)})` : ""} foi
            paga — venda pelo Asaas, pagamento externo ou cortesia. Isto NÃO libera nem
            bloqueia o acesso ao WhatsApp: quem faz isso é a assinatura da instância ou uma
            cortesia de acesso, geridas no detalhe da organização.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
            <SelectContent>
              {STATUS_FILTERS.map((f) => (
                <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={() => setCreateOpen(true)}>Nova implantação</Button>
        </div>
      </div>

      {isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : isError ? (
        <Card className="border-warning/20 bg-warning/10">
          <CardContent className="py-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-warning">Falha ao carregar as implantações.</p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              Tentar novamente
            </Button>
          </CardContent>
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            Nenhuma implantação neste filtro.
          </CardContent>
        </Card>
      ) : (
        <Card>
          {/* Container próprio de rolagem: o body da página nunca rola na horizontal. */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="p-3">Empresa</th>
                  <th className="p-3">Origem</th>
                  <th className="p-3">Financeiro</th>
                  <th className="p-3">Operacional</th>
                  <th className="p-3">Valor</th>
                  <th className="p-3">Criada em</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const org = orgOf(row);
                  return (
                    <tr
                      key={row.id}
                      className="border-t cursor-pointer hover:bg-muted/50"
                      onClick={() => setSelected(row)}
                    >
                      <td className="p-3 font-medium">
                        {org?.name ?? "—"}
                        {org?.slug && <p className="text-xs font-normal text-muted-foreground">{org.slug}</p>}
                      </td>
                      <td className="p-3">{IMPLEMENTATION_ORIGIN_LABEL[row.origin]}</td>
                      <td className="p-3">
                        <Badge variant="secondary" className={PAYMENT_BADGE_CLASS[row.payment_status]}>
                          {IMPLEMENTATION_PAYMENT_LABEL[row.payment_status]}
                        </Badge>
                      </td>
                      <td className="p-3">
                        <Badge variant="secondary" className={OPERATIONAL_BADGE_CLASS[row.operational_status]}>
                          {IMPLEMENTATION_OPERATIONAL_LABEL[row.operational_status]}
                        </Badge>
                      </td>
                      <td className="p-3">
                        {row.amount_cents == null ? "—" : formatCentsBRL(row.amount_cents)}
                      </td>
                      <td className="p-3">{formatDateBR(row.created_at.slice(0, 10))}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <ResponsiveDialog open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <ResponsiveDialogContent>
          {selected && (
            <ImplementationDetail row={selected} onClose={() => setSelected(null)} />
          )}
        </ResponsiveDialogContent>
      </ResponsiveDialog>

      <NovaImplantacaoDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

// ── Detalhe + ações de uma implantação existente ────────────────────────────

function InfoField({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <p className="text-muted-foreground">{label}</p>
      <p className="font-medium">{value}</p>
    </div>
  );
}

function ImplementationDetail({
  row,
  onClose,
}: {
  row: AdminImplementationRow;
  onClose: () => void;
}) {
  const org = orgOf(row);
  const setStatus = useSetOperationalStatus();
  const cancelMutation = useCancelImplementation();

  const [destino, setDestino] = useState<ImplementationOperationalStatus | "">("");
  const [scheduledFor, setScheduledFor] = useState("");
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");

  const destinations = nextDestinations(row.operational_status);
  const isTerminal = row.operational_status === "COMPLETED" || row.operational_status === "CANCELED";
  const advanceVerdict = destino ? canTransitionOperational(row.operational_status, destino, row.payment_status) : null;
  const completionBlocked = !!advanceVerdict && !advanceVerdict.ok && advanceVerdict.reason === "payment_not_settled";
  const asaasPendingWindow = row.origin === "ASAAS" && row.payment_status === "PENDING";

  /**
   * I-2 (Rodada de correção 1): o índice único parcial é por ORGANIZAÇÃO
   * (`whatsapp_impl_one_open_per_org_idx`, migration 071), não por linha. A
   * linha selecionada estar CANCELED não basta — a lista da página pode estar
   * filtrada por status e esconder uma OUTRA implantação da mesma org que
   * segue aberta. Consulta própria, sem filtro de status, só pra esta org —
   * nunca reaproveita `rows` da tela-mãe.
   */
  const orgImplementations = useImplementations({ organization_id: row.organization_id });
  const orgRows = (orgImplementations.data?.implementations ?? []) as unknown as AdminImplementationRow[];
  const canRegisterNew =
    !orgImplementations.isLoading &&
    !orgImplementations.isError &&
    orgRows.length > 0 &&
    orgRows.every((r) => r.operational_status === "CANCELED");

  function handleAdvance() {
    if (!destino) return;
    setStatus.mutate(
      {
        id: row.id,
        operational_status: destino,
        scheduled_for: destino === "SCHEDULED" && scheduledFor ? scheduledFor : undefined,
      },
      {
        onSuccess: () => { toast.success("Etapa atualizada."); onClose(); },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  function handleCancel() {
    if (!cancelReason.trim()) return;
    cancelMutation.mutate(
      { id: row.id, cancel_reason: cancelReason.trim() },
      {
        onSuccess: () => { toast.success("Implantação cancelada."); setCancelOpen(false); onClose(); },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  return (
    <>
      <ResponsiveDialogHeader>
        <ResponsiveDialogTitle>{org?.name ?? "Implantação"}</ResponsiveDialogTitle>
        <ResponsiveDialogDescription>
          <Link
            to={`/platform/billing/${row.organization_id}`}
            className="inline-flex items-center gap-1 hover:underline"
          >
            Ver organização <ExternalLink className="h-3 w-3" />
          </Link>
        </ResponsiveDialogDescription>
      </ResponsiveDialogHeader>

      <ResponsiveDialogBody className="space-y-6">
        {/* Origem COMERCIAL — como isto foi pago. Nunca decide acesso. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          <InfoField label="Origem" value={IMPLEMENTATION_ORIGIN_LABEL[row.origin]} />
          <InfoField
            label="Valor"
            value={row.amount_cents == null ? "—" : formatCentsBRL(row.amount_cents)}
          />
          <InfoField
            label="Financeiro"
            value={
              <Badge variant="secondary" className={PAYMENT_BADGE_CLASS[row.payment_status]}>
                {IMPLEMENTATION_PAYMENT_LABEL[row.payment_status]}
              </Badge>
            }
          />
          <InfoField
            label="Operacional"
            value={
              <Badge variant="secondary" className={OPERATIONAL_BADGE_CLASS[row.operational_status]}>
                {IMPLEMENTATION_OPERATIONAL_LABEL[row.operational_status]}
              </Badge>
            }
          />
          <InfoField label="Responsável" value={row.owner_admin_id ?? "—"} />
          <InfoField label="Criada em" value={formatDateBR(row.created_at.slice(0, 10))} />
          {row.paid_at && <InfoField label="Pago em" value={formatDateBR(row.paid_at.slice(0, 10))} />}
          {row.scheduled_for && <InfoField label="Agendada para" value={formatDateBR(row.scheduled_for)} />}
          {row.started_at && <InfoField label="Iniciada em" value={formatDateBR(row.started_at.slice(0, 10))} />}
          {row.completed_at && <InfoField label="Concluída em" value={formatDateBR(row.completed_at.slice(0, 10))} />}
          {row.canceled_at && <InfoField label="Cancelada em" value={formatDateBR(row.canceled_at.slice(0, 10))} />}
        </div>
        {row.reason && <p className="text-sm text-muted-foreground">Motivo: {row.reason}</p>}
        {row.notes && <p className="text-sm text-muted-foreground">Observação: {row.notes}</p>}
        {row.cancel_reason && (
          <p className="text-sm text-destructive">Motivo do cancelamento: {row.cancel_reason}</p>
        )}

        {!isTerminal && (
          <div className="space-y-2 border-t pt-4">
            <p className="text-sm font-medium">Avançar etapa</p>
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex-1 min-w-[180px]">
                <Select
                  value={destino}
                  onValueChange={(v) => setDestino(v as ImplementationOperationalStatus)}
                >
                  <SelectTrigger className="h-12 sm:h-10">
                    <SelectValue placeholder="Selecione o destino" />
                  </SelectTrigger>
                  <SelectContent>
                    {destinations.map((d) => (
                      <SelectItem key={d} value={d}>{IMPLEMENTATION_OPERATIONAL_LABEL[d]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {destino === "SCHEDULED" && (
                <Input
                  type="date"
                  className="h-12 sm:h-10 w-40"
                  value={scheduledFor}
                  onChange={(e) => setScheduledFor(e.target.value)}
                />
              )}
              <Button onClick={handleAdvance} disabled={!destino || setStatus.isPending || completionBlocked}>
                {setStatus.isPending ? "Salvando..." : destino === "COMPLETED" ? "Concluir" : "Aplicar"}
              </Button>
            </div>
            {completionBlocked && (
              <p className="text-xs text-muted-foreground">
                Conclua depois que o pagamento for confirmado (ou registrado como cortesia).
              </p>
            )}
          </div>
        )}

        {!isTerminal && (
          <div className="space-y-2 border-t pt-4">
            <p className="text-sm font-medium text-destructive">Cancelar implantação</p>
            {asaasPendingWindow && (
              <p className="text-xs text-muted-foreground">
                Cobrança Asaas ainda pendente — o servidor recusa o cancelamento por até 30
                minutos após a criação, enquanto o cliente pode pagar.
              </p>
            )}
            <Button variant="destructive" size="sm" onClick={() => setCancelOpen(true)}>
              Cancelar implantação
            </Button>
          </div>
        )}

        {row.operational_status === "CANCELED" && (
          <div className="space-y-3 border-t pt-4">
            <p className="text-sm font-medium">Esta implantação foi cancelada</p>
            {orgImplementations.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : orgImplementations.isError ? (
              <div className="space-y-2">
                <p className="text-xs text-destructive">Falha ao checar as demais implantações desta empresa.</p>
                <Button variant="outline" size="sm" onClick={() => orgImplementations.refetch()}>
                  Tentar novamente
                </Button>
              </div>
            ) : canRegisterNew ? (
              <>
                <p className="text-xs text-muted-foreground">
                  O registro abaixo cria uma NOVA implantação para {org?.name ?? "esta empresa"} —
                  a linha cancelada é histórico e não é reaberta.
                </p>
                <CreateImplementationForm organizationId={row.organization_id} onSuccess={onClose} />
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                Esta empresa já tem outra implantação não cancelada — localize-a na lista pra
                agir sobre ela antes de registrar uma nova aqui.
              </p>
            )}
          </div>
        )}
      </ResponsiveDialogBody>

      <AlertDialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancelar esta implantação?</AlertDialogTitle>
            <AlertDialogDescription>
              O histórico é preservado — cancelar só tira esta linha da fila operacional e
              libera a organização para uma nova implantação.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            placeholder="Motivo do cancelamento (obrigatório)"
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
          />
          <AlertDialogFooter>
            <AlertDialogCancel>Voltar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={cancelMutation.isPending || !cancelReason.trim()}
              onClick={handleCancel}
            >
              {cancelMutation.isPending ? "Cancelando..." : "Cancelar implantação"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ── Registro manual (pagamento externo OU cortesia/override) ───────────────

/**
 * Compartilhado por dois pontos de entrada: o botão "Nova implantação" do
 * topo da lista (organização escolhida pelo admin) e a seção que aparece
 * quando a implantação selecionada já está CANCELED (organização fixa). Os
 * dois só fazem sentido quando a organização NÃO tem implantação não-cancelada
 * — índice único parcial no banco barra a segunda com 409, e é exatamente por
 * isso que este formulário só aparece nesses dois lugares, nunca ao lado de
 * uma implantação em andamento.
 */
function CreateImplementationForm({
  organizationId,
  onSuccess,
}: {
  organizationId: string;
  onSuccess: () => void;
}) {
  const { user } = useAuth();
  const registerPayment = useRegisterExternalPayment();
  const createImplementation = useCreateImplementation();

  const [origin, setOrigin] = useState<ImplementationOrigin>("EXTERNAL_PAYMENT");
  const [amount, setAmount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("");
  const [paidAt, setPaidAt] = useState("");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [ownerAdminId, setOwnerAdminId] = useState(user?.id ?? "");
  const [reason, setReason] = useState("");

  const isPending = registerPayment.isPending || createImplementation.isPending;
  const amountCents = parseAmountReaisToCents(amount);
  const externalValid = Number.isFinite(amountCents) && amountCents > 0 && paymentMethod.trim().length > 0;
  const courtesyValid = reason.trim().length > 0;

  function handleSubmit() {
    if (origin === "EXTERNAL_PAYMENT") {
      if (!externalValid) {
        toast.error(
          !Number.isFinite(amountCents) || amountCents <= 0
            ? "Informe um valor recebido válido."
            : "Informe a forma de pagamento.",
        );
        return;
      }
      registerPayment.mutate(
        {
          organization_id: organizationId,
          amount_cents: amountCents,
          payment_method: paymentMethod.trim(),
          external_payment_reference: reference.trim() || undefined,
          notes: notes.trim() || undefined,
          owner_admin_id: ownerAdminId.trim() || undefined,
          paid_at: paidAt ? new Date(`${paidAt}T12:00:00`).toISOString() : undefined,
        },
        {
          onSuccess: () => { toast.success("Pagamento externo registrado."); onSuccess(); },
          onError: (err) => toast.error(err.message),
        },
      );
      return;
    }
    if (!courtesyValid) {
      toast.error("Informe o motivo.");
      return;
    }
    createImplementation.mutate(
      {
        organization_id: organizationId,
        origin,
        reason: reason.trim(),
        notes: notes.trim() || undefined,
        owner_admin_id: ownerAdminId.trim() || undefined,
      },
      {
        onSuccess: () => { toast.success("Implantação registrada."); onSuccess(); },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  return (
    <div className="space-y-3">
      <div>
        <Label>Tipo de registro</Label>
        <Select value={origin} onValueChange={(v) => setOrigin(v as ImplementationOrigin)}>
          <SelectTrigger className="h-12 sm:h-10"><SelectValue /></SelectTrigger>
          <SelectContent>
            {CREATE_ORIGINS.map((o) => (
              <SelectItem key={o} value={o}>{IMPLEMENTATION_ORIGIN_LABEL[o]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {origin === "EXTERNAL_PAYMENT" ? (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label>Valor recebido (R$)</Label>
              <Input
                inputMode="decimal"
                placeholder="750,00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="h-12 sm:h-10"
              />
              {/* Rodada de correção 2: eco do valor INTERPRETADO, não do texto
                  digitado — é a defesa que sobrevive a uma entrada que a
                  heurística de separador não previu. O admin confirma o
                  número antes do clique, em vez de confiar cego no parse. */}
              {amount.trim() && (
                <p
                  className={
                    Number.isFinite(amountCents) && amountCents > 0
                      ? "text-xs text-muted-foreground mt-1"
                      : "text-xs text-destructive mt-1"
                  }
                >
                  {Number.isFinite(amountCents) && amountCents > 0
                    ? `Será registrado: ${formatCentsBRL(amountCents)}`
                    : "Valor não reconhecido — confira o formato (ex.: 750,00 ou 1.750,00)."}
                </p>
              )}
            </div>
            <div>
              <Label>Forma de pagamento</Label>
              <Input
                placeholder="pix, transferência, dinheiro..."
                value={paymentMethod}
                onChange={(e) => setPaymentMethod(e.target.value)}
                className="h-12 sm:h-10"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label>Data do pagamento (opcional)</Label>
              <Input
                type="date"
                value={paidAt}
                onChange={(e) => setPaidAt(e.target.value)}
                className="h-12 sm:h-10"
              />
            </div>
            <div>
              <Label>Referência (opcional)</Label>
              <Input
                placeholder="Nº do comprovante"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                className="h-12 sm:h-10"
              />
            </div>
          </div>
        </>
      ) : (
        <div>
          <Label>Motivo (obrigatório)</Label>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Por que esta implantação não é cobrada"
          />
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <Label>Observação (opcional)</Label>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        <div>
          <Label>Responsável (UUID do admin, opcional)</Label>
          <Input
            value={ownerAdminId}
            onChange={(e) => setOwnerAdminId(e.target.value)}
            className="h-12 sm:h-10"
          />
        </div>
      </div>

      <Button
        onClick={handleSubmit}
        disabled={isPending || (origin === "EXTERNAL_PAYMENT" ? !externalValid : !courtesyValid)}
      >
        {isPending ? "Salvando..." : "Registrar"}
      </Button>
    </div>
  );
}

function NovaImplantacaoDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data, isLoading, isError, refetch } = useOrganizationsBilling({ page_size: 100 });
  // I-3 (Rodada de correção 1): sem cruzar com quem já tem implantação aberta,
  // o Select oferece qualquer empresa e o 409 garantido só aparece depois do
  // submit. Consulta própria, sem filtro de status — precisa ver TODAS as
  // linhas pra saber quem está bloqueado, independente do filtro da tela-mãe.
  const implsQuery = useImplementations({});
  const [organizationId, setOrganizationId] = useState("");
  const orgs = data?.organizations ?? [];

  const blockedOrgIds = new Set(
    ((implsQuery.data?.implementations ?? []) as unknown as AdminImplementationRow[])
      .filter((r) => r.operational_status !== "CANCELED")
      .map((r) => r.organization_id),
  );

  // M-3 (Rodada de correção 1): fechar sem passar por aqui deixava
  // `organizationId` intacto — reabrir o diálogo (ou o sucesso do form, que
  // chamava `onOpenChange(false)` direto, pulando este reset) reaproveitava a
  // mesma organização e convidava a um re-submit que 409a contra a linha que
  // acabou de ser criada.
  function handleClose() {
    onOpenChange(false);
    setOrganizationId("");
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={(o) => { if (!o) handleClose(); else onOpenChange(o); }}>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Nova implantação</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Registro manual — pagamento recebido fora do Asaas, ou cortesia/override.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody className="space-y-4">
          <div>
            <Label>Empresa</Label>
            <Select
              value={organizationId}
              onValueChange={setOrganizationId}
              disabled={isLoading || orgs.length === 0}
            >
              <SelectTrigger className="h-12 sm:h-10">
                <SelectValue placeholder={isLoading ? "Carregando empresas..." : "Selecione a empresa"} />
              </SelectTrigger>
              <SelectContent>
                {orgs.map((o) => (
                  <SelectItem key={o.id} value={o.id} disabled={blockedOrgIds.has(o.id)}>
                    {o.name}{blockedOrgIds.has(o.id) ? " — já tem implantação aberta" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {isError && (
              <div className="flex items-center gap-2 mt-1">
                <p className="text-xs text-destructive">Falha ao carregar as empresas.</p>
                <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={() => refetch()}>
                  Tentar novamente
                </Button>
              </div>
            )}
            {!isLoading && !isError && orgs.length === 0 && (
              <p className="text-xs text-muted-foreground mt-1">Nenhuma organização encontrada.</p>
            )}
            {implsQuery.isError && (
              <p className="text-xs text-warning mt-1">
                Não foi possível checar quem já tem implantação — confira antes de escolher.
              </p>
            )}
          </div>
          {organizationId && (
            <CreateImplementationForm
              key={organizationId}
              organizationId={organizationId}
              onSuccess={handleClose}
            />
          )}
        </ResponsiveDialogBody>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
