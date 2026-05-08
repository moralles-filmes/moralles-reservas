import { useState } from "react";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import {
  useFindVoucherByCode,
  useRedeemVoucher,
  useCancelVoucher,
  type VoucherWithCustomer,
  TRIGGER_LABEL,
} from "@/hooks/useVouchers";
import { VoucherStatusBadge } from "@/components/giftback/VoucherStatusBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Gift, Search, CheckCircle2, XCircle, AlertCircle } from "lucide-react";
import { formatPhone } from "@/lib/utils";
import { toast } from "sonner";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function daysUntil(iso: string): number {
  const ms = new Date(iso).getTime() - Date.now();
  return Math.ceil(ms / (1000 * 60 * 60 * 24));
}

export default function GiftbackOperacional() {
  const unit = useCurrentUnit();
  const unitId = unit?.unit_id ?? "";

  const find = useFindVoucherByCode(unitId);
  const redeem = useRedeemVoucher(unitId);
  const cancel = useCancelVoucher(unitId);

  const [code, setCode] = useState("");
  const [voucher, setVoucher] = useState<VoucherWithCustomer | null>(null);
  const [notFound, setNotFound] = useState(false);

  const handleSearch = async () => {
    if (!code.trim()) return;
    setNotFound(false);
    setVoucher(null);
    try {
      const result = await find.mutateAsync(code);
      if (!result) {
        setNotFound(true);
      } else {
        setVoucher(result);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao buscar voucher");
    }
  };

  const handleRedeem = async () => {
    if (!voucher) return;
    try {
      await redeem.mutateAsync({ id: voucher.id });
      toast.success(`Voucher ${voucher.code} aplicado!`);
      setVoucher(null);
      setCode("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao aplicar voucher");
    }
  };

  const handleCancel = async () => {
    if (!voucher) return;
    try {
      await cancel.mutateAsync(voucher.id);
      toast.success("Voucher cancelado");
      setVoucher(null);
      setCode("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao cancelar");
    }
  };

  const reset = () => {
    setVoucher(null);
    setNotFound(false);
    setCode("");
  };

  const daysLeft = voucher ? daysUntil(voucher.expires_at) : 0;

  return (
    <div className="space-y-5 max-w-xl mx-auto">
      <header>
        <div className="flex items-center gap-2">
          <Gift className="h-5 w-5 text-rose-500" />
          <h1 className="text-2xl font-bold">Validar voucher</h1>
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          Digite o código do voucher do cliente pra validar e aplicar o desconto.
        </p>
      </header>

      <Card>
        <CardContent className="p-4 space-y-3">
          <Label htmlFor="voucher-code">Código do voucher</Label>
          <div className="flex gap-2">
            <Input
              id="voucher-code"
              placeholder="Ex.: ABC12345"
              value={code}
              onChange={(e) => {
                setCode(e.target.value.toUpperCase());
                setNotFound(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSearch();
              }}
              className="font-mono uppercase tracking-wider text-lg h-12"
              autoFocus
            />
            <Button
              onClick={handleSearch}
              disabled={!code.trim() || find.isPending}
              size="lg"
              className="gap-1.5"
            >
              <Search className="h-4 w-4" />
              {find.isPending ? "Buscando…" : "Validar"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {notFound && (
        <Card className="border-destructive">
          <CardContent className="py-4 flex items-center gap-3">
            <XCircle className="h-5 w-5 text-destructive shrink-0" />
            <div>
              <p className="text-sm font-medium">Voucher não encontrado ou já consumido</p>
              <p className="text-xs text-muted-foreground">
                Verifique se o código está correto e se ele ainda está ativo nessa unidade.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {voucher && (
        <Card className="border-emerald-300">
          <CardContent className="p-5 space-y-4">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                  <h2 className="font-semibold text-lg">Voucher válido</h2>
                </div>
                <p className="font-mono text-2xl font-bold tracking-wider">{voucher.code}</p>
              </div>
              <VoucherStatusBadge status={voucher.status} />
            </div>

            <div className="rounded-md bg-rose-50 border border-rose-200 p-4 text-center">
              <p className="text-xs uppercase tracking-wider text-rose-700">Desconto</p>
              <p className="text-4xl font-bold text-rose-600">{voucher.discount_percent}%</p>
            </div>

            <div className="space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Cliente</span>
                <span className="font-medium">{voucher.customer?.name || "—"}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Telefone</span>
                <span>
                  {voucher.customer?.phone ? formatPhone(voucher.customer.phone) : "—"}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Origem</span>
                <span>{voucher.rule ? TRIGGER_LABEL[voucher.rule.trigger_type] : "Manual avulso"}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Validade</span>
                <span className="font-medium">
                  {formatDate(voucher.expires_at)}
                  <span className="text-xs text-muted-foreground ml-1">
                    ({daysLeft > 0 ? `${daysLeft} dias` : "expira hoje"})
                  </span>
                </span>
              </div>
            </div>

            {daysLeft <= 3 && daysLeft > 0 && (
              <div className="rounded-md bg-amber-50 border border-amber-200 p-2 flex items-center gap-2 text-xs text-amber-800">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                Voucher expira em breve.
              </div>
            )}

            <div className="flex gap-2 pt-1">
              <Button variant="outline" onClick={reset} disabled={redeem.isPending}>
                Voltar
              </Button>
              <Button
                variant="ghost"
                onClick={handleCancel}
                disabled={cancel.isPending || redeem.isPending}
                className="text-destructive hover:text-destructive"
              >
                Cancelar voucher
              </Button>
              <Button
                onClick={handleRedeem}
                disabled={redeem.isPending}
                className="ml-auto gap-1.5"
              >
                <CheckCircle2 className="h-4 w-4" />
                {redeem.isPending ? "Aplicando…" : "Marcar como usado"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
