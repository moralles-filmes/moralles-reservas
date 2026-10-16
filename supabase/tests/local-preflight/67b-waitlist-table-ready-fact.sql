-- 67b: after migration 20261017140000 on disposable local PostgreSQL.
-- Uses the already-proven fixture setup from baseline 66; baseline 66 itself
-- must run BEFORE this migration because it intentionally allowed waiting.
\set ON_ERROR_STOP on

do $$
begin
  if to_regprocedure('public.set_waitlist_notification_fact()') is null
    or not exists(select from information_schema.columns where table_schema='public' and table_name='waitlist' and column_name='notified_server_at')
    or position('w.notified_server_at=j.fact_at' in pg_get_functiondef('app_private.whatsapp_automation_post_core(uuid,uuid,bigint,bigint,bigint,boolean,jsonb)'::regprocedure)) = 0 then
    raise exception 'FAIL67b migration missing';
  end if;
  if has_function_privilege('anon','public.set_waitlist_notification_fact()','EXECUTE')
    or has_function_privilege('authenticated','public.set_waitlist_notification_fact()','EXECUTE')
    or has_function_privilege('service_role','public.set_waitlist_notification_fact()','EXECUTE') then
    raise exception 'FAIL67b trigger function ACL open';
  end if;
  if (select count(*) from pg_trigger where tgrelid='public.waitlist'::regclass and tgname='waitlist_set_notification_fact' and not tgisinternal) <> 1 then
    raise exception 'FAIL67b trigger cardinality';
  end if;
end $$;

begin;
set local lock_timeout = '5s'; set local statement_timeout = '180s';
-- The compact 41 fixture omits this historical production column. The
-- migration expects it in the real schema; add it only inside the rolled-back
-- preflight transaction so trigger behavior can be exercised here.
alter table public.waitlist add column if not exists notified_at timestamptz;
create temp table checks66(n bigserial, label text) on commit drop;
create temp table ids66(k text primary key, v uuid not null) on commit drop;
create function pg_temp.ok66(v boolean, label text) returns void language plpgsql as $$
begin if v is distinct from true then raise exception 'FAIL66 %', label; end if; insert into checks66(label) values (label); end $$;
-- SQLSTATE + constraint of a refused statement, or 'ok' (effect then persists).
create function pg_temp.err66(stmt text) returns text language plpgsql as $$
declare s text; c text;
begin
  begin execute stmt; exception when others then get stacked diagnostics s = returned_sqlstate, c = constraint_name; return s || ':' || coalesce(c, ''); end;
  return 'ok';
end $$;
create function pg_temp.id66(key text) returns uuid language sql as $$ select v from ids66 where k = key $$;
create function pg_temp.put66(key text, val uuid) returns uuid language sql as $$ insert into ids66 values (key, val) on conflict (k) do update set v = excluded.v returning v $$;
-- This image's auth.uid()/auth.role() read request.jwt.claim.sub/role.
create function pg_temp.actor66(uid uuid, role_name text default 'authenticated') returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('role', role_name, 'sub', uid)::text, true);
  perform set_config('request.jwt.claim.sub', coalesce(uid::text, ''), true);
  perform set_config('request.jwt.claim.role', coalesce(role_name, ''), true);
end $$;
create function pg_temp.service66() returns void language plpgsql as $$
begin perform pg_temp.actor66(null, 'service_role'); end $$;
-- Projection of the real fixture row (same shape as 41's expected41). The
-- setting key mirrors the migration's v_key: null for confirmation and for
-- both new kinds.
create function pg_temp.expected66(jid uuid) returns jsonb language plpgsql as $$
declare j public.whatsapp_automation_jobs%rowtype; r jsonb; c jsonb; u jsonb; rule jsonb := 'null'; setting jsonb; k text;
begin
  select * into j from public.whatsapp_automation_jobs where id = jid;
  if j.reservation_id is not null then
    select jsonb_build_object('id',id,'unit_id',unit_id,'customer_id',customer_id,'date',date,'time',time,'status',status,
      'payment_status',payment_status,'source',source,'party_size',party_size,'reservation_code',reservation_code,
      'applied_discount_percent',applied_discount_percent,'satisfaction_rating',satisfaction_rating) into r from public.reservations where id = j.reservation_id;
  elsif j.waitlist_id is not null then
    select jsonb_build_object('id',id,'unit_id',unit_id,'customer_id',customer_id,'customer_name',customer_name,'customer_phone',customer_phone,
      'party_size',party_size,'code',code,'status',status,'created_at',created_at,'seated_at',seated_at) into r from public.waitlist where id = j.waitlist_id;
  else
    raise exception 'expected66 voucher not used';
  end if;
  select jsonb_build_object('id',id,'organization_id',organization_id,'name',name,'phone',phone,'do_not_contact',do_not_contact,'deleted_at',deleted_at)
    into c from public.customers where id = j.customer_id;
  select jsonb_build_object('id',id,'organization_id',organization_id,'name',name,'slug',slug,'timezone',timezone) into u from public.units where id = j.unit_id;
  k := case j.kind when 'confirmation' then null when 'cancellation' then null when 'waitlist_table_ready' then null
         when 'voucher_issued' then 'giftback_whatsapp_enabled' else j.kind || '_enabled' end;
  select jsonb_build_object('key',k,'present',true,'value',value) into setting from public.settings where unit_id = j.unit_id and key = k;
  if not found then setting := jsonb_build_object('key',k,'present',false,'value',null); end if;
  return jsonb_build_object('version',1,'kind',j.kind,'resource',r,'customer',c,'unit',u,'rule',rule,'setting',setting);
end $$;
-- Real path: enqueue -> claim -> frozen redacted body -> pre-POST prepare.
create function pg_temp.flow66(u uuid, v_kind text, res uuid, fact timestamptz, expiry timestamptz, rev bigint, label text) returns jsonb language plpgsql as $$
declare j uuid; x jsonb; f uuid; g bigint;
begin
  j := public.enqueue_whatsapp_automation(jsonb_build_object('unit_id',u,'kind',v_kind,
    case when v_kind in ('confirmation','reminder_d1','survey_d1','cancellation') then 'reservation_id' else 'waitlist_id' end, res,
    'source_event_key','task66-'||v_kind||'-'||res,'fact_at',fact,'expires_at',expiry));
  perform pg_temp.ok66(j is not null, label || ' enqueued');
  x := public.claim_whatsapp_automation(j); f := (x->>'claim_token')::uuid;
  perform pg_temp.ok66(f is not null and x->>'state' = 'claimed', label || ' claimed');
  update public.whatsapp_automation_jobs set safe_log_body = 'Task66 synthetic redacted' where id = j and claim_token = f;
  select binding_generation into g from public.whatsapp_automation_jobs where id = j;
  perform pg_temp.ok66(public.prepare_whatsapp_automation_post(j, f, g, rev, null), label || ' real prepare');
  return jsonb_build_object('job', j, 'fence', f, 'generation', g);
end $$;
create function pg_temp.confirm66(flow jsonb, expected jsonb, rev bigint default null) returns jsonb language sql as $$
  select public.confirm_whatsapp_automation_resource_post((flow->>'job')::uuid, (flow->>'fence')::uuid, (flow->>'generation')::bigint, rev, null, expected)
$$;
create temp table flows66(k text primary key, flow jsonb not null) on commit drop;

-- ─── fixtures ──────────────────────────────────────────────────────────────
do $$
declare
  stamp timestamptz := clock_timestamp(); v_admin uuid := gen_random_uuid(); o uuid := gen_random_uuid();
  u uuid := gen_random_uuid(); u2 uuid := gen_random_uuid(); u3 uuid := gen_random_uuid();
  c uuid := gen_random_uuid(); ch uuid := gen_random_uuid(); ch2 uuid := gen_random_uuid(); ch3 uuid := gen_random_uuid();
  a2 uuid := gen_random_uuid(); b2 uuid;
begin
  if (stamp at time zone 'America/Sao_Paulo')::time >= '23:50'::time or (stamp at time zone 'America/Sao_Paulo')::time < '00:10'::time then
    raise exception 'task66_day_boundary_fixture_refused (rode fora de 23:50-00:10 BRT)';
  end if;
  perform pg_temp.ok66(not exists (select from cron.job where jobname in ('whatsapp-automation-worker','whatsapp-template-workers')), 'T0 cron quarantine');
  insert into auth.users(id) values (v_admin); insert into public.platform_admins values (v_admin);
  insert into public.organizations(id, name) values (o, 'Task66');
  insert into public.units(id, organization_id, name, slug, timezone) values
    (u, o, 'Task66 text', 'task66-' || u, 'America/Sao_Paulo'),
    (u2, o, 'Task66 datafy', 'task66-' || u2, 'America/Sao_Paulo'),
    (u3, o, 'Task66 sem canal', 'task66-' || u3, 'America/Sao_Paulo');
  insert into public.customers(id, organization_id, name, phone, do_not_contact, deleted_at) values (c, o, 'Synthetic66', '11999996601', false, null);
  insert into public.whatsapp_channels(id, unit_id, provider, status, is_active, last_health_check_at, webhook_secret) values
    (ch, u, 'zapi', 'connected', true, stamp, 'synthetic-task66-text'),
    (ch3, u3, 'zapi', 'connected', true, stamp, 'synthetic-task66-gone');
  insert into public.whatsapp_channels(id, unit_id, provider, status, is_active, last_health_check_at, credentials, webhook_secret) values
    (ch2, u2, 'datafy', 'connected', true, stamp, '{"phone_number_id":"6601"}', 'synthetic-task66-datafy');
  perform pg_temp.actor66(v_admin);
  -- TEXT bootstrap through the real admin RPC (binding + sticky adoption).
  perform pg_temp.ok66(public.release_whatsapp_template_channel(ch, 'dispatch', true, 0, null), 'T0 TEXT bootstrap u');
  perform pg_temp.ok66(public.release_whatsapp_template_channel(ch3, 'dispatch', true, 0, null), 'T0 TEXT bootstrap u3');
  -- Datafy account/binding; catalog and dispatch grants through the real RPC.
  insert into public.whatsapp_template_accounts(id, organization_id, waba_id, verified_at) values (a2, o, '6600000000001', stamp);
  insert into public.whatsapp_template_bindings(unit_id, channel_id, account_id, provider, verified_at) values (u2, ch2, a2, 'datafy', stamp) returning id into b2;
  perform pg_temp.ok66(public.release_whatsapp_template_channel(ch2, 'catalog', true, 0, 1), 'T0 datafy catalog grant');
  perform pg_temp.ok66(public.release_whatsapp_template_channel(ch2, 'dispatch', true, 0, 1), 'T0 datafy dispatch grant');
  perform pg_temp.service66();
  -- u3 keeps its sticky adoption after losing channel and binding (preconfiguration path).
  delete from public.whatsapp_channels where id = ch3;
  perform pg_temp.ok66(exists (select from public.whatsapp_automation_adoptions where unit_id = u3)
    and not exists (select from public.whatsapp_channels where unit_id = u3), 'T0 u3 adopted without channel');
  insert into public.platform_flags(key, value) values ('whatsapp_automation_dispatch', 'true') on conflict (key) do update set value = excluded.value;
  perform pg_temp.put66('admin', v_admin); perform pg_temp.put66('org', o);
  perform pg_temp.put66('u', u); perform pg_temp.put66('u2', u2); perform pg_temp.put66('u3', u3);
  perform pg_temp.put66('c', c); perform pg_temp.put66('ch', ch); perform pg_temp.put66('ch2', ch2);
  perform pg_temp.put66('a2', a2); perform pg_temp.put66('b2', b2);
end $$;


-- Transition, direct spoof, reversal before/after capture, and legacy row.
do $$
declare
  u uuid := pg_temp.id66('u'); c uuid := pg_temp.id66('c');
  w uuid := gen_random_uuid(); w_before uuid := gen_random_uuid(); w_old uuid := gen_random_uuid();
  fact timestamptz; new_fact timestamptz; f jsonb; got jsonb;
  j uuid; x jsonb; fence uuid; generation bigint;
begin
  insert into public.waitlist(id,unit_id,customer_id,customer_name,customer_phone,party_size,code,status,notified_at)
    values(w,u,c,'Synthetic67b','11999996601',2,671,'waiting','1999-01-01');
  perform pg_temp.ok66((select notified_at is null and notified_server_at is null from public.waitlist where id=w), '67b insert ignores spoof');
  update public.waitlist set status='notified',notified_at='2000-01-01',notified_server_at='2001-01-01' where id=w;
  select notified_at into fact from public.waitlist where id=w;
  perform pg_temp.ok66(fact is not null and fact > '2020-01-01' and
    (select notified_server_at=fact from public.waitlist where id=w), '67b transition server stamp');
  update public.waitlist set notified_at='2002-01-01',notified_server_at='2003-01-01' where id=w;
  perform pg_temp.ok66((select notified_at=fact and notified_server_at=fact from public.waitlist where id=w), '67b lateral spoof ignored');
  f := pg_temp.flow66(u,'waitlist_table_ready',w,fact,fact+interval '30 minutes',null,'67b captured');
  got := pg_temp.confirm66(f,pg_temp.expected66((f->>'job')::uuid));
  perform pg_temp.ok66(got='{"allowed":true}'::jsonb,'67b captured proof accepted: '||got::text);
  update public.waitlist set status='waiting' where id=w;
  perform pg_temp.ok66((select notified_at is null and notified_server_at is null from public.waitlist where id=w), '67b reset clears proof');
  got := pg_temp.confirm66(f,pg_temp.expected66((f->>'job')::uuid));
  perform pg_temp.ok66(got='{"allowed":false,"reason":"snapshot_invalid"}'::jsonb,'67b reversal after capture: '||got::text);
  perform pg_sleep(0.01);
  update public.waitlist set status='notified' where id=w;
  select notified_at into new_fact from public.waitlist where id=w;
  perform pg_temp.ok66(new_fact>fact and (select notified_server_at=new_fact from public.waitlist where id=w), '67b re-notify new fact');
  got := pg_temp.confirm66(f,pg_temp.expected66((f->>'job')::uuid));
  perform pg_temp.ok66(got='{"allowed":false,"reason":"authority_changed"}'::jsonb,'67b old job cannot use new fact: '||got::text);

  insert into public.waitlist(id,unit_id,customer_id,customer_name,customer_phone,party_size,code,status)
    values(w_before,u,c,'Synthetic67b','11999996601',2,672,'waiting');
  update public.waitlist set status='notified' where id=w_before;
  select notified_at into fact from public.waitlist where id=w_before;
  j := public.enqueue_whatsapp_automation(jsonb_build_object('unit_id',u,'kind','waitlist_table_ready',
    'waitlist_id',w_before,'source_event_key','67b-before','fact_at',fact,'expires_at',fact+interval '30 minutes'));
  x := public.claim_whatsapp_automation(j); fence := (x->>'claim_token')::uuid;
  select binding_generation into generation from public.whatsapp_automation_jobs where id=j;
  update public.whatsapp_automation_jobs set safe_log_body='Synthetic67b' where id=j and claim_token=fence;
  update public.waitlist set status='waiting' where id=w_before;
  perform pg_temp.ok66(not public.prepare_whatsapp_automation_post(j,fence,generation,null,null), '67b reversal before capture');

  insert into public.waitlist(id,unit_id,customer_id,customer_name,customer_phone,party_size,code,status)
    values(w_old,u,c,'Synthetic67b','11999996601',2,673,'waiting');
  alter table public.waitlist disable trigger waitlist_set_notification_fact;
  update public.waitlist set status='notified',notified_at=clock_timestamp(),notified_server_at=null where id=w_old;
  alter table public.waitlist enable trigger waitlist_set_notification_fact;
  perform pg_temp.ok66((select notified_at is not null and notified_server_at is null from public.waitlist where id=w_old), '67b old browser fact remains untrusted');
  select notified_at into fact from public.waitlist where id=w_old;
  j := public.enqueue_whatsapp_automation(jsonb_build_object('unit_id',u,'kind','waitlist_table_ready',
    'waitlist_id',w_old,'source_event_key','67b-old','fact_at',fact,'expires_at',fact+interval '30 minutes'));
  x := public.claim_whatsapp_automation(j); fence := (x->>'claim_token')::uuid;
  select binding_generation into generation from public.whatsapp_automation_jobs where id=j;
  update public.whatsapp_automation_jobs set safe_log_body='Synthetic67b' where id=j and claim_token=fence;
  perform pg_temp.ok66(not public.prepare_whatsapp_automation_post(j,fence,generation,null,null), '67b old fact cannot prepare');
end $$;

-- Recancelamento: o mesmo job permanece histórico, mas o ciclo novo não pode
-- tomar emprestado seu fact_at no último guard SQL.
do $$
declare
  u uuid := pg_temp.id66('u'); c uuid := pg_temp.id66('c'); r uuid := gen_random_uuid();
  tomorrow date := (clock_timestamp() at time zone 'America/Sao_Paulo')::date + 1;
  old_fact timestamptz; new_fact timestamptz; f jsonb; base jsonb; flipped jsonb; restored jsonb;
  sig regprocedure := 'app_private.whatsapp_automation_post_core(uuid,uuid,bigint,bigint,bigint,boolean,jsonb)'::regprocedure;
  def0 text := pg_get_functiondef(sig); bad text;
begin
  insert into public.reservations(id,unit_id,customer_id,date,time,status,source,party_size,reservation_code)
    values(r,u,c,tomorrow,'20:00','cancelled','web',2,'R67-'||r);
  select cancelled_at into old_fact from public.reservations where id=r;
  perform pg_temp.ok66(old_fact is not null,'67b cancellation server fact exists');
  f := pg_temp.flow66(u,'cancellation',r,old_fact,old_fact+interval '24 hours',null,'67b cancellation captured');
  base := pg_temp.confirm66(f,pg_temp.expected66((f->>'job')::uuid));
  perform pg_temp.ok66(base='{"allowed":true}'::jsonb,'67b cancellation original cycle allowed: '||base::text);
  update public.reservations set status='confirmed' where id=r;
  perform pg_sleep(0.01);
  update public.reservations set status='cancelled' where id=r;
  select cancelled_at into new_fact from public.reservations where id=r;
  perform pg_temp.ok66(new_fact>old_fact,'67b recancellation has a new server fact');
  base := pg_temp.confirm66(f,pg_temp.expected66((f->>'job')::uuid));
  perform pg_temp.ok66(base='{"allowed":false,"reason":"authority_changed"}'::jsonb,'67b old cancellation job denied: '||base::text);
  bad := replace(def0,' and r.cancelled_at=j.fact_at','');
  perform pg_temp.ok66(bad<>def0,'67b cancellation sabotage finds final guard');
  begin
    execute bad;
    flipped := pg_temp.confirm66(f,pg_temp.expected66((f->>'job')::uuid));
    raise sqlstate 'P0067';
  exception when sqlstate 'P0067' then null; end;
  restored := pg_temp.confirm66(f,pg_temp.expected66((f->>'job')::uuid));
  perform pg_temp.ok66(flipped='{"allowed":true}'::jsonb,'67b cancellation sabotage flips result: '||flipped::text);
  perform pg_temp.ok66(restored=base and pg_get_functiondef(sig)=def0,'67b cancellation guard restored');
end $$;

-- Positive control for the final SQL authority: removing only the server
-- marker comparison makes the same captured job pass; subtransaction restores
-- body and ACL before leaving this case.
do $$
declare
  u uuid := pg_temp.id66('u'); c uuid := pg_temp.id66('c'); w uuid := gen_random_uuid();
  fact timestamptz; f jsonb; base jsonb; flipped jsonb; after_restore jsonb;
  sig regprocedure := 'app_private.whatsapp_automation_post_core(uuid,uuid,bigint,bigint,bigint,boolean,jsonb)'::regprocedure;
  def0 text := pg_get_functiondef(sig); bad text; acl0 text;
begin
  select coalesce(proacl::text,'null') into acl0 from pg_proc where oid=sig;
  insert into public.waitlist(id,unit_id,customer_id,customer_name,customer_phone,party_size,code,status)
    values(w,u,c,'Synthetic67b','11999996601',2,674,'waiting');
  update public.waitlist set status='notified' where id=w;
  select notified_at into fact from public.waitlist where id=w;
  f := pg_temp.flow66(u,'waitlist_table_ready',w,fact,fact+interval '30 minutes',null,'67b SQL control');
  alter table public.waitlist disable trigger waitlist_set_notification_fact;
  update public.waitlist set notified_server_at=null where id=w;
  alter table public.waitlist enable trigger waitlist_set_notification_fact;
  base := pg_temp.confirm66(f,pg_temp.expected66((f->>'job')::uuid));
  perform pg_temp.ok66(base='{"allowed":false,"reason":"authority_changed"}'::jsonb,'67b SQL guard baseline');
  bad := replace(def0,' and w.notified_server_at=j.fact_at','');
  perform pg_temp.ok66(bad<>def0,'67b SQL sabotage found exact guard');
  begin
    execute bad;
    flipped := pg_temp.confirm66(f,pg_temp.expected66((f->>'job')::uuid));
    raise sqlstate 'P0067';
  exception when sqlstate 'P0067' then null; end;
  after_restore := pg_temp.confirm66(f,pg_temp.expected66((f->>'job')::uuid));
  perform pg_temp.ok66(flipped='{"allowed":true}'::jsonb,'67b SQL sabotage flips result');
  perform pg_temp.ok66(after_restore=base and pg_get_functiondef(sig)=def0
    and (select coalesce(proacl::text,'null') from pg_proc where oid=sig)=acl0,'67b SQL body and ACL restored');
end $$;

-- Positive control: disable trigger, then direct timestamp spoof succeeds.
alter table public.waitlist disable trigger waitlist_set_notification_fact;
update public.waitlist set notified_at='2004-01-01',notified_server_at='2004-01-01'
  where code=671 and unit_id=pg_temp.id66('u');
do $$ begin
  if not exists(select from public.waitlist where code=671 and unit_id=pg_temp.id66('u')
    and notified_at='2004-01-01'::timestamptz and notified_server_at='2004-01-01'::timestamptz) then
    raise exception 'FAIL67b positive control did not defeat trigger';
  end if;
end $$;
alter table public.waitlist enable trigger waitlist_set_notification_fact;

select count(*) as checks67b from checks66;
rollback;
