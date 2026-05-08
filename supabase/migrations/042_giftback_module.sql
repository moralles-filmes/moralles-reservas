-- Módulo de Giftback (sprint 1 — núcleo).
-- Cria tabelas voucher_rules + vouchers, adiciona customers.birthday (sprint 2)
-- e estende notifications_sent.kind com 'voucher_issued'.

-- ─── voucher_rules ───────────────────────────────────────────────────────────
-- Configurações de regras de emissão. Uma unit pode ter múltiplas rules ativas
-- ao mesmo tempo (ex: uma para after_rating + uma para birthday).

create table voucher_rules (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references units(id) on delete cascade,
  name text not null,
  trigger_type text not null check (trigger_type in ('after_rating', 'manual', 'birthday', 'frequency')),
  discount_percent int not null check (discount_percent > 0 and discount_percent <= 100),
  validity_days int not null default 30 check (validity_days > 0),
  -- Configs específicas por trigger:
  min_rating int check (min_rating between 1 and 5),
  visits_required int check (visits_required > 0),
  days_window int check (days_window > 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index voucher_rules_unit_active_idx on voucher_rules (unit_id, active);

alter table voucher_rules enable row level security;

create policy "voucher_rules_member_select" on voucher_rules
  for select using (is_unit_member(auth.uid(), unit_id));

create policy "voucher_rules_member_insert" on voucher_rules
  for insert with check (is_unit_member(auth.uid(), unit_id));

create policy "voucher_rules_member_update" on voucher_rules
  for update using (is_unit_member(auth.uid(), unit_id))
  with check (is_unit_member(auth.uid(), unit_id));

create policy "voucher_rules_member_delete" on voucher_rules
  for delete using (is_unit_member(auth.uid(), unit_id));

-- ─── vouchers ────────────────────────────────────────────────────────────────
-- Instâncias emitidas. Code unique enquanto active (após uso/expiração pode
-- haver colisão teórica; check da unit_id na tela de validação resolve).

create table vouchers (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references units(id) on delete cascade,
  rule_id uuid references voucher_rules(id) on delete set null,
  customer_id uuid not null references customers(id) on delete cascade,
  code text not null,
  discount_percent int not null check (discount_percent > 0 and discount_percent <= 100),
  status text not null default 'active' check (status in ('active', 'used', 'expired', 'cancelled')),
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by_user_id uuid references auth.users(id) on delete set null,
  reservation_id uuid references reservations(id) on delete set null,
  notes text,
  created_at timestamptz not null default now()
);

create unique index vouchers_code_active_idx on vouchers (code) where status = 'active';
create index vouchers_unit_status_idx on vouchers (unit_id, status);
create index vouchers_customer_idx on vouchers (customer_id);
create index vouchers_expires_idx on vouchers (expires_at) where status = 'active';

alter table vouchers enable row level security;

create policy "vouchers_member_select" on vouchers
  for select using (is_unit_member(auth.uid(), unit_id));

create policy "vouchers_member_insert" on vouchers
  for insert with check (is_unit_member(auth.uid(), unit_id));

create policy "vouchers_member_update" on vouchers
  for update using (is_unit_member(auth.uid(), unit_id))
  with check (is_unit_member(auth.uid(), unit_id));

create policy "vouchers_member_delete" on vouchers
  for delete using (is_unit_member(auth.uid(), unit_id));

-- ─── customers.birthday ──────────────────────────────────────────────────────

alter table customers
  add column if not exists birthday date null;

-- ─── notifications_sent.kind: voucher_issued ────────────────────────────────

alter table notifications_sent drop constraint if exists notifications_sent_kind_check;

alter table notifications_sent
  add constraint notifications_sent_kind_check
  check (kind in (
    'confirmation',
    'confirmation_email',
    'reminder_d1',
    'survey_d1',
    'cancellation',
    'waitlist_entered',
    'waitlist_table_ready',
    'waitlist_feedback',
    'voucher_issued'
  ));

-- ─── helper: expira vouchers vencidos ────────────────────────────────────────

create or replace function expire_vouchers() returns int
language plpgsql
security definer
as $$
declare
  expired_count int;
begin
  update vouchers
    set status = 'expired'
  where status = 'active'
    and expires_at < now();
  get diagnostics expired_count = row_count;
  return expired_count;
end;
$$;

revoke all on function expire_vouchers() from public, anon, authenticated;
grant execute on function expire_vouchers() to service_role;
