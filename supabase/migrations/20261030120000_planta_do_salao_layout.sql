-- Planta do salão (Parte B do redesign), passo 1: layout de mesas e salões.
-- Spec: docs/superpowers/specs/2026-10-29-redesign-salao-em-vidro-design.md §5;
-- plano: docs/superpowers/plans/2026-10-30-planta-do-salao.md, Task 1.
--
-- Aditiva e inerte: colunas nulas, nenhuma tela lê ainda. As policies
-- `unit_member_all_tables|halls` não conferem papel (o operador edita mesas e
-- salões pela API; fora do escopo). Aqui só o LAYOUT ganha regra de papel:
-- o trigger `guard_plan_write` recusa mudança em `plan_*` de quem não é owner,
-- gerente ou platform_admin. Escrita sem `plan_*` passa como hoje.
--
-- `save_hall_plan` é SECURITY INVOKER sobre a RLS existente. Em produção
-- `authenticated` não tem USAGE em `app_private` (medido em 2026-10-30), então
-- a RPC não chama helper de lá: o portão de papel é o trigger (definer). A RPC
-- liga o GUC local `planta.strict_plan_write`, que faz o trigger exigir papel
-- mesmo quando a planta enviada é igual à gravada. O GUC só aperta: quem o
-- liga por conta própria só se recusa mais.
-- Pré-voo: supabase/tests/local-preflight/81-planta-do-salao.sql (README §81).
begin;
set local lock_timeout = '5s';

-- ─── Colunas e CHECKs ────────────────────────────────────────────────────────
-- Centímetros. (plan_x, plan_y) é o centro da mesa.
alter table public.tables
  add column if not exists plan_x integer,
  add column if not exists plan_y integer,
  add column if not exists plan_w integer,
  add column if not exists plan_h integer,
  add column if not exists plan_rotation smallint,
  add column if not exists plan_shape text;

alter table public.tables drop constraint if exists tables_plan_all_or_none;
alter table public.tables add constraint tables_plan_all_or_none check (
  num_nulls(plan_x, plan_y, plan_w, plan_h, plan_rotation, plan_shape) in (0, 6));
alter table public.tables drop constraint if exists tables_plan_values;
alter table public.tables add constraint tables_plan_values check (
  (plan_x between 0 and 5000) and (plan_y between 0 and 5000)
  and (plan_w between 30 and 600) and (plan_h between 30 and 600)
  and (plan_rotation between 0 and 359)
  and plan_shape in ('round', 'square', 'rect')
  and (plan_shape = 'rect' or plan_w = plan_h));

alter table public.halls
  add column if not exists plan_width_cm integer,
  add column if not exists plan_depth_cm integer,
  add column if not exists plan_entrance_wall text,
  add column if not exists plan_entrance_offset_cm integer,
  add column if not exists plan_window_walls text[] not null default '{}';

alter table public.halls drop constraint if exists halls_plan_dims;
-- num_nulls: CHECK com NULL passa, e `between 200 and null` deixaria meia planta.
alter table public.halls add constraint halls_plan_dims check (
  num_nulls(plan_width_cm, plan_depth_cm) in (0, 2)
  and (plan_width_cm is null or (plan_width_cm between 200 and 5000 and plan_depth_cm between 200 and 5000)));
alter table public.halls drop constraint if exists halls_plan_entrance;
alter table public.halls add constraint halls_plan_entrance check (
  num_nulls(plan_entrance_wall, plan_entrance_offset_cm) in (0, 2)
  and (plan_entrance_wall is null
       or (plan_entrance_wall in ('top', 'right', 'bottom', 'left') and plan_entrance_offset_cm >= 0)));
alter table public.halls drop constraint if exists halls_plan_windows;
alter table public.halls add constraint halls_plan_windows check (
  plan_window_walls <@ array['top', 'right', 'bottom', 'left']);

-- ─── Papel de gestor ─────────────────────────────────────────────────────────
create or replace function app_private.is_unit_manager(p_user_id uuid, p_unit_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.unit_members m
     where m.user_id = p_user_id and m.unit_id = p_unit_id and m.role in ('owner', 'gerente'))
$$;
comment on function app_private.is_unit_manager(uuid, uuid) is
  'Verdadeiro se a pessoa é owner ou gerente da unidade. Não inclui platform_admin: quem chama faz o OR com app_private.is_platform_admin.';
-- Sem grant: só o guard_plan_write (definer, roda como dono) chama; nenhuma policy usa.
revoke all on function app_private.is_unit_manager(uuid, uuid) from public, anon, authenticated, service_role;

-- ─── Trigger de papel nas colunas plan_* ─────────────────────────────────────
-- Molde: app_private.guard_unit_setting_write() (20261019180000).
create or replace function app_private.guard_plan_write()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_role text := auth.role();
  v_uid uuid;
  v_changed boolean;
  v_strict boolean := coalesce(pg_catalog.current_setting('planta.strict_plan_write', true), '') = 'on';
begin
  if tg_table_name = 'tables' then
    if tg_op = 'INSERT' then
      v_changed := num_nonnulls(new.plan_x, new.plan_y, new.plan_w, new.plan_h,
                                new.plan_rotation, new.plan_shape) > 0;
    else
      v_changed := (old.plan_x, old.plan_y, old.plan_w, old.plan_h, old.plan_rotation, old.plan_shape)
        is distinct from (new.plan_x, new.plan_y, new.plan_w, new.plan_h, new.plan_rotation, new.plan_shape);
    end if;
  else
    if tg_op = 'INSERT' then
      v_changed := num_nonnulls(new.plan_width_cm, new.plan_depth_cm, new.plan_entrance_wall,
                                new.plan_entrance_offset_cm) > 0
                   or coalesce(cardinality(new.plan_window_walls), 0) > 0;
    else
      v_changed := (old.plan_width_cm, old.plan_depth_cm, old.plan_entrance_wall,
                    old.plan_entrance_offset_cm, old.plan_window_walls)
        is distinct from (new.plan_width_cm, new.plan_depth_cm, new.plan_entrance_wall,
                          new.plan_entrance_offset_cm, new.plan_window_walls);
    end if;
  end if;
  if not v_changed and not v_strict then
    return new;
  end if;

  -- No JWT claims: trusted only when the session did not switch to an API role
  -- (migrations, cron). The `role` GUC survives SECURITY DEFINER.
  if v_role is null then
    if pg_catalog.current_setting('role', true) in ('anon', 'authenticated') then
      raise exception 'plan_write_forbidden' using errcode = '42501';
    end if;
    return new;
  end if;
  if v_role = 'service_role' then
    return new;
  end if;

  v_uid := auth.uid();
  if v_role is distinct from 'authenticated' or v_uid is null then
    raise exception 'plan_write_forbidden' using errcode = '42501';
  end if;
  if app_private.is_platform_admin(v_uid) then
    return new;
  end if;
  -- Both scopes: moving a row to another unit cannot evade the rule.
  if (tg_op = 'UPDATE' and not app_private.is_unit_manager(v_uid, old.unit_id))
     or not app_private.is_unit_manager(v_uid, new.unit_id) then
    raise exception 'plan_write_forbidden' using errcode = '42501';
  end if;
  return new;
end
$$;
comment on function app_private.guard_plan_write() is
  'Só owner, gerente ou platform_admin mudam as colunas plan_* de tables/halls (42501 plan_write_forbidden); service_role e sessão sem claims de papel de API passam. Com o GUC local planta.strict_plan_write = on (save_hall_plan), exige o papel mesmo sem mudança.';
revoke all on function app_private.guard_plan_write() from public, anon, authenticated, service_role;

drop trigger if exists tables_plan_write_guard on public.tables;
create trigger tables_plan_write_guard
  before insert or update on public.tables
  for each row execute function app_private.guard_plan_write();
drop trigger if exists halls_plan_write_guard on public.halls;
create trigger halls_plan_write_guard
  before insert or update on public.halls
  for each row execute function app_private.guard_plan_write();

-- ─── save_hall_plan ──────────────────────────────────────────────────────────
create or replace function public.save_hall_plan(
  p_hall_id uuid, p_expected_updated_at timestamptz, p_hall jsonb, p_tables jsonb)
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
                 or jsonb_typeof(e -> 'shape') not in ('string', 'null')) then
    raise exception 'hall_plan_invalid' using errcode = '22023';
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
        as t(id uuid, x integer, y integer, w integer, h integer, rotation smallint, shape text);
  exception when data_exception then
    raise exception 'hall_plan_invalid' using errcode = '22023';
  end;

  -- 5. Ids distintos e todos do próprio salão e da unidade dele (visíveis pela
  -- RLS). `tables.hall_id` não tem FK composta com a unidade.
  if v_n > 0 then
    if (select count(distinct i) from unnest(v_ids) as i) <> v_n
       or (select count(*) from public.tables t
            where t.id = any (v_ids) and t.hall_id = p_hall_id and t.unit_id = v_unit) <> v_n then
      raise exception 'hall_plan_forbidden' using errcode = '42501';
    end if;
  end if;

  -- 6. Grava. Valores fora de faixa caem nos CHECKs (23514).
  update public.halls h
     set plan_width_cm = v_width, plan_depth_cm = v_depth, plan_entrance_wall = v_wall,
         plan_entrance_offset_cm = v_offset, plan_window_walls = v_windows
   where h.id = p_hall_id
  returning h.updated_at into v_new;

  if v_n > 0 then
    update public.tables t
       set plan_x = r.x, plan_y = r.y, plan_w = r.w, plan_h = r.h,
           plan_rotation = r.rotation, plan_shape = r.shape
      from jsonb_to_recordset(p_tables)
        as r(id uuid, x integer, y integer, w integer, h integer, rotation smallint, shape text)
     where t.id = r.id and t.hall_id = p_hall_id and t.unit_id = v_unit;
    get diagnostics v_count = row_count;
    if v_count <> v_n then
      raise exception 'hall_plan_forbidden' using errcode = '42501';
    end if;
  end if;

  perform pg_catalog.set_config('planta.strict_plan_write', 'off', true);
  return v_new;
end
$$;
comment on function public.save_hall_plan(uuid, timestamptz, jsonb, jsonb) is
  'Salva a planta de um salão (medidas, entrada, janelas) e a posição das mesas dele, numa transação. Owner/gerente/platform_admin da unidade do próprio salão; alheio, inexistente ou mesa de outro salão: 42501 hall_plan_forbidden. Revisão desatualizada: 40001 hall_plan_stale. Payload malformado: 22023 hall_plan_invalid. Mesa com tudo nulo sai da planta. Devolve o updated_at novo do salão.';
revoke all on function public.save_hall_plan(uuid, timestamptz, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.save_hall_plan(uuid, timestamptz, jsonb, jsonb) to authenticated;

commit;
