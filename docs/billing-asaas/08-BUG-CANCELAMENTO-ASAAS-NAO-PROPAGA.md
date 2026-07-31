# BUG — cancelar assinatura Asaas não cancela no provedor

> **Status: BUG REAL, DORMENTE, NÃO CORRIGIDO.** Descoberto em 2026-07-31, durante a limpeza da
> fixture do sandbox da Fase 5b. **Severidade maior que a do
> [07](07-BUG-EXTERNALREFERENCE-LIMITE.md)**: aquele falha alto na primeira tentativa; este falha
> em silêncio e continua cobrando o cliente. Não corrigir junto com limpeza de fixture — precisa
> de spec e de teste.

## 1. O defeito

As duas ações de cancelamento de `manage-billing` chamam o helper **da Stripe** diretamente, em
vez do adapter de provedor:

```ts
// cancel_subscription (admin) e cancel_subscription_by_owner (cliente)
if (sub.stripe_subscription_id) {          // null em assinatura Asaas
  await cancelStripeSubscription(...)      // nunca executa
}
await supabase.from("billing_subscriptions").update({ status: "canceled", ... })
```

`provider.cancelSubscription` **existe nos dois adapters e não tem nenhum caller** em
`supabase/functions` — verificado por varredura. É código morto, mesma família do
`createOneTimeCharge` do [07](07-BUG-EXTERNALREFERENCE-LIMITE.md).

## 2. Consequência

Para uma assinatura com `provider = 'asaas'`:

| lado | depois de "cancelar" |
|---|---|
| nosso banco | `status: canceled`, `canceled_at` preenchido |
| Asaas | **`ACTIVE`** — segue gerando cobrança todo ciclo |

O cliente cancela, a plataforma confirma o cancelamento na tela, e a cobrança mensal continua
saindo. Ninguém percebe até chegar a fatura — ou a reclamação. É cobrança indevida com o
consentimento aparente do sistema, e o rastro interno diz que estava tudo certo.

Vale para os dois caminhos: o admin (`cancel_subscription`) e o self-service do lojista
(`cancel_subscription_by_owner`).

## 3. Por que está dormente hoje

Nenhum plano tem `provider = 'asaas'` com assinatura viva de cliente real. A única assinatura
Asaas que existiu foi a fixture desta fase, e ela foi encerrada **pelo painel do Asaas**, à mão —
não pelo nosso fluxo. O bug acorda no primeiro cliente pagante com assinatura Asaas.

## 4. Evidência

Limpeza da fixture, 2026-07-31:

1. `sub_qn6dpom3q6xr3r8s` removida **pelo painel do Asaas** → `status: INACTIVE`, `deleted: true`,
   cobrança `pay_u47jujtp7u4fm19l` preservada (`CONFIRMED`, `deleted: false`).
2. Só depois a linha interna foi conciliada pela ação admin → `status: canceled`,
   `canceled_at` preenchido.

Os dois passos foram necessários **porque um não faz o outro**. Se a ordem tivesse sido só a (2),
a assinatura seguiria ativa no Asaas com cobrança prevista para 2026-08-31.

## 5. O que a correção precisa cobrir

1. **Rotear pelo adapter** — `getBillingProvider(sub.provider).cancelSubscription(...)`, com o
   `provider_subscription_id`, em vez de `cancelStripeSubscription` direto.
2. **Semântica de `at_period_end` no Asaas**: `true` → `status: INACTIVE` (para cobrança futura,
   preserva histórico); `false` → `DELETE` (encerra e remove cobranças **pendentes/vencidas em
   aberto** — comportamento destrutivo que a UI precisa deixar explícito).
3. **Falha do provedor não pode virar sucesso local.** Hoje, se o provedor recusasse, o `update`
   local rodaria assim mesmo em alguns caminhos. Cancelamento tem que ser: provedor primeiro,
   banco depois, e erro do provedor aborta com mensagem clara.
4. **Reconciliação** — o `process-billing-reconcile` deveria detectar divergência entre
   `billing_subscriptions.status` e o status no provedor, e alertar.
5. **Teste que prove a propagação** para os dois provedores, e um contrato que impeça um adapter
   novo de nascer sem `cancelSubscription` ligado.
6. **Varredura por irmãos**: `createOneTimeCharge` e `cancelSubscription` já são dois métodos do
   adapter sem caller. Vale auditar a interface inteira antes de assumir que são só esses dois.

## 6. Relação com o [07](07-BUG-EXTERNALREFERENCE-LIMITE.md)

Mesma causa raiz: a abstração `BillingProvider` foi escrita na Fase 3, e partes do
`manage-billing` continuaram falando com a Stripe diretamente. A migração ficou pela metade e
ninguém notou porque **não há cliente Asaas pagante** — a mesma razão pela qual quase tudo nesta
fase é difícil de testar.
