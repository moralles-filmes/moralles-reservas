# FASE 0 — Auditoria: Migração de Billing Stripe → Asaas

> Data: 2026-07-16 · Nenhum arquivo de código foi alterado nesta fase.
> Método: 5 varreduras paralelas do repositório + consultas read-only ao banco de produção (`gbabxcrntkwgblgqsiit`).
> Documento-irmão: [01-PLANO-IMPLEMENTACAO.md](01-PLANO-IMPLEMENTACAO.md).

---

## 1. Sumário executivo

1. **A exposição real à Stripe em produção é quase nula.** 3 organizações existem; as 2 reais (Moralles, Ren Sushi) estão `active` **sem** assinatura e **sem** customer Stripe. A única org com vínculo Stripe é "Seu Japa Teste" (org de teste): assinatura **cancelada**, plano R$ 99,99/mês, 1 invoice aberta, `past_due`. **Não há cliente pagante real para migrar.** O risco de dupla cobrança na migração é ~zero.
2. **O módulo de caução (Stripe Connect per-unit) nunca foi usado em produção**: 0 linhas em `stripe_accounts`, 0 reservas pagas ou pendentes. Ele está **fora do escopo** desta migração (cobra o cliente final da reserva, não a organização) e pode ficar congelado como está.
3. **Lacuna crítica descoberta: avisos de cobrança nunca chegam ao cliente.** `process-billing-reminders` insere `billing_notifications` com `status='pending'` e `channel='email'`, mas **nenhum worker consome esses registros** — não existe dispatcher. Cliente só descobre inadimplência pela tela de bloqueio in-app. O novo modelo (avisos D+1/D+3/D+5) exige construir essa camada do zero.
4. **Não existe mecanismo de feature flag** no projeto. Será a primeira entrega da Fase 1.
5. **A IA hoje é 100% BYOK per-unit** (chave do próprio tenant em `ai_provider_credentials`, 5 provedores) com **um único ponto de consumo** (`webhook-whatsapp` → `runAgentLoop`). Uso de tokens é medido mas **não persistido** (só `console.log`). A carteira de créditos exige decisão de modelo comercial (ver §10.3).
6. **Não existe integração com API de parceiro da Z-API.** Só 2 endpoints são usados (`send-text`, `status`); provisionamento de instância é manual no painel Z-API. A máquina de estados de instância será construção nova.
7. O trial atual é **data-driven** (`billing_plans.trial_days` do plano `is_trial=true`) e **hoje não há plano trial ativo cadastrado** — org nova nasce `active` sem trial (fallback silencioso). Mudar para 5 dias é operação de dado + seed, não refactor.

---

## 2. Estado de produção (números reais, 2026-07-16)

| Métrica | Valor |
|---|---|
| Organizações | 3 (Moralles `active`, Ren Sushi `active`, Seu Japa Teste `past_due`) |
| Units | 3 |
| `billing_customers` com `stripe_customer_id` | **1** (Seu Japa Teste) |
| `billing_subscriptions` | **1**, status `canceled` |
| `billing_invoices` | 2 (1 `open`, 1 `paid`) |
| `billing_plans` | 3 (2 ativos, 1 inativo; **nenhum `is_trial=true`**) |
| Overrides ativos | 0 |
| `stripe_accounts` (Connect/caução) | **0** |
| Reservas pagas / pendentes de pagamento | 0 / 0 |
| Canais WhatsApp | 1 (`connected`) |
| `ai_provider_credentials` ativas | 2 |
| `platform_secrets` | `stripe_secret_key`, `stripe_webhook_secret` |
| Jobs pg_cron ativos | 12 (billing-overdue/reminders/reconcile/unblock/trial-expiry, outbox, reminders, surveys, vouchers, waitlist-feedback, expire-pending-payments, cleanup-orphan-assets) |

**Consequência estratégica:** as 2 orgs reais operam como cortesia implícita (sem assinatura). Na Fase 9, elas devem receber **override formal** (`LIFETIME`/`MANUAL_OVERRIDE`) para não serem suspensas quando as regras novas de trial/inadimplência entrarem.

---

## 3. Arquitetura atual do billing — dois mundos Stripe

| | **CAUÇÃO** (fora do escopo da migração) | **MENSALIDADE** (alvo da migração) |
|---|---|---|
| Conta Stripe | Connect per-unit (`transfer_data.destination`) | Conta principal da plataforma |
| Cobra | Cliente final da reserva | Organização (SaaS) |
| Tabelas | `stripe_accounts`, `stripe_webhook_events`, `reservations.payment_*` | `billing_customers`, `billing_plans`, `billing_subscriptions`, `billing_invoices`, `billing_events`, `billing_access_overrides`, `billing_notifications`, `organizations.billing_*` |
| EFs | `create-checkout-session`, `expire-pending-payments`, `manage-stripe-accounts` | `manage-billing`, `create-billing-checkout`, `manage-payment-methods`, `process-billing-*`, `process-trial-expiry` |
| Uso em produção | **Zero** | 1 org de teste |

Ponto único compartilhado: `stripe-webhook/index.ts` recebe os dois mundos e roteia em runtime pelo discriminador `isBillingCheckout(obj)` (linhas 26-32): `metadata.reservation_id` → caução; `mode in (subscription,setup)` ou `metadata.organization_id` → billing. Idempotência separada: `stripe_webhook_events` (caução) vs `billing_events` (billing).

### 3.1 Tabelas de mensalidade (schema resumido)

- **`organizations`**: `billing_status` (CHECK: `active, trialing, pending_payment, past_due, grace_period, blocked, canceled, manual_override, suspended`; default `active`), `billing_email`, `trial_ends_at`, `blocked_at`, `blocked_reason`. Migration `20260528000000_billing_module.sql:12-37`.
- **`billing_customers`**: 1:1 com org (UNIQUE `organization_id`), `stripe_customer_id`, name/email/tax_id. FORCE RLS sem policies.
- **`billing_plans`**: slug UNIQUE, `stripe_price_id_card/_boleto/_pix`, `amount_cents`, `interval` (month/year), `trial_days`, `is_trial` (UNIQUE parcial: 1 trial ativo), `popular`, `description`, `features jsonb`, `max_units`, `max_members_per_unit`, `active`, `sort_order`. RLS: leitura `authenticated` (só ativos) + platform_admin ALL.
- **`billing_subscriptions`**: `stripe_subscription_id` (UNIQUE parcial), status CHECK (`active,trialing,past_due,canceled,unpaid,paused`), `payment_method` CHECK (`card,boleto,pix,manual`), períodos, `cancel_at_period_end`. FORCE RLS.
- **`billing_invoices`**: `stripe_invoice_id` (UNIQUE parcial), status CHECK (`draft,open,paid,void,uncollectible`), `amount_cents`, `hosted_invoice_url`, `due_date`, `paid_at`. FORCE RLS.
- **`billing_events`**: `stripe_event_id` UNIQUE (idempotência billing). FORCE RLS.
- **`billing_access_overrides`**: `override_type` CHECK (`grant_access, block_access, extend_trial`), `reason` NOT NULL, `granted_by`, `valid_until`, `active`. RLS platform_admin. **Sem worker que expire por `valid_until`** (gap).
- **`billing_notifications`**: event_type/channel/recipient/status **livres, sem CHECK**. FORCE RLS.
- **`platform_secrets`**: key/value/last4 globais, FORCE RLS, `value` em **texto puro**. `VALID_KEYS` hardcoded = só as 2 chaves Stripe (`manage-platform-secrets/index.ts:17-20`).

### 3.2 Máquina de estados `organizations.billing_status`

Constantes atuais: `GRACE_PERIOD_DAYS=3`, `BLOCK_AFTER_DAYS=4` (`process-billing-overdue/index.ts:14-15`); `REMINDER_OFFSETS=[-3, 0, +1, +3, +4]` (`process-billing-reminders/index.ts:23-29`). **O novo modelo pede tolerância de 5 dias com suspensão em D+6 e avisos D+1/D+3/D+5** — mudança de constantes + cadência.

| Valor | Escritores |
|---|---|
| `active` | default; manage-billing (unblock, sub sem trial); webhook (`invoice.paid` desbloqueia); reconcile; unblock worker |
| `trialing` | manage-organizations (criação); manage-billing (extend_trial); webhook |
| `pending_payment` | **NINGUÉM escreve — estado morto** (só existe no CHECK e é lido) |
| `past_due` | webhook (`invoice.payment_failed`); overdue worker |
| `grace_period` | só overdue worker (due_date ≤ hoje−3d) |
| `blocked` | overdue worker (D+4); process-trial-expiry; block manual |
| `canceled` | cancel imediato; webhook `subscription.deleted` |
| `manual_override` | override `grant_access` |
| `suspended` | webhook/reconcile (sub `paused`) |

Guards server-side que leem `billing_status`: `create-reservation` (rejeita blocked/suspended) e `webhook-whatsapp:1204-1216` (silencia agente, outcome `org_billing_blocked`) — **este último é o molde exato para o gate de saldo de IA**.

### 3.3 Trial atual

- Aplicado em `manage-organizations/index.ts:178-201` na criação da org: busca plano `is_trial=true AND active=true`; se `trial_days>0` → `trialing` + `trial_ends_at`. Sem plano trial → org nasce `active` **sem aviso** (fallback silencioso; é o estado atual de produção).
- Expiração: `process-trial-expiry` (03:00 UTC) → `blocked`, pulando orgs com subscription viva ou override `grant_access`. Guard anti-race `.eq('billing_status','trialing')`.
- Nenhuma migration faz seed de plano trial. "14 dias" não existe em código — mudar para **5 dias** é criar/ajustar o registro do plano trial.

### 3.4 Notificações de billing — LACUNA CRÍTICA

- `process-billing-reminders` resolve destinatário (`organizations.billing_email` → fallback e-mail do owner), deduplica por org+event_type+dia e insere `billing_notifications` com `status='pending'`, `channel='email'`… **e para aí**. Nenhuma EF lê os `pending` e chama `sendEmail` (Resend, `_shared/email.ts`, usado só em `send-confirmation`). Nenhum aviso de billing usa WhatsApp.
- `billing_email` nasce **nulo** na criação da org (`manage-organizations/index.ts:120-124`).
- O novo modelo exige avisos reais desde D+1 → a camada de dispatch de notificações de billing precisa ser construída (Fase 4), reutilizando Resend e/ou WhatsApp administrativo — **nunca a instância inadimplente do próprio cliente** (§17 da spec).

---

## 4. Painel atual (frontend)

- **`/platform/billing`** (`Billing.tsx`): KPIs (MRR, ativos, vencidos, bloqueados), busca/filtro por status, tabela de orgs, bloquear/desbloquear com motivo.
- **`/platform/billing/planos`** (`BillingPlans.tsx`): colunas Nome/Slug/Valor/Intervalo/**Stripe price (cartão)**/Status/ações. Modal com os campos citados na spec + seção "**Stripe Price IDs**" (3 inputs `price_...`) — é onde a des-stripificação visual acontece (Fase 3).
- **`/platform/billing/:organizationId`** (`BillingDetail.tsx`): cards Customer Stripe / Assinatura / Info; ações criar customer, criar assinatura, cancelar, fatura manual, override, estender trial, bloquear; tabs Faturas/Cartões/Overrides/Notificações; botão "Sincronizar Stripe".
- **`/g/:slug/cobranca`** (`Cobranca.tsx`, cliente): banner de bloqueio, card trial local, plano atual, cartão (troca via Checkout `mode=setup`), PricingTable (filtra `is_trial`), preview de proration, cancelamento. Pós-redirect lê `?session=success&sid=…` com refetch escalonado — contrato a preservar no checkout Asaas.
- **`BillingGuard.tsx`**: `BLOCKED=[blocked,suspended]`+`canceled` → tela `PaymentRequired` exceto rota `/cobranca` (whitelist); `WARNING=[pending_payment,past_due,grace_period]` → banner; `trialing` ≤3d → banner. Bypass total platform_admin. **Base pronta para "suspensão por serviço"** — hoje é binário (org inteira), precisará consumir entitlements (system/whatsapp/ai) na Fase 4-5.
- Navegação `/platform`: sidebar com 3 itens (Empresas, Automação, Cobranças) via `PlatformLayout` + `AdminShell`. As novas áreas (Implementações, Instâncias, IA, Webhooks) entram como sub-navegação/tabs de `/platform/billing/*`.
- Labels/formatters centralizados em `src/types/billing.ts` (`BILLING_STATUS_LABEL/VARIANT`, `formatCentsBRL`).
- Achados menores: `organizations.plan` (string legada editável em Empresas, desconectada do billing real — confunde e deve ser aposentada na UI); `useSetDefaultPaymentMethod` sem uso (dead code); KPI "Vencidos" inclui `pending_payment` que nunca é escrito.

---

## 5. IA hoje (mapa para a carteira de créditos)

- **Um único ponto de consumo faturável em todo o repo**: `webhook-whatsapp/index.ts:2048` → `runAgentLoop` (`_shared/ai-providers.ts:211`). Grep global confirma: nenhum outro worker/front chama LLM.
- **BYOK per-unit sem fallback global**: `resolveApiKey` (`webhook-whatsapp/index.ts:92-104`) lê `ai_provider_credentials` (FORCE RLS; UNIQUE `(unit_id, provider)`); sem chave → handoff (`api_key_not_configured:<provider>`).
- **Usage capturado por turno** (`AgentUsage`: input/output/cache_creation/cache_read) e agregado em `totalUsage`; custo estimado por `estimateCostUsd` + `PRICING_USD_PER_MTOK` (`ai-providers.ts:111-132`). **Persistência: nenhuma** — evento `agent_usage` é `console.log`; em banco só `webhook_executions.meta.tokens` (inteiro somado, TTL 30d).
- Lacunas de precisão a fechar (Fase 7): thinking/reasoning tokens não capturados (OpenAI `reasoning_tokens`, Gemini `thoughtsTokenCount`); `cache_creation` fixo em 0 fora do Claude; fallback Gemini flash→pro **não é refletido** no modelo usado para estimar custo (`usedModel=modelOverride`, `webhook-whatsapp/index.ts:2134`); modelos fora de `PRICING_USD_PER_MTOK` retornam custo **0**.
- Limites existentes por chamada: `max_tokens 1024`, timeout 12s, 2 retries, `MAX_ITERATIONS=12`, retry silencioso do agente com budget 30s (o débito deve considerar que `totalUsage` acumula os attempts).
- **Pontos de inserção identificados**: gate de saldo espelhando o gate de billing em `webhook-whatsapp/index.ts:1204-1216` (antes de montar o prompt) e/ou pós-`resolveApiKey`; débito/persistência junto ao log `agent_usage` (`:2135-2144`), onde `totalUsage`, provider e modelo já estão em escopo.
- `manage-ai-providers`: actions `list/upsert/delete` (platform_admin). Não há action de saldo/consumo — lugar natural de expansão.

---

## 6. Z-API hoje (mapa para provisionamento de instância)

- **Endpoints usados: apenas 2** — `POST .../send-text` (`_shared/whatsapp-providers.ts:328`) e `GET .../status` (teste de conexão, `manage-channels/index.ts:215`). **Nenhuma chamada à API de parceiro** (criar/assinar/cancelar instância) existe; grep confirma ausência total.
- Provisionamento manual: platform_admin cola `instance_id/token/client_token` no `AddChannelDialog`; webhook URL (com `?channel=<id>&secret=<hex>`) é copiada manualmente pro painel Z-API. **Não há QR code na aplicação** — pareamento acontece no painel da Z-API.
- `whatsapp_channels.status` CHECK só admite `connected/disconnected/error` — a FSM nova (NOT_REQUESTED→…→CANCELED) **não cabe** nesse enum; recomendação: tabela nova `whatsapp_instances` para o ciclo de vida comercial/provisionamento, mantendo `whatsapp_channels` como camada de mensageria (não quebra webhook nem envio).
- Credenciais em JSONB **texto puro** (`manage-channels/index.ts:87` admite "add pgcrypto encryption in production") — automatizar provisionamento aumenta a superfície; criptografia em repouso entra na Fase 6.
- Webhook secret na query string é limitação da Z-API (não aceita headers custom) — já documentado em memória do projeto; rotação é a mitigação.
- Múltiplos canais por unit são permitidos pelo schema (UNIQUE `unit_id, provider, display_phone`), mas o envio resolve o **primeiro `connected` por `created_at`** e o health-check assume 1 canal — modelo mental é 1 canal/unit.
- `webhook-zapi` é legado morto (responde 410).

---

## 7. Organizações, permissões, jobs

- **Criação de org**: exclusiva de platform_admin via `manage-organizations` (`create_organization`): auth user owner → organization → unit → unit_member(owner) → trial automático, com rollback manual em cadeia. **Não cria** billing_customer, canal WhatsApp, nem `billing_email`. O trial de 5 dias do novo modelo pluga direto aqui.
- **Papéis**: `platform_admins` (global) + `unit_members` (`owner|gerente|operador`). Helpers SQL `is_platform_admin`, `is_unit_member`, `is_org_member` (SECURITY DEFINER). EFs client-friendly de billing usam `canManageOrgBilling` (owner/gerente da org OU platform_admin).
- **Jobs pg_cron**: padrão único — wrapper `SECURITY DEFINER` lê `internal_api_key` do Vault → `pg_net.http_post` com `x-internal-key` → EF valida `requireInternalAuth`. Todo worker novo precisa de entrada `verify_jwt=false` no `config.toml` **antes** do deploy (CLI ≥2.95 mudou default).
- **audit_log**: cobre só `customers`, `reservations`, `unit_members`. Billing/orgs/units/channels **sem trilha** — a spec exige auditoria de ações financeiras manuais; o trigger genérico `audit_trigger_func()` existe e pode ser anexado às tabelas novas.
- **Feature flags: inexistentes** (grep zero). O mais próximo é `settings` per-unit (jsonb) e `platform_secrets` global. Fase 1 cria mecanismo global (`platform_flags` no padrão FORCE RLS + cache 5min nas EFs, espelhando `stripe-config.ts`).

---

## 8. Acoplamentos Stripe que a abstração precisa contornar

**Colunas com nome `stripe_*`** (manter, adicionar colunas genéricas ao lado — migração aditiva):
`billing_customers.stripe_customer_id` · `billing_plans.stripe_price_id_{card,boleto,pix}` · `billing_subscriptions.stripe_subscription_id` · `billing_invoices.stripe_invoice_id` · `billing_events.stripe_event_id` (UNIQUE = idempotência amarrada à Stripe) · `reservations.stripe_*` (caução) · `stripe_accounts.*`.

**Conceitos Stripe-específicos no código**:
- Verificação de webhook HMAC `t=...,v1=...` (Asaas usa token simples no header `asaas-access-token`).
- `payment_behavior=default_incomplete`, `client_secret`, `latest_invoice.payment_intent` (`stripe-billing.ts`).
- Proration (`proration_behavior`, `/invoices/upcoming`) — **Asaas não tem equivalente direto**; troca de plano no Asaas será "atualizar valor da assinatura no próximo ciclo" ou cobrança avulsa de diferença.
- Checkout `mode=subscription|setup` + `trial_period_days`.
- `transfer_data[destination]` (Connect, caução — fora de escopo).
- Mapas de status Stripe→local (`billingStatusMap` no webhook; `statusMap` no reconcile) — precisarão de resolver per-provider (Asaas: `ACTIVE/EXPIRED/OVERDUE/INACTIVE`; payments: `PENDING/CONFIRMED/RECEIVED/OVERDUE/REFUNDED/CHARGEBACK_*`).
- `api.stripe.com/v1` hardcoded em 6+ arquivos; `platform_secrets.VALID_KEYS` só aceita as 2 chaves Stripe.
- `manage-billing` tem `stripeRequestRaw` inline duplicado do helper.

---

## 9. Riscos identificados

| # | Risco | Severidade | Mitigação no plano |
|---|---|---|---|
| R1 | Avisos de billing não são enviados hoje; novo modelo depende deles | **Alta** | Fase 4 constrói dispatcher (Resend + canal admin); testes de cadência D+1/D+3/D+5 |
| R2 | Orgs reais (Moralles, Ren Sushi) sem assinatura serão bloqueadas quando regras novas ativarem | **Alta** | Fase 9 concede override LIFETIME/MANUAL antes de ativar workers novos |
| R3 | Crédito duplo de IA / dupla ativação por webhook reenviado | Alta | UNIQUE `(provider, provider_event_id)` + `idempotency_key` no ledger; testes 6/7/22 |
| R4 | Concorrência no débito da carteira (N chamadas simultâneas) | Alta | Transação + lock de linha (RPC SECURITY DEFINER estilo `try_claim_conversation_for_ai`); teste 21 |
| R5 | Tokens Z-API/parceiro em texto puro no banco | Média | pgcrypto/criptografia app-side na Fase 6; partner token só em `platform_secrets` |
| R6 | Custo Gemini estimado com modelo errado no fallback flash→pro | Média | Fase 7 expõe `modelUsed` real do loop antes de ativar débito |
| R7 | `pending_payment` morto + `organizations.plan` legado confundem novos fluxos | Baixa | Fase 3 aposenta na UI; documentar; não reutilizar |
| R8 | Webhook Asaas sem validação adequada (token na query? replay?) | Alta | EF `asaas-webhook` valida header token + persiste evento antes de processar (fila) |
| R9 | Overrides com `valid_until` não expiram automaticamente | Média | Worker de entitlements (Fase 9) passa a expirar |
| R10 | Migrations aplicadas fora de `supabase db push` causam drift | Média | Regra existente do CLAUDE.md; validação pós-migration em cada fase |
| R11 | `verify_jwt` default true bloquearia workers/webhook novos silenciosamente | Média | Checklist por fase: entrada no `config.toml` no mesmo PR |
| R12 | Proration prometida na UI atual não existe no Asaas | Média | Fase 4 redefine UX de troca de plano (sem proration automática) |

---

## 10. Divergências espec ↔ realidade (decisões a validar com o administrador)

### 10.1 Nomenclatura de tenant
A spec fala em `company_id`. O sistema usa `organizations → units`. **Todo billing já é por organização** — o plano usa `organization_id` em todas as entidades novas (ai_wallets, entitlement_overrides etc.). "Empresa" na spec = `organization` no código.

### 10.2 Caução Stripe Connect
Fora do escopo da spec e sem uso em produção. **Recomendação: congelar como está** (código permanece, 0 impacto), avaliar Asaas split/subconta em fase futura separada. Nenhuma tabela/EF de caução será tocada.

### 10.3 IA: BYOK vs plataforma — decisão de produto necessária
A spec assume que a plataforma paga o Gemini e vende créditos. Hoje a chave é **do tenant** (BYOK), então o custo já é do cliente. Os dois modelos podem coexistir, mas é preciso definir:
- **Modo proposto (recomendado)**: unit sob o modelo de créditos usa **chave da plataforma** (nova credencial `platform`-owned, fora de `ai_provider_credentials` per-unit) e todo consumo debita a carteira via `ai_model_prices`. Units legadas BYOK continuam sem carteira (flag por org).
- Alternativa: manter BYOK e debitar carteira como "taxa de uso" — contradiz "valor pago = valor creditado, sem margem" (§3.4 da spec).
A carteira e o gate são construídos igual nos dois casos; o que muda é de quem é a chave. **Fase 7 só ativa débito real após essa confirmação.**

### 10.4 Tolerância e trial
Atual: grace 3d, bloqueio D+4, lembretes [-3,0,+1,+3,+4], trial data-driven (sem plano ativo). Novo: tolerância 5d, suspensão D+6, avisos D+1/D+3/D+5, trial 5d somente sistema. Mudança de constantes + seed + cadência — mas os workers atuais suspendem a **org inteira**; o novo modelo suspende **por serviço** (system/whatsapp/ai), o que exige a camada de entitlements (Fase 1) antes.

### 10.5 Tabelas conceituais da spec × tabelas existentes (mapeamento aditivo)

| Spec | Decisão |
|---|---|
| `billing_providers` | Coluna `provider` (`stripe|asaas|manual|lifetime`) nas tabelas existentes; sem tabela própria |
| `billing_products` / `billing_prices` | **Estender `billing_plans`** (`category`, `provider`, `billing_type one_time|recurring`, `amount_credited_cents`, `recommended`, `requires_plan_id`, `provider_metadata jsonb`) — mantém painel atual funcionando. `billing_customers` NÃO ganha coluna `provider`: mantém `stripe_customer_id` e `asaas_customer_id` lado a lado (uma org pode ter os dois durante a transição) |
| `billing_orders` / `billing_order_items` | Novas (carrinho interno) |
| `billing_checkouts` | Nova (checkout Asaas tem id próprio e expiração) |
| `billing_subscriptions` | Existente + `provider`, `provider_subscription_id` |
| `billing_payments` | **Estender `billing_invoices`** (`provider`, `provider_payment_id`, `purpose`, `external_reference`, `payload jsonb sanitizado`) — Asaas "payment" ≈ invoice |
| `billing_webhook_events` | **Estender `billing_events`** (`provider`, `provider_event_id`, UNIQUE composto, `processing_status`, `error_message`, `retry_count`) |
| `billing_notifications` | Existente + dispatcher novo + UNIQUE dedupe (org, event_type, billing_cycle) |
| `company_entitlement_overrides` | Nova `organization_entitlement_overrides` (feature-scoped: system/whatsapp/ai); `billing_access_overrides` continua até migrarmos os 3 tipos atuais |
| `whatsapp_implementations` | Nova |
| `whatsapp_instances` | Nova (FSM comercial; FK opcional para `whatsapp_channels`) |
| `ai_credit_packages` | Linhas de `billing_plans` com `category='AI_CREDIT_PACKAGE'` + `amount_credited_cents` |
| `ai_wallets`, `ai_wallet_transactions`, `ai_usage_events`, `ai_model_prices`, `ai_auto_recharge_settings` | Novas |
| `audit_logs` | Existente `audit_log`; anexar `audit_trigger_func()` às tabelas novas + log de ações manuais nas EFs |

### 10.6 Segredos Asaas
A spec pede env vars. O padrão do projeto para chaves de billing é `platform_secrets` (DB, painel `/platform/automacao`) com fallback `Deno.env` — **recomendação: seguir o padrão do projeto** (estender `VALID_KEYS` com `asaas_api_key`, `asaas_webhook_token`; `ASAAS_ENV`/URLs em `supabase secrets`). Nunca `VITE_*`.

---

## 11. Plano de rollback (princípios gerais)

1. **Migrations 100% aditivas** — nenhuma coluna/tabela Stripe é removida até fase final aprovada. Rollback de schema = não usar as colunas novas (dados novos ficam órfãos, sem quebrar nada).
2. **Feature flags como interruptor mestre**: `asaas_enabled`, `billing_provider_default`, `entitlements_enforced`, `ai_wallet_enforced`, `zapi_auto_provisioning`, `ASAAS_CARD_TOKENIZATION_ENABLED` — todos default **off**. Rollback imediato = desligar flag (sem deploy).
3. **EFs versionadas por git**: rollback = `supabase functions deploy <nome>` do commit anterior (tags `fase-N` por fase).
4. **Workers novos**: rollback = `cron.unschedule(<job>)` (padrão idempotente já usado nas migrations de cron).
5. **Stripe permanece funcional** durante toda a migração (webhook ativo, reconcile ativo) até cutover aprovado; a única assinatura Stripe existente já está cancelada, então o cutover não tem janela de dupla cobrança.
6. **Validação pós-migration** em cada fase: query de sanidade (contagens, CHECKs, RLS `FORCE`) documentada no PR.

---

*Próximo documento: [01-PLANO-IMPLEMENTACAO.md](01-PLANO-IMPLEMENTACAO.md) — fases 1 a 11 com entregas, testes e rollback por fase.*
