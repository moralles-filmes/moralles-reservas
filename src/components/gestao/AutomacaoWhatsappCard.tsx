import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { MessageSquare, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { formatDateBR } from "@/lib/utils";
import {
  formatCentsBRL,
  ENTITLEMENT_GRANT_TYPE_LABEL,
  type EntitlementGrantType,
  type ClientImplementationState,
  type WhatsappServiceStatus,
} from "@/types/billing";
import {
  useWhatsappServiceStatus,
  useCreateImplementationCheckout,
} from "@/hooks/useWhatsappImplementation";
import { useBillingPlans, useCreateBillingCheckout } from "@/hooks/useBilling";

interface Props {
  organizationId: string;
}

/**
 * Rótulo da linha "pagamentos únicos" do resumo, por estado da implantação.
 *
 * `costs.oneTimeDueCents` devolve o preço de VITRINE (750000 centavos) quando
 * não existe linha (`NOT_REQUESTED`) — é "quanto custa", não "quanto você
 * deve" (a org pode nunca ter pedido a implantação e ter cortesia vitalícia
 * em tudo o resto, ex.: Ren Sushi). Só `AWAITING_PAYMENT` é cobrança real em
 * aberto; nos estados liquidados o valor já é 0, e em `CANCELED` não há
 * checkout ativo pra pagar (o botão de contratar só existe em
 * `NOT_REQUESTED`). Rotular pelo estado evita a leitura "você deve R$750"
 * pra quem nunca contratou.
 */
const ONE_TIME_ROW_LABEL: Record<ClientImplementationState, string> = {
  NOT_REQUESTED: "Implantação (contratação avulsa)",
  AWAITING_PAYMENT: "Implantação — pagamento em aberto",
  PAID_NOT_STARTED: "Pagamentos únicos",
  IN_PROGRESS: "Pagamentos únicos",
  WAITING_CUSTOMER: "Pagamentos únicos",
  COMPLETED: "Pagamentos únicos",
  CANCELED: "Implantação (cancelada)",
};

export function AutomacaoWhatsappCard({ organizationId }: Props) {
  const { data, isLoading, isError, refetch } = useWhatsappServiceStatus(organizationId);
  const { data: plans } = useBillingPlans();
  const implCheckout = useCreateImplementationCheckout();
  const subCheckout = useCreateBillingCheckout();

  if (isLoading) return <Skeleton className="h-64 w-full" />;

  // Erro tratado como branch PRÓPRIO, nunca como "não tem nada": silenciar aqui
  // faria uma implantação em andamento sumir da tela do cliente.
  if (isError || !data) {
    return (
      <Card className="border-warning/20 bg-warning/10">
        <CardContent className="py-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-warning shrink-0 mt-0.5" />
            <p className="text-sm text-warning">
              Não foi possível carregar o status da automação do WhatsApp.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            Tentar novamente
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!data.flags.implementation_flow) return null;

  const implPlan = (plans ?? []).find((p) => p.slug === "implementacao-whatsapp");
  const instancePlan = (plans ?? []).find((p) => p.slug === "instancia-whatsapp");

  async function contratarImplantacao() {
    if (!implPlan) return;
    try {
      await implCheckout.mutateAsync({ organization_id: organizationId, plan_id: implPlan.id });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao iniciar o checkout.");
    }
  }

  async function contratarInstancia() {
    if (!instancePlan) return;
    try {
      await subCheckout.mutateAsync({
        organization_id: organizationId,
        plan_id: instancePlan.id,
        purpose: "subscription",
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao iniciar o checkout.");
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0 gap-3">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-5 w-5 text-muted-foreground" />
          <CardTitle className="text-base">Automação no WhatsApp</CardTitle>
        </div>
        {data.override.active && (
          <Badge variant="secondary" className="bg-info/10 text-info">
            Liberado pela plataforma
          </Badge>
        )}
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Preços SEMPRE visíveis, antes de qualquer clique — vitrine do
            catálogo, não necessariamente o que esta conta deve. */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
          <div className="rounded-md border p-3">
            <p className="text-muted-foreground">Implantação</p>
            <p className="font-semibold">
              {implPlan ? formatCentsBRL(implPlan.amount_cents) : "—"}{" "}
              <span className="font-normal text-muted-foreground">uma vez</span>
            </p>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-muted-foreground">Instância</p>
            <p className="font-semibold">
              {instancePlan ? formatCentsBRL(instancePlan.amount_cents) : "—"}
              <span className="font-normal text-muted-foreground">/mês</span>
            </p>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-muted-foreground">Créditos de IA</p>
            <p className="font-semibold">
              R$ 50 a R$ 200{" "}
              <span className="font-normal text-muted-foreground">recarga</span>
            </p>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          A mensalidade da instância e os créditos de IA <strong>não</strong> estão
          inclusos no valor da implantação.
        </p>

        <Separator />

        <div className="space-y-2">
          <p className="text-sm">{data.implementation.next_step}</p>
          {data.implementation.state === "NOT_REQUESTED" && (
            <Button onClick={contratarImplantacao} disabled={implCheckout.isPending || !implPlan}>
              {implCheckout.isPending ? "Abrindo checkout..." : "Contratar implementação"}
            </Button>
          )}
          {data.implementation.state === "COMPLETED"
            && !data.subscription.has_instance
            && !data.override.active
            && data.flags.subscription_checkout && (
            <Button onClick={contratarInstancia} disabled={subCheckout.isPending || !instancePlan}>
              {subCheckout.isPending
                ? "Abrindo checkout..."
                : `Contratar instância — ${instancePlan ? formatCentsBRL(instancePlan.amount_cents) : ""}/mês`}
            </Button>
          )}
          {data.subscription.has_instance && data.subscription.next_due && (
            <p className="text-sm text-muted-foreground">
              Próximo vencimento da instância:{" "}
              <span className="font-medium">{formatDateBR(data.subscription.next_due.slice(0, 10))}</span>
            </p>
          )}
          {data.override.active && (
            <p className="text-sm text-muted-foreground">
              {ENTITLEMENT_GRANT_TYPE_LABEL[
                (data.override.grant_type ?? "MANUAL_OVERRIDE") as EntitlementGrantType
              ]}
              {" — "}
              {data.override.ends_at
                ? `válido até ${formatDateBR(data.override.ends_at.slice(0, 10))}`
                : "próxima cobrança: não aplicável"}
              .
            </p>
          )}
        </div>

        <Separator />
        <ResumoCustos
          costs={data.costs}
          sponsored={data.override.active}
          pricesUnavailable={data.prices_unavailable}
          implementationState={data.implementation.state}
        />
      </CardContent>
    </Card>
  );
}

/**
 * Os quatro números do resumo consolidado — sempre os quatro, inclusive
 * quando algum é zero. `pricesUnavailable` força "—" em vez de R$ 0,00 (mesma
 * convenção de `KpiCard.formatValue`): quando o catálogo não carrega, o
 * backend colapsa preço `null` em 0, indistinguível do zero legítimo de quem
 * tem cortesia — mostrar R$ 0,00 nesse caso seria mentira pra quem deve
 * R$ 449 + R$ 750.
 */
function ResumoCustos({
  costs,
  sponsored,
  pricesUnavailable,
  implementationState,
}: {
  costs: WhatsappServiceStatus["costs"];
  sponsored: boolean;
  pricesUnavailable: boolean;
  implementationState: ClientImplementationState;
}) {
  const money = (cents: number) => (pricesUnavailable ? "—" : formatCentsBRL(cents));

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">Resumo dos custos</p>
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Total mensal atual</dt>
          <dd className="font-medium">{money(costs.currentMonthlyCents)}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Total mensal com a automação</dt>
          <dd className="font-medium">{money(costs.projectedMonthlyCents)}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">{ONE_TIME_ROW_LABEL[implementationState]}</dt>
          <dd className="font-medium">{money(costs.oneTimeDueCents)}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Créditos de IA</dt>
          <dd className="font-medium">Variável</dd>
        </div>
      </dl>
      {pricesUnavailable && (
        <p className="text-xs text-warning">
          Não foi possível carregar os valores agora. Tente novamente em instantes.
        </p>
      )}
      {sponsored && (
        <p className="text-xs text-muted-foreground">
          O WhatsApp desta conta é patrocinado pela plataforma — não há cobrança
          mensal por ele.
        </p>
      )}
    </div>
  );
}
