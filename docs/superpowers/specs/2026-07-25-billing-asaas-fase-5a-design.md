# Fase 5a — Comercial: implantação do WhatsApp (R$ 750) + assinatura da instância (R$ 149)

> Spec de design aprovada em 2026-07-25.
> Plano-mãe: [docs/billing-asaas/01-PLANO-IMPLEMENTACAO.md § FASE 5](../../billing-asaas/01-PLANO-IMPLEMENTACAO.md).
> Fase anterior: [FASE-4B-RESUMO.md](../../billing-asaas/FASE-4B-RESUMO.md) (validada em sandbox, tag `billing-asaas/fase-4b`).
> API verificada: [03-ASAAS-API-VERIFICADO.md](../../billing-asaas/03-ASAAS-API-VERIFICADO.md).

## 1. Por que 5a e 5b

A Fase 5 do plano original entrega dois blocos com naturezas diferentes: **vender** dois produtos novos e **desligar** o serviço de quem não paga um deles. Pelo tamanho (≈3× a Fase 4b) e pela dependência (não há assinatura de WhatsApp real para suspender antes de existir a venda), a fase foi decomposta:

- **5a — Comercial (esta spec):** cobrar, correlacionar, rastrear a implantação, conceder cortesia, exibir ao cliente. **Nada suspende, nada silencia.**
- **5b — Enforcement por serviço:** worker de inadimplência específico do WhatsApp, gate central de envio, gate do agente, estacionamento e revalidação de jobs, banner e restauração pós-pagamento.

Mesmo corte que separou 4a (entrada de dinheiro) de 4b (falta de dinheiro), com validação em sandbox no fim de cada uma.

## 2. Estado do qual esta fase parte

| Fato | Consequência para a 5a |
|---|---|
| `implementacao-whatsapp` (R$ 750, `one_time`, `WHATSAPP_IMPLEMENTATION`) e `instancia-whatsapp` (R$ 149/mês, `WHATSAPP_SUBSCRIPTION`, `requires_plan_id` → implantação) já existem em `billing_plans`, ambos `active=false` | Catálogo pronto; a fase liga os planos no fim |
| `createCheckout({mode:"one_time"})` emite `chargeTypes:["DETACHED"]` e existe desde a Fase 2 **sem nenhum call site** | Caminho avulso é código nunca exercitado — primeiro item do roteiro de sandbox |
| `billing_checkout_sessions.purpose` e `billing_invoices.purpose` já aceitam `'implementation'` | Correlação por `checkoutSession` (validada ao vivo na 4a) serve o produto avulso sem extensão |
| `applyAsaasEvent` resolve "a assinatura da org" com `maybeSingle()` sobre qualquer assinatura não-cancelada | **Bloqueante:** com sistema + instância vira `PGRST116` e o pagamento falha. Corrigir antes de qualquer venda de R$ 149 |
| `process-billing-overdue`, `process-billing-unblock`, `process-trial-expiry`, `process-billing-reconcile` e `manage-billing` escrevem `organizations.billing_status` a partir de **qualquer** fatura/assinatura | **Bloqueante:** fatura de R$ 149 vencida bloquearia a org inteira; cancelar a instância marcaria a org `canceled`; assinatura de WhatsApp ativa faria o trial nunca expirar |
| `organization_entitlement_overrides` existe desde a Fase 1 com `CHECK (LIFETIME\|TEMPORARY\|PROMOTIONAL\|MANUAL_OVERRIDE)`, lida pelo núcleo testado `entitlements-core.ts` | Override de `whatsapp` é insert nessa tabela — sem migration de CHECK |
| Único cliente ativo é vitalício grátis (Ren Sushi); Moralles é a plataforma | Nenhum fluxo pode cobrar quem tem override; go-live de produção segue deferido |

## 3. Escopo

### Dentro da 5a

1. Correlação de **múltiplas assinaturas por organização**, resolvida por categoria do plano.
2. **Sweep de category-awareness**: todo writer de `organizations.billing_status` passa a exigir categoria `SYSTEM_SUBSCRIPTION`.
3. Checkout **avulso** de R$ 750 (`purpose=implementation`).
4. Checkout **recorrente** de R$ 149 (`purpose=subscription`, categoria `WHATSAPP_SUBSCRIPTION`), travado no servidor.
5. Tabela e painel de **implantação**, com status financeiro e operacional separados e origem comercial.
6. **Override mínimo de `whatsapp`** (conceder/revogar) com motivo obrigatório, aviso de custo Z-API e auditoria.
7. Card e **resumo consolidado** na tela de cobrança do cliente.
8. Três **flags** separadas (visibilidade, checkout mensal, enforcement).

### Fora da 5a (registrado, não esquecido)

| Item | Fase |
|---|---|
| Suspensão por serviço, gate central de envio, gate do agente, estacionamento/revalidação de jobs, banner de suspensão, restauração pós-pagamento | 5b |
| Status real da instância na Z-API, provisionamento, QR code, "não criar instância duplicada" | 6 |
| Carteira de IA: saldo, débito, crédito promocional, limite mensal patrocinado, consumo ilimitado | 7 |
| UI genérica de overrides das três features, worker de expiração de `TEMPORARY` | 9 |
| Fluxo explícito de **reimplantação** (segunda implantação para a mesma org) | pós-5b |

"Campanhas" não existe como feature deste produto — não há fila de campanha. Os fluxos automáticos reais são `notification_outbox`, lembretes D-0, pesquisas D+1, vouchers e fila de espera; todos entram no estacionamento da 5b.

## 4. Decisões aprovadas

1. **Sem carrinho.** Nenhuma `billing_orders`/`billing_order_items`. Um produto → uma sessão de checkout → uma cobrança. O resumo consolidado na tela é leitura, não pedido.
2. **Rótulos, não sinônimos.** `grant_type` mantém `LIFETIME|TEMPORARY|PROMOTIONAL|MANUAL_OVERRIDE` no banco, APIs, testes e núcleo. A UI rotula: Acesso vitalício / Acesso temporário / Cortesia / Override administrativo. Mapa único em `src/types/billing.ts`.
3. **R$ 149 nunca escreve em `organizations.billing_status`.** Essa coluna representa só a assinatura do sistema. A assinatura de WhatsApp atualiza a própria linha, o entitlement de `whatsapp` e suas datas de ciclo.
4. **Assinatura resolvida por categoria do plano**, sem desnormalizar `feature` em `billing_subscriptions`.
5. **Ambiguidade é falha alta.** Duas assinaturas não-canceladas da mesma categoria → erro, evento continua na fila, nunca escolha silenciosa da mais recente.
6. **Constraint + advisory lock.** A UNIQUE parcial cobre o mesmo plano; o `pg_advisory_xact_lock` por `(org, categoria)` cobre planos diferentes da mesma categoria. Complementares.
7. **Pagamento e operação em estados separados.** `payment_status` e `operational_status`, nunca um campo só.
8. **`create-billing-checkout` dividido** em roteador + contexto + handler por `purpose`; lógica da implantação em `_shared/implementation-checkout.ts` porque o painel admin usa a mesma.
9. **EF separada `manage-whatsapp-implementations`** — `manage-billing` já tem 1347 linhas.
10. **`resolvePlatformAdminRecipients()` separado** do resolver tenant-scoped (que é org-scoped de propósito, fix do vazamento cross-tenant da 4b).
11. **Ausência de linha = `NOT_REQUESTED`.** Desvio consciente do enunciado: em vez de gravar uma linha que significa "nada aconteceu", a projeção do cliente devolve `NOT_REQUESTED` quando não há registro. Evita linha órfã sem origem, sem valor e sem responsável, e mantém a UNIQUE de "uma implantação aberta" significativa.

## 5. Modelo de dados

Todas as migrations são **aditivas** e idempotentes, na sequência `071`+ (a última aplicada é `070`).

### 5.1 `071_whatsapp_implementations.sql`

```
whatsapp_implementations
  id                        uuid pk
  organization_id           uuid not null → organizations(id) on delete cascade
  origin                    text not null  check (ASAAS|EXTERNAL_PAYMENT|COURTESY|ADMIN_OVERRIDE)
  payment_status            text not null  check (PENDING|CONFIRMED|WAIVED|REFUNDED|CHARGEBACK|CANCELED)
  operational_status        text not null  check (NOT_STARTED|SCHEDULED|IN_PROGRESS|WAITING_CUSTOMER|COMPLETED|CANCELED)
                                           default 'NOT_STARTED'
  amount_cents              integer          -- valor cobrado (ASAAS) ou recebido (EXTERNAL_PAYMENT); null em WAIVED
  billing_plan_id           uuid  → billing_plans(id)
  billing_invoice_id        uuid  → billing_invoices(id)      -- só origin=ASAAS
  provider_checkout_id      text                              -- só origin=ASAAS
  paid_at                   timestamptz
  payment_method            text                              -- livre: pix|card|transferencia|dinheiro|...
  external_payment_reference text                             -- comprovante/nota (EXTERNAL_PAYMENT)
  reason                    text                              -- obrigatório em COURTESY|ADMIN_OVERRIDE (EF valida)
  notes                     text
  owner_admin_id            uuid → auth.users(id)             -- responsável pela execução
  scheduled_for             date
  started_at                timestamptz
  completed_at              timestamptz
  canceled_at               timestamptz
  cancel_reason             text
  created_by                uuid → auth.users(id)
  updated_by                uuid → auth.users(id)
  created_at / updated_at   timestamptz not null default now()
```

**Constraints de invariante (proteção no banco, não só no servidor):**

- **Matriz origem × pagamento**
  `ASAAS` → `PENDING|CONFIRMED|REFUNDED|CHARGEBACK|CANCELED`
  `EXTERNAL_PAYMENT` → `CONFIRMED|REFUNDED|CANCELED`
  `COURTESY` → `WAIVED|CANCELED`
  `ADMIN_OVERRIDE` → `WAIVED|CANCELED`
  Pagamento externo **nunca** é `WAIVED`; cortesia **nunca** é `CONFIRMED`.
- **Sem id falso do Asaas:** `origin <> 'ASAAS'` ⇒ `billing_invoice_id IS NULL AND provider_checkout_id IS NULL`.
- **Conclusão exige pagamento resolvido:** `operational_status = 'COMPLETED'` ⇒ `payment_status IN ('CONFIRMED','WAIVED','REFUNDED','CHARGEBACK')`. `REFUNDED`/`CHARGEBACK` entram porque estorno **depois** da entrega não desfaz o trabalho (decisão 6 do usuário); a EF, porém, só aceita a *transição* para `COMPLETED` quando o pagamento é `CONFIRMED` ou `WAIVED`.
- **Uma implantação aberta por org:** `UNIQUE (organization_id) WHERE operational_status <> 'CANCELED'`. `COMPLETED` continua bloqueando criação nova — reimplantação é fluxo explícito de fase futura. Histórico nunca é apagado.

**RLS:** `enable` + `force`. Policy de escrita e leitura **apenas** `is_platform_admin(auth.uid())`. Membros da organização **não** têm SELECT — a tela do cliente lê a projeção segura via EF (a tabela carrega notas, motivo, referência de pagamento e responsáveis internos).

**Auditoria:** trigger `audit_trigger_func()` (o mesmo de `organization_entitlement_overrides`; ele extrai `organization_id` do row automaticamente).

### 5.2 `072_billing_checkout_sessions_lifecycle.sql`

`billing_checkout_sessions` ganha ciclo de vida para permitir dedupe sob concorrência:

- Novo PK surrogate `id uuid default gen_random_uuid()`; `provider_checkout_id` passa a ser **nullable** com UNIQUE parcial `WHERE provider_checkout_id IS NOT NULL` (a linha é reservada **antes** de chamar o Asaas, quando o id ainda não existe).
- `status text not null default 'creating' check (creating|pending|used|expired|canceled|failed)`.
- `checkout_url text`, `expires_at timestamptz`, `updated_at timestamptz`.
- **Uma sessão ativa por produto:** `UNIQUE (organization_id, billing_plan_id, purpose) WHERE status IN ('creating','pending')`.
- Backfill: linhas existentes viram `status='used'` (são de checkouts já pagos em sandbox) — decisão registrada na própria migration.

`expires_at` é **derivado, não adivinhado**: `minutesToExpire` (10–1440) é parâmetro nosso na criação do checkout Asaas.

### 5.3 `073_billing_subscription_category.sql`

- `UNIQUE (organization_id, billing_plan_id) WHERE status <> 'canceled'` em `billing_subscriptions` — mata a corrida de dois cliques no mesmo plano.
- RPC `resolve_or_activate_subscription(p_org uuid, p_plan_id uuid, p_provider_subscription_id text, p_payment_method text)` — `SECURITY DEFINER`, `revoke from public`, grant só `service_role`:
  1. resolve `category` de `billing_plans`;
  2. `pg_advisory_xact_lock(hashtextextended(p_org::text || ':' || category, 0))`;
  3. conta assinaturas não-canceladas **da categoria** (join com `billing_plans`);
  4. `0` → INSERT (`status='active'`) e devolve `action='created'`;
  5. `1` → UPDATE condicional para `active` + backfill de `provider_subscription_id` quando null; devolve `action='reused'`;
  6. `>1` → `raise exception 'ambiguous_subscription_category'`.
  O aplicador chama a RPC no lugar do `select … maybeSingle()` + insert inline atuais, e converte a exceção em `failed` (evento fica na fila do reconcile).

### 5.4 `074_billing_plans_category_guard.sql`

Trigger `BEFORE UPDATE` em `billing_plans`: recusa mudança de `category` quando existe `billing_subscriptions` não-cancelada do plano. `manage-billing` traduz para 409 amigável — o trigger é quem garante.

### 5.5 `075_platform_flags_whatsapp.sql`

Duas flags novas, **OFF**, com `on conflict do nothing`:

| Flag | Controla | Ligada quando |
|---|---|---|
| `whatsapp_implementation_flow` (já existe) | Visibilidade dos preços + checkout da implantação | Fim da 5a |
| `whatsapp_subscription_checkout` | Checkout mensal de R$ 149 | Junto da 5b |
| `whatsapp_service_enforcement` | Suspensão/gates do serviço | 5b |

### 5.6 `076_activate_whatsapp_plans.sql`

`update billing_plans set active = true where slug in ('implementacao-whatsapp','instancia-whatsapp')`. Última migration da fase. `PricingTable` continua filtrando `SYSTEM_SUBSCRIPTION`, então os produtos de WhatsApp **não** viram card contratável na tabela de planos — eles aparecem só no bloco dedicado.

## 6. Fluxos

### 6.1 Contratação da implantação (cliente)

```
"Contratar implementação"
 → create-billing-checkout { organization_id, plan_id, purpose:'implementation' }
   ├ gates: asaas_enabled (simetria com o webhook) + whatsapp_implementation_flow
   ├ valida no banco: category=WHATSAPP_IMPLEMENTATION, billing_type=one_time
   ├ recusa se já existe implantação aberta (409)
   ├ dedupe de sessão: expira vencidas → reserva 'creating' → Asaas → 'pending' + url + expires_at
   │                    (erro no Asaas → 'failed'; conflito 23505 → devolve a 'pending' existente,
   │                     ou 409 "checkout em criação" se o irmão ainda está em 'creating')
   ├ checkout DETACHED (PIX + cartão), valor SEMPRE de billing_plans
   └ cria whatsapp_implementations (origin=ASAAS, payment_status=PENDING, provider_checkout_id)
 → cliente paga
 → PAYMENT_CONFIRMED ou PAYMENT_RECEIVED (o que chegar primeiro — PIX pula CONFIRMED, §5 do doc 03)
   ├ applyAsaasEvent registra billing_invoices (purpose=implementation) e NÃO libera sistema
   ├ UPDATE condicional .neq('payment_status','CONFIRMED') .select('id')
   │   └ só se afetou linha: marca CONFIRMED + paid_at + billing_invoice_id
   │                          e enfileira 'implementation_paid' para os platform admins
   └ marca a billing_checkout_sessions como 'used'
 → admin conduz operational_status até COMPLETED
```

O retorno da `successUrl` **não confirma nada** — a tela faz polling do estado real, como já faz para a assinatura (cenário 8).

### 6.2 Contratação da instância (R$ 149)

Mesmo `purpose=subscription` do sistema, com gates próprios no servidor, repetidos mesmo com o botão escondido:

- flag `whatsapp_subscription_checkout` ligada;
- implantação da org com `operational_status = 'COMPLETED'`;
- entitlement `system` permitido;
- nenhuma assinatura não-cancelada de categoria `WHATSAPP_SUBSCRIPTION`;
- nenhum override de `whatsapp` ativo (cobrar quem tem cortesia é pior que negar).

Ativação pelo webhook: `resolve_or_activate_subscription` + fatura paga. **Nenhuma escrita em `organizations.billing_status`**, nenhum `restored_at`, nenhum aviso `regularized` — esses continuam exclusivos do caminho do sistema.

### 6.3 Registro manual (admin)

| Ação | origin | payment_status | Exige |
|---|---|---|---|
| Registrar pagamento externo | `EXTERNAL_PAYMENT` | `CONFIRMED` | forma, valor, data, referência opcional, observação, responsável |
| Conceder cortesia | `COURTESY` | `WAIVED` | motivo, responsável |
| Override administrativo | `ADMIN_OVERRIDE` | `WAIVED` | motivo, prazo quando temporário, confirmação |

Nenhuma delas preenche `billing_invoice_id`/`provider_checkout_id` — a constraint recusa. Pagamento externo aparece em relatório e auditoria por ser `CONFIRMED` com `amount_cents` e `paid_at` reais.

### 6.4 Override de WhatsApp

Helper único `_shared/entitlement-overrides.ts` — `grantOverride` / `revokeOverride`. **Nenhum insert direto** em `organization_entitlement_overrides` fora dele. Valida: `grant_type` permitido, coerência de datas (`TEMPORARY` exige `ends_at` futuro; `LIFETIME` recusa `ends_at`), motivo não vazio, `granted_by`/`revoked_by` presentes, conflito com override ativo da mesma feature (409 pedindo revogar antes) e com bloqueio administrativo. Devolve o entitlement resolvido depois da escrita, para a UI refletir o efeito real.

Um override de `whatsapp` concede o direito interno de uso — e só isso. Não libera IA, não cria crédito, não altera o entitlement de sistema, não marca cobrança como paga, não cria pagamento nem assinatura fictícia no Asaas.

## 7. Sweep de category-awareness (obrigatório na 5a)

Todo ponto que hoje deriva estado da organização a partir de "qualquer" fatura ou assinatura passa a exigir categoria `SYSTEM_SUBSCRIPTION`:

| Arquivo | Hoje | Depois |
|---|---|---|
| `_shared/asaas-billing-events-apply.ts` | `select … neq('status','canceled').maybeSingle()`; ativa e escreve org | RPC por categoria; só `SYSTEM_SUBSCRIPTION` toca `organizations` |
| `process-billing-overdue` | agrega faturas vencidas por org, sem olhar propósito | filtra faturas de assinatura de sistema; fatura de WhatsApp é ignorada na 5a (tratada na 5b) |
| `process-billing-reminders` | lembra qualquer fatura vencida | idem — lembrete de WhatsApp é da 5b, para não mandar "sua conta será bloqueada" por uma fatura que não bloqueia nada |
| `process-billing-unblock` | desbloqueia org com **qualquer** fatura paga nos últimos 7d | exige fatura de sistema; senão pagar R$ 149 desbloquearia sistema inadimplente |
| `process-trial-expiry` | pula org com **qualquer** assinatura não-cancelada | exige assinatura de sistema; senão a instância faria o trial nunca expirar |
| `manage-billing` (cancelamento imediato) | cancela sub e marca org `canceled` | só marca a org quando a sub cancelada é de sistema |
| `process-billing-reconcile` | mapeia status da sub Stripe → `billing_status` da org | mesma guarda por categoria (baixo risco hoje — planos de WhatsApp são Asaas — mas a guarda é barata) |

A regra vira invariante no CLAUDE.md: **só assinatura/fatura de categoria `SYSTEM_SUBSCRIPTION` pode escrever `organizations.billing_status`.**

## 8. Edge Functions e contratos

### 8.1 `create-billing-checkout` (reestruturada)

```
create-billing-checkout/
  index.ts           auth, parse, permissão, roteamento por purpose
  context.ts         prelúdio comum: org, plano (do banco), cliente Asaas, gates de flag
  subscription.ts    purpose=subscription (sistema e instância)
  implementation.ts  purpose=implementation → _shared/implementation-checkout.ts
```

Contrato: `{ organization_id, plan_id, purpose }` com `purpose ∈ subscription | implementation | payment_method_update`. O servidor resolve categoria, modalidade, preço, intervalo e `billing_type`; o navegador não envia nenhum deles.

`mode` sai do contrato. Como o frontend em produção ainda manda `mode: 'setup'` para trocar cartão, a EF aceita o campo legado por **uma release**, mapeando `setup → payment_method_update` e logando `evt: "checkout_legacy_mode_param"`; o frontend passa a mandar `purpose` no mesmo PR, e a remoção do compat é item da 5b.

### 8.2 `manage-whatsapp-implementations` (nova)

`verify_jwt=true` no `config.toml` **no mesmo PR**, CORS via `_shared/cors.ts`, `platform_admin` obrigatório exceto onde indicado.

| Ação | Quem | Observação |
|---|---|---|
| `list` / `get` | admin | Registro completo |
| `create` | admin | Origem manual; matriz validada antes do insert |
| `create_asaas_charge` | admin | Usa `_shared/implementation-checkout.ts` — mesma lógica do cliente |
| `register_external_payment` | admin | `CONFIRMED` + valor/data/forma/referência |
| `set_operational_status` | admin | Transições válidas; `COMPLETED` só com pagamento `CONFIRMED`/`WAIVED` |
| `cancel` | admin | Motivo obrigatório; nunca apaga |
| `grant_whatsapp_override` / `revoke_whatsapp_override` / `list_whatsapp_overrides` | admin | Via helper único |
| `get_service_status` | owner/gerente da org **ou** admin | **Projeção segura** |

`get_service_status` devolve: `implementation` (`payment_status`, `operational_status`, `amount_cents`, `paid_at`, `scheduled_for`, `started_at`, `completed_at`, próxima etapa) — ou `NOT_REQUESTED` quando não há linha; `subscription` (existência, status, próximo vencimento); `override` (ativo, `grant_type`, `ends_at`); e as flags que a UI precisa. Nunca `notes`, `reason`, `external_payment_reference`, `owner_admin_id`, `created_by`.

### 8.3 `_shared/billing-notify.ts`

`resolvePlatformAdminRecipients()`: lê `platform_admins`, resolve e-mail em `auth.users`, descarta usuário inexistente, banido ou sem e-mail, deduplica por e-mail normalizado, loga quando o conjunto sai vazio. Não substitui nem reusa `resolveBillingRecipient` (org-scoped). Falha dele **nunca** derruba a confirmação financeira (best-effort, como o enqueue de `regularized`).

Novo `event_type` na fila: `implementation_paid`. `billing_notifications.event_type` é texto livre (sem CHECK), mas o dispatcher marca `status='failed'` com `unknown_event_type` para todo tipo sem template — então **o template entra em `process-billing-notifications` no mesmo PR** e a EF é redeployada junto. O índice de dedupe é parcial em `invoice_id`; o insert trata `23505` como no-op e o `invoice_id` é preenchido (existe fatura nesse caminho).

## 9. Interface

### 9.1 Cliente — `/g/:slug/cobranca`

Card "Automação WhatsApp", visível quando `whatsapp_implementation_flow` está ligada, com preços **antes** de qualquer clique: R$ 750 único, R$ 149/mês após a implantação, créditos de IA de R$ 50 a R$ 200 (R$ 70 recomendado) e a frase explícita de que mensalidade e créditos não estão inclusos nos R$ 750.

Estados: sem implantação → "Contratar implementação" · `PENDING` → aguardando confirmação, sem promessa de prazo · `CONFIRMED` + operacional em curso → etapa atual · `COMPLETED` → "Contratar instância — R$ 149/mês" (só se `whatsapp_subscription_checkout` ligada) · override ativo → "Acesso concedido pela plataforma", sem valor cobrado, próxima cobrança "Não aplicável" (vitalício) ou validade (temporário), **e nenhuma fatura de R$ 149 exibida como vencida**.

**Resumo consolidado**, com os quatro números distintos:

- Total mensal atual — R$ 449,00
- Total mensal após ativar a automação — R$ 598,00
- Pagamentos únicos — R$ 750,00 (implantação)
- IA — variável

Depois de contratada a instância, "total mensal atual" passa a R$ 598,00. Com override ativo: WhatsApp patrocinado pela plataforma, cobrança ao cliente "não aplicável", histórico financeiro visível mas não como obrigação corrente.

### 9.2 Admin

Rota `/platform/billing/implementacoes` (lista: empresa, origem, financeiro, operacional, valor, responsável; detalhe com as ações da §8.2) e bloco resumido no detalhe da organização (`BillingDetail.tsx`), separando visualmente **Implantação** (origem, valor, status financeiro, status operacional) de **WhatsApp** (fonte do acesso — assinatura paga × override —, tipo, validade, custo patrocinado).

Conceder cortesia/vitalício de WhatsApp exige confirmação explícita com o aviso: *"Esta empresa poderá gerar um custo mensal de Z-API para a plataforma, mesmo sem uma assinatura paga pelo cliente."*

Campos de gratuidade de IA **não aparecem** nesta fase — controle sem efeito no banco não é entregue.

## 10. Núcleo puro e testes

`_shared/whatsapp-implementation-core.ts` — zero imports, mesmo padrão de `billing-delinquency-core.ts`, testado por vitest a partir de `src/lib/whatsapp-implementation-core.test.ts`:

- `validateOriginPayment(origin, paymentStatus)` — matriz da §5.1;
- `canTransitionOperational(from, to, paymentStatus)` — inclusive a recusa de `COMPLETED` sem pagamento resolvido;
- `canContractInstance({ implementation, systemEntitlement, whatsappSubscription, whatsappOverride, flag })`;
- `buildClientImplementationView(row | null)` — projeção segura, incluindo `NOT_REQUESTED` na ausência de linha;
- `summarizeMonthlyCosts({ systemPlan, instancePlan, hasInstance, override })` — os quatro números da §9.1.

Cobertura exigida (unit): implantação em cortesia não libera a mensalidade · implantação paga não impede override vitalício · override de WhatsApp não libera IA · override não cria pagamento fictício · `LIFETIME` não expira e `TEMPORARY` deixa de valer após `ends_at` · revogação volta a exigir assinatura paga · pagamento externo é `CONFIRMED` e nunca `WAIVED` · `COMPLETED` recusado com pagamento `PENDING` · R$ 149 bloqueado até `COMPLETED` · estorno após entrega mantém `COMPLETED` com `REFUNDED`.

Cobertura em sandbox (roteiro B, como na 4b): checkout `DETACHED` cria e paga · `successUrl` não confirma nada · webhook confirma e notifica admin uma única vez · evento duplicado não repete fatura/notificação/atualização · duas assinaturas coexistem sem `PGRST116` · fatura de WhatsApp vencida **não** muda `organizations.billing_status` · cancelamento da instância não marca a org `canceled` · trial não é prorrogado por assinatura de WhatsApp · checkout concorrente devolve a mesma sessão · ação administrativa negada a não-admin.

## 11. Riscos e follow-ups

1. **Checkout `DETACHED` nunca exercitado ao vivo** — escrito na Fase 2 e sem nenhum call site desde então. Primeiro item do sandbox; a combinação de `billingTypes` pode ser recusada pelo Asaas.
2. **Renovação do mês 2+ sem `checkoutSession`** (herdado da 4a) passa a valer para duas assinaturas. Correlação por `provider_subscription_id` continua pendente e é bloqueante antes do primeiro ciclo real.
3. **Estorno após entrega** não reverte trabalho: `payment_status=REFUNDED` com `operational_status=COMPLETED`, auditoria e aviso ao admin. Política comercial de reembolso parcial não está desenhada.
4. **Sessões `creating` órfãs** (isolate morto entre a reserva e a resposta do Asaas) só são limpas na próxima tentativa do mesmo produto. Varredura periódica é follow-up da 5b.
5. **`regularized` com `invoice_id=null`** no caminho de renovação — follow-up #2 da 4b, ainda aberto.
6. **Queries sem `.range()`** em overdue/reminders — débito herdado, irrelevante na base atual.

## 12. Rollback

1. `whatsapp_implementation_flow` e `whatsapp_subscription_checkout` OFF → cards somem e os dois checkouts são negados no servidor.
2. `update billing_plans set active = false where slug in ('implementacao-whatsapp','instancia-whatsapp')`.
3. Frontend por revert de commit.
4. Migrations são aditivas e ficam. O sweep de category-awareness (§7) **não** é revertido — ele corrige comportamento errado que existe hoje independentemente da venda.

## 13. Checklist de fim de fase

`npm run lint` · `npm run typecheck` (`tsc -b`) · `npm run test` · `npm run build` · `supabase db push` + queries de validação pós-migration · `verify_jwt` no `config.toml` para a EF nova **no mesmo PR** · redeploy das EFs afetadas por `_shared/` · atualizar o checklist de redeploy do CLAUDE.md (`implementation-checkout.ts`, `entitlement-overrides.ts`, `whatsapp-implementation-core.ts`, `billing-notify.ts`) · gates `saas-shield-br` (RLS, isolamento multi-tenant, identidade/acesso, migrations, secrets, confiabilidade de integração) antes do merge · resumo da fase em `docs/billing-asaas/FASE-5A-RESUMO.md` · tag `billing-asaas/fase-5a` (usar `refs/heads/...` em merge e push).

**Redeploy por mudança em `_shared/`:**

- `asaas-billing-events-apply.ts` → `asaas-webhook`, `process-asaas-reconcile`, `manage-billing`
- `billing-notify.ts` → `process-billing-overdue`, `process-billing-reminders`, `asaas-webhook`, `process-asaas-reconcile`, `manage-billing`
- template `implementation_paid` → `process-billing-notifications` (sem ele, o aviso ao admin morre como `unknown_event_type`)
- `implementation-checkout.ts` → `create-billing-checkout`, `manage-whatsapp-implementations`
- `entitlement-overrides.ts` → `manage-whatsapp-implementations`
- `entitlements.ts` / `entitlements-core.ts` → `manage-billing`, `create-billing-checkout`
