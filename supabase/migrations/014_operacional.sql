-- Migration 014: Painel Operacional — walk_ins + waitlist
-- Dependência: 013_multi_tenant.sql (tabela units já existe)

begin;

-- ─── walk_ins ──────────────────────────────────────────────────────────────────
-- Registro de clientes que chegaram sem reserva (passantes / walk-in).

create table if not exists walk_ins (
  id            uuid primary key default gen_random_uuid(),
  unit_id       uuid not null references units(id) on delete cascade,
  customer_name text not null,
  customer_phone text,
  party_size    int  not null check (party_size >= 1),
  table_id      uuid references tables(id) on delete set null,
  status        text not null default 'waiting'
                  check (status in ('waiting', 'seated', 'left', 'no_show')),
  notes         text,
  arrived_at    timestamptz not null default now(),
  seated_at     timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ─── waitlist ─────────────────────────────────────────────────────────────────
-- Fila de espera para clientes que querem reservar mas não há mesa disponível.

create table if not exists waitlist (
  id                  uuid primary key default gen_random_uuid(),
  unit_id             uuid not null references units(id) on delete cascade,
  customer_id         uuid references customers(id) on delete set null,
  customer_name       text not null,
  customer_phone      text,
  party_size          int  not null check (party_size >= 1),
  requested_for_time  time,
  priority            int  not null default 0,
  status              text not null default 'waiting'
                        check (status in ('waiting', 'notified', 'seated', 'cancelled')),
  notes               text,
  notified_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- ─── Triggers updated_at ──────────────────────────────────────────────────────

create trigger walk_ins_updated_at
  before update on walk_ins
  for each row execute function update_updated_at();

create trigger waitlist_updated_at
  before update on waitlist
  for each row execute function update_updated_at();

-- ─── Índices ───────────────────────────────────────────────────────────────────

create index if not exists walk_ins_unit_status_idx
  on walk_ins (unit_id, status, arrived_at desc);

create index if not exists waitlist_unit_status_priority_idx
  on waitlist (unit_id, status, priority asc, created_at asc);

-- ─── RLS ──────────────────────────────────────────────────────────────────────

alter table walk_ins  enable row level security;
alter table waitlist  enable row level security;

-- walk_ins — leitura e escrita para membros da unidade
create policy "walk_ins_member_select" on walk_ins
  for select using (is_unit_member(auth.uid(), unit_id));

create policy "walk_ins_member_insert" on walk_ins
  for insert with check (is_unit_member(auth.uid(), unit_id));

create policy "walk_ins_member_update" on walk_ins
  for update using (is_unit_member(auth.uid(), unit_id));

create policy "walk_ins_member_delete" on walk_ins
  for delete using (is_unit_member(auth.uid(), unit_id));

-- waitlist — leitura e escrita para membros da unidade
create policy "waitlist_member_select" on waitlist
  for select using (is_unit_member(auth.uid(), unit_id));

create policy "waitlist_member_insert" on waitlist
  for insert with check (is_unit_member(auth.uid(), unit_id));

create policy "waitlist_member_update" on waitlist
  for update using (is_unit_member(auth.uid(), unit_id));

create policy "waitlist_member_delete" on waitlist
  for delete using (is_unit_member(auth.uid(), unit_id));

commit;
