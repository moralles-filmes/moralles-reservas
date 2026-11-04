-- Escolha de mesa, passo 2: ocupação de várias mesas, histórico e ações da
-- recepção. Spec: docs/superpowers/specs/2026-11-04-escolha-de-mesa-design.md
-- §1; plano: docs/superpowers/plans/2026-11-04-escolha-de-mesa.md, Task 2.
--
-- Aditiva (expand). `reservations.table_id`, `walk_ins.table_id` e
-- `waitlist.table_id` continuam sendo a mesa principal e o que os caminhos
-- legados escrevem; `occupant_tables` guarda uma linha por mesa física de cada
-- ocupante e é mantida por trigger a partir do `table_id`:
--   * `sync_occupant_tables`: `table_id` nulo apaga as linhas do ocupante;
--     `table_id` fora das linhas troca tudo pela principal; já nas linhas, nada
--     (é o que a junção da recepção deixa);
--   * `refresh_occupant_slot`: data, hora, status ou liberação da reserva
--     recalculam a janela; mudar data ou hora desfaz o `overlap_ok`.
-- Garantia contra sobreposição: exclusão `gist` (mesa =, janela &&) sobre as
-- linhas `blocks_slot` (reserva pending/confirmed, não liberada, sem
-- `overlap_ok`). Janela = [data+hora BRT, + reservation_duration_minutes da
-- unidade lida na escrita). Cobre combinação e junção, que viram várias linhas.
-- O índice `reservations_unique_active_table_slot` fica (o 23505 dele vem antes
-- e o retry do reserveSlot continua valendo). Passante e fila sentados têm
-- linha sem janela: a ocupação deles é julgada por `seated_at` nas leituras.
-- `overlap_ok` só é gravado pela `set_occupant_tables` com `p_allow_overlap`.
--
-- Mudança de comportamento nos caminhos legados (rara, e é a regra da spec):
-- reserva com mesa que sobrepõe outra na mesma mesa por duração (não só no
-- mesmo horário) passa a falhar com 23P01 em vez de gravar. reserveSlot e o
-- agente já recusam isso antes do INSERT; o UPDATE com `override` da
-- update-reservation passa a receber 23P01 (tratado na E2).
--
-- Rollback (migration nova, nunca edição desta): drop das RPCs
-- set_occupant_tables, set_occupant_party_size e
-- insert_reservation_with_tables; drop dos triggers *_occupant_*,
-- reservations_table_unit_guard e reservations_anon_table_guard e das funções
-- app_private desta migration;
-- drop de occupancy_events e occupant_tables. As colunas table_choice e
-- original_party_size podem ficar (inertes).
-- Pré-voo: supabase/tests/local-preflight/83-escolha-de-mesa.sql (README §83).
begin;
set local lock_timeout = '5s';

-- Mesmo cuidado da 099: no-op se já instalada (em qualquer schema); o opclass
-- de uuid para gist é resolvido por tipo, sem search_path.
create extension if not exists btree_gist with schema extensions;

-- ─── Colunas novas ───────────────────────────────────────────────────────────
alter table public.reservations
  add column if not exists table_choice text,
  add column if not exists original_party_size integer;
alter table public.reservations drop constraint if exists reservations_table_choice_check;
alter table public.reservations add constraint reservations_table_choice_check
  check (table_choice is null or table_choice in ('customer', 'system', 'staff'));
alter table public.reservations drop constraint if exists reservations_original_party_size_check;
alter table public.reservations add constraint reservations_original_party_size_check
  check (original_party_size is null or original_party_size >= 1);
comment on column public.reservations.table_choice is
  'Como a reserva ganhou a mesa: customer (página ou WhatsApp), system (escolha automática), staff (a recepção trocou ou juntou). Nulo nas reservas anteriores à escolha de mesa.';
comment on column public.reservations.original_party_size is
  'Pessoas da reserva antes do primeiro ajuste na recepção. Histórico; não entra nos totais (relatórios contam party_size).';

alter table public.walk_ins add column if not exists original_party_size integer;
alter table public.walk_ins drop constraint if exists walk_ins_original_party_size_check;
alter table public.walk_ins add constraint walk_ins_original_party_size_check
  check (original_party_size is null or original_party_size >= 1);
alter table public.waitlist add column if not exists original_party_size integer;
alter table public.waitlist drop constraint if exists waitlist_original_party_size_check;
alter table public.waitlist add constraint waitlist_original_party_size_check
  check (original_party_size is null or original_party_size >= 1);

-- ─── Duração e janela ────────────────────────────────────────────────────────
-- Mesma leitura de loadDurationMinutes (_shared/availability.ts): número,
-- texto numérico ou {"minutes": n}; fora de 1..1440 ou ausente = 90.
create or replace function app_private.reservation_duration_minutes(p_unit_id uuid)
returns integer language plpgsql stable set search_path = '' as $$
declare
  v_raw jsonb;
  v_num numeric;
begin
  select s.value into v_raw from public.settings s
   where s.unit_id = p_unit_id and s.key = 'reservation_duration_minutes';
  if v_raw is not null then
    if pg_catalog.jsonb_typeof(v_raw) = 'number' then
      v_num := (v_raw #>> '{}')::numeric;
    elsif pg_catalog.jsonb_typeof(v_raw) = 'string' and (v_raw #>> '{}') ~ '^\s*[0-9]{1,6}' then
      v_num := pg_catalog.substring(v_raw #>> '{}', '^\s*([0-9]{1,6})')::numeric;
    elsif pg_catalog.jsonb_typeof(v_raw) = 'object' and pg_catalog.jsonb_typeof(v_raw -> 'minutes') = 'number' then
      v_num := (v_raw ->> 'minutes')::numeric;
    end if;
  end if;
  if v_num is not null and pg_catalog.floor(v_num) between 1 and 1440 then
    return pg_catalog.floor(v_num)::integer;
  end if;
  return 90;
end
$$;
comment on function app_private.reservation_duration_minutes(uuid) is
  'Duração da reserva da unidade (settings.reservation_duration_minutes, leitura igual à de availability.ts); fora de 1..1440 ou ausente = 90.';
revoke all on function app_private.reservation_duration_minutes(uuid) from public, anon, authenticated, service_role;

create or replace function app_private.reservation_slot(p_unit_id uuid, p_date date, p_time time)
returns tstzrange language sql stable set search_path = '' as $$
  select pg_catalog.tstzrange(
    (p_date + p_time) at time zone 'America/Sao_Paulo',
    (p_date + p_time) at time zone 'America/Sao_Paulo'
      + pg_catalog.make_interval(mins => app_private.reservation_duration_minutes(p_unit_id)),
    '[)')
$$;
comment on function app_private.reservation_slot(uuid, date, time) is
  'Janela da reserva: [data+hora em America/Sao_Paulo, + duração da unidade).';
revoke all on function app_private.reservation_slot(uuid, date, time) from public, anon, authenticated, service_role;

-- ─── occupant_tables ─────────────────────────────────────────────────────────
create table if not exists public.occupant_tables (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references public.units(id) on delete cascade,
  table_id uuid not null references public.tables(id) on delete cascade,
  reservation_id uuid references public.reservations(id) on delete cascade,
  walk_in_id uuid references public.walk_ins(id) on delete cascade,
  waitlist_id uuid references public.waitlist(id) on delete cascade,
  slot tstzrange,
  blocks_slot boolean not null default false,
  overlap_ok boolean not null default false,
  created_at timestamptz not null default now(),
  constraint occupant_tables_one_occupant check (pg_catalog.num_nonnulls(reservation_id, walk_in_id, waitlist_id) = 1),
  constraint occupant_tables_blocks_need_slot check (not blocks_slot or slot is not null),
  constraint occupant_tables_reservation_table_key unique (reservation_id, table_id),
  constraint occupant_tables_walk_in_table_key unique (walk_in_id, table_id),
  constraint occupant_tables_waitlist_table_key unique (waitlist_id, table_id)
);
create index if not exists occupant_tables_unit_table_idx on public.occupant_tables (unit_id, table_id);
create index if not exists occupant_tables_table_idx on public.occupant_tables (table_id);
comment on table public.occupant_tables is
  'Uma linha por mesa física de cada reserva, passante ou entrada da fila (a principal é o table_id do ocupante). Mantida por trigger a partir do table_id e pelas RPCs da recepção; sem escrita direta. blocks_slot entra na exclusão occupant_tables_no_overlap.';

do $$ begin
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conname = 'occupant_tables_no_overlap'
                    and conrelid = 'public.occupant_tables'::pg_catalog.regclass) then
    alter table public.occupant_tables add constraint occupant_tables_no_overlap
      exclude using gist (table_id with =, slot with &&) where (blocks_slot);
  end if;
end $$;

alter table public.occupant_tables enable row level security;
alter table public.occupant_tables force row level security;
drop policy if exists unit_member_select_occupant_tables on public.occupant_tables;
create policy unit_member_select_occupant_tables on public.occupant_tables
  for select to authenticated using (app_private.is_unit_member(auth.uid(), unit_id));
drop policy if exists platform_admin_select_occupant_tables on public.occupant_tables;
create policy platform_admin_select_occupant_tables on public.occupant_tables
  for select to authenticated using (app_private.is_platform_admin(auth.uid()));
revoke all on table public.occupant_tables from public, anon, authenticated, service_role;
grant select on table public.occupant_tables to authenticated, service_role;

-- ─── Mesma unidade em toda mesa ligada a um ocupante ─────────────────────────
create or replace function app_private.guard_occupant_table_unit()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.tables t where t.id = new.table_id and t.unit_id = new.unit_id;
  if not found then
    raise exception 'table_unit_mismatch' using errcode = '42501';
  end if;
  if new.reservation_id is not null then
    perform 1 from public.reservations r where r.id = new.reservation_id and r.unit_id = new.unit_id;
  elsif new.walk_in_id is not null then
    perform 1 from public.walk_ins w where w.id = new.walk_in_id and w.unit_id = new.unit_id;
  else
    perform 1 from public.waitlist w where w.id = new.waitlist_id and w.unit_id = new.unit_id;
  end if;
  if not found then
    raise exception 'table_unit_mismatch' using errcode = '42501';
  end if;
  return new;
end
$$;
comment on function app_private.guard_occupant_table_unit() is
  'occupant_tables: mesa e ocupante da mesma unidade da linha (42501 table_unit_mismatch).';
revoke all on function app_private.guard_occupant_table_unit() from public, anon, authenticated, service_role;

drop trigger if exists occupant_tables_unit_guard on public.occupant_tables;
create trigger occupant_tables_unit_guard
  before insert or update on public.occupant_tables
  for each row execute function app_private.guard_occupant_table_unit();

-- O guard de mesma unidade da fila e do passante passa a valer na reserva.
drop trigger if exists reservations_table_unit_guard on public.reservations;
create trigger reservations_table_unit_guard
  before insert or update of table_id, unit_id on public.reservations
  for each row execute function app_private.guard_same_unit_table();
comment on function app_private.guard_same_unit_table() is
  'Recusa table_id de mesa de outra unidade (ou inexistente) em reservations, waitlist e walk_ins: 42501 table_unit_mismatch.';

-- ─── Sincronia a partir do table_id legado ───────────────────────────────────
create or replace function app_private.sync_occupant_tables()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_slot tstzrange;
  v_blocks boolean := false;
begin
  if tg_table_name = 'reservations' then
    if new.table_id is null then
      delete from public.occupant_tables ot where ot.reservation_id = new.id;
    elsif not exists (select 1 from public.occupant_tables ot
                       where ot.reservation_id = new.id and ot.table_id = new.table_id) then
      delete from public.occupant_tables ot where ot.reservation_id = new.id;
      v_slot := app_private.reservation_slot(new.unit_id, new.date, new.time);
      v_blocks := new.status in ('pending', 'confirmed') and new.released_at is null;
      insert into public.occupant_tables (unit_id, table_id, reservation_id, slot, blocks_slot)
      values (new.unit_id, new.table_id, new.id, v_slot, v_blocks);
    end if;
  elsif tg_table_name = 'walk_ins' then
    if new.table_id is null then
      delete from public.occupant_tables ot where ot.walk_in_id = new.id;
    elsif not exists (select 1 from public.occupant_tables ot
                       where ot.walk_in_id = new.id and ot.table_id = new.table_id) then
      delete from public.occupant_tables ot where ot.walk_in_id = new.id;
      insert into public.occupant_tables (unit_id, table_id, walk_in_id)
      values (new.unit_id, new.table_id, new.id);
    end if;
  else
    if new.table_id is null then
      delete from public.occupant_tables ot where ot.waitlist_id = new.id;
    elsif not exists (select 1 from public.occupant_tables ot
                       where ot.waitlist_id = new.id and ot.table_id = new.table_id) then
      delete from public.occupant_tables ot where ot.waitlist_id = new.id;
      insert into public.occupant_tables (unit_id, table_id, waitlist_id)
      values (new.unit_id, new.table_id, new.id);
    end if;
  end if;
  return null;
end
$$;
comment on function app_private.sync_occupant_tables() is
  'Mantém occupant_tables a partir do table_id de reservations, walk_ins e waitlist: nulo apaga as linhas; mesa fora das linhas troca tudo pela principal; já nas linhas (junção da recepção) não muda. Pode levantar 23P01 (occupant_tables_no_overlap).';
revoke all on function app_private.sync_occupant_tables() from public, anon, authenticated, service_role;

drop trigger if exists reservations_occupant_sync on public.reservations;
create trigger reservations_occupant_sync
  after insert or update of table_id on public.reservations
  for each row execute function app_private.sync_occupant_tables();
drop trigger if exists walk_ins_occupant_sync on public.walk_ins;
create trigger walk_ins_occupant_sync
  after insert or update of table_id on public.walk_ins
  for each row execute function app_private.sync_occupant_tables();
drop trigger if exists waitlist_occupant_sync on public.waitlist;
create trigger waitlist_occupant_sync
  after insert or update of table_id on public.waitlist
  for each row execute function app_private.sync_occupant_tables();

create or replace function app_private.refresh_occupant_slot()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_moved boolean := new.date is distinct from old.date or new.time is distinct from old.time;
begin
  if not v_moved and new.status is not distinct from old.status
     and new.released_at is not distinct from old.released_at then
    return null;
  end if;
  update public.occupant_tables ot
     set overlap_ok = ot.overlap_ok and not v_moved,
         slot = app_private.reservation_slot(new.unit_id, new.date, new.time),
         blocks_slot = new.status in ('pending', 'confirmed') and new.released_at is null
                       and not (ot.overlap_ok and not v_moved)
   where ot.reservation_id = new.id;
  return null;
end
$$;
comment on function app_private.refresh_occupant_slot() is
  'Recalcula janela e blocks_slot das linhas da reserva quando data, hora, status ou liberação mudam; mudar data ou hora desfaz overlap_ok. Pode levantar 23P01.';
revoke all on function app_private.refresh_occupant_slot() from public, anon, authenticated, service_role;

-- O nome ordena DEPOIS de reservations_occupant_sync (triggers do mesmo evento
-- disparam por nome): num UPDATE que troca mesa e hora juntas, o sync troca as
-- linhas já com a janela nova; se esta rodasse antes, gravaria a janela nova
-- na mesa antiga e daria 23P01 falso contra quem ocupa a mesa antiga.
drop trigger if exists reservations_occupant_slot on public.reservations;
drop trigger if exists reservations_occupant_sync_slot on public.reservations;
create trigger reservations_occupant_sync_slot
  after update of date, time, status, released_at on public.reservations
  for each row execute function app_private.refresh_occupant_slot();

-- ─── Anon não escolhe mesa por escrita direta ────────────────────────────────
-- A policy anon_insert_reservations (023b) não restringe coluna. Nenhum caminho
-- do produto grava reservations como anon (a reserva pública vai pela EF com
-- service role), mas com a exclusão por duração uma linha anon com mesa
-- trancaria a janela inteira e pularia bookable e combinações. A policy e o
-- INSERT de anon caem na 20261105120300; este guard fica como terceira tranca.
create or replace function app_private.guard_anon_reservation_table()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() = 'anon'
     and (new.table_id is not null or new.table_choice is not null or new.original_party_size is not null) then
    raise exception 'reservation_table_forbidden' using errcode = '42501';
  end if;
  return new;
end
$$;
comment on function app_private.guard_anon_reservation_table() is
  'reservations: anon não grava table_id, table_choice nem original_party_size (42501 reservation_table_forbidden). A mesa do cliente vem só pela EF (service role).';
revoke all on function app_private.guard_anon_reservation_table() from public, anon, authenticated, service_role;

drop trigger if exists reservations_anon_table_guard on public.reservations;
create trigger reservations_anon_table_guard
  before insert or update of table_id, table_choice, original_party_size on public.reservations
  for each row execute function app_private.guard_anon_reservation_table();

-- ─── Backfill ────────────────────────────────────────────────────────────────
-- Reservas com mesa de ontem (BRT) em diante, em ordem de chegada do pedido:
-- a que colidiria na exclusão entra com overlap_ok (a recepção resolve na
-- chegada, como a regra de "mesa em uso"). Mesa de outra unidade fica de fora
-- (o guard recusaria). Passante e fila sentados, não liberados, desde ontem.
do $$
declare
  v_yesterday date := (pg_catalog.now() at time zone 'America/Sao_Paulo')::date - 1;
  v_since timestamptz := (v_yesterday::timestamp) at time zone 'America/Sao_Paulo';
  r record;
  v_slot tstzrange;
  v_blocks boolean;
  v_overlaps integer := 0;
  v_rows integer := 0;
  v_skipped integer := 0;
begin
  for r in
    select x.id, x.unit_id, x.table_id, x.date, x.time, x.status, x.released_at,
           (t.id is not null) as same_unit
      from public.reservations x
      left join public.tables t on t.id = x.table_id and t.unit_id = x.unit_id
     where x.table_id is not null and x.date >= v_yesterday
       and not exists (select 1 from public.occupant_tables ot where ot.reservation_id = x.id)
     order by x.date, x.time, x.created_at, x.id
  loop
    if not r.same_unit then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    v_slot := app_private.reservation_slot(r.unit_id, r.date, r.time);
    v_blocks := r.status in ('pending', 'confirmed') and r.released_at is null;
    begin
      insert into public.occupant_tables (unit_id, table_id, reservation_id, slot, blocks_slot)
      values (r.unit_id, r.table_id, r.id, v_slot, v_blocks);
    exception when exclusion_violation then
      insert into public.occupant_tables (unit_id, table_id, reservation_id, slot, blocks_slot, overlap_ok)
      values (r.unit_id, r.table_id, r.id, v_slot, false, true);
      v_overlaps := v_overlaps + 1;
    end;
    v_rows := v_rows + 1;
  end loop;

  insert into public.occupant_tables (unit_id, table_id, walk_in_id)
  select w.unit_id, w.table_id, w.id
    from public.walk_ins w
    join public.tables t on t.id = w.table_id and t.unit_id = w.unit_id
   where w.status = 'seated' and w.released_at is null and w.seated_at >= v_since
     and not exists (select 1 from public.occupant_tables ot where ot.walk_in_id = w.id);

  insert into public.occupant_tables (unit_id, table_id, waitlist_id)
  select w.unit_id, w.table_id, w.id
    from public.waitlist w
    join public.tables t on t.id = w.table_id and t.unit_id = w.unit_id
   where w.status = 'seated' and w.released_at is null and w.seated_at >= v_since
     and not exists (select 1 from public.occupant_tables ot where ot.waitlist_id = w.id);

  raise notice 'occupant_tables backfill: % reservas, % com overlap_ok (sobreposição pré-existente), % com mesa de outra unidade ignoradas',
    v_rows, v_overlaps, v_skipped;
end $$;

-- ─── Histórico ───────────────────────────────────────────────────────────────
create table if not exists public.occupancy_events (
  id bigserial primary key,
  unit_id uuid not null references public.units(id) on delete cascade,
  reservation_id uuid references public.reservations(id) on delete cascade,
  walk_in_id uuid references public.walk_ins(id) on delete cascade,
  waitlist_id uuid references public.waitlist(id) on delete cascade,
  kind text not null,
  before jsonb not null,
  after jsonb not null,
  actor_user_id uuid,
  created_at timestamptz not null default now(),
  constraint occupancy_events_kind_check check (kind in ('tables_changed', 'party_size_changed')),
  constraint occupancy_events_one_occupant check (pg_catalog.num_nonnulls(reservation_id, walk_in_id, waitlist_id) = 1)
);
create index if not exists occupancy_events_unit_created_idx on public.occupancy_events (unit_id, created_at desc);
create index if not exists occupancy_events_reservation_idx on public.occupancy_events (reservation_id) where reservation_id is not null;
create index if not exists occupancy_events_walk_in_idx on public.occupancy_events (walk_in_id) where walk_in_id is not null;
create index if not exists occupancy_events_waitlist_idx on public.occupancy_events (waitlist_id) where waitlist_id is not null;
comment on table public.occupancy_events is
  'Histórico das ações da recepção no salão: troca/junção de mesas (números antes e depois) e ajuste de pessoas. Só as RPCs gravam.';

alter table public.occupancy_events enable row level security;
alter table public.occupancy_events force row level security;
drop policy if exists unit_member_select_occupancy_events on public.occupancy_events;
create policy unit_member_select_occupancy_events on public.occupancy_events
  for select to authenticated using (app_private.is_unit_member(auth.uid(), unit_id));
drop policy if exists platform_admin_select_occupancy_events on public.occupancy_events;
create policy platform_admin_select_occupancy_events on public.occupancy_events
  for select to authenticated using (app_private.is_platform_admin(auth.uid()));
revoke all on table public.occupancy_events from public, anon, authenticated, service_role;
grant select on table public.occupancy_events to authenticated, service_role;
revoke all on sequence public.occupancy_events_id_seq from public, anon, authenticated, service_role;

-- ─── Ocupante: unidade, estado e janela ──────────────────────────────────────
-- Usado pelas duas RPCs da recepção. Trava a linha do ocupante (FOR UPDATE).
-- Sem achar o ocupante, ou caller sem membership e sem platform_admin: o mesmo
-- 42501 seat_forbidden. Estado fora do previsto: 23514 seat_action_invalid.
create or replace function app_private.lock_occupant(p_kind text, p_id uuid)
returns table (o_unit_id uuid, o_window tstzrange, o_party_size integer, o_table_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_status text;
  v_released timestamptz;
  v_arrived timestamptz;
  v_date date;
  v_time time;
  v_since timestamptz;
  v_dur integer;
  v_ok boolean;
begin
  if p_kind = 'reservation' then
    select r.unit_id, r.status, r.released_at, r.arrived_at, r.date, r.time, r.party_size, r.table_id
      into o_unit_id, v_status, v_released, v_arrived, v_date, v_time, o_party_size, o_table_id
      from public.reservations r where r.id = p_id for update;
  elsif p_kind = 'walk_in' then
    select w.unit_id, w.status, w.released_at, coalesce(w.seated_at, w.arrived_at), w.party_size, w.table_id
      into o_unit_id, v_status, v_released, v_since, o_party_size, o_table_id
      from public.walk_ins w where w.id = p_id for update;
  else
    select w.unit_id, w.status, w.released_at, coalesce(w.seated_at, w.created_at), w.party_size, w.table_id
      into o_unit_id, v_status, v_released, v_since, o_party_size, o_table_id
      from public.waitlist w where w.id = p_id for update;
  end if;
  if o_unit_id is null or v_uid is null
     or not (app_private.is_unit_member(v_uid, o_unit_id) or app_private.is_platform_admin(v_uid)) then
    raise exception 'seat_forbidden' using errcode = '42501';
  end if;

  v_ok := case when p_kind = 'reservation' then v_status in ('pending', 'confirmed') and v_released is null
               else v_status = 'seated' and v_released is null end;
  if not v_ok then
    raise exception 'seat_action_invalid' using errcode = '23514';
  end if;

  v_dur := app_private.reservation_duration_minutes(o_unit_id);
  if p_kind = 'reservation' and v_arrived is null then
    o_window := app_private.reservation_slot(o_unit_id, v_date, v_time);
  else
    v_since := coalesce(v_arrived, v_since, pg_catalog.now());
    o_window := pg_catalog.tstzrange(pg_catalog.now(),
      greatest(v_since + pg_catalog.make_interval(mins => v_dur), pg_catalog.now() + interval '1 minute'), '[)');
  end if;
  return next;
end
$$;
comment on function app_private.lock_occupant(text, uuid) is
  'Trava o ocupante (reserva, passante ou fila), confere membership/platform_admin (42501 seat_forbidden, igual para inexistente) e o estado (23514 seat_action_invalid) e devolve unidade, janela (reserva a chegar: a dela; sentado: de agora ao fim previsto), pessoas e mesa principal.';
revoke all on function app_private.lock_occupant(text, uuid) from public, anon, authenticated, service_role;

-- ─── RPC: trocar e juntar mesas ──────────────────────────────────────────────
create or replace function public.set_occupant_tables(p_kind text, p_id uuid, p_table_ids uuid[],
  p_allow_overlap boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_unit uuid;
  v_window tstzrange;
  v_party integer;
  v_principal uuid;
  v_n integer := pg_catalog.cardinality(p_table_ids);
  v_since_day timestamptz := (((pg_catalog.now() at time zone 'America/Sao_Paulo')::date - 1)::timestamp)
                             at time zone 'America/Sao_Paulo';
  v_current uuid[];
  v_before jsonb;
  v_after jsonb;
  v_conflicts jsonb;
  v_conflict_tables uuid[];
  v_is_res boolean := p_kind = 'reservation';
begin
  if p_kind is null or p_kind not in ('reservation', 'walk_in', 'waitlist')
     or p_table_ids is null or v_n is null or v_n not between 1 and 12
     or pg_catalog.array_position(p_table_ids, null) is not null
     or (select count(distinct x) from pg_catalog.unnest(p_table_ids) x) <> v_n then
    raise exception 'seat_action_invalid' using errcode = '22023';
  end if;

  select o.o_unit_id, o.o_window, o.o_party_size, o.o_table_id
    into v_unit, v_window, v_party, v_principal
    from app_private.lock_occupant(p_kind, p_id) o;

  -- Mesas da unidade e ativas (qualquer salão; bookable não importa para a
  -- recepção). NO KEY UPDATE: duas ações sobre a mesma mesa se enfileiram e a
  -- segunda já enxerga a primeira.
  perform 1 from public.tables t
   where t.id = any (p_table_ids) and t.unit_id = v_unit and t.active
   order by t.id
     for no key update;
  if (select count(*) from public.tables t
       where t.id = any (p_table_ids) and t.unit_id = v_unit and t.active) <> v_n then
    raise exception 'seat_forbidden' using errcode = '42501';
  end if;

  select coalesce(pg_catalog.array_agg(ot.table_id), '{}') into v_current
    from public.occupant_tables ot
   where (v_is_res and ot.reservation_id = p_id)
      or (p_kind = 'walk_in' and ot.walk_in_id = p_id)
      or (p_kind = 'waitlist' and ot.waitlist_id = p_id);
  if v_current @> p_table_ids and v_current <@ p_table_ids then
    return pg_catalog.jsonb_build_object('status', 'noop');
  end if;

  -- Outro ocupante sentado (não liberado, desde ontem BRT) cuja ocupação
  -- prevista cruza a janela.
  if exists (
    select 1 from public.occupant_tables ot
      left join public.reservations r on r.id = ot.reservation_id
      left join public.walk_ins w on w.id = ot.walk_in_id
      left join public.waitlist q on q.id = ot.waitlist_id
     where ot.table_id = any (p_table_ids)
       -- IS NOT DISTINCT FROM: as colunas de ocupante das outras linhas são
       -- nulas e um `=` daria NULL, tirando a linha da conferência.
       and not ((v_is_res and ot.reservation_id is not distinct from p_id)
             or (p_kind = 'walk_in' and ot.walk_in_id is not distinct from p_id)
             or (p_kind = 'waitlist' and ot.waitlist_id is not distinct from p_id))
       and (
         (r.id is not null and r.status in ('pending', 'confirmed') and r.released_at is null
            and r.arrived_at is not null and r.arrived_at >= v_since_day
            and pg_catalog.tstzrange(r.arrived_at, greatest(r.arrived_at + pg_catalog.make_interval(
                  mins => app_private.reservation_duration_minutes(v_unit)), pg_catalog.now() + interval '1 minute'), '[)') && v_window)
         or (w.id is not null and w.status = 'seated' and w.released_at is null
            and coalesce(w.seated_at, w.arrived_at) >= v_since_day
            and pg_catalog.tstzrange(coalesce(w.seated_at, w.arrived_at), greatest(coalesce(w.seated_at, w.arrived_at)
                  + pg_catalog.make_interval(mins => app_private.reservation_duration_minutes(v_unit)),
                  pg_catalog.now() + interval '1 minute'), '[)') && v_window)
         or (q.id is not null and q.status = 'seated' and q.released_at is null
            and coalesce(q.seated_at, q.created_at) >= v_since_day
            and pg_catalog.tstzrange(coalesce(q.seated_at, q.created_at), greatest(coalesce(q.seated_at, q.created_at)
                  + pg_catalog.make_interval(mins => app_private.reservation_duration_minutes(v_unit)),
                  pg_catalog.now() + interval '1 minute'), '[)') && v_window)
       )) then
    raise exception 'seat_taken' using errcode = '23514';
  end if;

  -- Bloqueio da própria mesa na janela (bloqueio macro de salão/unidade não
  -- impede a recepção de mover quem já está no salão).
  if exists (select 1 from public.table_blocks b
              where b.unit_id = v_unit and b.table_id = any (p_table_ids)
                and b.blocked_from < pg_catalog.upper(v_window)
                and b.blocked_to > pg_catalog.lower(v_window)) then
    raise exception 'seat_blocked' using errcode = '23514';
  end if;

  -- Reservas de outros cuja janela cruza a desta ocupação (inclui a que já
  -- chegou mas cuja ocupação prevista não cruza: a janela dela ainda colidiria
  -- na exclusão).
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'reservation_id', c.id, 'time', pg_catalog.to_char(c.time, 'HH24:MI'),
           'customer_name', c.customer_name, 'table_number', c.number)
           order by c.date, c.time, c.number),
         pg_catalog.array_agg(distinct c.table_id)
    into v_conflicts, v_conflict_tables
    from (select r.id, r.date, r.time, cu.name as customer_name, t.number, ot.table_id
            from public.occupant_tables ot
            join public.reservations r on r.id = ot.reservation_id and r.unit_id = v_unit
            join public.tables t on t.id = ot.table_id
            left join public.customers cu on cu.id = r.customer_id
                  and cu.organization_id = (select u.organization_id from public.units u where u.id = v_unit)
           where ot.unit_id = v_unit and ot.table_id = any (p_table_ids)
             and not (v_is_res and r.id = p_id)
             and r.status in ('pending', 'confirmed') and r.released_at is null
             and ot.slot && v_window) c;
  if v_conflicts is not null and not coalesce(p_allow_overlap, false) then
    return pg_catalog.jsonb_build_object('status', 'conflict', 'conflicts', v_conflicts);
  end if;

  select coalesce(pg_catalog.jsonb_agg(t.number order by (t.id = v_principal) desc, t.number), '[]')
    into v_before from public.tables t where t.id = any (v_current);
  select pg_catalog.jsonb_agg(t.number order by pg_catalog.array_position(p_table_ids, t.id))
    into v_after from public.tables t where t.id = any (p_table_ids);

  if v_is_res then
    delete from public.occupant_tables ot where ot.reservation_id = p_id;
    begin
      insert into public.occupant_tables (unit_id, table_id, reservation_id, slot, blocks_slot, overlap_ok)
      select v_unit, x.id, p_id, v_window,
             not (x.id = any (coalesce(v_conflict_tables, '{}'))),
             x.id = any (coalesce(v_conflict_tables, '{}'))
        from pg_catalog.unnest(p_table_ids) x(id);
    exception when exclusion_violation then
      -- Reserva gravada por outro caminho entre a conferência e a escrita.
      raise exception 'seat_taken' using errcode = '23514';
    end;
    update public.reservations r set table_id = p_table_ids[1], table_choice = 'staff' where r.id = p_id;
  elsif p_kind = 'walk_in' then
    delete from public.occupant_tables ot where ot.walk_in_id = p_id;
    insert into public.occupant_tables (unit_id, table_id, walk_in_id, overlap_ok)
    select v_unit, x.id, p_id, x.id = any (coalesce(v_conflict_tables, '{}'))
      from pg_catalog.unnest(p_table_ids) x(id);
    update public.walk_ins w set table_id = p_table_ids[1] where w.id = p_id;
  else
    delete from public.occupant_tables ot where ot.waitlist_id = p_id;
    insert into public.occupant_tables (unit_id, table_id, waitlist_id, overlap_ok)
    select v_unit, x.id, p_id, x.id = any (coalesce(v_conflict_tables, '{}'))
      from pg_catalog.unnest(p_table_ids) x(id);
    update public.waitlist w set table_id = p_table_ids[1] where w.id = p_id;
  end if;

  insert into public.occupancy_events (unit_id, reservation_id, walk_in_id, waitlist_id, kind, before, after, actor_user_id)
  values (v_unit,
          case when v_is_res then p_id end,
          case when p_kind = 'walk_in' then p_id end,
          case when p_kind = 'waitlist' then p_id end,
          'tables_changed',
          pg_catalog.jsonb_build_object('tables', v_before),
          pg_catalog.jsonb_build_object('tables', v_after, 'overlap_confirmed', v_conflicts is not null),
          auth.uid());
  return pg_catalog.jsonb_build_object('status', 'ok');
end
$$;
comment on function public.set_occupant_tables(text, uuid, uuid[], boolean) is
  'Recepção troca ou junta mesas de uma reserva (pending/confirmed, não liberada), passante ou fila (sentados, não liberados). Não muda status nem cria linha. Qualquer papel da unidade ou platform_admin; alheio, inexistente ou mesa de outra unidade/inativa: 42501 seat_forbidden. Mesa com outro ocupante sentado: 23514 seat_taken; bloqueada: 23514 seat_blocked. Reserva de outro a chegar na janela: {"status":"conflict"} sem gravar, ou grava com p_allow_overlap marcando overlap_ok. Mesmo conjunto: {"status":"noop"}.';
revoke all on function public.set_occupant_tables(text, uuid, uuid[], boolean) from public, anon, authenticated, service_role;
grant execute on function public.set_occupant_tables(text, uuid, uuid[], boolean) to authenticated;

-- ─── RPC: ajustar pessoas ────────────────────────────────────────────────────
create or replace function public.set_occupant_party_size(p_kind text, p_id uuid, p_party_size integer)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_unit uuid;
  v_window tstzrange;
  v_party integer;
  v_table uuid;
begin
  if p_kind is null or p_kind not in ('reservation', 'walk_in', 'waitlist')
     or p_party_size is null or p_party_size not between 1 and 50 then
    raise exception 'seat_action_invalid' using errcode = '22023';
  end if;
  select o.o_unit_id, o.o_window, o.o_party_size, o.o_table_id
    into v_unit, v_window, v_party, v_table
    from app_private.lock_occupant(p_kind, p_id) o;
  if v_party = p_party_size then
    return false;
  end if;

  if p_kind = 'reservation' then
    update public.reservations r
       set party_size = p_party_size, original_party_size = coalesce(r.original_party_size, v_party)
     where r.id = p_id;
  elsif p_kind = 'walk_in' then
    update public.walk_ins w
       set party_size = p_party_size, original_party_size = coalesce(w.original_party_size, v_party)
     where w.id = p_id;
  else
    update public.waitlist w
       set party_size = p_party_size, original_party_size = coalesce(w.original_party_size, v_party)
     where w.id = p_id;
  end if;

  insert into public.occupancy_events (unit_id, reservation_id, walk_in_id, waitlist_id, kind, before, after, actor_user_id)
  values (v_unit,
          case when p_kind = 'reservation' then p_id end,
          case when p_kind = 'walk_in' then p_id end,
          case when p_kind = 'waitlist' then p_id end,
          'party_size_changed',
          pg_catalog.jsonb_build_object('party_size', v_party),
          pg_catalog.jsonb_build_object('party_size', p_party_size),
          auth.uid());
  return true;
end
$$;
comment on function public.set_occupant_party_size(text, uuid, integer) is
  'Recepção ajusta o número de pessoas (1..50) de reserva, passante ou fila, nos mesmos estados e com a mesma autorização da set_occupant_tables. Guarda original_party_size na primeira mudança e grava party_size_changed. Não muda status nem caução. false quando igual.';
revoke all on function public.set_occupant_party_size(text, uuid, integer) from public, anon, authenticated, service_role;
grant execute on function public.set_occupant_party_size(text, uuid, integer) to authenticated;

-- ─── RPC: reserva com várias mesas numa transação (só service_role) ──────────
-- Colunas aceitas = as do INSERT de reserveSlot (_shared/availability.ts) mais
-- table_choice. As mesas são da unidade da linha, ativas e reserváveis.
create or replace function public.insert_reservation_with_tables(p_row jsonb, p_table_ids uuid[])
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_allowed constant text[] := array['customer_id', 'unit_id', 'date', 'time', 'party_size', 'notes',
    'reservation_code', 'status', 'payment_status', 'payment_amount_cents', 'payment_expires_at',
    'applied_discount_percent', 'source', 'table_choice'];
  v_required constant text[] := array['customer_id', 'unit_id', 'date', 'time', 'party_size', 'reservation_code'];
  v_n integer := pg_catalog.cardinality(p_table_ids);
  v_unit uuid;
  v_cols text;
  v_id uuid;
  v_res public.reservations;
begin
  if p_row is null or pg_catalog.jsonb_typeof(p_row) <> 'object'
     or exists (select 1 from pg_catalog.jsonb_object_keys(p_row) k where not (k = any (v_allowed)))
     or not (p_row ?& v_required)
     or p_table_ids is null or v_n is null or v_n not between 1 and 12
     or pg_catalog.array_position(p_table_ids, null) is not null
     or (select count(distinct x) from pg_catalog.unnest(p_table_ids) x) <> v_n then
    raise exception 'reservation_row_invalid' using errcode = '22023';
  end if;
  v_unit := (p_row ->> 'unit_id')::uuid;

  -- Cliente da organização da unidade (o service role não passa por RLS).
  if not exists (select 1 from public.customers c
                   join public.units u on u.organization_id = c.organization_id
                  where c.id = (p_row ->> 'customer_id')::uuid and u.id = v_unit) then
    raise exception 'reservation_row_invalid' using errcode = '22023';
  end if;

  if (select count(*) from public.tables t
       where t.id = any (p_table_ids) and t.unit_id = v_unit and t.active and t.bookable) <> v_n then
    raise exception 'seat_forbidden' using errcode = '42501';
  end if;

  select pg_catalog.string_agg(pg_catalog.quote_ident(k), ', ' order by k) into v_cols
    from pg_catalog.jsonb_object_keys(p_row) k;
  execute pg_catalog.format(
    'insert into public.reservations (%1$s, table_id) select %1$s, $2 from pg_catalog.jsonb_populate_record(null::public.reservations, $1) returning id',
    v_cols) into v_id using p_row, p_table_ids[1];

  select * into v_res from public.reservations r where r.id = v_id;
  insert into public.occupant_tables (unit_id, table_id, reservation_id, slot, blocks_slot)
  select v_unit, x.id, v_id, app_private.reservation_slot(v_unit, v_res.date, v_res.time),
         v_res.status in ('pending', 'confirmed') and v_res.released_at is null
    from pg_catalog.unnest(p_table_ids[2:]) x(id);
  return v_id;
end
$$;
comment on function public.insert_reservation_with_tables(jsonb, uuid[]) is
  'Só service_role (EF create-reservation e agente): insere a reserva com table_id = primeira mesa e as mesas extras em occupant_tables na mesma transação. Mesa fora da unidade, inativa ou não reservável: 42501 seat_forbidden; colisão com outra reserva: 23P01 (occupant_tables_no_overlap) e nada fica gravado.';
revoke all on function public.insert_reservation_with_tables(jsonb, uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.insert_reservation_with_tables(jsonb, uuid[]) to service_role;

commit;
