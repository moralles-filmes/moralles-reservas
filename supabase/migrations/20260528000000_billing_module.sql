-- billing_module.sql
-- Modulo de billing/mensalidades por organization.
-- Nao altera fluxo de caucao de reservas (stripe_accounts, stripe_webhook_events, reservations.payment_status).
-- Billing usa conta principal da plataforma; caucao usa Stripe Connect per-unit.

begin;

-- =====================================================================
-- PART 1 — Colunas de billing em organizations
-- =====================================================================

alter table organizations
  add column if not exists billing_status text not null default 'active',
  add column if not exists billing_email text,
  add column if not exists trial_ends_at timestamptz,
  add column if not exists blocked_at timestamptz,
  add column if not exists blocked_reason text;

-- CHECK separado permite add column if not exists sem conflito de constraint
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'organizations_billing_status_check'
  ) then
    alter table organizations
      add constraint organizations_billing_status_check
      check (billing_status in (
        'active', 'trialing', 'pending_payment', 'past_due',
        'grace_period', 'blocked', 'canceled', 'manual_override', 'suspended'
      ));
  end if;
end $$;

create index if not exists organizations_billing_status_idx
  on organizations (billing_status)
  where billing_status not in ('active');

-- =====================================================================
-- PART 2 — billing_customers (1:1 com organization)
-- FORCE RLS sem policies — acesso exclusivo via Edge Function (service_role)
-- =====================================================================

create table if not exists billing_customers (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references organizations(id) on delete cascade,
  stripe_customer_id text,
  name              text,
  email             text,
  tax_id            text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (organization_id)
);

alter table billing_customers enable row level security;
alter table billing_customers force row level security;

comment on table billing_customers is
  'Mapeamento 1:1 entre organization e Stripe Customer. FORCE RLS — acesso via Edge Function (service_role). Billing usa conta principal da plataforma, nao Connected Account.';

create unique index if not exists billing_customers_stripe_customer_idx
  on billing_customers (stripe_customer_id)
  where stripe_customer_id is not null;

create index if not exists billing_customers_org_idx
  on billing_customers (organization_id);

drop trigger if exists billing_customers_updated_at on billing_customers;
create trigger billing_customers_updated_at
  before update on billing_customers
  for each row execute function public.update_updated_at();

-- =====================================================================
-- PART 3 — billing_plans
-- RLS: authenticated le planos ativos, platform_admin CRUD
-- =====================================================================

create table if not exists billing_plans (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null,
  slug                  text not null unique,
  stripe_price_id_card  text,
  stripe_price_id_boleto text,
  stripe_price_id_pix   text,
  amount_cents          integer not null check (amount_cents >= 0),
  currency              text not null default 'brl',
  "interval"            text not null default 'month'
                          check ("interval" in ('month', 'year')),
  max_units             integer,
  max_members_per_unit  integer,
  features              jsonb not null default '{}'::jsonb,
  active                boolean not null default true,
  sort_order            integer not null default 0,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

alter table billing_plans enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where policyname = 'authenticated_read_active_plans' and tablename = 'billing_plans'
  ) then
    create policy "authenticated_read_active_plans" on billing_plans
      for select to authenticated
      using (active = true);
  end if;

  if not exists (
    select 1 from pg_policies
    where policyname = 'platform_admin_all_billing_plans' and tablename = 'billing_plans'
  ) then
    create policy "platform_admin_all_billing_plans" on billing_plans
      for all to authenticated
      using (is_platform_admin(auth.uid()))
      with check (is_platform_admin(auth.uid()));
  end if;
end $$;

drop trigger if exists billing_plans_updated_at on billing_plans;
create trigger billing_plans_updated_at
  before update on billing_plans
  for each row execute function public.update_updated_at();

-- =====================================================================
-- PART 4 — billing_subscriptions
-- FORCE RLS sem policies
-- =====================================================================

create table if not exists billing_subscriptions (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references organizations(id) on delete cascade,
  billing_customer_id     uuid not null references billing_customers(id) on delete cascade,
  billing_plan_id         uuid not null references billing_plans(id),
  stripe_subscription_id  text,
  status                  text not null default 'trialing'
                            check (status in (
                              'active', 'trialing', 'past_due', 'canceled', 'unpaid', 'paused'
                            )),
  payment_method          text not null default 'card'
                            check (payment_method in ('card', 'boleto', 'pix', 'manual')),
  current_period_start    timestamptz,
  current_period_end      timestamptz,
  trial_end               timestamptz,
  cancel_at_period_end    boolean not null default false,
  canceled_at             timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

alter table billing_subscriptions enable row level security;
alter table billing_subscriptions force row level security;

comment on table billing_subscriptions is
  'Assinatura recorrente por organization. FORCE RLS — acesso via Edge Function (service_role).';

create unique index if not exists billing_subscriptions_stripe_idx
  on billing_subscriptions (stripe_subscription_id)
  where stripe_subscription_id is not null;

create index if not exists billing_subscriptions_org_idx
  on billing_subscriptions (organization_id);

create index if not exists billing_subscriptions_customer_idx
  on billing_subscriptions (billing_customer_id);

create index if not exists billing_subscriptions_plan_idx
  on billing_subscriptions (billing_plan_id);

create index if not exists billing_subscriptions_status_idx
  on billing_subscriptions (status)
  where status not in ('canceled');

drop trigger if exists billing_subscriptions_updated_at on billing_subscriptions;
create trigger billing_subscriptions_updated_at
  before update on billing_subscriptions
  for each row execute function public.update_updated_at();

-- =====================================================================
-- PART 5 — billing_invoices
-- FORCE RLS sem policies
-- =====================================================================

create table if not exists billing_invoices (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references organizations(id) on delete cascade,
  billing_subscription_id uuid references billing_subscriptions(id) on delete set null,
  stripe_invoice_id       text,
  number                  text,
  status                  text not null default 'draft'
                            check (status in (
                              'draft', 'open', 'paid', 'void', 'uncollectible'
                            )),
  amount_cents            integer not null check (amount_cents >= 0),
  currency                text not null default 'brl',
  payment_method          text
                            check (payment_method is null or payment_method in (
                              'card', 'pix', 'boleto', 'manual'
                            )),
  hosted_invoice_url      text,
  invoice_pdf             text,
  due_date                date,
  paid_at                 timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

alter table billing_invoices enable row level security;
alter table billing_invoices force row level security;

comment on table billing_invoices is
  'Faturas de assinatura. FORCE RLS — acesso via Edge Function (service_role).';

create unique index if not exists billing_invoices_stripe_idx
  on billing_invoices (stripe_invoice_id)
  where stripe_invoice_id is not null;

create index if not exists billing_invoices_org_idx
  on billing_invoices (organization_id);

create index if not exists billing_invoices_subscription_idx
  on billing_invoices (billing_subscription_id);

create index if not exists billing_invoices_status_idx
  on billing_invoices (status)
  where status not in ('paid', 'void');

create index if not exists billing_invoices_due_date_idx
  on billing_invoices (due_date)
  where status = 'open';

drop trigger if exists billing_invoices_updated_at on billing_invoices;
create trigger billing_invoices_updated_at
  before update on billing_invoices
  for each row execute function public.update_updated_at();

-- =====================================================================
-- PART 6 — billing_events (idempotencia webhooks de billing)
-- Separada de stripe_webhook_events (reservas/caucao)
-- FORCE RLS sem policies
-- =====================================================================

create table if not exists billing_events (
  id              uuid primary key default gen_random_uuid(),
  stripe_event_id text not null unique,
  event_type      text not null,
  organization_id uuid references organizations(id) on delete set null,
  data            jsonb,
  processed_at    timestamptz not null default now()
);

alter table billing_events enable row level security;
alter table billing_events force row level security;

comment on table billing_events is
  'Idempotencia de eventos Stripe de billing (subscription.*, invoice.*). Separada de stripe_webhook_events (reservas). FORCE RLS.';

create index if not exists billing_events_org_idx
  on billing_events (organization_id);

create index if not exists billing_events_type_idx
  on billing_events (event_type);

-- =====================================================================
-- PART 7 — billing_access_overrides
-- RLS: platform_admin CRUD
-- =====================================================================

create table if not exists billing_access_overrides (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  override_type   text not null
                    check (override_type in ('grant_access', 'block_access', 'extend_trial')),
  reason          text not null,
  granted_by      uuid not null references auth.users(id),
  valid_until     timestamptz,
  active          boolean not null default true,
  created_at      timestamptz not null default now()
);

alter table billing_access_overrides enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where policyname = 'platform_admin_all_billing_overrides' and tablename = 'billing_access_overrides'
  ) then
    create policy "platform_admin_all_billing_overrides" on billing_access_overrides
      for all to authenticated
      using (is_platform_admin(auth.uid()))
      with check (is_platform_admin(auth.uid()));
  end if;
end $$;

create index if not exists billing_overrides_org_idx
  on billing_access_overrides (organization_id);

create index if not exists billing_overrides_active_idx
  on billing_access_overrides (organization_id, active)
  where active = true;

-- =====================================================================
-- PART 8 — billing_notifications
-- FORCE RLS sem policies
-- =====================================================================

create table if not exists billing_notifications (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  event_type      text not null,
  channel         text not null,
  recipient       text not null,
  status          text not null default 'sent',
  error           text,
  sent_at         timestamptz not null default now()
);

alter table billing_notifications enable row level security;
alter table billing_notifications force row level security;

comment on table billing_notifications is
  'Log de notificacoes de billing enviadas. FORCE RLS — acesso via Edge Function (service_role).';

create index if not exists billing_notifications_org_idx
  on billing_notifications (organization_id);

commit;
