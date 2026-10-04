\set ON_ERROR_STOP on
begin;
create temp table event_authority_checks(label text);
create function pg_temp.ok(v boolean,label text) returns void language plpgsql as $$begin if v is distinct from true then raise exception 'FAIL: %',label; end if; insert into event_authority_checks values(label); end$$;
create function pg_temp.denied(q text,code text,label text) returns void language plpgsql as $$begin begin execute q; exception when others then if sqlstate=code then perform pg_temp.ok(true,label); return; end if; raise; end; raise exception 'FAIL: % allowed',label; end$$;
create function pg_temp.capture(c uuid) returns jsonb language sql as $$
 select jsonb_build_object('accountId',a.id,'wabaId',a.waba_id,'organizationId',a.organization_id,'unitOrganizationId',u.organization_id,
 'channelId',ch.id,'unitId',ch.unit_id,'provider',ch.provider,'phoneNumberId',ch.credentials->>'phone_number_id','verifiedAt',b.verified_at,
 'credentialRevision',ch.template_credential_revision,'bindingCredentialRevision',b.channel_credential_revision,
 'bindingId',b.id,'bindingGeneration',b.generation,'accountGeneration',a.binding_generation)
 from public.whatsapp_channels ch join public.units u on u.id=ch.unit_id join public.whatsapp_template_bindings b on b.channel_id=ch.id
 join public.whatsapp_template_accounts a on a.id=b.account_id where ch.id=c
$$;
create function pg_temp.state(a uuid) returns jsonb language sql as $$
 select jsonb_build_object('events',(select count(*) from public.whatsapp_template_events where account_id=a),'jobs',(select count(*) from public.whatsapp_template_jobs where account_id=a),
 'revision',(select reconciliation_revision from public.whatsapp_template_accounts where id=a),
 'templates',(select jsonb_agg(jsonb_build_array(sync_epoch,remote_status,quality,local_status,sync_required) order by id) from public.whatsapp_remote_templates where account_id=a))
$$;
do $$declare c uuid:=gen_random_uuid(); c2 uuid:=gen_random_uuid(); a uuid; t uuid:=gen_random_uuid(); cap jsonb; e jsonb; before_state jsonb; bad jsonb; k text; r text; n text;
begin
 insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,credentials) values
 (c,'bbbbbbbb-0000-0000-0000-000000000001','datafy','connected',false,'{"phone_number_id":"331"}'),
 (c2,'bbbbbbbb-0000-0000-0000-000000000002','datafy','connected',false,'{"phone_number_id":"332"}');
 a:=(public.bind_whatsapp_template_account(c,'bbbbbbbb-0000-0000-0000-000000000001','datafy',0,'331','330033')->>'accountId')::uuid;
 perform public.bind_whatsapp_template_account(c2,'bbbbbbbb-0000-0000-0000-000000000002','datafy',0,'332','330033');
 -- Deliberately use the binding that legacy order-by-id would NOT select.
 select channel_id into c from public.whatsapp_template_bindings where account_id=a order by id desc limit 1;
 cap:=pg_temp.capture(c);
 insert into public.whatsapp_remote_templates(id,account_id,logical_id,version,language,name,remote_id,desired_hash,requested_category,binding_generation,remote_status,local_status)
 values(t,a,'res_confirmacao_v1',1,'pt_BR','res_confirmacao_v1','331',repeat('a',64),'UTILITY',1,'APPROVED','usable');
 e:=jsonb_build_array(jsonb_build_object('field','message_template_status_update','remote_id','331','name',null,'language','pt_BR','event_time','2026-10-04T16:00:00Z','digest',repeat('1',64),'remote_status','PAUSED','quality',null,'effective_category',null));
 perform pg_temp.ok(public.record_whatsapp_template_events_fenced(cap,e)=1,'fenced positive writes once');
 perform pg_temp.ok((select binding_id=(cap->>'bindingId')::uuid from public.whatsapp_template_jobs where account_id=a),'sync job pins exact origin binding, not arbitrary sibling');
 perform pg_temp.ok((select remote_status='PAUSED' and local_status='paused' and sync_epoch=1 from public.whatsapp_remote_templates where id=t),'restriction and epoch atomic');
 before_state:=pg_temp.state(a);
 perform pg_temp.ok(public.record_whatsapp_template_events_fenced(cap,e)=0 and pg_temp.state(a)=before_state,'fenced duplicate coalesces');
 perform pg_temp.ok(public.record_whatsapp_template_events(a,e)=0 and pg_temp.state(a)=before_state,'legacy wrapper shares dedupe');
 e:=jsonb_build_array((e->0)||jsonb_build_object('digest',repeat('2',64),'remote_status','APPROVED'));
 perform pg_temp.ok(public.record_whatsapp_template_events(a,e)=1,'legacy wrapper preserves positive count');
 perform pg_temp.ok((select remote_status='PAUSED' and local_status='paused' and sync_epoch=2 from public.whatsapp_remote_templates where id=t),'legacy approval never releases');
 before_state:=pg_temp.state(a);
 foreach k in array array['channelId','unitId','provider','phoneNumberId','wabaId','organizationId','unitOrganizationId','bindingId','accountId','verifiedAt','bindingGeneration','accountGeneration','credentialRevision','bindingCredentialRevision'] loop
   bad:=cap||jsonb_build_object(k,case when k in('bindingGeneration','accountGeneration','credentialRevision','bindingCredentialRevision') then '999'::jsonb else '"wrong"'::jsonb end);
   perform pg_temp.denied(format('select public.record_whatsapp_template_events_fenced(%L,%L)',bad,e),'PT503','capture mismatch '||k);
 end loop;
 foreach bad in array array[null::jsonb,'null'::jsonb,'[]'::jsonb,cap||'{"extra":true}',cap-'bindingId',cap||'{"bindingGeneration":"1"}',cap||'{"verifiedAt":null}'] loop
   perform pg_temp.denied(format('select public.record_whatsapp_template_events_fenced(%L,%L)',bad,e),'PT503','closed typed capture');
 end loop;
 perform pg_temp.ok(pg_temp.state(a)=before_state,'all invalid captures zero effects');
 bad:=jsonb_build_array((e->0)||jsonb_build_object('digest',repeat('3',64)),(e->0)||jsonb_build_object('field','invalid','digest',repeat('4',64)));
 perform pg_temp.denied(format('select public.record_whatsapp_template_events_fenced(%L,%L)',cap,bad),'23514','fenced invalid sibling rolls back');
 perform pg_temp.ok(pg_temp.state(a)=before_state,'rollback includes events epochs revision jobs');
 perform pg_temp.denied(format('select public.record_whatsapp_template_events(%L,%L)',a,bad),'23514','legacy invalid sibling rolls back');
 perform pg_temp.ok(pg_temp.state(a)=before_state,'legacy rollback parity');
 update public.whatsapp_channels set credentials=credentials||'{"access_token":"fake-local-rotation"}' where id=c;
 perform pg_temp.denied(format('select public.record_whatsapp_template_events_fenced(%L,%L)',cap,e),'PT503','rotation after capture refused');
 perform pg_temp.ok(pg_temp.state(a)=before_state,'rotation refusal zero event effects');
 perform public.reconcile_whatsapp_template_credentials(c);
 perform public.bind_whatsapp_template_account(c,(cap->>'unitId')::uuid,'datafy',1,cap->>'phoneNumberId',cap->>'wabaId');
 before_state:=pg_temp.state(a);
 perform pg_temp.denied(format('select public.record_whatsapp_template_events_fenced(%L,%L)',cap,e),'PT503','reconcile rebind rejects old capture');
 perform pg_temp.ok(pg_temp.state(a)=before_state,'rebind refusal zero event effects');
 cap:=pg_temp.capture(c);
 perform public.bind_whatsapp_template_account(c,(cap->>'unitId')::uuid,'datafy',1,cap->>'phoneNumberId',cap->>'wabaId');
 perform pg_temp.denied(format('select public.record_whatsapp_template_events_fenced(%L,%L)',cap,e),'PT503','same-generation reverification fences exact timestamp');
 cap:=pg_temp.capture(c);update public.whatsapp_template_accounts set binding_generation=binding_generation+1 where id=a;
 before_state:=pg_temp.state(a);
 perform pg_temp.denied(format('select public.record_whatsapp_template_events_fenced(%L,%L)',cap,e),'PT503','account generation changed refuses capture');
 perform pg_temp.ok(pg_temp.state(a)=before_state,'generation refusal zero event effects');
 cap:=pg_temp.capture(c);e:=jsonb_build_array((e->0)||jsonb_build_object('digest',repeat('5',64),'remote_status','DISABLED'));
 perform pg_temp.ok(public.record_whatsapp_template_events_fenced(cap,e)=1,'current capture restores positive path');
 foreach r in array array['anon','authenticated','service_role'] loop
   perform pg_temp.ok(not has_function_privilege(r,'app_private.record_whatsapp_template_events_core(uuid,uuid,jsonb)','EXECUTE'),'private core denied '||r);
   foreach n in array array['public.record_whatsapp_template_events(uuid,jsonb)','public.record_whatsapp_template_events_fenced(jsonb,jsonb)'] loop
     perform pg_temp.ok(has_function_privilege(r,n,'EXECUTE')=(r='service_role'),'wrapper ACL '||r||' '||n);
   end loop;
 end loop;
 perform pg_temp.ok(not exists(select from pg_proc p, lateral aclexplode(p.proacl) x where p.oid in('app_private.record_whatsapp_template_events_core(uuid,uuid,jsonb)'::regprocedure,'public.record_whatsapp_template_events(uuid,jsonb)'::regprocedure,'public.record_whatsapp_template_events_fenced(jsonb,jsonb)'::regprocedure) and x.grantee=0),'PUBLIC has no execute');
end$$;
select count(*) as passed_checks from event_authority_checks;
rollback;
