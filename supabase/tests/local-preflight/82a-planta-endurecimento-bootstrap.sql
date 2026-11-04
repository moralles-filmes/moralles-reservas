-- 82a: complemento do 81a para o pré-voo 82 (endurecimento da planta).
--
-- Roda como `postgres` DEPOIS do 81a e das migrations 20261030120000/120100,
-- no mesmo contêiner (README §82). Acrescenta `hall_schedules` no estado de
-- produção, conferido por MCP só leitura em 2026-11-04: colunas, FK com
-- cascata para halls, RLS sem FORCE, as duas policies (texto de `pg_policies`)
-- e ACL de tabela (tudo para anon, authenticated e service_role).
-- Fixtures: H1 em S1, H2 em S2 e HB em SB (UUIDs a0d81000-…-4x1).
-- Não reaplicar: cria tudo uma vez (o 82 roda em transação desfeita).
\set ON_ERROR_STOP on
begin;

create table public.hall_schedules (
  id uuid primary key default gen_random_uuid(),
  hall_id uuid not null references public.halls(id) on delete cascade,
  day_of_week integer not null check (day_of_week between 0 and 6),
  open_time time not null,
  close_time time not null,
  slot_minutes integer not null default 30 check (slot_minutes in (5, 10, 15, 20, 30, 45, 60)),
  min_advance_minutes integer not null default 0 check (min_advance_minutes >= 0),
  discount_percent integer not null default 0 check (discount_percent between 0 and 100),
  charge_enabled boolean not null default false,
  charge_amount_cents integer check (charge_amount_cents is null or charge_amount_cents >= 0),
  created_at timestamptz not null default now(),
  check (close_time > open_time),
  check (charge_enabled = false or charge_amount_cents is not null));
create index hall_schedules_hall_dow_idx on public.hall_schedules (hall_id, day_of_week);

alter table public.hall_schedules enable row level security;
create policy platform_admin_all_hall_schedules on public.hall_schedules for all to authenticated
  using (app_private.is_platform_admin(auth.uid())) with check (app_private.is_platform_admin(auth.uid()));
create policy unit_member_all_hall_schedules on public.hall_schedules for all to authenticated
  using (exists (select 1 from public.halls h
                  where h.id = hall_schedules.hall_id and app_private.is_unit_member(auth.uid(), h.unit_id)))
  with check (exists (select 1 from public.halls h
                       where h.id = hall_schedules.hall_id and app_private.is_unit_member(auth.uid(), h.unit_id)));
grant all on table public.hall_schedules to anon, authenticated, service_role;

-- Projeção mínima: só o vínculo com o salão, que o guard de halls.unit_id lê.
create table public.table_blocks (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references public.units(id) on delete cascade,
  hall_id uuid references public.halls(id) on delete cascade);
create table public.special_dates (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references public.units(id) on delete cascade,
  hall_id uuid references public.halls(id) on delete cascade);

insert into public.hall_schedules (id, hall_id, day_of_week, open_time, close_time) values
  ('a0d81000-0000-4000-8000-000000000401', 'a0d81000-0000-4000-8000-000000000001', 5, '18:00', '23:00'),
  ('a0d81000-0000-4000-8000-000000000402', 'a0d81000-0000-4000-8000-000000000002', 5, '18:00', '23:00'),
  ('a0d81000-0000-4000-8000-0000000004b1', 'a0d81000-0000-4000-8000-000000000003', 5, '18:00', '23:00');

commit;
