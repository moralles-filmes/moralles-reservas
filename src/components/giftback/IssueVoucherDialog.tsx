import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useIssueVoucher } from "@/hooks/useVouchers";
import { supabase } from "@/lib/supabase";
import { formatPhone } from "@/lib/utils";
import { Search, User } from "lucide-react";
import { toast } from "sonner";

interface IssueVoucherDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  unitId: string;
  organizationId: string;
}

interface CustomerLite {
  id: string;
  name: string;
  phone: string;
  email: string | null;
}

export function IssueVoucherDialog({ open, onOpenChange, unitId, organizationId }: IssueVoucherDialogProps) {
  const issue = useIssueVoucher(unitId);

  const [search, setSearch] = useState("");
  const [results, setResults] = useState<CustomerLite[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<CustomerLite | null>(null);
  const [discount, setDiscount] = useState(15);
  const [validity, setValidity] = useState(30);
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (!open) {
      setSearch("");
      setResults([]);
      setSelected(null);
      setDiscount(15);
      setValidity(30);
      setNotes("");
    }
  }, [open]);

  useEffect(() => {
    if (!search.trim() || !organizationId) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const term = search.trim();
    const handle = setTimeout(async () => {
      const onlyDigits = term.replace(/\D/g, "");
      const orFilter = onlyDigits.length >= 3
        ? `name.ilike.%${term}%,phone.ilike.%${onlyDigits}%`
        : `name.ilike.%${term}%`;
      const { data } = await supabase
        .from("customers")
        .select("id, name, phone, email")
        .eq("organization_id", organizationId)
        .or(orFilter)
        .limit(8);
      if (!cancelled) {
        setResults((data ?? []) as CustomerLite[]);
        setSearching(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [search, organizationId]);

  const submit = async () => {
    if (!selected) {
      toast.error("Selecione um cliente");
      return;
    }
    if (!Number.isInteger(discount) || discount < 1 || discount > 100) {
      toast.error("Desconto deve ser um inteiro entre 1% e 100%");
      return;
    }
    if (!Number.isInteger(validity) || validity < 1 || validity > 365) {
      toast.error("Validade deve ser um inteiro entre 1 e 365 dias");
      return;
    }
    try {
      const v = await issue.mutateAsync({
        customer_id: selected.id,
        discount_percent: discount,
        validity_days: validity,
        notes: notes.trim() || null,
      });
      toast.success(`Voucher ${v.code} emitido para ${selected.name}`);
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao emitir voucher");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Emitir voucher manual</DialogTitle>
          <DialogDescription>
            Crie um voucher pra um cliente específico. O código é gerado automaticamente.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {!selected ? (
            <div className="space-y-2">
              <Label>Buscar cliente</Label>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Nome ou telefone"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-8"
                  autoFocus
                />
              </div>
              {search.trim() && (
                <div className="border rounded-md max-h-60 overflow-auto divide-y">
                  {searching ? (
                    <div className="p-3 text-sm text-muted-foreground text-center">Buscando…</div>
                  ) : results.length === 0 ? (
                    <div className="p-3 text-sm text-muted-foreground text-center">
                      Nenhum cliente encontrado
                    </div>
                  ) : (
                    results.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => setSelected(c)}
                        className="w-full text-left p-3 hover:bg-muted/50 flex items-center gap-3"
                      >
                        <div className="p-1.5 rounded-full bg-muted">
                          <User className="h-3.5 w-3.5" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium truncate">{c.name}</p>
                          <p className="text-xs text-muted-foreground">{formatPhone(c.phone)}</p>
                        </div>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-md border p-3 flex items-center gap-3">
              <div className="p-2 rounded-full bg-muted">
                <User className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate">{selected.name}</p>
                <p className="text-xs text-muted-foreground">{formatPhone(selected.phone)}</p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>
                Trocar
              </Button>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="issue-discount">Desconto (%)</Label>
              <Input
                id="issue-discount"
                type="number"
                min={1}
                max={100}
                value={discount}
                onChange={(e) => setDiscount(parseInt(e.target.value, 10) || 1)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="issue-validity">Validade (dias)</Label>
              <Input
                id="issue-validity"
                type="number"
                min={1}
                value={validity}
                onChange={(e) => setValidity(parseInt(e.target.value, 10) || 1)}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="issue-notes">Observação interna (opcional)</Label>
            <Textarea
              id="issue-notes"
              placeholder="Ex.: Compensação por reserva atrasada"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={issue.isPending}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={!selected || issue.isPending}>
            {issue.isPending ? "Emitindo…" : "Emitir voucher"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
