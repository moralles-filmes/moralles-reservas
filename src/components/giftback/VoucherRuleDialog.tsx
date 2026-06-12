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
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  TRIGGER_LABEL,
  TRIGGER_DESCRIPTION,
  type VoucherRule,
  type VoucherRuleInput,
  type VoucherTrigger,
  useCreateVoucherRule,
  useUpdateVoucherRule,
} from "@/hooks/useVouchers";
import { toast } from "sonner";

interface VoucherRuleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  unitId: string;
  rule?: VoucherRule | null;
}

// "manual" não aparece no select porque IssueVoucherDialog nunca passa rule_id
// — emissão manual sempre cria voucher avulso. Mantemos o tipo no TRIGGER_LABEL
// pra renderizar registros legados que tenham trigger_type='manual'.
const TRIGGERS: VoucherTrigger[] = ["after_rating", "birthday", "frequency"];

export function VoucherRuleDialog({ open, onOpenChange, unitId, rule }: VoucherRuleDialogProps) {
  const isEdit = !!rule;
  const create = useCreateVoucherRule(unitId);
  const update = useUpdateVoucherRule(unitId);

  const [name, setName] = useState("");
  const [trigger, setTrigger] = useState<VoucherTrigger>("after_rating");
  const [discount, setDiscount] = useState(15);
  const [validity, setValidity] = useState(30);
  const [active, setActive] = useState(true);
  const [minRating, setMinRating] = useState(4);
  const [visitsRequired, setVisitsRequired] = useState(3);
  const [daysWindow, setDaysWindow] = useState(60);

  useEffect(() => {
    if (rule) {
      setName(rule.name);
      setTrigger(rule.trigger_type);
      setDiscount(rule.discount_percent);
      setValidity(rule.validity_days);
      setActive(rule.active);
      setMinRating(rule.min_rating ?? 4);
      setVisitsRequired(rule.visits_required ?? 3);
      setDaysWindow(rule.days_window ?? 60);
    } else if (open) {
      setName("");
      setTrigger("after_rating");
      setDiscount(15);
      setValidity(30);
      setActive(true);
      setMinRating(4);
      setVisitsRequired(3);
      setDaysWindow(60);
    }
  }, [rule, open]);

  const submit = async () => {
    if (!name.trim()) {
      toast.error("Dê um nome para a regra");
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
    if (trigger === "after_rating") {
      if (!Number.isInteger(minRating) || minRating < 1 || minRating > 5) {
        toast.error("Nota mínima deve ser um inteiro entre 1 e 5");
        return;
      }
    }
    if (trigger === "frequency") {
      if (!Number.isInteger(visitsRequired) || visitsRequired < 1 || visitsRequired > 100) {
        toast.error("Visitas mínimas deve ser um inteiro entre 1 e 100");
        return;
      }
      if (!Number.isInteger(daysWindow) || daysWindow < 1 || daysWindow > 365) {
        toast.error("Janela em dias deve ser um inteiro entre 1 e 365");
        return;
      }
    }

    const payload: VoucherRuleInput = {
      name: name.trim(),
      trigger_type: trigger,
      discount_percent: discount,
      validity_days: validity,
      active,
      min_rating: trigger === "after_rating" ? minRating : null,
      visits_required: trigger === "frequency" ? visitsRequired : null,
      days_window: trigger === "frequency" ? daysWindow : null,
    };

    try {
      if (isEdit && rule) {
        await update.mutateAsync({ id: rule.id, ...payload });
        toast.success("Regra atualizada");
      } else {
        await create.mutateAsync(payload);
        toast.success("Regra criada");
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao salvar");
    }
  };

  const submitting = create.isPending || update.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Editar regra" : "Nova regra de Giftback"}</DialogTitle>
          <DialogDescription>
            Defina quando e como o cliente recebe o voucher.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="rule-name">Nome da regra</Label>
            <Input
              id="rule-name"
              placeholder="Ex.: Voucher de fidelidade pós-pesquisa"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="rule-trigger">Gatilho</Label>
            <Select value={trigger} onValueChange={(v) => setTrigger(v as VoucherTrigger)}>
              <SelectTrigger id="rule-trigger">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TRIGGERS.map((t) => (
                  <SelectItem key={t} value={t}>
                    {TRIGGER_LABEL[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{TRIGGER_DESCRIPTION[trigger]}</p>
          </div>

          {trigger === "after_rating" && (
            <div className="space-y-1.5">
              <Label htmlFor="rule-min-rating">Nota mínima para emitir</Label>
              <Input
                id="rule-min-rating"
                type="number"
                min={1}
                max={5}
                value={minRating}
                onChange={(e) => setMinRating(parseInt(e.target.value, 10) || 1)}
              />
              <p className="text-xs text-muted-foreground">
                Voucher emitido apenas se a nota for ≥ {minRating}.
              </p>
            </div>
          )}

          {trigger === "frequency" && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="rule-visits">Visitas mínimas</Label>
                <Input
                  id="rule-visits"
                  type="number"
                  min={1}
                  value={visitsRequired}
                  onChange={(e) => setVisitsRequired(parseInt(e.target.value, 10) || 1)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rule-window">Em quantos dias</Label>
                <Input
                  id="rule-window"
                  type="number"
                  min={1}
                  value={daysWindow}
                  onChange={(e) => setDaysWindow(parseInt(e.target.value, 10) || 1)}
                />
              </div>
            </div>
          )}

          {trigger === "birthday" && (
            <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
              Requer o campo <code className="mx-1 px-1 bg-muted rounded">birthday</code>{" "}
              preenchido no cadastro do cliente. Verificado diariamente às 09:00 BRT.
            </div>
          )}

          {trigger === "frequency" && (
            <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
              Conta reservas <strong>confirmadas</strong> ou marcadas como{" "}
              <strong>no-show</strong> nessa unidade. Verificado diariamente às 09:00 BRT.
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="rule-discount">Desconto (%)</Label>
              <Input
                id="rule-discount"
                type="number"
                min={1}
                max={100}
                value={discount}
                onChange={(e) => setDiscount(parseInt(e.target.value, 10) || 1)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rule-validity">Validade (dias)</Label>
              <Input
                id="rule-validity"
                type="number"
                min={1}
                value={validity}
                onChange={(e) => setValidity(parseInt(e.target.value, 10) || 1)}
              />
            </div>
          </div>

          <div className="flex items-center justify-between rounded-md border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="rule-active" className="text-sm">Regra ativa</Label>
              <p className="text-xs text-muted-foreground">
                Enquanto ativa, o gatilho emite vouchers automaticamente.
              </p>
            </div>
            <Switch id="rule-active" checked={active} onCheckedChange={setActive} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={submitting}>
            {submitting ? "Salvando…" : isEdit ? "Salvar alterações" : "Criar regra"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
