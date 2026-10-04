\set ON_ERROR_STOP on
begin;
-- This exact assertion must fail with 42P01 before the product migration.
do $$ begin
  if not exists(select from pg_class where oid='public.whatsapp_template_accounts'::regclass and relrowsecurity and relforcerowsecurity) then raise exception 'TEMPLATE-RLS: RLS nao forcada'; end if;
  if has_table_privilege('anon','public.whatsapp_template_accounts','SELECT') then raise exception 'TEMPLATE-ACL: anon ganhou leitura'; end if;
end $$;
create temporary table template_test_results(label text primary key);
create function pg_temp.assert_template(p_ok boolean,p_label text) returns void language plpgsql as $$begin
  if p_ok is distinct from true then raise exception 'TEMPLATE-TEST: %',p_label; end if;
  insert into template_test_results values(p_label);
end $$;
create function pg_temp.expect_template_error(p_sql text,p_code text,p_label text) returns void language plpgsql as $$begin
  begin execute p_sql;
  exception when others then
    if sqlstate<>p_code then raise exception 'TEMPLATE-TEST: % expected %, got %: %',p_label,p_code,sqlstate,sqlerrm; end if;
    insert into template_test_results values(p_label); return;
  end;
  raise exception 'TEMPLATE-TEST: % unexpectedly succeeded',p_label;
end $$;
do $$ declare t text; r text; p text; begin
  foreach t in array array['whatsapp_template_accounts','whatsapp_template_bindings','whatsapp_remote_templates','whatsapp_template_jobs','whatsapp_template_events','whatsapp_automation_jobs','whatsapp_message_consent_events','whatsapp_message_preference_tokens','whatsapp_promotion_slots','whatsapp_template_cost_authorizations','whatsapp_automation_receipt_events','whatsapp_automation_adoptions'] loop
    perform pg_temp.assert_template((select relrowsecurity and relforcerowsecurity from pg_class where oid=('public.'||t)::regclass),t||'_force_rls');
    perform pg_temp.assert_template(not exists(select from pg_policy where polrelid=('public.'||t)::regclass),t||'_no_policy');
    foreach r in array array['anon','authenticated'] loop
      foreach p in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] loop
        perform pg_temp.assert_template(not has_table_privilege(r,'public.'||t,p),t||'_'||r||'_'||p||'_denied');
      end loop;
    end loop;
    foreach p in array array['TRUNCATE','REFERENCES','TRIGGER'] loop
      perform pg_temp.assert_template(not has_table_privilege('service_role','public.'||t,p),t||'_service_'||p||'_denied');
    end loop;
  end loop;
  perform pg_temp.assert_template(not has_table_privilege('service_role','public.whatsapp_automation_adoptions','INSERT,UPDATE,DELETE'),'adoption_service_read_only');
  foreach r in array array['anon','authenticated','service_role'] loop
    perform pg_temp.assert_template(not has_table_privilege(r,'app_private.whatsapp_template_maintenance_permits','SELECT,INSERT,UPDATE,DELETE'),'permit_'||r||'_denied');
  end loop;
  foreach t in array array['guard_whatsapp_template_scope','guard_whatsapp_template_evidence','guard_whatsapp_legacy_template_write'] loop
    foreach r in array array['anon','authenticated','service_role'] loop
      perform pg_temp.assert_template(not has_function_privilege(r,'public.'||t||'()','EXECUTE'),t||'_'||r||'_denied');
    end loop;
  end loop;
end $$;
set local role service_role;
insert into public.whatsapp_template_accounts(id,organization_id,waba_id,verified_at) values('11111111-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','123456789',now());
insert into public.whatsapp_template_bindings(id,unit_id,channel_id,account_id,provider,verified_at) values
 ('22222222-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000001','dddddddd-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001','datafy',now()),
 ('22222222-0000-0000-0000-000000000002','bbbbbbbb-0000-0000-0000-000000000002','dddddddd-0000-0000-0000-000000000002','11111111-0000-0000-0000-000000000001','official',now()),
 ('22222222-0000-0000-0000-000000000003','bbbbbbbb-0000-0000-0000-000000000003','dddddddd-0000-0000-0000-000000000003',null,'zapi',now());
reset role;
select pg_temp.assert_template((select count(*)=2 from public.whatsapp_template_bindings where account_id='11111111-0000-0000-0000-000000000001'),'shared_waba_same_org');
select pg_temp.assert_template((select bool_and(not dispatch_enabled and adopted_at is null) from public.whatsapp_template_bindings),'dispatch_default_off');
select pg_temp.expect_template_error($q$insert into public.whatsapp_template_accounts(organization_id,waba_id,verified_at) values('aaaaaaaa-0000-0000-0000-000000000002','123456789',now())$q$,'23505','waba_unique_independent_provider');
select pg_temp.expect_template_error($q$insert into public.whatsapp_template_accounts(id,organization_id,waba_id,verified_at) values('11111111-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000002','987654321',now()); insert into public.whatsapp_template_bindings(unit_id,channel_id,account_id,provider) values('bbbbbbbb-0000-0000-0000-000000000001','dddddddd-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000002','datafy')$q$,'23514','cross_org_account_binding');
select pg_temp.expect_template_error($q$insert into public.whatsapp_template_bindings(unit_id,channel_id,account_id,provider) values('bbbbbbbb-0000-0000-0000-000000000002','dddddddd-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001','datafy')$q$,'23514','channel_unit_mismatch');
select pg_temp.expect_template_error($q$update public.whatsapp_template_bindings set adopted_at=now(),dispatch_enabled=true where id='22222222-0000-0000-0000-000000000001'$q$,'42501','generic_adoption_denied');
insert into public.whatsapp_remote_templates(id,account_id,logical_id,version,language,name,desired_hash,requested_category,binding_generation) values('33333333-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001','res_confirmacao_v1',1,'pt_BR','res_confirmacao_v1',repeat('a',64),'UTILITY',1);
insert into public.whatsapp_remote_templates(account_id,logical_id,version,language,name,remote_id,desired_hash,requested_category,binding_generation) values('11111111-0000-0000-0000-000000000001','res_confirmacao_v1',2,'pt_BR',repeat('n',512),repeat('R',512),repeat('a',64),'UTILITY',1);
select pg_temp.assert_template(exists(select from public.whatsapp_remote_templates where char_length(name)=512 and char_length(remote_id)=512),'remote_technical_id_bound_512');
insert into public.whatsapp_automation_jobs(id,unit_id,organization_id,kind,reservation_id,customer_id,source_event_key,fact_at,channel_id,provider,binding_id,binding_generation,transport,account_id,remote_template_id,template_version,sync_epoch,expires_at)
 values('44444444-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','confirmation','eeeeeeee-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000001','fixture_fact',now(),'dddddddd-0000-0000-0000-000000000001','datafy','22222222-0000-0000-0000-000000000001',1,'template','11111111-0000-0000-0000-000000000001','33333333-0000-0000-0000-000000000001',1,0,now());
select pg_temp.assert_template((select expires_at=fact_at from public.whatsapp_automation_jobs where id='44444444-0000-0000-0000-000000000001'),'confirmation_zero_ttl_valid');
select pg_temp.assert_template(public.normalize_br_phone('55911110001')='55911110001' and public.normalize_br_phone('+55 (11) 91111-0001')='11911110001' and public.normalize_br_phone('1191110001')='11991110001','phone_canonicalizer_preserves_DDD55');
insert into public.customers(id,organization_id,name,phone) values('cccccccc-0000-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000001','Different A','11911110003'),('cccccccc-0000-0000-0000-000000000004','aaaaaaaa-0000-0000-0000-000000000002','Same phone B','11911110001');
insert into public.whatsapp_automation_jobs select (jsonb_populate_record(null::public.whatsapp_automation_jobs,to_jsonb(j)||jsonb_build_object('id',gen_random_uuid(),'notification_id',gen_random_uuid(),'kind','waitlist_entered','reservation_id',null,'waitlist_id','eeeeeeee-0000-0000-0000-000000000002'))).* from public.whatsapp_automation_jobs j where id='44444444-0000-0000-0000-000000000001';
select pg_temp.assert_template((select customer_id='cccccccc-0000-0000-0000-000000000001' from public.whatsapp_automation_jobs where kind='waitlist_entered'),'waitlist_null_FK_resolves_canonical_customer_in_resource_org');
delete from public.whatsapp_automation_jobs where kind='waitlist_entered';
select pg_temp.expect_template_error($q$insert into public.whatsapp_automation_jobs select (jsonb_populate_record(null::public.whatsapp_automation_jobs,to_jsonb(j)||jsonb_build_object('id',gen_random_uuid(),'notification_id',gen_random_uuid(),'kind','waitlist_entered','reservation_id',null,'waitlist_id','eeeeeeee-0000-0000-0000-000000000002','customer_id',null))).* from public.whatsapp_automation_jobs j where id='44444444-0000-0000-0000-000000000001'$q$,'23514','waitlist_resolved_customer_cannot_be_omitted');
update public.waitlist set customer_id='cccccccc-0000-0000-0000-000000000003' where id='eeeeeeee-0000-0000-0000-000000000002';
select pg_temp.expect_template_error($q$insert into public.whatsapp_automation_jobs select (jsonb_populate_record(null::public.whatsapp_automation_jobs,to_jsonb(j)||jsonb_build_object('id',gen_random_uuid(),'notification_id',gen_random_uuid(),'kind','waitlist_entered','reservation_id',null,'waitlist_id','eeeeeeee-0000-0000-0000-000000000002'))).* from public.whatsapp_automation_jobs j where id='44444444-0000-0000-0000-000000000001'$q$,'23514','waitlist_incompatible_FK_never_falls_back');
update public.waitlist set customer_id='cccccccc-0000-0000-0000-000000000001' where id='eeeeeeee-0000-0000-0000-000000000002';
insert into public.whatsapp_automation_jobs select (jsonb_populate_record(null::public.whatsapp_automation_jobs,to_jsonb(j)||jsonb_build_object('id',gen_random_uuid(),'notification_id',gen_random_uuid(),'kind','waitlist_entered','reservation_id',null,'waitlist_id','eeeeeeee-0000-0000-0000-000000000002'))).* from public.whatsapp_automation_jobs j where id='44444444-0000-0000-0000-000000000001';
select pg_temp.assert_template((select customer_id='cccccccc-0000-0000-0000-000000000001' from public.whatsapp_automation_jobs where kind='waitlist_entered'),'waitlist_compatible_FK_preserved');
delete from public.whatsapp_automation_jobs where kind='waitlist_entered';
update public.waitlist set customer_id=null,customer_phone='+55 (11) 91111-0002' where id='eeeeeeee-0000-0000-0000-000000000002';
insert into public.whatsapp_automation_jobs select (jsonb_populate_record(null::public.whatsapp_automation_jobs,to_jsonb(j)||jsonb_build_object('id',gen_random_uuid(),'notification_id',gen_random_uuid(),'kind','waitlist_entered','reservation_id',null,'waitlist_id','eeeeeeee-0000-0000-0000-000000000002','customer_id',null))).* from public.whatsapp_automation_jobs j where id='44444444-0000-0000-0000-000000000001';
select pg_temp.assert_template((select customer_id is null from public.whatsapp_automation_jobs where kind='waitlist_entered') and (select count(*)=4 from public.customers),'waitlist_missing_customer_does_not_match_other_org_or_create');
delete from public.whatsapp_automation_jobs where kind='waitlist_entered';
update public.waitlist set customer_phone='+55 (11) 91111-0001' where id='eeeeeeee-0000-0000-0000-000000000002';
insert into public.whatsapp_automation_jobs select (jsonb_populate_record(null::public.whatsapp_automation_jobs,to_jsonb(j)||jsonb_build_object('id',gen_random_uuid(),'notification_id',gen_random_uuid(),'kind','reminder_d1'))).* from public.whatsapp_automation_jobs j where id='44444444-0000-0000-0000-000000000001';
select pg_temp.assert_template((select expires_at=fact_at from public.whatsapp_automation_jobs where kind='reminder_d1'),'reminder_zero_ttl_valid');
delete from public.whatsapp_automation_jobs where kind='reminder_d1';
select pg_temp.expect_template_error($q$insert into public.whatsapp_automation_jobs select (jsonb_populate_record(null::public.whatsapp_automation_jobs,to_jsonb(j)||jsonb_build_object('id',gen_random_uuid(),'notification_id',gen_random_uuid(),'kind','reminder_d1','expires_at',j.fact_at-interval '1 second'))).* from public.whatsapp_automation_jobs j where id='44444444-0000-0000-0000-000000000001'$q$,'23514','expiry_before_fact_denied');
select pg_temp.expect_template_error($q$update public.whatsapp_automation_jobs set notification_id=gen_random_uuid() where id='44444444-0000-0000-0000-000000000001'$q$,'23514','notification_id_pinned');
select pg_temp.expect_template_error($q$update public.whatsapp_automation_jobs set transport='text',account_id=null,remote_template_id=null,template_version=null,sync_epoch=null where id='44444444-0000-0000-0000-000000000001'$q$,'23514','transport_pinned');
select pg_temp.expect_template_error($q$update public.whatsapp_automation_jobs set waitlist_id='eeeeeeee-0000-0000-0000-000000000002' where id='44444444-0000-0000-0000-000000000001'$q$,'23514','resource_exactly_one');
select pg_temp.expect_template_error($q$update public.whatsapp_automation_jobs set safe_log_body='https://example.com/preferencias/mensagens/'||repeat('A',43) where id='44444444-0000-0000-0000-000000000001'$q$,'23514','raw_preference_token_denied');
select pg_temp.expect_template_error($q$update public.whatsapp_automation_jobs set customer_id=null,customer_erased_at=now() where id='44444444-0000-0000-0000-000000000001'$q$,'23514','live_customer_erasure_denied');
select pg_temp.expect_template_error($q$update public.whatsapp_automation_jobs set organization_id='aaaaaaaa-0000-0000-0000-000000000002' where id='44444444-0000-0000-0000-000000000001'$q$,'23514','job_org_mismatch');
select pg_temp.expect_template_error($q$update public.whatsapp_automation_jobs set provider_message_id=E'unsafe\nmessage' where id='44444444-0000-0000-0000-000000000001'$q$,'23514','provider_id_controls_denied');
select pg_temp.expect_template_error($q$update public.whatsapp_automation_jobs set sync_epoch=1 where id='44444444-0000-0000-0000-000000000001'$q$,'23514','epoch_requires_current_approved_snapshot');
update public.whatsapp_template_accounts set binding_generation=2 where id='11111111-0000-0000-0000-000000000001';
update public.whatsapp_remote_templates set sync_epoch=1,sync_required=false,remote_status='APPROVED',local_status='usable',observed_hash=desired_hash,last_synced_at=now() where id='33333333-0000-0000-0000-000000000001';
select pg_temp.expect_template_error($q$update public.whatsapp_automation_jobs set sync_epoch=1 where id='44444444-0000-0000-0000-000000000001'$q$,'23514','epoch_obsolete_account_generation_denied');
update public.whatsapp_remote_templates set binding_generation=2 where id='33333333-0000-0000-0000-000000000001';
update public.whatsapp_automation_jobs set sync_epoch=1 where id='44444444-0000-0000-0000-000000000001';
select pg_temp.assert_template((select sync_epoch=1 and template_version=1 and posting_started_at is null from public.whatsapp_automation_jobs where id='44444444-0000-0000-0000-000000000001'),'prepost_refresh_same_template_epoch');
select pg_temp.assert_template((select j.binding_generation=1 and r.binding_generation=2 from public.whatsapp_automation_jobs j join public.whatsapp_remote_templates r on r.id=j.remote_template_id where j.id='44444444-0000-0000-0000-000000000001'),'account_and_binding_generation_independent');
update public.whatsapp_automation_jobs set safe_log_body='First safe render' where id='44444444-0000-0000-0000-000000000001';
update public.whatsapp_automation_jobs set safe_log_body='Refreshed safe render' where id='44444444-0000-0000-0000-000000000001';
select pg_temp.assert_template((select safe_log_body='Refreshed safe render' from public.whatsapp_automation_jobs where id='44444444-0000-0000-0000-000000000001'),'prepost_safe_render_can_refresh');
insert into public.whatsapp_message_consent_events(unit_id,customer_id,purpose,decision,source_code,evidence_reference,observed_at,revision) values
 ('bbbbbbbb-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000001','promotional','opt_in','documented_permission','fixture_evidence',now(),999),
 ('bbbbbbbb-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000001','promotional','opt_out','documented_permission','fixture_evidence',now()-interval '1 day',999);
select pg_temp.assert_template((select array_agg(revision order by revision)=array[1,2]::bigint[] from public.whatsapp_message_consent_events),'revision_sql_not_body_or_observed_at');
select pg_temp.expect_template_error($q$update public.whatsapp_message_consent_events set decision='opt_in' where revision=2$q$,'23514','consent_append_only');
select pg_temp.expect_template_error($q$delete from public.whatsapp_message_consent_events$q$,'23514','consent_live_delete_denied');
select pg_temp.expect_template_error($q$insert into public.whatsapp_message_consent_events(unit_id,customer_id,purpose,decision,source_code,evidence_reference,observed_at,revision) values('bbbbbbbb-0000-0000-0000-000000000003','cccccccc-0000-0000-0000-000000000001','promotional','opt_in','evidence','fixture',now(),1)$q$,'23514','consent_customer_org_mismatch');
select pg_temp.expect_template_error($q$insert into public.whatsapp_message_preference_tokens(unit_id,customer_id,token_hash,expires_at) values('bbbbbbbb-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000001','raw_token',now()+interval '1 day')$q$,'23514','preference_hash_only');
insert into public.whatsapp_message_preference_tokens(unit_id,customer_id,token_hash,expires_at) values('bbbbbbbb-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000001',repeat('b',64),now()+interval '90 days');
select pg_temp.expect_template_error($q$update public.whatsapp_message_preference_tokens set token_hash=repeat('c',64)$q$,'23514','token_identity_immutable');
insert into public.whatsapp_automation_receipt_events(unit_id,provider,channel_id,provider_message_id,status,provider_timestamp,digest) values('bbbbbbbb-0000-0000-0000-000000000001','datafy','dddddddd-0000-0000-0000-000000000001','fixture_message','read',now(),repeat('d',64));
insert into public.whatsapp_automation_receipt_events(unit_id,provider,channel_id,provider_message_id,status,provider_timestamp,digest) values('bbbbbbbb-0000-0000-0000-000000000001','datafy','dddddddd-0000-0000-0000-000000000001',repeat('M',512),'read',now(),repeat('c',64));
select pg_temp.assert_template(exists(select from public.whatsapp_automation_receipt_events where char_length(provider_message_id)=512),'provider_message_id_512_preserved');
select pg_temp.expect_template_error($q$insert into public.whatsapp_automation_receipt_events(unit_id,provider,channel_id,provider_message_id,status,provider_timestamp,digest) values('bbbbbbbb-0000-0000-0000-000000000001','datafy','dddddddd-0000-0000-0000-000000000001',repeat('M',513),'read',now(),repeat('f',64))$q$,'23514','provider_message_id_513_denied');
select pg_temp.expect_template_error($q$insert into public.whatsapp_automation_receipt_events(unit_id,provider,channel_id,provider_message_id,status,provider_timestamp,digest) values('bbbbbbbb-0000-0000-0000-000000000003','datafy','dddddddd-0000-0000-0000-000000000001','fixture_message','read',now(),repeat('e',64))$q$,'23514','receipt_tenant_mismatch');
select pg_temp.expect_template_error($q$update public.whatsapp_automation_receipt_events set status='sent'$q$,'23514','receipt_evidence_immutable');
select pg_temp.assert_template((select body='Texto legado preservado' from public.reservation_message_templates where unit_id='bbbbbbbb-0000-0000-0000-000000000001' and event='reminder_d1'),'legacy_body_preserved');
select pg_temp.expect_template_error($q$update public.reservation_message_templates set body='Forbidden' where unit_id='bbbbbbbb-0000-0000-0000-000000000001'$q$,'42501','generic_service_legacy_guard');
-- Claims below are SQL fixture context, not proof of a signed JWT (separate REST tests).
insert into auth.users(id) values('99999999-0000-0000-0000-000000000001') on conflict do nothing;
insert into public.platform_admins(user_id) values('99999999-0000-0000-0000-000000000001') on conflict do nothing;
select set_config('request.jwt.claims','{"sub":"99999999-0000-0000-0000-000000000001","role":"authenticated"}',true);
update public.whatsapp_template_bindings set adopted_at='2000-01-01',dispatch_enabled=true where id='22222222-0000-0000-0000-000000000001';
select pg_temp.assert_template((select adopted_at=now() from public.whatsapp_template_bindings where id='22222222-0000-0000-0000-000000000001'),'adoption_uses_sql_clock');
select pg_temp.expect_template_error($q$update public.whatsapp_template_bindings set adopted_at=null,dispatch_enabled=false where id='22222222-0000-0000-0000-000000000001'$q$,'23514','binding_adoption_cannot_reset');
select pg_temp.expect_template_error($q$delete from public.whatsapp_automation_adoptions where unit_id='bbbbbbbb-0000-0000-0000-000000000001'$q$,'23514','unit_adoption_immutable');
insert into public.whatsapp_template_cost_authorizations(id,account_id,binding_id,binding_generation,category,valid_from,valid_until,actor_id) values('55555555-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001','22222222-0000-0000-0000-000000000001',1,'MARKETING',now(),now()+interval '1 day','99999999-0000-0000-0000-000000000001');
select pg_temp.expect_template_error($q$update public.whatsapp_template_cost_authorizations set valid_until=now()+interval '10 days'$q$,'23514','cost_decision_immutable');
select pg_temp.expect_template_error($q$insert into public.whatsapp_template_cost_authorizations(account_id,binding_id,binding_generation,category,valid_from,valid_until,actor_id) values('11111111-0000-0000-0000-000000000001','22222222-0000-0000-0000-000000000002',999,'MARKETING',now(),now()+interval '1 day','99999999-0000-0000-0000-000000000001')$q$,'23514','cost_binding_generation_mismatch');
select pg_temp.expect_template_error($q$insert into public.whatsapp_template_cost_authorizations(account_id,binding_id,binding_generation,category,valid_from,valid_until,actor_id) values('11111111-0000-0000-0000-000000000001','22222222-0000-0000-0000-000000000001',1,'MARKETING',now()+interval '1 day',now(),'99999999-0000-0000-0000-000000000001')$q$,'23514','cost_invalid_vigency');
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select pg_temp.expect_template_error($q$insert into public.whatsapp_template_cost_authorizations(account_id,binding_id,binding_generation,category,valid_from,valid_until,actor_id) values('11111111-0000-0000-0000-000000000001','22222222-0000-0000-0000-000000000001',1,'MARKETING',now(),now()+interval '1 day','99999999-0000-0000-0000-000000000001')$q$,'42501','cost_service_cannot_forge_actor');
insert into public.whatsapp_template_jobs(id,account_id,binding_id,binding_generation,operation,target_key) values('66666666-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001','22222222-0000-0000-0000-000000000001',1,'provision','fixture_template');
update public.whatsapp_automation_jobs set state='uncertain',claim_token='77777777-0000-0000-0000-000000000001',claimed_until=now()+interval '90 seconds',posting_started_at=now() where id='44444444-0000-0000-0000-000000000001';
select pg_temp.expect_template_error($q$update public.whatsapp_automation_jobs set safe_log_body='Changed after POST' where id='44444444-0000-0000-0000-000000000001'$q$,'23514','posted_safe_render_immutable');
update public.whatsapp_remote_templates set sync_epoch=2 where id='33333333-0000-0000-0000-000000000001';
select pg_temp.expect_template_error($q$update public.whatsapp_automation_jobs set sync_epoch=2 where id='44444444-0000-0000-0000-000000000001'$q$,'23514','posted_epoch_cannot_change');
delete from public.whatsapp_channels where id='dddddddd-0000-0000-0000-000000000001';
select pg_temp.assert_template(not exists(select from public.whatsapp_template_bindings where id='22222222-0000-0000-0000-000000000001'),'channel_deletion_removes_binding');
select pg_temp.assert_template((select state='uncertain' and claim_token='77777777-0000-0000-0000-000000000001' from public.whatsapp_automation_jobs where id='44444444-0000-0000-0000-000000000001'),'deleted_channel_preserves_intent_fence');
select pg_temp.assert_template(exists(select from public.whatsapp_automation_adoptions where unit_id='bbbbbbbb-0000-0000-0000-000000000001'),'deleted_channel_preserves_unit_adoption');
select pg_temp.assert_template(exists(select from public.whatsapp_automation_receipt_events where channel_id='dddddddd-0000-0000-0000-000000000001'),'deleted_channel_preserves_receipt');
update public.whatsapp_template_jobs set state='uncertain',claim_token=gen_random_uuid(),claimed_until=now()+interval '90 seconds' where id='66666666-0000-0000-0000-000000000001';
update public.whatsapp_automation_jobs set state='accepted',provider_message_id='late_fixture_acceptance',reconcile_required=true where id='44444444-0000-0000-0000-000000000001';
select pg_temp.assert_template((select state='accepted' and claim_token='77777777-0000-0000-0000-000000000001' from public.whatsapp_automation_jobs where id='44444444-0000-0000-0000-000000000001'),'late_acceptance_after_channel_deletion');
update public.whatsapp_automation_jobs set provider_message_id='late_fixture_acceptance' where id='44444444-0000-0000-0000-000000000001';
select pg_temp.assert_template((select provider_message_id='late_fixture_acceptance' from public.whatsapp_automation_jobs where id='44444444-0000-0000-0000-000000000001'),'same_provider_id_repair_idempotent');
select pg_temp.expect_template_error($q$update public.whatsapp_automation_jobs set provider_message_id='another_provider_id' where id='44444444-0000-0000-0000-000000000001'$q$,'23514','accepted_provider_id_cannot_change');
select pg_temp.expect_template_error($q$update public.whatsapp_automation_jobs set provider_message_id=null where id='44444444-0000-0000-0000-000000000001'$q$,'23514','accepted_provider_id_cannot_clear');
-- Restore the channel only for a coherent competing INSERT; natural key still wins.
insert into public.whatsapp_channels(id,unit_id,provider,status,is_active) values('dddddddd-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000001','datafy','connected',true);
insert into public.whatsapp_template_bindings(id,unit_id,channel_id,account_id,provider) values('22222222-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000001','dddddddd-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001','datafy');
select pg_temp.expect_template_error($q$insert into public.whatsapp_automation_jobs select (jsonb_populate_record(null::public.whatsapp_automation_jobs,to_jsonb(j)||jsonb_build_object('id',gen_random_uuid(),'notification_id',gen_random_uuid(),'kind','reminder_d1'))).* from public.whatsapp_automation_jobs j where id='44444444-0000-0000-0000-000000000001'$q$,'23505','provider_receipt_correlates_one_job_only');
select pg_temp.expect_template_error($q$insert into public.whatsapp_automation_jobs(unit_id,organization_id,kind,reservation_id,customer_id,source_event_key,fact_at,channel_id,provider,binding_id,binding_generation,transport,account_id,remote_template_id,template_version,sync_epoch,expires_at) values('bbbbbbbb-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','confirmation','eeeeeeee-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000001','other_source',now(),'dddddddd-0000-0000-0000-000000000001','datafy','22222222-0000-0000-0000-000000000001',1,'template','11111111-0000-0000-0000-000000000001','33333333-0000-0000-0000-000000000001',1,0,now()+interval '1 day')$q$,'23505','resource_key_survives_binding_replacement');
update public.customers set deleted_at=now() where id='cccccccc-0000-0000-0000-000000000001';
select pg_temp.expect_template_error($q$insert into public.whatsapp_message_consent_events(unit_id,customer_id,purpose,decision,source_code,evidence_reference,observed_at,revision) values('bbbbbbbb-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000001','promotional','opt_in','evidence','fixture',now(),1)$q$,'P0A15','deleted_customer_insert_denied');
update public.whatsapp_automation_jobs set customer_id=null where id='44444444-0000-0000-0000-000000000001';
select pg_temp.assert_template((select customer_erased_at is not null and state='accepted' and claim_token='77777777-0000-0000-0000-000000000001' from public.whatsapp_automation_jobs where id='44444444-0000-0000-0000-000000000001'),'verified_erasure_preserves_posted_evidence');
delete from public.whatsapp_message_consent_events where customer_id='cccccccc-0000-0000-0000-000000000001';
delete from public.whatsapp_message_preference_tokens where customer_id='cccccccc-0000-0000-0000-000000000001';
select pg_temp.assert_template(not exists(select from public.whatsapp_message_consent_events),'deleted_customer_evidence_purge_allowed');
select set_config('request.jwt.claims','{"sub":"99999999-0000-0000-0000-000000000001","role":"authenticated"}',true);
select public.maintain_whatsapp_legacy_template('reservation_message_templates','INSERT',null,'bbbbbbbb-0000-0000-0000-000000000002','reminder_d1','Cascade fixture',true,'Local fixture');
select public.maintain_whatsapp_legacy_template('waitlist_message_templates','INSERT',null,'bbbbbbbb-0000-0000-0000-000000000002','entered','Cascade fixture',true,'Local fixture');
select public.maintain_whatsapp_legacy_template('settings','INSERT',null,'bbbbbbbb-0000-0000-0000-000000000002','giftback_message_template','After rating legacy untouched',true,'Local fixture');
select pg_temp.expect_template_error($q$update public.reservation_message_templates set unit_id='bbbbbbbb-0000-0000-0000-000000000003' where unit_id='bbbbbbbb-0000-0000-0000-000000000002'$q$,'42501','OLD_official_scope_blocks_move');
select pg_temp.expect_template_error($q$update public.settings set key='unrelated_new_key' where unit_id='bbbbbbbb-0000-0000-0000-000000000002' and key='giftback_message_template'$q$,'42501','OLD_giftback_key_blocks_move');
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select pg_temp.expect_template_error($q$delete from public.waitlist_message_templates where unit_id='bbbbbbbb-0000-0000-0000-000000000002'$q$,'42501','ordinary_service_delete_still_denied');
set local role service_role;
delete from public.units where id='bbbbbbbb-0000-0000-0000-000000000002';
reset role;
select pg_temp.assert_template(not exists(select from public.reservation_message_templates where unit_id='bbbbbbbb-0000-0000-0000-000000000002') and not exists(select from public.waitlist_message_templates where unit_id='bbbbbbbb-0000-0000-0000-000000000002') and not exists(select from public.settings where unit_id='bbbbbbbb-0000-0000-0000-000000000002'),'verified_unit_cascade_allowed');
select pg_temp.assert_template(not exists(select from app_private.whatsapp_template_maintenance_permits),'maintenance_permits_do_not_escape');
select set_config('request.jwt.claims','{"sub":"99999999-0000-0000-0000-000000000001","role":"authenticated"}',true);
update public.whatsapp_channels set is_active=false where id='dddddddd-0000-0000-0000-000000000001';
insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,created_at,updated_at) values('dddddddd-0000-0000-0000-000000000004','bbbbbbbb-0000-0000-0000-000000000001','official','connected',null,now()-interval '2 days',now()-interval '3 days'),('dddddddd-0000-0000-0000-000000000005','bbbbbbbb-0000-0000-0000-000000000001','zapi','connected',null,now()-interval '1 day',now());
select pg_temp.expect_template_error($q$update public.reservation_message_templates set body='Forbidden fallback write' where unit_id='bbbbbbbb-0000-0000-0000-000000000001'$q$,'42501','fallback_oldest_created_official_ignores_newest_updated_zapi');
update public.whatsapp_channels set is_active=true,status='disconnected' where id='dddddddd-0000-0000-0000-000000000005';
update public.reservation_message_templates set body='Selected explicit nonofficial' where unit_id='bbbbbbbb-0000-0000-0000-000000000001';
select pg_temp.assert_template((select body='Selected explicit nonofficial' from public.reservation_message_templates where unit_id='bbbbbbbb-0000-0000-0000-000000000001'),'explicit_active_selection_independent_of_connected_status');
select count(*) as assertions_passed from template_test_results;
rollback;
do $$ begin
  if exists(select from public.whatsapp_template_accounts where waba_id='123456789') then raise exception 'TEMPLATE-TEST: transaction rollback left fixture data'; end if;
end $$;
