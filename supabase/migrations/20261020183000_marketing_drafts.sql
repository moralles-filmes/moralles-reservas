-- MARKETING is a draft-only store workspace. No row here authorizes dispatch.
-- The file is atomic: no table/function is exposed between CREATE and REVOKE.
begin;
create unique index if not exists voucher_rules_id_unit_marketing_idx
  on public.voucher_rules(id, unit_id);

create table if not exists public.marketing_campaign_drafts (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references public.units(id) on delete cascade,
  program text not null check (program in ('birthday_voucher', 'frequency_voucher', 'waitlist_feedback')),
  voucher_rule_id uuid,
  voucher_rule_name text,
  title text not null check (char_length(title) between 1 and 120 and title = btrim(title)),
  start_date date,
  end_date date,
  proposed_daily_contacts integer check (proposed_daily_contacts between 1 and 100000),
  proposed_daily_messages integer check (proposed_daily_messages between 1 and 100000),
  status text not null default 'draft' check (status in ('draft', 'archived')),
  revision bigint not null default 1 check (revision > 0),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint marketing_drafts_rule_unit_fk foreign key (voucher_rule_id, unit_id)
    references public.voucher_rules(id, unit_id) on delete set null (voucher_rule_id),
  constraint marketing_drafts_program_rule_check check (
    program <> 'waitlist_feedback' or voucher_rule_id is null
  ),
  constraint marketing_drafts_dates_check check (start_date is null or end_date is null or end_date >= start_date)
);
create unique index if not exists marketing_drafts_voucher_current_idx
  on public.marketing_campaign_drafts(unit_id, program, voucher_rule_id)
  where status = 'draft' and voucher_rule_id is not null;
create unique index if not exists marketing_drafts_waitlist_current_idx
  on public.marketing_campaign_drafts(unit_id, program)
  where status = 'draft' and program = 'waitlist_feedback';
create index if not exists marketing_drafts_unit_updated_idx
  on public.marketing_campaign_drafts(unit_id, updated_at desc);
alter table public.marketing_campaign_drafts enable row level security;
alter table public.marketing_campaign_drafts force row level security;
revoke all on public.marketing_campaign_drafts from public, anon, authenticated, service_role;

create or replace function app_private.check_marketing_draft_rule()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_kind text;
begin
  if new.voucher_rule_id is null then return new; end if;
  select r.trigger_type into v_kind from public.voucher_rules r
    where r.id = new.voucher_rule_id and r.unit_id = new.unit_id for share;
  if v_kind is null or (new.program = 'birthday_voucher' and v_kind <> 'birthday')
     or (new.program = 'frequency_voucher' and v_kind <> 'frequency')
     or new.program = 'waitlist_feedback' then
    raise exception 'invalid marketing rule' using errcode = '22023';
  end if;
  return new;
end;
$$;
revoke all on function app_private.check_marketing_draft_rule() from public, anon, authenticated, service_role;
create or replace trigger check_marketing_draft_rule before insert or update of unit_id, program, voucher_rule_id
  on public.marketing_campaign_drafts for each row execute function app_private.check_marketing_draft_rule();

create or replace function public.get_marketing_drafts(p_unit_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_actor uuid := auth.uid();
begin
  if auth.role() is distinct from 'authenticated' or v_actor is null or p_unit_id is null
     or not (app_private.is_platform_admin(v_actor) or exists (
       select 1 from public.unit_members m where m.user_id = v_actor and m.unit_id = p_unit_id
         and m.role in ('owner', 'gerente')
     )) or not exists (select 1 from public.units u where u.id = p_unit_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'drafts', coalesce((select jsonb_agg(jsonb_build_object(
      'id', d.id, 'unit_id', d.unit_id, 'program', d.program,
      'voucher_rule_id', d.voucher_rule_id, 'voucher_rule_name', d.voucher_rule_name,
      'title', d.title, 'start_date', d.start_date, 'end_date', d.end_date,
      'proposed_daily_contacts', d.proposed_daily_contacts,
      'proposed_daily_messages', d.proposed_daily_messages, 'status', d.status,
      'revision', d.revision, 'updated_at', d.updated_at
    ) order by d.updated_at desc) from public.marketing_campaign_drafts d where d.unit_id = p_unit_id), '[]'::jsonb),
    'rules', coalesce((select jsonb_agg(jsonb_build_object(
      'id', r.id, 'name', r.name, 'trigger_type', r.trigger_type, 'active', r.active
    ) order by r.name, r.id) from public.voucher_rules r
      where r.unit_id = p_unit_id and r.trigger_type in ('birthday', 'frequency')), '[]'::jsonb)
  );
end;
$$;
revoke all on function public.get_marketing_drafts(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_marketing_drafts(uuid) to authenticated;

create or replace function public.save_marketing_draft(
  p_unit_id uuid, p_draft_id uuid, p_expected_revision bigint, p_program text,
  p_voucher_rule_id uuid, p_title text, p_start_date date, p_end_date date,
  p_proposed_daily_contacts integer, p_proposed_daily_messages integer
) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_authorized boolean := false;
  v_row public.marketing_campaign_drafts%rowtype;
  v_rule public.voucher_rules%rowtype;
  v_title text := btrim(p_title);
begin
  if auth.role() is distinct from 'authenticated' or v_actor is null
     or app_private.is_platform_admin(v_actor) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_draft_id is not null then
    select * into v_row from public.marketing_campaign_drafts where id = p_draft_id for update;
    if v_row.id is null or v_row.unit_id is distinct from p_unit_id then
      raise exception 'forbidden' using errcode = '42501';
    end if;
  end if;
  -- Hold the membership row through commit so a concurrent revocation cannot
  -- overtake authorization between this check and the draft write.
  select true into v_authorized from public.units u
    join public.unit_members m on m.unit_id = u.id
    where u.id = p_unit_id and m.user_id = v_actor and m.role = 'owner'
    for share of m;
  if not coalesce(v_authorized, false) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_program is null or p_program not in ('birthday_voucher', 'frequency_voucher', 'waitlist_feedback')
     or v_title is null or char_length(v_title) not between 1 and 120
     or (p_start_date is not null and p_end_date is not null and p_end_date < p_start_date)
     or (p_proposed_daily_contacts is not null and p_proposed_daily_contacts not between 1 and 100000)
     or (p_proposed_daily_messages is not null and p_proposed_daily_messages not between 1 and 100000)
     or (p_program = 'waitlist_feedback' and p_voucher_rule_id is not null)
     or (p_program <> 'waitlist_feedback' and p_voucher_rule_id is null) then
    raise exception 'invalid marketing draft' using errcode = '22023';
  end if;
  if p_voucher_rule_id is not null then
    select * into v_rule from public.voucher_rules r
      where r.id = p_voucher_rule_id and r.unit_id = p_unit_id for share;
    if v_rule.id is null or (p_program = 'birthday_voucher' and v_rule.trigger_type <> 'birthday')
       or (p_program = 'frequency_voucher' and v_rule.trigger_type <> 'frequency') then
      raise exception 'invalid marketing rule' using errcode = '22023';
    end if;
  end if;
  if p_draft_id is null then
    if p_expected_revision is not null then
      raise exception 'stale marketing draft' using errcode = '40001';
    end if;
    insert into public.marketing_campaign_drafts(
      unit_id, program, voucher_rule_id, voucher_rule_name, title, start_date, end_date,
      proposed_daily_contacts, proposed_daily_messages, created_by, updated_by
    ) values (
      p_unit_id, p_program, p_voucher_rule_id, v_rule.name, v_title, p_start_date, p_end_date,
      p_proposed_daily_contacts, p_proposed_daily_messages, v_actor, v_actor
    ) returning * into v_row;
    insert into public.audit_log(table_name, record_id, action, new_values, actor_id, unit_id)
      values ('marketing_campaign_drafts', v_row.id::text, 'INSERT',
        jsonb_build_object('program', v_row.program, 'status', v_row.status, 'revision', v_row.revision),
        v_actor, p_unit_id);
  else
    if v_row.status <> 'draft' or p_expected_revision is distinct from v_row.revision then
      raise exception 'stale marketing draft' using errcode = '40001';
    end if;
    update public.marketing_campaign_drafts set program = p_program, voucher_rule_id = p_voucher_rule_id,
      voucher_rule_name = v_rule.name, title = v_title, start_date = p_start_date, end_date = p_end_date,
      proposed_daily_contacts = p_proposed_daily_contacts,
      proposed_daily_messages = p_proposed_daily_messages, revision = revision + 1,
      updated_by = v_actor, updated_at = now() where id = p_draft_id returning * into v_row;
    insert into public.audit_log(table_name, record_id, action, new_values, actor_id, unit_id)
      values ('marketing_campaign_drafts', v_row.id::text, 'UPDATE',
        jsonb_build_object('program', v_row.program, 'status', v_row.status, 'revision', v_row.revision),
        v_actor, p_unit_id);
  end if;
  return jsonb_build_object(
    'id', v_row.id, 'unit_id', v_row.unit_id, 'program', v_row.program,
    'voucher_rule_id', v_row.voucher_rule_id, 'voucher_rule_name', v_row.voucher_rule_name,
    'title', v_row.title, 'start_date', v_row.start_date, 'end_date', v_row.end_date,
    'proposed_daily_contacts', v_row.proposed_daily_contacts,
    'proposed_daily_messages', v_row.proposed_daily_messages, 'status', v_row.status,
    'revision', v_row.revision, 'updated_at', v_row.updated_at
  );
end;
$$;
revoke all on function public.save_marketing_draft(uuid,uuid,bigint,text,uuid,text,date,date,integer,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.save_marketing_draft(uuid,uuid,bigint,text,uuid,text,date,date,integer,integer)
  to authenticated;

create or replace function public.archive_marketing_draft(p_draft_id uuid, p_expected_revision bigint)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_actor uuid := auth.uid(); v_row public.marketing_campaign_drafts%rowtype;
  v_authorized boolean := false;
begin
  if auth.role() is distinct from 'authenticated' or v_actor is null
     or app_private.is_platform_admin(v_actor) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_row from public.marketing_campaign_drafts where id = p_draft_id for update;
  select true into v_authorized from public.unit_members m
    where m.user_id = v_actor and m.unit_id = v_row.unit_id and m.role = 'owner'
    for share of m;
  if v_row.id is null or not coalesce(v_authorized, false) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_row.status <> 'draft' or p_expected_revision is distinct from v_row.revision then
    raise exception 'stale marketing draft' using errcode = '40001';
  end if;
  update public.marketing_campaign_drafts set status = 'archived', revision = revision + 1,
    updated_by = v_actor, updated_at = now() where id = v_row.id returning * into v_row;
  insert into public.audit_log(table_name, record_id, action, new_values, actor_id, unit_id)
    values ('marketing_campaign_drafts', v_row.id::text, 'UPDATE',
      jsonb_build_object('program', v_row.program, 'status', v_row.status, 'revision', v_row.revision),
      v_actor, v_row.unit_id);
  return jsonb_build_object(
    'id', v_row.id, 'unit_id', v_row.unit_id, 'program', v_row.program,
    'voucher_rule_id', v_row.voucher_rule_id, 'voucher_rule_name', v_row.voucher_rule_name,
    'title', v_row.title, 'start_date', v_row.start_date, 'end_date', v_row.end_date,
    'proposed_daily_contacts', v_row.proposed_daily_contacts,
    'proposed_daily_messages', v_row.proposed_daily_messages, 'status', v_row.status,
    'revision', v_row.revision, 'updated_at', v_row.updated_at
  );
end;
$$;
revoke all on function public.archive_marketing_draft(uuid,bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.archive_marketing_draft(uuid,bigint) to authenticated;
commit;
