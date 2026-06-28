import { useState } from "react";
import { Link } from "react-router-dom";
import {
  useBillingPlans,
  useCreatePlan,
  useUpdatePlan,
  useDeactivatePlan,
} from "@/hooks/useBilling";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { ArrowLeft, Plus, MoreHorizontal, Pencil, PowerOff } from "lucide-react";
import { formatCentsBRL, parsePlanFeatures, type BillingPlan } from "@/types/billing";
import { slugify } from "@/lib/utils";

interface PlanFormState {
  name: string;
  slug: string;
  description: string;
  amount_brl: string;
  interval: "month" | "year";
  stripe_price_id_card: string;
  stripe_price_id_boleto: string;
  stripe_price_id_pix: string;
  trial_days: string;
  popular: boolean;
  is_trial: boolean;
  features: string;  // 1 feature por linha (textarea)
  max_units: string;
  max_members_per_unit: string;
  sort_order: string;
}

const EMPTY_FORM: PlanFormState = {
  name: "",
  slug: "",
  description: "",
  amount_brl: "",
  interval: "month",
  stripe_price_id_card: "",
  stripe_price_id_boleto: "",
  stripe_price_id_pix: "",
  trial_days: "0",
  popular: false,
  is_trial: false,
  features: "",
  max_units: "",
  max_members_per_unit: "",
  sort_order: "0",
};

function planToForm(plan: BillingPlan): PlanFormState {
  return {
    name: plan.name,
    slug: plan.slug,
    description: plan.description ?? "",
    amount_brl: (plan.amount_cents / 100).toFixed(2).replace(".", ","),
    interval: plan.interval,
    stripe_price_id_card: plan.stripe_price_id_card ?? "",
    stripe_price_id_boleto: plan.stripe_price_id_boleto ?? "",
    stripe_price_id_pix: plan.stripe_price_id_pix ?? "",
    trial_days: (plan.trial_days ?? 0).toString(),
    popular: plan.popular === true,
    is_trial: plan.is_trial === true,
    features: parsePlanFeatures(plan.features).join("\n"),
    max_units: plan.max_units?.toString() ?? "",
    max_members_per_unit: plan.max_members_per_unit?.toString() ?? "",
    sort_order: plan.sort_order.toString(),
  };
}

function parseAmountBRL(input: string): number | null {
  const normalized = input.replace(/\./g, "").replace(",", ".").trim();
  if (!normalized) return null;
  const value = Number(normalized);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

export default function BillingPlans() {
  const { data: plans, isLoading, isError, refetch } = useBillingPlans();
  const createMutation = useCreatePlan();
  const updateMutation = useUpdatePlan();
  const deactivateMutation = useDeactivatePlan();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingPlan, setEditingPlan] = useState<BillingPlan | null>(null);
  const [form, setForm] = useState<PlanFormState>(EMPTY_FORM);
  const [slugTouched, setSlugTouched] = useState(false);
  const [deactivateTarget, setDeactivateTarget] = useState<BillingPlan | null>(null);

  function openCreate() {
    setEditingPlan(null);
    setForm(EMPTY_FORM);
    setSlugTouched(false);
    setDialogOpen(true);
  }

  function openEdit(plan: BillingPlan) {
    setEditingPlan(plan);
    setForm(planToForm(plan));
    setSlugTouched(true);
    setDialogOpen(true);
  }

  function handleNameChange(value: string) {
    setForm((prev) => ({
      ...prev,
      name: value,
      slug: slugTouched ? prev.slug : slugify(value),
    }));
  }

  function handleSlugChange(value: string) {
    setSlugTouched(true);
    setForm((prev) => ({ ...prev, slug: value }));
  }

  async function handleSubmit() {
    if (!form.name.trim()) {
      toast.error("Informe o nome do plano.");
      return;
    }
    if (!form.slug.trim()) {
      toast.error("Informe o slug do plano.");
      return;
    }
    const amountCents = parseAmountBRL(form.amount_brl);
    if (amountCents == null) {
      toast.error("Valor inválido. Use formato 99,90.");
      return;
    }

    // Parse features textarea → array de strings (trim + dropa vazios)
    const featuresArray = form.features
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const payload: Record<string, unknown> = {
      name: form.name.trim(),
      slug: form.slug.trim(),
      description: form.description.trim() || null,
      amount_cents: amountCents,
      interval: form.interval,
      stripe_price_id_card: form.stripe_price_id_card.trim() || null,
      stripe_price_id_boleto: form.stripe_price_id_boleto.trim() || null,
      stripe_price_id_pix: form.stripe_price_id_pix.trim() || null,
      trial_days: form.trial_days.trim() ? Math.max(0, Number(form.trial_days)) : 0,
      popular: form.popular,
      is_trial: form.is_trial,
      features: featuresArray,
      max_units: form.max_units.trim() ? Number(form.max_units) : null,
      max_members_per_unit: form.max_members_per_unit.trim() ? Number(form.max_members_per_unit) : null,
      sort_order: form.sort_order.trim() ? Number(form.sort_order) : 0,
    };

    try {
      if (editingPlan) {
        await updateMutation.mutateAsync({ plan_id: editingPlan.id, ...payload });
        toast.success("Plano atualizado.");
      } else {
        await createMutation.mutateAsync(payload);
        toast.success("Plano criado.");
      }
      setDialogOpen(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Falha ao salvar plano.";
      // UNIQUE PARTIAL billing_plans_only_one_active_trial — usuário ativou
      // is_trial mas já existe outro ativo. Backend devolve a mensagem do
      // Postgres; aqui traduzimos pra texto amigável.
      const isUniqueViolation =
        msg.includes("23505") ||
        msg.toLowerCase().includes("only_one_active_trial") ||
        msg.toLowerCase().includes("duplicate key");
      if (form.is_trial && isUniqueViolation) {
        toast.error("Já existe outro plano de trial ativo. Desative o anterior antes de marcar este como trial.");
      } else {
        toast.error(msg);
      }
    }
  }

  async function handleDeactivate(plan: BillingPlan) {
    try {
      await deactivateMutation.mutateAsync(plan.id);
      toast.success("Plano desativado.");
      setDeactivateTarget(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao desativar plano.");
    }
  }

  async function handleReactivate(plan: BillingPlan) {
    try {
      await updateMutation.mutateAsync({ plan_id: plan.id, active: true });
      toast.success("Plano reativado.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao reativar plano.");
    }
  }

  const submitting = createMutation.isPending || updateMutation.isPending;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link to="/platform/billing">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="flex-1">
          <h1 className="text-2xl font-bold">Planos</h1>
          <p className="text-muted-foreground text-sm">
            Catálogo de planos da plataforma. Cada plano referencia um <code className="text-xs">price_id</code> do Stripe.
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="mr-2 h-4 w-4" /> Novo plano
        </Button>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
      ) : isError ? (
        <Card>
          <CardContent className="py-10 text-center">
            <p className="text-destructive mb-2">Erro ao carregar planos.</p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>Tentar novamente</Button>
          </CardContent>
        </Card>
      ) : !plans?.length ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            <p className="mb-3">Nenhum plano cadastrado ainda.</p>
            <Button variant="outline" size="sm" onClick={openCreate}>
              <Plus className="mr-2 h-4 w-4" /> Criar primeiro plano
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nome</TableHead>
                <TableHead>Slug</TableHead>
                <TableHead>Valor</TableHead>
                <TableHead className="hidden md:table-cell">Intervalo</TableHead>
                <TableHead className="hidden lg:table-cell">Stripe price (cartão)</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-10"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {plans.map((plan) => (
                <TableRow key={plan.id}>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      {plan.name}
                      {plan.is_trial && (
                        <Badge variant="secondary" className="bg-warning/10 text-warning text-[10px] px-1.5 py-0">TRIAL</Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground font-mono">{plan.slug}</TableCell>
                  <TableCell>{formatCentsBRL(plan.amount_cents)}</TableCell>
                  <TableCell className="hidden md:table-cell">
                    {plan.interval === "month" ? "Mensal" : "Anual"}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell text-xs font-mono text-muted-foreground">
                    {plan.stripe_price_id_card ?? "—"}
                  </TableCell>
                  <TableCell>
                    {plan.active ? (
                      <Badge variant="secondary" className="bg-success/10 text-success">Ativo</Badge>
                    ) : (
                      <Badge variant="secondary" className="bg-muted text-muted-foreground">Inativo</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => openEdit(plan)}>
                          <Pencil className="mr-2 h-4 w-4" /> Editar
                        </DropdownMenuItem>
                        {plan.active ? (
                          <DropdownMenuItem
                            onClick={() => setDeactivateTarget(plan)}
                            className="text-destructive"
                          >
                            <PowerOff className="mr-2 h-4 w-4" /> Desativar
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem onClick={() => handleReactivate(plan)}>
                            <PowerOff className="mr-2 h-4 w-4" /> Reativar
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Create/Edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editingPlan ? "Editar plano" : "Novo plano"}</DialogTitle>
          </DialogHeader>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="plan-name">Nome</Label>
              <Input
                id="plan-name"
                value={form.name}
                onChange={(e) => handleNameChange(e.target.value)}
                placeholder="Ex.: Plano Profissional Mensal"
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="plan-slug">Slug</Label>
              <Input
                id="plan-slug"
                value={form.slug}
                onChange={(e) => handleSlugChange(e.target.value)}
                placeholder="profissional-mensal"
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">Identificador único. Não muda após criar.</p>
            </div>

            <div className="space-y-1">
              <Label htmlFor="plan-amount">Valor (R$)</Label>
              <Input
                id="plan-amount"
                value={form.amount_brl}
                onChange={(e) => setForm((prev) => ({ ...prev, amount_brl: e.target.value }))}
                placeholder="99,90"
                inputMode="decimal"
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="plan-interval">Intervalo de cobrança</Label>
              <Select
                value={form.interval}
                onValueChange={(value: "month" | "year") => setForm((prev) => ({ ...prev, interval: value }))}
              >
                <SelectTrigger id="plan-interval"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="month">Mensal</SelectItem>
                  <SelectItem value="year">Anual</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label htmlFor="plan-trial">Dias de trial</Label>
              <Input
                id="plan-trial"
                type="number"
                min="0"
                value={form.trial_days}
                onChange={(e) => setForm((prev) => ({ ...prev, trial_days: e.target.value }))}
                placeholder="0"
              />
              <p className="text-xs text-muted-foreground">0 = cobra imediato.</p>
            </div>

            <div className="space-y-1">
              <Label htmlFor="plan-sort">Ordem de exibição</Label>
              <Input
                id="plan-sort"
                type="number"
                value={form.sort_order}
                onChange={(e) => setForm((prev) => ({ ...prev, sort_order: e.target.value }))}
              />
            </div>

            <div className="sm:col-span-2 space-y-1">
              <Label htmlFor="plan-description">Descrição curta</Label>
              <Input
                id="plan-description"
                value={form.description}
                onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
                placeholder="Ex.: Ideal pra restaurantes com até 3 salões"
                maxLength={120}
              />
              <p className="text-xs text-muted-foreground">Aparece logo abaixo do nome do plano na pricing table pública.</p>
            </div>

            <div className="sm:col-span-2 flex items-center justify-between rounded-md border p-3">
              <div>
                <Label htmlFor="plan-popular" className="font-medium">Plano popular</Label>
                <p className="text-xs text-muted-foreground">Destaca este plano na pricing table pública.</p>
              </div>
              <Switch
                id="plan-popular"
                checked={form.popular}
                onCheckedChange={(checked) => setForm((prev) => ({ ...prev, popular: checked }))}
              />
            </div>

            <div className="sm:col-span-2 flex items-center justify-between rounded-md border border-warning/20 bg-warning/10 p-3">
              <div>
                <Label htmlFor="plan-is-trial" className="font-medium">Plano de trial automático</Label>
                <p className="text-xs text-muted-foreground">
                  Aplicado automaticamente a toda nova empresa criada. Apenas 1 plano de trial pode estar ativo por vez.
                  Não aparece na lista de planos pra escolha do cliente.
                </p>
              </div>
              <Switch
                id="plan-is-trial"
                checked={form.is_trial}
                onCheckedChange={(checked) => setForm((prev) => ({ ...prev, is_trial: checked }))}
              />
            </div>

            <div className="sm:col-span-2 space-y-1">
              <Label htmlFor="plan-features">Features (uma por linha)</Label>
              <Textarea
                id="plan-features"
                value={form.features}
                onChange={(e) => setForm((prev) => ({ ...prev, features: e.target.value }))}
                placeholder={"Reservas ilimitadas\nAgente IA WhatsApp\nMulti-unidade\nRelatórios completos"}
                rows={5}
              />
              <p className="text-xs text-muted-foreground">Cada linha vira um bullet com check verde no card público.</p>
            </div>

            <div className="sm:col-span-2 border-t pt-4 mt-2">
              <p className="text-sm font-medium mb-1">Stripe Price IDs</p>
              <p className="text-xs text-muted-foreground mb-3">
                Cole os IDs <code>price_...</code> criados no Stripe. Pelo menos o de cartão é obrigatório
                pra criar assinatura.
              </p>
            </div>

            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="plan-price-card">Cartão</Label>
              <Input
                id="plan-price-card"
                value={form.stripe_price_id_card}
                onChange={(e) => setForm((prev) => ({ ...prev, stripe_price_id_card: e.target.value }))}
                placeholder="price_..."
                className="font-mono text-sm"
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="plan-price-boleto">Boleto (opcional)</Label>
              <Input
                id="plan-price-boleto"
                value={form.stripe_price_id_boleto}
                onChange={(e) => setForm((prev) => ({ ...prev, stripe_price_id_boleto: e.target.value }))}
                placeholder="price_..."
                className="font-mono text-sm"
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="plan-price-pix">PIX (opcional)</Label>
              <Input
                id="plan-price-pix"
                value={form.stripe_price_id_pix}
                onChange={(e) => setForm((prev) => ({ ...prev, stripe_price_id_pix: e.target.value }))}
                placeholder="price_..."
                className="font-mono text-sm"
              />
            </div>

            <div className="sm:col-span-2 border-t pt-4 mt-2">
              <p className="text-sm font-medium mb-1">Limites do plano (opcional)</p>
              <p className="text-xs text-muted-foreground mb-3">Vazio = sem limite.</p>
            </div>

            <div className="space-y-1">
              <Label htmlFor="plan-max-units">Máx. de unidades</Label>
              <Input
                id="plan-max-units"
                type="number"
                min="0"
                value={form.max_units}
                onChange={(e) => setForm((prev) => ({ ...prev, max_units: e.target.value }))}
                placeholder="Sem limite"
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="plan-max-members">Máx. de membros / unidade</Label>
              <Input
                id="plan-max-members"
                type="number"
                min="0"
                value={form.max_members_per_unit}
                onChange={(e) => setForm((prev) => ({ ...prev, max_members_per_unit: e.target.value }))}
                placeholder="Sem limite"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={submitting}>
              Cancelar
            </Button>
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting ? "Salvando..." : editingPlan ? "Salvar alterações" : "Criar plano"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Deactivate confirmation */}
      <AlertDialog open={!!deactivateTarget} onOpenChange={(open) => !open && setDeactivateTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Desativar {deactivateTarget?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              O plano deixa de aparecer no formulário de criação de assinatura. Assinaturas existentes
              não são afetadas — continuam cobrando normalmente.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deactivateMutation.isPending}
              onClick={() => deactivateTarget && handleDeactivate(deactivateTarget)}
            >
              {deactivateMutation.isPending ? "Desativando..." : "Desativar"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
