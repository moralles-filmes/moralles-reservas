# Cancelamento de assinatura roteado por provedor — design

**Data:** 2026-07-31
**Origem:** [08-BUG-CANCELAMENTO-ASAAS-NAO-PROPAGA.md](../../billing-asaas/08-BUG-CANCELAMENTO-ASAAS-NAO-PROPAGA.md)
**Escopo:** corrigir a metade do buraco que cobra o cliente indevidamente. Nada além disso.

## 1. O problema

As duas ações de cancelamento de `manage-billing` chamam `cancelStripeSubscription` diretamente,
guardadas por `if (sub.stripe_subscription_id)`. Para uma assinatura Asaas essa coluna é `null`:
o provedor nunca é chamado, o banco grava `canceled`, e o Asaas continua cobrando todo mês. A
tela confirma o cancelamento; a cobrança sai assim mesmo.

`provider.cancelSubscription` existe nos dois adapters e **não tem nenhum caller** — é código
morto desde a Fase 3.

Vale para os dois caminhos: `cancel_subscription` (admin) e `cancel_subscription_by_owner`
(self-service do lojista).

## 2. Decisões tomadas antes do desenho

**Destino do billing: Asaas-only.** A Stripe é legado em extinção. Por isso **não** migramos as
outras cinco operações não roteadas (`createSubscription`, `getSubscription`, `createOneTimeCharge`,
`refundPayment` e a duplicata de `createCustomer`): seria trabalho apagado junto com a Stripe. A
lacuna fica registrada, não corrigida.

**Só a metade 1.** Reconciliar de volta o status de uma assinatura cancelada direto no painel do
Asaas (a metade 2) fica para a migração Asaas-nativa. A conta Asaas só assina eventos `PAYMENT_*`;
não há `SUBSCRIPTION_*`, e tanto `process-billing-reconcile` quanto o `sync` do painel filtram
`stripe_subscription_id not null` — pulam Asaas em silêncio.

## 3. A armadilha que reescreveu o desenho

Rotear o cancelamento mantendo `at_period_end` como está trocaria um bug por outro:

| | |
|---|---|
| Asaas | `INACTIVE` — para de cobrar ✅ |
| banco | `cancel_at_period_end: true`, `status` continua `active` |
| `current_period_end` | `null` — nenhum escritor Asaas existe |
| quem vira para `canceled` | **ninguém** — não há evento nem worker |
| entitlements | `allowed: true`, indefinidamente |

`entitlements-core.ts:137-142` concede acesso por **status** (`ALLOWED_SUB_STATUSES`); `current_period_end` viaja só como
`expiresAt` informativo e nunca é comparado com agora. Quem encerra acesso numa assinatura Stripe
é o webhook `customer.subscription.deleted`. Para Asaas esse elo não existe. O cliente pararia de
pagar e manteria o serviço.

**Portanto: `at_period_end` é um conceito Stripe, e para Asaas o cancelamento é sempre imediato.**

### Consequência comercial, aceita conscientemente

Quem cancelar no dia 5 perde os dias que já pagou. Não há mecanismo para devolver nem para honrar
o período, e construí-lo é a metade 2. A decisão é registrar isso na tela, de forma explícita, em
vez de esconder atrás de uma flag que nada consome.

## 4. Arquitetura

### 4.1 O adapter informa o efeito real

`cancelSubscription` passa a devolver o que **de fato** aconteceu:

```ts
cancelSubscription(
  providerSubscriptionId: string,
  atPeriodEnd: boolean,
): Promise<ProviderResult<{ effective: "immediate" | "at_period_end" }>>;
```

- **Stripe:** `effective` espelha o `atPeriodEnd` pedido.
- **Asaas:** ignora `atPeriodEnd`, sempre `PUT /subscriptions/{id}` com `status: INACTIVE`, e
  devolve `effective: "immediate"`.

O caller grava o estado local **a partir da resposta**, nunca do que pediu. É isso que impede a
classe inteira do bug de voltar: hoje o caller supõe o efeito e escreve; qualquer provedor cuja
semântica não bata volta a divergir em silêncio.

`INACTIVE`, não `DELETE`: `DELETE` encerra a assinatura **e remove as cobranças pendentes/vencidas
em aberto**, ou seja, o cliente extinguiria a própria dívida cancelando. O branch `DELETE` sai, e
`deleteAsaasSubscription` sai com ele — tem exatamente um caller, esse. Deixar função sem caller é
o padrão que originou este bug.

### 4.2 Núcleo puro de decisão

`supabase/functions/_shared/billing-cancel-core.ts`, testado por vitest como os demais núcleos.

```ts
type CancelTarget =
  | { kind: "provider"; provider: "stripe" | "asaas"; providerSubscriptionId: string }
  | { kind: "local_only"; provider: "manual" | "lifetime" }
  | { kind: "unroutable"; provider: string; reason: "missing_provider_id" | "unknown_provider" };

decideCancelTarget(sub: {
  provider: string;
  provider_subscription_id: string | null;
  stripe_subscription_id: string | null;
}): CancelTarget;
```

`billing_subscriptions.provider` aceita `stripe | asaas | manual | lifetime` (CHECK da
[migration 063](../../../supabase/migrations/20260716130200_063_billing_provider_columns.sql)):

- `manual`/`lifetime` → `local_only`. **Não têm contraparte externa; cancelar só no banco é
  legítimo.** Sem esse ramo, o núcleo recusaria um cancelamento válido.
- `stripe`/`asaas` com id → `provider`. O id sai de `provider_subscription_id`, com
  `stripe_subscription_id` como fallback (linhas anteriores ao backfill da 063).
- `stripe`/`asaas` sem id → `unroutable` / `missing_provider_id`. **É o coração da correção:** hoje
  esse caso pula o provedor e grava local em silêncio. Passa a ser erro.
- Qualquer outro valor de `provider` → `unroutable` / `unknown_provider`. O CHECK do banco impede
  hoje, mas o núcleo é puro e falha fechado em vez de adivinhar rota.

```ts
localCancelPatch(
  effective: "immediate" | "at_period_end",
  nowIso: string,
): { status?: "canceled"; canceled_at?: string; cancel_at_period_end?: boolean; updated_at: string };
```

`immediate` → `status: "canceled"`, `canceled_at`, `cancel_at_period_end: false`.
`at_period_end` → só `cancel_at_period_end: true`, sem tocar em `status`.

### 4.3 Os dois call sites

Ambos passam a selecionar `provider`, `provider_subscription_id` e `stripe_subscription_id`, e a
seguir a mesma sequência:

1. `decideCancelTarget`.
2. `unroutable` → **400**, sem escrita local: *"Esta assinatura não tem vínculo com o provedor de
   pagamento. Não é possível cancelar automaticamente."*
3. `provider` → `getBillingProvider(provider).cancelSubscription(id, atPeriodEnd)`.
   **Falha do provedor aborta com 500 em PT-BR e não escreve nada localmente.**
4. `local_only` → segue direto, com `effective: "immediate"`.
5. Aplica `localCancelPatch(effective, now)`.
6. Só quando `effective === "immediate"`: mantém o gate `isSystemSubscription` que cascateia
   `organizations.billing_status = 'canceled'`. Assinatura de instância de WhatsApp nunca cancela
   a organização — comportamento validado ao vivo em
   [FASE-5B-ROTEIRO-SANDBOX.md §0.9](../../billing-asaas/FASE-5B-ROTEIRO-SANDBOX.md).

`cancel_subscription_by_owner` continua pedindo `atPeriodEnd: true`; para Asaas o provedor responde
`immediate` e o patch reflete isso.

Ordem obrigatória: **provedor primeiro, banco depois.** Nunca o inverso, e nunca banco sem
provedor.

### 4.4 UI

**`BillingDetail.tsx` (`CancelSubDialog`)** recebe o `provider` da assinatura. Quando é `asaas`, a
caixa "Cancelar apenas ao fim do período" não é renderizada e a descrição diz que o cancelamento é
imediato e que o acesso termina na hora. Para `stripe`, nada muda.

**`Cobranca.tsx` (self-service do lojista)** — o diálogo avisa, **antes** de confirmar, que para
Asaas o acesso termina imediatamente e não há reembolso do período já pago. O toast de sucesso
passa a refletir o `effective` devolvido, em vez do texto fixo *"Assinatura agendada para
cancelamento no fim do período"*, que para Asaas é falso.

### 4.5 CLAUDE.md, no mesmo PR

- **Invariante novo:** cancelamento de assinatura roteia por `getBillingProvider` e grava o estado
  local a partir do `effective` devolvido, nunca do que foi pedido. Uma frase, um porquê, um
  ponteiro.
- **Nota honesta:** as outras cinco operações de `manage-billing` seguem Stripe-nativas por decisão
  (Asaas-only, Stripe sai), com ponteiro para o bug 08.
- **Checklist de redeploy:** `billing-provider.ts` e `asaas.ts` ganham `manage-billing` como
  consumidor; `billing-cancel-core.ts` nasce com `manage-billing` como único consumidor.

## 5. Erros

| situação | resposta | escrita local |
|---|---|---|
| `unroutable` (sem id, ou provider desconhecido) | 400, mensagem curta em PT-BR | nenhuma |
| provedor recusa ou cai | 500, mensagem curta em PT-BR, detalhe em `jsonLog` | nenhuma |
| provedor ok, banco falha | 500 | assinatura já cancelada no provedor — logar `evt` dedicado para conciliação humana |
| `local_only` | 200 | patch normal |

O terceiro caso é assimetria conhecida e aceita: sem transação distribuída, alguém fica na frente.
Cancelar no provedor primeiro erra a favor do cliente — ele para de ser cobrado mesmo se o nosso
banco falhar. O log nomeado é o que permite achar e conciliar.

## 6. Testes

**Vitest sobre o núcleo puro**, em `src/lib/billing-cancel-core.test.ts` (mesmo padrão dos demais
núcleos, que importam de `supabase/functions/_shared/`):

- `decideCancelTarget`: asaas com id · stripe com id · stripe só com `stripe_subscription_id`
  (fallback pré-063) · manual · lifetime · asaas sem id · stripe sem id · provider desconhecido.
- `localCancelPatch`: `immediate` grava `status`/`canceled_at`/`cancel_at_period_end: false`;
  `at_period_end` grava só `cancel_at_period_end` e **não** toca em `status`.

**Não há teste de integração possível** sem um provider fake — a limitação está registrada no
[follow-up 06](../../billing-asaas/06-FOLLOWUP-SANDBOX-INADIMPLENCIA.md), e essa spec não a resolve.
A verificação do caminho real fica manual, contra o Sandbox, quando houver assinatura Asaas viva.

## 7. Fora de escopo — declarado, não esquecido

- As outras cinco operações de `manage-billing` não roteadas pelo adapter.
- A metade 2: reconciliar de volta assinatura Asaas cancelada fora do sistema.
- `entitlements-core` e qualquer noção de expiração por data.
- Popular `current_period_end` para Asaas.
- Qualquer caminho Stripe além de preservar o comportamento atual.
- O bug do `externalReference` ([07](../../billing-asaas/07-BUG-EXTERNALREFERENCE-LIMITE.md)), que
  tem spec própria.

## 8. Critério de pronto

Cancelar uma assinatura `provider='asaas'` chama o Asaas, e uma falha do Asaas impede a escrita
local. Cancelar `manual`/`lifetime` continua funcionando sem chamar provedor nenhum. Assinatura
`stripe`/`asaas` sem id de provedor é recusada com 400 em vez de gravar `canceled` em silêncio.
Nenhuma tela promete fim de período para uma assinatura Asaas. `npm run typecheck` sem erro novo, e
os testes do núcleo passando.
