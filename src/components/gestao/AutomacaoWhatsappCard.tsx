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
 * `costs.oneTimeDueCents` devolve o preço de VITRINE (75000 centavos) quando
 * não existe linha (`NOT_REQUESTED`) — é "quanto custa", não "quanto você
 * deve" (a org pode nunca ter pedido a implantação e ter cortesia vitalícia
 * em tudo o resto, ex.: Ren Sushi). Só `AWAITING_PAYMENT` é cobrança real em
 * aberto (e usa `implementation.amount_cents`, não `costs.oneTimeDueCents` —
 * ver `ResumoCustos`); nos estados liquidados o valor já é 0. Rotular pelo
 * estado evita a leitura "você deve R$750" pra quem nunca contratou.
 *
 * `CANCELED` é INALCANÇÁVEL no payload do cliente hoje (Rodada de correção 1,
 * Minor): `get_service_status` lê `whatsapp_implementations` com
 * `.neq("operational_status", "CANCELED")` — a mesma condição do índice
 * parcial da migration 071 (`where operational_status <> 'CANCELED'`) — então
 * uma linha cancelada nunca chega a `buildClientImplementationView`, que cai
 * em `NOT_REQUESTED` como se a linha não existisse. Nenhum writer do repo
 * grava `payment_status='CANCELED'` (só a leitura em
 * `whatsapp-implementation-core.ts:206` prevê o caso). O rótulo abaixo fica
 * como defesa para o dia em que um caminho de estorno alcançar esse estado —
 * não é código morto por descuido, é código morto documentado.
 */
const ONE_TIME_ROW_LABEL: Record<ClientImplementationState, string> = {
  NOT_REQUESTED: "Implantação (se contratar)",
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

  // N6 (review final fase 5a): par da correção I-4 (Task 16) já aplicada no
  // lado admin (BillingDetail.tsx, SUBSCRIPTION_STATUS_LABEL/CLASS) — o
  // rótulo/cor vêm do status REAL, não de `has_instance` (que só diz "existe
  // assinatura não cancelada", inclusive `past_due`/`unpaid`). Sem qualificar
  // por status, `current_period_end` já vencido era apresentado ao cliente
  // como "Próximo vencimento". `unpaid` é mais severo que `past_due` (mesma
  // gradação do lado admin).
  const instanceOverdue =
    data.subscription.status === "past_due" || data.subscription.status === "unpaid";
  const instanceSeverelyOverdue = data.subscription.status === "unpaid";

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
          {/* I4 (Rodada 1): `next_step` do backend é escrito para quem ainda
              não tem nada — "Contrate a implantação..." — e mente pra quem já
              usa a automação em produção por cortesia (ex.: Ren Sushi). Só o
              FRONTEND sabe cruzar `override.active` com `state`; o núcleo puro
              não teria como (ele não decide texto de cortesia). */}
          <p className="text-sm">
            {data.override.active && data.implementation.state === "NOT_REQUESTED"
              ? "Sua automação de WhatsApp está ativa por cortesia da plataforma."
              : data.implementation.next_step}
          </p>
          {/* I4: sem isso, quem já tem cortesia (override.active) vê um botão
              de R$750 pra um serviço que já recebeu fora deste sistema de
              tracking. Formalizar isso é ação de admin (Task 16, action
              `create` com origin:"COURTESY"), não oferta na tela do cliente. */}
          {data.implementation.state === "NOT_REQUESTED" && !data.override.active && (
            <Button onClick={contratarImplantacao} disabled={implCheckout.isPending || !implPlan}>
              {implCheckout.isPending ? "Abrindo checkout..." : "Contratar implementação"}
            </Button>
          )}
          {/* I2 (Rodada 1): `system_allowed` espelha `canContractInstance`
              (núcleo puro) / `eligibility.ts` (servidor) — sem ele, uma org com
              implantação concluída mas sistema bloqueado (parou de pagar) via
              esta MESMA rota (única liberada quando bloqueada) via o botão e
              levava 409 no clique. `has_system_subscription` não serve pra
              isso: cortesia de sistema tem `systemAllowed=true` e
              `has_system_subscription=false` — usá-lo aqui esconderia o botão
              de quem tem direito. */}
          {data.implementation.state === "COMPLETED"
            && !data.subscription.has_instance
            && !data.override.active
            && (data.system_allowed ?? false)
            && data.flags.subscription_checkout && (
            <Button onClick={contratarInstancia} disabled={subCheckout.isPending || !instancePlan}>
              {subCheckout.isPending
                ? "Abrindo checkout..."
                : instancePlan
                  ? `Contratar instância — ${formatCentsBRL(instancePlan.amount_cents)}/mês`
                  : "Contratar instância"}
            </Button>
          )}
          {data.subscription.has_instance && data.subscription.next_due && (
            <p
              className={`text-sm ${
                instanceOverdue
                  ? instanceSeverelyOverdue
                    ? "text-destructive"
                    : "text-warning"
                  : "text-muted-foreground"
              }`}
            >
              {instanceOverdue ? "Pagamento da instância em atraso desde" : "Próximo vencimento da instância"}
              :{" "}
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
          hasSystemSubscription={data.has_system_subscription}
          implementationAmountCents={data.implementation.amount_cents}
        />
      </CardContent>
    </Card>
  );
}

/**
 * Os quatro números do resumo consolidado — sempre os quatro, inclusive
 * quando algum é zero. `pricesUnavailable` força "—" em vez de R$ 0,00 (mesma
 * convenção de `KpiCard.formatValue`) via o helper `money()` logo abaixo —
 * este É o invariante ("a UI nunca renderiza `costs` como R$ 0,00 quando o
 * catálogo falhou") citado no comentário de `WhatsappServiceStatus` em
 * `src/types/billing.ts`: quando o catálogo não carrega, o backend colapsa
 * preço `null` em 0, indistinguível do zero legítimo de quem tem cortesia —
 * mostrar R$ 0,00 nesse caso seria mentira pra quem deve R$ 449 + R$ 750.
 */
function ResumoCustos({
  costs,
  sponsored,
  pricesUnavailable,
  implementationState,
  hasSystemSubscription,
  implementationAmountCents,
}: {
  costs: WhatsappServiceStatus["costs"];
  sponsored: boolean;
  pricesUnavailable: boolean;
  implementationState: ClientImplementationState;
  hasSystemSubscription: boolean;
  implementationAmountCents: number | null;
}) {
  const money = (cents: number) => (pricesUnavailable ? "—" : formatCentsBRL(cents));

  // C1 (Rodada de correção 1, CRITICAL): `summarizeMonthlyCosts` (núcleo puro)
  // calcula `systemPart` a partir do preço de VITRINE do sistema sempre que
  // não há cortesia — de propósito, é um núcleo de projeção sobre catálogo,
  // não de cobrança real; não é ele que está errado. Quem mente é a palavra
  // "atual" ao lado desse número quando NÃO existe assinatura de sistema
  // (trial sem sub, org `blocked` sem sub) — o cliente paga zero e leria
  // "Total mensal atual: R$ 449,00". Sem cortesia (`systemSponsored`), o
  // backend zera `currentMonthlyCents` só quando o preço não carrega
  // (`pricesUnavailable`), nunca por falta de assinatura — daí o gate aqui,
  // não no backend.
  const systemNotBilled =
    !hasSystemSubscription && !pricesUnavailable && costs.currentMonthlyCents > 0;
  const currentLabel = systemNotBilled
    ? "Valor de tabela (sem assinatura ativa)"
    : "Total mensal atual";

  // I3 (Rodada de correção 1, Important): em `AWAITING_PAYMENT`, o único
  // estado rotulado "pagamento em aberto", `costs.oneTimeDueCents` é o preço
  // do CATÁLOGO hoje — se o preço subir entre a abertura do checkout e o
  // pagamento, a tela diverge do valor real da cobrança (e do link já aberto).
  // `implementation.amount_cents` é o valor GRAVADO na linha no momento em que
  // o checkout foi criado (`insertImplementationRow`,
  // `_shared/implementation-checkout.ts:72`) — vem de uma leitura própria
  // (`whatsapp_implementations`) que já teria abortado a resposta inteira com
  // 500 se tivesse falhado, então é confiável independentemente de
  // `pricesUnavailable` (que só reflete falha em `billing_plans`). Por isso
  // este valor NÃO passa pelo `money()` acima — não faz sentido esconder o
  // único número que é garantidamente uma dívida real atrás de um aviso que
  // fala de um catálogo que nem foi consultado para produzi-lo.
  const oneTimeDisplay =
    implementationState === "AWAITING_PAYMENT" && implementationAmountCents != null
      ? formatCentsBRL(implementationAmountCents)
      : money(costs.oneTimeDueCents);

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">Resumo dos custos</p>
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">{currentLabel}</dt>
          <dd className="font-medium">{money(costs.currentMonthlyCents)}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Total mensal com a automação</dt>
          <dd className="font-medium">{money(costs.projectedMonthlyCents)}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">{ONE_TIME_ROW_LABEL[implementationState]}</dt>
          <dd className="font-medium">{oneTimeDisplay}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Créditos de IA</dt>
          <dd className="font-medium">Variável</dd>
        </div>
      </dl>
      {systemNotBilled && (
        <p className="text-xs text-muted-foreground">
          Você ainda não tem uma assinatura ativa do sistema — os valores
          mensais acima são de referência, não uma cobrança em curso.
        </p>
      )}
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
