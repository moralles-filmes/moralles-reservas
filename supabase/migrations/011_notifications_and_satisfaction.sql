-- Suporte a automações N8N (lembrete D-1, pesquisa de satisfação D+1):
-- 1. reservations.satisfaction_rating / satisfaction_at — captura da nota 1-5
-- 2. notifications_sent              — log/idempotência de mensagens outbound
-- 3. RPCs get_reservations_for_*     — consultas controladas para o N8N

-- ─── 1. Coluna de satisfação na própria reserva ──────────────────────────────

alter table reservations
  add column if not exists satisfaction_rating integer
    check (satisfaction_rating between 1 and 5),
  add column if not exists satisfaction_at timestamptz;

-- ─── 2. Log de notificações outbound ─────────────────────────────────────────
-- unique(reservation_id, kind) garante idempotência: tentar inserir 2x o mesmo
-- (reservation_id, 'reminder_d1') falha — RPCs filtram pela ausência do registro.

create table if not exists notifications_sent (
  id              uuid primary key default gen_random_uuid(),
  reservation_id  uuid not null references reservations(id) on delete cascade,
  kind            text not null check (kind in ('confirmation', 'reminder_d1', 'survey_d1')),
  status          text not null default 'sent' check (status in ('sent', 'failed', 'skipped')),
  sent_at         timestamptz not null default now(),
  error           text,
  unique (reservation_id, kind)
);

create index if not exists notifications_sent_kind_sent_at_idx
  on notifications_sent (kind, sent_at desc);

create index if not exists notifications_sent_reservation_idx
  on notifications_sent (reservation_id);

alter table notifications_sent enable row level security;

-- Admin lê tudo (sem policy de write — service_role bypassa RLS).
create policy "auth_read_notifications_sent" on notifications_sent
  for select to authenticated using (true);

-- ─── 3. RPCs para o N8N ──────────────────────────────────────────────────────
-- SECURITY DEFINER: encapsula filtros e schema, e permite revogar execute de
-- anon/authenticated para que só service_role (N8N) execute.

create or replace function public.get_reservations_for_reminder(p_target_date date)
returns table (
  reservation_id    uuid,
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
    c.phone,
    c.name,
    r.time,
    r.party_size,
    r.reservation_code
  from reservations r
  join customers c on c.id = r.customer_id
  where r.date = p_target_date
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

create or replace function public.get_reservations_for_survey(p_target_date date)
returns table (
  reservation_id  uuid,
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
    c.phone,
    c.name,
    r.reservation_code
  from reservations r
  join customers c on c.id = r.customer_id
  where r.date = p_target_date
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

revoke all on function public.get_reservations_for_reminder(date) from public;
revoke execute on function public.get_reservations_for_reminder(date) from anon, authenticated;
grant execute on function public.get_reservations_for_reminder(date) to service_role;

revoke all on function public.get_reservations_for_survey(date) from public;
revoke execute on function public.get_reservations_for_survey(date) from anon, authenticated;
grant execute on function public.get_reservations_for_survey(date) to service_role;
