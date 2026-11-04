-- Escolha de mesa, passo 1: mesa reservável e combinações de mesas juntas.
-- Spec: docs/superpowers/specs/2026-11-04-escolha-de-mesa-design.md §1;
-- plano: docs/superpowers/plans/2026-11-04-escolha-de-mesa.md, Task 1.
--
-- Aditiva (expand): `tables.bookable` nasce true para todas as mesas e nenhuma
-- leitura existente muda. As combinações são do salão (`unit_id` + `hall_id`).
--
-- Escrita das combinações: `save_hall_plan` é SECURITY INVOKER (authenticated
-- não tem USAGE em app_private), então as duas tabelas têm policy de escrita
-- para membro e o papel é decidido pelo `guard_layout_write` (owner, gerente,
-- platform_admin; 42501 layout_write_forbidden), como em tables/halls. A
-- integridade fica em triggers que valem para todo papel:
--   * `guard_combination_row`: salão da mesma unidade; unidade e salão
--     imutáveis; combinação desativada não volta a valer (42501 combination_invalid);
--   * `guard_combination_member`: mesa da unidade e do salão da combinação,
--     reservável e ativa (42501 combination_invalid);
--   * `deactivate_combinations_of_table`: mesa que deixa de ser reservável,
--     é desativada ou muda de salão desativa as combinações dela.
-- Combinação nunca é apagada pela tela: vira active=false, porque reservas e
-- links antigos podem citá-la. `save_hall_plan` mantém o id de combinação
-- cujo conjunto de mesas continua no payload.
-- Pré-voo: supabase/tests/local-preflight/83-escolha-de-mesa.sql (README §83).
--
-- Rollback (migration nova, nunca edição desta): drop da save_hall_plan de 5
-- argumentos e create da de 4 (corpo de 20261030120000, com revoke/grant);
-- drop das tabelas table_combination_members e table_combinations, dos
-- triggers e funções app_private.guard_combination_row/_member e
-- deactivate_combinations_of_table; guard_table_hall_unit sem a perna de
-- combinações; `tables.bookable` pode ficar (inerte).
begin;
set local lock_timeout = '5s';

-- ─── Mesa reservável ─────────────────────────────────────────────────────────
alter table public.tables add column if not exists bookable boolean not null default true;
comment on column public.tables.bookable is
  'false = "Não disponível para reservas": aparece no mapa do cliente, mas não recebe reserva automática, do cliente ou da IA, e não entra em combinação. A recepção usa livremente.';

-- ─── Combinações ─────────────────────────────────────────────────────────────
create table if not exists public.table_combinations (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references public.units(id) on delete cascade,
  hall_id uuid not null references public.halls(id) on delete cascade,
  min_capacity integer not null,
  max_capacity integer not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint table_combinations_capacity_range check (max_capacity >= min_capacity and min_capacity > 0)
);
create index if not exists table_combinations_hall_active_idx
  on public.table_combinations (hall_id) where active;
create index if not exists table_combinations_unit_idx on public.table_combinations (unit_id);
comment on table public.table_combinations is
  'Mesas juntas cadastradas no editor do salão, com a faixa de pessoas digitada pelo restaurante. Valem para a escolha do cliente e a escolha automática. Desativada (active=false) não volta a valer.';

create table if not exists public.table_combination_members (
  combination_id uuid not null references public.table_combinations(id) on delete cascade,
  table_id uuid not null references public.tables(id) on delete cascade,
  unit_id uuid not null references public.units(id) on delete cascade,
  primary key (combination_id, table_id)
);
create index if not exists table_combination_members_table_idx
  on public.table_combination_members (table_id);

drop trigger if exists table_combinations_updated_at on public.table_combinations;
create trigger table_combinations_updated_at before update on public.table_combinations
  for each row execute function public.update_updated_at();

-- ─── RLS e ACL ───────────────────────────────────────────────────────────────
alter table public.table_combinations enable row level security;
alter table public.table_combinations force row level security;
alter table public.table_combination_members enable row level security;
alter table public.table_combination_members force row level security;

drop policy if exists unit_member_select_table_combinations on public.table_combinations;
create policy unit_member_select_table_combinations on public.table_combinations
  for select to authenticated using (app_private.is_unit_member(auth.uid(), unit_id));
drop policy if exists unit_member_insert_table_combinations on public.table_combinations;
create policy unit_member_insert_table_combinations on public.table_combinations
  for insert to authenticated with check (app_private.is_unit_member(auth.uid(), unit_id));
drop policy if exists unit_member_update_table_combinations on public.table_combinations;
create policy unit_member_update_table_combinations on public.table_combinations
  for update to authenticated
  using (app_private.is_unit_member(auth.uid(), unit_id))
  with check (app_private.is_unit_member(auth.uid(), unit_id));
drop policy if exists platform_admin_all_table_combinations on public.table_combinations;
create policy platform_admin_all_table_combinations on public.table_combinations
  for all to authenticated
  using (app_private.is_platform_admin(auth.uid()))
  with check (app_private.is_platform_admin(auth.uid()));

drop policy if exists unit_member_select_table_combination_members on public.table_combination_members;
create policy unit_member_select_table_combination_members on public.table_combination_members
  for select to authenticated using (app_private.is_unit_member(auth.uid(), unit_id));
drop policy if exists unit_member_insert_table_combination_members on public.table_combination_members;
create policy unit_member_insert_table_combination_members on public.table_combination_members
  for insert to authenticated with check (app_private.is_unit_member(auth.uid(), unit_id));
drop policy if exists platform_admin_all_table_combination_members on public.table_combination_members;
create policy platform_admin_all_table_combination_members on public.table_combination_members
  for all to authenticated
  using (app_private.is_platform_admin(auth.uid()))
  with check (app_private.is_platform_admin(auth.uid()));

-- Anon não lê nem escreve: o mapa público sai da Edge Function public-seat-map.
revoke all on table public.table_combinations, public.table_combination_members from public, anon, authenticated;
grant select, insert, update on table public.table_combinations to authenticated;
grant select, insert on table public.table_combination_members to authenticated;
grant all on table public.table_combinations, public.table_combination_members to service_role;

-- ─── Papel: o mesmo guard de layout de tables/halls ──────────────────────────
-- As duas tabelas têm unit_id próprio (ramo `else` do guard_layout_write).
drop trigger if exists table_combinations_write_role_guard on public.table_combinations;
create trigger table_combinations_write_role_guard
  before insert or update or delete on public.table_combinations
  for each row execute function app_private.guard_layout_write();
drop trigger if exists table_combination_members_write_role_guard on public.table_combination_members;
create trigger table_combination_members_write_role_guard
  before insert or update or delete on public.table_combination_members
  for each row execute function app_private.guard_layout_write();

-- ─── Integridade da combinação (todo papel) ──────────────────────────────────
-- Nome `*_write_unit_*`: dispara depois do `*_write_role_guard` (ordem por
-- nome), então quem não tem papel recebe layout_write_forbidden antes de
-- qualquer sinal sobre salão ou mesa (sem oráculo).
create or replace function app_private.guard_combination_row()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if new.unit_id is distinct from old.unit_id or new.hall_id is distinct from old.hall_id
       or (new.active and not old.active) then
      raise exception 'combination_invalid' using errcode = '42501';
    end if;
    return new;
  end if;
  perform 1 from public.halls h where h.id = new.hall_id and h.unit_id = new.unit_id for share;
  if not found then
    raise exception 'combination_invalid' using errcode = '42501';
  end if;
  return new;
end
$$;
comment on function app_private.guard_combination_row() is
  'table_combinations: salão da mesma unidade na criação; unidade e salão imutáveis; combinação desativada não volta a valer (42501 combination_invalid). Vale para todos os papéis.';
revoke all on function app_private.guard_combination_row() from public, anon, authenticated, service_role;

drop trigger if exists table_combinations_write_unit_guard on public.table_combinations;
create trigger table_combinations_write_unit_guard
  before insert or update on public.table_combinations
  for each row execute function app_private.guard_combination_row();

create or replace function app_private.guard_combination_member()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_hall uuid;
begin
  select c.hall_id into v_hall from public.table_combinations c
   where c.id = new.combination_id and c.unit_id = new.unit_id;
  if not found then
    raise exception 'combination_invalid' using errcode = '42501';
  end if;
  -- FOR SHARE: a mudança concorrente de bookable/active/hall_id da mesa espera
  -- este insert, e o trigger de desativação dela vê o membro novo.
  perform 1 from public.tables t
   where t.id = new.table_id and t.unit_id = new.unit_id and t.hall_id = v_hall
     and t.bookable and t.active
     for share;
  if not found then
    raise exception 'combination_invalid' using errcode = '42501';
  end if;
  return new;
end
$$;
comment on function app_private.guard_combination_member() is
  'table_combination_members: a mesa é da unidade e do salão da combinação, reservável e ativa (42501 combination_invalid). Vale para todos os papéis.';
revoke all on function app_private.guard_combination_member() from public, anon, authenticated, service_role;

drop trigger if exists table_combination_members_write_unit_guard on public.table_combination_members;
create trigger table_combination_members_write_unit_guard
  before insert or update on public.table_combination_members
  for each row execute function app_private.guard_combination_member();

create or replace function app_private.deactivate_combinations_of_table()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'table_combination_members' then
    -- Mesa apagada (cascata): a combinação não vale com menos mesas.
    update public.table_combinations c set active = false
     where c.id = old.combination_id and c.active;
    return null;
  end if;
  if (old.bookable and not new.bookable)
     or (old.active and not new.active)
     or new.hall_id is distinct from old.hall_id then
    update public.table_combinations c set active = false
     where c.active
       and c.id in (select m.combination_id from public.table_combination_members m
                     where m.table_id = new.id);
  end if;
  return null;
end
$$;
comment on function app_private.deactivate_combinations_of_table() is
  'Mesa que deixa de ser reservável, é desativada, muda de salão ou é apagada desativa as combinações que a contêm. Não mexe em reserva.';
revoke all on function app_private.deactivate_combinations_of_table() from public, anon, authenticated, service_role;

drop trigger if exists tables_deactivate_combinations on public.tables;
create trigger tables_deactivate_combinations
  after update of bookable, active, hall_id on public.tables
  for each row execute function app_private.deactivate_combinations_of_table();
drop trigger if exists table_combination_members_deactivate_combination on public.table_combination_members;
create trigger table_combination_members_deactivate_combination
  after delete on public.table_combination_members
  for each row execute function app_private.deactivate_combinations_of_table();

-- Salão com combinação também não muda de unidade (mesmo motivo das mesas).
create or replace function app_private.guard_table_hall_unit()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'tables' then
    -- FOR SHARE trava o salão contra o UPDATE concorrente de halls.unit_id, que
    -- trava a linha antes deste trigger: mover o salão e pendurar mesa nele não passam juntos.
    if new.hall_id is not null then
      perform 1 from public.halls h where h.id = new.hall_id and h.unit_id = new.unit_id for share;
      if not found then
        raise exception 'hall_unit_mismatch' using errcode = '42501';
      end if;
    end if;
  elsif new.unit_id is distinct from old.unit_id and (
          exists (select 1 from public.tables t where t.hall_id = old.id)
          or exists (select 1 from public.hall_schedules s where s.hall_id = old.id)
          or exists (select 1 from public.table_blocks b where b.hall_id = old.id)
          or exists (select 1 from public.special_dates d where d.hall_id = old.id)
          or exists (select 1 from public.table_combinations c where c.hall_id = old.id)) then
    raise exception 'hall_unit_mismatch' using errcode = '42501';
  end if;
  return new;
end
$$;
comment on function app_private.guard_table_hall_unit() is
  'Recusa tables.hall_id de salão de outra unidade (ou inexistente) e mudança de halls.unit_id com mesa, horário, bloqueio, data especial ou combinação no salão: 42501 hall_unit_mismatch. Vale para todos os papéis.';
revoke all on function app_private.guard_table_hall_unit() from public, anon, authenticated, service_role;

-- ─── save_hall_plan v2: bookable por mesa e combinações ──────────────────────
-- Assinatura nova com p_combinations default null: a chamada nomeada de 4
-- argumentos do front publicado resolve para esta e não mexe nas combinações.
drop function if exists public.save_hall_plan(uuid, timestamptz, jsonb, jsonb);
drop function if exists public.save_hall_plan(uuid, timestamptz, jsonb, jsonb, jsonb);
create function public.save_hall_plan(
  p_hall_id uuid, p_expected_updated_at timestamptz, p_hall jsonb, p_tables jsonb,
  p_combinations jsonb default null)
returns timestamptz language plpgsql security invoker set search_path = '' as $$
declare
  v_unit uuid;
  v_rev timestamptz;
  v_new timestamptz;
  v_width integer;
  v_depth integer;
  v_wall text;
  v_offset integer;
  v_windows text[];
  v_ids uuid[];
  v_n integer;
  v_count integer;
  v_norm jsonb;
  v_combo record;
  v_combo_id uuid;
begin
  -- 1. O salão visível pela RLS de quem chama; alheio e inexistente são iguais.
  select h.unit_id, h.updated_at into v_unit, v_rev
    from public.halls h where h.id = p_hall_id for update;
  if not found then
    raise exception 'hall_plan_forbidden' using errcode = '42501';
  end if;

  -- 2. Papel: o trigger de planta, em modo estrito, decide (owner, gerente ou
  -- platform_admin). A escrita é desfeita se recusada.
  perform pg_catalog.set_config('planta.strict_plan_write', 'on', true);
  begin
    update public.halls h set plan_width_cm = h.plan_width_cm where h.id = p_hall_id;
  exception when insufficient_privilege then
    raise exception 'hall_plan_forbidden' using errcode = '42501';
  end;

  -- 3. Concorrência: outra aba salvou depois da leitura de quem chama.
  if p_expected_updated_at is distinct from v_rev then
    raise exception 'hall_plan_stale' using errcode = '40001';
  end if;

  -- 4. Forma do payload. Inteiros chegam como número JSON; texto, como string.
  -- IFs em sequência: o OR do SQL não garante a ordem de avaliação, e
  -- jsonb_array_length/jsonb_array_elements estouram sobre não-array.
  if jsonb_typeof(p_hall) is distinct from 'object'
     or jsonb_typeof(p_tables) is distinct from 'array' then
    raise exception 'hall_plan_invalid' using errcode = '22023';
  end if;
  if not (p_hall ?& array['width_cm', 'depth_cm', 'entrance_wall', 'entrance_offset_cm', 'window_walls'])
     or jsonb_array_length(p_tables) > 500 then
    raise exception 'hall_plan_invalid' using errcode = '22023';
  end if;
  if jsonb_typeof(p_hall -> 'width_cm') not in ('number', 'null')
     or jsonb_typeof(p_hall -> 'depth_cm') not in ('number', 'null')
     or jsonb_typeof(p_hall -> 'entrance_wall') not in ('string', 'null')
     or jsonb_typeof(p_hall -> 'entrance_offset_cm') not in ('number', 'null')
     or jsonb_typeof(p_hall -> 'window_walls') <> 'array' then
    raise exception 'hall_plan_invalid' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_hall -> 'window_walls') w
              where jsonb_typeof(w) <> 'string')
     or exists (select 1 from jsonb_array_elements(p_tables) e
                 where jsonb_typeof(e) <> 'object') then
    raise exception 'hall_plan_invalid' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_tables) e
              where not (e ?& array['id', 'x', 'y', 'w', 'h', 'rotation', 'shape'])
                 or jsonb_typeof(e -> 'id') <> 'string'
                 or jsonb_typeof(e -> 'x') not in ('number', 'null')
                 or jsonb_typeof(e -> 'y') not in ('number', 'null')
                 or jsonb_typeof(e -> 'w') not in ('number', 'null')
                 or jsonb_typeof(e -> 'h') not in ('number', 'null')
                 or jsonb_typeof(e -> 'rotation') not in ('number', 'null')
                 or jsonb_typeof(e -> 'shape') not in ('string', 'null')
                 or (e ? 'bookable' and jsonb_typeof(e -> 'bookable') <> 'boolean')) then
    raise exception 'hall_plan_invalid' using errcode = '22023';
  end if;
  -- Combinações: nulo = não mexe; array = conjunto ativo do salão.
  if p_combinations is not null then
    if jsonb_typeof(p_combinations) <> 'array' then
      raise exception 'hall_plan_invalid' using errcode = '22023';
    end if;
    if jsonb_array_length(p_combinations) > 200
       or exists (select 1 from jsonb_array_elements(p_combinations) c
                   where jsonb_typeof(c) <> 'object') then
      raise exception 'hall_plan_invalid' using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_array_elements(p_combinations) c
                where not (c ?& array['min', 'max', 'table_ids'])
                   or jsonb_typeof(c -> 'min') <> 'number'
                   or jsonb_typeof(c -> 'max') <> 'number'
                   or jsonb_typeof(c -> 'table_ids') <> 'array') then
      raise exception 'hall_plan_invalid' using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_array_elements(p_combinations) c
                where jsonb_array_length(c -> 'table_ids') not between 2 and 12
                   or exists (select 1 from jsonb_array_elements(c -> 'table_ids') i
                               where jsonb_typeof(i) <> 'string')) then
      raise exception 'hall_plan_invalid' using errcode = '22023';
    end if;
  end if;
  begin
    v_width := (p_hall ->> 'width_cm')::integer;
    v_depth := (p_hall ->> 'depth_cm')::integer;
    v_wall := p_hall ->> 'entrance_wall';
    v_offset := (p_hall ->> 'entrance_offset_cm')::integer;
    select coalesce(array_agg(w order by o), '{}') into v_windows
      from jsonb_array_elements_text(p_hall -> 'window_walls') with ordinality as x(w, o);
    select array_agg(t.id), count(*) into v_ids, v_n
      from jsonb_to_recordset(p_tables)
        as t(id uuid, x integer, y integer, w integer, h integer, rotation smallint, shape text,
             bookable boolean);
    -- Conjuntos de mesas normalizados: ids ordenados e sem repetição.
    select coalesce(jsonb_agg(jsonb_build_object(
             'min', (c.v ->> 'min')::integer, 'max', (c.v ->> 'max')::integer,
             'n', jsonb_array_length(c.v -> 'table_ids'),
             'ids', (select to_jsonb(array_agg(distinct i::uuid order by i::uuid))
                       from jsonb_array_elements_text(c.v -> 'table_ids') i))
             order by c.o), '[]'::jsonb)
      into v_norm
      from jsonb_array_elements(coalesce(p_combinations, '[]'::jsonb)) with ordinality as c(v, o);
  exception when data_exception then
    raise exception 'hall_plan_invalid' using errcode = '22023';
  end;
  -- Mesa repetida dentro de uma combinação, ou o mesmo conjunto duas vezes.
  if exists (select 1 from jsonb_array_elements(v_norm) c
              where jsonb_array_length(c -> 'ids') <> (c ->> 'n')::integer)
     or (select count(*) from jsonb_array_elements(v_norm))
        <> (select count(distinct c -> 'ids') from jsonb_array_elements(v_norm) c) then
    raise exception 'hall_plan_invalid' using errcode = '22023';
  end if;

  -- 5. Ids distintos e todos do próprio salão e da unidade dele (visíveis pela
  -- RLS). `tables.hall_id` não tem FK composta com a unidade.
  if v_n > 0 then
    if (select count(distinct i) from unnest(v_ids) as i) <> v_n
       or (select count(*) from public.tables t
            where t.id = any (v_ids) and t.hall_id = p_hall_id and t.unit_id = v_unit) <> v_n then
      raise exception 'hall_plan_forbidden' using errcode = '42501';
    end if;
  end if;
  if exists (select 1 from jsonb_array_elements(v_norm) c,
                     jsonb_array_elements_text(c -> 'ids') as i
              where not exists (select 1 from public.tables t
                                 where t.id = i::uuid and t.hall_id = p_hall_id and t.unit_id = v_unit)) then
    raise exception 'hall_plan_forbidden' using errcode = '42501';
  end if;

  -- 6. Grava. Valores fora de faixa caem nos CHECKs (23514).
  update public.halls h
     set plan_width_cm = v_width, plan_depth_cm = v_depth, plan_entrance_wall = v_wall,
         plan_entrance_offset_cm = v_offset, plan_window_walls = v_windows
   where h.id = p_hall_id
  returning h.updated_at into v_new;

  if v_n > 0 then
    -- bookable ausente = não muda. Desligar desativa as combinações da mesa
    -- (trigger) antes de o conjunto novo ser gravado abaixo.
    update public.tables t
       set plan_x = r.x, plan_y = r.y, plan_w = r.w, plan_h = r.h,
           plan_rotation = r.rotation, plan_shape = r.shape,
           bookable = coalesce(r.bookable, t.bookable)
      from jsonb_to_recordset(p_tables)
        as r(id uuid, x integer, y integer, w integer, h integer, rotation smallint, shape text,
             bookable boolean)
     where t.id = r.id and t.hall_id = p_hall_id and t.unit_id = v_unit;
    get diagnostics v_count = row_count;
    if v_count <> v_n then
      raise exception 'hall_plan_forbidden' using errcode = '42501';
    end if;
  end if;

  if p_combinations is not null then
    -- Ativas cujo conjunto saiu do payload viram inativas; as que ficam mantêm o id.
    update public.table_combinations c set active = false
     where c.hall_id = p_hall_id and c.unit_id = v_unit and c.active
       and not exists (
         select 1 from jsonb_array_elements(v_norm) p
          where p -> 'ids' = (select to_jsonb(array_agg(m.table_id order by m.table_id))
                                from public.table_combination_members m
                               where m.combination_id = c.id));
    for v_combo in select e from jsonb_array_elements(v_norm) as e loop
      select c.id into v_combo_id
        from public.table_combinations c
       where c.hall_id = p_hall_id and c.unit_id = v_unit and c.active
         and (select to_jsonb(array_agg(m.table_id order by m.table_id))
                from public.table_combination_members m
               where m.combination_id = c.id) = v_combo.e -> 'ids'
       order by c.created_at
       limit 1;
      if found then
        update public.table_combinations c
           set min_capacity = (v_combo.e ->> 'min')::integer,
               max_capacity = (v_combo.e ->> 'max')::integer
         where c.id = v_combo_id
           and (c.min_capacity, c.max_capacity) is distinct from
               ((v_combo.e ->> 'min')::integer, (v_combo.e ->> 'max')::integer);
      else
        insert into public.table_combinations (unit_id, hall_id, min_capacity, max_capacity)
        values (v_unit, p_hall_id, (v_combo.e ->> 'min')::integer, (v_combo.e ->> 'max')::integer)
        returning id into v_combo_id;
        insert into public.table_combination_members (combination_id, table_id, unit_id)
        select v_combo_id, i::uuid, v_unit from jsonb_array_elements_text(v_combo.e -> 'ids') as i;
      end if;
    end loop;
  end if;

  perform pg_catalog.set_config('planta.strict_plan_write', 'off', true);
  return v_new;
end
$$;
comment on function public.save_hall_plan(uuid, timestamptz, jsonb, jsonb, jsonb) is
  'Salva a planta de um salão (medidas, entrada, janelas), a posição e o "disponível para reservas" (bookable, opcional) das mesas dele e, se p_combinations não for nulo, o conjunto ativo de combinações ({min, max, table_ids}: 2 a 12 mesas do salão, reserváveis; conjunto repetido recusado; combinação que sai vira inativa, a que fica mantém o id), numa transação. Owner/gerente/platform_admin da unidade do próprio salão; alheio, inexistente ou mesa de outro salão: 42501 hall_plan_forbidden; mesa não reservável ou inativa em combinação: 42501 combination_invalid. Revisão desatualizada: 40001 hall_plan_stale. Payload malformado: 22023 hall_plan_invalid. Mesa com tudo nulo sai da planta. Devolve o updated_at novo do salão.';
revoke all on function public.save_hall_plan(uuid, timestamptz, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.save_hall_plan(uuid, timestamptz, jsonb, jsonb, jsonb) to authenticated;

commit;
