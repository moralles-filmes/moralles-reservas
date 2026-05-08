-- Migration 044: Templates customizáveis pra lembrete D-1 e pesquisa D+1.
--
-- Substitui os textos hardcoded nos workflows N8N (docs/n8n/workflow-*.json)
-- por templates editáveis pelo cliente em /g/:slug/reservas/comunicacao.
-- Modelo: 036_waitlist_module.sql (waitlist_message_templates).
--
-- Também estende as RPCs `get_reservations_for_reminder` e
-- `get_reservations_for_survey` (mig 011) com filtro opcional `p_unit_id`
-- e expõe `unit_id` no retorno — necessário porque os workers internos
-- iteram unit a unit (carregando template e settings.*_enabled por unidade).
-- A assinatura nova é retrocompatível: `p_unit_id default null` retorna
-- todas as unidades (igual antes).

begin;

-- ─── 1. reservation_message_templates ─────────────────────────────────────────

create table if not exists reservation_message_templates (
  id          uuid primary key default gen_random_uuid(),
  unit_id     uuid not null references units(id) on delete cascade,
  event       text not null check (event in ('reminder_d1','survey_d1')),
  customized  boolean not null default false,
  body        text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (unit_id, event)
);

drop trigger if exists reservation_message_templates_updated_at on reservation_message_templates;
create trigger reservation_message_templates_updated_at
  before update on reservation_message_templates
  for each row execute function update_updated_at();

alter table reservation_message_templates enable row level security;

-- Membros da unit gerenciam (CRUD). service_role bypassa RLS pra leitura
-- pelos workers (process-reservation-reminders / process-satisfaction-surveys).
drop policy if exists "rmt_member_select" on reservation_message_templates;
create policy "rmt_member_select" on reservation_message_templates
  for select using (is_unit_member(auth.uid(), unit_id));

drop policy if exists "rmt_member_insert" on reservation_message_templates;
create policy "rmt_member_insert" on reservation_message_templates
  for insert with check (is_unit_member(auth.uid(), unit_id));

drop policy if exists "rmt_member_update" on reservation_message_templates;
create policy "rmt_member_update" on reservation_message_templates
  for update using (is_unit_member(auth.uid(), unit_id));

drop policy if exists "rmt_member_delete" on reservation_message_templates;
create policy "rmt_member_delete" on reservation_message_templates
  for delete using (is_unit_member(auth.uid(), unit_id));

-- ─── 2. Estende RPC get_reservations_for_reminder ────────────────────────────

drop function if exists public.get_reservations_for_reminder(date);
drop function if exists public.get_reservations_for_reminder(date, uuid);

create or replace function public.get_reservations_for_reminder(
  p_target_date date,
  p_unit_id     uuid default null
)
returns table (
  reservation_id    uuid,
  unit_id           uuid,
  customer_phone    text,
  customer_name     text,
  reservation_time  time,
  party_size        integer,
  code              text
)
language sql
security definer
set search_path = public
stable
as $$
  select
    r.id,
    r.unit_id,
    c.phone,
    c.name,
    r.time,
    r.party_size,
    r.reservation_code
  from reservations r
  join customers c on c.id = r.customer_id
  where r.date = p_target_date
    and (p_unit_id is null or r.unit_id = p_unit_id)
    and r.status = 'confirmed'
    and c.do_not_contact = false
    and not exists (
      select 1
        from notifications_sent n
       where n.reservation_id = r.id
         and n.kind = 'reminder_d1'
         and n.status = 'sent'
    );
$$;

revoke all on function public.get_reservations_for_reminder(date, uuid) from public;
revoke execute on function public.get_reservations_for_reminder(date, uuid) from anon, authenticated;
grant execute on function public.get_reservations_for_reminder(date, uuid) to service_role;

-- ─── 3. Estende RPC get_reservations_for_survey ──────────────────────────────

drop function if exists public.get_reservations_for_survey(date);
drop function if exists public.get_reservations_for_survey(date, uuid);

create or replace function public.get_reservations_for_survey(
  p_target_date date,
  p_unit_id     uuid default null
)
returns table (
  reservation_id  uuid,
  unit_id         uuid,
  customer_phone  text,
  customer_name   text,
  code            text
)
language sql
security definer
set search_path = public
stable
as $$
  select
    r.id,
    r.unit_id,
    c.phone,
    c.name,
    r.reservation_code
  from reservations r
  join customers c on c.id = r.customer_id
  where r.date = p_target_date
    and (p_unit_id is null or r.unit_id = p_unit_id)
    and r.status = 'confirmed'
    and c.do_not_contact = false
    and r.satisfaction_rating is null
    and not exists (
      select 1
        from notifications_sent n
       where n.reservation_id = r.id
         and n.kind = 'survey_d1'
         and n.status = 'sent'
    );
$$;

revoke all on function public.get_reservations_for_survey(date, uuid) from public;
revoke execute on function public.get_reservations_for_survey(date, uuid) from anon, authenticated;
grant execute on function public.get_reservations_for_survey(date, uuid) to service_role;

commit;
