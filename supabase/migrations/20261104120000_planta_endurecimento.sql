-- Planta do salão: endurecimento (pendências da B4 e achados fora do escopo do PR #67).
-- Spec: docs/superpowers/specs/2026-11-04-planta-endurecimento-design.md;
-- plano: docs/superpowers/plans/2026-11-04-planta-endurecimento.md, Task 1.
--
-- 1. `set_reservation_presence` devolve se a ação gravou (true) ou já estava
--    feita (false), para a tela não oferecer "Desfazer" de chegada alheia.
--    O tipo de retorno muda: drop + create, e revoke/grant refeitos aqui.
--    O front antigo ignora o retorno; o novo trata null (RPC antiga) como true.
-- 2. `guard_layout_write`: INSERT, UPDATE e DELETE em tables, halls e
--    hall_schedules só para owner, gerente ou platform_admin (42501
--    layout_write_forbidden). As policies `unit_member_all_*` continuam: a
--    leitura segue para qualquer membro e o trigger só aperta a escrita.
--    Nome `*_write_role_guard`: dispara depois do `*_plan_write_guard`
--    (ordem alfabética), então escrita de planta pelo operador segue
--    recusada como plan_write_forbidden.
-- 3. `guard_table_hall_unit`: tables.hall_id só aponta para salão da mesma
--    unidade, e halls.unit_id não muda com mesa, horário, bloqueio ou data
--    especial pendurados (42501 hall_unit_mismatch). Vale para todos,
--    inclusive service_role: é integridade, não papel. Nome `*_write_unit_*`:
--    dispara depois do `*_write_role_guard`, então quem não tem papel recebe
--    layout_write_forbidden antes de qualquer sinal sobre o salão (sem oráculo).
--    Produção em 2026-11-04: 0 mesas fora da regra.
-- waitlist/walk_ins.table_id já têm app_private.guard_same_unit_table.
-- Apagar unidade (cascata para halls/tables) segue só por service_role ou
-- platform_admin; como owner, a cascata rodaria o guard sem a membership.
-- Pré-voo: supabase/tests/local-preflight/82-planta-endurecimento.sql (README §82).
--
-- Rollback (migration nova, nunca edição desta): drop dos 5 triggers
-- (tables_write_role_guard, halls_write_role_guard, hall_schedules_write_role_guard,
-- tables_write_unit_hall_guard, halls_write_unit_change_guard) e das funções
-- app_private.guard_layout_write() e app_private.guard_table_hall_unit(); para a
-- RPC, drop + create com `returns void` e o mesmo revoke/grant (create or replace
-- não muda tipo de retorno: 42P13). Front publicado trata o retorno null.
begin;
set local lock_timeout = '5s';

-- ─── 1. set_reservation_presence devolve boolean ─────────────────────────────
drop function if exists public.set_reservation_presence(uuid, text);
create function public.set_reservation_presence(p_reservation_id uuid, p_action text)
returns boolean language plpgsql security invoker set search_path = '' as $$
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
    return false;
  end if;
  if p_action = 'release' then
    update public.reservations r set released_at = pg_catalog.now() where r.id = p_reservation_id;
  else
    update public.reservations r
       set arrived_at = case when p_action = 'arrive' then pg_catalog.now() end
     where r.id = p_reservation_id;
  end if;
  return true;
end
$$;
comment on function public.set_reservation_presence(uuid, text) is
  'Chegada (arrive), desfazer chegada (undo_arrive) e liberar mesa (release) de uma reserva. Não muda status nem cria linha; carimbo de presença. Devolve true se gravou e false se a ação já estava feita (o horário gravado não muda). Alheia ou inexistente: 42501 presence_forbidden.';
revoke all on function public.set_reservation_presence(uuid, text) from public, anon, authenticated;
grant execute on function public.set_reservation_presence(uuid, text) to authenticated;

-- ─── 2. Escrita de mesas, salões e horários só para gestor ───────────────────
-- Decisão de sessão igual à de app_private.guard_plan_write (20261030120000).
create or replace function app_private.guard_layout_write()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_role text := auth.role();
  v_uid uuid;
  v_old_unit uuid;
  v_new_unit uuid;
begin
  -- No JWT claims: trusted only when the session did not switch to an API role
  -- (migrations, cron). The `role` GUC survives SECURITY DEFINER.
  if v_role is null then
    if pg_catalog.current_setting('role', true) in ('anon', 'authenticated') then
      raise exception 'layout_write_forbidden' using errcode = '42501';
    end if;
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if v_role = 'service_role' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  v_uid := auth.uid();
  if v_role is distinct from 'authenticated' or v_uid is null then
    raise exception 'layout_write_forbidden' using errcode = '42501';
  end if;
  if app_private.is_platform_admin(v_uid) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_table_name = 'hall_schedules' then
    -- Sem unit_id próprio: a unidade vem do salão, antes e depois.
    if tg_op <> 'INSERT' then
      select h.unit_id into v_old_unit from public.halls h where h.id = old.hall_id;
      if not found then
        -- hall_id é NOT NULL com FK: só some na cascata do DELETE do salão,
        -- que já passou por este trigger em halls.
        if tg_op = 'DELETE' then
          return old;
        end if;
        raise exception 'layout_write_forbidden' using errcode = '42501';
      end if;
    end if;
    if tg_op <> 'DELETE' then
      select h.unit_id into v_new_unit from public.halls h where h.id = new.hall_id;
      if not found then
        raise exception 'layout_write_forbidden' using errcode = '42501';
      end if;
    end if;
  else
    if tg_op <> 'INSERT' then
      v_old_unit := old.unit_id;
    end if;
    if tg_op <> 'DELETE' then
      v_new_unit := new.unit_id;
    end if;
  end if;

  -- Both scopes: moving a row to another unit cannot evade the rule.
  if (tg_op <> 'INSERT' and not app_private.is_unit_manager(v_uid, v_old_unit))
     or (tg_op <> 'DELETE' and not app_private.is_unit_manager(v_uid, v_new_unit)) then
    raise exception 'layout_write_forbidden' using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end
$$;
comment on function app_private.guard_layout_write() is
  'Só owner, gerente ou platform_admin inserem, alteram ou apagam tables, halls e hall_schedules (42501 layout_write_forbidden), conferindo a unidade antiga e a nova; hall_schedules resolve a unidade pelo salão. service_role e sessão sem claims de papel de API passam. A leitura segue pelas policies de membro.';
revoke all on function app_private.guard_layout_write() from public, anon, authenticated, service_role;

drop trigger if exists tables_write_role_guard on public.tables;
create trigger tables_write_role_guard
  before insert or update or delete on public.tables
  for each row execute function app_private.guard_layout_write();
drop trigger if exists halls_write_role_guard on public.halls;
create trigger halls_write_role_guard
  before insert or update or delete on public.halls
  for each row execute function app_private.guard_layout_write();
drop trigger if exists hall_schedules_write_role_guard on public.hall_schedules;
create trigger hall_schedules_write_role_guard
  before insert or update or delete on public.hall_schedules
  for each row execute function app_private.guard_layout_write();

-- ─── 3. Mesa só em salão da própria unidade ──────────────────────────────────
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
          or exists (select 1 from public.special_dates d where d.hall_id = old.id)) then
    raise exception 'hall_unit_mismatch' using errcode = '42501';
  end if;
  return new;
end
$$;
comment on function app_private.guard_table_hall_unit() is
  'Recusa tables.hall_id de salão de outra unidade (ou inexistente) e mudança de halls.unit_id com mesa, horário, bloqueio ou data especial no salão: 42501 hall_unit_mismatch. Vale para todos os papéis.';
revoke all on function app_private.guard_table_hall_unit() from public, anon, authenticated, service_role;

drop trigger if exists tables_write_unit_hall_guard on public.tables;
create trigger tables_write_unit_hall_guard
  before insert or update of hall_id, unit_id on public.tables
  for each row execute function app_private.guard_table_hall_unit();
drop trigger if exists halls_write_unit_change_guard on public.halls;
create trigger halls_write_unit_change_guard
  before update of unit_id on public.halls
  for each row execute function app_private.guard_table_hall_unit();

commit;
