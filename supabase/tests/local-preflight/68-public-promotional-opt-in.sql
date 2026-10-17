-- Apply 68a bootstrap, then the real 20261017170000 migration. Re-run after
-- each of two further applications. All fixture data ends in ROLLBACK.
\set ON_ERROR_STOP on
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

do $$ begin
  if to_regprocedure('public.record_public_promotional_opt_in(uuid,uuid,text)') is null then
    raise exception 'FAIL68 migration not installed';
  end if;
  if has_function_privilege('anon','public.record_public_promotional_opt_in(uuid,uuid,text)','EXECUTE')
    or has_function_privilege('authenticated','public.record_public_promotional_opt_in(uuid,uuid,text)','EXECUTE')
    or not has_function_privilege('service_role','public.record_public_promotional_opt_in(uuid,uuid,text)','EXECUTE')
    or has_function_privilege('service_role','public.enter_waitlist(uuid,text,text,integer,text,text,time)','EXECUTE') then
    raise exception 'FAIL68 effective function ACL';
  end if;
  if (select prosecdef from pg_proc where oid='public.record_public_promotional_opt_in(uuid,uuid,text)'::regprocedure) is distinct from true
    or (select proconfig from pg_proc where oid='public.record_public_promotional_opt_in(uuid,uuid,text)'::regprocedure)
       is distinct from array['search_path=""']::text[] then
    raise exception 'FAIL68 function security shape';
  end if;
end $$;

insert into public.organizations(id,is_public) values
  ('00000000-0000-4000-8000-000000000001',true),
  ('00000000-0000-4000-8000-000000000002',true),
  ('00000000-0000-4000-8000-000000000003',false);
insert into public.units(id,organization_id,is_public) values
  ('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000001',true),
  ('00000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000001',false),
  ('00000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-000000000002',true),
  ('00000000-0000-4000-8000-000000000031','00000000-0000-4000-8000-000000000003',true);
insert into public.customers(id,organization_id,deleted_at) values
  ('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000001',null),
  ('00000000-0000-4000-8000-000000000102','00000000-0000-4000-8000-000000000001',now()),
  ('00000000-0000-4000-8000-000000000103','00000000-0000-4000-8000-000000000001',null),
  ('00000000-0000-4000-8000-000000000201','00000000-0000-4000-8000-000000000002',null),
  ('00000000-0000-4000-8000-000000000301','00000000-0000-4000-8000-000000000003',null);
insert into public.reservations(id,unit_id,customer_id) values
  ('00000000-0000-4000-8000-000000001001','00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000101'),
  ('00000000-0000-4000-8000-000000001002','00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000101'),
  ('00000000-0000-4000-8000-000000001003','00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000103'),
  ('00000000-0000-4000-8000-000000001012','00000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000101'),
  ('00000000-0000-4000-8000-000000002001','00000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-000000000201');
insert into public.reservations(id,unit_id,customer_id) values
  ('00000000-0000-4000-8000-000000003031','00000000-0000-4000-8000-000000000031','00000000-0000-4000-8000-000000000301');
insert into public.waitlist(id,unit_id,customer_id) values
  ('00000000-0000-4000-8000-000000003001','00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000101'),
  ('00000000-0000-4000-8000-000000003002','00000000-0000-4000-8000-000000000011',null),
  ('00000000-0000-4000-8000-000000004001','00000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-000000000201');

create function pg_temp.expect68_refusal(p_unit uuid,p_customer uuid,p_ref text,p_state text,p_message text,p_label text)
returns void language plpgsql as $$
begin
  begin
    perform public.record_public_promotional_opt_in(p_unit,p_customer,p_ref);
  exception when others then
    if sqlstate=p_state and sqlerrm=p_message then return; end if;
    raise exception 'FAIL68 % got %:% instead of %:%',p_label,sqlstate,sqlerrm,p_state,p_message;
  end;
  raise exception 'FAIL68 % unexpectedly accepted',p_label;
end $$;

do $$
declare
  u uuid := '00000000-0000-4000-8000-000000000011';
  c uuid := '00000000-0000-4000-8000-000000000101';
  ref1 text := 'reservation:00000000-0000-4000-8000-000000001001;form:v1';
  ref2 text := 'waitlist:00000000-0000-4000-8000-000000003001;form:v1';
  ref3 text := 'reservation:00000000-0000-4000-8000-000000001002;form:v1';
  rev bigint;
begin
  rev:=public.record_public_promotional_opt_in(u,c,ref1);
  if rev<>1 or (select count(*) from public.whatsapp_message_consent_events)<>1
    or (select count(*) from public.audit_log)<>1 then raise exception 'FAIL68 reservation insertion'; end if;
  if not exists(select from public.whatsapp_message_consent_events e where e.unit_id=u and e.customer_id=c
      and e.purpose='promotional' and e.decision='opt_in' and e.source_code='public_form'
      and e.actor_id is null and e.evidence_reference=ref1
      and e.observed_at between now()-interval '1 minute' and clock_timestamp()) then
    raise exception 'FAIL68 consent fields';
  end if;
  if not exists(select from public.audit_log a where a.unit_id=u and a.organization_id='00000000-0000-4000-8000-000000000001'
      and a.actor_id is null and a.new_values='{"purpose":"promotional","decision":"opt_in","revision":1}'::jsonb
      and a.new_values::text !~ '[0-9]{10,11}') then raise exception 'FAIL68 audit fields'; end if;

  insert into public.whatsapp_message_consent_events(unit_id,customer_id,purpose,decision,source_code,evidence_reference,actor_id,observed_at)
    values(u,c,'promotional','opt_out','preference_link','preference-event',null,clock_timestamp());
  if public.record_public_promotional_opt_in(u,c,ref1)<>1
    or (select count(*) from public.whatsapp_message_consent_events)<>2
    or (select count(*) from public.audit_log)<>1
    or (select decision from public.whatsapp_message_consent_events where unit_id=u and customer_id=c order by revision desc limit 1)<>'opt_out' then
    raise exception 'FAIL68 replay restored consent after opt-out';
  end if;
  rev:=public.record_public_promotional_opt_in(u,c,ref2);
  if rev<>3 or (select count(*) from public.audit_log)<>2 then raise exception 'FAIL68 waitlist new evidence'; end if;
  if not exists(select from public.whatsapp_message_consent_events e where e.unit_id=u and e.customer_id=c
      and e.purpose='promotional' and e.decision='opt_in' and e.source_code='public_form'
      and e.actor_id is null and e.evidence_reference=ref2 and e.revision=3
      and e.observed_at between now()-interval '1 minute' and clock_timestamp())
    or not exists(select from public.audit_log a where a.unit_id=u
      and a.organization_id='00000000-0000-4000-8000-000000000001'
      and a.record_id=c::text and a.table_name='whatsapp_message_consent_events'
      and a.action='INSERT' and a.actor_id is null
      and a.new_values='{"purpose":"promotional","decision":"opt_in","revision":3}'::jsonb) then
    raise exception 'FAIL68 waitlist consent/audit fields';
  end if;
  rev:=public.record_public_promotional_opt_in(u,c,ref3);
  if rev<>4 or (select count(*) from public.audit_log)<>3 then raise exception 'FAIL68 reservation new evidence'; end if;
  if (select revision from public.whatsapp_message_consent_events where evidence_reference=ref2)<>3
    or (select decision from public.whatsapp_message_consent_events where unit_id=u and customer_id=c order by revision desc limit 1)<>'opt_in' then
    raise exception 'FAIL68 new evidence did not opt in';
  end if;
end $$;

select pg_temp.expect68_refusal('00000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000101',
  'reservation:00000000-0000-4000-8000-000000001012;form:v1','42501','public_promotional_opt_in_forbidden','private unit');
select pg_temp.expect68_refusal('00000000-0000-4000-8000-000000000031','00000000-0000-4000-8000-000000000301',
  'reservation:00000000-0000-4000-8000-000000003031;form:v1','42501','public_promotional_opt_in_forbidden','private organization');
select pg_temp.expect68_refusal('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000102',
  'reservation:00000000-0000-4000-8000-000000001001;form:v1','42501','public_promotional_opt_in_forbidden','deleted customer');
select pg_temp.expect68_refusal('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000201',
  'reservation:00000000-0000-4000-8000-000000001001;form:v1','42501','public_promotional_opt_in_forbidden','foreign customer');
select pg_temp.expect68_refusal('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000999',
  'reservation:00000000-0000-4000-8000-000000001001;form:v1','42501','public_promotional_opt_in_forbidden','missing customer');
select pg_temp.expect68_refusal('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000101',
  'reservation:00000000-0000-4000-8000-000000009999;form:v1','42501','public_promotional_opt_in_forbidden','missing reservation');
select pg_temp.expect68_refusal('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000101',
  'reservation:00000000-0000-4000-8000-000000002001;form:v1','42501','public_promotional_opt_in_forbidden','foreign reservation');
select pg_temp.expect68_refusal('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000101',
  'reservation:00000000-0000-4000-8000-000000001003;form:v1','42501','public_promotional_opt_in_forbidden','other customer reservation');
select pg_temp.expect68_refusal('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000101',
  'waitlist:00000000-0000-4000-8000-000000003002;form:v1','42501','public_promotional_opt_in_forbidden','unlinked waitlist');
select pg_temp.expect68_refusal('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000101',
  'waitlist:00000000-0000-4000-8000-000000004001;form:v1','42501','public_promotional_opt_in_forbidden','foreign waitlist');
select pg_temp.expect68_refusal('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000101',
  'waitlist:00000000-0000-4000-8000-000000009999;form:v1','42501','public_promotional_opt_in_forbidden','missing waitlist');

select pg_temp.expect68_refusal('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000101',
  '','22023','public_promotional_opt_in_invalid','empty reference');
select pg_temp.expect68_refusal('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000101',
  null,'22023','public_promotional_opt_in_invalid','null reference');
select pg_temp.expect68_refusal('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000101',
  repeat('a',513),'22023','public_promotional_opt_in_invalid','long reference');
select pg_temp.expect68_refusal('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000101',
  'reservation:00000000-0000-4000-8000-000000001001;form:v1' || chr(10),'22023','public_promotional_opt_in_invalid','control reference');
select pg_temp.expect68_refusal('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000101',
  '/preferencias/mensagens/token','22023','public_promotional_opt_in_invalid','preference link');
select pg_temp.expect68_refusal('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000101',
  'voucher:00000000-0000-4000-8000-000000001001;form:v1','22023','public_promotional_opt_in_invalid','forged resource type');
select pg_temp.expect68_refusal('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000101',
  'reservation:00000000-0000-4000-8000-000000001001;form:v2','22023','public_promotional_opt_in_invalid','forged form version');

-- Exercise the actual database roles, not only pg_proc ACL metadata.
set local role anon;
do $$ begin
  begin
    perform public.record_public_promotional_opt_in('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000101',
      'reservation:00000000-0000-4000-8000-000000001001;form:v1');
  exception when insufficient_privilege then return; end;
  raise exception 'FAIL68 anon executed consent RPC';
end $$;
reset role;
set local role authenticated;
do $$ begin
  begin
    perform public.record_public_promotional_opt_in('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000101',
      'reservation:00000000-0000-4000-8000-000000001001;form:v1');
  exception when insufficient_privilege then return; end;
  raise exception 'FAIL68 authenticated executed consent RPC';
end $$;
reset role;
set local role service_role;
do $$ begin
  if public.record_public_promotional_opt_in('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000101',
    'reservation:00000000-0000-4000-8000-000000001001;form:v1')<>1 then
    raise exception 'FAIL68 service_role cannot execute';
  end if;
end $$;
reset role;

create temp table t68_original(
  definition text not null,proacl aclitem[],anon_execute boolean not null,
  authenticated_execute boolean not null,service_execute boolean not null
);
insert into t68_original
select pg_get_functiondef(p.oid),p.proacl,
  has_function_privilege('anon',p.oid,'EXECUTE'),
  has_function_privilege('authenticated',p.oid,'EXECUTE'),
  has_function_privilege('service_role',p.oid,'EXECUTE')
from pg_proc p where p.oid='public.record_public_promotional_opt_in(uuid,uuid,text)'::regprocedure;
create function pg_temp.assert68_restored(p_label text) returns void language plpgsql as $$
begin
  if pg_get_functiondef('public.record_public_promotional_opt_in(uuid,uuid,text)'::regprocedure)
       is distinct from (select definition from t68_original)
    or (select proacl from pg_proc where oid='public.record_public_promotional_opt_in(uuid,uuid,text)'::regprocedure)
       is distinct from (select proacl from t68_original)
    or has_function_privilege('anon','public.record_public_promotional_opt_in(uuid,uuid,text)','EXECUTE')
       is distinct from (select anon_execute from t68_original)
    or has_function_privilege('authenticated','public.record_public_promotional_opt_in(uuid,uuid,text)','EXECUTE')
       is distinct from (select authenticated_execute from t68_original)
    or has_function_privilege('service_role','public.record_public_promotional_opt_in(uuid,uuid,text)','EXECUTE')
       is distinct from (select service_execute from t68_original) then
    raise exception 'FAIL68 % did not restore function/ACL',p_label;
  end if;
end $$;
savepoint control68;
do $$ declare original text; weakened text; begin
  select definition into original from t68_original;
  weakened:=replace(original,'r.customer_id=p_customer_id','true');
  if weakened=original then raise exception 'FAIL68 control cannot find resource guard'; end if;
  execute weakened;
end $$;
do $$ begin
  -- This is the same other-customer reservation assertion tested above.
  -- With the guard removed it must fail, proving the test can turn red.
  begin
    perform public.record_public_promotional_opt_in('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000101',
      'reservation:00000000-0000-4000-8000-000000001003;form:v1');
    raise exception 'protected_resource_assertion';
  exception when raise_exception then
    if sqlerrm<>'protected_resource_assertion' then raise; end if;
  end;
end $$;
rollback to savepoint control68;
select pg_temp.assert68_restored('resource control');
select pg_temp.expect68_refusal('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000101',
  'reservation:00000000-0000-4000-8000-000000001003;form:v1','42501','public_promotional_opt_in_forbidden','restored resource guard');

savepoint control68_unit;
do $$ declare original text; weakened text; begin
  select definition into original from t68_original;
  weakened:=replace(original,'u.is_public=true','true');
  if weakened=original then raise exception 'FAIL68 control cannot find unit visibility guard'; end if;
  execute weakened;
end $$;
do $$ begin
  begin
    perform public.record_public_promotional_opt_in('00000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000101',
      'reservation:00000000-0000-4000-8000-000000001012;form:v1');
    raise exception 'protected_unit_visibility_assertion';
  exception when raise_exception then
    if sqlerrm<>'protected_unit_visibility_assertion' then raise; end if;
  end;
end $$;
rollback to savepoint control68_unit;
select pg_temp.assert68_restored('unit visibility control');
select pg_temp.expect68_refusal('00000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000101',
  'reservation:00000000-0000-4000-8000-000000001012;form:v1','42501','public_promotional_opt_in_forbidden','restored unit visibility');

savepoint control68_org;
do $$ declare original text; weakened text; begin
  select definition into original from t68_original;
  weakened:=replace(original,'o.is_public=true','true');
  if weakened=original then raise exception 'FAIL68 control cannot find organization visibility guard'; end if;
  execute weakened;
end $$;
do $$ begin
  begin
    perform public.record_public_promotional_opt_in('00000000-0000-4000-8000-000000000031','00000000-0000-4000-8000-000000000301',
      'reservation:00000000-0000-4000-8000-000000003031;form:v1');
    raise exception 'protected_org_visibility_assertion';
  exception when raise_exception then
    if sqlerrm<>'protected_org_visibility_assertion' then raise; end if;
  end;
end $$;
rollback to savepoint control68_org;
select pg_temp.assert68_restored('organization visibility control');
select pg_temp.expect68_refusal('00000000-0000-4000-8000-000000000031','00000000-0000-4000-8000-000000000301',
  'reservation:00000000-0000-4000-8000-000000003031;form:v1','42501','public_promotional_opt_in_forbidden','restored organization visibility');

do $$ begin
  if (select count(*) from public.whatsapp_message_consent_events)<>4
    or (select count(*) from public.audit_log)<>3 then raise exception 'FAIL68 refusals/control wrote durable evidence'; end if;
  raise notice 'GREEN68 public promotional opt-in, replay, ACL, refusals and positive control';
end $$;
rollback;
