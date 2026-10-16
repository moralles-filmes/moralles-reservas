---
paths:
  - "**/*billing*"
  - "**/*billing*/**"
  - "**/*asaas*"
  - "**/*stripe*"
  - "**/*entitlement*"
  - "**/*tax-id*"
  - "**/*whatsapp-instance*"
  - "**/*whatsapp_instance*"
  - "**/*whatsapp-implementation*"
  - "**/*whatsapp_implementation*"
  - "**/*whatsapp-service*"
  - "**/*whatsapp-subscription*"
  - "**/*whatsapp-connection-allowance*"
  - "supabase/functions/process-billing-*/**"
  - "supabase/functions/process-trial-expiry/**"
  - "supabase/functions/process-whatsapp-enforcement/**"
  - "supabase/functions/manage-whatsapp-implementations/**"
  - "supabase/functions/manage-whatsapp-instances/**"
  - "supabase/functions/manage-organizations/**"
  - "supabase/functions/create-checkout-session/**"
  - "supabase/functions/expire-pending-payments/**"
  - "supabase/functions/create-reservation/**"
  - "supabase/functions/manage-payment-methods/**"
  - "**/*implementation-checkout*"
  - "**/*platform-flags*"
  - "**/*platform_flags*"
  - "src/pages/gestao/Cobranca*"
  - "src/pages/platform/Billing*"
  - "src/pages/platform/WhatsappImplementations*"
  - "src/components/billing/**"
  - "src/components/Pricing*"
---

# Billing, caução e custo de WhatsApp

Caminhos repo-relativos. Plano, fases e decisões do Asaas: [docs/billing-asaas/](docs/billing-asaas/01-PLANO-IMPLEMENTACAO.md) — leia antes de mexer em billing, IA ou Z-API.

## Clientes reais e política

- **O único cliente ativo é Ren Sushi, vitalício grátis; Moralles é a própria plataforma** — ambos com `LIFETIME` em system+whatsapp+ai (não remover). Não há cliente pagante: todo fluxo de cobrança, bloqueio, notificação e débito de IA respeita o override ANTES de escalar, e plano cobrável ativo no catálogo é risco sem contrapartida.
- **Billing é por organização** (`billing_customers` 1:1 com `organizations`; 5 units pagam 1 mensalidade). Mensalidade usa a conta principal (sem Connect/`transfer_data`), separada da caução.
- **Trial 5d, grace 5d, bloqueio D+6.** `GRACE_PERIOD_DAYS`/`BLOCK_AFTER_DAYS`/`REMINDER_OFFSETS` vivem no núcleo [billing-delinquency-core.ts](supabase/functions/_shared/billing-delinquency-core.ts) (datas BRT). **A duração do trial vem de `billing_plans.trial_days` do único plano `is_trial AND active`**, e `trial_ends_at` é calculado na criação da org e nunca recalculado; tempo extra só por override `extend_trial`. UNIQUE PARTIAL garante um único plano trial ativo. Trial é one-shot: cancelou → `canceled`.

## Caução de reserva (Stripe Connect Standard, por unidade)

- **`create-reservation` detecta caução após `reserveSlot()`:** schedule com `charge_enabled` → `payment_status='pending_payment'`, `payment_expires_at = now()+15min`, `requires_payment: true`; o frontend chama `create-checkout-session`.
- **Reservas `source='whatsapp'` são isentas.**
- **`checkout.session.completed` marca `paid` e insere `notification_outbox` manualmente** — o trigger filtra `source` mas não re-filtra pagamento.
- **Expiração em defesa dupla:** worker `expire-pending-payments` + evento `checkout.session.expired`.

- **O retorno do onboarding Connect (`manage-stripe-accounts`) usa o endereço antigo `/platform/automacao/:unitSlug?stripe=complete`,** que depende do redirect permanente preservando query e hash ([legacy-redirects.tsx](src/pages/platform/legacy-redirects.tsx)). Mudar a URL de retorno ou o redirect exige mudar os dois.

## Segredos e flags

- **Stripe/Asaas vivem em `platform_secrets` (FORCE RLS; frontend só vê `last4`), lidos via `_shared/stripe-config.ts`/`asaas-config.ts` com cache de 5 min.** **A leitura cai para `Deno.env` em QUALQUER erro** (não distingue "sem linha" de "banco fora"): cópia velha em env é credencial viva. Rotacionar no painel sincroniza `supabase secrets set` no mesmo ato (ou remove a env) — `asaas_api_key`, `asaas_webhook_token`, `stripe_secret_key`, `stripe_webhook_secret`. [runbook](docs/RUNBOOK-ROTACAO-CREDENCIAIS.md).
- **Flags globais em `platform_flags` (FORCE RLS, sem leitura frontend), via `_shared/platform-flags.ts`** (cache 5 min, fail-closed). Seeds `on conflict do nothing` preservam o valor existente; implantação confere OFF efetivo. `clearPlatformFlagsCache()` não tem chamador (chamá-lo por invocação mudaria todos os consumidores).
- **`asaas_enabled` gateia as duas pontas:** `create-billing-checkout` e `asaas-webhook` (que descarta evento sem persistir quando OFF). Path novo que cria cobrança Asaas gateia ANTES de qualquer I/O — criar e abortar deixa `cus_` órfão (o Asaas não deduplica).

## Asaas

- **Código novo lê `provider` + `provider_*_id`; `stripe_*` é legado read-only.** Idempotência de webhook: UNIQUE `(provider, provider_event_id)` em `billing_events`. [migration 063](supabase/migrations/20260716130200_063_billing_provider_columns.sql).
- **Todo I/O externo dentro da resposta do `asaas-webhook` roda sob orçamento com falha rápida (`ASAAS_IO_BUDGET_MS` ~5s), nunca `waitUntil`.** O Asaas corta em 10s; 15 falhas seguidas interrompem a fila de eventos de todos os clientes. O orçamento é do caller (`applyAsaasEvent(…, { asaasIoBudgetMs })`); `process-asaas-reconcile` omite e faz retry completo.
- **Pagamento de checkout hospedado correlaciona por `checkoutSession`, não por `externalReference` nem `customer`** — o Asaas não propaga `externalReference` e o pagador gera `customer` novo. `create-billing-checkout` grava `billing_checkout_sessions` (persist-or-abort). Escada em [billing-correlation-core.ts](supabase/functions/_shared/billing-correlation-core.ts): fatura conhecida → assinatura do provedor (único elo da renovação do mês 2+, que não traz `checkoutSession`) → externalReference → sessão de checkout → cliente do provedor.
- **O formato do `externalReference` é contrato entre `create-billing-checkout` e todos os leitores de `parseExternalReference`** (aplicador e workers via `billing-category.ts`). Mudar exige redeploy de todos juntos: emissor velho faz o webhook não extrair org/plano; leitor velho faz `isSystemInvoice` cair em "sem vínculo → true" e bloquear a org por fatura de WhatsApp.
- **Cancelamento roteia por `getBillingProvider` e grava o estado local pelo `effective` que o provedor devolve.** No Asaas é sempre imediato (`INACTIVE`, nunca `DELETE`, que apagaria dívida); assinatura `stripe`/`asaas` sem id de provedor é recusada com 400; `manual`/`lifetime` cancelam só localmente. [billing-cancel-core.ts](supabase/functions/_shared/billing-cancel-core.ts).
- **As outras operações de `manage-billing` (`createSubscription`, `getSubscription`, `createOneTimeCharge`, `refundPayment`, `createCustomer` duplicado) seguem Stripe-nativas por decisão:** o destino é Asaas-only.
- **`decideReconcileAction` é a única decisão por cobrança em `process-asaas-invoice-reconcile`**, tomada sobre UM snapshot (criar RECONCILE/BACKFILL, liquidar `open`, reter divergência ou não-cobrável); duas chamadas sequenciais decidiam com status desatualizado. `billing_invoice_ingestion_since` é obrigatória com `billing_invoice_ingestion` ligada. [asaas-invoice-reconcile-core.ts](supabase/functions/_shared/asaas-invoice-reconcile-core.ts).

## Estado de acesso e categorias

- **`organizations.billing_status` é autoritativa para o `BillingGuard` e para checks server-side** (`create-reservation` rejeita `blocked`/`suspended`; `webhook-whatsapp` silencia o agente com `org_billing_blocked`), por SELECT direto. Valores: `active`, `trialing`, `pending_payment`, `past_due`, `grace_period`, `blocked`, `canceled`, `manual_override`, `suspended` (default `active`). Platform admin bypassa; `/g/<slug>/cobranca` é a única rota liberada para org bloqueada.
- **Quando o gatilho é fatura ou assinatura, só categoria `SYSTEM_SUBSCRIPTION` escreve `billing_status`** — pergunta centralizada em [billing-category.ts](supabase/functions/_shared/billing-category.ts). Não cobre overrides administrativos nem `process-trial-expiry`, que escrevem por autoridade própria. **A garantia depende de a fatura ter vínculo de plano** (`billing_subscription_id` ou `external_reference` com `plan:<uuid>`); sem nenhum, `isSystemInvoice` devolve `true` por compatibilidade — fechar isso é pré-requisito da primeira renovação recorrente real.
- **`isSystemInvoice === false` não diz qual produto é** (curto-circuita em `purpose='implementation'`/`'ai_topup'`). Nunca derive copy/consequência "é WhatsApp" de `!isSystem`.
- **O caminho legado do `stripe-webhook` escreve `billing_status` sem checar categoria em 4 eventos** — inalcançável só enquanto nenhum plano tiver `provider='stripe'` com Price ID (o painel ainda grava esses campos). Não construir sobre ele; se reativar, migrar para `billing-category.ts`.
- **`billing_events` é separada de `stripe_webhook_events`:** no `stripe-webhook`, `BILLING_EVENT_TYPES.has(eventType)` roteia antes do check de caução. `checkout.session.completed` é dual-purpose — `isBillingCheckout(obj)` discrimina; não mover para o set sem o discriminador.
- **`_shared/stripe-billing.ts` é helper sem SDK** (raw fetch) usado por `manage-billing` e workers; não confundir com `stripe-config.ts`.
- **Overrides manuais em `billing_access_overrides`:** `grant_access`→`manual_override`, `block_access`→`blocked`, `extend_trial`→`trialing`. Workers de inadimplência e lembretes pulam org com `grant_access` ativo ou override vitalício de sistema (`hasActiveSystemOverride`).
- **Entitlement por feature (system/whatsapp/ai) via [entitlements.ts](supabase/functions/_shared/entitlements.ts)** (+ `entitlements-core.ts`, mudam juntos); prioridade bloqueio admin > override > assinatura > trial, testada em [entitlements-core.test.ts](src/lib/entitlements-core.test.ts). Webhook financeiro nunca escreve `organization_entitlement_overrides`.
- **Concessão/revogação de entitlement só por `_shared/entitlement-overrides.ts`; só `TEMPORARY` carrega validade** — LIFETIME/PROMOTIONAL/MANUAL_OVERRIDE com data → 400.

## Catálogo de planos

- **`billing_plans` é catálogo de PRODUTOS; `category` decide onde aparece.** `PricingTable` só oferta `SYSTEM_SUBSCRIPTION` (`isSelectableSystemPlan`); use os helpers de [billing-plan-display.ts](src/lib/billing-plan-display.ts) em vez de ler `plan.category`/`plan.provider` cru.
- **Plano com `ai` em `included_features` não pode ser `active` — CHECK `billing_plans_ai_plan_not_sellable_chk` (097).** A migration que o dropar quando a venda abrir precisa de timestamp maior que `20260803120300` (antes disso o `drop if exists` é no-op silencioso); não dropar junto `billing_plans_included_features_chk`.
- **`billing_type='one_time'` carrega `interval='month'` no banco** (NOT NULL); renderize por `planIntervalLabel()`, que devolve `null` em cobrança única.
- **Destaque é `recommended`; `popular` é legado read-only.**

## Self-service e `manage-billing`

- **`/g/:slug/cobranca`:** owner/gerente ou platform_admin. Remover cartão é exclusivo de platform_admin (`manage-payment-methods` action `delete`, validado no servidor). `create-billing-checkout` gera `mode=subscription|setup`. Actions client-friendly (`CLIENT_FRIENDLY_ACTIONS`): `change_plan`, `preview_plan_change`, `cancel_subscription_by_owner` (sempre `cancel_at_period_end=true`).
- **Action client-friendly protege por duas perguntas: "de quem é a org?" e "que forma tem a resposta?".** `list_plans` (catálogo) dá ao lojista só `active=true` e colunas de vitrine; `get_organization_billing` checa `canManageOrgBilling` e responde por colunas explícitas (`ORG_BILLING_PUBLIC_COLUMNS`/`SUBSCRIPTION_PUBLIC_COLUMNS`). Moldar filtrando o payload admin depois de montá-lo é errado — campo novo entra por `select("*")` e vaza.

## Avisos (`billing_notifications`)

- **Produtores enfileiram `status='pending'` e só `process-billing-notifications` envia** (Resend, flag `billing_notifications_dispatch`; OFF = fila acumula). Produtor novo trata `23505` como no-op — **o UNIQUE `(organization_id, event_type, invoice_id)` é parcial e não deduplica com `invoice_id` nulo** — e resolve destinatário por `resolveBillingRecipient` (escopado por org via units→unit_members; owner sem filtro de org vaza cross-tenant). [billing-notify.ts](supabase/functions/_shared/billing-notify.ts).
- **`event_type` é contrato por STRING entre produtor e o `TEMPLATE_BY_EVENT` do dispatcher, sem arquivo compartilhado; dispatcher velho marca a linha `failed/unknown_event_type`.** Produtor e dispatcher deployam juntos. Listas canônicas, nunca redigitadas: `EVENT_TYPE_BY_ALERT` (`admin_zapi_*`, de `process-whatsapp-instance-cycles`, teste nas duas direções em [whatsapp-instance-alerts-dispatcher.test.ts](src/lib/whatsapp-instance-alerts-dispatcher.test.ts)) e `EVENT_TYPE_BY_MILESTONE_PERCENT` (`admin_ai_budget_70/80/90/stop`, produzidos pelo `webhook-whatsapp`; o 100% chama-se `_stop` pela consequência — não renomear por simetria). Outros produtores: `process-asaas-invoice-reconcile` (`admin_invoice_value_mismatch`, `admin_invoice_non_collectible_hold`), `process-whatsapp-enforcement` (`whatsapp_suspended`, `whatsapp_restored`, `admin_correlation_ambiguity`), `manage-billing` (`admin_cancel_local_write_failed` — provedor cancelou e a escrita local falhou: conferência humana, nunca retry).
- **`admin_correlation_ambiguity` é compartilhado por gatilhos distintos;** a copy é deliberadamente genérica.
- **Custo de instância desconhecido não tem `event_type`** — é pendência do painel (`PENDING_REVIEW`) e motivo do D-1.
- **Cadência de aviso sem fatura vive em ledger, nunca na fila:** o worker de ciclos só enfileira quando o ledger diz `created`/`reminded`, nunca `seen`; marcos de IA em `ai_budget_milestones`.
- **`billing_notifications_dispatch` não pode ser ligado para os `admin_zapi_*` enquanto não houver enqueue transacional (`ADMIN_ZAPI_ALERT_TRANSACTIONAL_ENQUEUE`):** entre enfileirar e carimbar, falha no carimbo duplica na execução seguinte. [FASE-6B-FOLLOWUPS](docs/billing-asaas/FASE-6B-FOLLOWUPS.md).

## Serviço de WhatsApp (gate, implantação, instâncias)

- **O gate pai do serviço lê `organizations.billing_status`, nunca `entitlements.system.allowed`** (falso para org legada `active` sem assinatura de sistema). [whatsapp-service-state-core.ts](supabase/functions/_shared/whatsapp-service-state-core.ts).
- **`enforced.sending` é a única consequência gateada por `whatsapp_service_enforcement`;** elegibilidade de provisionamento novo (`newProvisioningBlocked` → `resolveProvisioningEligibility`) nunca consulta a flag. Envio é fail-OPEN a soluço técnico; provisionamento é fail-CLOSED (custo externo novo só com tudo confirmado). Sob suspensão, o outbox legado estaciona sem incrementar `attempts`.
- **A query da fatura em aberto mais antiga é idêntica campo a campo em `resolveWhatsAppGateByOrg` e `process-whatsapp-enforcement`** — divergir faz gate de envio e worker discordarem sobre quem está inadimplente.
- **Copy "está suspensa" escolhe o tempo verbal por `sendingBlocked`, nunca por `serviceState`** (com a flag OFF o estado pode ser `SUSPENDED_UNPAID` com envio funcionando). [WhatsappServiceBanner.tsx](src/components/billing/WhatsappServiceBanner.tsx).
- **Receita atribuível à instância = assinatura legada `WHATSAPP_SUBSCRIPTION` ou `whatsapp_component_cents` de plano de sistema que declara `whatsapp` — nunca a mensalidade inteira;** receita `NULL` é dado ausente, não zero. [whatsapp-instance-revenue-core.ts](supabase/functions/_shared/whatsapp-instance-revenue-core.ts).
- **Implantação (`whatsapp_implementations`): no máximo uma linha não-cancelada por org** (índice parcial). O caminho admin trata `23505` como 409; o checkout do cliente só faz SELECT antes e, sob corrida, vira 500 genérico. **`cancel` é a única porta para `CANCELED`** (exige `cancel_reason`). Matriz origem×pagamento e estados em [whatsapp-implementation-core.ts](supabase/functions/_shared/whatsapp-implementation-core.ts), importado direto pelo frontend. **Operação manual nunca preenche `billing_invoice_id`/`provider_checkout_id`** (CHECK `whatsapp_impl_no_fake_asaas_chk`).
- **Credencial de instância em claro é recusada por default (`whatsapp-instance-core.ts`, fail-closed para callers antigos);** só a UazAPI passa `credentialsEncryptedAtRest:true`, e só depois de garantir o Vault.
- **`whatsapp_instances.lifecycle_state` registra CUSTO da plataforma, nunca autoriza envio ou entitlement.** Quem corta o serviço é o gate de sete estados.
- **`provider_due_on`/`provider_access_until` são exclusivos (primeiro dia NÃO coberto);** a UI escreve "acesso até `until - 1`". **`provider_cycle_anchor_day` é persistido e nunca re-derivado** (âncora 31 degradaria para 28). Painel e worker calculam o próximo vencimento pela mesma função de [whatsapp-instance-cycle-core.ts](supabase/functions/_shared/whatsapp-instance-cycle-core.ts).
- **Ledger `whatsapp_instance_alerts`: `subject_id` é identidade imutável e `instance_id` pode ser nulado** (exigi-lo tornava o `on delete set null` inexecutável); rigor de INSERT na trigger `whatsapp_alert_subject_guard`. **A guarda de `whatsapp_instance_notes` (096) é mais estrita que a da 089 de propósito** — corrija apertando a 089, nunca afrouxando a 096. O vocabulário de ações de notas (`whatsapp-instance-notes-core.ts`) é gêmeo do CHECK da [migration 104](supabase/migrations/20260807100000_104_whatsapp_cycle_cost_and_end.sql).
- **Custo de ciclo é fotografado nos três momentos:** nascimento (`confirm_cycle_date`), preenchimento de nulo (`set_whatsapp_instance_cost`) e rolagem. Preencher nulo é permitido; sobrescrever só por `correct_cycle_cost` em `PENDING_REVIEW` (ciclo `CLOSED` não reabre). `customer_revenue_cents`/`revenue_source`/`gross_margin_cents` não têm produtor — a margem é calculada em memória só para `ECONOMIC_IMBALANCE`.
- **Encerramento de instância: a primeira confirmação vence nos três campos** (`ended_at`, `ended_by`, `end_confirmation_note`); repetições vão ao ledger de notas.
- **`23505` em `confirm_cycle_date` não é reexecução por default:** o discriminador é o ciclo OPEN (OPEN com data diferente → 409 `OPEN_CYCLE_DATE_MISMATCH`; erro de leitura → 503), não "existe linha com esta `cycle_start`".
- **Toast de ação administrativa com consequência pendente diz qual** — copy em função pura de [whatsapp-instance-format.ts](src/lib/whatsapp-instance-format.ts); `hasOpenCycle: null` não afirma nada.
- **Registro de instância faz três perguntas independentes; a de unidade duplicada fica fora do `checkConnectionAllowance`** (compartilhado com `manage-channels`, onde não faz sentido) e vale em `register_instance` e `update_instance` (pula se `unit_id` não muda, exclui a própria instância). [registration-core](supabase/functions/_shared/whatsapp-instance-registration-core.ts). O teto de conexões (`whatsapp-connection-allowance-core.ts`) tem duas portas: `manage-whatsapp-instances` e `manage-channels`.
- **Decisão do worker de ciclos vive em [whatsapp-instance-worker-core.ts](supabase/functions/_shared/whatsapp-instance-worker-core.ts);** o teste de acoplamento reprova se `EVENT_TYPE_BY_ALERT` reaparecer no `index.ts`.
- **Slot mensal de lembrete: toca (barreira de persistência) → enfileira → carimba;** `enqueueBillingNotification` devolve `boolean` (`true` também em `23505`). Inverter reabre aviso diário sem teto ou ledger mentindo "lembrado". A criação também consome o slot.
- **`UPDATE` com predicado de tenant que casa zero linhas devolve `error: null`:** confira com `.select()` antes de enfileirar aviso.

## Outros gêmeos

- **`_shared/tax-id.ts` ⇄ [src/lib/tax-id.ts](src/lib/tax-id.ts)** (backend não importa `src/`); a sincronia é o [teste](src/lib/tax-id.test.ts) que importa os dois.
