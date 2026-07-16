-- Colunas multi-provider nas tabelas de billing (Stripe → Asaas) — 100% ADITIVA.
-- Fase 1 da migração (docs/billing-asaas/01-PLANO-IMPLEMENTACAO.md).
--
-- Nenhuma coluna stripe_* é removida ou renomeada. As colunas provider_* ficam
-- ao lado; linhas existentes são backfilladas com provider='stripe' e
-- provider_*_id = stripe_*_id. Código legado continua lendo stripe_*; código
-- novo (Fase 2+) lê provider + provider_*_id.
--
-- Única relaxação de constraint: billing_events.stripe_event_id perde NOT NULL
-- (eventos Asaas não têm id Stripe). O UNIQUE original permanece (NULLs
-- múltiplos são permitidos em UNIQUE).

begin;

-- =====================================================================
-- PART 1 — billing_plans: categoria de produto + provedor + tipo de cobrança
-- =====================================================================

alter table billing_plans
  add column if not exists category text not null default 'SYSTEM_SUBSCRIPTION',
  add column if not exists provider text not null default 'stripe',
  add column if not exists billing_type text not null default 'recurring',
  add column if not exists amount_credited_cents integer,
  add column if not exists recommended boolean not null default false,
  add column if not exists requires_plan_id uuid references billing_plans(id),
  add column if not exists provider_metadata jsonb not null default '{}'::jsonb;

-- CHECKs separados pra permitir add column if not exists sem conflito
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'billing_plans_category_check') then
    alter table billing_plans
      add constraint billing_plans_category_check
      check (category in ('SYSTEM_SUBSCRIPTION', 'WHATSAPP_IMPLEMENTATION', 'WHATSAPP_SUBSCRIPTION', 'AI_CREDIT_PACKAGE', 'TRIAL', 'CUSTOM'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'billing_plans_provider_check') then
    alter table billing_plans
      add constraint billing_plans_provider_check
      check (provider in ('stripe', 'asaas', 'manual', 'lifetime'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'billing_plans_billing_type_check') then
    alter table billing_plans
      add constraint billing_plans_billing_type_check
      check (billing_type in ('recurring', 'one_time'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'billing_plans_amount_credited_check') then
    alter table billing_plans
      add constraint billing_plans_amount_credited_check
      check (amount_credited_cents is null or amount_credited_cents >= 0);
  end if;
end $$;

create index if not exists billing_plans_category_idx on billing_plans (category);

comment on column billing_plans.category is
  'Categoria comercial do produto: SYSTEM_SUBSCRIPTION | WHATSAPP_IMPLEMENTATION | WHATSAPP_SUBSCRIPTION | AI_CREDIT_PACKAGE | TRIAL | CUSTOM.';
comment on column billing_plans.provider is
  'Provedor de pagamento que cobra este plano. Linhas pré-Asaas = stripe. Planos novos (Fase 3+) = asaas.';
comment on column billing_plans.billing_type is
  'recurring = assinatura; one_time = cobrança única (implementação WhatsApp, recarga de IA).';
comment on column billing_plans.amount_credited_cents is
  'Só AI_CREDIT_PACKAGE: valor creditado na carteira. Por decisão comercial, igual a amount_cents (sem margem sobre IA).';
comment on column billing_plans.recommended is
  'Destaque "Recomendado para começar" (pacote IA R$70).';
comment on column billing_plans.requires_plan_id is
  'Pré-requisito comercial: ex. instancia-whatsapp exige implementacao-whatsapp paga/concluída. Validado server-side no checkout.';

-- =====================================================================
-- PART 2 — billing_customers: id do cliente no Asaas (coexiste com Stripe)
-- =====================================================================

alter table billing_customers
  add column if not exists asaas_customer_id text;

create unique index if not exists billing_customers_asaas_customer_idx
  on billing_customers (asaas_customer_id)
  where asaas_customer_id is not null;

comment on column billing_customers.asaas_customer_id is
  'ID do customer no Asaas (cus_...). Coexiste com stripe_customer_id — um registro por org pode ter os dois durante a transição.';

-- =====================================================================
-- PART 3 — billing_subscriptions: provider + id genérico
-- =====================================================================

alter table billing_subscriptions
  add column if not exists provider text not null default 'stripe',
  add column if not exists provider_subscription_id text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'billing_subscriptions_provider_check') then
    alter table billing_subscriptions
      add constraint billing_subscriptions_provider_check
      check (provider in ('stripe', 'asaas', 'manual', 'lifetime'));
  end if;
end $$;

update billing_subscriptions
   set provider_subscription_id = stripe_subscription_id
 where provider_subscription_id is null
   and stripe_subscription_id is not null;

create unique index if not exists billing_subscriptions_provider_sub_idx
  on billing_subscriptions (provider, provider_subscription_id)
  where provider_subscription_id is not null;

comment on column billing_subscriptions.provider_subscription_id is
  'ID da assinatura no provedor (Stripe sub_... | Asaas sub_...). Backfill = stripe_subscription_id. Código novo lê daqui.';

-- =====================================================================
-- PART 4 — billing_invoices: provider + payment id + finalidade + rastreio
-- =====================================================================

alter table billing_invoices
  add column if not exists provider text not null default 'stripe',
  add column if not exists provider_payment_id text,
  add column if not exists purpose text not null default 'subscription',
  add column if not exists external_reference text,
  add column if not exists payload jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'billing_invoices_provider_check') then
    alter table billing_invoices
      add constraint billing_invoices_provider_check
      check (provider in ('stripe', 'asaas', 'manual'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'billing_invoices_purpose_check') then
    alter table billing_invoices
      add constraint billing_invoices_purpose_check
      check (purpose in ('subscription', 'implementation', 'ai_topup', 'other'));
  end if;
end $$;

update billing_invoices
   set provider_payment_id = stripe_invoice_id
 where provider_payment_id is null
   and stripe_invoice_id is not null;

create unique index if not exists billing_invoices_provider_payment_idx
  on billing_invoices (provider, provider_payment_id)
  where provider_payment_id is not null;

create index if not exists billing_invoices_external_ref_idx
  on billing_invoices (external_reference)
  where external_reference is not null;

comment on column billing_invoices.provider_payment_id is
  'ID da cobrança no provedor (Stripe in_... | Asaas pay_...). Backfill = stripe_invoice_id.';
comment on column billing_invoices.purpose is
  'Finalidade da cobrança: subscription (mensalidade) | implementation (R$750 WhatsApp) | ai_topup (recarga carteira) | other.';
comment on column billing_invoices.external_reference is
  'externalReference enviado ao provedor (correlação org|plan|purpose). Validado no webhook antes de processar.';
comment on column billing_invoices.payload is
  'Snapshot SANITIZADO do objeto do provedor (sem dados de cartão). Preenchido pelo webhook Asaas (Fase 2+).';

-- =====================================================================
-- PART 5 — billing_events: idempotência multi-provider + fila de processamento
-- =====================================================================

-- Eventos Asaas não têm stripe_event_id → relaxa NOT NULL (UNIQUE original fica).
alter table billing_events
  alter column stripe_event_id drop not null;

alter table billing_events
  add column if not exists provider text not null default 'stripe',
  add column if not exists provider_event_id text,
  add column if not exists processing_status text not null default 'processed',
  add column if not exists error_message text,
  add column if not exists retry_count integer not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'billing_events_provider_check') then
    alter table billing_events
      add constraint billing_events_provider_check
      check (provider in ('stripe', 'asaas'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'billing_events_processing_status_check') then
    alter table billing_events
      add constraint billing_events_processing_status_check
      check (processing_status in ('received', 'processed', 'failed', 'ignored'));
  end if;
end $$;

update billing_events
   set provider_event_id = stripe_event_id
 where provider_event_id is null
   and stripe_event_id is not null;

-- Idempotência multi-provider: 1 evento por (provider, provider_event_id).
create unique index if not exists billing_events_provider_event_idx
  on billing_events (provider, provider_event_id)
  where provider_event_id is not null;

-- Fila da Fase 2: reconcile busca failed/received antigos pra reprocessar.
create index if not exists billing_events_processing_status_idx
  on billing_events (processing_status)
  where processing_status in ('received', 'failed');

comment on column billing_events.provider_event_id is
  'ID do evento no provedor (Stripe evt_... | Asaas evt_...). Idempotência via UNIQUE (provider, provider_event_id). Backfill = stripe_event_id.';
comment on column billing_events.processing_status is
  'received = persistido antes de processar (webhook Asaas responde 2xx rápido) | processed | failed (reconcile reprocessa) | ignored (evento desconhecido — nunca 500).';

commit;
