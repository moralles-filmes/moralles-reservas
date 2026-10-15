-- 00/00a/61a + Task2 + 62a/63a + Task7. Somente banco descartável.
\set ON_ERROR_STOP on
begin;
insert into auth.users(id) values('eeeeeeee-0063-0000-0000-000000000001');
insert into public.platform_admins(user_id) values('eeeeeeee-0063-0000-0000-000000000001');
insert into public.units(id,organization_id,name) values
 ('bbbbbbbb-0063-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','local63-a'),
 ('bbbbbbbb-0063-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000002','local63-b'),
 ('bbbbbbbb-0063-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000001','local63-a2');
insert into public.whatsapp_official_connection_grants(id,unit_id,organization_id,granted_by) values
 ('ffffffff-0063-0000-0000-000000000001','bbbbbbbb-0063-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','eeeeeeee-0063-0000-0000-000000000001');
insert into public.whatsapp_datafy_onboardings(id,unit_id,organization_id,reserved_channel_id,datafy_channel_id,state,grant_id) values
 ('cccccccc-0063-0000-0000-000000000001','bbbbbbbb-0063-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001',
  'dddddddd-0063-0000-0000-000000000001','remote63','connected','ffffffff-0063-0000-0000-000000000001');
insert into public.whatsapp_channels(id,unit_id,provider,status,external_instance_id,is_active,credentials) values
 ('dddddddd-0063-0000-0000-000000000001','bbbbbbbb-0063-0000-0000-000000000001','datafy','connected','remote63',false,'{"business_account_id":"63001","phone_number_id":"6300001"}'),
 ('dddddddd-0063-0000-0000-000000000002','bbbbbbbb-0063-0000-0000-000000000002','datafy','connected','remote63b',false,'{}');

do $$ declare
 u uuid:='bbbbbbbb-0063-0000-0000-000000000001'; u2 uuid:='bbbbbbbb-0063-0000-0000-000000000002';
 c uuid:='dddddddd-0063-0000-0000-000000000001'; c2 uuid:='dddddddd-0063-0000-0000-000000000002';
 o uuid:='cccccccc-0063-0000-0000-000000000001'; a uuid:='eeeeeeee-0063-0000-0000-000000000001';
 g uuid:='ffffffff-0063-0000-0000-000000000001'; r record; active boolean;
begin
 -- WBR003: proveniência vem do onboarding, mesmo sem boolean no INSERT.
 if not (select datafy_subscription_required from public.whatsapp_channels where id=c) then raise exception 'provenance missing'; end if;
 begin update public.whatsapp_channels set datafy_subscription_required=false where id=c;
  raise exception 'provenance erasable'; exception when check_violation then null; end;
 -- 402 e as duas ordens eco/intenção; nenhum pedido sobrevive à recusa.
 for i in 1..2 loop
  if i=2 then update public.whatsapp_channels set manual_echo_verified_at=now() where id=c; end if;
  begin perform public.request_whatsapp_channel_activation(u,c,a,'local63');
   raise exception 'unsubscribed intent accepted'; exception when check_violation then null; end;
  begin perform public.activate_whatsapp_channel(u,c,a,'local63');
   raise exception 'unsubscribed activation accepted'; exception when check_violation then null; end;
 end loop;
 if exists(select from public.whatsapp_channels where id=c and (is_active or activation_requested_at is not null)) then raise exception 'unsubscribed became operational'; end if;
 -- Controle positivo da CHECK: remover só a defesa de escrita permite bypass direto.
 begin
  alter table public.whatsapp_channels drop constraint whatsapp_channels_datafy_self_service_subscription_chk;
  update public.whatsapp_channels set is_active=true where id=c;
  raise exception 'rollback positive' using errcode='ZZ063';
 exception when sqlstate 'ZZ063' then null; end;
 -- Manual legado NULL continua elegível; mesma org e assinatura + eco também.
 update public.whatsapp_channels set manual_echo_verified_at=now() where id=c2;
 perform public.request_whatsapp_channel_activation(u2,c2,a,'local63');
 perform public.activate_whatsapp_channel(u2,c2,a,'local63');
 update public.whatsapp_channels set provider_subscribed_at=now() where id=c;
 perform public.request_whatsapp_channel_activation(u,c,a,'local63');
 perform public.activate_whatsapp_channel(u,c,a,'local63');
 update public.whatsapp_channels set is_active=false where id=c;
 -- WBR001: outro provider aparece antes de finalizer ou depois da intenção.
 insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,manual_echo_verified_at)
  values('dddddddd-0063-0000-0000-000000000003',u,'zapi','connected',null,now());
 foreach active in array array[null::boolean,true] loop
  update public.whatsapp_channels set is_active=active where id='dddddddd-0063-0000-0000-000000000003';
  begin perform public.request_whatsapp_channel_activation(u,c,a,'local63');
   raise exception 'other-provider intent accepted'; exception when check_violation then null; end;
  -- Simula intenção já persistida antes do outro canal aparecer.
  update public.whatsapp_channels set activation_requested_at=now(),activation_requested_by=a where id=c;
  begin perform public.activate_whatsapp_channel(u,c,a,'local63');
   raise exception 'other-provider cutover accepted'; exception when check_violation then null; end;
  select * into r from public.claim_datafy_onboarding_step(o,u,'subscribe',a);
  begin perform public.finalize_datafy_channel_subscription(c,u,a,r.claim_id,o,g,'remote63',0,'local63');
   raise exception 'other-provider finalizer accepted'; exception when check_violation then null; end;
  perform public.release_datafy_onboarding_step(o,u,r.claim_id,'subscribe','failed');
  if exists(select from public.whatsapp_official_connection_grants where id=g and consumed_at is not null) then raise exception 'refusal consumed grant'; end if;
  if (select is_active from public.whatsapp_channels where id='dddddddd-0063-0000-0000-000000000003') is distinct from active then raise exception 'selected provider lost'; end if;
 end loop;
 -- Remover a autoridade comprova o cenário da revisão; subtransação restaura.
 begin
  execute 'create or replace function public.assert_datafy_first_configuration(p_unit_id uuid) returns void language plpgsql security definer set search_path='''' as $x$ begin return; end $x$';
  perform public.activate_whatsapp_channel(u,c,a,'local63');
  if not (select is_active from public.whatsapp_channels where id=c) then raise exception 'positive control inert'; end if;
  raise exception 'rollback positive' using errcode='ZZ063';
 exception when sqlstate 'ZZ063' then null; end;
 -- Mesmo provider permanece permitido, inclusive ativo explícito desconectado.
 update public.whatsapp_channels set provider='datafy',status='disconnected' where id='dddddddd-0063-0000-0000-000000000003';
 perform public.activate_whatsapp_channel(u,c,a,'local63');
 raise notice '63: WBR001/003 OK (explicit/legacy, intent/echo/finalizer, provenance/manual compatibility, positive controls)';
end $$;

do $$ declare r record; old_claim uuid; a uuid:='eeeeeeee-0063-0000-0000-000000000001';
 u uuid:='bbbbbbbb-0063-0000-0000-000000000001'; c uuid:='dddddddd-0063-0000-0000-000000000001';
 o uuid:='cccccccc-0063-0000-0000-000000000001'; g uuid:='ffffffff-0063-0000-0000-000000000001';
begin
 -- WBR002: SQL freshness/ator/pin/grant/TTL e takeover de ambas as fontes.
 select * into r from public.claim_datafy_onboarding_step(o,u,'subscribe',a);
 if not public.authorize_datafy_mutation(u,c,a,r.claim_id,o,'subscribe','remote63',0,g) then raise exception 'valid authorization refused'; end if;
 if public.authorize_datafy_mutation(u,c,gen_random_uuid(),r.claim_id,o,'subscribe','remote63',0,g)
  or public.authorize_datafy_mutation(u,c,a,r.claim_id,o,'subscribe','wrong',0,g)
  or public.authorize_datafy_mutation(u,c,a,r.claim_id,o,'subscribe','remote63',1,g)
  or public.authorize_datafy_mutation(u,c,a,r.claim_id,o,'pause','remote63',0,g) then raise exception 'forged authorization'; end if;
 update public.whatsapp_datafy_onboardings set claim_expires_at=now()+interval '24 seconds' where id=o;
 if public.authorize_datafy_mutation(u,c,a,r.claim_id,o,'subscribe','remote63',0,g) then raise exception 'insufficient budget accepted'; end if;
 update public.whatsapp_datafy_onboardings set claim_expires_at=now()-interval '1 second' where id=o;
 old_claim:=r.claim_id;
 select * into r from public.claim_datafy_channel_operation(c,u,a,'subscribe');
 if public.authorize_datafy_mutation(u,c,a,old_claim,o,'subscribe','remote63',0,g)
  or public.authorize_datafy_mutation(u,c,a,r.claim_id,o,'subscribe','remote63',0,g) then raise exception 'stale or uncertain lease accepted'; end if;
 -- WBR006: conclusão por ausência mantém terminal e libera posterior relink.
 update public.whatsapp_datafy_onboardings set state='abandoned',abandoned_at=now(),channel_token=null,webhook_secret=null where id=o;
 perform public.release_datafy_onboarding_step(o,u,r.claim_id,'subscribe','reconciled_absent','REMOTE_CHANNEL_MISSING');
 select * into r from public.claim_datafy_channel_operation(c,u,a,'relink');
 if not r.claimed or r.source<>'channel' then raise exception 'missing reconciliation stranded recovery'; end if;
 perform public.release_datafy_existing_subscription(c,u,r.claim_id,'failed');
 select * into r from public.claim_datafy_channel_operation(c,u,a,'subscribe');
 if not public.authorize_datafy_mutation(u,c,a,r.claim_id,null,'subscribe','remote63',0,g) then raise exception 'valid channel source refused'; end if;
 old_claim:=r.claim_id;
 update public.whatsapp_channels set datafy_subscription_claim_expires_at=now()-interval '1 second' where id=c;
 select * into r from public.claim_datafy_channel_operation(c,u,a,'subscribe');
 if public.authorize_datafy_mutation(u,c,a,old_claim,null,'subscribe','remote63',0,g) then raise exception 'channel takeover old owner accepted'; end if;
 perform public.release_datafy_existing_subscription(c,u,r.claim_id,'reconciled_absent');
 select * into r from public.claim_datafy_channel_operation(c,u,a,'subscribe');
 update public.whatsapp_official_connection_grants set revoked_at=now(),revoked_by=a where id=g;
 if public.authorize_datafy_mutation(u,c,a,r.claim_id,null,'subscribe','remote63',0,g) then raise exception 'revoked grant accepted'; end if;
 perform public.release_datafy_existing_subscription(c,u,r.claim_id,'failed');
 if (select state from public.whatsapp_datafy_onboardings where id=o)<>'abandoned' then raise exception 'history reopened'; end if;
 raise notice '63: WBR002/006 SQL OK (live fence, operation, actor, pin, remaining budget, uncertainty, grant, terminal recovery)';
end $$;

do $$ declare sig regprocedure; begin
 -- WBR005: canais same-org compartilham; template e canal colidem nas duas direções.
 insert into public.whatsapp_channels(unit_id,provider,credentials) values
  ('bbbbbbbb-0063-0000-0000-000000000003','datafy','{"business_account_id":"63001","phone_number_id":"6300003"}');
 begin insert into public.whatsapp_channels(unit_id,provider,credentials) values
  ('bbbbbbbb-0063-0000-0000-000000000002','datafy','{"business_account_id":"63001","phone_number_id":"6300002"}');
  raise exception 'cross-org channel accepted'; exception when sqlstate 'PT409' then null; end;
 begin insert into public.whatsapp_template_accounts(organization_id,waba_id) values('aaaaaaaa-0000-0000-0000-000000000002','63001');
  raise exception 'cross-org template accepted'; exception when sqlstate 'PT409' then null; end;
 insert into public.whatsapp_template_accounts(organization_id,waba_id) values('aaaaaaaa-0000-0000-0000-000000000002','63002');
 begin insert into public.whatsapp_channels(unit_id,provider,credentials) values
  ('bbbbbbbb-0063-0000-0000-000000000003','datafy','{"business_account_id":"63002"}');
  raise exception 'cross-org template owner bypass'; exception when sqlstate 'PT409' then null; end;
 -- Controle positivo: sem trigger canal aceita a contradição de owner.
 begin
  alter table public.whatsapp_channels disable trigger guard_whatsapp_channel_waba_owner;
  insert into public.whatsapp_channels(unit_id,provider,credentials) values
   ('bbbbbbbb-0063-0000-0000-000000000003','datafy','{"business_account_id":"63002"}');
  raise exception 'rollback positive' using errcode='ZZ063';
 exception when sqlstate 'ZZ063' then null; end;
 -- ACL efetiva de todas as novas autoridades; registry não é Data API.
 foreach sig in array array['public.authorize_datafy_mutation(uuid,uuid,uuid,uuid,uuid,text,text,bigint,uuid)'::regprocedure,
  'public.assert_datafy_first_configuration(uuid)'::regprocedure,'public.reserve_whatsapp_waba_owner(text,uuid)'::regprocedure,
  'public.guard_whatsapp_waba_owner()'::regprocedure,'public.guard_datafy_subscription_origin()'::regprocedure] loop
  if has_function_privilege('anon',sig,'execute') or has_function_privilege('authenticated',sig,'execute')
   or exists(select from pg_catalog.aclexplode((select proacl from pg_catalog.pg_proc where oid=sig)) where grantee=0) then raise exception 'public ACL open %',sig; end if;
 end loop;
 if not has_function_privilege('service_role','public.authorize_datafy_mutation(uuid,uuid,uuid,uuid,uuid,text,text,bigint,uuid)','execute')
  or has_table_privilege('anon','public.whatsapp_waba_owners','select') or has_table_privilege('authenticated','public.whatsapp_waba_owners','insert')
  or not (select relrowsecurity and relforcerowsecurity from pg_catalog.pg_class where oid='public.whatsapp_waba_owners'::regclass) then raise exception 'registry/authority ACL'; end if;
 raise notice '63: WBR005/ACL OK (same org, both collisions, positive control, no direct access)';
end $$;
rollback;
