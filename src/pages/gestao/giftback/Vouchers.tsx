import { useMemo, useState } from "react";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import {
  useVouchers,
  useCancelVoucher,
  TRIGGER_LABEL,
  type VoucherStatus,
  type VoucherWithCustomer,
} from "@/hooks/useVouchers";
import { IssueVoucherDialog } from "@/components/giftback/IssueVoucherDialog";
import { VoucherStatusBadge } from "@/components/giftback/VoucherStatusBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Gift, Plus, MoreHorizontal, XCircle, ChevronLeft, ChevronRight } from "lucide-react";
import { formatPhone } from "@/lib/utils";
import { toast } from "sonner";

const STATUS_FILTERS: ("all" | VoucherStatus)[] = ["all", "active", "used", "expired", "cancelled"];

const PAGE_SIZE = 20;

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
  });
}

export default function Vouchers() {
  const unit = useCurrentUnit();
  const unitId = unit?.unit_id ?? "";
  const organizationId = unit?.organization_id ?? "";

  const { data: vouchers, isLoading } = useVouchers(unitId);
  const cancel = useCancelVoucher(unitId);

  const [issueOpen, setIssueOpen] = useState(false);
  const [filter, setFilter] = useState<"all" | VoucherStatus>("all");
  const [page, setPage] = useState(0);
  const [confirmCancel, setConfirmCancel] = useState<VoucherWithCustomer | null>(null);

  const filtered = useMemo(() => {
    if (!vouchers) return [];
    if (filter === "all") return vouchers;
    return vouchers.filter((v) => v.status === filter);
  }, [vouchers, filter]);

  const total = filtered.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const handleCancel = async () => {
    if (!confirmCancel) return;
    try {
      await cancel.mutateAsync(confirmCancel.id);
      toast.success("Voucher cancelado");
      setConfirmCancel(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao cancelar");
    }
  };

  return (
    <div className="space-y-5">
      <header className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Gift className="h-5 w-5 text-gold" />
            <h1 className="text-2xl font-bold">Vouchers emitidos</h1>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Histórico de vouchers, com status e ações.
          </p>
        </div>
        <Button onClick={() => setIssueOpen(true)} className="gap-1.5">
          <Plus className="h-4 w-4" />
          Emitir voucher
        </Button>
      </header>

      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <Select value={filter} onValueChange={(v) => { setFilter(v as "all" | VoucherStatus); setPage(0); }}>
              <SelectTrigger className="w-44 h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_FILTERS.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s === "all" ? "Todos" :
                     s === "active" ? "Ativos" :
                     s === "used" ? "Usados" :
                     s === "expired" ? "Expirados" : "Cancelados"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {total} voucher{total === 1 ? "" : "s"} no filtro
            </p>
          </div>

          {isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : total === 0 ? (
            <div className="py-12 text-center text-muted-foreground space-y-2">
              <Gift className="h-6 w-6 mx-auto opacity-30" />
              <p className="text-sm">
                {filter === "all"
                  ? "Nenhum voucher emitido ainda."
                  : `Nenhum voucher ${filter === "active" ? "ativo" : filter === "used" ? "usado" : filter === "expired" ? "expirado" : "cancelado"}.`}
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Código</TableHead>
                  <TableHead>Cliente</TableHead>
                  <TableHead>Desconto</TableHead>
                  <TableHead>Gatilho</TableHead>
                  <TableHead>Emitido</TableHead>
                  <TableHead>Validade</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-10"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((v) => (
                  <TableRow key={v.id}>
                    <TableCell className="font-mono font-semibold">{v.code}</TableCell>
                    <TableCell>
                      <div className="space-y-0.5 min-w-0">
                        <p className="text-sm font-medium truncate">
                          {v.customer?.name || "—"}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {v.customer?.phone ? formatPhone(v.customer.phone) : ""}
                        </p>
                      </div>
                    </TableCell>
                    <TableCell className="font-semibold text-gold">
                      {v.discount_percent}%
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {v.rule ? TRIGGER_LABEL[v.rule.trigger_type] : "Manual avulso"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDateTime(v.issued_at)}
                    </TableCell>
                    <TableCell className="text-xs">
                      {formatDate(v.expires_at)}
                    </TableCell>
                    <TableCell>
                      <VoucherStatusBadge status={v.status} />
                    </TableCell>
                    <TableCell>
                      {v.status === "active" && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Mais ações">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onClick={() => setConfirmCancel(v)}
                              className="text-destructive focus:text-destructive"
                            >
                              <XCircle className="h-3.5 w-3.5 mr-2" />
                              Cancelar voucher
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          {total > PAGE_SIZE && (
            <div className="flex items-center justify-end gap-2 pt-2">
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={safePage === 0}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="text-xs text-muted-foreground min-w-[3rem] text-center">
                {safePage + 1} / {pageCount}
              </span>
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8"
                onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                disabled={safePage >= pageCount - 1}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <IssueVoucherDialog
        open={issueOpen}
        onOpenChange={setIssueOpen}
        unitId={unitId}
        organizationId={organizationId}
      />

      <AlertDialog open={!!confirmCancel} onOpenChange={(o) => !o && setConfirmCancel(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancelar voucher?</AlertDialogTitle>
            <AlertDialogDescription>
              O voucher <span className="font-mono font-semibold">{confirmCancel?.code}</span>{" "}
              ({confirmCancel?.discount_percent}% off) ficará indisponível pra uso. Essa ação não
              pode ser desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Voltar</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleCancel}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Cancelar voucher
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
