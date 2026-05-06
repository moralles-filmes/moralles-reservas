-- Migration 023b: trava as policies anon abertas + FORCE RLS em
-- whatsapp_channels + NOT NULL em rate_limit_events.unit_id.
--
-- Aplicar APÓS 023a + Edge Functions atualizadas + frontend deployado em
-- prod. As mudanças aqui quebram callers que ainda lessem
-- tables/business_hours/settings/special_dates direto via REST como anon, ou
-- whatsapp_channels via REST como authenticated.

begin;

-- C1, C2: dropar policies anon abertas
drop policy if exists "anon_read_active_tables"   on tables;
drop policy if exists "anon_read_business_hours"  on business_hours;
drop policy if exists "anon_read_settings"        on settings;
drop policy if exists "anon_read_special_dates"   on special_dates;

-- C3: validar org pública em insert anon de customers
drop policy if exists "anon_insert_customers" on customers;
create policy "anon_insert_customers" on customers
  for insert to anon
  with check (
    organization_id is not null
    and exists (
      select 1 from organizations o
      where o.id = organization_id and o.is_public = true
    )
  );

-- C4: validar unit pública em insert anon de reservations
drop policy if exists "anon_insert_reservations" on reservations;
create policy "anon_insert_reservations" on reservations
  for insert to anon
  with check (
    unit_id is not null
    and exists (
      select 1 from units u
      join organizations o on o.id = u.organization_id
      where u.id = unit_id and u.is_public = true and o.is_public = true
    )
  );

drop policy if exists "anon_insert_waitlist" on waitlist;
create policy "anon_insert_waitlist" on waitlist
  for insert to anon
  with check (
    unit_id is not null
    and status = 'waiting'
    and party_size between 1 and 20
    and exists (
      select 1 from units u
      join organizations o on o.id = u.organization_id
      where u.id = unit_id and u.is_public = true and o.is_public = true
    )
  );

-- C5: FORCE RLS em whatsapp_channels — leitura passa por manage-channels.
drop policy if exists "unit_member_read_channels" on whatsapp_channels;
alter table whatsapp_channels force row level security;

-- M1: rate_limit_events sempre por unit
alter table rate_limit_events alter column unit_id set not null;

commit;
