import { useState } from "react";
import { Link } from "react-router-dom";
import { useOrganizationsBilling, useBillingPlans, useBlockOrganization, useUnblockOrganization } from "@/hooks/useBilling";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Textarea } from "@/components/ui/textarea";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { CreditCard, Eye, Lock, Unlock, MoreHorizontal, Search, DollarSign, Users, AlertTriangle, Clock, Settings2, MessageSquare } from "lucide-react";
import {
  BILLING_STATUS_LABEL,
  BILLING_STATUS_VARIANT,
  PAYMENT_METHOD_LABEL,
  formatCentsBRL,
  type BillingStatus,
  type OrgBillingRow,
} from "@/types/billing";
import { formatDateBR } from "@/lib/utils";

export default function Billing() {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [page, setPage] = useState(0);

  const { data, isLoading, isError, refetch } = useOrganizationsBilling({
    search: search || undefined,
    status: statusFilter || undefined,
    page,
    page_size: 50,
  });
  const { data: plans } = useBillingPlans();

  const blockMutation = useBlockOrganization();
  const unblockMutation = useUnblockOrganization();

  const [blockDialog, setBlockDialog] = useState<{ orgId: string; orgName: string } | null>(null);
  const [blockReason, setBlockReason] = useState("");

  const orgs = data?.organizations ?? [];
  const total = data?.total ?? 0;

  const activeCount = orgs.filter((o) => o.billing_status === "active").length;
  const trialingCount = orgs.filter((o) => o.billing_status === "trialing").length;
  const pastDueCount = orgs.filter((o) => ["past_due", "grace_period", "pending_payment"].includes(o.billing_status)).length;
  const blockedCount = orgs.filter((o) => ["blocked", "suspended"].includes(o.billing_status)).length;

  const mrr = orgs.reduce((sum, o) => {
    if (o.subscription?.plan && ["active", "trialing"].includes(o.subscription.status)) {
      return sum + (o.subscription.plan.amount_cents ?? 0);
    }
    return sum;
  }, 0);

  function handleBlock(orgId: string) {
    if (!blockReason.trim()) {
      toast.error("Informe o motivo do bloqueio.");
      return;
    }
    blockMutation.mutate(
      { organization_id: orgId, reason: blockReason },
      {
        onSuccess: () => {
          toast.success("Organização bloqueada.");
          setBlockDialog(null);
          setBlockReason("");
        },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  function handleUnblock(orgId: string) {
    unblockMutation.mutate(orgId, {
      onSuccess: () => toast.success("Organização desbloqueada."),
      onError: (err) => toast.error(err.message),
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Cobranças</h1>
          <p className="text-muted-foreground text-sm">Gestão de mensalidades e faturamento das organizações.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {/* M-10 (Rodada de correção 1): a lista cross-org de implantações só
              era alcançável por dentro do detalhe de UMA organização — o
              oposto do propósito de uma lista cross-org. Mesmo padrão de
              "Gerenciar planos" abaixo. */}
          <Button variant="outline" asChild>
            <Link to="/platform/billing/implementacoes">
              <MessageSquare className="mr-2 h-4 w-4" /> Implantações de WhatsApp
            </Link>
          </Button>
          <Button variant="outline" asChild>
            <Link to="/platform/billing/planos">
              <Settings2 className="mr-2 h-4 w-4" /> Gerenciar planos
            </Link>
          </Button>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <DollarSign className="h-4 w-4" /> MRR
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{formatCentsBRL(mrr)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Users className="h-4 w-4" /> Ativos
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{activeCount}</p>
            {trialingCount > 0 && (
              <p className="text-xs text-muted-foreground">{trialingCount} em trial</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Clock className="h-4 w-4" /> Vencidos
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-warning">{pastDueCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" /> Bloqueados
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-destructive">{blockedCount}</p>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Buscar por nome..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0); }}
            className="pl-10"
          />
        </div>
        <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v === "all" ? "" : v); setPage(0); }}>
          <SelectTrigger className="w-48">
            <SelectValue placeholder="Todos os status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos os status</SelectItem>
            <SelectItem value="active">Ativo</SelectItem>
            <SelectItem value="trialing">Trial</SelectItem>
            <SelectItem value="past_due">Vencido</SelectItem>
            <SelectItem value="grace_period">Carência</SelectItem>
            <SelectItem value="blocked">Bloqueado</SelectItem>
            <SelectItem value="canceled">Cancelado</SelectItem>
            <SelectItem value="suspended">Suspenso</SelectItem>
            <SelectItem value="manual_override">Override manual</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
      ) : isError ? (
        <Card>
          <CardContent className="py-10 text-center">
            <p className="text-destructive mb-2">Erro ao carregar dados de cobrança.</p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>Tentar novamente</Button>
          </CardContent>
        </Card>
      ) : orgs.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            Nenhuma organização encontrada.
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Empresa</TableHead>
                  <TableHead>Plano</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden md:table-cell">Pagamento</TableHead>
                  <TableHead className="hidden lg:table-cell">Próx. vencimento</TableHead>
                  <TableHead className="hidden md:table-cell">Valor</TableHead>
                  <TableHead className="w-10"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {orgs.map((org: OrgBillingRow) => (
                  <OrgRow
                    key={org.id}
                    org={org}
                    onBlock={() => setBlockDialog({ orgId: org.id, orgName: org.name })}
                    onUnblock={() => handleUnblock(org.id)}
                    isUnblocking={unblockMutation.isPending && unblockMutation.variables === org.id}
                  />
                ))}
              </TableBody>
            </Table>
          </div>

          {total != null && total > 50 && (
            <div className="flex justify-between items-center text-sm">
              <span className="text-muted-foreground">{total} organizações</span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>
                  Anterior
                </Button>
                <Button variant="outline" size="sm" disabled={(page + 1) * 50 >= total} onClick={() => setPage(page + 1)}>
                  Próxima
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Block Dialog */}
      <AlertDialog open={!!blockDialog} onOpenChange={(open) => !open && setBlockDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Bloquear {blockDialog?.orgName}?</AlertDialogTitle>
            <AlertDialogDescription>
              A organização perderá acesso ao sistema até ser desbloqueada manualmente ou regularizar o pagamento.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            placeholder="Motivo do bloqueio (obrigatório)"
            value={blockReason}
            onChange={(e) => setBlockReason(e.target.value)}
            className="mt-2"
          />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={blockMutation.isPending || !blockReason.trim()}
              onClick={() => blockDialog && handleBlock(blockDialog.orgId)}
            >
              {blockMutation.isPending ? "Bloqueando..." : "Bloquear"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function OrgRow({
  org,
  onBlock,
  onUnblock,
  isUnblocking,
}: {
  org: OrgBillingRow;
  onBlock: () => void;
  onUnblock: () => void;
  isUnblocking: boolean;
}) {
  const sub = org.subscription;
  const plan = sub?.plan;
  const bs = org.billing_status as BillingStatus;
  const isBlocked = bs === "blocked" || bs === "suspended";

  return (
    <TableRow>
      <TableCell>
        <Link to={`/platform/billing/${org.id}`} className="font-medium hover:underline">
          {org.name}
        </Link>
        <p className="text-xs text-muted-foreground">{org.slug}</p>
      </TableCell>
      <TableCell>{plan?.name ?? org.plan ?? "—"}</TableCell>
      <TableCell>
        <Badge variant="secondary" className={BILLING_STATUS_VARIANT[bs]}>
          {BILLING_STATUS_LABEL[bs] ?? bs}
        </Badge>
      </TableCell>
      <TableCell className="hidden md:table-cell">
        {sub?.payment_method ? PAYMENT_METHOD_LABEL[sub.payment_method] ?? sub.payment_method : "—"}
      </TableCell>
      <TableCell className="hidden lg:table-cell">
        {sub?.current_period_end ? formatDateBR(sub.current_period_end.slice(0, 10)) : "—"}
      </TableCell>
      <TableCell className="hidden md:table-cell">
        {plan ? formatCentsBRL(plan.amount_cents) : "—"}
      </TableCell>
      <TableCell>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem asChild>
              <Link to={`/platform/billing/${org.id}`}>
                <Eye className="mr-2 h-4 w-4" /> Ver detalhes
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {isBlocked ? (
              <DropdownMenuItem onClick={onUnblock} disabled={isUnblocking}>
                <Unlock className="mr-2 h-4 w-4" /> Desbloquear
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onClick={onBlock} className="text-destructive">
                <Lock className="mr-2 h-4 w-4" /> Bloquear
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
}
