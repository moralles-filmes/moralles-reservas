\set ON_ERROR_STOP on
-- ROOT only after the exact migration; genuine JWT proof lives in 59.
begin;
set local lock_timeout='5s'; set local statement_timeout='90s';
create temp table checks57(label text) on commit drop;
create function pg_temp.ok57(v boolean,label text) returns void language plpgsql as $$
begin if v is distinct from true then raise exception 'FAIL57 %',label; end if; insert into checks57 values(label); end $$;
create function pg_temp.error57(statement text,code text,label text) returns void language plpgsql as $$
declare actual text; begin
  begin execute statement; exception when others then get stacked diagnostics actual=returned_sqlstate; end;
  perform pg_temp.ok57(actual=code,label||' exact SQLSTATE');
end $$;
create function pg_temp.actor57(actor uuid,role_name text default 'authenticated') returns void language plpgsql as $$
begin perform set_config('request.jwt.claims',jsonb_build_object('role',role_name,'sub',actor)::text,true); end $$;
create function pg_temp.job57(u uuid,c uuid,ch uuid,b uuid,phase text default 'bound',account uuid default null,template uuid default null,expired boolean default false)
returns uuid language plpgsql as $$
declare r uuid:=gen_random_uuid(); j uuid:=gen_random_uuid(); o uuid; p text; g bigint; rev bigint;
  stamp timestamptz:=clock_timestamp()-case when expired then interval '2 hours' else interval '0' end;
begin
  select organization_id into o from public.units where id=u;
  select provider,template_credential_revision into p,rev from public.whatsapp_channels where id=ch;
  select generation into g from public.whatsapp_template_bindings where id=b;
  insert into public.reservations(id,unit_id,customer_id) values(r,u,c);
  insert into public.whatsapp_automation_jobs(id,unit_id,organization_id,kind,reservation_id,customer_id,source_event_key,fact_at,expires_at,channel_id,provider,binding_id,binding_generation,transport,account_id,remote_template_id,template_version,sync_epoch,pin_phase,initial_credential_revision,initial_catalog_key,state,error_code)
  values(j,u,o,'confirmation',r,c,'task57:'||r,stamp,stamp+interval '1 hour',ch,p,b,g,case when ch is null then null when p in('datafy','official') then 'template' else 'text' end,account,template,case when template is not null then 1 end,case when template is not null then 0 end,phase,rev,'res_confirmacao_v1','blocked',case when ch is null then 'channel_unconfigured' when b is null then 'binding_unconfigured' else 'binding_changed' end);
  return j;
end $$;

do $$ declare sig text; f oid; t text; begin
  perform pg_temp.ok57(not exists(select from cron.job where jobname in('whatsapp-automation-worker','whatsapp-template-workers')),'persistent quarantine');
  foreach sig in array array[
    'get_whatsapp_message_consent_state(uuid,uuid,text)','record_whatsapp_message_consent(uuid,uuid,text,text,text,timestamptz,text)',
    'release_whatsapp_template_channel(uuid,text,boolean,bigint,bigint)','request_whatsapp_template_sync_for_channel(uuid,bigint)',
    'initialize_whatsapp_automation_job(uuid,uuid,bigint)','revalidate_whatsapp_automation_job(uuid,uuid,bigint)',
    'revalidate_whatsapp_template_job(uuid,uuid,bigint)','authorize_whatsapp_marketing_cost(uuid,bigint,text,timestamptz,timestamptz)',
    'configure_whatsapp_promotion_frequency(integer)'] loop
    f:=('public.'||sig)::regprocedure;
    perform pg_temp.ok57(has_function_privilege('authenticated',f,'EXECUTE') and not has_function_privilege('anon',f,'EXECUTE') and not has_function_privilege('service_role',f,'EXECUTE'),sig||' minimal ACL');
    perform pg_temp.ok57((select prosecdef and pronargdefaults=0 and proconfig=array['search_path=""'] from pg_proc where oid=f),sig||' exact definer contract');
    perform pg_temp.ok57(not exists(select from pg_proc p,lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=f and a.grantee=0 and a.privilege_type='EXECUTE'),sig||' PUBLIC closed');
  end loop;
  perform pg_temp.ok57((select provolatile='s' from pg_proc where oid='public.get_whatsapp_message_consent_state(uuid,uuid,text)'::regprocedure),'selected reader stable');
  foreach t in array array['whatsapp_automation_pin_revalidation_permits','whatsapp_catalog_pin_revalidation_permits','whatsapp_template_zero_post_evidence','whatsapp_template_revalidation_authorizations'] loop
    perform pg_temp.ok57((select relrowsecurity and relforcerowsecurity from pg_class where oid=('app_private.'||t)::regclass),'private FORCE RLS '||t);
    perform pg_temp.ok57(not has_table_privilege('authenticated','app_private.'||t,'SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('service_role','app_private.'||t,'SELECT,INSERT,UPDATE,DELETE'),'private no caller access '||t);
  end loop;
  perform pg_temp.ok57(not has_type_privilege('authenticated','app_private.whatsapp_catalog_pin_tuple','USAGE') and not has_type_privilege('service_role','app_private.whatsapp_catalog_pin_tuple','USAGE'),'typed catalog permit private');
end $$;

do $$ declare
  o uuid:=gen_random_uuid(); other_o uuid:=gen_random_uuid(); u uuid:=gen_random_uuid(); u2 uuid:=gen_random_uuid(); other_u uuid:=gen_random_uuid();
  c uuid:=gen_random_uuid(); other_c uuid:=gen_random_uuid(); dead_c uuid:=gen_random_uuid();
  admin uuid:=gen_random_uuid(); admin2 uuid:=gen_random_uuid(); owner_id uuid:=gen_random_uuid(); manager uuid:=gen_random_uuid(); operator_id uuid:=gen_random_uuid(); outsider uuid:=gen_random_uuid();
  ch uuid:=gen_random_uuid(); ch2 uuid:=gen_random_uuid(); account uuid:=gen_random_uuid(); b uuid; b2 uuid; template uuid:=gen_random_uuid();
  next_account uuid:=gen_random_uuid(); next_channel uuid:=gen_random_uuid(); next_template uuid:=gen_random_uuid(); next_binding uuid; phase text; prior_dispatch jsonb;
  j uuid; j2 uuid; j3 uuid; catalog_job uuid; fence uuid; n integer; rev bigint; gen bigint; actor uuid; source text; decision jsonb; before_row jsonb; after_row jsonb; marker timestamptz; authz uuid; saved_at timestamptz; evidence uuid;
begin
  insert into auth.users(id) values(admin),(admin2),(owner_id),(manager),(operator_id),(outsider);
  insert into public.platform_admins values(admin),(admin2);
  insert into public.organizations(id,name) values(o,'Task57'),(other_o,'Task57 foreign');
  insert into public.units(id,organization_id,name) values(u,o,'Task57'),(u2,o,'Task57 sibling'),(other_u,other_o,'Task57 foreign');
  insert into public.customers(id,organization_id,name,phone) values(c,o,'Synthetic','11999995757'),(other_c,other_o,'Synthetic foreign','11999995757'),(dead_c,o,'Synthetic erased','11999995758');
  update public.customers set deleted_at=clock_timestamp() where id=dead_c;
  insert into public.unit_members(user_id,unit_id,role) values(owner_id,u,'owner'),(manager,u,'gerente'),(operator_id,u,'operador'),(outsider,other_u,'owner');
  foreach actor in array array[owner_id,manager,admin] loop
    perform pg_temp.actor57(actor);
    perform pg_temp.ok57(public.get_whatsapp_message_consent_state(u,c,'promotional')='{"purpose":"promotional","status":"unknown","revision":null}'::jsonb,'genuine absence before first record '||actor);
  end loop;
  foreach actor in array array[operator_id,outsider] loop
    perform pg_temp.actor57(actor);
    perform pg_temp.error57(format('select public.get_whatsapp_message_consent_state(%L,%L,%L)',u,c,'promotional'),'42501','denied role selected read');
    perform pg_temp.error57(format('select public.record_whatsapp_message_consent(%L,%L,%L,%L,%L,clock_timestamp(),%L)',u,c,'promotional','opt_in','in_person','synthetic reference'),'42501','denied role manual write');
  end loop;
  perform pg_temp.actor57(owner_id);
  foreach actor in array array[other_c,dead_c,gen_random_uuid()] loop
    perform pg_temp.error57(format('select public.get_whatsapp_message_consent_state(%L,%L,%L)',u,actor,'promotional'),'42501','uniform foreign missing erased');
  end loop;
  perform pg_temp.error57(format('select public.get_whatsapp_message_consent_state(%L,%L,%L)',u2,c,'operational'),'42501','same org different unit needs role');
  foreach source in array array['preference_link','inferred','bulk',''] loop
    perform pg_temp.error57(format('select public.record_whatsapp_message_consent(%L,%L,%L,%L,%L,clock_timestamp(),%L)',u,c,'promotional','opt_in',source,'synthetic reference'),'22023','manual origin closed');
  end loop;
  n:=0;
  foreach source in array array['customer_message','signed_form','in_person'] loop
    n:=n+1; perform pg_temp.ok57(public.record_whatsapp_message_consent(u,c,'operational','opt_in',source,clock_timestamp(),'synthetic individual reference')=n,'manual allowed origin revision');
  end loop;
  perform pg_temp.ok57(public.get_whatsapp_message_consent_state(u,c,'promotional')->>'status'='unknown','operational never grants promotional');
  perform pg_temp.ok57(public.record_whatsapp_message_consent(u,c,'promotional','opt_in','customer_message',clock_timestamp(),'synthetic individual reference')=1,'first promotional revision');
  perform pg_temp.ok57(public.record_whatsapp_message_consent(u,c,'promotional','opt_out','in_person',clock_timestamp(),'synthetic refusal')=2,'next individual optout');
  perform pg_temp.ok57(public.get_whatsapp_message_consent_state(u,c,'promotional')='{"purpose":"promotional","status":"opt_out","revision":2}'::jsonb,'latest exact selected state');
  perform pg_temp.ok57((select bool_and(actor_id=owner_id) from public.whatsapp_message_consent_events where customer_id=c),'actual SQL actor');
  perform pg_temp.error57(format('select public.record_whatsapp_message_consent(%L,%L,%L,%L,%L,%L,%L)',u,c,'promotional','opt_in','in_person','infinity','synthetic'),'22023','infinite observation');
  perform pg_temp.error57(format('select public.record_whatsapp_message_consent(%L,%L,%L,%L,%L,clock_timestamp()+interval %L,%L)',u,c,'promotional','opt_in','in_person','1 hour','synthetic'),'22023','future observation');
  -- Internal preference origin/NULL actor remains legal, independently of manual API.
  perform pg_temp.actor57(admin,'service_role');
  insert into public.whatsapp_message_consent_events(unit_id,customer_id,purpose,decision,source_code,evidence_reference,actor_id,observed_at) values(u,c,'promotional','opt_out','preference_link','synthetic token digest',null,clock_timestamp());
  perform pg_temp.ok57((select max(revision)=3 from public.whatsapp_message_consent_events where customer_id=c and purpose='promotional'),'internal preference path unchanged');
  perform pg_temp.error57('select public.configure_whatsapp_promotion_frequency(1)','42501','service with admin UID refused');
  perform pg_temp.actor57(owner_id);
  perform pg_temp.error57('select public.configure_whatsapp_promotion_frequency(1)','42501','owner frequency refused');
  perform pg_temp.actor57(admin);
  perform pg_temp.ok57(public.configure_whatsapp_promotion_frequency(1)=1,'admin frequency future only');
  perform pg_temp.error57('select public.configure_whatsapp_promotion_frequency(0)','22023','frequency lower bound');
  perform pg_temp.error57('select public.configure_whatsapp_promotion_frequency(31)','22023','frequency upper bound');

  -- All three preconfiguration shapes retain their original row and TTL.
  j:=pg_temp.job57(u,c,null,null,'preconfiguration');
  insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,last_health_check_at,webhook_secret) values(ch,u,'zapi','connected',true,clock_timestamp(),'synthetic-task57-channel');
  j2:=pg_temp.job57(u,c,ch,null,'preconfiguration');
  perform pg_temp.ok57(not public.release_whatsapp_template_channel(ch,'dispatch',false,0,null),'missing disable never bootstraps');
  perform pg_temp.ok57(public.release_whatsapp_template_channel(ch,'dispatch',true,0,null),'TEXT bootstrap');
  select id,generation into b,gen from public.whatsapp_template_bindings where channel_id=ch;
  select to_jsonb(x) into before_row from public.whatsapp_automation_jobs x where id=j;
  perform pg_temp.ok57(public.initialize_whatsapp_automation_job(j,ch,gen),'unselected single initializer');
  select to_jsonb(x) into after_row from public.whatsapp_automation_jobs x where id=j;
  perform pg_temp.ok57((before_row->'fact_at',before_row->'expires_at',before_row->'notification_id',before_row->'due_at',before_row->'attempts')=(after_row->'fact_at',after_row->'expires_at',after_row->'notification_id',after_row->'due_at',after_row->'attempts'),'initialization original facts');
  perform pg_temp.ok57(not public.initialize_whatsapp_automation_job(j,ch,gen),'initializer single use');
  perform pg_temp.ok57(public.initialize_whatsapp_automation_job(j2,ch,gen),'unbound single initializer');
  perform pg_temp.error57(format('update public.whatsapp_automation_jobs set binding_generation=binding_generation+1 where id=%L',j),'23514','direct pin forgery');
  update public.whatsapp_automation_jobs set state='needs_review',error_code='binding_changed',attempts=1 where id=j;
  update public.whatsapp_channels set webhook_secret='synthetic-task57-rotation' where id=ch;
  perform public.reconcile_whatsapp_template_credentials(ch);
  select generation into gen from public.whatsapp_template_bindings where id=b;
  select template_credential_revision into rev from public.whatsapp_channels where id=ch;
  perform pg_temp.ok57(public.release_whatsapp_template_channel(ch,'dispatch',true,rev,gen),'TEXT reattestation after explicit reconciliation');
  perform pg_temp.actor57(owner_id);
  perform pg_temp.ok57(public.revalidate_whatsapp_automation_job(j,ch,gen),'owner bound revalidation');
  perform pg_temp.ok57((select initial_credential_revision=0 and binding_generation=gen and attempts=1 and expires_at=(before_row->>'expires_at')::timestamptz from public.whatsapp_automation_jobs where id=j),'bound refresh keeps history counters deadline');
  perform pg_temp.ok57(not exists(select from app_private.whatsapp_automation_pin_initialization_permits) and not exists(select from app_private.whatsapp_automation_pin_revalidation_permits),'permits consumed');
  perform pg_temp.actor57(admin);
  -- Datafy catalog scope and dispatch scope have independent grants.
  insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,last_health_check_at,credentials,webhook_secret) values(ch2,u2,'datafy','connected',true,clock_timestamp(),'{"phone_number_id":"5701"}','synthetic-task57-datafy');
  insert into public.whatsapp_template_accounts(id,organization_id,waba_id,verified_at) values(account,o,'5700000000001',clock_timestamp());
  insert into public.whatsapp_template_bindings(unit_id,channel_id,account_id,provider,verified_at) values(u2,ch2,account,'datafy',clock_timestamp()) returning id into b2;
  j3:=pg_temp.job57(u2,c,ch2,b2,'preconfiguration',account);
  perform pg_temp.ok57(public.release_whatsapp_template_channel(ch2,'catalog',true,0,1),'catalog grant');
  select submission_authorized_at into saved_at from public.whatsapp_template_bindings where id=b2;
  perform pg_temp.ok57(not exists(select from public.whatsapp_automation_adoptions where unit_id=u2),'catalog alone never adopts');
  perform pg_temp.actor57(admin2);
  perform pg_temp.ok57(public.release_whatsapp_template_channel(ch2,'dispatch',true,0,1),'different admin dispatch grant');
  perform pg_temp.ok57((select submission_authorized_at=saved_at and submission_authorized_by=admin from public.whatsapp_template_bindings where id=b2),'dispatch does not renew catalog actor/time');
  insert into public.whatsapp_remote_templates(id,account_id,logical_id,version,language,name,desired_hash,requested_category,binding_generation) values(template,account,'res_confirmacao_v1',1,'pt_BR','res_confirmacao_v1',repeat('a',64),'UTILITY',1);
  update public.whatsapp_remote_templates set sync_epoch=5 where id=template;
  perform pg_temp.ok57(public.initialize_whatsapp_automation_job(j3,ch2,1),'missing template shape single initializer');
  perform pg_temp.ok57(public.authorize_whatsapp_marketing_cost(ch2,1,'MARKETING',clock_timestamp(),clock_timestamp()+interval '1 hour') is not null,'explicit cost interval');
  perform pg_temp.error57(format('select public.authorize_whatsapp_marketing_cost(%L,1,%L,clock_timestamp(),clock_timestamp()+interval %L)',ch2,'UTILITY','1 hour'),'22023','cost category closed');

  -- Same transport can adopt a current account with a lower epoch, never a new intent.
  insert into public.whatsapp_template_accounts(id,organization_id,waba_id,verified_at) values(next_account,o,'5700000000002',clock_timestamp());
  insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,last_health_check_at,credentials,webhook_secret) values(next_channel,u2,'datafy','connected',false,clock_timestamp(),'{"phone_number_id":"5702"}','synthetic-task57-next');
  insert into public.whatsapp_template_bindings(unit_id,channel_id,account_id,provider,verified_at) values(u2,next_channel,next_account,'datafy',clock_timestamp()) returning id into next_binding;
  insert into public.whatsapp_remote_templates(id,account_id,logical_id,version,language,name,desired_hash,requested_category,binding_generation) values(next_template,next_account,'res_confirmacao_v1',1,'pt_BR','res_confirmacao_v1',repeat('b',64),'UTILITY',1);
  update public.whatsapp_channels set is_active=false where id=ch2;
  update public.whatsapp_channels set is_active=true where id=next_channel;
  perform pg_temp.ok57(public.release_whatsapp_template_channel(next_channel,'dispatch',true,0,1),'current same-transport account selected');
  update public.whatsapp_automation_jobs set state='needs_review',error_code='binding_changed' where id=j3;
  select to_jsonb(x) into before_row from public.whatsapp_automation_jobs x where id=j3;
  perform pg_temp.ok57(public.revalidate_whatsapp_automation_job(j3,next_channel,1),'same-transport new account exact permit');
  select to_jsonb(x) into after_row from public.whatsapp_automation_jobs x where id=j3;
  perform pg_temp.ok57((after_row->>'account_id')::uuid=next_account and (after_row->>'sync_epoch')::bigint=0 and (before_row->>'sync_epoch')::bigint=5,'only explicit permit admits new-account epoch');
  perform pg_temp.ok57((before_row->'fact_at',before_row->'expires_at',before_row->'notification_id',before_row->'customer_id',before_row->'attempts',before_row->'initial_credential_revision',before_row->'initial_catalog_key')=(after_row->'fact_at',after_row->'expires_at',after_row->'notification_id',after_row->'customer_id',after_row->'attempts',after_row->'initial_credential_revision',after_row->'initial_catalog_key'),'new account preserves original identity and anchors');
  -- Build valid lifecycle evidence through existing writers; no state-only POST fixture.
  select value into prior_dispatch from public.platform_flags where key='whatsapp_automation_dispatch';
  update public.platform_flags set value='true'::jsonb where key='whatsapp_automation_dispatch';
  select revision into rev from public.whatsapp_message_consent_events where unit_id=u and customer_id=c and purpose='operational' order by revision desc limit 1;
  foreach phase in array array['accepted','uncertain','reconciled','expired','posting','claimed','failed','rejected'] loop
    j2:=pg_temp.job57(u,c,ch,b,'bound',null,null,phase='expired');
    if phase='failed' then
      -- A valid historical terminal row; no claim or provider success is inferred.
      update public.whatsapp_automation_jobs set state='failed',finished_at=clock_timestamp(),error_code='dependency_unavailable' where id=j2;
    else
      update public.whatsapp_automation_jobs set state='queued',error_code=null where id=j2;
      decision:=public.claim_whatsapp_automation(j2); fence:=(decision->>'claim_token')::uuid;
      if phase='expired' then
        perform pg_temp.ok57(decision is null,'originally expired fixture cannot claim');
      else
        perform pg_temp.ok57(fence is not null and decision->>'state'='claimed','real claim for '||phase);
        if phase<>'claimed' then
          update public.whatsapp_automation_jobs set safe_log_body='Task57 synthetic lifecycle evidence' where id=j2 and claim_token=fence;
          perform pg_temp.ok57(public.prepare_whatsapp_automation_post(j2,fence,gen,rev,null),'real prepare for '||phase);
          if phase in('accepted','reconciled') then
            perform pg_temp.ok57(public.finish_whatsapp_automation(j2,fence,jsonb_build_object('outcome','accepted','reason','provider_accepted','provider_message_id','task57-synthetic-'||j2)),'synthetic accepted result via real finisher for '||phase);
            if phase='reconciled' then
              perform pg_temp.ok57(public.reconcile_whatsapp_automation_acceptance(j2)->>'state'='reconciled','real local acceptance projection');
            end if;
          elsif phase='uncertain' then
            perform pg_temp.ok57(public.finish_whatsapp_automation(j2,fence,'{"outcome":"uncertain","reason":"post_ambiguous"}'),'uncertain through real finisher');
          elsif phase='rejected' then
            perform pg_temp.ok57(public.finish_whatsapp_automation(j2,fence,'{"outcome":"rejected","reason":"provider_rejected"}'),'rejected through real finisher');
          end if;
        end if;
      end if;
    end if;
    perform pg_temp.ok57((select state=phase from public.whatsapp_automation_jobs where id=j2),'actual lifecycle fixture reaches '||phase);
    select to_jsonb(x) into before_row from public.whatsapp_automation_jobs x where id=j2;
    perform pg_temp.ok57(not public.revalidate_whatsapp_automation_job(j2,ch,gen),'terminal or active state refuses '||phase);
    perform pg_temp.ok57((select to_jsonb(x)=before_row from public.whatsapp_automation_jobs x where id=j2),'refusal leaves row unchanged '||phase);
  end loop;
  update public.platform_flags set value=prior_dispatch where key='whatsapp_automation_dispatch';

  -- Exercise actual prepare/finish and genuine durable local-zeroPOST proof.
  update public.platform_flags set value='true'::jsonb where key='whatsapp_template_catalog';
  update public.whatsapp_template_accounts set sync_capture_id=gen_random_uuid(),last_sync_published_at=clock_timestamp(),sync_binding_id=b2,sync_binding_generation=1,sync_credential_revision=0 where id=account;
  update public.whatsapp_remote_templates set sync_required=false,last_synced_at=clock_timestamp() where id=template;
  catalog_job:=public.enqueue_whatsapp_template_job(b2,'provision','res_confirmacao_v1',1);
  decision:=public.claim_whatsapp_template_job(catalog_job); fence:=(decision->>'claim_token')::uuid;
  perform pg_temp.ok57(public.prepare_whatsapp_template_provision(catalog_job,fence,1),'first catalog prepare');
  select submission_attempted_at into marker from public.whatsapp_remote_templates where id=template;
  perform pg_temp.ok57(public.finish_whatsapp_template_job(catalog_job,fence,'{"outcome":"local_preflight_refused","reason":"final_channel_changed"}'),'actual local refusal resets only prePOST attempt');
  select id into evidence from app_private.whatsapp_template_zero_post_evidence where job_id=catalog_job;
  perform pg_temp.ok57(evidence is not null,'durable zeroPOST evidence exists');
  update public.whatsapp_template_jobs set error_code=null where id=catalog_job;
  perform pg_temp.ok57(public.revalidate_whatsapp_template_job(catalog_job,ch2,1),'catalog proof survives transient reason clear');
  perform pg_temp.ok57(not public.revalidate_whatsapp_template_job(catalog_job,ch2,1),'catalog authorization single action');
  decision:=public.claim_whatsapp_template_job(catalog_job); fence:=(decision->>'claim_token')::uuid;
  perform pg_temp.ok57(public.prepare_whatsapp_template_provision(catalog_job,fence,1),'one corrected prepare');
  perform pg_temp.ok57(not public.prepare_whatsapp_template_provision(catalog_job,fence,1),'no second prepare');
  perform pg_temp.ok57((select submission_attempted_at=marker from public.whatsapp_remote_templates where id=template),'first submission history sticky');
  perform pg_temp.ok57((select consumed_claim_token=fence and consumed_at is not null from app_private.whatsapp_template_revalidation_authorizations where evidence_id=evidence),'authorization consumed exact fence');
  perform pg_temp.ok57(public.finish_whatsapp_template_job(catalog_job,fence,'{"outcome":"uncertain","reason":"post_ambiguous"}'),'ambiguous POST uncertain');
  perform pg_temp.ok57(not public.revalidate_whatsapp_template_job(catalog_job,ch2,1),'uncertain cannot revalidate');
  perform pg_temp.ok57((select count(*)=1 from app_private.whatsapp_template_zero_post_evidence where job_id=catalog_job),'uncertain produces no proof');

  -- Unreconciled provider drift: only an exact genuine-admin reduction passes.
  update public.whatsapp_channels set provider='zapi',status='disconnected',last_health_check_at=null,webhook_secret=null where id=ch2;
  select template_credential_revision into rev from public.whatsapp_channels where id=ch2;
  select to_jsonb(x) into before_row from public.whatsapp_template_bindings x where id=b2;
  perform pg_temp.actor57(admin,'service_role');
  perform pg_temp.error57(format('update public.whatsapp_template_bindings set dispatch_enabled=false where id=%L',b2),'23514','service admin UID no drift bypass');
  perform pg_temp.actor57(admin);
  perform pg_temp.error57(format('update public.whatsapp_template_bindings set dispatch_enabled=false,verified_at=null where id=%L',b2),'23514','extra field defeats exclusive stop');
  perform pg_temp.error57(format('select public.release_whatsapp_template_channel(%L,%L,false,0,1)',ch2,'dispatch'),'PT409','stale current channel revision refuses stop');
  perform pg_temp.ok57(public.release_whatsapp_template_channel(ch2,'dispatch',false,rev,1),'unhealthy provider drift stop');
  select to_jsonb(x) into after_row from public.whatsapp_template_bindings x where id=b2;
  perform pg_temp.ok57((before_row-'dispatch_enabled')=(after_row-'dispatch_enabled'),'whole residual preserved by dispatch stop');
  perform pg_temp.ok57(public.release_whatsapp_template_channel(ch2,'dispatch',false,rev,1),'already stopped returns true');
  perform pg_temp.ok57((select to_jsonb(x)=after_row from public.whatsapp_template_bindings x where id=b2),'already stopped zero update');
  perform pg_temp.ok57(public.release_whatsapp_template_channel(ch2,'catalog',false,rev,1),'independent catalog stop under drift');
  perform pg_temp.ok57((select (to_jsonb(x)-array['submission_authorized_at','submission_authorized_by'])=(after_row-array['submission_authorized_at','submission_authorized_by']) from public.whatsapp_template_bindings x where id=b2),'whole residual preserved by catalog stop');
  perform pg_temp.ok57(not public.release_whatsapp_template_channel(ch2,'dispatch',true,rev,1),'enable remains closed under drift');
  perform pg_temp.ok57(exists(select from public.whatsapp_automation_adoptions where unit_id=u2),'unit adoption survives both stops');
  perform pg_temp.ok57(not exists(select from public.audit_log where actor_id in(admin,admin2,owner_id,manager) and (coalesce(old_values::text,'')||coalesce(new_values::text,'')) like '%synthetic individual reference%'),'audit excludes personal evidence');
end $$;
select count(*) as checks57 from checks57;
select 'GREEN57 all management SQL controls; rollback removes only own fixtures' as evidence;
rollback;
