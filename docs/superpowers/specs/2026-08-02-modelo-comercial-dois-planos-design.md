# Modelo comercial de dois planos — spec de transição

**Data:** 2026-08-02
**Versão:** **1.0 — CONGELADA**
**Status:** decisões comerciais D1–D9 fechadas; 47 testes nomeados; 4 acoplamentos de rollout; 9 invariantes de fecho. **Nada implementado.**
**Não substitui** as specs de 4a a 6b — aquelas documentam o que já foi construído e continuam verdadeiras como registro histórico.

## Congelamento

Esta spec está congelada na versão 1.0. **Regra nova só entra mediante risco concreto identificado** — não por refinamento, simetria ou completude aparente. Alteração posterior vira versão 1.x com o risco que a motivou registrado ao lado.

### Deixado deliberadamente para a implementação

Os cinco itens abaixo **não são lacunas da regra de negócio**. São escolhas de implementação, e **devem preservar os invariantes já aprovados**:

| # | Item | Invariante que precisa sobreviver |
|---|---|---|
| 1 | Mecanismo PostgreSQL contra sobreposição parcial de ciclos | ciclos da mesma organização não se sobrepõem silenciosamente (§17.3) |
| 2 | Desenho exato da RPC transacional de reserva e liquidação | leitura e criação atômicas; concorrentes não consomem o mesmo saldo (§17.5) |
| 3 | Grants, RLS e locks concretos | FORCE RLS + `platform_admin_all_*`; lojista nunca lê custo |
| 4 | Política operacional de reconciliação de `USAGE_REVIEW_REQUIRED` | nem alerta eterno, nem liberação por decurso de prazo (§17.2.2) |
| 5 | Execução dos testes 42 e 44 contra banco real | concorrência e não sobreposição não são declaráveis por unitário (§20) |

---

## Premissa operacional (corrigida)

O relatório anterior tratava a Fase 6b como "NO-GO". O registro de rollout diz outra coisa, e a distinção importa porque qualquer mudança daqui em diante convive com dados reais em produção.

| Fato | Estado |
|---|---|
| Migrations 087→093 | **aplicadas em produção** |
| Nove Edge Functions da 6b | **deployadas** |
| Cron `whatsapp-instance-cycles` (`10 12 * * *`) | **ativo** |
| Ren Sushi no inventário | **cadastrado**, custo real R$ 99,90, vencimento dia 4 |
| Frontend da 6b | **não publicado** — o painel existe só na branch |
| Branch `billing-asaas/fase-6b` | **não mergeada** |
| `whatsapp_service_enforcement`, `whatsapp_implementation_flow`, `whatsapp_subscription_checkout`, `billing_notifications_dispatch` | **OFF** |
| Asaas | **sandbox** |

Consequência prática: o inventário está vivo e rolando ciclos. Esta spec não pode propor nada que exija reescrever as migrations 087→093, e a instância do Ren Sushi não é fixture.

---

## Achados de schema e código que fundamentam a spec

Sete verificações feitas antes de propor DDL.

### A1 — `billing_plans.features` é copy de marketing, não entitlement

Renderizada por `parsePlanFeatures` em [PricingCard.tsx](../../../src/components/PricingCard.tsx), editada como textarea de uma linha por bullet em [BillingPlans.tsx:722](../../../src/pages/platform/BillingPlans.tsx), tipada como `string[] | Record<string, unknown>` em [billing.ts:92](../../../src/types/billing.ts).

**Decisão fechada:** permanece exclusivamente copy. Um administrador editando uma frase comercial **nunca** pode conceder ou retirar acesso. `included_features` é coluna separada, com CHECK fechado, sem nenhuma dependência de `parsePlanFeatures`. **Não reusar `features` para evitar uma migration.**

### A2 — A instrumentação de custo de IA já existe

[_shared/ai-providers.ts](../../../supabase/functions/_shared/ai-providers.ts) define `AgentUsage`, o callback `onUsage` implementado nos cinco provedores, e `estimateCostUsd` sobre `PRICING_USD_PER_MTOK`. O `webhook-whatsapp` já agrega `totalUsage` por invocação e loga `evt: "agent_usage"` com `estimated_cost_usd` na [linha 2543](../../../supabase/functions/webhook-whatsapp/index.ts).

**Decisão fechada:** a Fase 7 **não reconstrói a instrumentação**. Ela persiste, versiona e protege financeiramente o que hoje só é calculado e jogado em log.

Lacunas reais, todas endereçadas nesta spec:

| # | Lacuna | Seção |
|---|---|---|
| 1 | preço preso a constantes de código | §15.1 |
| 2 | custo apenas em USD | §15.1 |
| 3 | ausência de taxa de conversão versionada | §15.1 |
| 4 | ausência de persistência por chamada e por turno | §15.2 |
| 5 | ausência de reserva | §15.3 |
| 6 | ausência de consolidação atômica | §15.4 |
| 7 | **modelo desconhecido retornando custo zero** | §15.1 — **falha crítica** |

**A lacuna 7 é falha crítica, não detalhe.** `estimateCostUsd` devolve `0` para modelo fora de `PRICING_USD_PER_MTOK`. **Modelo desconhecido não é gratuito.** No caminho protegido por orçamento, esse zero significa consumo ilimitado sem nunca tocar o teto.

### A3 — O modelo já é configurável; o preço é que não acompanha

`resolveModel(provider, settings.ai_config.models[provider])` valida contra `KNOWN_MODELS` e cai em `DEFAULT_MODELS`. **Gemini 2.5 Flash é default, não hardcode** — está em `DEFAULT_MODELS.gemini`, ao lado de quatro outros provedores, com `FALLBACK_MODELS.gemini` apontando para Pro.

O que falta é o **preço acompanhar o modelo efetivamente resolvido** (§15.1).

### A4 — `MAX_ITERATIONS = 12`

Um turno pode realizar até doze chamadas HTTP ao provedor. Consequências, todas incorporadas:

- **interação/conversa não é unidade financeira** — a mesma conversa pode custar 1× ou 12×;
- uma única invocação pode consumir várias chamadas;
- a reserva existe no **nível do turno**;
- o custo real é consolidado **pelas chamadas internas**;
- **existe verificação antes de cada chamada interna**, para que um turno não consuma orçamento sem controle até a 12ª iteração (§16.2).

Nenhum limite de conversas, interações ou mensagens. O único teto é financeiro.

### A5 — O gate do WhatsApp quebra sob o Plano 2

[whatsapp-service-gate.ts:127](../../../supabase/functions/_shared/whatsapp-service-gate.ts):

```ts
.select("id, status, canceled_at, suspended_at, billing_plans!inner(category)")
.eq("billing_plans.category", "WHATSAPP_SUBSCRIPTION")
.neq("status", "canceled")
.maybeSingle()
```

Sob o Plano 2 **não existe** assinatura dessa categoria: a consulta não retorna linha e uma organização pagante cai em `NOT_ENTITLED`. Detalhado na §14; resolvido na §15-A.

### A6 — Slugs novos estão livres; os antigos estão hardcoded em runtime

`billing_plans.slug` é UNIQUE. Slugs existentes: `sistema-reservas`, `implementacao-whatsapp`, `instancia-whatsapp`, `credito-ia-50|70|100|150|200`, `trial-padrao`. **`plano-reservas` e `plano-automacao` não colidem** e seguem a convenção (kebab-case, sem acento, sem preço, sem modelo de IA, sem quantidade de conexão).

**Mas desativar não basta.** Os slugs antigos aparecem em código de runtime:

| Local | Uso | Impacto |
|---|---|---|
| [manage-whatsapp-implementations:239](../../../supabase/functions/manage-whatsapp-implementations/index.ts) | `.eq("slug", "implementacao-whatsapp")` | resolve o plano da implementação — **permanece correto**, a implementação continua existindo |
| [manage-whatsapp-implementations:626](../../../supabase/functions/manage-whatsapp-implementations/index.ts) | `.in("slug", [três slugs])` **sem filtro `active`** | comentário no próprio código explica que o filtro foi omitido de propósito — logo `active=false` **não** esconde esses preços |
| [manage-whatsapp-implementations:738-740](../../../supabase/functions/manage-whatsapp-implementations/index.ts) | `systemMonthlyCents` / `instanceMonthlyCents` / `implementationOneTimeCents` | **afirma preço ao lojista**: continuaria dizendo R$ 449 + R$ 149/mês |
| [AutomacaoWhatsappCard.tsx:89](../../../src/components/gestao/AutomacaoWhatsappCard.tsx) | `find(p => p.slug === "instancia-whatsapp")` + `contratarInstancia()` | **botão de contratar instância** — o produto que o novo modelo remove |

**O que o runtime ainda pode afirmar ao lojista hoje:** sistema por R$ 449; instância separada por R$ 149/mês; contratação individual de instância. **Isso contradiz o modelo de dois planos.**

O risco está **parcialmente** contido por `whatsapp_subscription_checkout = OFF`. **Flag OFF não resolve incompatibilidade de produto** — ela nega uma ação; o contrato de dados continua errado.

**Exigência da spec — mesmo lote.** No mesmo lote de rollout comercial em que os dois novos planos forem semeados e os antigos retirados da vitrine:

- os call sites cliente-facing deixam de expor a contratação separada de instância;
- `AutomacaoWhatsappCard` deixa de oferecer `contratarInstancia()`;
- a interface passa a oferecer **upgrade para o Plano Automação**;
- os valores apresentados vêm dos **novos** planos;
- a implementação continua aparecendo como **cobrança única separada**;
- produtos antigos permanecem acessíveis **somente** para histórico e compatibilidade legada.

**Não resolver isso apenas com filtro `active`. Não deixar UI nova convivendo com Edge Function que ainda devolve os valores antigos.**

### A6.1 — Histórico versus oferta comercial

As duas leituras do catálogo são diferentes e a spec as separa explicitamente:

| | **HISTÓRICO** | **OFERTA NOVA** |
|---|---|---|
| Resolver produto antigo por slug | **pode** | não |
| `sistema-reservas` | preservado | substituído por `plano-reservas` |
| `instancia-whatsapp` | preservado | **não ofertado separadamente** |
| `credito-ia-*` | preservado | **não ofertado** |
| `implementacao-whatsapp` | preservado | **mantido** — cobrança única |
| Invoices, subscriptions, implementações existentes | preservados, **não alterados** | — |

**Não remover os slugs antigos do banco nem alterar seu significado histórico.** Uma fatura de 2026 que aponta para `instancia-whatsapp` continua significando exatamente o que significava.

### A6.2 — Guardrail de regressão do catálogo

Teste que prova que **superfícies de contratação nova** não dependem mais de `sistema-reservas`, `instancia-whatsapp` nem `credito-ia-*`.

`implementacao-whatsapp` **continua permitido** enquanto for o produto canônico da cobrança única.

**O teste diferencia uso histórico legítimo de uso cliente-facing.** Proibir cegamente qualquer ocorrência textual reprovaria migrations, testes e comentários que precisam mencionar os slugs — [asaas-core.test.ts:398](../../../src/lib/asaas-core.test.ts) usa os valores como fixtures nomeados, e [billing-amount.ts:5](../../../src/lib/billing-amount.ts) os cita em comentário.

Forma proposta: allowlist por **caminho**, não por texto. O guardrail:

- verifica **apenas caminhos declarados** de contratação e apresentação comercial;
- detecta dependência dos slugs antigos **nas superfícies novas**;
- **permite referências históricas legítimas**;
- **exclui migrations, testes e comentários por construção**, não por exceção pontual;
- **falha se uma superfície comercial nova for adicionada ao escopo sem ser classificada**.

O último item é o que impede o guardrail de apodrecer: sem ele, uma tela de contratação criada em 2027 simplesmente não seria varrida, e o teste continuaria verde afirmando algo que deixou de conferir.

**Não fazer grep global** que transforme fixtures e documentação histórica em falso positivo — [asaas-core.test.ts:398](../../../src/lib/asaas-core.test.ts) usa os valores antigos como fixtures nomeados e [billing-amount.ts:5](../../../src/lib/billing-amount.ts) os cita em comentário; os dois são legítimos e permanecem.

### A7 — `whatsapp_instance_cycles.revenue_source` tem CHECK de quatro valores

[088:34](../../../supabase/migrations/20260801200100_088_whatsapp_instance_cycles.sql). Adicionar `PLAN_COMPONENT` exige drop/add do constraint — a única operação desta spec que toca migration aplicada (§1.2).

---

## 1. Modelo de dados aditivo

Toda a DDL abaixo é aditiva. Nenhum `drop` de coluna, nenhum `update` em assinatura existente, nenhuma categoria removida.

### 1.1 `billing_plans` — três colunas novas

```sql
alter table billing_plans
  add column if not exists included_features text[] not null default '{}',
  add column if not exists included_whatsapp_connections integer not null default 0,
  add column if not exists whatsapp_component_cents integer;

alter table billing_plans
  add constraint billing_plans_included_features_chk
  check (included_features <@ array['system','whatsapp','ai']::text[]);

alter table billing_plans
  add constraint billing_plans_included_connections_chk
  check (included_whatsapp_connections >= 0);

alter table billing_plans
  add constraint billing_plans_whatsapp_component_chk
  check (whatsapp_component_cents is null
         or (whatsapp_component_cents >= 0
             and whatsapp_component_cents <= amount_cents));

comment on column billing_plans.included_features is
  'AUTORIZAÇÃO. Features concedidas por este plano além da categoria. '
  'NÃO CONFUNDIR com billing_plans.features, que é copy de marketing '
  'renderizada no PricingCard e não tem efeito sobre acesso.';
```

**Requisitos de `included_features`, todos fechados:**

- tipo controlado (`text[]`), nunca jsonb livre;
- CHECK fechado nos valores reais de `EntitlementFeature` — hoje `system`, `whatsapp`, `ai`;
- sem strings arbitrárias: vocabulário aberto é caminho silencioso para conceder feature que o resolvedor não conhece;
- edição **somente em fluxo administrativo consciente** — campo próprio no formulário de plano, separado do textarea de copy, com confirmação;
- **alteração auditada**: escrita via `manage-billing` com registro de quem mudou, quando, valor anterior e novo;
- **nenhuma dependência de `parsePlanFeatures`**;
- plano legado com array vazio resolve pelo mecanismo de categorias, byte a byte como hoje.

O CHECK `whatsapp_component_cents <= amount_cents` impede que o componente atribuído exceda o que o cliente paga.

### 1.2 `whatsapp_instance_cycles` — novo valor de `revenue_source`

```sql
alter table whatsapp_instance_cycles
  drop constraint if exists whatsapp_instance_cycles_revenue_source_check;

alter table whatsapp_instance_cycles
  add constraint whatsapp_instance_cycles_revenue_source_check
  check (revenue_source is null or revenue_source in (
    'SUBSCRIPTION_SOLE_INSTANCE','AMBIGUOUS_MULTI_INSTANCE',
    'LIFETIME_OVERRIDE','NO_ENTITLEMENT','PLAN_COMPONENT'
  ));
```

**Nenhuma linha existente é reescrita.** Ciclos já fechados mantêm o `revenue_source` que têm — é isso que "congelado historicamente" significa.

### 1.3 Tabelas da Fase 7

`ai_model_prices`, `ai_usage_events`, `ai_cost_reservations`, `ai_cycle_budgets` — DDL nas §15 e §16.

### 1.4 O que NÃO muda

Nenhuma categoria removida do CHECK da 063. Nenhum plano antigo apagado — os cinco pacotes de IA, `instancia-whatsapp` e `implementacao-whatsapp` continuam na tabela, referenciados por faturas históricas. Nenhuma coluna `stripe_*` tocada.

---

## 2. Entitlement dos dois planos

### 2.1 A regra

```
concede(feature) =
     categoria da assinatura ∈ FEATURE_CATEGORIES[feature]
  OU feature ∈ plano.included_features
```

Em [entitlements-core.ts:137](../../../supabase/functions/_shared/entitlements-core.ts), o passo 3 passa de:

```ts
const sub = inputs.subscriptions.find(
  (s) => categories.includes(s.category) && ALLOWED_SUB_STATUSES.has(s.status),
);
```

para:

```ts
const sub = inputs.subscriptions.find(
  (s) =>
    ALLOWED_SUB_STATUSES.has(s.status) &&
    (categories.includes(s.category) || (s.includedFeatures ?? []).includes(feature)),
);
```

`EntitlementSubscriptionInput` ganha `includedFeatures?: string[]`. **Opcional de propósito:** campo ausente resolve exatamente como hoje.

### 2.2 Os dois planos (D1, D2, D9 fechadas)

| | Plano 1 — Reservas | Plano 2 — Automação |
|---|---|---|
| `slug` | `plano-reservas` | `plano-automacao` |
| `amount_cents` | **44990** | **79990** |
| `category` | `SYSTEM_SUBSCRIPTION` | `SYSTEM_SUBSCRIPTION` |
| `billing_type` / `interval` | `recurring` / `month` | `recurring` / `month` |
| `included_features` | `{system}` | `{system,whatsapp,ai}` |
| `included_whatsapp_connections` | **0** | **1** |
| `whatsapp_component_cents` | `null` | **35000** |
| `requires_plan_id` | `null` | `null` (ver §4) |

**Os dois são `SYSTEM_SUBSCRIPTION`.** Deliberado: preserva a garantia da 5a — `isSystemInvoice` continua verdadeiro, a fatura continua autorizada a escrever `organizations.billing_status`, e **nenhuma feature não-sistêmica ganha essa autoridade**. O Plano 2 não é categoria nova; é o mesmo produto financeiro declarando que inclui mais coisas.

O Plano 2 inclui tudo do Plano 1, uma conexão de WhatsApp, chat, automações, confirmações e lembretes, e IA com franquia financeira interna de até R$ 100 por ciclo. **A implementação continua separada, como cobrança única.**

### 2.3 IA: o ramo que muda

Hoje ([entitlements-core.ts:170-187](../../../supabase/functions/_shared/entitlements-core.ts)) a IA resolve por override → carteira → herança de `system`. Com franquia inclusa, entra um degrau **entre** override e carteira:

```
1. override de ai (bloqueio ou concessão)              — inalterado
2. franquia: system permitido E 'ai' ∈ includedFeatures
     → allowed = orçamento do ciclo não esgotado        — NOVO
3. carteira (aiWalletBalanceCents definido)             — inalterado, legados
4. herança de system (pré-carteira)                     — inalterado, legados
```

`FeatureEntitlement` ganha `source: "franchise"` e `status: "within_budget" | "budget_exhausted"`.

**`balanceCents` não é reusado** — significa "crédito do cliente", e franquia não é crédito do cliente. Campo próprio `budgetRemainingCents`, que **nunca vai ao frontend do lojista** (§16.4).

---

## 3. Contratação

**Plano 1.** Checkout do `create-billing-checkout`, `SYSTEM_SUBSCRIPTION`, sem mudança de fluxo. `whatsapp` e `ai` negados; chat, automações e agente não aparecem no menu.

**Plano 2.** Mesmo checkout, plano diferente. No pagamento confirmado: `system` e `ai` liberados; `whatsapp` **entitled mas não operacional** até a implementação concluir (§16-op). Esse estado precisa estar antecipado na copy do produto, senão o cliente paga e acha que quebrou.

### 3.1 Trial (D3, D4 fechadas)

**O trial inclui apenas `system`.**

Durante o trial: acesso ao sistema e às reservas web; **sem** WhatsApp automatizado, **sem** chat operacional de WhatsApp, **sem** IA, **sem** criação de instância, **sem** custo de Z-API, **sem** implementação automática.

Motivo: ativar WhatsApp no trial criaria custo real de Z-API (R$ 99,90, irrecuperável) antes de receita confirmada, e exigiria trabalho humano de implementação. O cliente conhece o Plano 2 por **demonstração comercial**, não por instância real.

**Ao fim do trial:**

- **não** converter automaticamente para plano pago;
- exigir contratação e **pagamento confirmado**;
- sem pagamento, aplicar o fluxo já aprovado de expiração (`process-trial-expiry`);
- **não** criar assinatura, cobrança ou implementação presumida;
- **não** presumir Plano 1 como fallback pago;
- **não** criar instância.

Com contratação confirmada do Plano 1 → ativa Plano 1. Com contratação confirmada do Plano 2 → segue o fluxo de implementação antes do WhatsApp.

---

## 4. Implementação do WhatsApp

Inalterada. Cobrança única `WHATSAPP_IMPLEMENTATION`, máquina de estados própria em `whatsapp_implementations`, dois eixos (pagamento × operacional), no máximo uma linha não-cancelada por organização.

O que muda é só o **gatilho**: contratar ou fazer upgrade para o Plano 2 abre a pendência.

**Não usar `requires_plan_id` para amarrar Plano 2 → implementação.** Ele é validado como pré-requisito de *checkout*, e exigir implementação paga antes de assinar inverte a ordem comercial. A dependência correta é **operacional**, não de checkout (§16-op).

Override administrativo de dispensa (`WAIVED`) continua valendo — é como o Ren Sushi opera.

---

## 5. Upgrade Plano 1 → Plano 2 (D8 fechada)

**Não implementar prorrata automática na primeira versão.**

Fluxo aprovado:

1. cliente solicita upgrade;
2. contratação da implementação é criada, quando necessária;
3. implementação pode ser preparada em paralelo;
4. a mudança entra como **transição agendada**;
5. o Plano 2 passa a valer **no próximo ciclo de cobrança**, após pagamento confirmado;
6. o WhatsApp só é ativado quando as **quatro** condições valerem:
   1. Plano 2 financeiramente ativo,
   2. implementação `COMPLETED` **ou** `WAIVED`,
   3. capacidade de conexão disponível (§10),
   4. instância criada manualmente na Z-API **e** registrada no inventário.

Restrições explícitas:

- **não** criar duas `SYSTEM_SUBSCRIPTION` ativas simultaneamente;
- **não** escolher a assinatura mais recente (§15-D);
- **não** cancelar a assinatura antiga antes de a nova transição estar confirmada.

Franquia de IA: passa a valer com o Plano 2, **a partir do ciclo em que ele entra em vigor**. Sem proporcionalidade — R$ 100 é teto de proteção, não crédito comprado.

Upgrade imediato com diferença proporcional, se algum dia for exigido pelo produto, **ganha spec própria** cobrindo: diferença proporcional, transição no Asaas, idempotência, rollback, duplicidade e data de vigência. **A prioridade atual é simplificar o billing, não criar prorrata.**

---

## 6. Downgrade Plano 2 → Plano 1

**Invariante desta spec: a Fase 6c existe antes do downgrade. Sem exceção.**

**Revogar o recurso no SaaS nunca significa que o custo no provider foi cancelado.** A Z-API continua cobrando até você cancelar no painel dela.

Sequência obrigatória:

1. transição de plano → `included_features` vira `{system}`;
2. **revogar o entitlement de WhatsApp** — o agente para, o chat some do menu;
3. **identificar instâncias que continuam gerando custo** (`lifecycle_state` ≠ `ENDED`);
4. **abrir `request_cancellation`** com motivo automático `"downgrade para Plano 1"`;
5. **apresentar a pendência no painel** — não só em tabela ou log;
6. **lembrar o platform_admin** — D-7 e D-1 do worker de ciclos;
7. **exigir cancelamento manual na Z-API** — não há outro caminho; a API de Parceiro é a Fase 6a e não existe;
8. **exigir confirmação de encerramento** no painel;
9. **preservar `provider_access_until`** — o cliente pagou o ciclo, o acesso vai até o fim dele;
10. **não mover automaticamente para `ENDED`**.

Até `ENDED`, o inventário **continua contando o custo**, porque ele continua sendo cobrado.

Proibições:

- não lançar downgrade antes da 6c;
- não esconder a pendência apenas em tabela ou log;
- não depender de o administrador lembrar manualmente.

Sem a superfície operacional da 6c, o downgrade deixa custo invisível de R$ 99,90/mês correndo indefinidamente.

---

## 7. Inadimplência

Uma fatura só, categoria `SYSTEM_SUBSCRIPTION`. `process-billing-overdue` escala normalmente: tolerância 5 dias, bloqueio D+6, `organizations.billing_status` → `blocked`.

O gate lê `organizations.billing_status` como pai — **nunca** `entitlements.system.allowed`, pelo invariante em [whatsapp-service-state-core.ts:98](../../../supabase/functions/_shared/whatsapp-service-state-core.ts). Bloqueado o sistema, bloqueado o WhatsApp junto: é a mesma fatura.

**`SUSPENDED_UNPAID` isolado torna-se inalcançável para contratos novos.** Isso **não** é motivo para remover nada: `process-whatsapp-enforcement`, os sete estados e `LEGACY_GRANDFATHERED` continuam sendo o único caminho correto para organizações legadas.

A instância **não** é cancelada por inadimplência. Cancelar na Z-API por cinco dias de atraso e ter que recriar (QR novo, sessão nova, histórico perdido) na regularização é pior que absorver um ciclo.

---

## 8. Restauração

Pagamento reconhecido → `billing_status` volta a `active` → o gate reabre na próxima resolução (`clearWhatsAppGateCache` para o caminho síncrono).

**Não há reprovisionamento**, porque não houve desprovisionamento.

`process-billing-unblock` é a defesa dupla do webhook. A lacuna documentada no CLAUDE.md — `isSystemInvoice` caindo no caminho 3 (compatibilidade legada, devolve `true`) quando a fatura não carrega vínculo de plano — **deixa de ser perigosa** com dois planos ambos `SYSTEM_SUBSCRIPTION`: não existe mais fatura recorrente de outra categoria capaz de satisfazer o gate por engano. **O modelo de dois planos fecha essa lacuna por construção.** Ela permanece aberta apenas para legados com assinatura de instância.

Franquia de IA: reativa na **abertura do ciclo seguinte**, não na regularização (§16.5).

---

## 9. Cancelamento total

1. `cancel_subscription_by_owner` → `cancel_at_period_end` (comportamento atual preservado);
2. no fim do período: `billing_status` → `canceled`, entitlements caem;
3. **abre `request_cancellation`** — mesma mecânica do downgrade, mesmo motivo;
4. você cancela na Z-API e confirma → `ENDED`;
5. dados preservados; `whatsapp_implementations` não é apagada.

**Cliente que volta:** instância `ENDED` não ressuscita. Linha nova, instância física nova, QR novo. `lifecycle_state` é registro histórico de custo, não interruptor.

O roteamento por `getBillingProvider` (gravar o estado a partir do `effective` que o provedor devolve, nunca do pedido) permanece como está.

---

## 10. Conexão incluída e limite (D9 fechada)

**Plano 1: zero conexão. Plano 2: exatamente uma.**

Validado server-side por `billing_plans.included_whatsapp_connections`.

**Contagem de uso:** instâncias que ainda geram **ou podem gerar** custo — `lifecycle_state` ≠ `ENDED`. Instância em `CANCELLATION_REQUESTED` **conta**: ela ainda custa.

**Não permitir segunda conexão por nenhuma via:** frontend, chamada direta à EF, backfill disfarçado, override implícito ou cadastro duplicado.

**Dois pontos de verificação, não um:**

- `register_instance` no `manage-whatsapp-instances` — onde o **custo** entra;
- `manage-channels` — onde o **envio** se habilita.

Verificar só um deixa a outra porta aberta. A verificação entra em `resolveProvisioningEligibility`, que já é fail-closed, com motivo próprio `CONNECTION_LIMIT_REACHED`.

Por que não é opcional: margem incremental do Plano 2 é R$ 350,00; segunda instância custa R$ 99,90 sem receita. Duas instâncias no pior caso de IA deixam R$ 50,10; três tornam o plano deficitário.

**Casos com mais de uma conexão ficam como proposta personalizada** — plano `CUSTOM` com `included_whatsapp_connections` maior e `whatsapp_component_cents` correspondente. **Não criar agora:** checkout de conexão adicional, preço automático, produto público de instância, provisionamento Partner.

---

## 11. Integração com a Fase 6b

| Peça | Status |
|---|---|
| Inventário, lifecycle, custo, vencimento, ciclos | **inalterado** |
| Alertas D-7/D-1, ledger, contadores | **inalterado** |
| Divergências (as cinco) | **inalterado** |
| `request_cancellation` / `confirm_end` | **inalterado, e mais usado** — vira o gancho de §6 e §9 |
| Painel | ganha o componente de plano na exibição de receita |
| `attributeRevenue` | **única peça que muda** (§12) |

A 6b mede **custo do fornecedor**, e custo do fornecedor não depende de como você cobra do cliente. Nenhum dado, tabela, categoria ou histórico é removido.

---

## 12. Receita `PLAN_COMPONENT`

### Por que não as outras três

- **Mensalidade inteira por instância** — toda organização parece lucrativa; erro que o cabeçalho do núcleo já proíbe por escrito.
- **Cópia integral para cada instância** — infla em N×.
- **Rateio proporcional ao custo** — circular: usa o custo para justificar a receita que mede o custo.

### O que `PLAN_COMPONENT` é

Valor contratual explícito, definido por você ao precificar, gravado no plano e **congelado no ciclo na abertura** — como `provider_cost_cents` já é.

Não é arbitrário: R$ 799,90 − R$ 449,90 = **R$ 350,00** é o preço incremental da capacidade de automação.

### A mudança no núcleo

`attributeRevenue` ganha um input e um degrau. A ordem importa:

```
1. hasLifetimeWhatsappOverride        → 0, LIFETIME_OVERRIDE           (inalterado)
2. planWhatsappComponentCents ≠ null
     e activeInstanceCount == 1       → componente, PLAN_COMPONENT      (novo)
2b. mesmo, com activeInstanceCount > 1 → null, AMBIGUOUS_MULTI_INSTANCE (novo)
3. subscriptionAmountCents == null    → null, NO_ENTITLEMENT           (inalterado)
4. activeInstanceCount > 1            → null, AMBIGUOUS_MULTI_INSTANCE (inalterado)
5. senão                              → assinatura, SUBSCRIPTION_SOLE_INSTANCE (inalterado)
```

O override vitalício continua **primeiro**: o Ren Sushi não paga nada, e `0` ali é zero verdadeiro, não "não sei".

O passo 2b existe porque a ambiguidade não desaparece com o componente — só muda de causa. Com o limite da §10, é caminho de exceção (plano `CUSTOM`), e devolve `null`, nunca divide.

### Congelamento

`customer_revenue_cents`, `revenue_source` e `customer_revenue_snapshot_at` já são gravados na abertura. Reajustar o preço em 2027 **não** reescreve a margem de 2026.

---

## 13. Margem com Z-API e IA

Seis números separados, nunca um agregado que esconda a origem:

| Linha | Valor | Origem |
|---|---|---|
| Receita total do plano | R$ 799,90 | `billing_plans.amount_cents` |
| Componente do sistema | R$ 449,90 | derivado: `amount_cents − whatsapp_component_cents` |
| Componente de automação | R$ 350,00 | `whatsapp_component_cents`, congelado no ciclo |
| Custo Z-API | R$ 99,90 | `whatsapp_instance_cycles.provider_cost_cents` |
| Custo real de IA | medido | agregado de `ai_usage_events` no ciclo |
| **Margem incremental** | componente − Z-API − IA | derivada, **nunca armazenada** |

O componente do sistema não entra na margem incremental: ele paga o sistema.

Custo desconhecido é `null`, **nunca zero** — a regra de `consolidateOrgMargin` (custo desconhecido em qualquer instância impede a consolidação) vale igual para IA.

### Cenários (R$ 799,90)

| Custo de IA no ciclo | Z-API | Custo total | **Margem** | % sobre o componente |
|---|---|---|---|---|
| R$ 20 | 99,90 | 119,90 | **R$ 230,10** | 66% |
| R$ 50 | 99,90 | 149,90 | **R$ 200,10** | 57% |
| R$ 70 (1º alerta) | 99,90 | 169,90 | **R$ 180,10** | 51% |
| R$ 90 (crítico) | 99,90 | 189,90 | **R$ 160,10** | 46% |
| **R$ 100 (hard stop)** | 99,90 | 199,90 | **R$ 150,10** | **43%** |

**Pior caso conhecido: 43%.** É isso que o teto compra — sem ele não existe pior caso.

**PENDENTE, não estimado:** taxa de cartão e boleto do Asaas (a única documentada é PIX R$ 0,99 sobre R$ 19,90, em [03-ASAAS-API-VERIFICADO.md:225](../../billing-asaas/03-ASAAS-API-VERIFICADO.md)); impostos; custo de Supabase/Vercel por organização.

Dado real de campo: 1.600 conversas por menos de R$ 200 ≈ R$ 0,125 por conversa. Nesse patamar seriam ~800 conversas para tocar o teto. **Confirma a decisão:** limitar conversas restringiria comercialmente sem proteger financeiramente.

---

## 14. Gate do WhatsApp — maior risco da transição

**Ponto crítico confirmado.**

[whatsapp-service-gate.ts:127](../../../supabase/functions/_shared/whatsapp-service-gate.ts) filtra `billing_plans.category = 'WHATSAPP_SUBSCRIPTION'` e usa `.maybeSingle()`.

Sob o Plano 2:

- não haverá `WHATSAPP_SUBSCRIPTION` separada;
- a consulta não retorna linha;
- **uma organização pagante pode cair em `NOT_ENTITLED`**.

**A query gêmea de [process-whatsapp-enforcement:194](../../../supabase/functions/process-whatsapp-enforcement/index.ts) muda no mesmo commit.** Ela é campo-a-campo idêntica por invariante escrito no CLAUDE.md: divergir uma sem a outra faz o worker de suspensão e o gate de envio discordarem sobre quem está inadimplente.

**Não corrigir apenas um consumidor.**

---

## 15. Resolução explícita de assinaturas

**Não substituir `.maybeSingle()` por "pegar a mais recente".**

Buscar **todas** as candidatas relevantes (sem `.maybeSingle()`, com ordenação determinística) e passar **fatos normalizados** para um **núcleo puro de resolução**, testado por vitest.

O resolvedor distingue: assinatura SYSTEM do Plano 1; SYSTEM do Plano 2 com `whatsapp` incluído; legada `WHATSAPP_SUBSCRIPTION`; cancelada; terminal; duplicidade; transição de plano; override ativo; implementação não concluída.

**Prioridade geral preservada:**

```
ADMIN_BLOCKED > OVERRIDE_ACTIVE > assinatura > LEGACY_GRANDFATHERED > NOT_ENTITLED
```

Dentro da camada de assinatura, os quatro casos são explícitos:

**A — contrato novo.** `SYSTEM_SUBSCRIPTION` ativa cujo plano inclui `whatsapp` → o `financialState` do WhatsApp **é** o da assinatura do sistema. É a única leitura coerente: quem financia a feature define seu estado financeiro.

**B — contrato legado.** `WHATSAPP_SUBSCRIPTION` ativa → continua usando a fonte financeira legada, sem mudança.

**C — transição, as duas existem.** Nunca lançar por `.maybeSingle()`. Nunca escolher por `created_at`. O resolvedor **identifica a transição**, impede dupla cobrança, **mantém o serviço sem interrupção quando houver ao menos uma fonte inequivocamente válida**, e **gera pendência administrativa** para encerrar a obrigação legada. **Provisionamento novo permanece fail-closed em ambiguidade** — as duas polaridades opostas do gate (envio fail-open, provisionamento fail-closed) são preservadas.

**D — duplicidade inesperada na mesma categoria.** Erro/revisão. **Nunca escolher silenciosamente.** Nenhuma instância nova. Telemetria e alerta ao platform_admin.

O resolvedor é **núcleo puro** — zero I/O, importável por Edge Functions e por vitest. `whatsapp-service-gate.ts` e `process-whatsapp-enforcement` chamam **o mesmo** resolvedor: é o que torna estrutural a garantia que hoje depende de disciplina humana de manter duas queries idênticas.

---

## 16. Implementação como gate operacional

Feature comercial `whatsapp` no Plano 2 **não** significa que o envio pode começar. Cinco camadas separadas:

| Camada | Pergunta | Fonte |
|---|---|---|
| **Entitlement financeiro** | o plano inclui `whatsapp` e a assinatura está ativa? | §15 |
| **Readiness operacional** | implementação `COMPLETED` ou `WAIVED`? | `whatsapp_implementations` |
| **Capacidade** | há conexão incluída disponível? | §10 |
| **Canal** | instância existe e está configurada? | `whatsapp_instances` + `whatsapp_channels` |
| **Enforcement** | a consequência é aplicada? | flags aprovadas |

Confundir as camadas produz os dois erros opostos: negar serviço a quem pagou, ou habilitar envio sem instância.

**Pagamento do Plano 2 não cria instância. Pagamento da implementação não cria instância. Tudo continua manual no provider.**

---

## 17. Franquia de IA — Fase 7 redefinida

A Fase 7 foi desenhada como **carteira pré-paga**. O modelo aprovado é **franquia financiada pela plataforma**: o cliente não compra nada, o teto é interno, e ele nunca vê valores de custo.

| Peça da 7 | Destino |
|---|---|
| `ai_usage_events` | **mantida e ampliada** (§17.2) |
| Preço versionado por modelo | **mantida e mais necessária** |
| Reserva antes / consolidação depois | **mantida e endurecida** (§17.4-17.5) |
| Idempotência por `request_id` | **mantida**, mais `turn_id` |
| Carteira com saldo do cliente | **substituída** por orçamento de ciclo |
| Pacotes `AI_CREDIT_PACKAGE` | **inativados** para venda, preservados no histórico |
| Recarga automática (Fase 8) | **cancelada** — não há o que recarregar |
| Flag `ai_wallet_enforced` (semeada, OFF) | **reusada** como gate de franquia |

Organizações legadas com `aiWalletBalanceCents` definido continuam no ramo de carteira.

### 17.1 Preços versionados (D5 fechada)

```sql
create table if not exists ai_model_prices (
  id                       uuid primary key default gen_random_uuid(),
  provider                 text not null,
  model                    text not null,
  input_usd_per_mtok       numeric(12,6) not null,
  output_usd_per_mtok      numeric(12,6) not null,
  cache_read_usd_per_mtok  numeric(12,6) not null default 0,
  cache_write_usd_per_mtok numeric(12,6) not null default 0,
  reasoning_usd_per_mtok   numeric(12,6),
  usd_to_brl               numeric(12,6) not null,
  effective_from           timestamptz not null,
  effective_to             timestamptz,
  created_at               timestamptz not null default now()
);
```

Vigência fechada por `effective_from`/`effective_to`. `usd_to_brl` fica **na linha de preço**, não em variável global: a taxa vigente faz parte da vigência, e um câmbio "atual" aplicado a consumo antigo produziria custo histórico que muda sozinho.

**Não recalcular consumo histórico quando preço ou câmbio mudarem.**

**Modelo sem preço vigente — fail-closed, decisão fechada:**

- **não** chamar o provider;
- **não** assumir custo zero;
- **não** usar preço de modelo semelhante;
- **não** usar fallback silencioso;
- **não** consumir a franquia com estimativa falsa;
- encaminhar o atendimento para humano;
- registrar alerta para platform_admin;
- registrar provider, modelo e organização **de forma sanitizada** — nunca a chave, nunca o objeto de credenciais;
- permitir nova tentativa **somente depois** de o preço ser cadastrado.

Trocar de modelo sem cadastrar o preço pode interromper a IA daquela organização. **Custo operacional aceitável e preferível a furar o teto silenciosamente.**

**`estimateCostUsd` não pode continuar devolvendo zero para modelo desconhecido no caminho protegido pelo orçamento.** Deve devolver **resultado discriminado**, erro tipado ou estado `PRICE_UNKNOWN`:

```ts
type CostResult =
  | { kind: "PRICED"; usd: number; brl_cents: number; priceId: string }
  | { kind: "PRICE_UNKNOWN"; provider: string; model: string };
```

Sob `strict: false` do `tsconfig.app.json`, estreitar união discriminada exige `x.kind === "PRICED"` ou early-return — `if (!x.priced) { x.usd }` **não** estreita. Invariante já registrado no CLAUDE.md, e vale aqui.

O caminho de telemetria pura pode continuar tolerando desconhecido; **o caminho de orçamento, não.**

### 17.2 Eventos de uso

Cada evento registra, conforme decidido:

```sql
create table if not exists ai_usage_events (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references organizations(id) on delete restrict,
  cycle_id            uuid not null references ai_cycle_budgets(id),
  unit_id             uuid references units(id) on delete set null,
  conversation_id     uuid,
  turn_id             text not null,
  request_id          text not null,
  provider            text not null,
  model               text not null,          -- modelo EXATO resolvido
  price_id            uuid not null references ai_model_prices(id),
  input_tokens        integer not null default 0,
  output_tokens       integer not null default 0,
  cache_read_tokens   integer not null default 0,
  cache_write_tokens  integer not null default 0,
  reasoning_tokens    integer not null default 0,
  cost_usd            numeric(12,6) not null,
  usd_to_brl          numeric(12,6) not null, -- taxa efetivamente usada
  cost_brl_cents      integer not null,
  call_id             text not null,
  usage_state         text not null default 'SETTLED'
                        check (usage_state in (
                          'SETTLED','USAGE_REVIEW_REQUIRED',
                          'FAILED_BEFORE_PROVIDER','PROVIDER_FAILED')),
  idempotency_key     text not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (organization_id, idempotency_key)
);
```

`price_id` é **NOT NULL**: um evento de uso financeiro só pode existir quando o sistema conhece provider, modelo, preço, vigência, unidade de cobrança e custo calculável. O fail-closed impede a chamada antes disso. É a "versão de preço usada" — auditável mesmo depois de a vigência fechar.

`cycle_id` referencia o orçamento do ciclo, não um par de datas soltas: as datas ficam no orçamento, e o evento aponta para ele. Evita que dois eventos do mesmo ciclo discordem sobre onde o ciclo começa.

`turn_id` agrupa as até 12 chamadas de um turno; `request_id` identifica a chamada. Os dois são necessários: reserva é por turno, consolidação é pelas chamadas internas. `idempotency_key` é o que o UNIQUE protege — derivado de `request_id`, mas nomeado pelo papel que exerce.

**Não recalcular eventos históricos depois que preço ou câmbio mudarem.**

FORCE RLS **com** policy `platform_admin_all_*`, seguindo 087/088/089. O lojista nunca lê esta tabela.

### 17.2.1 — Usage ausente ou inconsistente

Vocabulário fechado de `usage_state`, ajustável ao schema real:

| Estado | Significado |
|---|---|
| `SETTLED` | custo real conhecido e apropriado |
| `USAGE_REVIEW_REQUIRED` | **chamada ocorreu, custo indeterminado** |
| `FAILED_BEFORE_PROVIDER` | negada antes de qualquer I/O externo — custo zero **verdadeiro** |
| `PROVIDER_FAILED` | provider falhou sem consumo apurável |

`FAILED_BEFORE_PROVIDER` é o **único** estado em que zero é uma afirmação legítima, porque é o único em que se sabe que nada foi consumido.

**Se o provider realizar a chamada mas não devolver usage suficiente:**

- **não** gravar custo zero;
- **não** criar evento aparentemente liquidado;
- manter **estimativa conservadora comprometida**;
- **impedir liberação automática que possa furar o teto**;
- gerar **pendência administrativa**;
- permitir **reconciliação posterior**;
- registrar `provider`, `model`, `turn_id` e `call_id`;
- **não registrar o payload integral da resposta** — vale o invariante do CLAUDE.md sobre não copiar objeto completo nem segredo.

**Fail-closed cobre as duas ignorâncias: preço desconhecido e consumo desconhecido.** São falhas diferentes com a mesma consequência — não é possível afirmar quanto custou, logo não é possível afirmar que cabe no teto.

### 17.2.2 — Política das reservas com usage pendente

Uma reserva cuja chamada ocorreu mas cujo custo é indeterminado **não pode**:

- permanecer eternamente sem alerta;
- **nem expirar e liberar todo o valor automaticamente**, como se nada tivesse sido consumido.

Os dois extremos são erros opostos e igualmente ruins: o primeiro trava a organização para sempre; o segundo transforma o TTL de recuperação de crash (§17.4) numa **porta de saída para consumo não contabilizado** — bastaria toda resposta vazia esperar cinco minutos para o custo desaparecer.

Portanto: reserva com `USAGE_REVIEW_REQUIRED` **sai do caminho da varredura de expiração** e entra em fila de reconciliação. A resolução é **administrativa ou por reconcile seguro** — nunca por decurso de prazo.

O `process-asaas-invoice-reconcile` é o precedente de forma: worker que reprocessa pendências, retém divergência em vez de decidir sozinho, e enfileira aviso ao platform_admin quando a retenção persiste.

### 17.3 Orçamento do ciclo

A âncora de tudo. Uma linha por (organização, ciclo), criada na abertura do ciclo da assinatura de sistema.

```sql
create table if not exists ai_cycle_budgets (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references organizations(id) on delete restrict,
  cycle_start       date not null,
  cycle_end         date not null,   -- EXCLUSIVO: 1º dia NÃO coberto (§17.3)
  limit_cents       integer not null,
  settled_cents     integer not null default 0 check (settled_cents >= 0),
  state             text not null default 'OPEN'
                      check (state in ('OPEN','EXHAUSTED','CLOSED')),
  exhausted_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (organization_id, cycle_start)
);
```

`limit_cents` é **congelado na abertura**, não lido do plano a cada consulta — mesma razão de `provider_cost_cents` e `whatsapp_component_cents` serem congelados: mudar o teto em 2027 não pode reescrever o que foi permitido em 2026. Valor inicial: **10000** (R$ 100,00).

`settled_cents` é o custo **liquidado**; o disponível é `limit_cents − settled_cents − Σ(reservas HELD)`. O orçamento nunca soma reservas na própria coluna — reserva não é gasto, é promessa de gasto, e misturá-las tornaria impossível distinguir "gastei" de "posso vir a gastar".

`state` é derivável de `settled_cents >= limit_cents`, mas é persistido de propósito: `exhausted_at` precisa de um momento, e o momento não é derivável depois.

**Convenção de datas: `cycle_start` INCLUSIVO, `cycle_end` EXCLUSIVO — o primeiro dia NÃO coberto.** Idêntica a `provider_access_until` da 6b, pelo mesmo motivo registrado no CLAUDE.md: o nome admitia duas leituras e a diferença de um dia é a que erra a virada. A UI escreve "renova em `cycle_end`".

**Invariantes de schema e domínio:**

- `cycle_start < cycle_end`;
- `limit_cents >= 0`;
- `settled_cents >= 0`;
- **moeda explícita ou BRL como contrato fechado** — o custo do provedor é USD e o teto é BRL; sem a moeda declarada, uma comparação errada passa despercebida por três ordens de grandeza;
- **uma organização não pode ter dois budgets concorrentes para o mesmo ciclo**;
- **ciclos da mesma organização não podem se sobrepor silenciosamente**;
- **ciclo fechado não tem `limit_cents` reescrito** por mudança futura de plano;
- **reativação ou troca de plano não cria dois budgets para o mesmo intervalo**.

Os dois últimos são o caminho real de defeito: upgrade no meio do ciclo, reativação após inadimplência e troca de plano são exatamente os momentos em que um segundo budget nasceria sobrepondo o primeiro — e dois budgets no mesmo intervalo significam **teto dobrado sem ninguém decidir isso**.

**O mecanismo de unicidade e de não sobreposição fica em aberto até conferir o schema real** — `unique (organization_id, cycle_start)` cobre o duplicado exato, mas **não** cobre sobreposição parcial; um `exclusion constraint` com `daterange` cobriria, ao custo de exigir `btree_gist`. A escolha é de implementação; **o invariante é da spec** e não depende dela.

### 17.4 Reservas

```sql
create table if not exists ai_cost_reservations (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations(id) on delete restrict,
  cycle_id         uuid not null references ai_cycle_budgets(id),
  turn_id          text not null,
  reserved_cents   integer not null check (reserved_cents >= 0),
  consumed_cents   integer not null default 0 check (consumed_cents >= 0),
  released_cents   integer not null default 0 check (released_cents >= 0),
  status           text not null default 'HELD'
                     check (status in ('HELD','SETTLED','RELEASED','EXPIRED')),
  idempotency_key  text not null,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  finalized_at     timestamptz,
  unique (organization_id, idempotency_key)
);
```

`consumed_cents` acompanha o gasto **dentro** do turno — é o que permite revalidar por chamada (§17.5) **sem consultar o ledger financeiro inteiro a cada iteração**. A reserva é a fonte operacional do turno; o ledger é a fonte de verdade do ciclo.

**A reserva pertence ao TURNO; cada chamada interna apropria parte dela.** A mesma reserva cobre a chamada inicial, as chamadas posteriores do loop, o fallback, e as chamadas depois de ferramentas não mutantes. **Cada chamada tem identidade própria dentro do turno** (`call_id`), e o fallback **não cria uma segunda reserva de turno**.

**Invariantes:**

- `consumed_cents` **nunca diminui**;
- `consumed_cents` **nunca é negativo**;
- `consumed_cents` **não ultrapassa `reserved_cents` como comportamento normal** — quando ultrapassa, é overage observável (§17.5);
- **uma `call_id` não liquida duas vezes**;
- **o mesmo `request_id` não cria duas reservas**;
- **o consumo de cada chamada é apropriado ANTES da próxima autorização** — sem isso, a 2ª chamada decide com o saldo de antes da 1ª;
- toda atualização é **atômica**;
- reexecução com a mesma `idempotency_key` **não debita novamente**;
- **reserva expirada não autoriza chamada**;
- **reserva finalizada não volta a ativa** — `SETTLED`/`RELEASED`/`EXPIRED` são terminais.

**`expires_at` é obrigatório.** Reserva não liquidada nem liberada — crash, timeout, deploy no meio do turno — consumiria teto para sempre. TTL sugerido: 5 minutos, acima do pior caso (12 iterações × 45s de timeout, com o hard limit de 60s da Edge Function como teto real). Varredura de expiradas roda junto com o worker mais frequente.

`finalized_at` (em vez de `settled_at`) porque os três estados terminais precisam de carimbo, não só a liquidação — uma reserva `EXPIRED` sem data de finalização é indistinguível de uma que nunca foi varrida.

### 17.5 Teto e reserva (D6 fechada)

**Não aprovado:** "o ciclo pode ultrapassar R$ 100 pelo custo de uma invocação inteira". Com `MAX_ITERATIONS = 12`, aceitar isso enfraqueceria o teto exatamente nos atendimentos mais complexos.

**Regra aprovada:**

- teto de **R$ 100 por organização e por ciclo**;
- **reserva atômica antes de iniciar o turno**;
- reserva baseada em **estimativa conservadora**;
- **limites máximos de tokens configurados por provider/modelo**;
- **revalidação do orçamento antes de cada chamada interna**;
- consolidação do custo real ao final;
- liberação da diferença reservada e não utilizada;
- liberação total em falha sem consumo;
- idempotência por `request_id` / `turn_id`;
- **lock ou operação atômica** impedindo concorrência ultrapassar o teto.

**Fórmula do teto.** A decisão financeira considera três grandezas **separadamente**:

```
available_cents =
    limit_cents
  − settled_cents                      -- gasto LIQUIDADO
  − active_reserved_remaining_cents    -- capacidade COMPROMETIDA
```

Uma nova autorização só existe quando **a reserva solicitada cabe em `available_cents`**.

**Não usar `settled_cents + reserved_cents` como um único campo semântico.** Reserva é capacidade comprometida, não gasto realizado — colapsar as duas torna impossível responder "quanto essa organização realmente custou neste ciclo?", que é a pergunta que a margem da §13 depende.

`active_reserved_remaining_cents` é o **restante** das reservas `HELD` (`reserved_cents − consumed_cents`), não o valor original: a parte já consumida migrou para `settled_cents` e contá-la duas vezes bloquearia organizações que ainda têm saldo.

**A leitura e a criação da reserva ocorrem de forma atômica**, com lock de linha ou RPC equivalente. Sem isso, duas invocações concorrentes leem o mesmo `available_cents` e ambas reservam contra ele — o modo clássico de furar um teto que "está implementado".

**Durante o turno, antes de cada chamada adicional:**

- verificar se a reserva restante cobre a próxima chamada;
- se não cobrir, **não iniciar** uma nova chamada;
- encerrar o fluxo de forma segura;
- preservar a conversa;
- encaminhar para humano;
- **nunca truncar uma resposta já recebida do provider**;
- **não iniciar uma chamada que não possa ser coberta**.

**Se o custo real de uma chamada já autorizada exceder a reserva** por diferença de contabilização do provider:

- liquidar o custo real **integralmente**;
- **bloquear chamadas posteriores**;
- registrar o overage como **incidente**;
- alertar platform_admin;
- **não tratar como comportamento normal nem como margem comercial aceita**.

A meta arquitetural é **não ultrapassar R$ 100**. Diferença inevitável de uma chamada já iniciada é **exceção operacional observável**, não franquia adicional.

### 17.6 O ciclo completo

```
1. RPC reserve_ai_budget(org, turn_id, estimativa)   — SECURITY DEFINER,
   lock de linha do orçamento; checa o teto DENTRO da mesma operação
2. negado → nenhuma chamada ao provider; handoff humano
3. concedido → chamada 1
4. antes de cada chamada seguinte (até a 12ª):
   reserva restante cobre a próxima? não → encerra em segurança
5. onUsage devolve tokens reais → grava ai_usage_events (custo BRL, price_id)
   e incrementa consumed_cents
6. fim do turno → settle_ai_reservation(org, turn_id, custo_real)
   → SETTLED; diferença volta ao disponível
7. falha do provider sem consumo → release_ai_reservation → RELEASED
8. crash → expires_at recupera
```

**O passo 1 é atômico e é onde o teto é aplicado.** Verificar depois da chamada não é proteção: é detecção.

### 17.7 Onde isso se conecta ao código existente

O ponto de consolidação **já existe**: [webhook-whatsapp:2543](../../../supabase/functions/webhook-whatsapp/index.ts) agrega `totalUsage` e loga `agent_usage`. Passos 5 e 6 entram ali.

O passo 1 entra **antes** do `runOnce()` ([linha 2456](../../../supabase/functions/webhook-whatsapp/index.ts)), junto do gate de serviço que já roda naquele caminho.

O passo 4 exige um **hook novo** dentro de `runAgentLoop` — hoje `onUsage` só reporta *depois* da chamada, e não existe ponto de decisão antes dela. **É a única mudança estrutural no `ai-providers.ts`**, e vale para os cinco provedores.

O passo 7 aproveita o tratamento existente: exceção em `runAgentLoop` já vira auto-handoff.

### 17.7.1 — `beforeCall` NÃO é boolean

Um `Promise<boolean>` não diferencia teto atingido, reserva insuficiente, preço desconhecido, usage anterior pendente, erro no banco, falha ao adquirir lock, configuração inválida e cancelamento da invocação. Isso enfraquece a observabilidade e — pior — **transforma falha de infraestrutura em hard stop comercial**: um soluço de banco viraria "franquia esgotada" para o cliente, com a copy errada e o alerta errado.

Resultado discriminado, no padrão de nomes do repositório:

```ts
export type BeforeCallDecision =
  | { kind: "ALLOW"; reservationId: string; remainingReservedCents: number }
  | { kind: "DENY_BUDGET"; reasonCode: string }
  | { kind: "DENY_PRICE_UNKNOWN"; provider: string; model: string }
  | { kind: "DENY_USAGE_UNRESOLVED"; reasonCode: string }
  | { kind: "ERROR"; retryable: boolean; sanitizedCode: string };
```

**Nunca expor secret, SQL ou payload bruto no resultado** — `sanitizedCode` é código curto, não mensagem do Postgres. Vale o invariante do CLAUDE.md: Edge Function não devolve `error.message` cru; detalhe vai para `console.error`/`jsonLog`.

**Semântica obrigatória por variante.** Todas podem terminar em handoff — mas a **causa**, a **copy**, a **telemetria** e a **possibilidade de retry** são diferentes, e é essa diferença que o boolean apagava.

**`ALLOW`** — executa a chamada, com `remainingReservedCents` conhecido.

**`DENY_BUDGET`** — *hard stop comercial*.
- franquia financeira utilizada **ou** cobertura insuficiente para a próxima chamada;
- handoff humano;
- **mensagem comercial** adequada (§18.3);
- alerta interno **de orçamento** (`admin_ai_budget_stop`).

**`DENY_PRICE_UNKNOWN`** — *fail-closed técnico*.
- **não afirmar que a franquia acabou** — não é isso que aconteceu;
- alertar platform_admin sobre **preço ausente**, com provider e modelo sanitizados;
- **nenhuma chamada ao provider**.

**`DENY_USAGE_UNRESOLVED`** — *fail-closed técnico*.
- existe **consumo anterior cujo custo não pôde ser determinado**;
- manter **cobertura conservadora** comprometida;
- alertar platform_admin;
- **nenhuma nova chamada até resolução segura**.

**`ERROR`** — *falha de infraestrutura*.
- **não afirmar que a franquia acabou**;
- retry **somente** quando `retryable === true` **e** não houver ferramenta mutante já executada — as duas condições, não uma;
- telemetria **sanitizada**.

A condição dupla do retry não é redundância: `retryable` fala da natureza do erro, `mutatingToolUsed` fala do estado do mundo. Um erro perfeitamente retriável depois de `create_reservation` ter rodado ainda produziria reserva duplicada — é o invariante que já existe hoje para o retry silencioso, e vale igual aqui.

`ERROR` e `DENY_BUDGET` levam ao mesmo destino operacional, mas **dizem coisas opostas ao cliente e ao admin**, e só uma delas significa que a franquia acabou.

Sob `strict: false`, estreitar essa união exige `d.kind === "ALLOW"` ou early-return — invariante já registrado no CLAUDE.md.

### 17.7.2 — Contexto entregue ao `beforeCall`

O gancho recebe o suficiente para decidir sem ir ao ledger:

`organization_id` · `cycle_id` · `turn_id` · `request_id` · `provider` · `model` · `iteration` · `max_iterations` · `reservation_id` · `consumed_cents` · `reserved_cents` · estimativa máxima da próxima chamada.

`iteration` e `max_iterations` entram porque a estimativa da próxima chamada depende de onde o turno está: a 1ª iteração e a 11ª têm perfis de custo diferentes (histórico acumulado, tool results embutidos).

### 17.7.3 — Ordem por chamada interna

Para **cada** chamada do `runAgentLoop`:

1. resolver provider e modelo;
2. **verificar preço vigente**;
3. chamar `beforeCall`;
4. receber `ALLOW` com cobertura;
5. executar a chamada ao provider;
6. receber `onUsage`;
7. calcular o custo real;
8. **avançar `consumed_cents` de forma atômica e idempotente**;
9. atualizar o saldo restante da reserva;
10. só então permitir a próxima iteração.

**Se `beforeCall` negar:**

- **não** iniciar nova chamada;
- **não** truncar resposta já recebida;
- encerrar o loop de forma controlada;
- preservar mensagens e ferramentas já executadas;
- encaminhar para atendimento humano;
- emitir telemetria com o motivo correto (`evt` distinto por variante da decisão).

### 17.7.4 — Negação depois de ferramenta mutante

O caso mais delicado do contrato. Se `create_reservation`, `update_reservation` ou `cancel_reservation` **já rodou**, existe efeito persistido no banco antes de o orçamento acabar.

Regras:

- **o efeito persistido não pode ser descartado**;
- a ferramenta **não pode ser repetida silenciosamente**;
- o turno **não pode receber retry automático integral**;
- **a ausência de orçamento para uma chamada posterior não apaga o resultado da ferramenta**.

Ao negar uma chamada com `mutatingToolUsed === true`:

1. persistir o resultado da ferramenta;
2. marcar o turno como **interrompido após efeito mutante**;
3. criar handoff humano;
4. registrar `needsHumanFollowUp` (ou equivalente no schema real);
5. responder ao cliente com **texto determinístico**, sem depender de nova chamada ao LLM;
6. informar com segurança que a ação foi registrada e que a equipe continuará o atendimento;
7. **não afirmar confirmação final** quando a ferramenta ainda exigir validação adicional.

**A copy precisa diferenciar três situações**, e usar a mesma frase para as três é o erro que produz cliente aparecendo no restaurante sem mesa:

| Situação | O que a mensagem pode afirmar |
|---|---|
| Ação **efetivamente concluída** | confirma |
| Ação **criada, aguardando confirmação** | registra, **não** confirma |
| Atendimento **interrompido antes da conclusão** | não afirma nada sobre a ação |

**Não gerar uma nova resposta com IA para explicar que a IA foi bloqueada** — isso exigiria justamente a chamada que foi negada. O texto é hardcoded, e entra no `HARDCODED_AGENT_NOISE` no mesmo PR, pelo mesmo motivo de `MEDIA_REPLY_TEXT` e do texto do hard stop.

Isso estende o invariante `mutatingToolUsed` já existente: hoje ele proíbe o retry silencioso; agora também governa o encerramento por orçamento.

### 17.7.5 — Os cinco provedores

O contrato vale para **claude, openai, gemini, grok e deepseek**. **Não implementar o gancho somente no Gemini** — é o provedor com fallback configurado e o mais exercitado, o que o torna o mais provável de virar "o único testado".

Cada adapter precisa provar que: chama `beforeCall` antes de **cada** chamada HTTP; **não** chama o provider quando a decisão é negativa; reporta `onUsage` depois da chamada; preserva `provider`/`model` corretos; e **não** considera modelo desconhecido gratuito.

### 17.7.6 — O fallback do Gemini é uma chamada financeira própria

`callGeminiWithFallback` realiza **potencialmente duas chamadas HTTP dentro de uma mesma iteração lógica** (Flash → Pro), cobrindo 5xx, timeout e resposta vazia.

**A chamada de fallback não herda a autorização concedida à primeira.** Cada chamada tem:

- autorização financeira própria **antes** de iniciar;
- `provider`/`model` **reais daquela chamada**;
- preço vigente **do modelo real** — Pro custa múltiplas vezes Flash, e cobrar Pro a preço de Flash é subcontabilização direta;
- `call_id` (ou `idempotency_key`) própria;
- `onUsage` próprio;
- apropriação própria **dentro da mesma reserva e do mesmo `turn_id`**.

Ordem obrigatória:

```
1. autorizar Flash
2. executar Flash
3. liquidar OU marcar o usage do Flash
4. resolver o modelo de fallback
5. verificar preço do fallback
6. revalidar orçamento
7. só então chamar Pro
```

**Se a primeira chamada retornar sem usage suficiente:**

- marcar `USAGE_REVIEW_REQUIRED`;
- **não** considerar custo zero;
- **não** liberar integralmente a cobertura;
- **o fallback recebe `DENY_USAGE_UNRESOLVED`**;
- **não iniciar a segunda chamada enquanto o custo da primeira estiver indeterminado**;
- encaminhar para humano.

Isso fecha exatamente o buraco que o caminho atual abriria: **resposta vazia + fallback = duas chamadas, uma contabilizada.** E o caso não é hipotético — `callGeminiWithFallback` trata resposta vazia como cenário real observado em produção, e resposta vazia é justamente quando `usageMetadata` pode não vir.

### 17.7.7 — Redeploy

**Confirmado no repositório: o único consumidor de runtime de `ai-providers.ts` é `webhook-whatsapp`** — é o único arquivo com `import ... from "../_shared/ai-providers.ts"`. `manage-ai-providers` importa apenas `security.ts` e `cors.ts`.

Consequência direta: **a alteração do contrato `runAgentLoop`/`beforeCall` exige redeploy de `webhook-whatsapp` e não exige de `manage-ai-providers`**, enquanto o catálogo de modelos permanecer inalterado.

A linha do checklist do CLAUDE.md que lista `manage-ai-providers` existe por outra razão: o invariante de **sincronização do catálogo de modelos**. Ela se aplica quando mudar:

- `DEFAULT_MODELS` (backend);
- `KNOWN_MODELS` (backend);
- `MODELS_BY_PROVIDER` (UI);
- `DEFAULT_MODEL_BY_PROVIDER` (UI);
- ou outro contrato de catálogo compartilhado entre backend e interface.

**Não manter `manage-ai-providers` no checklist do `beforeCall` apenas por proximidade temática.** Redeploy desnecessário não é inofensivo: ele treina a leitura de que o checklist é aproximado, e o checklist só funciona enquanto for exato — é ele que impede que metade do sistema rode com `_shared/` velho em memória.

O checklist do CLAUDE.md é atualizado **quando a implementação ocorrer**, não nesta rodada.

---

## 18. Limites soft e hard

### 18.1 Não há limite de volume

Sem limite diário. Sem limite mensal. Sem limite de interações. Sem bloqueio por quantidade de requests. **O único limite é financeiro.**

Regra da spec, não preferência: **qualquer código que conte conversas para autorizar ou negar está errado.**

### 18.2 Os quatro marcos

| Custo real liquidado no ciclo | Ação | `event_type` |
|---|---|---|
| R$ 70,00 | primeiro aviso | `admin_ai_budget_70` |
| R$ 80,00 | segundo aviso | `admin_ai_budget_80` |
| R$ 90,00 | aviso crítico | `admin_ai_budget_90` |
| R$ 100,00 | **hard stop** | `admin_ai_budget_stop` |

Avisos **internos**, ao platform_admin, via `billing_notifications` + `TEMPLATE_BY_EVENT` em `process-billing-notifications`.

**Sexta ocorrência do acoplamento por string** já documentado no CLAUDE.md: os quatro tipos exigem entrada em `TEMPLATE_BY_EVENT` no **mesmo deploy**, ou o aviso morre em `failed/unknown_event_type` — exatamente quando importa. Teste bidirecional no padrão de [whatsapp-instance-alerts-dispatcher.test.ts](../../../src/lib/whatsapp-instance-alerts-dispatcher.test.ts).

**Cada marco dispara no máximo uma vez por ciclo.** O UNIQUE de `billing_notifications` é **parcial** e não deduplica com `invoice_id` nulo — e estes avisos não têm fatura. A cadência vive no **ledger**, não na fila: ledger de marcos por (org, ciclo, marco), com a disciplina de três tempos da 6b — **tocar → enfileirar → carimbar** — onde o primeiro UPDATE prova que a linha é gravável antes de qualquer enfileiramento.

**Conteúdo obrigatório do alerta interno:** organização; ciclo; custo liquidado; custo reservado; modelo; data da renovação; ação esperada.

### 18.3 Comportamento no hard stop (D7 fechada)

Ao atingir R$ 100 no ciclo:

- **não** realizar novas chamadas ao LLM;
- **não** desligar o canal — o WhatsApp continua recebendo mensagens;
- **não** bloquear o sistema;
- chat continua funcionando; mensagens ficam visíveis;
- atendimento humano continua possível;
- encaminhar novos atendimentos para a equipe;
- gerar alerta administrativo;
- **não** dizer que houve falha técnica;
- **não** degradar silenciosamente para modelo inferior;
- reativar automaticamente na abertura do ciclo seguinte.

**Texto ao cliente final (conceitual):**

> "A franquia de automação com IA deste ciclo foi utilizada. As novas mensagens continuarão disponíveis para atendimento pela equipe até a renovação da franquia."

**Nunca informar ao cliente:** custo interno em reais, tokens, preço do modelo, margem, ou o limite de R$ 100.

Mecanismo: `conversations.status = 'awaiting_human'` com `handoff_reason = 'ai_budget_exhausted'` — razão própria, que o distingue de `agent_error` na telemetria e no painel.

Duas consequências que precisam de teste explícito, porque hoje todo handoff é por erro:

- **O auto-resolve de 12h sem resposta humana devolve a conversa para `ai_active`.** Com a franquia esgotada, devolveria a uma IA que não pode responder. O auto-resolve precisa reconhecer `ai_budget_exhausted` e não devolver antes da virada do ciclo.
- **A mensagem ao cliente entra no `HARDCODED_AGENT_NOISE`** no mesmo PR — precedente direto de `MEDIA_REPLY_TEXT`. Sem isso, ela polui o histórico das invocações seguintes.

### 18.4 O que o cliente vê

Somente estados comerciais: `Franquia disponível` · `Uso elevado` · `Franquia utilizada — renova no próximo ciclo`.

O mapeamento marco → estado é interno; "uso elevado" pode corresponder a R$ 80 ou R$ 90 sem que isso apareça.

`budgetRemainingCents` **não** vai ao frontend do lojista. Mesma disciplina do payload de `manage-billing`: ter `organization_id` para checar não dispensa **moldar** a resposta, e filtrar o payload admin depois de montá-lo é a forma errada — **caminho de resposta separado**, senão campo novo vaza sozinho.

### 18.5 Reset

Alinhado ao **ciclo da assinatura**, não ao mês civil.

`cycle_start`/`cycle_end` derivam da assinatura de sistema. A âncora tem o mesmo problema de dia 31 já resolvido na 6b por `provider_cycle_anchor_day` — persistido, nunca re-derivado, senão âncora 31 degrada para 28 depois do primeiro fevereiro e nunca mais volta. **Reusar a solução, não reinventar.**

Regularização de inadimplência **não** reseta a franquia. Só a virada de ciclo.

---

## 19. Compatibilidade legada

| Situação | Comportamento |
|---|---|
| Plano antigo, `included_features = '{}'` | resolve por `FEATURE_CATEGORIES`, byte a byte |
| Assinatura `WHATSAPP_SUBSCRIPTION` ativa | continua concedendo `whatsapp` pela categoria (§15-B) |
| Org com as duas | caso C do resolvedor — sem `.maybeSingle()`, sem `created_at` |
| **Ren Sushi** | override LIFETIME nas três features, **prioridade 2** — não passa por nada desta spec |
| Moralles | idem |
| `LEGACY_GRANDFATHERED` | preservado |
| `process-whatsapp-enforcement` | preservado, ativo para legados |
| Sete estados | preservados integralmente |
| Faturas históricas | intactas; planos antigos continuam existindo |
| Carteira de IA legada | ramo preservado; franquia só se aplica a quem tem `ai` em `included_features` |
| `instancia-whatsapp`, `credito-ia-*` | **inativados** para novas vendas; nunca apagados |

**Nenhuma assinatura existente é migrada.** A propriedade que torna isso verdade: `included_features` vazio é indistinguível, para o resolvedor, do mundo anterior.

---

## 20. Testes obrigatórios

Todos em núcleo puro (vitest, sem banco — a rede real enquanto não há Docker).

**Entitlement e planos**

1. `billing_plans.features` não concede acesso — copy arbitrária, incluindo strings iguais a `"whatsapp"`, não muda entitlement.
2. `included_features` aceita apenas valores válidos — CHECK rejeita string fora do vocabulário.
3. Plano 1 concede `system`.
4. Plano 1 **não** concede `whatsapp` nem `ai`.
5. Plano 2 concede `system`, `whatsapp` e `ai`.
6. Plano legado com `included_features` vazio mantém o comportamento antigo.
7. **Ren Sushi com override LIFETIME não muda de caminho** — cenário nomeado.
8. Trial não concede WhatsApp.

**Catálogo e slugs**

9. Novos slugs não colidem com os existentes.
10. Superfícies de contratação nova **não** ofertam `instancia-whatsapp` (§A6.2).
11. Produto legado continua **consultável para histórico** — o guardrail não quebra a leitura antiga.

**Preço e custo de IA**

12. Modelo desconhecido falha fechado — **zero chamada ao provider**.
13. `estimateCostUsd` não trata desconhecido como zero — devolve `PRICE_UNKNOWN`.
14. **Usage ausente não vira custo zero** — marca `USAGE_REVIEW_REQUIRED` e mantém reserva.

**Reserva, teto e `beforeCall`**

15. Reserva concorrente não ultrapassa o teto.
16. **`beforeCall` é executado antes de cada uma das até 12 chamadas.**
17. `beforeCall` negado resulta em **zero chamada externa**.
18. **`ERROR` de infraestrutura não é confundido com teto atingido** — variantes distintas, consequências distintas.
19. `consumed_cents` avança **uma vez por `request_id`**.
20. Chamada repetida com a mesma `idempotency_key` **não debita novamente**.
21. **Todos os cinco provedores** respeitam o contrato — incluindo a segunda chamada do fallback do Gemini.
22. Reserva expirada não autoriza chamada; reserva finalizada não volta a ativa.

**Gate e enforcement**

23. Plano 2 usa `financialState` da `SYSTEM_SUBSCRIPTION`.
24. Legado usa `WHATSAPP_SUBSCRIPTION`.
25. Coexistência em transição **não dispara `maybeSingle`** — caso C não lança.
26. Duplicidade **não escolhe a mais recente** — caso D devolve erro/revisão.
27. **Gate e enforcement retornam a mesma decisão para os mesmos fatos.**

**Fluxos comerciais**

28. **Plano 2 pago sem implementação não habilita envio.**
29. Downgrade sem 6c permanece indisponível.
30. Segunda conexão é bloqueada — **nos dois pontos de verificação**.
31. Pagamento do plano não cria instância.
32. Pagamento da implementação não cria instância.

**Fallback, identidade por chamada e ferramenta mutante**

33. **Fallback verifica orçamento novamente** — não herda a autorização da primeira chamada.
34. **Fallback usa o preço do modelo real** (Pro), não o do modelo inicial (Flash).
35. **Fallback não executa quando o usage da primeira chamada está pendente** — recebe `DENY_USAGE_UNRESOLVED`.
36. Duas chamadas do mesmo turno têm **`call_id` distintas**.
37. **A mesma `call_id` não liquida duas vezes.**
38. **Ferramenta mutante seguida de `DENY_BUDGET` preserva o efeito.**
39. **Ferramenta mutante não provoca retry integral.**
40. **Handoff após ferramenta mutante não depende de nova chamada de IA** — texto determinístico.

**Orçamento e ciclo**

41. **`settled_cents` não inclui reserva.**
42. **Duas reservas concorrentes não usam o mesmo saldo disponível.**
43. Ciclo de orçamento usa **fim exclusivo**.
44. **Dois ciclos sobrepostos são rejeitados.**
45. **Usage desconhecido não libera automaticamente toda a reserva.**

**Checklist de redeploy**

46. **Apenas `webhook-whatsapp`** entra no redeploy por alteração de `beforeCall`.
47. **`manage-ai-providers` só entra quando o catálogo de modelos mudar.**

**Acoplamento:** os quatro `admin_ai_budget_*` verificados nas duas direções contra `TEMPLATE_BY_EVENT`.

**Limite honesto desta suíte.** Os testes 42 e 44 — concorrência real, constraints, locks e RPC — **dependem de banco real e não podem ser declarados concluídos por teste unitário**. Um teste de núcleo puro prova que a *fórmula* está certa; ele não prova que o `SELECT ... FOR UPDATE` serializa, que o `exclusion constraint` existe, nem que a RPC é `SECURITY DEFINER` com os grants certos. Enquanto não houver ambiente com Docker, esses ficam **explicitamente pendentes** — não silenciosamente ausentes. A 6b já produziu o precedente: RLS e grants nunca provados contra banco real seguem como residual nomeado.

**O que não é testável automaticamente:** o `index.ts` das EFs importa `deno.land`/`esm.sh` e chama `serve()` no carregamento — vitest não o alcança. Regra de decisão escrita em `index.ts` só é verificável por leitura, **e leitura já deixou passar um `ReferenceError` de autorização e um conflito FK × CHECK por duas auditorias na 6b**. Toda decisão desta spec vive em núcleo puro; `index.ts` é adapter de I/O.

**Gates obrigatórios antes do merge** (CLAUDE.md): `rls-auditor`, `tenant-isolation-auditor`, `migration-validator`, `secret-hunter`, `integration-reliability-auditor`, `identity-access-auditor`. Esta mudança toca banco, entitlement e multi-tenant — não é exceção trivial.

---

## 21. Rollout

**Ordem obrigatória:** migration aplicada **antes** do deploy da EF que lê a coluna. Coluna inexistente vira 400 do PostgREST → leitura falha → gate fail-closed nega para todo mundo. Foi assim que `manage-channels` respondeu 403 `PROVISIONING_UNVERIFIABLE` para toda unidade sem canal, inclusive platform_admin.

Pontos de atenção do deploy:

- `entitlements-core.ts` muda → `manage-billing`, `create-billing-checkout`, `manage-whatsapp-implementations`;
- `whatsapp-service-gate.ts` muda → **as dezoito** consumidoras. Redeploy parcial deixa metade do sistema com a regra antiga em memória;
- `ai-providers.ts` muda → **`webhook-whatsapp` apenas** (único importador de runtime, §17.7.5); `manage-ai-providers` só entra quando o catálogo de modelos mudar;
- **`process-billing-notifications` primeiro**, antes de qualquer produtor dos novos `event_type`;
- conferir `acl-estatico` na aba Checks (não é required check; a conferência é operacional).

Flags: o gate de franquia nasce **OFF** (`ai_wallet_enforced` reusada) → medição e ledger funcionam, hard stop não aplica. É o modo de observação: **você vê o custo real por organização antes de qualquer bloqueio ligar.**

---

## 22. Rollback

| Camada | Como reverter |
|---|---|
| Entitlement | `update billing_plans set included_features = '{}'` → resolvedor volta ao caminho de categoria. **Sem migration reversa.** |
| Planos novos | `active = false` — some da vitrine; faturas emitidas preservadas |
| Franquia de IA | flag OFF → medição continua, hard stop para |
| `PLAN_COMPONENT` | `whatsapp_component_cents = null` → `attributeRevenue` volta aos degraus antigos |
| CHECK do `revenue_source` | reversível pelo par drop/add **enquanto** nenhum ciclo tiver gravado `PLAN_COMPONENT` |
| Planos antigos | nunca removidos; reativáveis por `active = true` |

Propriedade central: **coluna vazia = comportamento antigo.** É o que torna a abordagem aditiva defensável sem staging.

**Única irreversibilidade real:** o CHECK do `revenue_source` depois que ciclos gravarem `PLAN_COMPONENT` — e isso é histórico financeiro, que não deveria ser revertido.

---

## 23. Riscos

| Risco | Gravidade | Mitigação |
|---|---|---|
| Org pagante em `NOT_ENTITLED` sob o Plano 2 | **alta** | §14 + §15-A; teste 23 |
| Gate e `process-whatsapp-enforcement` divergirem | **alta** | mesmo resolvedor puro (§15); teste 27 |
| Redeploy parcial de `whatsapp-service-gate.ts` | **alta** | 18 consumidoras; checklist é load-bearing |
| Segunda conexão sem receita | **alta** | dois pontos server-side (§10); teste 30 |
| Reserva vazando por crash | **alta** | `expires_at` obrigatório + varredura |
| Modelo sem preço consumindo sem tocar o teto | **alta** | fail-closed (§17.1); testes 12-14 |
| Turno consumindo até a 12ª iteração sem controle | **alta** | revalidação por chamada (§17.5); testes 16-17 |
| Preço antigo hardcoded ofertando instância ao lojista | **média** | quatro call sites da §A6 na fase B |
| `included_features` confundido com `features` | **média** | nomes distintos, comentário de coluna, CHECK fechado; teste 1 |
| `event_type` novo sem template | **média** | teste bidirecional + dispatcher deployado primeiro |
| Auto-resolve devolvendo conversa à IA sem orçamento | **média** | reconhecer `ai_budget_exhausted` (§18.3) |
| Downgrade sem superfície operacional | **média** | 6c antes, invariante (§6); teste 29 |
| Overage de chamada já autorizada | **baixa** | incidente observável, nunca margem aceita (§17.5) |
| Ren Sushi afetado | **baixa** | override em prioridade 2; teste 7 nomeado |

---

## 24. Fases e ordem de implementação

Ordem aprovada, com dependências:

| # | Etapa | Estado |
|---|---|---|
| **1** | Fechar decisões comerciais | ✅ **concluído** — D1–D9 nesta spec |
| **2** | Especificar dados aditivos dos planos | ✅ **concluído** — §1 |
| **3** | Adaptar entitlement em núcleo puro | §2 |
| **4** | **Adaptar gate do WhatsApp e enforcement no mesmo commit** | §14, §15, §16 |
| **5** | Criar compatibilidade legada | §19 |
| **6** | Concluir/publicar a operação administrativa da 6b | observação, merge, frontend |
| **7** | **Implementar a 6c** | spec `ac3dac9` |
| **8** | **Somente depois, implementar downgrade** | §6 |
| **9** | Redefinir Fase 7 como franquia inclusa | §17 |
| **10** | Implementar preços versionados | §17.1 |
| **11** | Implementar ledger e reserva de IA | §17.2-17.7 |
| **12** | **Provar concorrência e teto** | testes 15-22, 33-45 (42 e 44 exigem banco real) |
| **13** | Habilitar Plano 2 para novos clientes | decisão sua |

Quatro acoplamentos não negociáveis:

- **4 é um commit só.** Gate e enforcement mudam juntos ou nenhum muda.
- **7 antes de 8.** Sem o painel da 6c, a pendência de cancelar o custo na Z-API fica invisível — R$ 99,90/mês correndo em silêncio.
- **11 antes de 13, com 12 no meio.** Ligar o hard stop sem histórico de custo real é bloquear às cegas; habilitar o Plano 2 sem o teto provado é assumir risco ilimitado por margem finita.
- **Seed dos novos planos e remoção das superfícies cliente-facing dos produtos antigos no MESMO lote** (§A6). **Os novos planos não podem ser publicados enquanto qualquer superfície cliente-facing ainda oferecer contratação de `instancia-whatsapp` separadamente** — o cliente veria os dois modelos ao mesmo tempo, com preços que se contradizem.

O lote comercial contém, indivisivelmente:

1. semear `plano-reservas`;
2. semear `plano-automacao`;
3. retirar produtos antigos da nova vitrine;
4. adaptar `manage-whatsapp-implementations` (projeção de preços da §A6);
5. remover `contratarInstancia` da experiência nova;
6. apresentar **upgrade para o Plano Automação** no lugar;
7. manter `implementacao-whatsapp` como cobrança única;
8. preservar produtos antigos para histórico.

---

## Decisões fechadas

| | Decisão |
|---|---|
| **D1** | Plano 1 R$ 449,90; **Plano 2 R$ 799,90**; componentes R$ 449,90 + R$ 350,00 |
| **D2** | Slugs `plano-reservas` e `plano-automacao` — **colisão verificada, livres** (§A6) |
| **D3** | Trial somente `system` |
| **D4** | Sem conversão automática ao fim do trial |
| **D5** | Modelo sem preço **falha fechado**; `estimateCostUsd` devolve resultado discriminado |
| **D6** | Reserva por turno **com revalidação por chamada**; `beforeCall` devolve **resultado discriminado, nunca boolean**; estouro é incidente, nunca franquia |
| **D7** | Hard stop com handoff humano, sem expor custo interno |
| **D8** | Sem prorrata automática; upgrade efetivo no próximo ciclo |
| **D9** | Uma conexão incluída; adicionais só por proposta personalizada |

**Invariantes desta spec:**

- **A Fase 6c existe antes do downgrade.**
- **`included_features` é autorização; `billing_plans.features` é copy — jamais confundidas.**
- **`active = false` não remove produto antigo do runtime** — as superfícies cliente-facing saem no mesmo lote do seed.
- **Modelo sem preço e usage sem resolução falham fechados** — nenhuma ignorância vira gratuidade.
- **`beforeCall` distingue falha de infraestrutura de teto atingido** — nunca um boolean.
- **Toda chamada ao provedor tem autorização própria** — inclusive a segunda do fallback.
- **Efeito de ferramenta mutante sobrevive ao fim do orçamento** — e a copy não afirma o que não aconteceu.
- **Reserva é capacidade comprometida, não gasto** — `settled_cents` e reservas nunca colapsam num campo só.
- **Só `webhook-whatsapp` consome `ai-providers.ts`** — o checklist de redeploy é exato ou não serve.

---

*Spec de decisões. Nenhum código, migration, flag, deploy, cron ou dado de produção foi alterado.*
