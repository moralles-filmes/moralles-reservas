import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import {
  useOrgBillingDetail,
  useBillingPlans,
  useCreateBillingCustomer,
  useCreateSubscription,
  useCancelSubscription,
  useCreateManualInvoice,
  useBlockOrganization,
  useUnblockOrganization,
  useCreateOverride,
  useDeactivateOverride,
  useExtendTrial,
  useSyncFromStripe,
} from "@/hooks/useBilling";
import { usePaymentMethods, useDeletePaymentMethod } from "@/hooks/usePaymentMethods";
import {
  useImplementations,
  useWhatsappServiceStatus,
  useWhatsappOverrides,
  useGrantWhatsappOverride,
  useRevokeWhatsappOverride,
} from "@/hooks/useWhatsappImplementation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { ArrowLeft, RefreshCw, Copy, ExternalLink, Plus, Lock, Unlock, Clock, CreditCard, Trash2, Wrench, MessageSquare } from "lucide-react";
import {
  BILLING_STATUS_LABEL,
  BILLING_STATUS_VARIANT,
  INVOICE_STATUS_LABEL,
  PAYMENT_METHOD_LABEL,
  formatCentsBRL,
  IMPLEMENTATION_ORIGIN_LABEL,
  IMPLEMENTATION_PAYMENT_LABEL,
  IMPLEMENTATION_OPERATIONAL_LABEL,
  ENTITLEMENT_GRANT_TYPE_LABEL,
  type BillingStatus,
  type BillingInvoice,
  type BillingAccessOverride,
  type BillingNotification,
  type ImplementationOrigin,
  type ImplementationPaymentStatus,
  type ImplementationOperationalStatus,
  type EntitlementGrantType,
} from "@/types/billing";
import { formatDateBR } from "@/lib/utils";

export default function BillingDetail() {
  const { organizationId } = useParams<{ organizationId: string }>();
  const { data, isLoading, isError, refetch } = useOrgBillingDetail(organizationId);
  const { data: plans } = useBillingPlans();
  const syncMutation = useSyncFromStripe();

  const [customerDialog, setCustomerDialog] = useState(false);
  const [subDialog, setSubDialog] = useState(false);
  const [invoiceDialog, setInvoiceDialog] = useState(false);
  const [blockDialog, setBlockDialog] = useState(false);
  const [overrideDialog, setOverrideDialog] = useState(false);
  const [trialDialog, setTrialDialog] = useState(false);
  const [cancelDialog, setCancelDialog] = useState(false);

  if (isLoading) {
    return <div className="space-y-4 p-6">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-32 w-full" />)}</div>;
  }

  if (isError || !data) {
    return (
      <div className="p-6 text-center">
        <p className="text-destructive mb-2">Erro ao carregar dados de cobrança.</p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>Tentar novamente</Button>
      </div>
    );
  }

  const org = data.organization;
  const customer = data.customer;
  const activeSub = data.subscriptions.find((s) => s.status !== "canceled");
  const bs = org.billing_status as BillingStatus;
  const isBlocked = bs === "blocked" || bs === "suspended";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link to="/platform/billing">
          <Button variant="ghost" size="icon"><ArrowLeft className="h-4 w-4" /></Button>
        </Link>
        <div className="flex-1">
          <h1 className="text-2xl font-bold">{org.name}</h1>
          <p className="text-sm text-muted-foreground">{org.slug}</p>
        </div>
        <Badge variant="secondary" className={`${BILLING_STATUS_VARIANT[bs]} text-sm px-3 py-1`}>
          {BILLING_STATUS_LABEL[bs] ?? bs}
        </Badge>
        <Button
          variant="outline"
          size="sm"
          onClick={() => syncMutation.mutate(organizationId!)}
          disabled={syncMutation.isPending}
        >
          <RefreshCw className={`mr-2 h-4 w-4 ${syncMutation.isPending ? "animate-spin" : ""}`} />
          Sincronizar Stripe
        </Button>
      </div>

      {/* Summary cards */}
      <div className="grid md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Customer Stripe</CardTitle>
          </CardHeader>
          <CardContent>
            {customer ? (
              <div className="space-y-1">
                <p className="font-mono text-sm">{customer.stripe_customer_id ?? "Sem ID Stripe"}</p>
                <p className="text-sm text-muted-foreground">{customer.email ?? "Sem e-mail"}</p>
                {customer.tax_id && <p className="text-xs text-muted-foreground">CNPJ/CPF: {customer.tax_id}</p>}
              </div>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setCustomerDialog(true)}>
                <Plus className="mr-2 h-4 w-4" /> Criar customer
              </Button>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Assinatura</CardTitle>
          </CardHeader>
          <CardContent>
            {activeSub ? (
              <div className="space-y-1">
                <p className="font-medium">{data.active_plan?.name ?? "Plano"}</p>
                <p className="text-sm">{formatCentsBRL(data.active_plan?.amount_cents ?? 0)}/{data.active_plan?.interval === "year" ? "ano" : "mês"}</p>
                <p className="text-xs text-muted-foreground">
                  {PAYMENT_METHOD_LABEL[activeSub.payment_method]} — vence {activeSub.current_period_end ? formatDateBR(activeSub.current_period_end.slice(0, 10)) : "—"}
                </p>
                {activeSub.cancel_at_period_end && (
                  <p className="text-xs text-warning font-medium">Cancelamento ao fim do período</p>
                )}
              </div>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setSubDialog(true)} disabled={!customer}>
                <CreditCard className="mr-2 h-4 w-4" /> Criar assinatura
              </Button>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Info</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <p className="text-sm">E-mail cobrança: {org.billing_email ?? "—"}</p>
            <p className="text-sm">Unidades: {data.units_count ?? "—"}</p>
            {org.trial_ends_at && (
              <p className="text-sm">Trial até: {formatDateBR(org.trial_ends_at.slice(0, 10))}</p>
            )}
            {org.blocked_at && (
              <p className="text-sm text-destructive">Bloqueado em: {formatDateBR(org.blocked_at.slice(0, 10))}</p>
            )}
            {org.blocked_reason && (
              <p className="text-xs text-muted-foreground">Motivo: {org.blocked_reason}</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Actions */}
      <div className="flex flex-wrap gap-2">
        {!customer && (
          <Button size="sm" variant="outline" onClick={() => setCustomerDialog(true)}>
            <Plus className="mr-2 h-3 w-3" /> Criar customer
          </Button>
        )}
        {customer && !activeSub && (
          <Button size="sm" variant="outline" onClick={() => setSubDialog(true)}>
            <CreditCard className="mr-2 h-3 w-3" /> Criar assinatura
          </Button>
        )}
        {activeSub && !activeSub.cancel_at_period_end && (
          <Button size="sm" variant="outline" onClick={() => setCancelDialog(true)}>
            Cancelar assinatura
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={() => setInvoiceDialog(true)} disabled={!customer}>
          Gerar fatura manual
        </Button>
        <Button size="sm" variant="outline" onClick={() => setOverrideDialog(true)}>
          Criar override
        </Button>
        <Button size="sm" variant="outline" onClick={() => setTrialDialog(true)}>
          <Clock className="mr-2 h-3 w-3" /> Estender trial
        </Button>
        <Separator orientation="vertical" className="h-8 hidden sm:block" />
        {isBlocked ? (
          <UnblockButton organizationId={org.id} />
        ) : (
          <Button size="sm" variant="destructive" onClick={() => setBlockDialog(true)}>
            <Lock className="mr-2 h-3 w-3" /> Bloquear
          </Button>
        )}
      </div>

      {/* WhatsApp: implantação (origem COMERCIAL) × acesso (fonte do direito).
          Dois cards deliberadamente separados — uma cortesia de implantação
          NÃO concede entitlement, e uma cortesia de entitlement NÃO cria
          implantação. Ver ImplantacaoCard / WhatsappAccessCard. */}
      <div className="grid md:grid-cols-2 gap-4">
        <ImplantacaoCard organizationId={org.id} />
        <WhatsappAccessCard organizationId={org.id} orgName={org.name} />
      </div>

      {/* Tabs */}
      <Tabs defaultValue="invoices">
        <TabsList>
          <TabsTrigger value="invoices">Faturas ({data.invoices.length})</TabsTrigger>
          <TabsTrigger value="payment_methods">Cartões</TabsTrigger>
          <TabsTrigger value="overrides">Overrides ({data.overrides.length})</TabsTrigger>
          <TabsTrigger value="notifications">Notificações ({data.notifications.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="invoices" className="mt-4">
          <InvoicesTable invoices={data.invoices} />
        </TabsContent>

        <TabsContent value="payment_methods" className="mt-4">
          <PaymentMethodsTable organizationId={org.id} />
        </TabsContent>

        <TabsContent value="overrides" className="mt-4">
          <OverridesTable overrides={data.overrides} />
        </TabsContent>

        <TabsContent value="notifications" className="mt-4">
          <NotificationsTable notifications={data.notifications} />
        </TabsContent>
      </Tabs>

      {/* Dialogs */}
      <CreateCustomerDialog
        open={customerDialog}
        onOpenChange={setCustomerDialog}
        organizationId={org.id}
        orgName={org.name}
        billingEmail={org.billing_email}
      />
      <CreateSubscriptionDialog
        open={subDialog}
        onOpenChange={setSubDialog}
        organizationId={org.id}
        plans={plans ?? []}
      />
      <CreateInvoiceDialog
        open={invoiceDialog}
        onOpenChange={setInvoiceDialog}
        organizationId={org.id}
        planAmount={data.active_plan?.amount_cents}
      />
      <BlockOrgDialog
        open={blockDialog}
        onOpenChange={setBlockDialog}
        organizationId={org.id}
        orgName={org.name}
      />
      <OverrideDialog
        open={overrideDialog}
        onOpenChange={setOverrideDialog}
        organizationId={org.id}
      />
      <TrialDialog
        open={trialDialog}
        onOpenChange={setTrialDialog}
        organizationId={org.id}
      />
      {activeSub && (
        <CancelSubDialog
          open={cancelDialog}
          onOpenChange={setCancelDialog}
          subscriptionId={activeSub.id}
        />
      )}
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────────────────

function UnblockButton({ organizationId }: { organizationId: string }) {
  const mutation = useUnblockOrganization();
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={() => mutation.mutate(organizationId, {
        onSuccess: () => toast.success("Organização desbloqueada."),
        onError: (err) => toast.error(err.message),
      })}
      disabled={mutation.isPending}
    >
      <Unlock className="mr-2 h-3 w-3" /> Desbloquear
    </Button>
  );
}

function InvoicesTable({ invoices }: { invoices: BillingInvoice[] }) {
  if (invoices.length === 0) return <p className="text-muted-foreground text-sm py-4">Nenhuma fatura.</p>;

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Nº</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Valor</TableHead>
            <TableHead className="hidden md:table-cell">Pagamento</TableHead>
            <TableHead className="hidden md:table-cell">Vencimento</TableHead>
            <TableHead className="hidden lg:table-cell">Pago em</TableHead>
            <TableHead className="w-10"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {invoices.map((inv) => (
            <TableRow key={inv.id}>
              <TableCell className="font-mono text-xs">{inv.number ?? inv.stripe_invoice_id?.slice(-8) ?? inv.id.slice(0, 8)}</TableCell>
              <TableCell>
                <Badge variant="secondary" className={inv.status === "paid" ? "bg-success/10 text-success" : inv.status === "open" ? "bg-warning/10 text-warning" : "bg-muted text-muted-foreground"}>
                  {INVOICE_STATUS_LABEL[inv.status] ?? inv.status}
                </Badge>
              </TableCell>
              <TableCell>{formatCentsBRL(inv.amount_cents)}</TableCell>
              <TableCell className="hidden md:table-cell">{inv.payment_method ? PAYMENT_METHOD_LABEL[inv.payment_method] : "—"}</TableCell>
              <TableCell className="hidden md:table-cell">{inv.due_date ? formatDateBR(inv.due_date) : "—"}</TableCell>
              <TableCell className="hidden lg:table-cell">{inv.paid_at ? formatDateBR(inv.paid_at.slice(0, 10)) : "—"}</TableCell>
              <TableCell>
                {inv.hosted_invoice_url && (
                  <div className="flex gap-1">
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => { navigator.clipboard.writeText(inv.hosted_invoice_url!); toast.success("Link copiado."); }}>
                      <Copy className="h-3 w-3" />
                    </Button>
                    <a href={inv.hosted_invoice_url} target="_blank" rel="noopener noreferrer">
                      <Button variant="ghost" size="icon" className="h-8 w-8"><ExternalLink className="h-3 w-3" /></Button>
                    </a>
                  </div>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function PaymentMethodsTable({ organizationId }: { organizationId: string }) {
  const { data, isLoading, isError, refetch } = usePaymentMethods(organizationId);
  const deleteMutation = useDeletePaymentMethod();
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; label: string } | null>(null);

  if (isLoading) {
    return <p className="text-muted-foreground text-sm py-4">Carregando cartões…</p>;
  }
  if (isError) {
    return (
      <div className="text-sm py-4 space-y-2">
        <p className="text-destructive">Falha ao listar cartões.</p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>Tentar novamente</Button>
      </div>
    );
  }
  const pms = data?.payment_methods ?? [];
  if (pms.length === 0) {
    return <p className="text-muted-foreground text-sm py-4">Nenhum cartão cadastrado.</p>;
  }

  return (
    <>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Bandeira</TableHead>
              <TableHead>Final</TableHead>
              <TableHead>Validade</TableHead>
              <TableHead>Padrão</TableHead>
              <TableHead className="w-10"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pms.map((pm) => (
              <TableRow key={pm.id}>
                <TableCell className="font-medium">{(pm.brand ?? "card").toUpperCase()}</TableCell>
                <TableCell className="font-mono">•••• {pm.last4 ?? "----"}</TableCell>
                <TableCell>
                  {pm.exp_month ? `${String(pm.exp_month).padStart(2, "0")}/${pm.exp_year}` : "—"}
                </TableCell>
                <TableCell>
                  {pm.is_default && (
                    <Badge variant="secondary" className="bg-success/10 text-success">Padrão</Badge>
                  )}
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-destructive hover:text-destructive"
                    onClick={() =>
                      setConfirmDelete({
                        id: pm.id,
                        label: `${(pm.brand ?? "card").toUpperCase()} •••• ${pm.last4 ?? "----"}`,
                      })
                    }
                    disabled={deleteMutation.isPending}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground mt-2">
        Apenas administradores da plataforma podem remover cartões. O cliente pode trocar
        o cartão pela aba "Cobrança" do próprio painel.
      </p>

      <AlertDialog open={!!confirmDelete} onOpenChange={(open) => !open && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover cartão {confirmDelete?.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              O cartão será desvinculado do customer no Stripe. Próximas cobranças
              recorrentes vão falhar até o cliente cadastrar outro cartão.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteMutation.isPending}
              onClick={() => {
                if (!confirmDelete) return;
                deleteMutation.mutate(
                  { paymentMethodId: confirmDelete.id, organizationId },
                  { onSuccess: () => setConfirmDelete(null) },
                );
              }}
            >
              {deleteMutation.isPending ? "Removendo..." : "Remover"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function OverridesTable({ overrides }: { overrides: BillingAccessOverride[] }) {
  const deactivate = useDeactivateOverride();

  if (overrides.length === 0) return <p className="text-muted-foreground text-sm py-4">Nenhum override.</p>;

  const TYPE_LABEL: Record<string, string> = {
    grant_access: "Liberar acesso",
    block_access: "Bloquear acesso",
    extend_trial: "Estender trial",
  };

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Tipo</TableHead>
            <TableHead>Motivo</TableHead>
            <TableHead>Validade</TableHead>
            <TableHead>Ativo</TableHead>
            <TableHead className="w-10"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {overrides.map((ov) => (
            <TableRow key={ov.id}>
              <TableCell>{TYPE_LABEL[ov.override_type] ?? ov.override_type}</TableCell>
              <TableCell className="max-w-[200px] truncate">{ov.reason}</TableCell>
              <TableCell>{ov.valid_until ? formatDateBR(ov.valid_until.slice(0, 10)) : "Permanente"}</TableCell>
              <TableCell>
                <Badge variant={ov.active ? "default" : "secondary"}>{ov.active ? "Sim" : "Não"}</Badge>
              </TableCell>
              <TableCell>
                {ov.active && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => deactivate.mutate(ov.id, {
                      onSuccess: () => toast.success("Override desativado."),
                      onError: (err) => toast.error(err.message),
                    })}
                    disabled={deactivate.isPending}
                  >
                    Desativar
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function NotificationsTable({ notifications }: { notifications: BillingNotification[] }) {
  if (notifications.length === 0) return <p className="text-muted-foreground text-sm py-4">Nenhuma notificação.</p>;

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Evento</TableHead>
            <TableHead>Canal</TableHead>
            <TableHead>Destinatário</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="hidden md:table-cell">Data</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {notifications.map((n) => (
            <TableRow key={n.id}>
              <TableCell className="text-xs">{n.event_type}</TableCell>
              <TableCell>{n.channel}</TableCell>
              <TableCell className="max-w-[150px] truncate">{n.recipient}</TableCell>
              <TableCell>
                <Badge variant={n.status === "sent" ? "default" : "destructive"}>{n.status}</Badge>
              </TableCell>
              <TableCell className="hidden md:table-cell">{formatDateBR(n.sent_at.slice(0, 10))}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ── Dialogs ──────────────────────────────────────────────────────────────────

function CreateCustomerDialog({ open, onOpenChange, organizationId, orgName, billingEmail }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  organizationId: string;
  orgName: string;
  billingEmail: string | null;
}) {
  const mutation = useCreateBillingCustomer();
  const [email, setEmail] = useState(billingEmail ?? "");
  const [name, setName] = useState(orgName);
  const [taxId, setTaxId] = useState("");

  function handleSubmit() {
    mutation.mutate(
      { organization_id: organizationId, email: email || undefined, name: name || undefined, tax_id: taxId || undefined },
      {
        onSuccess: (data) => {
          toast.success(data.created ? "Customer criado." : "Customer já existia.");
          onOpenChange(false);
        },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Criar Customer Stripe</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Nome</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <Label>E-mail de cobrança</Label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <Label>CNPJ/CPF</Label>
            <Input value={taxId} onChange={(e) => setTaxId(e.target.value)} placeholder="Opcional" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button onClick={handleSubmit} disabled={mutation.isPending}>
            {mutation.isPending ? "Criando..." : "Criar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateSubscriptionDialog({ open, onOpenChange, organizationId, plans }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  organizationId: string;
  plans: { id: string; name: string; amount_cents: number; slug: string; active: boolean }[];
}) {
  const mutation = useCreateSubscription();
  const [planId, setPlanId] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("card");
  const [trialDays, setTrialDays] = useState("");

  const activePlans = plans.filter((p) => p.active);

  function handleSubmit() {
    if (!planId) { toast.error("Selecione um plano."); return; }
    mutation.mutate(
      {
        organization_id: organizationId,
        plan_id: planId,
        payment_method: paymentMethod,
        trial_days: trialDays ? Number(trialDays) : undefined,
      },
      {
        onSuccess: () => {
          toast.success("Assinatura criada.");
          onOpenChange(false);
        },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Criar Assinatura</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Plano</Label>
            <Select value={planId} onValueChange={setPlanId}>
              <SelectTrigger><SelectValue placeholder="Selecione" /></SelectTrigger>
              <SelectContent>
                {activePlans.map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.name} — {formatCentsBRL(p.amount_cents)}/mês</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Método de pagamento</Label>
            <Select value={paymentMethod} onValueChange={setPaymentMethod}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="card">Cartão</SelectItem>
                <SelectItem value="boleto">Boleto</SelectItem>
                <SelectItem value="pix">PIX</SelectItem>
                <SelectItem value="manual">Manual</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Trial (dias, opcional)</Label>
            <Input type="number" value={trialDays} onChange={(e) => setTrialDays(e.target.value)} placeholder="14" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button onClick={handleSubmit} disabled={mutation.isPending}>
            {mutation.isPending ? "Criando..." : "Criar assinatura"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateInvoiceDialog({ open, onOpenChange, organizationId, planAmount }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  organizationId: string;
  planAmount?: number;
}) {
  const mutation = useCreateManualInvoice();
  const [amount, setAmount] = useState(planAmount ? String(planAmount) : "");
  const [description, setDescription] = useState("Mensalidade Moralles Reservas");
  const [paymentMethod, setPaymentMethod] = useState("pix");
  const [daysUntilDue, setDaysUntilDue] = useState("7");

  function handleSubmit() {
    if (!amount || Number(amount) <= 0) { toast.error("Informe o valor."); return; }
    mutation.mutate(
      {
        organization_id: organizationId,
        amount_cents: Number(amount),
        description,
        payment_method: paymentMethod,
        days_until_due: Number(daysUntilDue),
      },
      {
        onSuccess: (data) => {
          toast.success("Fatura criada.");
          if (data.invoice?.hosted_invoice_url) {
            navigator.clipboard.writeText(data.invoice.hosted_invoice_url);
            toast.info("Link de pagamento copiado.");
          }
          onOpenChange(false);
        },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Gerar Fatura Manual</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Valor (centavos)</Label>
            <Input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="19900" />
            {Number(amount) > 0 && <p className="text-xs text-muted-foreground mt-1">{formatCentsBRL(Number(amount))}</p>}
          </div>
          <div>
            <Label>Descrição</Label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div>
            <Label>Método de pagamento</Label>
            <Select value={paymentMethod} onValueChange={setPaymentMethod}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="pix">PIX</SelectItem>
                <SelectItem value="boleto">Boleto</SelectItem>
                <SelectItem value="manual">Manual</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Dias até vencimento</Label>
            <Input type="number" value={daysUntilDue} onChange={(e) => setDaysUntilDue(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button onClick={handleSubmit} disabled={mutation.isPending}>
            {mutation.isPending ? "Criando..." : "Gerar fatura"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BlockOrgDialog({ open, onOpenChange, organizationId, orgName }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  organizationId: string;
  orgName: string;
}) {
  const mutation = useBlockOrganization();
  const [reason, setReason] = useState("");

  function handleSubmit() {
    if (!reason.trim()) { toast.error("Informe o motivo."); return; }
    mutation.mutate(
      { organization_id: organizationId, reason },
      {
        onSuccess: () => { toast.success("Organização bloqueada."); onOpenChange(false); setReason(""); },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Bloquear {orgName}?</AlertDialogTitle>
          <AlertDialogDescription>A organização perderá acesso ao sistema.</AlertDialogDescription>
        </AlertDialogHeader>
        <Textarea placeholder="Motivo (obrigatório)" value={reason} onChange={(e) => setReason(e.target.value)} />
        <AlertDialogFooter>
          <AlertDialogCancel>Cancelar</AlertDialogCancel>
          <AlertDialogAction className="bg-destructive text-destructive-foreground" disabled={mutation.isPending || !reason.trim()} onClick={handleSubmit}>
            {mutation.isPending ? "Bloqueando..." : "Bloquear"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function OverrideDialog({ open, onOpenChange, organizationId }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  organizationId: string;
}) {
  const mutation = useCreateOverride();
  const [type, setType] = useState("grant_access");
  const [reason, setReason] = useState("");
  const [validUntil, setValidUntil] = useState("");

  function handleSubmit() {
    if (!reason.trim()) { toast.error("Informe o motivo."); return; }
    mutation.mutate(
      { organization_id: organizationId, override_type: type, reason, valid_until: validUntil || undefined },
      {
        onSuccess: () => { toast.success("Override criado."); onOpenChange(false); setReason(""); },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Criar Override</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Tipo</Label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="grant_access">Liberar acesso</SelectItem>
                <SelectItem value="block_access">Bloquear acesso</SelectItem>
                <SelectItem value="extend_trial">Estender trial</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Motivo (obrigatório)</Label>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <div>
            <Label>Válido até (opcional)</Label>
            <Input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button onClick={handleSubmit} disabled={mutation.isPending || !reason.trim()}>
            {mutation.isPending ? "Criando..." : "Criar override"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TrialDialog({ open, onOpenChange, organizationId }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  organizationId: string;
}) {
  const mutation = useExtendTrial();
  const [days, setDays] = useState("14");
  const [reason, setReason] = useState("");

  function handleSubmit() {
    mutation.mutate(
      { organization_id: organizationId, trial_days: Number(days), reason: reason || undefined },
      {
        onSuccess: () => { toast.success("Trial estendido."); onOpenChange(false); },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Estender Trial</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Dias de trial</Label>
            <Input type="number" value={days} onChange={(e) => setDays(e.target.value)} />
          </div>
          <div>
            <Label>Motivo (opcional)</Label>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button onClick={handleSubmit} disabled={mutation.isPending}>
            {mutation.isPending ? "Estendendo..." : "Estender"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CancelSubDialog({ open, onOpenChange, subscriptionId }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  subscriptionId: string;
}) {
  const mutation = useCancelSubscription();
  const [atPeriodEnd, setAtPeriodEnd] = useState(true);

  function handleSubmit() {
    mutation.mutate(
      { subscription_id: subscriptionId, at_period_end: atPeriodEnd },
      {
        onSuccess: () => { toast.success("Assinatura cancelada."); onOpenChange(false); },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Cancelar assinatura?</AlertDialogTitle>
          <AlertDialogDescription>
            {atPeriodEnd
              ? "O acesso será mantido até o fim do período atual."
              : "O cancelamento será imediato."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex items-center gap-2 mt-2">
          <input type="checkbox" id="atPeriodEnd" checked={atPeriodEnd} onChange={(e) => setAtPeriodEnd(e.target.checked)} />
          <Label htmlFor="atPeriodEnd" className="text-sm">Cancelar apenas ao fim do período</Label>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Voltar</AlertDialogCancel>
          <AlertDialogAction className="bg-destructive text-destructive-foreground" disabled={mutation.isPending} onClick={handleSubmit}>
            {mutation.isPending ? "Cancelando..." : "Cancelar assinatura"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ── WhatsApp: implantação × acesso (Task 16) ────────────────────────────────
//
// Dois cards, deliberadamente separados:
//   - ImplantacaoCard    — origem COMERCIAL: como o serviço de configuração
//                          de R$750 foi pago (ou por que não foi). Read-only
//                          + link; criar/avançar/cancelar mora na página
//                          /platform/billing/implementacoes.
//   - WhatsappAccessCard — fonte do ACESSO: assinatura paga da instância ×
//                          cortesia administrativa (organization_entitlement_
//                          overrides, feature "whatsapp"). Uma implantação
//                          COURTESY não concede isto, e uma cortesia daqui
//                          não registra implantação nenhuma.

/** Subconjunto de ADMIN_COLUMNS usado só para o resumo — ver tipo irmão em
 *  WhatsappImplementations.tsx (não compartilhado: cada página projeta só o
 *  que exibe). */
interface AdminImplementationSummary {
  origin: ImplementationOrigin;
  amount_cents: number | null;
  payment_status: ImplementationPaymentStatus;
  operational_status: ImplementationOperationalStatus;
  owner_admin_id: string | null;
  created_at: string;
}

/** Linha de organization_entitlement_overrides projetada por
 *  list_whatsapp_overrides — sem organization_id (a EF não seleciona essa
 *  coluna aqui), por isso não é o mesmo tipo de OrganizationEntitlementOverride
 *  em src/types/billing.ts. */
interface WhatsappOverrideRow {
  id: string;
  grant_type: EntitlementGrantType;
  ends_at: string | null;
  revoked_at: string | null;
}

const GRANT_TYPES: EntitlementGrantType[] = ["LIFETIME", "TEMPORARY", "PROMOTIONAL", "MANUAL_OVERRIDE"];

/**
 * `entitlements: null` na resposta de grant/revoke NÃO é falha — a escrita já
 * commitou, só a releitura do snapshot pós-escrita falhou (ver
 * supabase/functions/_shared/entitlement-overrides.ts). Mostra sucesso sempre;
 * o aviso extra é informativo, nunca um toast de erro. Não tipamos o objeto
 * `entitlements` da resposta (ele carrega um `readFailed` solto que a EF
 * repassa cru) — só checamos se veio `null`.
 */
function afterOverrideMutation(res: unknown, successMessage: string) {
  toast.success(successMessage);
  const readFailed =
    res !== null &&
    typeof res === "object" &&
    "entitlements" in res &&
    (res as { entitlements: unknown }).entitlements === null;
  if (readFailed) {
    toast.info(
      "A concessão foi gravada, mas não foi possível confirmar o novo status agora. A tela pode levar um instante para refletir a mudança.",
    );
  }
}

function ImplantacaoCard({ organizationId }: { organizationId: string }) {
  const { data, isLoading, isError, refetch } = useImplementations({ organization_id: organizationId });
  const rows = (data?.implementations ?? []) as unknown as AdminImplementationSummary[];
  // Mais recente primeiro — mesma ordenação da EF (created_at desc).
  const latest = rows[0] ?? null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        <Wrench className="h-4 w-4 text-muted-foreground" />
        <CardTitle className="text-sm font-medium">Implantação do WhatsApp</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : isError ? (
          <div className="space-y-2">
            <p className="text-sm text-destructive">Falha ao carregar a implantação.</p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>Tentar novamente</Button>
          </div>
        ) : !latest ? (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">Nenhuma implantação registrada para esta empresa.</p>
            <Button variant="outline" size="sm" asChild>
              <Link to="/platform/billing/implementacoes">Registrar implantação</Link>
            </Button>
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <p className="text-muted-foreground">Origem</p>
                <p className="font-medium">{IMPLEMENTATION_ORIGIN_LABEL[latest.origin]}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Valor</p>
                <p className="font-medium">
                  {latest.amount_cents == null ? "—" : formatCentsBRL(latest.amount_cents)}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Financeiro</p>
                <Badge variant="secondary">{IMPLEMENTATION_PAYMENT_LABEL[latest.payment_status]}</Badge>
              </div>
              <div>
                <p className="text-muted-foreground">Operacional</p>
                <Badge variant="secondary">{IMPLEMENTATION_OPERATIONAL_LABEL[latest.operational_status]}</Badge>
              </div>
              <div>
                <p className="text-muted-foreground">Responsável</p>
                <p className="font-medium">{latest.owner_admin_id ?? "—"}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Criada em</p>
                <p className="font-medium">{formatDateBR(latest.created_at.slice(0, 10))}</p>
              </div>
            </div>
            <p className="text-xs text-muted-foreground border-t pt-2">
              Registra COMO a configuração foi paga — não libera nem bloqueia o acesso ao
              WhatsApp (isso é o card ao lado).
            </p>
            <Button variant="outline" size="sm" asChild>
              <Link to="/platform/billing/implementacoes">
                Ver na página de implantações <ExternalLink className="ml-2 h-3 w-3" />
              </Link>
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function WhatsappAccessCard({ organizationId, orgName }: { organizationId: string; orgName: string }) {
  const { data, isLoading, isError, refetch } = useWhatsappServiceStatus(organizationId);
  const {
    data: overrides,
    isLoading: ovLoading,
    isError: ovError,
    refetch: ovRefetch,
  } = useWhatsappOverrides(organizationId);
  const revoke = useRevokeWhatsappOverride();
  const [grantOpen, setGrantOpen] = useState(false);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-sm font-medium">Acesso ao WhatsApp</CardTitle>
        </div>
        <Button size="sm" variant="outline" onClick={() => setGrantOpen(true)}>
          Conceder cortesia
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : isError || !data ? (
          <div className="space-y-2">
            <p className="text-sm text-destructive">Falha ao carregar o status de acesso.</p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>Tentar novamente</Button>
          </div>
        ) : (
          <div className="space-y-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">Assinatura paga:</span>
              <Badge
                variant="secondary"
                className={data.subscription.has_instance ? "bg-success/10 text-success" : "bg-muted text-muted-foreground"}
              >
                {data.subscription.has_instance ? "Ativa" : "Sem assinatura"}
              </Badge>
              {data.subscription.next_due && (
                <span className="text-xs text-muted-foreground">
                  vence {formatDateBR(data.subscription.next_due.slice(0, 10))}
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">Cortesia administrativa:</span>
              <Badge
                variant="secondary"
                className={data.override.active ? "bg-info/10 text-info" : "bg-muted text-muted-foreground"}
              >
                {data.override.active ? "Ativa" : "Nenhuma"}
              </Badge>
            </div>
            {data.override.active && (
              <p className="text-xs text-muted-foreground">
                {ENTITLEMENT_GRANT_TYPE_LABEL[(data.override.grant_type ?? "MANUAL_OVERRIDE") as EntitlementGrantType]}
                {" — "}
                {data.override.ends_at
                  ? `expira em ${formatDateBR(data.override.ends_at.slice(0, 10))}`
                  : "sem validade (não expira)"}
                . O custo de Z-API desta conta é patrocinado pela plataforma enquanto esta
                cortesia estiver ativa.
              </p>
            )}
            <p className="text-xs text-muted-foreground border-t pt-2">
              Isto é a fonte do ACESSO ao recurso — separada da implantação (como o serviço
              de configuração foi pago). Conceder cortesia aqui não registra nem substitui a
              implantação do card ao lado.
            </p>
          </div>
        )}

        <div className="space-y-2 border-t pt-3">
          <p className="text-xs font-medium text-muted-foreground">Concessões de WhatsApp</p>
          {ovLoading ? (
            <Skeleton className="h-12 w-full" />
          ) : ovError ? (
            <div className="space-y-1">
              <p className="text-xs text-destructive">Falha ao listar as concessões.</p>
              <Button variant="outline" size="sm" onClick={() => ovRefetch()}>Tentar novamente</Button>
            </div>
          ) : !overrides || overrides.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nenhuma concessão registrada.</p>
          ) : (
            <ul className="space-y-1.5">
              {(overrides as unknown as WhatsappOverrideRow[]).map((ov) => (
                <li key={ov.id} className="flex items-center justify-between gap-2 text-xs">
                  <span>
                    {ENTITLEMENT_GRANT_TYPE_LABEL[ov.grant_type]} —{" "}
                    {ov.ends_at ? formatDateBR(ov.ends_at.slice(0, 10)) : "sem validade"}
                    {ov.revoked_at && " (revogada)"}
                  </span>
                  {!ov.revoked_at && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2"
                      disabled={revoke.isPending && revoke.variables?.override_id === ov.id}
                      onClick={() =>
                        revoke.mutate(
                          { organization_id: organizationId, override_id: ov.id },
                          {
                            onSuccess: (res) => afterOverrideMutation(res, "Concessão revogada."),
                            onError: (err) => toast.error(err.message),
                          },
                        )
                      }
                    >
                      Revogar
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>

      <GrantWhatsappOverrideDialog
        open={grantOpen}
        onOpenChange={setGrantOpen}
        organizationId={organizationId}
        orgName={orgName}
      />
    </Card>
  );
}

function GrantWhatsappOverrideDialog({
  open,
  onOpenChange,
  organizationId,
  orgName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  orgName: string;
}) {
  const grant = useGrantWhatsappOverride();
  const [grantType, setGrantType] = useState<EntitlementGrantType | "">("");
  const [reason, setReason] = useState("");
  const [endsAt, setEndsAt] = useState("");

  // Só TEMPORARY carrega prazo — o servidor recusa com 400 um ends_at em
  // LIFETIME/PROMOTIONAL/MANUAL_OVERRIDE. O campo de data só existe no DOM
  // quando grantType === "TEMPORARY".
  const needsDate = grantType === "TEMPORARY";
  const endsAtMs = endsAt ? new Date(`${endsAt}T23:59:59`).getTime() : NaN;
  const valid =
    grantType !== "" &&
    reason.trim().length > 0 &&
    (!needsDate || (Number.isFinite(endsAtMs) && endsAtMs > Date.now()));

  function handleSubmit() {
    if (!valid || !grantType) return;
    grant.mutate(
      {
        organization_id: organizationId,
        grant_type: grantType,
        reason: reason.trim(),
        ends_at: needsDate ? new Date(`${endsAt}T23:59:59`).toISOString() : undefined,
      },
      {
        onSuccess: (res) => {
          afterOverrideMutation(res, `Acesso ao WhatsApp liberado por cortesia para ${orgName}.`);
          onOpenChange(false);
          setGrantType("");
          setReason("");
          setEndsAt("");
        },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Conceder acesso ao WhatsApp por cortesia?</AlertDialogTitle>
          <AlertDialogDescription>
            Esta empresa poderá gerar um custo mensal de Z-API para a plataforma, mesmo sem
            uma assinatura paga pelo cliente.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Tipo de concessão</Label>
            <Select value={grantType} onValueChange={(v) => setGrantType(v as EntitlementGrantType)}>
              <SelectTrigger><SelectValue placeholder="Selecione" /></SelectTrigger>
              <SelectContent>
                {GRANT_TYPES.map((g) => (
                  <SelectItem key={g} value={g}>{ENTITLEMENT_GRANT_TYPE_LABEL[g]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {needsDate && (
            <div>
              <Label>Válido até</Label>
              <Input type="date" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
            </div>
          )}
          <div>
            <Label>Motivo (obrigatório)</Label>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancelar</AlertDialogCancel>
          <AlertDialogAction disabled={grant.isPending || !valid} onClick={handleSubmit}>
            {grant.isPending ? "Concedendo..." : "Conceder acesso"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
