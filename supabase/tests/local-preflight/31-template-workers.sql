\set ON_ERROR_STOP on
begin;
create function pg_temp.assert_true(v boolean,label text) returns void language plpgsql as $$begin if v is distinct from true then raise exception 'FAIL: %',label; end if; end$$;
select pg_temp.assert_true(to_regprocedure('public.bind_whatsapp_template_account(uuid,uuid,text,bigint,text,text)') is not null,'verified binding RPC exists');
create temp table worker_checks(label text);
create function pg_temp.ok(v boolean,label text) returns void language plpgsql as $$begin perform pg_temp.assert_true(v,label); insert into worker_checks values(label); end$$;
create function pg_temp.denied(q text,code text,label text) returns void language plpgsql as $$begin begin execute q; exception when others then if sqlstate=code then perform pg_temp.ok(true,label); return; end if; raise; end; raise exception 'FAIL: % allowed',label; end$$;
do $$ declare
  c uuid:=gen_random_uuid(); c2 uuid:=gen_random_uuid(); foreign_c uuid:=gen_random_uuid(); v uuid:=gen_random_uuid(); claim uuid:=gen_random_uuid();
  a uuid; b uuid; admin uuid:=gen_random_uuid(); t uuid:=gen_random_uuid(); x jsonb; y jsonb; snap jsonb; j uuid; j2 uuid; f uuid; rev bigint; secret_id uuid; secret2 uuid; marker timestamptz; p record;
begin
  insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,credentials,last_health_check_at) values
    (c,'bbbbbbbb-0000-0000-0000-000000000001','datafy','connected',false,'{"phone_number_id":"111"}',clock_timestamp()),
    (c2,'bbbbbbbb-0000-0000-0000-000000000002','datafy','connected',false,'{"phone_number_id":"222"}',clock_timestamp()),
    (foreign_c,'bbbbbbbb-0000-0000-0000-000000000003','datafy','connected',false,'{"phone_number_id":"333"}',clock_timestamp());
  x:=public.bind_whatsapp_template_account(c,'bbbbbbbb-0000-0000-0000-000000000001','datafy',0,'111','310001'); a:=(x->>'accountId')::uuid;
  select id into b from public.whatsapp_template_bindings where channel_id=c;
  perform pg_temp.ok(a is not null and (select not dispatch_enabled and adopted_at is null and submission_authorized_at is null from public.whatsapp_template_bindings where id=b),'inactive connected preparation enables nothing');
  update public.platform_flags set value='false' where key='whatsapp_template_catalog';
  perform pg_temp.ok(not exists(select from public.select_due_whatsapp_template_accounts(20) where id=a),'catalog OFF fresh verified account cannot list remotely');
  perform pg_temp.ok((public.bind_whatsapp_template_account(c2,'bbbbbbbb-0000-0000-0000-000000000002','datafy',0,'222','310001')->>'accountId')::uuid=a,'same org shares global WABA');
  perform pg_temp.denied(format('select public.bind_whatsapp_template_account(%L,%L,%L,0,%L,%L)',foreign_c,'bbbbbbbb-0000-0000-0000-000000000003','datafy','333','310001'),'42501','cross org WABA refused uniformly');
  perform pg_temp.denied(format('select public.bind_whatsapp_template_account(%L,%L,%L,0,%L,%L)',c,'bbbbbbbb-0000-0000-0000-000000000001','datafy','forged','310001'),'42501','phone anchor checked transactionally');
  perform pg_temp.denied(format('select public.bind_whatsapp_template_account(%L,%L,%L,0,%L,%L)',c,'bbbbbbbb-0000-0000-0000-000000000001','datafy','111','310002'),'42501','no implicit WABA rebind');
  perform pg_temp.ok(not exists(select from public.whatsapp_template_accounts where waba_id='310002'),'refused discovery leaves no account');
  perform pg_temp.denied(format('update public.whatsapp_channels set template_credential_revision=123 where id=%L',c),'23514','revision cannot be forged');
  update public.whatsapp_channels set credentials=credentials||'{"access_token":"fake-rotation"}' where id=c;
  perform pg_temp.ok((select template_credential_revision=1 from public.whatsapp_channels where id=c),'credential rotation advances revision atomically');
  perform pg_temp.denied(format('select public.bind_whatsapp_template_account(%L,%L,%L,0,%L,%L)',c,'bbbbbbbb-0000-0000-0000-000000000001','datafy','111','310001'),'42501','stale discovery pin refused');
  perform pg_temp.ok(public.reconcile_whatsapp_template_credentials(c),'ordered followup invalidates');
  perform pg_temp.ok(not public.reconcile_whatsapp_template_credentials(c),'followup is idempotent');
  perform pg_temp.ok((select generation=2 and verified_at is null and not dispatch_enabled from public.whatsapp_template_bindings where id=b),'verification and authorizations cleared');
  perform public.bind_whatsapp_template_account(c,'bbbbbbbb-0000-0000-0000-000000000001','datafy',1,'111','310001');
  -- Keep one selected binding for deterministic capture assertions.
  update public.whatsapp_template_bindings set verified_at=null where channel_id=c2;
  insert into public.whatsapp_remote_templates(id,account_id,logical_id,version,language,name,desired_hash,requested_category,binding_generation)
    values(t,a,'res_confirmacao_v1',1,'pt_BR','res_confirmacao_v1',repeat('a',64),'UTILITY',2);
  snap:=jsonb_build_array(jsonb_build_object('id',t,'remote_id',null,'name','res_confirmacao_v1','language','pt_BR','observed_hash',null,'effective_category',null,'remote_status','UNKNOWN','quality',null));
  j:=public.request_whatsapp_template_sync(a);
  perform pg_temp.ok(public.request_whatsapp_template_sync(a)=j,'pending sync coalesces');
  x:=public.claim_whatsapp_template_job(j); f:=(x->>'claim_token')::uuid;
  x:=public.begin_whatsapp_template_sync(a); y:=public.begin_whatsapp_template_sync(a);
  perform pg_temp.ok(x->>'capture_id'<>y->>'capture_id','every begin has distinct capture');
  perform pg_temp.ok(not public.publish_whatsapp_template_sync(a,2,x,snap),'older GET cannot borrow newer capture');
  perform pg_temp.ok(not public.publish_whatsapp_template_sync(a,2,y->'templates',snap),'legacy array capture refused');
  perform pg_temp.ok(not public.publish_whatsapp_template_sync(a,2,y||jsonb_build_object('credential_revision',999),snap),'forged revision refused');
  perform pg_temp.ok(public.publish_whatsapp_template_sync(a,2,y,snap),'complete current captured GET publishes');
  perform pg_temp.ok((select remote_status='UNKNOWN' and local_status='pending' and observed_hash is null from public.whatsapp_remote_templates where id=t),'unknown absent proof matches pure pending diagnostic');
  perform pg_temp.ok(public.complete_whatsapp_template_sync_job(j,f,true,'template_synced'),'sync complete after current publish');
  select reconciliation_revision into rev from public.whatsapp_template_accounts where id=a;
  update public.whatsapp_template_accounts set last_sync_requested_at=clock_timestamp()-interval '6 minutes' where id=a;
  perform pg_temp.ok(exists(select from public.select_due_whatsapp_template_accounts(20) where id=a),'five minute sync is due without a new event');
  j2:=public.request_whatsapp_template_sync(a);
  perform pg_temp.ok(j2<>j and (select reconciliation_revision=rev+1 from public.whatsapp_template_accounts where id=a),'completed sync gets fresh monotonic revision without event');
  x:=public.claim_whatsapp_template_job(j2); f:=(x->>'claim_token')::uuid;
  x:=public.begin_whatsapp_template_sync(a);
  perform pg_temp.ok(public.complete_whatsapp_template_sync_job(j2,f,false,'template_get_failed'),'GET failure observably fails claim');
  perform pg_temp.ok((select sync_required from public.whatsapp_remote_templates where id=t),'GET failure never clears sync_required');
  perform pg_temp.ok((public.whatsapp_template_pipeline_health()->>'failed')::integer>=1,'failed count observable');
  insert into auth.users(id) values(admin); insert into public.platform_admins values(admin);
  perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',admin)::text,true);
  update public.whatsapp_template_bindings set submission_authorized_at=clock_timestamp(),submission_authorized_by=admin where id=b;
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  update public.platform_flags set value='true' where key='whatsapp_template_catalog';
  j:=public.enqueue_whatsapp_template_job(b,'provision','res_confirmacao_v1',1);
  x:=public.claim_whatsapp_template_job(j); f:=(x->>'claim_token')::uuid;
  x:=public.begin_whatsapp_template_sync(a);
  perform pg_temp.ok(public.publish_whatsapp_template_sync(a,2,x,snap),'current missing snapshot before CREATE');
  perform pg_temp.ok(public.prepare_whatsapp_template_provision(j,f,2),'inactive channel may CREATE catalog');
  perform pg_temp.ok(not public.prepare_whatsapp_template_provision(j,f,2),'same claimed object cannot start twice');
  y:=(select jsonb_build_object('lease',claimed_until,'attempts',attempts,'capture',post_capture_id) from public.whatsapp_template_jobs where id=j);
  perform pg_temp.ok(public.confirm_whatsapp_template_post(j,f,2),'final current fence confirms');
  perform pg_temp.ok(not public.confirm_whatsapp_template_post(j,gen_random_uuid(),2),'confirm rejects foreign fence');
  perform pg_temp.ok((select jsonb_build_object('lease',claimed_until,'attempts',attempts,'capture',post_capture_id)=y from public.whatsapp_template_jobs where id=j),'confirm neither renews nor consumes');
  perform pg_temp.denied(format('update public.whatsapp_template_jobs set post_capture_id=%L where id=%L',gen_random_uuid(),j),'23514','posted capture cannot be forged');
  perform pg_temp.denied(format('update public.whatsapp_template_jobs set post_capture_id=null where id=%L',j),'23514','posted capture cannot be cleared');
  update public.platform_flags set value='false' where key='whatsapp_template_catalog';
  perform pg_temp.ok(not public.confirm_whatsapp_template_post(j,f,2),'confirm rechecks current flag');
  update public.platform_flags set value='true' where key='whatsapp_template_catalog';
  x:=public.begin_whatsapp_template_sync(a);
  perform pg_temp.ok(not public.confirm_whatsapp_template_post(j,f,2),'new begin invalidates posting capture');
  perform public.publish_whatsapp_template_sync(a,2,x,snap);
  perform pg_temp.ok(not public.confirm_whatsapp_template_post(j,f,2),'new complete GET cannot replace original POST capture');
  select submission_attempted_at into marker from public.whatsapp_remote_templates where id=t;
  perform pg_temp.ok(marker is not null,'first potential submission preserved independent job retention');
  perform pg_temp.denied(format('update public.whatsapp_template_jobs set posting_started_at=null,state=%L where id=%L','paused',j),'23514','direct zeroPOST reset denied');
  perform pg_temp.ok(not public.finish_whatsapp_template_job(j,gen_random_uuid(),'{"outcome":"local_preflight_refused","reason":"final_gate_paused"}'),'wrong fence refuses reset');
  perform pg_temp.ok(public.finish_whatsapp_template_job(j,f,'{"outcome":"local_preflight_refused","reason":"final_gate_paused"}'),'known zeroPOST finishes without ambiguity');
  perform pg_temp.ok((select state='paused' and attempts=0 and posting_started_at is null and claim_token is null and post_capture_id is null from public.whatsapp_template_jobs where id=j),'zeroPOST preserves zero network attempts');
  perform pg_temp.ok((select submission_attempted_at=marker from public.whatsapp_remote_templates where id=t),'zeroPOST retains conservative historical fence');
  j2:=public.enqueue_whatsapp_template_job(b,'provision','res_confirmacao_v1',2); x:=public.claim_whatsapp_template_job(j2); f:=(x->>'claim_token')::uuid;
  perform pg_temp.ok(not public.prepare_whatsapp_template_provision(j2,f,2),'new revision cannot bypass previous attempted submission');
  perform pg_temp.ok((select state='needs_review' from public.whatsapp_template_jobs where id=j2),'historical refusal requires review');
  -- Current exact content can be reused independently of approval; no POST/attempt.
  j2:=public.enqueue_whatsapp_template_job(b,'provision','res_confirmacao_v1',3); x:=public.claim_whatsapp_template_job(j2); f:=(x->>'claim_token')::uuid;
  snap:=jsonb_build_array(jsonb_build_object('id',t,'remote_id','310099','name','res_confirmacao_v1','language','pt_BR','observed_hash',repeat('a',64),'effective_category','UTILITY','remote_status','REJECTED','quality','RED'));
  x:=public.begin_whatsapp_template_sync(a); perform public.publish_whatsapp_template_sync(a,2,x,snap);
  perform pg_temp.ok(not public.prepare_whatsapp_template_provision(j2,f,2),'exact existing model avoids POST');
  perform pg_temp.ok((select state='done' and attempts=0 and posting_started_at is null from public.whatsapp_template_jobs where id=j2),'exact reuse is technical done only');
  perform pg_temp.ok((select remote_status='REJECTED' and local_status='rejected' and quality='RED' from public.whatsapp_remote_templates where id=t),'reused rejected template remains rejected');
  -- Rotation before followup blocks capture on the exact channel, even with sister binding available.
  x:=public.begin_whatsapp_template_sync(a);
  update public.whatsapp_channels set webhook_secret='fake-rotated' where id=c;
  perform pg_temp.ok(not public.publish_whatsapp_template_sync(a,2,x,snap),'revision mismatch blocks publication before followup');
  perform pg_temp.ok((select binding_generation=2 from public.whatsapp_template_accounts where id=a),'no parent generation write inside channel trigger');
  perform public.bind_whatsapp_template_account(c2,'bbbbbbbb-0000-0000-0000-000000000002','datafy',0,'222','310001');
  y:=public.begin_whatsapp_template_sync(a);
  perform pg_temp.ok(not public.publish_whatsapp_template_sync(a,2,x,snap),'old GET A cannot borrow sister binding capture B');
  perform pg_temp.ok(public.publish_whatsapp_template_sync(a,2,y,snap),'sister binding B publishes its own valid capture');
  j:=public.request_whatsapp_template_sync(a); x:=public.claim_whatsapp_template_job(j); f:=(x->>'claim_token')::uuid;
  -- Failed context load never reached begin; an existing published snapshot still fences.
  perform pg_temp.ok(public.complete_whatsapp_template_sync_job(j,f,false,'template_get_failed'),'failed load before begin completes as observable failed');
  perform pg_temp.ok((select sync_required from public.whatsapp_remote_templates where id=t),'failed load fences previous complete snapshot');
  j:=public.request_whatsapp_template_sync(a); x:=public.claim_whatsapp_template_job(j); f:=(x->>'claim_token')::uuid;
  y:=public.begin_whatsapp_template_sync(a); perform public.publish_whatsapp_template_sync(a,2,y,snap);
  update public.whatsapp_channels set webhook_secret='fake-c2-rotated' where id=c2;
  perform pg_temp.ok(not public.complete_whatsapp_template_sync_job(j,f,true,'template_synced'),'rotation between publish and complete refuses success');
  update public.whatsapp_template_jobs set claimed_until=clock_timestamp()-interval '1 second' where id=j;
  perform pg_temp.ok(not public.complete_whatsapp_template_sync_job(j,f,false,'template_get_failed'),'expired failure cannot invalidate newer work');
  perform pg_temp.ok((select not sync_required from public.whatsapp_remote_templates where id=t),'lost failure made no writes');
  -- Actual Vault same-reference replacement path, never a synthetic pointer-only update.
  insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,provisioning_claim_id) values(v,'bbbbbbbb-0000-0000-0000-000000000002','uazapi','provisioning',false,claim);
  secret_id:=public.store_whatsapp_channel_instance_token(v,claim,repeat('f',32),null,'fixture31');
  select template_credential_revision into rev from public.whatsapp_channels where id=v;
  secret2:=public.store_whatsapp_channel_instance_token(v,claim,repeat('g',32),null,'fixture31b');
  perform pg_temp.ok(secret_id=secret2,'Vault replacement keeps same pointer');
  perform pg_temp.ok((select template_credential_revision=rev+1 from public.whatsapp_channels where id=v),'same-reference Vault write advances revision before replacement');
  perform pg_temp.ok((select decrypted_secret=repeat('g',32) from vault.decrypted_secrets where id=secret_id),'actual Vault secret changed');
  perform pg_temp.denied(format('select public.store_whatsapp_channel_instance_token(%L,%L,%L)',v,gen_random_uuid(),repeat('h',32)),'40001','stale lifecycle claim cannot rotate Vault');
  perform pg_temp.ok(not exists(select from app_private.whatsapp_template_revision_permits),'Vault permit consumed');
  -- Every new API remains backend-only. Real JWT/PostgREST tests supplement this SQL ACL check.
  for p in select oid,proname from pg_proc where pronamespace='public'::regnamespace and proname in('bind_whatsapp_template_account','reconcile_whatsapp_template_credentials','request_whatsapp_template_sync','select_due_whatsapp_template_accounts','complete_whatsapp_template_sync_job','confirm_whatsapp_template_post','whatsapp_template_pipeline_health','purge_whatsapp_template_workers') loop
    perform pg_temp.ok(not has_function_privilege('anon',p.oid,'EXECUTE') and not has_function_privilege('authenticated',p.oid,'EXECUTE') and has_function_privilege('service_role',p.oid,'EXECUTE'),p.proname||' service only');
  end loop;
end $$;
do $$ declare c uuid:=gen_random_uuid(); a uuid; b uuid; t uuid:=gen_random_uuid(); admin uuid:=gen_random_uuid(); j uuid; f uuid; sj uuid; sf uuid; x jsonb; snap jsonb;
begin
  insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,credentials,last_health_check_at)
    values(c,'bbbbbbbb-0000-0000-0000-000000000001','datafy','connected',false,'{"phone_number_id":"3199"}',clock_timestamp());
  x:=public.bind_whatsapp_template_account(c,'bbbbbbbb-0000-0000-0000-000000000001','datafy',0,'3199','319900'); a:=(x->>'accountId')::uuid;
  select id into b from public.whatsapp_template_bindings where channel_id=c;
  insert into auth.users(id) values(admin); insert into public.platform_admins values(admin);
  perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',admin)::text,true);
  update public.whatsapp_template_bindings set submission_authorized_at=clock_timestamp(),submission_authorized_by=admin where id=b;
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  insert into public.whatsapp_remote_templates(id,account_id,logical_id,version,language,name,desired_hash,requested_category,binding_generation)
    values(t,a,'fila_entrada_v1',1,'pt_BR','fila_entrada_v1',repeat('a',64),'UTILITY',1);
  snap:=jsonb_build_array(jsonb_build_object('id',t,'remote_id',null,'name','fila_entrada_v1','language','pt_BR','observed_hash',null,'effective_category',null,'remote_status','UNKNOWN'));
  x:=public.begin_whatsapp_template_sync(a); perform public.publish_whatsapp_template_sync(a,1,x,snap);
  j:=public.enqueue_whatsapp_template_job(b,'provision','fila_entrada_v1',1); x:=public.claim_whatsapp_template_job(j); f:=(x->>'claim_token')::uuid;
  perform pg_temp.ok(public.prepare_whatsapp_template_provision(j,f,1),'expiry test prepares once');
  update public.whatsapp_template_jobs set claimed_until=clock_timestamp()-interval '1 second',created_at=clock_timestamp()-interval '100 days' where id=j;
  perform pg_temp.ok(not public.confirm_whatsapp_template_post(j,f,1),'expired lease cannot authorize adapter');
  perform pg_temp.ok(not public.finish_whatsapp_template_job(j,f,'{"outcome":"local_preflight_refused","reason":"final_channel_changed"}'),'expired preparation never resets uncertain evidence');
  perform public.claim_whatsapp_template_job(j);
  perform pg_temp.ok((select state='uncertain' and attempts=1 and post_capture_id is not null from public.whatsapp_template_jobs where id=j),'expired posting keeps original capture and attempt');
  perform pg_temp.ok(not public.finish_whatsapp_template_job(j,f,'{"outcome":"local_preflight_refused","reason":"final_channel_changed"}'),'uncertain cannot use local reset');
  perform pg_temp.ok((public.whatsapp_template_pipeline_health()->>'oldest_age_seconds')::numeric>90*86400,'old nonterminal has no retention window in health');
  sj:=public.request_whatsapp_template_sync(a); x:=public.claim_whatsapp_template_job(sj); sf:=(x->>'claim_token')::uuid;
  perform public.complete_whatsapp_template_sync_job(sj,sf,false,'template_get_failed');
  update public.whatsapp_template_jobs set finished_at=clock_timestamp()-interval '100 days' where id=sj;
  perform public.purge_whatsapp_template_workers();
  perform pg_temp.ok(exists(select from public.whatsapp_template_jobs where id=j),'purge never deletes old uncertain');
  perform pg_temp.ok(not exists(select from public.whatsapp_template_jobs where id=sj),'purge removes eligible terminal over90days');
  perform pg_temp.ok(public.finish_whatsapp_template_job(j,f,'{"outcome":"accepted","reason":"provider_accepted"}'),'late original fence records acceptance after uncertainty');
  update public.whatsapp_template_jobs set finished_at=clock_timestamp()-interval '100 days' where id=j;
  perform public.purge_whatsapp_template_workers();
  perform pg_temp.ok(not exists(select from public.whatsapp_template_jobs where id=j),'eligible accepted technical job purged');
  perform pg_temp.ok((select submission_attempted_at is not null from public.whatsapp_remote_templates where id=t),'target submission evidence survives terminal purge');
  x:=public.begin_whatsapp_template_sync(a); perform public.publish_whatsapp_template_sync(a,1,x,snap);
  j:=public.enqueue_whatsapp_template_job(b,'provision','fila_entrada_v1',2); x:=public.claim_whatsapp_template_job(j); f:=(x->>'claim_token')::uuid;
  perform pg_temp.ok(not public.prepare_whatsapp_template_provision(j,f,1),'missing GET after purged acceptance cannot recreate');
end $$;
-- Abandoned sync recovery must converge, including an event during the newer GET.
do $$ declare
  n integer; c uuid; a uuid; b uuid; t uuid; s1 uuid; s2 uuid; live_old uuid; provision uuid; uncertain_job uuid;
  f1 uuid; f2 uuid; lf uuid; x jsonb; snap jsonb; original_uncertain jsonb;
begin
  for n in 1..2 loop
    c:=gen_random_uuid(); t:=gen_random_uuid();
    insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,credentials,last_health_check_at)
      values(c,'bbbbbbbb-0000-0000-0000-000000000001','datafy','connected',false,'{"phone_number_id":"316"}',clock_timestamp());
    x:=public.bind_whatsapp_template_account(c,'bbbbbbbb-0000-0000-0000-000000000001','datafy',0,'316','31600'||n); a:=(x->>'accountId')::uuid;
    select id into b from public.whatsapp_template_bindings where channel_id=c;
    insert into public.whatsapp_remote_templates(id,account_id,logical_id,version,language,name,desired_hash,requested_category,binding_generation)
      values(t,a,'res_confirmacao_v1',1,'pt_BR','res_confirmacao_v1',repeat('a',64),'UTILITY',1);
    snap:=jsonb_build_array(jsonb_build_object('id',t,'remote_id',null,'name','res_confirmacao_v1','language','pt_BR','observed_hash',null,'effective_category',null,'remote_status','UNKNOWN'));
    s1:=public.request_whatsapp_template_sync(a); x:=public.claim_whatsapp_template_job(s1); f1:=(x->>'claim_token')::uuid;
    update public.whatsapp_template_jobs set claimed_until=clock_timestamp()-interval '1 second' where id=s1;
    -- Initial queued provision and protected network evidence, with no external call.
    insert into public.whatsapp_template_jobs(account_id,binding_id,binding_generation,operation,target_key,revision)
      values(a,b,1,'provision','res_confirmacao_v1',1) returning id into provision;
    insert into public.whatsapp_template_jobs(account_id,binding_id,binding_generation,operation,target_key,revision,state,posting_started_at,claim_token,claimed_until,attempts,provider_outcome)
      values(a,b,1,'provision','fila_entrada_v1',1,'uncertain',clock_timestamp(),gen_random_uuid(),clock_timestamp()-interval '1 second',1,'uncertain') returning id into uncertain_job;
    select to_jsonb(j) into original_uncertain from public.whatsapp_template_jobs j where id=uncertain_job;
    s2:=public.request_whatsapp_template_sync(a); x:=public.claim_whatsapp_template_job(s2); f2:=(x->>'claim_token')::uuid;
    x:=public.begin_whatsapp_template_sync(a);
    if n=2 then
      perform public.record_whatsapp_template_events(a,jsonb_build_array(jsonb_build_object('field','message_template_status_update','remote_id','316099','event_time',clock_timestamp(),'digest',repeat('9',64),'remote_status','APPROVED')));
      perform pg_temp.ok(not public.publish_whatsapp_template_sync(a,1,x,snap),'event revision during GET refuses publication');
      perform pg_temp.ok(not public.complete_whatsapp_template_sync_job(s2,f2,true,'template_synced'),'event revision cannot coalesce under stale proof');
      perform pg_temp.ok((select state='claimed' and claim_token=f1 from public.whatsapp_template_jobs where id=s1),'stale proof preserves abandoned sync');
      perform public.complete_whatsapp_template_sync_job(s2,f2,false,'template_snapshot_stale');
      s2:=public.request_whatsapp_template_sync(a); x:=public.claim_whatsapp_template_job(s2); f2:=(x->>'claim_token')::uuid;
      x:=public.begin_whatsapp_template_sync(a);
    end if;
    perform pg_temp.ok(public.publish_whatsapp_template_sync(a,1,x,snap),'recovery GET publishes current capture');
    -- A live historical claim is never coalesced by the new successful sync.
    live_old:=public.enqueue_whatsapp_template_job(b,'sync','live-historical',1); lf:=gen_random_uuid();
    update public.whatsapp_template_jobs set state='claimed',claim_token=lf,claimed_until=clock_timestamp()+interval '90 seconds' where id=live_old;
    perform pg_temp.ok(public.complete_whatsapp_template_sync_job(s2,f2,true,'template_synced'),'current recovery sync completes');
    perform pg_temp.ok((select state='done' and claim_token=f1 and posting_started_at is null from public.whatsapp_template_jobs where id=s1),'expired old sync coalesces after current proof');
    perform pg_temp.ok((select state='claimed' and claim_token=lf from public.whatsapp_template_jobs where id=live_old),'live old sync remains owned');
    perform pg_temp.ok((select to_jsonb(j)=original_uncertain from public.whatsapp_template_jobs j where id=uncertain_job),'uncertain provision evidence unchanged by coalescing');
    perform pg_temp.ok(public.claim_whatsapp_template_job(s1) is null,'coalesced old sync cannot restart');
    perform pg_temp.ok(not public.complete_whatsapp_template_sync_job(s1,f1,false,'template_get_failed'),'lost old claimant cannot invalidate current proof');
    perform public.complete_whatsapp_template_sync_job(live_old,lf,false,'template_get_failed');
    perform pg_temp.ok(public.claim_whatsapp_template_job(provision) is not null,'provision becomes reclaimable after abandoned sync recovery');
  end loop;
end $$;
-- Health counts a sync failure only until a later successful sync of the same account.
do $$ declare
  c1 uuid:=gen_random_uuid(); c2 uuid:=gen_random_uuid(); a1 uuid; a2 uuid; b1 uuid; b2 uuid; base integer; fa uuid; x jsonb;
begin
  insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,credentials,last_health_check_at) values
    (c1,'bbbbbbbb-0000-0000-0000-000000000001','datafy','connected',false,'{"phone_number_id":"3181"}',clock_timestamp()),
    (c2,'bbbbbbbb-0000-0000-0000-000000000002','datafy','connected',false,'{"phone_number_id":"3182"}',clock_timestamp());
  x:=public.bind_whatsapp_template_account(c1,'bbbbbbbb-0000-0000-0000-000000000001','datafy',0,'3181','318100'); a1:=(x->>'accountId')::uuid;
  x:=public.bind_whatsapp_template_account(c2,'bbbbbbbb-0000-0000-0000-000000000002','datafy',0,'3182','318200'); a2:=(x->>'accountId')::uuid;
  select id into b1 from public.whatsapp_template_bindings where channel_id=c1;
  select id into b2 from public.whatsapp_template_bindings where channel_id=c2;
  base:=(public.whatsapp_template_pipeline_health()->>'failed')::integer;
  insert into public.whatsapp_template_jobs(account_id,binding_id,binding_generation,operation,target_key,revision,state,error_code,finished_at)
    values(a1,b1,1,'sync','account',10,'failed','template_get_failed',clock_timestamp()-interval '10 minutes') returning id into fa;
  insert into public.whatsapp_template_jobs(account_id,binding_id,binding_generation,operation,target_key,revision,state,finished_at)
    values(a1,b1,1,'sync','account',9,'done',clock_timestamp()-interval '20 minutes');
  perform pg_temp.ok((public.whatsapp_template_pipeline_health()->>'failed')::integer=base+1,'failure without later success counts even after an earlier success');
  insert into public.whatsapp_template_jobs(account_id,binding_id,binding_generation,operation,target_key,revision,state,finished_at)
    values(a2,b2,1,'sync','account',11,'done',clock_timestamp()-interval '5 minutes');
  perform pg_temp.ok((public.whatsapp_template_pipeline_health()->>'failed')::integer=base+1,'another account success never resolves this failure');
  insert into public.whatsapp_template_jobs(account_id,binding_id,binding_generation,operation,target_key,revision,state,error_code,finished_at)
    values(a1,b1,1,'sync','account',11,'failed','template_get_failed',clock_timestamp()-interval '6 minutes');
  insert into public.whatsapp_template_jobs(account_id,binding_id,binding_generation,operation,target_key,revision,state,finished_at)
    values(a1,b1,1,'sync','account',12,'done',clock_timestamp()-interval '1 minute');
  perform pg_temp.ok((public.whatsapp_template_pipeline_health()->>'failed')::integer=base,'later same-account success resolves every earlier failure');
  perform pg_temp.ok((select state='failed' from public.whatsapp_template_jobs where id=fa),'resolved failure keeps its evidence row');
  insert into public.whatsapp_template_jobs(account_id,binding_id,binding_generation,operation,target_key,revision,state,error_code,finished_at)
    values(a1,b1,1,'sync','account',13,'failed','template_get_failed',clock_timestamp());
  perform pg_temp.ok((public.whatsapp_template_pipeline_health()->>'failed')::integer=base+1,'new failure after the success counts again');
end $$;
select count(*)||' worker SQL assertions GREEN' from worker_checks;
rollback;
