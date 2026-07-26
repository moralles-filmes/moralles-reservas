import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import {
  useBillingPlans,
  useOrgBillingDetail,
  useCreateBillingCheckout,
  usePreviewPlanChange,
  useChangePlan,
  useCancelByOwner,
  useOrgEntitlements,
} from "@/hooks/useBilling";
import { usePaymentMethods } from "@/hooks/usePaymentMethods";
import { AutomacaoWhatsappCard } from "@/components/gestao/AutomacaoWhatsappCard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
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
import { CreditCard, CalendarClock, AlertTriangle } from "lucide-react";
import { PricingTable } from "@/components/PricingTable";
import {
  BILLING_STATUS_LABEL,
  BILLING_STATUS_VARIANT,
  formatCentsBRL,
  type BillingPlan,
  type BillingStatus,
} from "@/types/billing";
import { formatDateBR } from "@/lib/utils";

export default function Cobranca() {
  const current = useCurrentUnit();
  const organizationId = current?.organization_id;
  const [searchParams, setSearchParams] = useSearchParams();
  const qc = useQueryClient();

  const { data: detail, isLoading: loadingDetail, refetch: refetchDetail } = useOrgBillingDetail(organizationId);
  const { data: plans, isLoading: loadingPlans } = useBillingPlans();
  const { data: pmData, isLoading: loadingPms, refetch: refetchPms } = usePaymentMethods(organizationId);
  const {
    data: entitlements,
    isLoading: loadingEntitlements,
    isError: entitlementsError,
    refetch: refetchEntitlements,
  } = useOrgEntitlements(organizationId ?? null);

  const checkout = useCreateBillingCheckout();
  const previewMutation = usePreviewPlanChange();
  const changePlanMutation = useChangePlan();
  const cancelMutation = useCancelByOwner();

  const [previewState, setPreviewState] = useState<{
    plan: BillingPlan;
    amountDue: number;
    currency: string;
  } | null>(null);
  const [cancelDialog, setCancelDialog] = useState(false);

  // Pós-redirect do checkout: refetch até a assinatura aparecer.
  //
  // O webhook é quem ativa — a URL de retorno NÃO ativa nada (cenário 8). Por
  // isso a mensagem depende do estado REAL ter mudado, e não de o navegador ter
  // voltado com session=success. Com PIX a confirmação pode chegar depois desta
  // janela, e prometer "Bem-vindo!" nesse caso seria mentira.
  useEffect(() => {
    const session = searchParams.get("session");
    if (session !== "success" && session !== "cancel") return;

    const clearParams = () => {
      searchParams.delete("session");
      searchParams.delete("sid");
      setSearchParams(searchParams, { replace: true });
    };

    if (session === "cancel") {
      clearParams();
      toast.info("Checkout cancelado. Nenhuma cobrança foi feita.");
      return;
    }

    let attempts = 0;
    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      attempts++;
      // Além da assinatura do sistema, também refaz o status da automação de
      // WhatsApp — cobre o retorno de uma implantação paga por PIX, cuja
      // confirmação chega pelo webhook depois do redirect.
      const [detailResult] = await Promise.all([
        refetchDetail(),
        refetchPms(),
        qc.invalidateQueries({ queryKey: ["whatsapp-service-status", organizationId] }),
      ]);
      if (cancelled) return;

      const activeSub = detailResult.data?.subscriptions?.find((s) => s.status !== "canceled");
      if (activeSub) {
        clearParams();
        toast.success("Pagamento confirmado. Bem-vindo!");
        return;
      }
      if (attempts < 6) {
        setTimeout(tick, 2000);
        return;
      }
      clearParams();
      toast.info(
        "Recebemos seu pagamento e estamos confirmando com o banco. " +
          "Pode levar alguns minutos — você não precisa pagar de novo.",
      );
    };

    tick();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams.get("session")]);

  if (!current || loadingDetail || loadingPlans) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (!organizationId) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-muted-foreground">
          Não foi possível identificar a organização.
        </CardContent>
      </Card>
    );
  }

  const sub = detail?.subscriptions.find((s) => s.status !== "canceled") ?? null;
  const activePlan = detail?.active_plan ?? null;
  const billingStatus = detail?.organization.billing_status as BillingStatus | undefined;
  const isBlocked = billingStatus === "blocked" || billingStatus === "suspended" || billingStatus === "canceled";

  // Trial puramente local — org está em billing_status='trialing' MAS sem
  // subscription (não passou pelo Stripe ainda). Aplicado automaticamente
  // pelo manage-organizations na criação da org.
  const trialEndsAt = detail?.organization.trial_ends_at ?? null;
  const isLocalTrial = billingStatus === "trialing" && !sub && !!trialEndsAt;
  const trialDaysLeft = trialEndsAt
    ? Math.max(0, Math.ceil((new Date(trialEndsAt).getTime() - Date.now()) / 86400000))
    : null;

  const defaultPm = pmData?.payment_methods.find((pm) => pm.is_default) ?? pmData?.payment_methods[0] ?? null;

  const activePlans = (plans ?? []).filter((p) => p.active);

  // Cortesia (LIFETIME/PROMOTIONAL etc. concedida por admin). Mostrar preço a
  // quem tem acesso vitalício gratuito gera dúvida sobre estar sendo cobrado.
  const isCourtesy = entitlements?.system.source === "override" && entitlements.system.allowed;

  async function handleChoose(plan: BillingPlan) {
    try {
      await checkout.mutateAsync({
        organization_id: organizationId!,
        plan_id: plan.id,
        purpose: "subscription",
      });
      // Redirect acontece dentro do hook (window.location.href = url)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao iniciar checkout.");
    }
  }

  async function handleChangePlanPreview(plan: BillingPlan) {
    if (!sub) {
      // Sem sub ativa → trata como nova
      handleChoose(plan);
      return;
    }
    try {
      const preview = await previewMutation.mutateAsync({
        subscription_id: sub.id,
        new_plan_id: plan.id,
        organization_id: organizationId!,
      });
      setPreviewState({
        plan,
        amountDue: preview.amount_due,
        currency: preview.currency,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao calcular preview.");
    }
  }

  async function confirmChangePlan() {
    if (!previewState || !sub) return;
    try {
      await changePlanMutation.mutateAsync({
        subscription_id: sub.id,
        new_plan_id: previewState.plan.id,
        organization_id: organizationId!,
      });
      toast.success("Plano atualizado.");
      setPreviewState(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao trocar plano.");
    }
  }

  async function handleCancel() {
    if (!sub) return;
    try {
      await cancelMutation.mutateAsync({
        subscription_id: sub.id,
        organization_id: organizationId!,
      });
      toast.success("Assinatura agendada para cancelamento no fim do período.");
      setCancelDialog(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao cancelar.");
    }
  }

  async function handleChangeCard() {
    try {
      await checkout.mutateAsync({
        organization_id: organizationId!,
        purpose: "payment_method_update",
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao abrir checkout.");
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Meu plano e cobrança</h1>
        <p className="text-muted-foreground text-sm">
          Gerencie sua assinatura, troque o cartão e veja os planos disponíveis.
        </p>
      </div>

      {isBlocked && (
        <Card className="border-warning/20 bg-warning/10">
          <CardContent className="py-4 flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-warning shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-medium text-warning">
                Sua conta está com status: {BILLING_STATUS_LABEL[billingStatus!] ?? billingStatus}
              </p>
              <p className="text-warning">
                Escolha um plano abaixo para reativar o acesso ao sistema.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Período de teste local (sem subscription) */}
      {isLocalTrial && (
        <Card className="border-info/20 bg-info/10">
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">Período de teste</CardTitle>
            <Badge variant="secondary" className="bg-info/10 text-info">Trial</Badge>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-sm">
              Você está testando a plataforma. Aproveite pra explorar tudo —
              quando estiver pronto, escolha um plano abaixo pra continuar sem
              interrupção.
            </p>
            <div className="flex items-center gap-2 text-sm">
              <CalendarClock className="h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground">Trial acaba em:</span>
              <span className="font-medium">
                {trialDaysLeft === 0
                  ? "hoje"
                  : trialDaysLeft === 1
                    ? "1 dia"
                    : `${trialDaysLeft} dias`}
                {" "}({formatDateBR(trialEndsAt!.slice(0, 10))})
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Meu plano */}
      {sub && activePlan && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">Plano atual</CardTitle>
            <Badge variant="secondary" className={BILLING_STATUS_VARIANT[billingStatus ?? "active"]}>
              {BILLING_STATUS_LABEL[billingStatus ?? "active"] ?? billingStatus}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-baseline gap-4">
              <div>
                <p className="text-2xl font-bold">{activePlan.name}</p>
                {activePlan.description && (
                  <p className="text-sm text-muted-foreground">{activePlan.description}</p>
                )}
              </div>
              <p className="text-lg font-semibold">
                {formatCentsBRL(activePlan.amount_cents)}
                <span className="text-sm text-muted-foreground font-normal">
                  /{activePlan.interval === "year" ? "ano" : "mês"}
                </span>
              </p>
            </div>

            <Separator />

            <div className="grid sm:grid-cols-2 gap-3 text-sm">
              {sub.current_period_end && (
                <div className="flex items-center gap-2">
                  <CalendarClock className="h-4 w-4 text-muted-foreground" />
                  <span className="text-muted-foreground">
                    {sub.cancel_at_period_end ? "Acesso ativo até" : "Próximo vencimento"}:
                  </span>
                  <span className="font-medium">{formatDateBR(sub.current_period_end.slice(0, 10))}</span>
                </div>
              )}
              {sub.trial_end && sub.status === "trialing" && (
                <div className="flex items-center gap-2">
                  <CalendarClock className="h-4 w-4 text-info" />
                  <span className="text-muted-foreground">Trial até:</span>
                  <span className="font-medium">{formatDateBR(sub.trial_end.slice(0, 10))}</span>
                </div>
              )}
            </div>

            {!sub.cancel_at_period_end && (
              <div className="pt-2">
                <Button variant="ghost" size="sm" onClick={() => setCancelDialog(true)} className="text-destructive hover:text-destructive">
                  Cancelar assinatura
                </Button>
              </div>
            )}
            {sub.cancel_at_period_end && (
              <p className="text-xs text-warning pt-1">
                Cancelamento agendado. Acesso garantido até o fim do período pago.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Meu cartão */}
      {sub && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Meu cartão de cobrança</CardTitle>
          </CardHeader>
          <CardContent>
            {loadingPms ? (
              <Skeleton className="h-12 w-full" />
            ) : defaultPm ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <CreditCard className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <p className="font-medium">
                      {(defaultPm.brand ?? "card").toUpperCase()} •••• {defaultPm.last4}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Expira {String(defaultPm.exp_month).padStart(2, "0")}/{defaultPm.exp_year}
                    </p>
                  </div>
                </div>
                <Button variant="outline" size="sm" onClick={handleChangeCard} disabled={checkout.isPending}>
                  Trocar cartão
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-muted-foreground">Nenhum cartão cadastrado.</p>
                <Button variant="outline" size="sm" onClick={handleChangeCard} disabled={checkout.isPending}>
                  Cadastrar cartão
                </Button>
              </div>
            )}
            <p className="text-xs text-muted-foreground mt-3">
              Para remover o cartão, entre em contato com o suporte da Moralles.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Automação WhatsApp (implantação avulsa + instância mensal) */}
      <AutomacaoWhatsappCard organizationId={organizationId} />

      {/* Planos disponíveis / cortesia */}
      {loadingEntitlements ? (
        <Skeleton className="h-32 w-full" />
      ) : entitlementsError ? (
        // Falha ao carregar entitlements: não sabemos se a conta tem cortesia.
        // Não mostrar o preço com confiança nesse caso — evita sugerir cobrança
        // pra quem tem acesso vitalício grátis (ex.: Ren Sushi) por causa de um
        // erro transitório de rede.
        <Card className="border-warning/20 bg-warning/10">
          <CardContent className="py-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-warning">
              Não foi possível carregar as informações de acesso da sua conta.
            </p>
            <Button variant="outline" size="sm" onClick={() => refetchEntitlements()}>
              Tentar novamente
            </Button>
          </CardContent>
        </Card>
      ) : isCourtesy ? (
        <Card>
          <CardHeader>
            <CardTitle>Acesso vitalício cortesia</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-sm text-muted-foreground">
              Sua conta tem acesso liberado por cortesia, sem cobrança. Não há
              nada a contratar nem a pagar.
            </p>
            {entitlements?.system.expires_at && (
              <p className="text-sm text-muted-foreground">
                Válido até {formatDateBR(entitlements.system.expires_at)}.
              </p>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          <div>
            <h2 className="text-lg font-semibold">Planos disponíveis</h2>
            <p className="text-sm text-muted-foreground">
              {sub
                ? "Mude de plano a qualquer momento — você só paga a diferença proporcional."
                : "Escolha o plano ideal pro seu negócio. Pagamento via cartão de crédito."}
            </p>
          </div>
          <PricingTable
            plans={activePlans}
            currentPlanId={activePlan?.id ?? null}
            onChoose={handleChoose}
            onChange={handleChangePlanPreview}
            loadingPlanId={checkout.isPending ? checkout.variables?.plan_id ?? null : previewMutation.isPending ? previewMutation.variables?.new_plan_id ?? null : null}
          />
        </div>
      )}

      {/* Preview / confirmação de troca de plano */}
      <AlertDialog open={!!previewState} onOpenChange={(open) => !open && setPreviewState(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Trocar para {previewState?.plan.name}?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  Você está alterando seu plano. O Stripe vai calcular automaticamente
                  o valor proporcional ao tempo restante do período atual.
                </p>
                <div className="bg-muted rounded-md p-3 text-sm">
                  <p className="text-muted-foreground">Cobrança agora (proporcional):</p>
                  <p className="text-lg font-bold mt-1">
                    {previewState ? formatCentsBRL(previewState.amountDue) : "—"}
                  </p>
                </div>
                <p className="text-xs text-muted-foreground">
                  A próxima cobrança recorrente passará a usar o novo valor do plano.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              disabled={changePlanMutation.isPending}
              onClick={confirmChangePlan}
            >
              {changePlanMutation.isPending ? "Confirmando..." : "Confirmar troca"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Confirmação de cancelamento */}
      <AlertDialog open={cancelDialog} onOpenChange={setCancelDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancelar assinatura?</AlertDialogTitle>
            <AlertDialogDescription>
              Você manterá acesso ao sistema até o fim do período já pago
              {sub?.current_period_end && ` (${formatDateBR(sub.current_period_end.slice(0, 10))})`}.
              Depois disso, o acesso será suspenso até você escolher um novo plano.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Voltar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={cancelMutation.isPending}
              onClick={handleCancel}
            >
              {cancelMutation.isPending ? "Cancelando..." : "Confirmar cancelamento"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
