-- Isolated PostgreSQL fixture for the two real MARKETING migrations. Run in a new DB.
\set ON_ERROR_STOP on
do $$ begin
  if not exists(select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists(select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists(select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
grant anon, authenticated, service_role to postgres;
create schema auth;
create schema app_private;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
create function auth.role() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claim.role', true), '')
$$;
grant usage on schema auth to authenticated, anon, service_role;
grant execute on function auth.uid() to authenticated, anon, service_role;
grant execute on function auth.role() to authenticated, anon, service_role;
create table public.units(id uuid primary key);
create table public.unit_members(user_id uuid references auth.users(id), unit_id uuid references public.units(id), role text);
create table public.platform_admins(user_id uuid primary key references auth.users(id));
create function app_private.is_platform_admin(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.platform_admins where user_id = p_user)
$$;
create table public.audit_log(id bigserial primary key, table_name text not null, record_id text not null,
  action text not null, new_values jsonb, actor_id uuid, unit_id uuid);
create table public.voucher_rules(id uuid primary key, unit_id uuid not null references public.units(id),
  name text not null, trigger_type text not null, active boolean not null default true);
create table public.vouchers(id uuid primary key default gen_random_uuid(), unit_id uuid not null,
  rule_id uuid references public.voucher_rules(id) on delete set null, issued_at timestamptz not null,
  used_at timestamptz);
create table public.whatsapp_automation_jobs(id uuid primary key default gen_random_uuid(), unit_id uuid not null,
  kind text not null, voucher_id uuid, notification_id uuid not null default gen_random_uuid(),
  state text not null, provider text, transport text default 'template', channel_id uuid,
  provider_message_id text, fact_at timestamptz not null);
create table public.whatsapp_automation_receipt_events(id uuid primary key default gen_random_uuid(),
  unit_id uuid not null, provider text not null, channel_id uuid not null,
  provider_message_id text not null, processing_state text not null, status text not null);
create table public.notifications_sent(id uuid primary key, unit_id uuid not null, kind text not null,
  status text not null, sent_at timestamptz not null, failed_at timestamptz, provider_message_id text,
  whatsapp_provider text, whatsapp_channel_id uuid);

insert into auth.users(id) values
  ('00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000002'),
  ('00000000-0000-4000-8000-000000000003'),
  ('00000000-0000-4000-8000-000000000004'),
  ('00000000-0000-4000-8000-000000000005');
insert into public.units(id) values
  ('10000000-0000-4000-8000-000000000001'), ('10000000-0000-4000-8000-000000000002');
insert into public.unit_members(user_id, unit_id, role) values
  ('00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','owner'),
  ('00000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','gerente'),
  ('00000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001','operador'),
  ('00000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000002','owner'),
  ('00000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000001','owner');
insert into public.platform_admins(user_id) values ('00000000-0000-4000-8000-000000000005');
insert into public.voucher_rules(id,unit_id,name,trigger_type) values
  ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Aniversário','birthday'),
  ('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','Fidelidade','frequency'),
  ('20000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000002','Alheia','birthday');

-- Reproduce Supabase's historically permissive default ACL for new public objects.
alter default privileges for role postgres in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant execute on functions to anon, authenticated, service_role;

\i supabase/migrations/20261020183000_marketing_drafts.sql
\i supabase/migrations/20261020184000_marketing_results.sql
-- Reapplying must preserve schema, ACL and behavior.
\i supabase/migrations/20261020183000_marketing_drafts.sql
\i supabase/migrations/20261020184000_marketing_results.sql

-- No raw table access or function execution for anonymous/service role.
do $$ begin
  if has_table_privilege('authenticated', 'public.marketing_campaign_drafts', 'SELECT')
    or has_table_privilege('service_role', 'public.marketing_campaign_drafts', 'SELECT')
    or has_function_privilege('anon', 'public.get_marketing_drafts(uuid)', 'EXECUTE')
    or has_function_privilege('service_role', 'public.get_marketing_results(uuid,date,date)', 'EXECUTE')
    or not has_function_privilege('authenticated', 'public.save_marketing_draft(uuid,uuid,bigint,text,uuid,text,date,date,integer,integer)', 'EXECUTE') then
    raise exception 'MARKETING ACL mismatch';
  end if;
  if not (select relrowsecurity and relforcerowsecurity from pg_class
      where oid = 'public.marketing_campaign_drafts'::regclass) then
    raise exception 'MARKETING RLS not forced';
  end if;
  if exists(select 1 from pg_policies where schemaname = 'public' and tablename = 'marketing_campaign_drafts') then
    raise exception 'unexpected direct MARKETING policy';
  end if;
end $$;

set role authenticated;
select set_config('request.jwt.claim.role','authenticated',false);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',false);
do $$ declare x jsonb; v_id uuid; v_denied boolean;
begin
  x := public.save_marketing_draft('10000000-0000-4000-8000-000000000001',null,null,
    'birthday_voucher','20000000-0000-4000-8000-000000000001','Aniversário',null,null,100,100);
  v_id := (x->>'id')::uuid;
  if x->>'status' is distinct from 'draft' or (x->>'revision')::bigint is distinct from 1 then raise exception 'save failed'; end if;
  if jsonb_array_length(public.get_marketing_drafts('10000000-0000-4000-8000-000000000001')->'rules') is distinct from 2 then
    raise exception 'wrong rules'; end if;
  v_denied := false;
  begin
    perform public.save_marketing_draft('10000000-0000-4000-8000-000000000001',null,null,
      'birthday_voucher','20000000-0000-4000-8000-000000000003','Alheia',null,null,null,null);
  exception when sqlstate '22023' then v_denied := true; end;
  if not v_denied then raise exception 'foreign rule accepted'; end if;
  v_denied := false;
  begin
    perform public.save_marketing_draft('10000000-0000-4000-8000-000000000001',null,null,
      'birthday_voucher','20000000-0000-4000-8000-000000000002','Gatilho errado',null,null,null,null);
  exception when sqlstate '22023' then v_denied := true; end;
  if not v_denied then raise exception 'wrong trigger accepted'; end if;
  v_denied := false;
  begin
    perform public.save_marketing_draft('10000000-0000-4000-8000-000000000001',v_id,0,
      'birthday_voucher','20000000-0000-4000-8000-000000000001','Aniversário',null,null,null,null);
  exception when sqlstate '40001' then v_denied := true; end;
  if not v_denied then raise exception 'stale CAS accepted'; end if;
  x := public.save_marketing_draft('10000000-0000-4000-8000-000000000001',null,null,
    'waitlist_feedback',null,'Pesquisa',null,null,null,null);
  v_denied := false;
  begin
    perform public.save_marketing_draft('10000000-0000-4000-8000-000000000001',null,null,
      'waitlist_feedback',null,'Pesquisa 2',null,null,null,null);
  exception when unique_violation then v_denied := true; end;
  if not v_denied then raise exception 'NULL waitlist dedupe failed'; end if;
  perform public.get_marketing_results('10000000-0000-4000-8000-000000000001',
    (now() at time zone 'America/Sao_Paulo')::date - 365,
    (now() at time zone 'America/Sao_Paulo')::date);
  v_denied := false;
  begin perform public.get_marketing_results('10000000-0000-4000-8000-000000000001',
    (now() at time zone 'America/Sao_Paulo')::date - 366,
    (now() at time zone 'America/Sao_Paulo')::date);
  exception when sqlstate '22023' then v_denied := true; end;
  if not v_denied then raise exception 'oversize marketing period accepted'; end if;
end $$;

-- Manager may read, but cannot mutate; operator and another unit cannot read.
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',false);
do $$ declare v_denied boolean := false;
begin
  if jsonb_array_length(public.get_marketing_drafts('10000000-0000-4000-8000-000000000001')->'drafts') is distinct from 2 then
    raise exception 'manager read failed'; end if;
  begin perform public.save_marketing_draft('10000000-0000-4000-8000-000000000001',null,null,
    'waitlist_feedback',null,'X',null,null,null,null);
  exception when sqlstate '42501' then v_denied := true; end;
  if not v_denied then raise exception 'manager write accepted'; end if;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000003',false);
do $$ declare v_denied boolean := false;
begin
  begin perform public.get_marketing_drafts('10000000-0000-4000-8000-000000000001');
  exception when sqlstate '42501' then v_denied := true; end;
  if not v_denied then raise exception 'operator read accepted'; end if;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000004',false);
do $$ declare v_denied boolean := false;
begin
  begin perform public.get_marketing_results('10000000-0000-4000-8000-000000000001',
    (now() at time zone 'America/Sao_Paulo')::date,(now() at time zone 'America/Sao_Paulo')::date);
  exception when sqlstate '42501' then v_denied := true; end;
  if not v_denied then raise exception 'cross-unit read accepted'; end if;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000005',false);
do $$ declare v_denied boolean := false; v_draft jsonb;
begin
  if jsonb_array_length(public.get_marketing_drafts('10000000-0000-4000-8000-000000000001')->'drafts') is distinct from 2 then
    raise exception 'platform read failed'; end if;
  begin perform public.save_marketing_draft('10000000-0000-4000-8000-000000000001',null,null,
    'waitlist_feedback',null,'Admin não edita',null,null,null,null);
  exception when sqlstate '42501' then v_denied := true; end;
  if not v_denied then raise exception 'platform admin write accepted'; end if;
  v_draft := public.get_marketing_drafts('10000000-0000-4000-8000-000000000001')->'drafts'->0;
  v_denied := false;
  begin perform public.archive_marketing_draft((v_draft->>'id')::uuid,(v_draft->>'revision')::bigint);
  exception when sqlstate '42501' then v_denied := true; end;
  if not v_denied then raise exception 'platform admin archive accepted'; end if;
end $$;
reset role;

-- Revoked membership must immediately remove query access.
delete from public.unit_members where user_id = '00000000-0000-4000-8000-000000000002';
set role authenticated;
select set_config('request.jwt.claim.role','authenticated',false);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',false);
do $$ declare v_denied boolean := false;
begin
  begin perform public.get_marketing_drafts('10000000-0000-4000-8000-000000000001');
  exception when sqlstate '42501' then v_denied := true; end;
  if not v_denied then raise exception 'revoked member read accepted'; end if;
end $$;
reset role;

-- More than 5,000 vouchers must aggregate without a client/PostgREST cap.
insert into public.vouchers(unit_id,rule_id,issued_at)
select '10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',now()
from generate_series(1,5001);
insert into public.vouchers(unit_id,rule_id,issued_at)
values ('10000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000003',now());
insert into public.vouchers(unit_id,rule_id,issued_at)
values ('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',
  (((now() at time zone 'America/Sao_Paulo')::date)::text || 'T00:00:00-03:00')::timestamptz - interval '1 second');
insert into public.whatsapp_automation_jobs(unit_id,kind,state,provider,channel_id,provider_message_id,fact_at)
values ('10000000-0000-4000-8000-000000000001','waitlist_feedback','accepted','official',
  '30000000-0000-4000-8000-000000000001','remote-message',now());
insert into public.whatsapp_automation_jobs(unit_id,kind,state,provider,channel_id,provider_message_id,fact_at)
values ('10000000-0000-4000-8000-000000000001','waitlist_feedback','reconciled','official',
  '30000000-0000-4000-8000-000000000001','failed-managed',now());
insert into public.whatsapp_automation_jobs(unit_id,kind,state,provider,transport,channel_id,provider_message_id,fact_at)
values ('10000000-0000-4000-8000-000000000001','waitlist_feedback','accepted','zapi','text',
  '30000000-0000-4000-8000-000000000002','text-managed',now());
insert into public.whatsapp_automation_jobs(unit_id,kind,state,provider,transport,channel_id,fact_at)
values ('10000000-0000-4000-8000-000000000001','waitlist_feedback','blocked',null,null,null,now());
insert into public.whatsapp_automation_jobs(unit_id,kind,voucher_id,state,provider,channel_id,provider_message_id,fact_at)
select '10000000-0000-4000-8000-000000000001','voucher_issued',v.id,'accepted','official',
  '30000000-0000-4000-8000-000000000001','voucher-message',now()
from public.vouchers v where v.unit_id='10000000-0000-4000-8000-000000000001'
  and v.rule_id='20000000-0000-4000-8000-000000000001' limit 1;
insert into public.whatsapp_automation_receipt_events(unit_id,provider,channel_id,provider_message_id,processing_state,status)
values
  ('10000000-0000-4000-8000-000000000001','official','30000000-0000-4000-8000-000000000001','remote-message','processed','read'),
  ('10000000-0000-4000-8000-000000000001','official','30000000-0000-4000-8000-000000000001','remote-message','processed','delivered'),
  ('10000000-0000-4000-8000-000000000001','official','30000000-0000-4000-8000-000000000001','failed-managed','processed','failed'),
  ('10000000-0000-4000-8000-000000000001','zapi','30000000-0000-4000-8000-000000000002','text-managed','processed','delivered'),
  ('10000000-0000-4000-8000-000000000001','official','30000000-0000-4000-8000-000000000001','failed-legacy','pending','failed');
insert into public.notifications_sent(id,unit_id,kind,status,sent_at)
values ('40000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','waitlist_feedback','sent',now());
insert into public.notifications_sent(id,unit_id,kind,status,sent_at,failed_at,provider_message_id,whatsapp_provider,whatsapp_channel_id)
values ('40000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001',
  'waitlist_feedback','failed',now(),now(),'failed-legacy','official','30000000-0000-4000-8000-000000000001');
insert into public.notifications_sent(id,unit_id,kind,status,sent_at)
select j.notification_id,j.unit_id,j.kind,
  case when j.provider_message_id='failed-managed' then 'failed' else 'sent' end,now()
from public.whatsapp_automation_jobs j where j.kind='waitlist_feedback' and j.provider is not null;
set role authenticated;
select set_config('request.jwt.claim.role','authenticated',false);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',false);
do $$ declare x jsonb; v_giftback jsonb; v_waitlist jsonb; v_text jsonb; v_unbound jsonb;
begin
  x := public.get_marketing_results('10000000-0000-4000-8000-000000000001',
    (now() at time zone 'America/Sao_Paulo')::date,(now() at time zone 'America/Sao_Paulo')::date);
  select d.value into v_giftback from jsonb_array_elements(x->'giftback') d
    where d.value->>'rule_id'='20000000-0000-4000-8000-000000000001';
  select d.value into v_waitlist from jsonb_array_elements(x->'managed') d
    where d.value->>'program'='waitlist_feedback' and d.value->>'channel_kind'='official';
  select d.value into v_text from jsonb_array_elements(x->'managed') d
    where d.value->>'program'='waitlist_feedback' and d.value->>'channel_kind'='text';
  select d.value into v_unbound from jsonb_array_elements(x->'managed') d
    where d.value->>'program'='waitlist_feedback' and d.value->>'channel_kind'='unbound';
  if (v_giftback->>'issued')::bigint is distinct from 5001 or
     (v_waitlist->>'intentions')::bigint is distinct from 2 or
     (v_waitlist->>'accepted')::bigint is distinct from 2 or
     (v_waitlist->>'delivered')::bigint is distinct from 1 or
     (v_waitlist->>'read')::bigint is distinct from 1 or
     (v_text->>'intentions')::bigint is distinct from 1 or
     (v_text->>'delivered')::bigint is distinct from 1 or
     (v_unbound->>'intentions')::bigint is distinct from 1 or
     (v_unbound->>'accepted')::bigint is distinct from 0 or
     (x->'legacy'->>'waitlist_feedback_sent')::bigint is distinct from 2 then
    raise exception 'marketing aggregate mismatch: %', x;
  end if;
  x := public.get_marketing_results('10000000-0000-4000-8000-000000000001',
    (now() at time zone 'America/Sao_Paulo')::date-91,(now() at time zone 'America/Sao_Paulo')::date-91);
  if (x->>'managed_available')::boolean or (x->>'legacy_available')::boolean
     or jsonb_array_length(x->'managed') is distinct from 0 or x->'legacy'->>'waitlist_feedback_sent' is not null then
    raise exception 'retention cutoff failed'; end if;
end $$;
reset role;
-- A mutable trigger cannot retroactively relabel voucher history.
update public.voucher_rules set trigger_type='frequency'
  where id='20000000-0000-4000-8000-000000000001';
set role authenticated;
select set_config('request.jwt.claim.role','authenticated',false);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',false);
do $$ declare x jsonb; v_row jsonb;
begin
  x := public.get_marketing_results('10000000-0000-4000-8000-000000000001',
    (now() at time zone 'America/Sao_Paulo')::date,(now() at time zone 'America/Sao_Paulo')::date);
  select d.value into v_row from jsonb_array_elements(x->'giftback') d
    where d.value->>'rule_id'='20000000-0000-4000-8000-000000000001';
  if v_row->>'program' is distinct from 'giftback_rule' or (v_row->>'issued')::bigint is distinct from 5001 then
    raise exception 'mutable trigger remapped history'; end if;
end $$;
reset role;
-- Deleting a Giftback rule must not block deletion or silently remap old vouchers.
delete from public.voucher_rules where id = '20000000-0000-4000-8000-000000000001';
set role authenticated;
select set_config('request.jwt.claim.role','authenticated',false);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',false);
do $$ declare x jsonb; v_draft jsonb; v_waitlist jsonb;
begin
  x := public.get_marketing_drafts('10000000-0000-4000-8000-000000000001');
  select d.value into v_draft from jsonb_array_elements(x->'drafts') d
    where d.value->>'program' = 'birthday_voucher';
  if v_draft is null or v_draft->>'voucher_rule_id' is not null then
    raise exception 'deleted rule still linked'; end if;
  x := public.get_marketing_results('10000000-0000-4000-8000-000000000001',
    (now() at time zone 'America/Sao_Paulo')::date,(now() at time zone 'America/Sao_Paulo')::date);
  if not (x->>'unknown_giftback_source')::boolean then raise exception 'unknown origin hidden'; end if;
  if not exists(select 1 from jsonb_array_elements(x->'managed') d
    where d.value->>'program'='giftback_rule' and d.value->>'rule_id' is null
      and (d.value->>'intentions')::bigint=1) then
    raise exception 'deleted-rule managed history hidden'; end if;
  x := public.get_marketing_drafts('10000000-0000-4000-8000-000000000001');
  select d.value into v_waitlist from jsonb_array_elements(x->'drafts') d
    where d.value->>'program' = 'waitlist_feedback' and d.value->>'status' = 'draft';
  x := public.archive_marketing_draft((v_waitlist->>'id')::uuid, (v_waitlist->>'revision')::bigint);
  if x->>'status' is distinct from 'archived' or (x->>'revision')::bigint is distinct from 2 then
    raise exception 'archive transition failed'; end if;
  x := public.save_marketing_draft('10000000-0000-4000-8000-000000000001',null,null,
    'waitlist_feedback',null,'Nova pesquisa',null,null,null,null);
  if x->>'status' is distinct from 'draft' then raise exception 'recreate after archive failed'; end if;
end $$;
reset role;
select 'MARKETING preflight passed' as result;
