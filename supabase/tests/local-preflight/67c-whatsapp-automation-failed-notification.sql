-- 67c: accepted automation adopts only an unaccepted failed legacy notification.
-- Run after migrations 20261017120000, 20261017140000 and 20261017150000
-- on a disposable local database with the 66a snapshot and quarantined workers.
-- Uses the same fixture bootstrap as 66, then rolls every synthetic row back.
\set ON_ERROR_STOP on

do $$
begin
  if position('v_legacy_notification' in pg_get_functiondef('public.reconcile_whatsapp_automation_acceptance(uuid)'::regprocedure)) = 0 then
    raise exception 'FAIL67c migration missing';
  end if;
  if has_function_privilege('anon','public.reconcile_whatsapp_automation_acceptance(uuid)','EXECUTE')
    or has_function_privilege('authenticated','public.reconcile_whatsapp_automation_acceptance(uuid)','EXECUTE')
    or not has_function_privilege('service_role','public.reconcile_whatsapp_automation_acceptance(uuid)','EXECUTE') then
    raise exception 'FAIL67c ACL';
  end if;
end $$;
-- ─── GUARDA: só faz sentido DEPOIS da migration e do 66a ───────────────────
-- Rodado antes, os casos de recusa (T1 trocado, T3/T4 recusas) passariam POR
-- ACIDENTE: sem os kinds no CHECK todo INSERT/enqueue "falha".
do $$
begin
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conrelid = 'public.whatsapp_remote_templates'::regclass and contype = 'c'
                    and pg_catalog.pg_get_constraintdef(oid) like '%fila_mesa_pronta_v1%'
                    and pg_catalog.pg_get_constraintdef(oid) like '%res_cancelada_v1%')
     or not exists (select 1 from pg_catalog.pg_constraint
                  where conrelid = 'public.whatsapp_automation_jobs'::regclass and contype = 'c'
                    and pg_catalog.pg_get_constraintdef(oid) like '%waitlist_table_ready%')
     or pg_catalog.pg_get_functiondef('app_private.whatsapp_automation_post_core(uuid,uuid,bigint,bigint,bigint,boolean,jsonb)'::regprocedure) not like '%waitlist_table_ready%' then
    raise exception '66 exige a migration 20261017120000 aplicada (CHECKs/post_core sem os kinds/ids novos).';
  end if;
  if to_regclass('public.t_snap066') is null
     or (select count(*) from public.t_snap066 where k like 'fn_antes:%') <> 10 then
    raise exception '66 exige o 66a-templates-table-ready-bootstrap.sql aplicado ANTES da migration (snapshot ausente).';
  end if;
end $$;

begin;
set local lock_timeout = '5s'; set local statement_timeout = '180s';
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

-- A failed row predates ledger acceptance. The sabotage restores the old
-- on-conflict behavior in a subtransaction, observes notification_conflict,
-- then rolls the function body and ACL back before the real reconciliation.
do $$
declare
  u uuid := pg_temp.id66('u'); c uuid := pg_temp.id66('c'); stamp timestamptz := clock_timestamp();
  tomorrow date := (stamp at time zone 'America/Sao_Paulo')::date + 1;
  r uuid := gen_random_uuid(); w uuid := gen_random_uuid(); f jsonb; j uuid; old_id uuid;
  definition text := pg_get_functiondef('public.reconcile_whatsapp_automation_acceptance(uuid)'::regprocedure);
  changed text; acl text; flipped jsonb; repaired jsonb;
begin
  select coalesce(proacl::text,'null') into acl from pg_proc
    where oid='public.reconcile_whatsapp_automation_acceptance(uuid)'::regprocedure;
  changed := replace(definition,
    'if v_legacy_notification is not null and v_legacy_notification<>j.notification_id then',
    'if false then');
  perform pg_temp.ok66(changed<>definition,'67c sabotage locates adoption branch');

  insert into public.reservations(id,unit_id,customer_id,date,time,status,payment_status,source,party_size,reservation_code)
    values(r,u,c,tomorrow,'19:00','confirmed',null,'web',2,'T67C-'||r);
  f := pg_temp.flow66(u,'confirmation',r,stamp,stamp+interval '24 hours',null,'67c confirmation');
  j := (f->>'job')::uuid;
  perform pg_temp.ok66(public.finish_whatsapp_automation(j,(f->>'fence')::uuid,
    jsonb_build_object('outcome','accepted','reason','provider_accepted','provider_message_id','task67c-confirm-'||j)),
    '67c confirmation accepted');
  insert into public.notifications_sent(reservation_id,unit_id,kind,status,error,failed_at)
    values(r,u,'confirmation','failed','synthetic_failed',stamp) returning id into old_id;
  begin
    execute changed;
    flipped := public.reconcile_whatsapp_automation_acceptance(j);
    raise sqlstate 'P0067';
  exception when sqlstate 'P0067' then null; end;
  perform pg_temp.ok66(flipped='{"state":"deferred","reason":"notification_conflict"}'::jsonb,
    '67c control old behavior defers accepted confirmation: '||flipped::text);
  perform pg_temp.ok66(pg_get_functiondef('public.reconcile_whatsapp_automation_acceptance(uuid)'::regprocedure)=definition
    and (select coalesce(proacl::text,'null') from pg_proc where oid='public.reconcile_whatsapp_automation_acceptance(uuid)'::regprocedure)=acl,
    '67c control restores function body and ACL');
  repaired := public.reconcile_whatsapp_automation_acceptance(j);
  perform pg_temp.ok66(repaired='{"state":"reconciled","history":"recorded"}'::jsonb,
    '67c failed confirmation adopted: '||repaired::text);
  perform pg_temp.ok66(exists(select from public.notifications_sent n join public.whatsapp_automation_jobs x on x.notification_id=n.id
    where x.id=j and n.id<>old_id and n.status='sent' and n.failed_at is null and n.error is null
      and n.provider_message_id='task67c-confirm-'||j), '67c confirmation exact correlation');
  perform pg_temp.ok66((select count(*)=1 from public.notifications_sent where reservation_id=r and kind='confirmation'),
    '67c confirmation unique projection');
  perform pg_temp.ok66(public.reconcile_whatsapp_automation_acceptance(j)='{"state":"reconciled","history":"recorded"}'::jsonb,
    '67c repeated reconcile idempotent');

  insert into public.waitlist(id,unit_id,customer_id,customer_name,customer_phone,party_size,code,status,created_at)
    values(w,u,c,'Synthetic67c','11999996601',2,675,'waiting',stamp);
  f := pg_temp.flow66(u,'waitlist_entered',w,stamp,stamp+interval '2 hours',null,'67c waitlist');
  j := (f->>'job')::uuid;
  perform pg_temp.ok66(public.finish_whatsapp_automation(j,(f->>'fence')::uuid,
    jsonb_build_object('outcome','accepted','reason','provider_accepted','provider_message_id','task67c-wait-'||j)),
    '67c waitlist accepted');
  insert into public.notifications_sent(waitlist_id,unit_id,kind,status,error,failed_at)
    values(w,u,'waitlist_entered','failed','synthetic_failed',stamp) returning id into old_id;
  repaired := public.reconcile_whatsapp_automation_acceptance(j);
  perform pg_temp.ok66(repaired='{"state":"reconciled","history":"recorded"}'::jsonb,
    '67c failed waitlist adopted: '||repaired::text);
  perform pg_temp.ok66(exists(select from public.notifications_sent n join public.whatsapp_automation_jobs x on x.notification_id=n.id
    where x.id=j and n.id<>old_id and n.status='sent' and n.failed_at is null and n.error is null
      and n.provider_message_id='task67c-wait-'||j), '67c waitlist exact correlation');
  perform pg_temp.ok66((select count(*)=1 from public.notifications_sent where waitlist_id=w and kind='waitlist_entered'),
    '67c waitlist unique projection');

  -- A historical failed label carrying a provider id is ambiguous acceptance
  -- evidence, so it must remain untouched and visible for manual resolution.
  r := gen_random_uuid();
  insert into public.reservations(id,unit_id,customer_id,date,time,status,payment_status,source,party_size,reservation_code)
    values(r,u,c,tomorrow,'20:00','confirmed',null,'web',2,'T67C-'||r);
  f := pg_temp.flow66(u,'confirmation',r,stamp,stamp+interval '24 hours',null,'67c prior evidence');
  j := (f->>'job')::uuid;
  perform pg_temp.ok66(public.finish_whatsapp_automation(j,(f->>'fence')::uuid,
    jsonb_build_object('outcome','accepted','reason','provider_accepted','provider_message_id','task67c-new-'||j)),
    '67c second confirmation accepted');
  insert into public.notifications_sent(reservation_id,unit_id,kind,status,provider_message_id,failed_at)
    values(r,u,'confirmation','failed','task67c-prior',stamp) returning id into old_id;
  repaired := public.reconcile_whatsapp_automation_acceptance(j);
  perform pg_temp.ok66(repaired='{"state":"deferred","reason":"notification_conflict"}'::jsonb,
    '67c prior provider evidence refuses adoption: '||repaired::text);
  perform pg_temp.ok66(exists(select from public.notifications_sent where id=old_id and status='failed'
    and provider_message_id='task67c-prior') and (select state='accepted' from public.whatsapp_automation_jobs where id=j),
    '67c prior provider evidence and accepted job preserved');
end $$;

-- Voucher has neither reservation_id nor waitlist_id. A historical failed
-- voucher row of the same unit/kind is NOT its natural key and must not be
-- adopted; the accepted voucher receives its own notification UUID.
do $$
declare
  u uuid := pg_temp.id66('u'); c uuid := pg_temp.id66('c'); stamp timestamptz := clock_timestamp();
  rule_id uuid := gen_random_uuid(); voucher_id uuid := gen_random_uuid(); old_id uuid;
  j uuid; x jsonb; fence uuid; generation bigint; rev bigint; result jsonb;
begin
  insert into public.voucher_rules(id,unit_id,name,trigger_type,discount_percent,validity_days,
    min_rating,visits_required,days_window,active,created_at,updated_at)
    values(rule_id,u,'Synthetic67c','birthday',15,30,null,null,null,true,stamp,stamp);
  insert into public.vouchers(id,unit_id,customer_id,rule_id,code,discount_percent,issued_at,created_at,expires_at,status)
    values(voucher_id,u,c,rule_id,'T67C-'||voucher_id,15,stamp,stamp,stamp+interval '30 days','active');
  insert into public.whatsapp_message_consent_events(unit_id,customer_id,purpose,decision,source_code,evidence_reference,observed_at)
    values(u,c,'promotional','opt_in','fixture','task67c-voucher',stamp) returning revision into rev;
  j := public.enqueue_whatsapp_automation(jsonb_build_object('unit_id',u,'kind','voucher_issued',
    'voucher_id',voucher_id,'source_event_key','task67c-voucher-'||voucher_id,
    'fact_at',stamp,'expires_at',stamp+interval '7 days'));
  perform pg_temp.ok66(j is not null,'67c voucher enqueued');
  x := public.claim_whatsapp_automation(j); fence := (x->>'claim_token')::uuid;
  perform pg_temp.ok66(fence is not null,'67c voucher claimed');
  update public.whatsapp_automation_jobs set safe_log_body='Synthetic67c voucher' where id=j and claim_token=fence;
  select binding_generation into generation from public.whatsapp_automation_jobs where id=j;
  perform pg_temp.ok66(public.prepare_whatsapp_automation_post(j,fence,generation,rev,null),'67c voucher prepared');
  perform pg_temp.ok66(public.finish_whatsapp_automation(j,fence,
    jsonb_build_object('outcome','accepted','reason','provider_accepted','provider_message_id','task67c-voucher-'||j)),
    '67c voucher accepted');
  insert into public.notifications_sent(unit_id,kind,status,error,failed_at)
    values(u,'voucher_issued','failed','synthetic_failed',stamp) returning id into old_id;
  result := public.reconcile_whatsapp_automation_acceptance(j);
  perform pg_temp.ok66(result='{"state":"reconciled","history":"recorded"}'::jsonb,
    '67c voucher ignores unrelated natural-null row: '||result::text);
  perform pg_temp.ok66((select status='failed' and provider_message_id is null from public.notifications_sent where id=old_id)
    and exists(select from public.notifications_sent n join public.whatsapp_automation_jobs x on x.notification_id=n.id
      where x.id=j and n.id<>old_id and n.status='sent' and n.provider_message_id='task67c-voucher-'||j),
    '67c voucher old failed row intact and new exact notification present');
end $$;
select count(*) as checks67c from checks66;
rollback;
