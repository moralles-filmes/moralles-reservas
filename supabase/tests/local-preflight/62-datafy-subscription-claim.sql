-- Sequência: 00 + 00a + 61a + migration onboarding + 62a + nova migration.
-- Tudo rollback. Banco descartável, sem provider, sem segredo real.
\set ON_ERROR_STOP on
begin;
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
    'public.release_datafy_existing_subscription(uuid,uuid,uuid,text,text)'::regprocedure] loop
    if has_function_privilege('anon',sig,'execute') or has_function_privilege('authenticated',sig,'execute')
      or not has_function_privilege('service_role',sig,'execute') then raise exception 'ACL indevida %',sig; end if;
    select * into p from pg_catalog.pg_proc where oid=sig;
    if not p.prosecdef or p.proconfig is distinct from array['search_path=""'] then raise exception 'forma SECURITY DEFINER/search_path %',sig; end if;
    if exists(select from pg_catalog.aclexplode(p.proacl) where grantee=0 and privilege_type='EXECUTE') then raise exception 'PUBLIC execute %',sig; end if;
  end loop;
  -- 6: cancel/pause bloqueiam eco stale no próprio banco; legado desconhecido
  -- (metadados NULL) permanece permitido. Controle positivo remove a guarda
  -- em subtransação e prova a ativação indevida; rollback a restaura.
  update public.whatsapp_channels set is_active=false, provider_subscription_canceled_at=now(), provider_paused_at=null where id=c2;
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
set local role service_role;
select claimed, source, must_reconcile from public.claim_datafy_existing_subscription(
  'dddddddd-0062-0000-0000-000000000002','bbbbbbbb-0000-0000-0000-000000000002','eeeeeeee-0000-0000-0000-000000000001');
reset role;
rollback;
