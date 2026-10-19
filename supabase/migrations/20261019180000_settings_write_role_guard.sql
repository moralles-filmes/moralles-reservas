-- `unit_member_all_settings` lets any unit member (operador included) write any
-- key of the unit, including `ai_config` (provider/model, i.e. cost) and the
-- agent prompt keys. This trigger adds the role-per-key rule on top of the
-- unchanged tenant policies: owner/gerente write only the keys the Gestão uses
-- (`manager`), every other key (unknown included) is platform_admin only.
-- Spec: docs/superpowers/specs/2026-10-19-settings-escrita-por-chave-design.md.
begin;
-- `drop trigger` takes ACCESS EXCLUSIVE on a table every worker reads: fail
-- fast instead of queueing reads behind a long transaction.
set local lock_timeout = '5s';

-- Keep in sync with scripts/settings-write-acl.test.ts (Gestão writers).
create or replace function app_private.unit_setting_write_class(p_key text)
returns text language sql immutable set search_path = '' as $$
  select case when p_key = any (array[
    'reservation_duration_minutes','booking_window_days','reservation_tolerance_minutes',
    'rules_and_conditions','additional_info','reminder_d1_enabled','survey_d1_enabled',
    'waitlist_qr_enabled','waitlist_menu_link_enabled','waitlist_priority_enabled',
    'waitlist_code_min','waitlist_code_max','waitlist_tolerance_minutes',
    'waitlist_remote_entry_enabled','waitlist_remote_entry_limit',
    'waitlist_entered_enabled','waitlist_feedback_enabled',
    'giftback_whatsapp_enabled','giftback_email_enabled','giftback_message_template',
    'allow_overbooking','restaurant_name'
  ]::text[]) then 'manager' else 'platform' end
$$;

create or replace function app_private.guard_unit_setting_write()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_role text := auth.role();
  v_uid uuid;
begin
  -- No JWT claims: trusted only when the session did not switch to an API role
  -- (migrations, cron). The `role` GUC survives SECURITY DEFINER.
  if v_role is null then
    if pg_catalog.current_setting('role', true) in ('anon', 'authenticated') then
      raise exception 'setting_write_forbidden' using errcode = '42501';
    end if;
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if v_role = 'service_role' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  v_uid := auth.uid();
  if v_role is distinct from 'authenticated' or v_uid is null then
    raise exception 'setting_write_forbidden' using errcode = '42501';
  end if;

  if app_private.is_platform_admin(v_uid) then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  -- Both scopes: changing `key` or `unit_id` in an UPDATE cannot evade the rule.
  if tg_op in ('UPDATE', 'DELETE') and (
       app_private.unit_setting_write_class(old.key) <> 'manager'
       or not exists (select 1 from public.unit_members m
                       where m.user_id = v_uid and m.unit_id = old.unit_id
                         and m.role in ('owner', 'gerente'))) then
    raise exception 'setting_write_forbidden' using errcode = '42501';
  end if;
  if tg_op in ('INSERT', 'UPDATE') and (
       app_private.unit_setting_write_class(new.key) <> 'manager'
       or not exists (select 1 from public.unit_members m
                       where m.user_id = v_uid and m.unit_id = new.unit_id
                         and m.role in ('owner', 'gerente'))) then
    raise exception 'setting_write_forbidden' using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;

revoke all on function app_private.unit_setting_write_class(text) from public, anon, authenticated, service_role;
revoke all on function app_private.guard_unit_setting_write() from public, anon, authenticated, service_role;

drop trigger if exists settings_write_role_guard on public.settings;
create trigger settings_write_role_guard
  before insert or update or delete on public.settings
  for each row execute function app_private.guard_unit_setting_write();

-- anon never writes settings (the public portal reads through SECURITY DEFINER
-- RPCs). A table-level REVOKE also clears column grants (measured on PG 18);
-- the per-column revoke below is belt-and-braces, as in 20261017160000.
revoke insert, update, delete, truncate on table public.settings from anon;
do $$
declare v_columns text;
begin
  select string_agg(format('%I', a.attname), ', ' order by a.attnum)
    into v_columns
    from pg_catalog.pg_attribute a
    where a.attrelid = 'public.settings'::pg_catalog.regclass
      and a.attnum > 0 and not a.attisdropped;
  execute format('revoke update (%s) on table public.settings from anon', v_columns);
  execute format('revoke insert (%s) on table public.settings from anon', v_columns);
end $$;
-- TRUNCATE bypasses RLS and row triggers; no client uses it.
revoke truncate on table public.settings from public, authenticated;

commit;
