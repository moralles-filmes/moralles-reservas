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
import {
  formatCentsBRL,
  parsePlanFeatures,
  BILLING_PROVIDER_LABEL,
  PLAN_BILLING_TYPE_LABEL,
  PLAN_CATEGORY_LABEL,
  PLAN_CATEGORY_VARIANT,
  type BillingPlan,
  type BillingProviderName,
  type PlanBillingType,
  type PlanCategory,
} from "@/types/billing";
import {
  isAiCreditPackage,
  planBillingType,
  planCategory,
  planIntervalLabel,
  planProvider,
  showsStripeConfig,
} from "@/lib/billing-plan-display";
import { slugify } from "@/lib/utils";

const CATEGORY_OPTIONS = Object.keys(PLAN_CATEGORY_LABEL) as PlanCategory[];
const PROVIDER_OPTIONS = Object.keys(BILLING_PROVIDER_LABEL) as BillingProviderName[];
const BILLING_TYPE_OPTIONS = Object.keys(PLAN_BILLING_TYPE_LABEL) as PlanBillingType[];

interface PlanFormState {
  name: string;
  slug: string;
  description: string;
  amount_brl: string;
  interval: "month" | "year";
  category: PlanCategory;
  provider: BillingProviderName;
  billing_type: PlanBillingType;
  amount_credited_brl: string;
  recommended: boolean;
  requires_plan_id: string;
  provider_metadata: string; // JSON cru (textarea)
  stripe_price_id_card: string;
  stripe_price_id_boleto: string;
  stripe_price_id_pix: string;
  trial_days: string;
  is_trial: boolean;
  features: string;  // 1 feature por linha (textarea)
  max_units: string;
  max_members_per_unit: string;
  sort_order: string;
}

// Sentinela do Select de pré-requisito: Radix Select não aceita value="" num
// SelectItem (string vazia é reservada pro estado "sem seleção").
const NO_PREREQUISITE = "__none__";

const EMPTY_FORM: PlanFormState = {
  name: "",
  slug: "",
  description: "",
  amount_brl: "",
  interval: "month",
  category: "SYSTEM_SUBSCRIPTION",
  // Plano novo nasce Asaas: é o provedor pra onde a plataforma está migrando
  // (a coluna tem default 'stripe' só pra não reclassificar linha legada).
  provider: "asaas",
  billing_type: "recurring",
  amount_credited_brl: "",
  recommended: false,
  requires_plan_id: NO_PREREQUISITE,
  provider_metadata: "",
  stripe_price_id_card: "",
  stripe_price_id_boleto: "",
  stripe_price_id_pix: "",
  trial_days: "0",
  is_trial: false,
  features: "",
  max_units: "",
  max_members_per_unit: "",
  sort_order: "0",
};

function centsToBRLInput(cents: number | null | undefined): string {
  if (cents == null) return "";
  return (cents / 100).toFixed(2).replace(".", ",");
}

function planToForm(plan: BillingPlan): PlanFormState {
  return {
    name: plan.name,
    slug: plan.slug,
    description: plan.description ?? "",
    amount_brl: centsToBRLInput(plan.amount_cents),
    interval: plan.interval,
    category: planCategory(plan),
    provider: planProvider(plan),
    billing_type: planBillingType(plan),
    amount_credited_brl: centsToBRLInput(plan.amount_credited_cents),
    recommended: plan.recommended === true,
    requires_plan_id: plan.requires_plan_id ?? NO_PREREQUISITE,
    provider_metadata:
      plan.provider_metadata && Object.keys(plan.provider_metadata).length > 0
        ? JSON.stringify(plan.provider_metadata, null, 2)
        : "",
    stripe_price_id_card: plan.stripe_price_id_card ?? "",
    stripe_price_id_boleto: plan.stripe_price_id_boleto ?? "",
    stripe_price_id_pix: plan.stripe_price_id_pix ?? "",
    trial_days: (plan.trial_days ?? 0).toString(),
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

    // Valor creditado só existe em pacote de IA — nas outras categorias vai
    // null, senão um valor digitado e depois "escondido" pela troca de
    // categoria continuaria gravado e creditaria saldo na Fase 7.
    let amountCreditedCents: number | null = null;
    if (isAiCreditPackage(form)) {
      if (!form.amount_credited_brl.trim()) {
        toast.error("Informe o valor creditado do pacote de IA.");
        return;
      }
      amountCreditedCents = parseAmountBRL(form.amount_credited_brl);
      if (amountCreditedCents == null) {
        toast.error("Valor creditado inválido. Use formato 70,00.");
        return;
      }
    }

    // Metadados do provedor: JSON de objeto. Validado aqui porque a EF só
    // devolveria um 500 genérico do Postgres.
    let providerMetadata: Record<string, unknown> = {};
    if (form.provider_metadata.trim()) {
      try {
        const parsed = JSON.parse(form.provider_metadata);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          toast.error("Metadados do provedor devem ser um objeto JSON.");
          return;
        }
        providerMetadata = parsed as Record<string, unknown>;
      } catch {
        toast.error("Metadados do provedor: JSON inválido.");
        return;
      }
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
      category: form.category,
      provider: form.provider,
      billing_type: form.billing_type,
      amount_credited_cents: amountCreditedCents,
      recommended: form.recommended,
      requires_plan_id:
        form.requires_plan_id === NO_PREREQUISITE ? null : form.requires_plan_id,
      provider_metadata: providerMetadata,
      // Price IDs são PRESERVADOS mesmo quando o provedor deixa de ser Stripe.
      // Zerá-los ao trocar pra Asaas destruiria, sem aviso e sem volta pela UI,
      // a configuração de um plano Stripe com assinantes vivos — e o
      // create-billing-checkout pararia de conseguir criar assinatura nele.
      // Ficam gravados e simplesmente não são lidos enquanto provider != stripe.
      stripe_price_id_card: form.stripe_price_id_card.trim() || null,
      stripe_price_id_boleto: form.stripe_price_id_boleto.trim() || null,
      stripe_price_id_pix: form.stripe_price_id_pix.trim() || null,
      trial_days: form.trial_days.trim() ? Math.max(0, Number(form.trial_days)) : 0,
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
      // manage-billing já traduz 23505 (slug duplicado E a UNIQUE PARCIAL do
      // trial), 23514 (CHECK de enum) e 23503 (pré-requisito inexistente) em
      // mensagem PT-BR. Antes essa tradução era tentada aqui por substring, mas
      // a EF nunca devolvia o código do Postgres — o toast amigável era morto.
      toast.error(err instanceof Error ? err.message : "Falha ao salvar plano.");
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
            Catálogo de produtos da plataforma — assinatura do sistema, WhatsApp e pacotes de IA.
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
                <TableHead className="hidden xl:table-cell">Slug</TableHead>
                <TableHead>Valor</TableHead>
                <TableHead className="hidden md:table-cell">Intervalo</TableHead>
                <TableHead className="hidden lg:table-cell">Categoria</TableHead>
                <TableHead className="hidden lg:table-cell">Provedor</TableHead>
                <TableHead className="hidden md:table-cell text-center">Empresas</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-10"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {plans.map((plan) => (
                <TableRow key={plan.id}>
                  <TableCell className="font-medium">
                    <div className="flex flex-wrap items-center gap-2">
                      {plan.name}
                      {plan.is_trial && (
                        <Badge variant="secondary" className="bg-warning/10 text-warning text-[10px] px-1.5 py-0">TRIAL</Badge>
                      )}
                      {plan.recommended && (
                        <Badge variant="secondary" className="bg-info/10 text-info text-[10px] px-1.5 py-0">RECOMENDADO</Badge>
                      )}
                    </div>
                    <span className="block xl:hidden text-xs text-muted-foreground font-mono">{plan.slug}</span>
                  </TableCell>
                  <TableCell className="hidden xl:table-cell text-xs text-muted-foreground font-mono">{plan.slug}</TableCell>
                  <TableCell>{formatCentsBRL(plan.amount_cents)}</TableCell>
                  <TableCell className="hidden md:table-cell text-sm">
                    {/* null = cobrança única; ver planIntervalLabel */}
                    {planIntervalLabel(plan) ?? (
                      <span className="text-muted-foreground">
                        {PLAN_BILLING_TYPE_LABEL.one_time}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    <Badge
                      variant="secondary"
                      className={`${PLAN_CATEGORY_VARIANT[planCategory(plan)]} text-[10px] px-1.5 py-0`}
                    >
                      {PLAN_CATEGORY_LABEL[planCategory(plan)]}
                    </Badge>
                  </TableCell>
                  <TableCell className="hidden lg:table-cell text-sm">
                    {BILLING_PROVIDER_LABEL[planProvider(plan)]}
                  </TableCell>
                  <TableCell className="hidden md:table-cell text-center text-sm">
                    {/* undefined = EF antiga deployada, sem a contagem. "—" ≠ 0. */}
                    {plan.active_subscriptions ?? "—"}
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
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
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
              <Label htmlFor="plan-category">Categoria</Label>
              <Select
                value={form.category}
                onValueChange={(value: PlanCategory) => setForm((prev) => ({ ...prev, category: value }))}
              >
                <SelectTrigger id="plan-category"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CATEGORY_OPTIONS.map((c) => (
                    <SelectItem key={c} value={c}>{PLAN_CATEGORY_LABEL[c]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Define onde o produto aparece pro cliente.
              </p>
            </div>

            <div className="space-y-1">
              <Label htmlFor="plan-provider">Provedor</Label>
              <Select
                value={form.provider}
                onValueChange={(value: BillingProviderName) => setForm((prev) => ({ ...prev, provider: value }))}
              >
                <SelectTrigger id="plan-provider"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PROVIDER_OPTIONS.map((p) => (
                    <SelectItem key={p} value={p}>{BILLING_PROVIDER_LABEL[p]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Quem cobra. Stripe é legado — plano novo usa Asaas.
              </p>
            </div>

            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="plan-billing-type">Tipo de cobrança</Label>
              <Select
                value={form.billing_type}
                onValueChange={(value: PlanBillingType) => setForm((prev) => ({ ...prev, billing_type: value }))}
              >
                <SelectTrigger id="plan-billing-type"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {BILLING_TYPE_OPTIONS.map((t) => (
                    <SelectItem key={t} value={t}>{PLAN_BILLING_TYPE_LABEL[t]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
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

            {/* Intervalo só existe em cobrança recorrente. Em one_time a coluna
                fica 'month' no banco por ser NOT NULL — ver migration 065. */}
            {form.billing_type === "recurring" ? (
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
            ) : (
              <div className="space-y-1">
                <Label>Intervalo de cobrança</Label>
                <p className="text-sm text-muted-foreground pt-2">
                  Não se aplica — cobrança única.
                </p>
              </div>
            )}

            {isAiCreditPackage(form) && (
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="plan-credited">Valor creditado (R$)</Label>
                <Input
                  id="plan-credited"
                  value={form.amount_credited_brl}
                  onChange={(e) => setForm((prev) => ({ ...prev, amount_credited_brl: e.target.value }))}
                  placeholder="70,00"
                  inputMode="decimal"
                />
                <p className="text-xs text-muted-foreground">
                  Saldo que cai na carteira de IA. Igual ao valor pago em pacote sem
                  bônus; maior que ele se o pacote der bônus.
                </p>
              </div>
            )}

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
                <Label htmlFor="plan-recommended" className="font-medium">Recomendado</Label>
                <p className="text-xs text-muted-foreground">
                  Destaca este produto pro cliente. Marque só um por categoria.
                </p>
              </div>
              <Switch
                id="plan-recommended"
                checked={form.recommended}
                onCheckedChange={(checked) => setForm((prev) => ({ ...prev, recommended: checked }))}
              />
            </div>

            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="plan-requires">Pré-requisito (opcional)</Label>
              <Select
                value={form.requires_plan_id}
                onValueChange={(value) => setForm((prev) => ({ ...prev, requires_plan_id: value }))}
              >
                <SelectTrigger id="plan-requires"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_PREREQUISITE}>Nenhum</SelectItem>
                  {/* Exclui o próprio plano: requires_plan_id é FK pra
                      billing_plans e auto-referência criaria dependência
                      circular que nenhum checkout resolve. */}
                  {(plans ?? [])
                    .filter((p) => p.id !== editingPlan?.id)
                    .map((p) => (
                      <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Produto que precisa estar pago antes deste. Ex.: a instância de
                WhatsApp exige a implantação.
              </p>
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

            <div className="sm:col-span-2 space-y-1">
              <Label htmlFor="plan-metadata">Metadados do provedor (opcional)</Label>
              <Textarea
                id="plan-metadata"
                value={form.provider_metadata}
                onChange={(e) => setForm((prev) => ({ ...prev, provider_metadata: e.target.value }))}
                placeholder={'{\n  "asaas_cycle": "MONTHLY"\n}'}
                rows={3}
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Objeto JSON com config específica do provedor. Vazio = <code>{"{}"}</code>.
              </p>
            </div>

            {/* Price IDs da Stripe: colapsados e só em plano Stripe. Plano Asaas
                não tem price_...; deixar os campos à vista convidaria a
                preencher o que nunca vai ser lido.

                Abre já expandido quando o plano em edição TEM price id: um
                plano Stripe vivo não pode abrir o modal com a config escondida
                atrás de um clique (parece que sumiu). Deriva de editingPlan,
                não do form, pra não reabrir sozinho a cada tecla. */}
            {showsStripeConfig(form) && (
              <details
                className="sm:col-span-2 border-t pt-4 mt-2 group"
                open={!!editingPlan?.stripe_price_id_card}
              >
                <summary className="cursor-pointer text-sm font-medium list-none [&::-webkit-details-marker]:hidden flex items-center gap-2">
                  <span className="text-muted-foreground transition-transform group-open:rotate-90">›</span>
                  Configuração do provedor (legado Stripe)
                </summary>
                <p className="text-xs text-muted-foreground mt-1 mb-3">
                  Cole os IDs <code>price_...</code> criados no Stripe. Pelo menos o de cartão é
                  obrigatório pra criar assinatura. Só se aplica a planos que ainda cobram pela Stripe.
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
                </div>
              </details>
            )}

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
