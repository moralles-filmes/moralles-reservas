import { useState } from "react";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import {
  useVoucherRules,
  useUpdateVoucherRule,
  useDeleteVoucherRule,
  TRIGGER_LABEL,
  type VoucherRule,
} from "@/hooks/useVouchers";
import { VoucherRuleDialog } from "@/components/giftback/VoucherRuleDialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Gift, MoreHorizontal, Plus, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";

export default function Regras() {
  const unit = useCurrentUnit();
  const unitId = unit?.unit_id ?? "";

  const { data: rules, isLoading } = useVoucherRules(unitId);
  const updateRule = useUpdateVoucherRule(unitId);
  const deleteRule = useDeleteVoucherRule(unitId);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<VoucherRule | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<VoucherRule | null>(null);

  const handleEdit = (rule: VoucherRule) => {
    setEditing(rule);
    setDialogOpen(true);
  };

  const handleNew = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  const toggleActive = async (rule: VoucherRule) => {
    try {
      await updateRule.mutateAsync({ id: rule.id, active: !rule.active });
      toast.success(rule.active ? "Regra desativada" : "Regra ativada");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao atualizar");
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    try {
      await deleteRule.mutateAsync(confirmDelete.id);
      toast.success("Regra removida");
      setConfirmDelete(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao remover");
    }
  };

  return (
    <div className="space-y-5">
      <header className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Gift className="h-5 w-5 text-gold" />
            <h1 className="text-2xl font-bold">Regras de Giftback</h1>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Configure quando o cliente recebe vouchers automaticamente.
          </p>
        </div>
        <Button onClick={handleNew} className="gap-1.5">
          <Plus className="h-4 w-4" />
          Nova regra
        </Button>
      </header>

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      ) : !rules?.length ? (
        <Card>
          <CardContent className="py-16 text-center text-muted-foreground space-y-3">
            <Gift className="h-8 w-8 mx-auto opacity-30" />
            <div>
              <p className="text-sm font-medium text-foreground">Nenhuma regra configurada</p>
              <p className="text-xs">
                Crie sua primeira regra pra começar a emitir vouchers automaticamente.
              </p>
            </div>
            <Button onClick={handleNew} variant="outline" className="gap-1.5">
              <Plus className="h-4 w-4" />
              Criar primeira regra
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {rules.map((rule) => (
            <Card key={rule.id}>
              <CardContent className="py-4 flex items-center gap-4 flex-wrap">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-semibold text-sm truncate">{rule.name}</h3>
                    <span className="text-[11px] uppercase tracking-wider text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                      {TRIGGER_LABEL[rule.trigger_type]}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {rule.discount_percent}% de desconto • Validade {rule.validity_days} dias
                    {rule.trigger_type === "after_rating" && rule.min_rating && (
                      <> • Mínimo {rule.min_rating}★</>
                    )}
                    {rule.trigger_type === "frequency" && rule.visits_required && rule.days_window && (
                      <> • {rule.visits_required} visitas em {rule.days_window} dias</>
                    )}
                  </p>
                </div>
                <Switch
                  checked={rule.active}
                  onCheckedChange={() => toggleActive(rule)}
                />
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-8 w-8">
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => handleEdit(rule)}>
                      <Pencil className="h-3.5 w-3.5 mr-2" />
                      Editar
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => setConfirmDelete(rule)}
                      className="text-destructive focus:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5 mr-2" />
                      Remover
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <VoucherRuleDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        unitId={unitId}
        rule={editing}
      />

      <AlertDialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover regra?</AlertDialogTitle>
            <AlertDialogDescription>
              "{confirmDelete?.name}" será removida. Vouchers já emitidos por essa regra
              continuam válidos.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Remover
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
