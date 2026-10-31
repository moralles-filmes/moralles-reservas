-- Planta do salão (Parte B do redesign), passo 2: presença nas mesas.
-- Spec: docs/superpowers/specs/2026-10-29-redesign-salao-em-vidro-design.md §5;
-- plano: docs/superpowers/plans/2026-10-30-planta-do-salao.md, Task 2.
--
-- Regra do dono: nada pode duplicar nem inflar métrica. Por isso nenhuma ação
-- da planta muda `status` nem cria linha em outra tabela de fluxo:
--   * chegada e liberação são carimbos à parte (`arrived_at`/`released_at` na
--     reserva; `released_at` na fila e no passante);
--   * sentar da fila grava a mesa na própria linha de `waitlist`;
--   * liberar um passante NUNCA usa `status = 'left'`: o useFluxoClientes conta
--     como sentado só `seated` (mesas, pessoas e receita).
-- O trigger `guard_presence_stamps` impõe a ordem e o relógio do servidor; o
-- `guard_same_unit_table` recusa mesa de outra unidade na fila e no passante.
-- As RPCs são SECURITY INVOKER sobre a RLS existente (reservations e waitlist
-- têm FORCE RLS): alheio e inexistente caem no mesmo 42501.
-- Aditiva e inerte: colunas nulas, nenhuma tela usa ainda.
-- Pré-voo: supabase/tests/local-preflight/81-planta-do-salao.sql (README §81).
begin;
set local lock_timeout = '5s';

-- ─── Colunas, CHECKs e índices ───────────────────────────────────────────────
alter table public.reservations
  add column if not exists arrived_at timestamptz,
  add column if not exists released_at timestamptz;
alter table public.reservations drop constraint if exists reservations_presence_order;
alter table public.reservations add constraint reservations_presence_order check (
  released_at is null or (arrived_at is not null and released_at >= arrived_at));

alter table public.waitlist
  add column if not exists table_id uuid references public.tables(id) on delete set null,
  add column if not exists released_at timestamptz;
alter table public.waitlist drop constraint if exists waitlist_release_requires_seat;
alter table public.waitlist add constraint waitlist_release_requires_seat check (
  released_at is null or seated_at is not null);

-- `seated_at`, não `status`: "Foi embora" (`left`) depois de liberar continua valendo.
alter table public.walk_ins add column if not exists released_at timestamptz;
alter table public.walk_ins drop constraint if exists walk_ins_release_requires_seat;
alter table public.walk_ins add constraint walk_ins_release_requires_seat check (
  released_at is null or seated_at is not null);

create index if not exists waitlist_table_open_idx on public.waitlist (table_id)
  where table_id is not null and released_at is null;
create index if not exists walk_ins_table_open_idx on public.walk_ins (table_id)
  where status = 'seated' and released_at is null;

-- ─── Trigger de carimbos de presença ─────────────────────────────────────────
-- Campos por tabela em IFs separados: `arrived_at` só existe com esse sentido
-- em reservations (walk_ins.arrived_at é a entrada do passante e fica de fora).
create or replace function app_private.guard_presence_stamps()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_today date := (pg_catalog.now() at time zone 'America/Sao_Paulo')::date;
begin
  if tg_op = 'INSERT' then
    if new.released_at is not null then
      raise exception 'presence_invalid' using errcode = '23514', detail = 'born_with_presence';
    end if;
    if tg_table_name = 'reservations' then
      if new.arrived_at is not null then
        raise exception 'presence_invalid' using errcode = '23514', detail = 'born_with_presence';
      end if;
    end if;
    return new;
  end if;

  if tg_table_name = 'reservations' then
    if old.arrived_at is null and new.arrived_at is not null then
      if new.status not in ('pending', 'confirmed') or new.date not between v_today - 1 and v_today then
        raise exception 'presence_invalid' using errcode = '23514', detail = 'arrival_not_allowed';
      end if;
      new.arrived_at := pg_catalog.now();
    elsif old.arrived_at is not null and new.arrived_at is null then
      if old.released_at is not null or new.released_at is not null then
        raise exception 'presence_invalid' using errcode = '23514', detail = 'presence_final';
      end if;
    elsif old.arrived_at is distinct from new.arrived_at then
      raise exception 'presence_invalid' using errcode = '23514', detail = 'presence_final';
    end if;
  end if;

  if old.released_at is null and new.released_at is not null then
    if tg_table_name = 'reservations' then
      if new.arrived_at is null then
        raise exception 'presence_invalid' using errcode = '23514', detail = 'release_requires_arrival';
      end if;
    elsif new.status is distinct from 'seated' then
      raise exception 'presence_invalid' using errcode = '23514', detail = 'not_seated';
    end if;
    new.released_at := pg_catalog.now();
  elsif old.released_at is distinct from new.released_at then
    raise exception 'presence_invalid' using errcode = '23514', detail = 'presence_final';
  end if;
  return new;
end
$$;
comment on function app_private.guard_presence_stamps() is
  'Carimbos de presença com relógio do servidor (23514 presence_invalid, motivo no DETAIL): ninguém nasce com chegada/liberação; chegada só em pending/confirmed de hoje ou ontem (BRT); desfazer só antes de liberar; liberar exige chegada (reserva) ou status seated (fila, passante); carimbo gravado não muda. Não toca status.';
revoke all on function app_private.guard_presence_stamps() from public, anon, authenticated, service_role;

drop trigger if exists reservations_presence_guard on public.reservations;
create trigger reservations_presence_guard
  before insert or update on public.reservations
  for each row execute function app_private.guard_presence_stamps();
drop trigger if exists waitlist_presence_guard on public.waitlist;
create trigger waitlist_presence_guard
  before insert or update on public.waitlist
  for each row execute function app_private.guard_presence_stamps();
drop trigger if exists walk_ins_presence_guard on public.walk_ins;
create trigger walk_ins_presence_guard
  before insert or update on public.walk_ins
  for each row execute function app_private.guard_presence_stamps();

-- ─── Mesa da mesma unidade na fila e no passante ─────────────────────────────
create or replace function app_private.guard_same_unit_table()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.table_id is not null and not exists (
       select 1 from public.tables t where t.id = new.table_id and t.unit_id = new.unit_id) then
    raise exception 'table_unit_mismatch' using errcode = '42501';
  end if;
  return new;
end
$$;
comment on function app_private.guard_same_unit_table() is
  'Recusa table_id de mesa de outra unidade (ou inexistente) em waitlist e walk_ins: 42501 table_unit_mismatch.';
revoke all on function app_private.guard_same_unit_table() from public, anon, authenticated, service_role;

drop trigger if exists waitlist_table_unit_guard on public.waitlist;
create trigger waitlist_table_unit_guard
  before insert or update of table_id, unit_id on public.waitlist
  for each row execute function app_private.guard_same_unit_table();
drop trigger if exists walk_ins_table_unit_guard on public.walk_ins;
create trigger walk_ins_table_unit_guard
  before insert or update of table_id, unit_id on public.walk_ins
  for each row execute function app_private.guard_same_unit_table();

-- ─── Paralelo de super-admin que faltava em walk_ins (AGENTS §8) ─────────────
drop policy if exists platform_admin_all_walk_ins on public.walk_ins;
create policy platform_admin_all_walk_ins on public.walk_ins for all to authenticated
  using (app_private.is_platform_admin(auth.uid()))
  with check (app_private.is_platform_admin(auth.uid()));

-- ─── RPCs de presença ────────────────────────────────────────────────────────
create or replace function public.set_reservation_presence(p_reservation_id uuid, p_action text)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  v_arrived timestamptz;
  v_released timestamptz;
begin
  if p_action is null or p_action not in ('arrive', 'undo_arrive', 'release') then
    raise exception 'presence_action_invalid' using errcode = '22023';
  end if;
  select r.arrived_at, r.released_at into v_arrived, v_released
    from public.reservations r where r.id = p_reservation_id for update;
  if not found then
    raise exception 'presence_forbidden' using errcode = '42501';
  end if;
  -- Repetição não escreve: o horário gravado fica e não sobra linha de auditoria.
  if (p_action = 'arrive' and v_arrived is not null)
     or (p_action = 'undo_arrive' and v_arrived is null)
     or (p_action = 'release' and v_released is not null) then
    return;
  end if;
  if p_action = 'release' then
    update public.reservations r set released_at = pg_catalog.now() where r.id = p_reservation_id;
  else
    update public.reservations r
       set arrived_at = case when p_action = 'arrive' then pg_catalog.now() end
     where r.id = p_reservation_id;
  end if;
end
$$;
comment on function public.set_reservation_presence(uuid, text) is
  'Chegada (arrive), desfazer chegada (undo_arrive) e liberar mesa (release) de uma reserva. Não muda status nem cria linha; carimbo de presença. Repetir não muda o horário. Alheia ou inexistente: 42501 presence_forbidden.';
revoke all on function public.set_reservation_presence(uuid, text) from public, anon, authenticated;
grant execute on function public.set_reservation_presence(uuid, text) to authenticated;

create or replace function public.seat_waitlist_entry(p_waitlist_id uuid, p_table_id uuid)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  if p_table_id is null then
    raise exception 'presence_action_invalid' using errcode = '22023';
  end if;
  update public.waitlist w set status = 'seated', table_id = p_table_id
   where w.id = p_waitlist_id and w.status in ('waiting', 'notified');
  if not found then
    if exists (select 1 from public.waitlist w where w.id = p_waitlist_id) then
      raise exception 'presence_invalid' using errcode = '23514', detail = 'not_seatable';
    end if;
    raise exception 'presence_forbidden' using errcode = '42501';
  end if;
end
$$;
comment on function public.seat_waitlist_entry(uuid, uuid) is
  'Senta uma entrada da fila (waiting/notified) numa mesa da mesma unidade, na própria linha de waitlist (status seated, table_id). Não cria passante. Alheia ou inexistente: 42501 presence_forbidden; mesa de outra unidade: 42501 table_unit_mismatch.';
revoke all on function public.seat_waitlist_entry(uuid, uuid) from public, anon, authenticated;
grant execute on function public.seat_waitlist_entry(uuid, uuid) to authenticated;

create or replace function public.release_waitlist_entry(p_waitlist_id uuid)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  update public.waitlist w set released_at = coalesce(w.released_at, pg_catalog.now())
   where w.id = p_waitlist_id and w.status = 'seated';
  if not found then
    if exists (select 1 from public.waitlist w where w.id = p_waitlist_id) then
      raise exception 'presence_invalid' using errcode = '23514', detail = 'not_seated';
    end if;
    raise exception 'presence_forbidden' using errcode = '42501';
  end if;
end
$$;
comment on function public.release_waitlist_entry(uuid) is
  'Libera a mesa de uma entrada da fila sentada (released_at). Status fica seated; carimbo de presença. Alheia ou inexistente: 42501 presence_forbidden.';
revoke all on function public.release_waitlist_entry(uuid) from public, anon, authenticated;
grant execute on function public.release_waitlist_entry(uuid) to authenticated;

create or replace function public.release_walk_in(p_walk_in_id uuid)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  update public.walk_ins w set released_at = coalesce(w.released_at, pg_catalog.now())
   where w.id = p_walk_in_id and w.status = 'seated';
  if not found then
    if exists (select 1 from public.walk_ins w where w.id = p_walk_in_id) then
      raise exception 'presence_invalid' using errcode = '23514', detail = 'not_seated';
    end if;
    raise exception 'presence_forbidden' using errcode = '42501';
  end if;
end
$$;
comment on function public.release_walk_in(uuid) is
  'Libera a mesa de um passante sentado (released_at). Status fica seated, para as métricas de sentados e receita; nunca usa left. Alheio ou inexistente: 42501 presence_forbidden.';
revoke all on function public.release_walk_in(uuid) from public, anon, authenticated;
grant execute on function public.release_walk_in(uuid) to authenticated;

commit;
