-- Integração Stripe para pagamento de caução em reservas.
--
-- Componentes:
--   1. stripe_accounts        — conta Stripe Connect por unit (FORCE RLS, sem policies)
--   2. stripe_webhook_events  — idempotência de eventos Stripe (FORCE RLS, sem policies)
--   3. Colunas de pagamento em reservations (payment_status, amount, session, intent, expires)
--
-- Padrão idêntico a whatsapp_channels / ai_provider_credentials:
-- FORCE RLS sem policies → acesso exclusivo via Edge Function com service_role.

begin;

-- ─── 1. stripe_accounts ─────────────────────────────────────────────────────

create table if not exists stripe_accounts (
  id                    uuid primary key default gen_random_uuid(),
  unit_id               uuid not null references units(id) on delete cascade,
  stripe_account_id     text not null,
  charges_enabled       boolean not null default false,
  payouts_enabled       boolean not null default false,
  onboarding_complete   boolean not null default false,
  display_name          text,
  livemode              boolean not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (unit_id)
);

create index if not exists stripe_accounts_unit_idx on stripe_accounts(unit_id);

alter table stripe_accounts enable row level security;
alter table stripe_accounts force row level security;

-- ─── 2. stripe_webhook_events ────────────────────────────────────────────────

create table if not exists stripe_webhook_events (
  id              uuid primary key default gen_random_uuid(),
  stripe_event_id text not null unique,
  event_type      text not null,
  reservation_id  uuid references reservations(id) on delete set null,
  processed_at    timestamptz not null default now()
);

create index if not exists stripe_events_reservation_idx
  on stripe_webhook_events(reservation_id);
create index if not exists stripe_events_type_idx
  on stripe_webhook_events(event_type);

alter table stripe_webhook_events enable row level security;
alter table stripe_webhook_events force row level security;

-- ─── 3. Colunas de pagamento em reservations ─────────────────────────────────

alter table reservations
  add column if not exists payment_status text
    default null
    check (payment_status is null or payment_status in (
      'not_required', 'pending_payment', 'paid', 'failed', 'refunded', 'expired'
    )),
  add column if not exists payment_amount_cents int
    check (payment_amount_cents is null or payment_amount_cents >= 0),
  add column if not exists stripe_checkout_session_id text,
  add column if not exists stripe_payment_intent_id text,
  add column if not exists payment_expires_at timestamptz;

create index if not exists reservations_payment_expires_idx
  on reservations(payment_expires_at)
  where payment_status = 'pending_payment';

create index if not exists reservations_payment_status_idx
  on reservations(payment_status)
  where payment_status is not null;

commit;
