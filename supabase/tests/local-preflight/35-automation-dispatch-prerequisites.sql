\set ON_ERROR_STOP on
begin;
create temp table checks(label text);
create function pg_temp.ok(v boolean,label text) returns void language plpgsql as $$begin if v is distinct from true then raise exception 'FAIL: %',label; end if; insert into checks values(label); end$$;
create function pg_temp.denied(q text,code text,label text) returns void language plpgsql as $$begin begin execute q; exception when others then if sqlstate=code then perform pg_temp.ok(true,label); return; end if; raise; end; raise exception 'FAIL: % allowed',label; end$$;
do $$ declare o uuid:=gen_random_uuid(); u uuid:=gen_random_uuid(); c uuid:=gen_random_uuid(); r uuid:=gen_random_uuid(); v uuid:=gen_random_uuid(); actor uuid:=gen_random_uuid(); j uuid; intent jsonb; begin
  insert into auth.users(id) values(actor);
  insert into public.platform_admins values(actor);
  insert into public.organizations(id,name) values(o,'Task35 synthetic');
  insert into public.units(id,organization_id,name) values(u,o,'Task35');
  insert into public.customers(id,organization_id,name,phone) values(c,o,'Synthetic','11999993535');
  insert into public.reservations(id,unit_id,customer_id) values(r,u,c);
  perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',actor)::text,true);
  insert into public.whatsapp_automation_adoptions(unit_id,adopted_at) values(u,clock_timestamp());
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  intent:=jsonb_build_object('unit_id',u,'kind','reminder_d1','reservation_id',r,'source_event_key','current35','fact_at',clock_timestamp(),'expires_at',clock_timestamp()+interval '1 hour');
  j:=public.enqueue_whatsapp_automation(intent);
  perform pg_temp.ok(j is not null,'missing selected configuration records real same-ledger job');
  perform pg_temp.ok(public.enqueue_whatsapp_automation(intent)=j,'missing configuration preserves natural identity');
  insert into public.vouchers(id,unit_id,customer_id) values(v,u,c);
  j:=public.enqueue_whatsapp_automation(jsonb_build_object('unit_id',u,'kind','voucher_issued','voucher_id',v,'source_event_key','task35-incomplete-promotion','fact_at',clock_timestamp(),'expires_at',clock_timestamp()+interval '1 hour'));
  perform pg_temp.denied(format('insert into public.whatsapp_promotion_slots(unit_id,customer_id,job_id,claim_token,claimed_until,window_until,window_days) values(%L,%L,%L,%L,clock_timestamp()+interval ''90 seconds'',clock_timestamp()+interval ''7 days'',7)',u,c,j,gen_random_uuid()),'23514','incomplete promotional job cannot reserve slot');
end $$;
-- Independent complete fixture; never a public initializer or genuine JWT proof.
do $$ declare
  o uuid:=gen_random_uuid(); u uuid:=gen_random_uuid(); c uuid:=gen_random_uuid(); actor uuid:=gen_random_uuid();
  r uuid; ch uuid:=gen_random_uuid(); b uuid:=gen_random_uuid(); a uuid:=gen_random_uuid(); t uuid:=gen_random_uuid();
  j0 uuid; j1 uuid; j2 uuid; j uuid; f uuid; x jsonb; intent jsonb; before_row jsonb; e bigint; label text; n integer;
  old_pins app_private.whatsapp_automation_pin_tuple; new_pins app_private.whatsapp_automation_pin_tuple;
begin
  insert into auth.users(id) values(actor); insert into public.platform_admins values(actor);
  insert into public.organizations(id,name) values(o,'Task35 isolated'); insert into public.units(id,organization_id,name) values(u,o,'Task35');
  insert into public.customers(id,organization_id,name,phone) values(c,o,'Synthetic','11999993536');
  perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',actor)::text,true);
  insert into public.whatsapp_automation_adoptions(unit_id,adopted_at) values(u,clock_timestamp());
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  insert into public.platform_flags(key,value) values('whatsapp_automation_dispatch','false') on conflict(key) do update set value=excluded.value;
  intent:=jsonb_build_object('unit_id',u,'kind','reminder_d1','source_event_key','task35-current','fact_at',clock_timestamp(),'expires_at',clock_timestamp()+interval '1 hour');
  for n in 0..3 loop
    r:=gen_random_uuid(); insert into public.reservations(id,unit_id,customer_id) values(r,u,c);
    j:=public.enqueue_whatsapp_automation(intent||jsonb_build_object('reservation_id',r));
    if n<3 then
      perform pg_temp.ok((select pin_phase='preconfiguration' and state='blocked' and attempts=0 from public.whatsapp_automation_jobs where id=j),'incomplete shape '||n);
      perform pg_temp.ok(public.claim_whatsapp_automation(j) is null and not public.requeue_whatsapp_automation(j) and not public.prepare_whatsapp_automation_post(j,gen_random_uuid(),1,null,null) and not public.confirm_whatsapp_automation_post(j,gen_random_uuid(),1,null,null),'incomplete cannot dispatch '||n);
      perform pg_temp.ok(not exists(select from public.select_due_whatsapp_automations(20) where id=j),'incomplete excluded due '||n);
      perform pg_temp.denied(format('update public.whatsapp_automation_jobs set state=''queued'' where id=%L',j),'23514','incomplete queued forbidden '||n);
      perform pg_temp.denied(format('update public.whatsapp_automation_jobs set attempts=1 where id=%L',j),'23514','incomplete attempt forbidden '||n);
      perform pg_temp.denied(format('update public.whatsapp_automation_jobs set safe_log_body=''forged'' where id=%L',j),'23514','incomplete render forbidden '||n);
      perform pg_temp.denied(format('update public.whatsapp_automation_jobs set pin_phase=''bound'' where id=%L',j),'23514','direct initialization forbidden '||n);
    end if;
    if n=0 then
      j0:=j;
      insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,last_health_check_at) values(ch,u,'datafy','connected',true,clock_timestamp());
    elsif n=1 then
      j1:=j;
      insert into public.whatsapp_template_accounts(id,organization_id,waba_id,verified_at,binding_generation) values(a,o,'3535353535',clock_timestamp(),7);
      insert into public.whatsapp_template_bindings(id,unit_id,channel_id,account_id,provider,generation,verified_at) values(b,u,ch,a,'datafy',3,clock_timestamp());
    elsif n=2 then
      j2:=j;
      insert into public.whatsapp_remote_templates(id,account_id,logical_id,version,language,name,desired_hash,requested_category,binding_generation) values(t,a,'res_lembrete_dia_v1',1,'pt_BR','res_lembrete_dia_v1',repeat('a',64),'UTILITY',7);
      x:=public.begin_whatsapp_template_sync(a);
      perform pg_temp.ok(public.publish_whatsapp_template_sync(a,7,x,jsonb_build_array(jsonb_build_object('id',t,'remote_id','task35-remote','name','res_lembrete_dia_v1','language','pt_BR','observed_hash',repeat('a',64),'effective_category','UTILITY','remote_status','APPROVED','quality','GREEN'))),'published current GET distinct account7 binding3');
      select sync_epoch into e from public.whatsapp_remote_templates where id=t;
    end if;
  end loop;
  perform pg_temp.ok((select pin_phase='bound' and state='paused' and error_code='dispatch_paused' from public.whatsapp_automation_jobs where id=j),'complete OFF bound paused');
  perform pg_temp.ok((select error_code='channel_unconfigured' and channel_id is null from public.whatsapp_automation_jobs where id=j0),'later configuration never fills original missing pins');
  perform pg_temp.ok((select initial_credential_revision=0 and initial_catalog_key='res_lembrete_dia_v1' from public.whatsapp_automation_jobs where id=j1),'known insertion revision zero retained');
  perform pg_temp.denied(format('update public.whatsapp_automation_jobs set binding_id=%L,binding_generation=3,account_id=%L where id=%L',b,a,j1),'23514','no partial fill');
  perform pg_temp.denied(format('update public.whatsapp_automation_jobs set initial_credential_revision=1 where id=%L',j1),'23514','known revision immutable');
  select pin_phase,channel_id,provider,binding_id,binding_generation,transport,account_id,remote_template_id,template_version,sync_epoch,initial_credential_revision,initial_catalog_key into old_pins from public.whatsapp_automation_jobs where id=j0;
  new_pins:=row('bound',ch,'datafy',b,3,'template',a,t,1,e,0,'res_lembrete_dia_v1')::app_private.whatsapp_automation_pin_tuple;
  insert into app_private.whatsapp_automation_pin_initialization_permits values(txid_current(),actor,j0,old_pins,new_pins);
  perform pg_temp.ok(not app_private.consume_whatsapp_automation_pin_initialization(j0,old_pins,new_pins),'service cannot consume even exact fixture permit');
  perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',actor)::text,true);
  perform pg_temp.ok(not app_private.consume_whatsapp_automation_pin_initialization(j1,old_pins,new_pins),'permit exact job');
  perform pg_temp.ok(not app_private.consume_whatsapp_automation_pin_initialization(j0,new_pins,old_pins),'permit exact OLD NEW');
  update app_private.whatsapp_automation_pin_initialization_permits set transaction_id=txid_current()+1 where job_id=j0;
  perform pg_temp.ok(not app_private.consume_whatsapp_automation_pin_initialization(j0,old_pins,new_pins),'permit rejects other transaction');
  update app_private.whatsapp_automation_pin_initialization_permits set transaction_id=txid_current(),actor_id=gen_random_uuid() where job_id=j0;
  perform pg_temp.ok(not app_private.consume_whatsapp_automation_pin_initialization(j0,old_pins,new_pins),'permit rejects other actor');
  update app_private.whatsapp_automation_pin_initialization_permits set actor_id=actor where job_id=j0;
  delete from public.platform_admins where user_id=actor;
  perform pg_temp.ok(not app_private.consume_whatsapp_automation_pin_initialization(j0,old_pins,new_pins),'permit requires current platform admin');
  insert into public.platform_admins values(actor);
  begin
    perform pg_temp.ok(app_private.consume_whatsapp_automation_pin_initialization(j0,old_pins,new_pins),'exact fixture permit consumable');
    raise sqlstate 'P0099';
  exception when sqlstate 'P0099' then null; end;
  begin
    update public.whatsapp_automation_jobs set pin_phase='bound',channel_id=ch,provider='datafy',binding_id=b,binding_generation=3,transport='template',account_id=a,remote_template_id=t,template_version=1,sync_epoch=e,initial_credential_revision=0,state='queued' where id=j0;
    perform pg_temp.ok(not exists(select from app_private.whatsapp_automation_pin_initialization_permits where job_id=j0),'fixture transition consumes permit');
    raise sqlstate 'P0099';
  exception when sqlstate 'P0099' then null; end;
  perform pg_temp.ok((select pin_phase='preconfiguration' from public.whatsapp_automation_jobs where id=j0) and exists(select from app_private.whatsapp_automation_pin_initialization_permits where job_id=j0),'rollback restores job and permit atomically');
  perform pg_temp.ok(app_private.consume_whatsapp_automation_pin_initialization(j0,old_pins,new_pins) and not app_private.consume_whatsapp_automation_pin_initialization(j0,old_pins,new_pins),'fixture consume one use only, not public initializer proof');
  select pin_phase,channel_id,provider,binding_id,binding_generation,transport,account_id,remote_template_id,template_version,sync_epoch,initial_credential_revision,initial_catalog_key into old_pins from public.whatsapp_automation_jobs where id=j2;
  for label in select unnest(array['revision','generation','channel','catalog','partial']) loop
    new_pins:=row('bound',ch,'datafy',b,3,'template',a,t,1,e,0,'res_lembrete_dia_v1')::app_private.whatsapp_automation_pin_tuple;
    if label='revision' then new_pins.initial_credential_revision:=1;
    elsif label='generation' then new_pins.binding_generation:=4;
    elsif label='channel' then new_pins.channel_id:=gen_random_uuid();
    elsif label='catalog' then new_pins.initial_catalog_key:='fila_entrada_v1';
    else new_pins.remote_template_id:=null; end if;
    insert into app_private.whatsapp_automation_pin_initialization_permits values(txid_current(),actor,j2,old_pins,new_pins);
    perform pg_temp.denied(format('update public.whatsapp_automation_jobs set pin_phase=''bound'',channel_id=%L,binding_generation=%L,remote_template_id=%L,template_version=1,sync_epoch=%L,initial_credential_revision=%L,initial_catalog_key=%L,state=''queued'' where id=%L',new_pins.channel_id,new_pins.binding_generation,new_pins.remote_template_id,new_pins.sync_epoch,new_pins.initial_credential_revision,new_pins.initial_catalog_key,j2),'23514','exact permit cannot replace known anchor or partially fill '||label);
    perform pg_temp.ok(exists(select from app_private.whatsapp_automation_pin_initialization_permits where job_id=j2),'denied initialization preserves permit '||label);
    delete from app_private.whatsapp_automation_pin_initialization_permits where job_id=j2;
  end loop;
  perform pg_temp.ok(not public.block_whatsapp_automation_preflight(j1,gen_random_uuid(),'reservation_pending'),'initial block rejects incomplete phase');
  update public.whatsapp_template_bindings set adopted_at=clock_timestamp(),dispatch_enabled=true where id=b;
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  update public.platform_flags set value='true' where key='whatsapp_automation_dispatch';
  select to_jsonb(z) into before_row from public.whatsapp_automation_jobs z where id=j;
  perform pg_temp.ok(public.enqueue_whatsapp_automation(intent||jsonb_build_object('reservation_id',r))=j,'reenqueue returns same paused ID');
  perform pg_temp.ok(public.requeue_whatsapp_automation(j),'explicit same job requeue');
  x:=public.claim_whatsapp_automation(j); f:=(x->>'claim_token')::uuid;
  perform pg_temp.ok(public.block_whatsapp_automation_preflight(j,f,'reservation_pending'),'initial pending refusal');
  perform pg_temp.ok((select attempts=0 and claim_token is null and posting_started_at is null and fact_at=(before_row->>'fact_at')::timestamptz and expires_at=(before_row->>'expires_at')::timestamptz and notification_id=(before_row->>'notification_id')::uuid from public.whatsapp_automation_jobs where id=j),'refusal preserves original attempt deadline identity');
  for label in select unnest(array['reservation_changed','waitlist_changed','voucher_changed','recipient_changed','channel_changed','binding_changed','dispatch_paused','payment_incompatible']) loop
    update public.whatsapp_automation_jobs set state='queued' where id=j;
    x:=public.claim_whatsapp_automation(j); f:=(x->>'claim_token')::uuid;
    perform pg_temp.ok(public.block_whatsapp_automation_preflight(j,f,label),'initial refusal category '||label);
    perform pg_temp.ok((select state=case when label='dispatch_paused' then 'paused' when label='payment_incompatible' then 'blocked' else 'needs_review' end from public.whatsapp_automation_jobs where id=j),'initial mapping '||label);
  end loop;
  update public.whatsapp_automation_jobs set state='queued' where id=j;
  x:=public.claim_whatsapp_automation(j); f:=(x->>'claim_token')::uuid;
  select to_jsonb(z) into before_row from public.whatsapp_automation_jobs z where id=j;
  perform pg_temp.ok(not public.block_whatsapp_automation_preflight(j,null,'reservation_pending') and not public.block_whatsapp_automation_preflight(j,gen_random_uuid(),'reservation_pending'),'null wrong fences no write');
  perform pg_temp.denied(format('select public.block_whatsapp_automation_preflight(%L,%L,''invented'')',j,f),'22023','unknown reason rejected');
  perform pg_temp.ok((select to_jsonb(z)=before_row from public.whatsapp_automation_jobs z where id=j),'initial refused ownership byte snapshot');
  update public.whatsapp_automation_jobs set safe_log_body='Task35 safe render' where id=j;
  perform pg_temp.ok(public.prepare_whatsapp_automation_post(j,f,3,null,e),'operational prepare positive');
  select to_jsonb(z) into before_row from public.whatsapp_automation_jobs z where id=j;
  perform pg_temp.ok(public.confirm_whatsapp_automation_post(j,f,3,null,e),'final readonly operational positive');
  perform pg_temp.ok(not public.prepare_whatsapp_automation_post(j,f,3,null,e),'double prepare refuses posting');
  perform pg_temp.ok(not public.confirm_whatsapp_automation_post(j,null,3,null,e) and not public.confirm_whatsapp_automation_post(j,gen_random_uuid(),3,null,e) and not public.confirm_whatsapp_automation_post(j,f,4,null,e) and not public.confirm_whatsapp_automation_post(j,f,3,null,e+1),'final input fences refuse');
  perform pg_temp.ok(not public.block_whatsapp_automation_preflight(j,f,'reservation_pending'),'initial refusal cannot erase posting');
  perform pg_temp.ok((select to_jsonb(z)=before_row from public.whatsapp_automation_jobs z where id=j),'confirm positive and negative byte readonly');
  perform pg_temp.denied(format('update public.whatsapp_automation_jobs set consent_revision=1 where id=%L',j),'23514','posted consent immutable');
  perform pg_temp.denied(format('update public.whatsapp_automation_jobs set cost_authorization_id=%L where id=%L',gen_random_uuid(),j),'23514','posted cost immutable');
  for label in select unnest(array['lease','dnc','rotation','sync','flag','optout','erasure']) loop
    begin
      if label='lease' then update public.whatsapp_automation_jobs set claimed_until=clock_timestamp()-interval '1 second' where id=j;
      elsif label='dnc' then update public.customers set do_not_contact=true where id=c;
      elsif label='rotation' then update public.whatsapp_channels set credentials='{"task35":"rotation"}' where id=ch;
      elsif label='sync' then update public.whatsapp_remote_templates set sync_epoch=sync_epoch+1,sync_required=true where id=t;
      elsif label='flag' then update public.platform_flags set value='false' where key='whatsapp_automation_dispatch';
      elsif label='optout' then insert into public.whatsapp_message_consent_events(unit_id,customer_id,purpose,decision,source_code,evidence_reference,observed_at) values(u,c,'operational','opt_out','fixture','task35',clock_timestamp());
      else update public.customers set deleted_at=clock_timestamp() where id=c; end if;
      select to_jsonb(z) into x from public.whatsapp_automation_jobs z where id=j;
      perform pg_temp.ok(not public.confirm_whatsapp_automation_post(j,f,3,null,e),'drift refuses '||label);
      perform pg_temp.ok((select to_jsonb(z)=x from public.whatsapp_automation_jobs z where id=j),'drift readonly '||label);
      raise sqlstate 'P0099';
    exception when sqlstate 'P0099' then null; end;
    perform pg_temp.ok(true,'actual drift readonly rollback '||label);
  end loop;
  update public.customers set deleted_at=clock_timestamp() where id=c;
  perform pg_temp.ok((select customer_id is null and customer_erased_at is not null and pin_phase='preconfiguration' and error_code='customer_not_alive' from public.whatsapp_automation_jobs where id=j1),'erased incomplete remains representable');
end $$;
do $$ declare role_name text; signature text; begin
  foreach role_name in array array['anon','authenticated','service_role'] loop
    foreach signature in array array['public.confirm_whatsapp_automation_post(uuid,uuid,bigint,bigint,bigint)','public.block_whatsapp_automation_preflight(uuid,uuid,text)'] loop
      perform pg_temp.ok(has_function_privilege(role_name,signature,'EXECUTE')=(role_name='service_role'),'actual RPC ACL '||role_name||signature);
    end loop;
    perform pg_temp.ok(not has_function_privilege(role_name,'app_private.whatsapp_automation_post_core(uuid,uuid,bigint,bigint,bigint,boolean)','EXECUTE'),'private core ACL '||role_name);
    perform pg_temp.ok(not has_function_privilege(role_name,'app_private.consume_whatsapp_automation_pin_initialization(uuid,app_private.whatsapp_automation_pin_tuple,app_private.whatsapp_automation_pin_tuple)','EXECUTE'),'private permit ACL '||role_name);
    perform pg_temp.ok(not has_type_privilege(role_name,'app_private.whatsapp_automation_pin_tuple','USAGE'),'private type ACL '||role_name);
    perform pg_temp.ok(not has_table_privilege(role_name,'app_private.whatsapp_automation_pin_initialization_permits','SELECT,INSERT,UPDATE,DELETE'),'private table ACL '||role_name);
  end loop;
  perform pg_temp.ok((select relrowsecurity and relforcerowsecurity from pg_class where oid='app_private.whatsapp_automation_pin_initialization_permits'::regclass),'private permit FORCE RLS');
  perform pg_temp.ok(not exists(select from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x where p.oid in('public.confirm_whatsapp_automation_post(uuid,uuid,bigint,bigint,bigint)'::regprocedure,'public.block_whatsapp_automation_preflight(uuid,uuid,text)'::regprocedure,'app_private.whatsapp_automation_post_core(uuid,uuid,bigint,bigint,bigint,boolean)'::regprocedure,'app_private.consume_whatsapp_automation_pin_initialization(uuid,app_private.whatsapp_automation_pin_tuple,app_private.whatsapp_automation_pin_tuple)'::regprocedure) and x.grantee=0),'PUBLIC has no execute on new public/private functions');
  perform pg_temp.ok(not exists(select from pg_type p cross join lateral aclexplode(coalesce(p.typacl,acldefault('T',p.typowner))) x where p.oid='app_private.whatsapp_automation_pin_tuple'::regtype and x.grantee=0),'PUBLIC has no private type usage');
end $$;
-- Exercise the real CHECK expressions independently of the BEFORE trigger.
-- LIKE copies CHECKs/NOT NULL, not triggers: a trigger refusal cannot hide a
-- three-valued-logic hole in the closed tuple constraint.
create temp table tuple_probe (like public.whatsapp_automation_jobs including constraints);
do $$ declare
  row_data jsonb; candidate jsonb; field text; mask integer; bit integer; accepted boolean;
  fields text[]:=array['channel_id','provider','transport','initial_credential_revision','binding_id','binding_generation','account_id','remote_template_id','template_version','sync_epoch'];
begin
  select to_jsonb(j) into row_data from public.whatsapp_automation_jobs j where pin_phase='bound' limit 1;
  perform pg_temp.ok(row_data is not null,'tuple matrix has positive bound fixture');
  row_data:=row_data||jsonb_build_object('state','blocked','attempts',0,'claim_token',null,'claimed_until',null,'posting_started_at',null,'provider_message_id',null,'safe_log_body',null,'consent_revision',null,'cost_authorization_id',null,'reconcile_required',false);
  for mask in 0..1023 loop
    candidate:=row_data||'{"pin_phase":"preconfiguration"}'::jsonb;
    for bit in 1..10 loop
      if (mask & (1 << (bit-1)))=0 then candidate:=candidate||jsonb_build_object(fields[bit],null); end if;
    end loop;
    accepted:=false;
    begin
      insert into tuple_probe select (jsonb_populate_record(null::public.whatsapp_automation_jobs,candidate)).*;
      accepted:=true;
    exception when check_violation or not_null_violation then null; end;
    perform pg_temp.ok(accepted=(mask in(0,15,127)),'actual incomplete tuple NULL mask '||mask);
    delete from tuple_probe;
  end loop;
  foreach field in array array['channel_id','provider','transport','binding_id','binding_generation','account_id','remote_template_id','template_version','sync_epoch'] loop
    candidate:=row_data||jsonb_build_object(field,null);
    perform pg_temp.denied(format('insert into tuple_probe select (jsonb_populate_record(null::public.whatsapp_automation_jobs,%L::jsonb)).*',candidate),'23514','bound NULL hole '||field);
  end loop;
  insert into tuple_probe select (jsonb_populate_record(null::public.whatsapp_automation_jobs,row_data||'{"initial_credential_revision":null,"initial_catalog_key":null}'::jsonb)).*;
  perform pg_temp.ok(true,'historical bound anchors may remain NULL');
end $$;

-- Promotion must authorize its OWN reserved slot and EXACT captured cost row.
do $$ declare
  o uuid:=gen_random_uuid(); u uuid:=gen_random_uuid(); c uuid:=gen_random_uuid(); actor uuid:=gen_random_uuid();
  ch uuid:=gen_random_uuid(); a uuid:=gen_random_uuid(); b uuid:=gen_random_uuid(); t uuid:=gen_random_uuid(); v uuid:=gen_random_uuid();
  j uuid; f uuid; cost uuid; alternate uuid; actor2 uuid:=gen_random_uuid(); x jsonb; before_state jsonb; after_state jsonb; e bigint; label text; core_body text; mutated_body text;
begin
  insert into auth.users(id) values(actor); insert into public.platform_admins values(actor);
  insert into public.organizations(id,name) values(o,'Task35 promotion'); insert into public.units(id,organization_id,name) values(u,o,'Task35 promotion');
  insert into public.customers(id,organization_id,name,phone) values(c,o,'Synthetic','11999993537');
  insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,last_health_check_at) values(ch,u,'datafy','connected',true,clock_timestamp());
  insert into public.whatsapp_template_accounts(id,organization_id,waba_id,verified_at) values(a,o,'3535353537',clock_timestamp());
  insert into public.whatsapp_template_bindings(id,unit_id,channel_id,account_id,provider,verified_at) values(b,u,ch,a,'datafy',clock_timestamp());
  perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',actor)::text,true);
  update public.whatsapp_template_bindings set adopted_at=clock_timestamp(),dispatch_enabled=true where id=b;
  insert into public.platform_flags(key,value) values('whatsapp_automation_dispatch','true') on conflict(key) do update set value=excluded.value;
  insert into public.whatsapp_remote_templates(id,account_id,logical_id,version,language,name,desired_hash,requested_category,binding_generation) values(t,a,'mkt_voucher_programado_v1',1,'pt_BR','mkt_voucher_programado_v1',repeat('b',64),'MARKETING',1);
  x:=public.begin_whatsapp_template_sync(a);
  perform pg_temp.ok(public.publish_whatsapp_template_sync(a,1,x,jsonb_build_array(jsonb_build_object('id',t,'remote_id','task35-promo','name','mkt_voucher_programado_v1','language','pt_BR','observed_hash',repeat('b',64),'effective_category','MARKETING','remote_status','APPROVED','quality','GREEN'))),'promotion current publication');
  select sync_epoch into e from public.whatsapp_remote_templates where id=t;
  insert into public.vouchers(id,unit_id,customer_id) values(v,u,c);
  insert into public.whatsapp_message_consent_events(unit_id,customer_id,purpose,decision,source_code,evidence_reference,observed_at) values(u,c,'promotional','opt_in','fixture','task35-promo',clock_timestamp());
  begin
    insert into public.whatsapp_template_cost_authorizations(account_id,binding_id,binding_generation,category,valid_from,valid_until,actor_id) values(a,b,1,'MARKETING',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 second',actor) returning id into cost;
    j:=public.enqueue_whatsapp_automation(jsonb_build_object('unit_id',u,'kind','voucher_issued','voucher_id',v,'source_event_key','task35-expiry','fact_at',clock_timestamp(),'expires_at',clock_timestamp()+interval '1 hour'));
    x:=public.claim_whatsapp_automation(j); f:=(x->>'claim_token')::uuid;
    update public.whatsapp_automation_jobs set safe_log_body='Synthetic expiry render' where id=j;
    perform pg_temp.ok(public.prepare_whatsapp_automation_post(j,f,1,1,e),'short cost actual prepare');
    perform pg_temp.ok(public.confirm_whatsapp_automation_post(j,f,1,1,e),'short cost live positive');
    insert into public.whatsapp_template_cost_authorizations(account_id,binding_id,binding_generation,category,valid_from,valid_until,actor_id) values(a,b,1,'MARKETING',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '3 hours',actor) returning id into alternate;
    perform pg_sleep(1.1);
    perform pg_temp.ok((select claimed_until>clock_timestamp() and expires_at>clock_timestamp() and cost_authorization_id=cost from public.whatsapp_automation_jobs where id=j),'cost expiry isolated from live job lease and TTL');
    perform pg_temp.ok((select valid_until>clock_timestamp() from public.whatsapp_template_cost_authorizations where id=alternate),'alternate cost remains valid');
    before_state:=jsonb_build_object('job',(select to_jsonb(z) from public.whatsapp_automation_jobs z where id=j),'slot',(select to_jsonb(z) from public.whatsapp_promotion_slots z where job_id=j));
    perform pg_temp.ok(not public.confirm_whatsapp_automation_post(j,f,1,1,e),'expired captured cost refuses despite valid alternate');
    after_state:=jsonb_build_object('job',(select to_jsonb(z) from public.whatsapp_automation_jobs z where id=j),'slot',(select to_jsonb(z) from public.whatsapp_promotion_slots z where job_id=j));
    perform pg_temp.ok(before_state=after_state,'actual cost expiry byte readonly');
    -- Positive mutation control: regress the actual shared core to accepting
    -- an alternate cost (lookup + identity), keeping all other eligibility and
    -- the real SQL clock. The unchanged expiry assertion above must catch it.
    -- MAIN110 keeps private6 as a SQL wrapper; the algorithm is private7.
    core_body:=pg_get_functiondef('app_private.whatsapp_automation_post_core(uuid,uuid,bigint,bigint,bigint,boolean,jsonb)'::regprocedure);
    mutated_body:=replace(core_body,'where id=j.cost_authorization_id for share;',format('where id=%L::uuid for share;',alternate));
    perform pg_temp.ok(mutated_body<>core_body,'captured-cost mutation targets actual private lookup');
    perform pg_temp.ok(position('(p_confirm_only and ca.id is distinct from j.cost_authorization_id)' in mutated_body)>0,'captured-cost mutation targets actual private identity');
    mutated_body:=replace(mutated_body,'(p_confirm_only and ca.id is distinct from j.cost_authorization_id)','false');
    perform pg_temp.ok(mutated_body<>core_body,'captured-cost mutation targets actual private core');
    execute mutated_body;
    perform pg_temp.ok(public.confirm_whatsapp_automation_post(j,f,1,1,e),'control: alternate lookup would wrongly authorize expired captured cost');
    raise sqlstate 'P0099';
  exception when sqlstate 'P0099' then null; end;
  perform pg_temp.ok(pg_get_functiondef('app_private.whatsapp_automation_post_core(uuid,uuid,bigint,bigint,bigint,boolean,jsonb)'::regprocedure)=core_body,'captured-cost mutation restores actual private algorithm');
  perform pg_temp.ok(true,'actual captured cost expiry control completed and rolled back');
  insert into public.whatsapp_template_cost_authorizations(account_id,binding_id,binding_generation,category,valid_from,valid_until,actor_id) values(a,b,1,'MARKETING',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '2 hours',actor) returning id into cost;
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  j:=public.enqueue_whatsapp_automation(jsonb_build_object('unit_id',u,'kind','voucher_issued','voucher_id',v,'source_event_key','task35-promo','fact_at',clock_timestamp(),'expires_at',clock_timestamp()+interval '1 hour'));
  x:=public.claim_whatsapp_automation(j); f:=(x->>'claim_token')::uuid;
  update public.whatsapp_automation_jobs set safe_log_body='Synthetic promotion render' where id=j;
  perform pg_temp.ok(public.prepare_whatsapp_automation_post(j,f,1,1,e),'promotion prepare positive');
  perform pg_temp.ok((select cost_authorization_id=cost and attempts=1 from public.whatsapp_automation_jobs where id=j),'exact cost captured');
  before_state:=jsonb_build_object('job',(select to_jsonb(z) from public.whatsapp_automation_jobs z where id=j),'slot',(select to_jsonb(z) from public.whatsapp_promotion_slots z where job_id=j));
  perform pg_temp.ok(public.confirm_whatsapp_automation_post(j,f,1,1,e),'own posting slot is not a frequency blocker');
  after_state:=jsonb_build_object('job',(select to_jsonb(z) from public.whatsapp_automation_jobs z where id=j),'slot',(select to_jsonb(z) from public.whatsapp_promotion_slots z where job_id=j));
  perform pg_temp.ok(before_state=after_state,'positive confirm job and slot byte readonly');
  insert into auth.users(id) values(actor2); insert into public.platform_admins values(actor2);
  perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',actor2)::text,true);
  insert into public.whatsapp_template_cost_authorizations(account_id,binding_id,binding_generation,category,valid_from,valid_until,actor_id) values(a,b,1,'MARKETING',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '3 hours',actor2) returning id into alternate;
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  for label in select unnest(array['captured_actor_removed','consent_revision','consent_optout','quality_red','template_pending','hash','category','publication_age','publication_revision','publication_generation','slot_lease','slot_state','flag_unknown','flag_off','channel_stale','binding_disabled']) loop
    begin
      if label='captured_actor_removed' then
        delete from public.platform_admins where user_id=actor;
        perform pg_temp.ok(exists(select from public.whatsapp_template_cost_authorizations ca join public.platform_admins pa on pa.user_id=ca.actor_id where ca.id=alternate and ca.valid_until>clock_timestamp()),'alternate cost actor stays currently authorized');
      elsif label='consent_revision' then insert into public.whatsapp_message_consent_events(unit_id,customer_id,purpose,decision,source_code,evidence_reference,observed_at) values(u,c,'promotional','opt_in','fixture','new-revision',clock_timestamp());
      elsif label='consent_optout' then insert into public.whatsapp_message_consent_events(unit_id,customer_id,purpose,decision,source_code,evidence_reference,observed_at) values(u,c,'promotional','opt_out','fixture','optout',clock_timestamp());
      elsif label='quality_red' then update public.whatsapp_remote_templates set quality='RED' where id=t;
      elsif label='template_pending' then update public.whatsapp_remote_templates set remote_status='PENDING' where id=t;
      elsif label='hash' then update public.whatsapp_remote_templates set observed_hash=repeat('c',64) where id=t;
      elsif label='category' then update public.whatsapp_remote_templates set effective_category='UTILITY' where id=t;
      elsif label='publication_age' then update public.whatsapp_template_accounts set last_sync_published_at=clock_timestamp()-interval '61 seconds' where id=a;
      elsif label='publication_revision' then update public.whatsapp_template_accounts set sync_credential_revision=99 where id=a;
      elsif label='publication_generation' then update public.whatsapp_template_accounts set sync_binding_generation=99 where id=a;
      elsif label='slot_lease' then update public.whatsapp_promotion_slots set claimed_until=clock_timestamp()-interval '1 second' where job_id=j;
      elsif label='slot_state' then update public.whatsapp_promotion_slots set state='uncertain' where job_id=j;
      elsif label='flag_unknown' then update public.platform_flags set value='"unknown"' where key='whatsapp_automation_dispatch';
      elsif label='flag_off' then update public.platform_flags set value='false' where key='whatsapp_automation_dispatch';
      elsif label='channel_stale' then update public.whatsapp_channels set last_health_check_at=clock_timestamp()-interval '6 minutes' where id=ch;
      elsif label='binding_disabled' then update public.whatsapp_template_bindings set dispatch_enabled=false where id=b;
      end if;
      before_state:=jsonb_build_object('job',(select to_jsonb(z) from public.whatsapp_automation_jobs z where id=j),'slot',(select to_jsonb(z) from public.whatsapp_promotion_slots z where job_id=j));
      if label='flag_unknown' then
        perform pg_temp.denied(format('select public.confirm_whatsapp_automation_post(%L,%L,1,1,%s)',j,f,e),'PT503','unknown flag observable dependency');
      else
        perform pg_temp.ok(not public.confirm_whatsapp_automation_post(j,f,1,1,e),'promotion drift refuses '||label);
      end if;
      after_state:=jsonb_build_object('job',(select to_jsonb(z) from public.whatsapp_automation_jobs z where id=j),'slot',(select to_jsonb(z) from public.whatsapp_promotion_slots z where job_id=j));
      perform pg_temp.ok(before_state=after_state,'promotion refused byte readonly '||label);
      raise sqlstate 'P0099';
    exception when sqlstate 'P0099' then null; end;
    perform pg_temp.ok(public.confirm_whatsapp_automation_post(j,f,1,1,e),'positive restored after drift '||label);
  end loop;
end $$;
-- Isolate SQL wall-clock expiry and historical revision using a real TEXT job.
do $$ declare
  o uuid:=gen_random_uuid(); u uuid:=gen_random_uuid(); c uuid:=gen_random_uuid(); actor uuid:=gen_random_uuid();
  ch uuid:=gen_random_uuid(); b uuid:=gen_random_uuid(); r uuid; j uuid; f uuid; x jsonb; before_row jsonb; label text;
begin
  insert into auth.users(id) values(actor); insert into public.platform_admins values(actor);
  insert into public.organizations(id,name) values(o,'Task35 clock'); insert into public.units(id,organization_id,name) values(u,o,'Task35 clock');
  insert into public.customers(id,organization_id,name,phone) values(c,o,'Synthetic','11999993538');
  insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,last_health_check_at) values(ch,u,'zapi','connected',true,clock_timestamp());
  insert into public.whatsapp_template_bindings(id,unit_id,channel_id,provider) values(b,u,ch,'zapi');
  perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',actor)::text,true);
  update public.whatsapp_template_bindings set adopted_at=clock_timestamp(),dispatch_enabled=true where id=b;
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  begin
    delete from public.platform_flags where key='whatsapp_automation_dispatch';
    r:=gen_random_uuid(); insert into public.reservations(id,unit_id,customer_id) values(r,u,c);
    j:=public.enqueue_whatsapp_automation(jsonb_build_object('unit_id',u,'kind','reminder_d1','reservation_id',r,'source_event_key','task35-missing-flag','fact_at',clock_timestamp(),'expires_at',clock_timestamp()+interval '1 hour'));
    perform pg_temp.ok((select state='paused' and pin_phase='bound' from public.whatsapp_automation_jobs where id=j),'absent flag records bound paused');
    insert into public.platform_flags(key,value) values('whatsapp_automation_dispatch','"malformed"');
    r:=gen_random_uuid(); insert into public.reservations(id,unit_id,customer_id) values(r,u,c);
    perform pg_temp.denied(format('select public.enqueue_whatsapp_automation(%L::jsonb)',jsonb_build_object('unit_id',u,'kind','reminder_d1','reservation_id',r,'source_event_key','task35-malformed-flag','fact_at',clock_timestamp(),'expires_at',clock_timestamp()+interval '1 hour')),'PT503','malformed enqueue gate observable refusal');
    perform pg_temp.ok(not exists(select from public.whatsapp_automation_jobs where reservation_id=r),'dependency error invents no ledger or pins');
    raise sqlstate 'P0099';
  exception when sqlstate 'P0099' then null; end;
  perform pg_temp.ok(true,'missing versus malformed flag controls completed with rollback');
  for label in select unnest(array['expired_lease','provider_id','initial_ttl','confirm_ttl','historical_revision']) loop
    r:=gen_random_uuid(); insert into public.reservations(id,unit_id,customer_id) values(r,u,c);
    j:=public.enqueue_whatsapp_automation(jsonb_build_object('unit_id',u,'kind','reminder_d1','reservation_id',r,'source_event_key','task35-clock','fact_at',clock_timestamp(),'expires_at',clock_timestamp()+case when label in('initial_ttl','confirm_ttl') then interval '1 second' else interval '1 hour' end));
    x:=public.claim_whatsapp_automation(j); f:=(x->>'claim_token')::uuid;
    if label='expired_lease' then update public.whatsapp_automation_jobs set claimed_until=clock_timestamp()-interval '1 second' where id=j;
    elsif label='provider_id' then update public.whatsapp_automation_jobs set provider_message_id='task35-existing-id' where id=j;
    elsif label in('confirm_ttl','historical_revision') then
      update public.whatsapp_automation_jobs set safe_log_body='Synthetic clock render' where id=j;
      perform pg_temp.ok(public.prepare_whatsapp_automation_post(j,f,1,null,null),'text prepare positive '||label);
      perform pg_temp.ok(public.confirm_whatsapp_automation_post(j,f,1,null,null),'text confirm positive '||label);
    end if;
    if label in('initial_ttl','confirm_ttl') then perform pg_sleep(1.1); end if;
    select to_jsonb(z) into before_row from public.whatsapp_automation_jobs z where id=j;
    if label='initial_ttl' then
      perform pg_temp.ok(public.block_whatsapp_automation_preflight(j,f,'reservation_pending'),'original TTL dominates requested refusal');
      perform pg_temp.ok((select state='expired' and error_code='expired' and attempts=0 and expires_at=(before_row->>'expires_at')::timestamptz and fact_at=(before_row->>'fact_at')::timestamptz and due_at=(before_row->>'due_at')::timestamptz and notification_id=(before_row->>'notification_id')::uuid from public.whatsapp_automation_jobs where id=j),'initial expiry preserves fact deadline due notification attempts');
    elsif label='historical_revision' then
      update public.whatsapp_channels set credentials='{"fixture_revision":1}' where id=ch;
      perform pg_temp.ok(not public.confirm_whatsapp_automation_post(j,f,1,null,null),'rotation before current verification refuses');
      -- SQL prerequisite fixture only, not proof of Task13 authenticated action.
      update public.whatsapp_template_bindings set channel_credential_revision=1,verified_at=clock_timestamp() where id=b;
      perform pg_temp.ok(public.confirm_whatsapp_automation_post(j,f,1,null,null),'effective verified binding allows immutable historical revision zero');
      perform pg_temp.ok((select initial_credential_revision=0 and to_jsonb(z)=before_row from public.whatsapp_automation_jobs z where id=j),'historical fact stays zero and confirm readonly');
    else
      if label='confirm_ttl' then
        perform pg_temp.ok((select claimed_until>clock_timestamp() from public.whatsapp_automation_jobs where id=j),'TTL expiry isolated from live lease');
        perform pg_temp.ok(not public.confirm_whatsapp_automation_post(j,f,1,null,null),'strict original TTL final confirm refusal');
      else perform pg_temp.ok(not public.block_whatsapp_automation_preflight(j,f,'reservation_pending'),'initial ownership refusal '||label); end if;
      perform pg_temp.ok((select to_jsonb(z)=before_row from public.whatsapp_automation_jobs z where id=j),'refusal zero writes '||label);
    end if;
  end loop;
  perform pg_temp.ok(not exists(select from public.notifications_sent where unit_id=u),'expiry never writes notification');
end $$;

-- Structural rollback is a separate proof from identical-content application.
-- Observe actual transactional removal of new structure, then byte-for-byte
-- restoration of function body, EXECUTE ACL, CHECK and column default.
set constraints all immediate;
do $$ declare before_state jsonb; after_state jsonb; begin
  select jsonb_build_object('body',pg_get_functiondef('public.confirm_whatsapp_automation_post(uuid,uuid,bigint,bigint,bigint)'::regprocedure),
    'acl',(select proacl::text from pg_proc where oid='public.confirm_whatsapp_automation_post(uuid,uuid,bigint,bigint,bigint)'::regprocedure),
    'check',(select pg_get_constraintdef(oid) from pg_constraint where conrelid='public.whatsapp_automation_jobs'::regclass and conname='whatsapp_automation_pin_tuple_check'),
    'default',(select pg_get_expr(d.adbin,d.adrelid) from pg_attrdef d join pg_attribute a on a.attrelid=d.adrelid and a.attnum=d.adnum where a.attrelid='public.whatsapp_automation_jobs'::regclass and a.attname='pin_phase')) into before_state;
  begin
    drop function public.confirm_whatsapp_automation_post(uuid,uuid,bigint,bigint,bigint);
    alter table public.whatsapp_automation_jobs drop constraint whatsapp_automation_pin_tuple_check;
    alter table public.whatsapp_automation_jobs alter column pin_phase drop default;
    perform pg_temp.ok(to_regprocedure('public.confirm_whatsapp_automation_post(uuid,uuid,bigint,bigint,bigint)') is null and not exists(select from pg_constraint where conrelid='public.whatsapp_automation_jobs'::regclass and conname='whatsapp_automation_pin_tuple_check'),'structural rollback control really removed function and CHECK');
    raise sqlstate 'P0099';
  exception when sqlstate 'P0099' then null; end;
  select jsonb_build_object('body',pg_get_functiondef('public.confirm_whatsapp_automation_post(uuid,uuid,bigint,bigint,bigint)'::regprocedure),
    'acl',(select proacl::text from pg_proc where oid='public.confirm_whatsapp_automation_post(uuid,uuid,bigint,bigint,bigint)'::regprocedure),
    'check',(select pg_get_constraintdef(oid) from pg_constraint where conrelid='public.whatsapp_automation_jobs'::regclass and conname='whatsapp_automation_pin_tuple_check'),
    'default',(select pg_get_expr(d.adbin,d.adrelid) from pg_attrdef d join pg_attribute a on a.attrelid=d.adrelid and a.attnum=d.adnum where a.attrelid='public.whatsapp_automation_jobs'::regclass and a.attname='pin_phase')) into after_state;
  perform pg_temp.ok(before_state=after_state,'structural transaction rollback restores actual body ACL CHECK and default');
end $$;
select count(*) as passed from checks;
rollback;
