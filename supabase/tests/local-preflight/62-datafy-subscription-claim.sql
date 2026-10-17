-- Sequência: 00 + 00a + 61a + migration onboarding + 62a + nova migration.
-- Tudo rollback. Banco descartável, sem provider, sem segredo real.
\set ON_ERROR_STOP on
begin;
-- Estes casos testam a primeira configuração Datafy. O seed global possui
-- Z-API nas unidades A1/B1 e Waha offline em B1 com is_active NULL.
-- Desativar os três impede que o fallback trate o Waha como migração.
update public.whatsapp_channels set is_active=false where id in
  ('dddddddd-0000-0000-0000-000000000001','dddddddd-0000-0000-0000-000000000002','dddddddd-0000-0000-0000-000000000003');
do $$ begin
  if to_regprocedure('public.claim_datafy_existing_subscription(uuid,uuid,uuid,integer)') is null then
    raise exception '62 exige migration datafy_existing_subscription_claim';
  end if;
end $$;
insert into auth.users(id) values ('eeeeeeee-0000-0000-0000-000000000001') on conflict do nothing;
insert into public.platform_admins(user_id) values ('eeeeeeee-0000-0000-0000-000000000001') on conflict do nothing;
insert into public.whatsapp_channels(id,unit_id,provider,status,external_instance_id) values
  ('dddddddd-0062-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000001','datafy','connected','synthetic-local-62'),
  ('dddddddd-0062-0000-0000-000000000002','bbbbbbbb-0000-0000-0000-000000000002','datafy','connected','synthetic-local-62b');
insert into public.whatsapp_datafy_onboardings(id,organization_id,unit_id,reserved_channel_id,datafy_channel_id,state) values
  ('cccccccc-0062-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000001','dddddddd-0062-0000-0000-000000000001','synthetic-local-62','connected'),
  ('cccccccc-0062-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000002','bbbbbbbb-0000-0000-0000-000000000002','dddddddd-0062-0000-0000-000000000002','synthetic-local-62b','completed');

-- Simula o último UPDATE de activate_whatsapp_channel com snapshot de eco
-- anterior ao cancel/pause. CHECK é a autoridade mesmo depois da releitura.
create or replace function pg_temp.require_datafy_operational_guard(p_channel uuid) returns void
language plpgsql as $$ begin
  begin
    update public.whatsapp_channels set is_active=true where id=p_channel;
    raise exception 'datafy_operational_guard_missing' using errcode='ZZ062';
  exception when check_violation then null; end;
end $$;

do $$
declare
  a uuid := 'eeeeeeee-0000-0000-0000-000000000001';
  u uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
  u2 uuid := 'bbbbbbbb-0000-0000-0000-000000000002';
  c uuid := 'dddddddd-0062-0000-0000-000000000001';
  c2 uuid := 'dddddddd-0062-0000-0000-000000000002';
  o uuid := 'cccccccc-0062-0000-0000-000000000001';
  o2 uuid := 'cccccccc-0062-0000-0000-000000000002';
  own record; other record; expired record; sig regprocedure; p record;
begin
  -- 1: identidade/tenant, recusa uniforme e sem metadata de outro claim.
  begin perform public.claim_datafy_existing_subscription(c,u,gen_random_uuid());
    raise exception 'ator falso foi aceito'; exception when insufficient_privilege then null; end;
  begin perform public.claim_datafy_existing_subscription(c,u2,a);
    raise exception 'tenant alheio foi aceito'; exception when insufficient_privilege then null; end;
  -- 2: admin e self-service compartilham onboarding; busy nunca ganha lease de canal.
  select * into own from public.claim_datafy_onboarding_step(o,u,'subscribe',a);
  select * into other from public.claim_datafy_existing_subscription(c,u,a);
  if other.claimed or other.claim_id is not null or other.source <> 'onboarding' then raise exception 'admin furou claim self-service'; end if;
  if exists(select from public.whatsapp_channels where id=c and datafy_subscription_claim_id is not null) then raise exception 'lease alternativo durante busy'; end if;
  perform public.release_datafy_onboarding_step(o,u,own.claim_id,'subscribe','succeeded');
  select * into own from public.claim_datafy_existing_subscription(c,u,a);
  if not own.claimed or own.source <> 'onboarding' or own.onboarding_id <> o then raise exception 'fonte do claim live incorreta'; end if;
  select * into other from public.claim_datafy_onboarding_step(o,u,'subscribe',a);
  if other.claimed then raise exception 'self-service furou claim admin'; end if;
  begin perform public.release_datafy_existing_subscription(c,u,own.claim_id,'succeeded');
    raise exception 'spoof de fonte liberou onboarding pelo canal'; exception when serialization_failure then null; end;
  perform public.release_datafy_onboarding_step(o,u,own.claim_id,'subscribe','succeeded');
  -- 3: canal fechado ganha lease separado; self-service continua recusado.
  begin perform public.claim_datafy_onboarding_step(o2,u2,'subscribe',a);
    raise exception 'onboarding fechado reaberto'; exception when check_violation then null; end;
  select * into own from public.claim_datafy_existing_subscription(c2,u2,a,1);
  if not own.claimed or own.source <> 'channel' or own.onboarding_id is not null then raise exception 'lease terminal incorreto'; end if;
  if (select datafy_subscription_claim_expires_at from public.whatsapp_channels where id=c2) <> now()+interval '30 seconds' then raise exception 'piso TTL incorreto'; end if;
  select * into other from public.claim_datafy_existing_subscription(c2,u2,a);
  if other.claimed or other.claim_id is not null then raise exception 'clique duplo recebeu cerca'; end if;
  -- 4: takeover registra incerteza e cerca dono antigo; failed conserva.
  update public.whatsapp_channels set datafy_subscription_claim_expires_at=now()-interval '1 second' where id=c2;
  select * into expired from public.claim_datafy_existing_subscription(c2,u2,a);
  if not expired.claimed or not expired.must_reconcile or expired.claim_id=own.claim_id then raise exception 'takeover sem reconciliacao'; end if;
  begin perform public.release_datafy_existing_subscription(c2,u2,own.claim_id,'succeeded');
    raise exception 'dono antigo liberou cerca'; exception when serialization_failure then null; end;
  begin perform public.release_datafy_existing_subscription(c2,u,expired.claim_id,'succeeded');
    raise exception 'release alheio aceito'; exception when insufficient_privilege then null; end;
  perform public.release_datafy_existing_subscription(c2,u2,expired.claim_id,'failed','DATAFY_RECONCILE_FAILED');
  select * into own from public.claim_datafy_existing_subscription(c2,u2,a);
  if not own.must_reconcile then raise exception 'failed apagou incerteza'; end if;
  perform public.release_datafy_existing_subscription(c2,u2,own.claim_id,'reconciled_absent');
  select * into own from public.claim_datafy_existing_subscription(c2,u2,a);
  if own.must_reconcile then raise exception 'absent nao resolveu incerteza'; end if;
  perform public.release_datafy_existing_subscription(c2,u2,own.claim_id,'succeeded');
  if exists(select from public.whatsapp_channels where id=c2 and (datafy_subscription_claim_id is not null
    or datafy_subscription_claim_expires_at is not null or datafy_subscription_claim_actor_id is not null)) then raise exception 'metadata de claim nao limpa'; end if;
  if (select state from public.whatsapp_datafy_onboardings where id=o2) <> 'completed' then raise exception 'historico terminal mudou'; end if;
  -- 5: ACL real sob default privileges da 61a.
  foreach sig in array array['public.claim_datafy_existing_subscription(uuid,uuid,uuid,integer)'::regprocedure,
    'public.release_datafy_existing_subscription(uuid,uuid,uuid,text,text)'::regprocedure,
    'public.claim_datafy_channel_operation(uuid,uuid,uuid,text,integer)'::regprocedure,
    'public.apply_datafy_channel_relink(uuid,uuid,uuid,uuid,text,bigint,text,text,text)'::regprocedure,
    'public.record_datafy_channel_state(uuid,uuid,uuid,uuid,uuid,text,bigint,boolean,boolean)'::regprocedure,
    'public.finalize_datafy_channel_subscription(uuid,uuid,uuid,uuid,uuid,uuid,text,bigint,text)'::regprocedure] loop
    if has_function_privilege('anon',sig,'execute') or has_function_privilege('authenticated',sig,'execute')
      or not has_function_privilege('service_role',sig,'execute') then raise exception 'ACL indevida %',sig; end if;
    select * into p from pg_catalog.pg_proc where oid=sig;
    if not p.prosecdef or p.proconfig is distinct from array['search_path=""'] then raise exception 'forma SECURITY DEFINER/search_path %',sig; end if;
    if exists(select from pg_catalog.aclexplode(p.proacl) where grantee=0 and privilege_type='EXECUTE') then raise exception 'PUBLIC execute %',sig; end if;
  end loop;
  -- 6: cancel/pause bloqueiam eco stale no próprio banco; legado desconhecido
  -- (metadados NULL) permanece permitido. Controle positivo remove a guarda
  -- em subtransação e prova a ativação indevida; rollback a restaura.
  update public.whatsapp_channels set is_active=false, manual_echo_verified_at=now(), provider_subscription_canceled_at=now(), provider_paused_at=null where id=c2;
  perform pg_temp.require_datafy_operational_guard(c2);
  update public.whatsapp_channels set provider_subscription_canceled_at=null, provider_paused_at=now() where id=c2;
  perform pg_temp.require_datafy_operational_guard(c2);
  begin
    alter table public.whatsapp_channels drop constraint whatsapp_channels_datafy_operational_subscription_chk;
    perform pg_temp.require_datafy_operational_guard(c2);
    raise exception 'controle positivo nao detectou guarda removida';
  exception when sqlstate 'ZZ062' then raise notice '62 CTRL: remoção de guarda permite reativação pausada; rollback restaurou CHECK'; end;
  perform pg_temp.require_datafy_operational_guard(c2);
  update public.whatsapp_channels set provider_subscription_canceled_at=null, provider_paused_at=null, provider_subscribed_at=null, is_active=true where id=c2;
  raise notice '62: 6 grupos OK (tenant/admin, cerca compartilhada, terminal, takeover/release, ACL, cancel/pause+controle positivo)';
end $$;

-- Falha injetada depois de consumo/request: a transação do finisher deve
-- restaurar grant, intenção e onboarding. Autoridade de ativação é verbatim 62a.
create function pg_temp.fail_task7_activation() returns trigger language plpgsql as $$ begin
  if current_setting('task7.fail_activation',true)='yes' and new.is_active is true then
    raise exception 'injected_activation_failure' using errcode='ZZ064';
  end if;
  return new;
end $$;
create trigger task7_fail_activation before update on public.whatsapp_channels
  for each row execute function pg_temp.fail_task7_activation();

do $$ declare
  a uuid:='eeeeeeee-0000-0000-0000-000000000001';
  u uuid:='bbbbbbbb-0000-0000-0000-000000000001'; u2 uuid:='bbbbbbbb-0000-0000-0000-000000000002';
  c uuid:='dddddddd-0062-0000-0000-000000000001'; c2 uuid:='dddddddd-0062-0000-0000-000000000002';
  o uuid:='cccccccc-0062-0000-0000-000000000001';
  g uuid:='ffffffff-0062-0000-0000-000000000001'; gnew uuid:='ffffffff-0062-0000-0000-000000000002';
  g2 uuid:='ffffffff-0062-0000-0000-000000000003'; own record; other record; old_fence uuid;
  old_revision bigint; changed bigint; outcome text; rowcount bigint;
begin
  insert into public.whatsapp_official_connection_grants(id,organization_id,unit_id,granted_by,revoked_at,revoked_by) values
    (g,'aaaaaaaa-0000-0000-0000-000000000001',u,a,now(),a);
  insert into public.whatsapp_official_connection_grants(id,organization_id,unit_id,granted_by) values
    (gnew,'aaaaaaaa-0000-0000-0000-000000000001',u,a), (g2,'aaaaaaaa-0000-0000-0000-000000000002',u2,a);
  update public.whatsapp_datafy_onboardings set grant_id=g where id=o;
  -- 7: abandono não libera uma assinatura em voo; takeover no MESMO histórico.
  select * into own from public.claim_datafy_onboarding_step(o,u,'subscribe',a);
  old_fence:=own.claim_id;
  update public.whatsapp_datafy_onboardings set state='abandoned',abandoned_at=now(),channel_token=null,webhook_secret=null where id=o;
  select * into other from public.claim_datafy_channel_operation(c,u,a,'subscribe');
  if other.claimed or other.source<>'onboarding' then raise exception 'terminal gerou lease alternativo'; end if;
  update public.whatsapp_datafy_onboardings set claim_expires_at=now()-interval '1 second' where id=o;
  select * into own from public.claim_datafy_channel_operation(c,u,a,'subscribe');
  if not own.claimed or not own.must_reconcile or own.source<>'onboarding' or own.onboarding_id<>o then raise exception 'terminal perdeu cerca/incerteza'; end if;
  begin perform public.release_datafy_onboarding_step(o,u,old_fence,'subscribe','succeeded');
    raise exception 'old owner released terminal'; exception when serialization_failure then null; end;
  -- TTL expirado sem takeover + revogação não descartam fato remoto do dono.
  update public.whatsapp_datafy_onboardings set claim_expires_at=now()-interval '1 second' where id=o;
  perform public.record_datafy_channel_state(c,u,a,own.claim_id,o,'synthetic-local-62',0,true,false);
  outcome:=public.finalize_datafy_channel_subscription(c,u,a,own.claim_id,o,g,'synthetic-local-62',0,'local62');
  if outcome<>'grant_revoked' or (select activation_requested_at from public.whatsapp_channels where id=c) is not null then raise exception 'revogado ativou/consumiu'; end if;
  outcome:=public.finalize_datafy_channel_subscription(c,u,a,own.claim_id,o,gnew,'synthetic-local-62',0,'local62');
  if outcome<>'finalized' or (select consumed_channel_id from public.whatsapp_official_connection_grants where id=gnew)<>c
    or (select grant_id from public.whatsapp_datafy_onboardings where id=o)<>g
    or (select state from public.whatsapp_datafy_onboardings where id=o)<>'abandoned' then raise exception 'finalização reabriu/regravou histórico'; end if;
  perform public.release_datafy_onboarding_step(o,u,own.claim_id,'subscribe','reconciled_present');
  -- 8: projeção velha do onboarding não remove cancel/pause na mesma geração.
  old_fence:=own.claim_id;
  select * into other from public.claim_datafy_channel_operation(c,u,a,'cancel');
  perform public.record_datafy_channel_state(c,u,a,other.claim_id,null,'synthetic-local-62',0,false,true);
  perform public.release_datafy_existing_subscription(c,u,other.claim_id,'succeeded');
  begin perform public.record_datafy_channel_state(c,u,a,old_fence,o,'synthetic-local-62',0,true,false);
    raise exception 'stale onboarding projection accepted'; exception when serialization_failure then null; end;
  if exists(select from public.whatsapp_channels where id=c and (provider_subscription_canceled_at is null or provider_paused_at is null or is_active or activation_requested_at is not null)) then raise exception 'stale apagou proteção'; end if;
  -- 9: lease/uncertainty congelam identidade; ação nova reconcilia a ANTERIOR.
  select * into own from public.claim_datafy_channel_operation(c2,u2,a,'cancel');
  -- Metadata legada NULL não pode transformar SQL UNKNOWN em permissão.
  update public.whatsapp_channels set datafy_subscription_operation=null where id=c2;
  begin update public.whatsapp_channels set external_instance_id='unsafe-b',datafy_subscription_claim_id=null,
    datafy_subscription_claim_expires_at=null,datafy_subscription_claim_actor_id=null where id=c2;
    raise exception 'identity guard missing' using errcode='ZZ063'; exception when check_violation then null; end;
  update public.whatsapp_channels set datafy_subscription_operation='cancel' where id=c2;
  begin
    alter table public.whatsapp_channels disable trigger guard_datafy_channel_identity;
    update public.whatsapp_channels set external_instance_id='unsafe-b' where id=c2;
    raise exception 'unsafe mutation permitted' using errcode='ZZ063';
  exception when sqlstate 'ZZ063' then raise notice '62 CTRL: retirar trigger permite troca durante lease; rollback restaura'; end;
  update public.whatsapp_channels set datafy_subscription_claim_expires_at=now()-interval '1 second' where id=c2;
  select * into other from public.claim_datafy_channel_operation(c2,u2,a,'pause');
  if not other.must_reconcile or other.reconcile_operation<>'cancel' then raise exception 'takeover mudou operação incerta'; end if;
  perform public.release_datafy_existing_subscription(c2,u2,other.claim_id,'failed');
  select * into own from public.claim_datafy_channel_operation(c2,u2,a,'relink');
  if not own.must_reconcile or own.reconcile_operation<>'cancel' then raise exception 'failed apagou operação incerta'; end if;
  begin perform public.apply_datafy_channel_relink(c2,u2,a,own.claim_id,'synthetic-local-62b',0,'remote-b','synthetic-channel-token','synthetic-secret');
    raise exception 'relink contornou uncertainty'; exception when serialization_failure then null; end;
  perform public.release_datafy_existing_subscription(c2,u2,own.claim_id,'reconciled_absent');
  -- 10: relink troca pin/geração e limpa prova+lease na MESMA transação.
  select * into own from public.claim_datafy_channel_operation(c2,u2,a,'relink'); old_revision:=own.template_credential_revision;
  begin perform public.apply_datafy_channel_relink(c2,u2,a,own.claim_id,'wrong-a',old_revision,'remote-b','synthetic-channel-token','synthetic-secret');
    raise exception 'relink pin inválido aceito'; exception when serialization_failure then null; end;
  select template_credential_revision into changed from public.apply_datafy_channel_relink(c2,u2,a,own.claim_id,'synthetic-local-62b',old_revision,'remote-b','synthetic-channel-token','synthetic-secret');
  if changed<>old_revision+1 or exists(select from public.whatsapp_channels where id=c2 and (manual_echo_verified_at is not null or activation_requested_at is not null or datafy_subscription_claim_id is not null or is_active)) then raise exception 'relink não invalidou prova/lease'; end if;
  update public.whatsapp_channels set manual_echo_verified_at=now() where id=c2 and template_credential_revision=old_revision and external_instance_id='synthetic-local-62b';
  get diagnostics rowcount=row_count;
  if rowcount<>0 then raise exception 'old callback restored proof'; end if;
  -- 11: recorder checa ator/fonte/pin; finisher zero/erro revoga toda a decisão.
  select * into own from public.claim_datafy_channel_operation(c2,u2,a,'subscribe');
  begin perform public.record_datafy_channel_state(c2,u2,gen_random_uuid(),own.claim_id,null,'remote-b',changed,true,false);
    raise exception 'actor spoof projection'; exception when serialization_failure then null; end;
  begin perform public.record_datafy_channel_state(c2,u2,a,own.claim_id,o,'remote-b',changed,true,false);
    raise exception 'source spoof projection'; exception when serialization_failure then null; end;
  outcome:=public.finalize_datafy_channel_subscription(c2,u2,a,own.claim_id,null,g2,'remote-b',changed,'local62');
  if outcome<>'subscription_not_confirmed' or (select consumed_at from public.whatsapp_official_connection_grants where id=g2) is not null then raise exception 'zero outcome consumed'; end if;
  begin perform public.record_datafy_channel_state(c2,u2,a,own.claim_id,null,'synthetic-local-62b',old_revision,true,false);
    raise exception 'old remote projection accepted'; exception when serialization_failure then null; end;
  perform public.record_datafy_channel_state(c2,u2,a,own.claim_id,null,'remote-b',changed,true,false);
  begin perform public.finalize_datafy_channel_subscription(c2,u2,a,own.claim_id,null,g2,'synthetic-local-62b',old_revision,'local62');
    raise exception 'old remote finalize accepted'; exception when serialization_failure then null; end;
  update public.whatsapp_channels set manual_echo_verified_at=now(),manual_echo_verification_source='provider_callback' where id=c2 and template_credential_revision=changed and external_instance_id='remote-b';
  perform set_config('task7.fail_activation','yes',true);
  begin perform public.finalize_datafy_channel_subscription(c2,u2,a,own.claim_id,null,g2,'remote-b',changed,'local62');
    raise exception 'injected failure did not run'; exception when sqlstate 'ZZ064' then null; end;
  perform set_config('task7.fail_activation','no',true);
  if (select consumed_at from public.whatsapp_official_connection_grants where id=g2) is not null
    or exists(select from public.whatsapp_channels where id=c2 and (activation_requested_at is not null or is_active)) then raise exception 'finisher partial commit'; end if;
  -- 12: controle elegível realmente ativa com funções/trigger de produção.
  outcome:=public.finalize_datafy_channel_subscription(c2,u2,a,own.claim_id,null,g2,'remote-b',changed,'local62');
  if outcome<>'finalized' or not(select is_active from public.whatsapp_channels where id=c2)
    or (select consumed_channel_id from public.whatsapp_official_connection_grants where id=g2)<>c2 then raise exception 'positive activation failed'; end if;
  perform public.release_datafy_existing_subscription(c2,u2,own.claim_id,'succeeded');
  if has_function_privilege('service_role','public.guard_datafy_channel_identity()','execute') then raise exception 'trigger exposed to service'; end if;
  raise notice '62: 12 grupos OK (+ terminal em voo, recorder stale, operation/relink, geração/echo, finisher rollback/zero, ativação real positiva)';
end $$;
-- Round2: primeiro vínculo legado e crash antes do writer SQL transacional.
do $$ declare
  a uuid:='eeeeeeee-0000-0000-0000-000000000001';
  u uuid:='bbbbbbbb-0000-0000-0000-000000000003';
  c uuid:='dddddddd-0062-0000-0000-000000000003';
  own record; takeover record; committed record; changed bigint; op text;
begin
  insert into public.whatsapp_channels(id,unit_id,provider,status,external_instance_id,credentials)
    values(c,u,'datafy','connected',null,'{"phone_number_id":"synthetic-legacy-phone"}');
  -- 13: pin NULL é bootstrap EXCLUSIVO do relink, não autoriza I/O remoto.
  foreach op in array array['subscribe','cancel','pause','resume','configure_webhook'] loop
    begin perform public.claim_datafy_channel_operation(c,u,a,op);
      raise exception 'remote operation accepted NULL identity: %',op;
    exception when insufficient_privilege then null; end;
  end loop;
  select * into own from public.claim_datafy_channel_operation(c,u,a,'relink');
  if not own.claimed or own.external_instance_id is not null or own.template_credential_revision<>0 then raise exception 'legacy NULL pin refused'; end if;
  begin perform public.apply_datafy_channel_relink(c,u,a,own.claim_id,'forged-old-pin',0,'synthetic-linked-62','synthetic-channel-token','synthetic-secret');
    raise exception 'NULL old pin not fenced'; exception when serialization_failure then null; end;
  -- 14: lease remanescente prova que relink não commitou. Takeover cercado
  -- libera reconciled_absent e toma NOVA fence antes de aplicar credenciais.
  update public.whatsapp_channels set datafy_subscription_claim_expires_at=now()-interval '1 second' where id=c;
  select * into takeover from public.claim_datafy_channel_operation(c,u,a,'relink');
  if not takeover.claimed or not takeover.must_reconcile or takeover.reconcile_operation<>'relink'
    or takeover.external_instance_id is not null or takeover.claim_id=own.claim_id then raise exception 'expired relink not recoverable'; end if;
  begin perform public.apply_datafy_channel_relink(c,u,a,own.claim_id,null,0,'synthetic-linked-62','synthetic-channel-token','synthetic-secret');
    raise exception 'old relink owner accepted'; exception when serialization_failure then null; end;
  begin perform public.apply_datafy_channel_relink(c,u,a,takeover.claim_id,null,0,'synthetic-linked-62','synthetic-channel-token','synthetic-secret');
    raise exception 'takeover applied without reconciliation'; exception when serialization_failure then null; end;
  perform public.release_datafy_existing_subscription(c,u,takeover.claim_id,'reconciled_absent');
  select * into own from public.claim_datafy_channel_operation(c,u,a,'relink');
  if own.must_reconcile or own.external_instance_id is not null then raise exception 'reconciled relink still blocked'; end if;
  select template_credential_revision into changed from public.apply_datafy_channel_relink(c,u,a,own.claim_id,null,0,'synthetic-linked-62','synthetic-channel-token','synthetic-secret');
  if changed<>1 or exists(select from public.whatsapp_channels where id=c and (datafy_subscription_claim_id is not null
    or datafy_subscription_uncertain or external_instance_id<>'synthetic-linked-62')) then raise exception 'legacy relink commit not atomic'; end if;
  -- Contraste: writer commitado encerrou lease; próximo claim observa pin novo,
  -- sem uncertainty=relink nem reconciliação do remoto anterior.
  select * into committed from public.claim_datafy_channel_operation(c,u,a,'configure_webhook');
  if committed.must_reconcile or committed.external_instance_id<>'synthetic-linked-62'
    or committed.template_credential_revision<>1 then raise exception 'committed relink falsely uncertain'; end if;
  perform public.release_datafy_existing_subscription(c,u,committed.claim_id,'succeeded');
  raise notice '62: 14 grupos OK (+ legacy NULL bootstrap exclusivo relink, crash/expiry e contraste commitado)';
end $$;
set local role service_role;
select claimed, source, must_reconcile from public.claim_datafy_existing_subscription(
  'dddddddd-0062-0000-0000-000000000002','bbbbbbbb-0000-0000-0000-000000000002','eeeeeeee-0000-0000-0000-000000000001');
reset role;
rollback;
