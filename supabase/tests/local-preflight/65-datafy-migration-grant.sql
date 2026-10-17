-- Migração de loja em produção para o oficial: migration
-- 20261016182000_datafy_migration_grant.sql (liberação de migração presa ao
-- binding, autoridade SQL única e ativação retida). Somente banco descartável.
--
-- SEQUÊNCIA (mesmo banco do 62/63; seção "Datafy — migração de loja em
-- produção (65)" no README):
--   00 -> 00a -> 61a -> 20261014120000 -> 62a -> 63a -> 20261014170540
--   -> 65a -> 65 (esperado: ERROR pela guarda, o RED)
--   -> 20261016182000 -> 65 (M10 PENDENTE, M1..M9/M11..M18, CTRL-a..g)
--   -> 20261016182000 x2 -> 65 (M10 OK, M1..M9/M11..M18, CTRL-a..g)
--
-- O QUE ESTE ARQUIVO PROVA:
--   M1  liberação inserida com `replaces_channel_id` forjado (aleatório, NULL,
--       id de canal de outra unidade), inclusive pelo `service_role`, ganha o
--       id do binding de outro provider; legado NULL+connected é binding;
--   M2  sem canal, binding datafy, só canal `is_active=false`, ou datafy ativo
--       à frente de legado uazapi → NULL (mesma ordem de binding da autoridade);
--   M3  UPDATE que muda `replaces_channel_id` (para outro id ou NULL) é
--       recusado; UPDATE que não muda e revogação passam e preservam o pin;
--   M4  `assert_datafy_first_configuration` passa com liberação presa ao
--       binding (ativa ou consumida pelo canal datafy) e recusa sem liberação,
--       revogada, com binding trocado e consumida por canal não-datafy;
--   M5  `authorize_datafy_mutation` autoriza o subscribe com liberação de
--       migração e `finalize_datafy_channel_subscription` devolve `finalized`,
--       consome, conclui o onboarding, sem intenção, sem evento e sem ativar,
--       mesmo com eco e `connected`; a UazAPI segue ativa;
--   M6  corte: intenção + ativação trocam atomicamente (UazAPI false, datafy
--       true, um único ativo, evento `activated` com o anterior);
--   M7  reversão: intenção + ativação na linha UazAPI voltam a UazAPI; a
--       liberação continua autorizando novo corte; com a autoridade Datafy
--       sabotada para recusar tudo a reversão passa igual (não a consulta);
--   M8  liberação comum (criada sem binding → pin NULL) com binding UazAPI
--       posterior: autoridade, autorização e finalizador recusam, sem consumir;
--   M9  forma e ACL: coluna uuid nula sem FK, trigger depois do guard, as três
--       funções SECURITY DEFINER com `search_path` vazio, trigger function sem
--       EXECUTE para PUBLIC/anon/authenticated/service_role e ACL das duas
--       substituídas idêntica à de ANTES da migration (snapshot do 65a);
--   M10 idempotência ATRAVÉS de execuções da migration (assinatura de catálogo
--       gravada na 1a passada, comparada na 2a);
--   M11 vínculo administrativo (`configure_webhook`, `p_grant_id` nulo) em
--       canal datafy que consumiu a liberação de migração, UazAPI ativa:
--       `finalized`, sem intenção nem ativação, UazAPI segue ativa;
--   M12 o mesmo vínculo administrativo sem liberação de migração recusa com
--       `datafy_migration_not_supported`, sem efeito;
--   M13 liberação de migração com o binding removido antes do finalizador:
--       consome sem intenção nem ativação;
--   M14 legado UazAPI `is_active` NULL fora do ar (sem binding) é preso pela
--       liberação; o finalizador com ela retém a ativação mesmo com eco;
--   M15 o legado reconecta: a autoridade casa com o pin e o corte troca;
--   M16 unidade só com canal `false` de outro provider → pin NULL.
--   M17 vínculo administrativo com legado NULL offline não pede intenção/ativa;
--   M18 autoridade, pedido e callback protegem legado NULL offline com grant
--       ausente, pendente, consumido, revogado após intenção e status error.
--
-- CONTROLES POSITIVOS (subtransação revertida; cada um confere que a sabotagem
-- mudou o corpo, mede o defeito com o MESMO cenário do caso e confere o
-- restore contra o catálogo — corpo e ACL):
--   (a) trigger sem `-- <pin>`                          -> M1 aceita o forjado
--   (b) bloco `-- <ativacao-retida>` trocado pelo da
--       20261014170540 (ativação incondicional)         -> M5 e M11 ativam
--   (c) autoridade ignorando `revoked_at`               -> M4 revogada passa
--   (d) só a checagem de binding, sem a condição da
--       liberação de migração                           -> M5 retido, M13 ativa
--   (e) trigger sem `-- <fallback-legado>`              -> M14 pin NULL e recusa
--   (f) autoridade sem `-- <authority-offline-fallback>` -> M18 sem grant passa
--   (g) finalizador sem `-- <finalizer-offline-fallback>` -> M17 ativa sozinho
--
-- O QUE ELE NÃO PROVA: RLS e exposição PostgREST (aqui o `postgres` é
-- superusuário; Supabase real fica com o `audit-function-acl.ts`), o
-- `rolbypassrls` do `postgres` de produção, corrida com DUAS sessões (os
-- locks são os mesmos das autoridades já medidas no 63b), nem o caminho
-- TypeScript de `manage-channels`.
\set ON_ERROR_STOP on

-- ─── GUARDA: só faz sentido DEPOIS da migration e do 65a ───────────────────
-- Rodado antes, M4/M8 (recusas) passariam POR ACIDENTE: sem a coluna, a
-- autoridade antiga recusa toda migração e todo caso negativo fica verde.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_attribute
                  where attrelid = to_regclass('public.whatsapp_official_connection_grants')
                    and attname = 'replaces_channel_id' and not attisdropped)
     or to_regprocedure('public.whatsapp_official_connection_grants_migration_pin()') is null then
    raise exception '65 exige a migration 20261016182000 aplicada (coluna replaces_channel_id ou trigger de pin ausente).';
  end if;
  if to_regclass('public.t_snap065') is null then
    raise exception '65 exige o 65a-datafy-migration-bootstrap.sql aplicado ANTES da migration (t_snap065 ausente).';
  end if;
end $$;
do $$
begin
  if (select count(*) from t_snap065 where k like 'acl_antes:%') <> 2 then
    raise exception '65 exige o 65a-datafy-migration-bootstrap.sql aplicado ANTES da migration (snapshot de ACL ausente).';
  end if;
end $$;

-- ─── M10: idempotência ATRAVÉS DE EXECUÇÕES (fora do rollback) ─────────────
-- A 1a execução grava a assinatura; o README manda reaplicar a migration duas
-- vezes e rodar de novo. Fica ANTES dos controles da mesma passada e DEPOIS
-- dos da passada anterior: restore incompleto de um controle aparece aqui.
do $$
declare v_sig text; v_saved text;
begin
  select string_agg(x, E'\n' order by x) into v_sig from (
    select 'col:' || a.attname || ':' || pg_catalog.format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull
           || ':' || coalesce(pg_catalog.pg_get_expr(d.adbin, d.adrelid), '')
           || ':' || coalesce(pg_catalog.col_description(a.attrelid, a.attnum), '')
      from pg_catalog.pg_attribute a
      left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
     where a.attrelid = 'public.whatsapp_official_connection_grants'::regclass and a.attnum > 0 and not a.attisdropped
    union all
    select 'con:' || conname || ':' || pg_catalog.pg_get_constraintdef(oid)
      from pg_catalog.pg_constraint where conrelid = 'public.whatsapp_official_connection_grants'::regclass
    union all
    select 'trg:' || tgname || ':' || pg_catalog.pg_get_triggerdef(oid)
      from pg_catalog.pg_trigger where not tgisinternal and tgrelid = 'public.whatsapp_official_connection_grants'::regclass
    union all
    select 'fn:' || p.oid::regprocedure::text || ':' || md5(pg_catalog.pg_get_functiondef(p.oid)) || ':' || coalesce(p.proacl::text, 'null')
      from pg_catalog.pg_proc p
     where p.oid in ('public.whatsapp_official_connection_grants_migration_pin()'::regprocedure,
                     'public.assert_datafy_first_configuration(uuid)'::regprocedure,
                     'public.finalize_datafy_channel_subscription(uuid,uuid,uuid,uuid,uuid,uuid,text,bigint,text)'::regprocedure)
  ) s(x);
  select v into v_saved from t_snap065 where k = 'assinatura';
  if v_saved is null then
    insert into t_snap065 values ('assinatura', v_sig);
    raise notice '65 M10 PENDENTE: assinatura gravada; reaplique a migration duas vezes e rode este arquivo de novo';
  elsif v_saved = v_sig then
    raise notice '65 M10 OK: catalogo identico entre execucoes da migration';
  else
    raise exception '65 M10 FALHOU: catalogo mudou entre execucoes da migration (ou um controle nao restaurou)';
  end if;
end $$;

begin;

-- ─── Fixtures (prefixo -0065-; tudo some no rollback) ───────────────────────
-- U  unidade em migração: UazAPI ativa explícita com prova de eco.
-- UC unidade de controle (outra organização): UazAPI ativa, sem liberação.
-- U0 sem canal; UD binding datafy legado; UF só UazAPI `false`;
-- UL UazAPI legado NULL+connected; UO UazAPI legado mais antigo + datafy ativo.
insert into auth.users(id) values ('eeeeeeee-0065-0000-0000-000000000001');
insert into public.platform_admins(user_id) values ('eeeeeeee-0065-0000-0000-000000000001');
insert into public.units(id, organization_id, name) values
  ('bbbbbbbb-0065-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'local65-migracao'),
  ('bbbbbbbb-0065-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000002', 'local65-controle'),
  ('bbbbbbbb-0065-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001', 'local65-sem-canal'),
  ('bbbbbbbb-0065-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000001', 'local65-datafy'),
  ('bbbbbbbb-0065-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-000000000001', 'local65-false'),
  ('bbbbbbbb-0065-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-000000000001', 'local65-legado'),
  ('bbbbbbbb-0065-0000-0000-000000000007', 'aaaaaaaa-0000-0000-0000-000000000001', 'local65-ordem'),
  ('bbbbbbbb-0065-0000-0000-000000000008', 'aaaaaaaa-0000-0000-0000-000000000001', 'local65-legado-caido'),
  ('bbbbbbbb-0065-0000-0000-000000000009', 'aaaaaaaa-0000-0000-0000-000000000001', 'local65-false-caido');
-- UL2 (…0008): UazAPI legado NULL fora do ar (QR vencido) — não é binding agora.
-- UF2 (…0009): só UazAPI `false` desconectada — nunca conta.
insert into public.whatsapp_channels(id, unit_id, provider, status, is_active, credentials, created_at) values
  ('dddddddd-0065-0000-0000-000000000013', 'bbbbbbbb-0065-0000-0000-000000000008', 'uazapi', 'disconnected', null,  '{}', now() - interval '30 days'),
  ('dddddddd-0065-0000-0000-000000000015', 'bbbbbbbb-0065-0000-0000-000000000009', 'uazapi', 'disconnected', false, '{}', now());
insert into public.whatsapp_channels(id, unit_id, provider, status, is_active, manual_echo_verified_at, credentials, created_at) values
  ('dddddddd-0065-0000-0000-000000000001', 'bbbbbbbb-0065-0000-0000-000000000001', 'uazapi', 'connected', true,  now(), '{}', now() - interval '30 days'),
  ('dddddddd-0065-0000-0000-000000000002', 'bbbbbbbb-0065-0000-0000-000000000002', 'uazapi', 'connected', true,  now(), '{}', now() - interval '30 days'),
  ('dddddddd-0065-0000-0000-000000000004', 'bbbbbbbb-0065-0000-0000-000000000004', 'datafy', 'connected', null,  null,  '{"phone_number_id":"6500004"}', now()),
  ('dddddddd-0065-0000-0000-000000000005', 'bbbbbbbb-0065-0000-0000-000000000005', 'uazapi', 'connected', false, now(), '{}', now()),
  ('dddddddd-0065-0000-0000-000000000006', 'bbbbbbbb-0065-0000-0000-000000000006', 'uazapi', 'connected', null,  null,  '{}', now()),
  ('dddddddd-0065-0000-0000-000000000007', 'bbbbbbbb-0065-0000-0000-000000000007', 'uazapi', 'connected', null,  null,  '{}', now() - interval '30 days'),
  ('dddddddd-0065-0000-0000-000000000008', 'bbbbbbbb-0065-0000-0000-000000000007', 'datafy', 'connected', true,  now(), '{"phone_number_id":"6500008"}', now());

-- Liberação pelo writer real (INSERT simples), com pin forjado pelo chamador.
create function pg_temp.f_grant(p_unit uuid, p_forged uuid default null) returns uuid language plpgsql as $$
declare v_id uuid;
begin
  insert into public.whatsapp_official_connection_grants(organization_id, unit_id, granted_by, replaces_channel_id)
  select u.organization_id, u.id, 'eeeeeeee-0065-0000-0000-000000000001', p_forged from public.units u where u.id = p_unit
  returning id into v_id;
  return v_id;
end $$;

-- M1/M2 e controle (a): o pin GRAVADO (relido da tabela), numa subtransação
-- desfeita — variável de plpgsql sobrevive ao rollback.
create function pg_temp.pin_of(p_unit uuid, p_forged uuid) returns uuid language plpgsql as $$
declare v_id uuid; v_pin uuid;
begin
  begin
    v_id := pg_temp.f_grant(p_unit, p_forged);
    select g.replaces_channel_id into v_pin from public.whatsapp_official_connection_grants g where g.id = v_id;
    raise exception 'rollback' using errcode = 'ZZ065';
  exception when sqlstate 'ZZ065' then null;
  end;
  return v_pin;
end $$;

create function pg_temp.assert_outcome(p_unit uuid) returns text language plpgsql as $$
begin
  perform public.assert_datafy_first_configuration(p_unit);
  return 'passed';
exception when others then
  return sqlstate || ':' || sqlerrm;
end $$;

create function pg_temp.cutover_outcome(p_unit uuid, p_channel uuid, p_action text) returns text language plpgsql as $$
begin
  if p_action='intent' then
    perform public.request_whatsapp_channel_activation(p_unit,p_channel,'eeeeeeee-0065-0000-0000-000000000001','local65');
  elsif p_action='activate' then
    perform public.activate_whatsapp_channel(p_unit,p_channel,'eeeeeeee-0065-0000-0000-000000000001','local65');
  else
    raise exception '65: cutover_outcome acao invalida';
  end if;
  return 'passed';
exception when others then return sqlstate || ':' || sqlerrm;
end $$;

-- Canal oficial alvo da unidade U, como o fluxo real cria: onboarding
-- (com a liberação) antes do canal, que nasce com `id = reserved_channel_id`,
-- inativo, já assinado e conectado.
create function pg_temp.f_target(p_grant uuid, p_echo boolean) returns void language plpgsql as $$
begin
  insert into public.whatsapp_datafy_onboardings(id, organization_id, unit_id, grant_id, reserved_channel_id, datafy_channel_id, state)
  values ('cccccccc-0065-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0065-0000-0000-000000000001',
          p_grant, 'dddddddd-0065-0000-0000-000000000003', 'remote65', 'connected');
  insert into public.whatsapp_channels(id, unit_id, provider, status, external_instance_id, is_active, provider_subscribed_at,
                                       manual_echo_verified_at, credentials)
  values ('dddddddd-0065-0000-0000-000000000003', 'bbbbbbbb-0065-0000-0000-000000000001', 'datafy', 'connected', 'remote65', false,
          now(), case when p_echo then now() end, '{"phone_number_id":"6500003"}');
end $$;

-- M4 revogada e controle (c): mesmo cenário.
create function pg_temp.m4_revoked() returns text language plpgsql as $$
declare v_g uuid;
begin
  v_g := pg_temp.f_grant('bbbbbbbb-0065-0000-0000-000000000001');
  update public.whatsapp_official_connection_grants
     set revoked_at = now(), revoked_by = 'eeeeeeee-0065-0000-0000-000000000001' where id = v_g;
  return pg_temp.assert_outcome('bbbbbbbb-0065-0000-0000-000000000001');
end $$;

-- M5, M6, M7 e controle (b): subscribe autorizado + finalizador com liberação
-- de migração, eco presente e canal conectado.
-- `p_drop_binding` (M13 e controle d): a UazAPI deixa de ser binding ENTRE a
-- autorização e o finalizador; a liberação de migração continua sem ativar.
create function pg_temp.m5(
  p_drop_binding boolean default false,
  out o_grant uuid, out o_pin uuid, out o_auth boolean, out o_outcome text, out o_consumed uuid,
  out o_onb_state text, out o_onb_creds boolean, out o_requested timestamptz, out o_cd_active boolean,
  out o_cu_active boolean, out o_events bigint
) language plpgsql as $$
declare r record;
begin
  o_grant := pg_temp.f_grant('bbbbbbbb-0065-0000-0000-000000000001', gen_random_uuid());
  perform pg_temp.f_target(o_grant, true);
  select * into r from public.claim_datafy_onboarding_step('cccccccc-0065-0000-0000-000000000001',
    'bbbbbbbb-0065-0000-0000-000000000001', 'subscribe', 'eeeeeeee-0065-0000-0000-000000000001');
  o_auth := public.authorize_datafy_mutation('bbbbbbbb-0065-0000-0000-000000000001', 'dddddddd-0065-0000-0000-000000000003',
    'eeeeeeee-0065-0000-0000-000000000001', r.claim_id, 'cccccccc-0065-0000-0000-000000000001', 'subscribe', 'remote65', 0, o_grant);
  if p_drop_binding then
    update public.whatsapp_channels set is_active = false where id = 'dddddddd-0065-0000-0000-000000000001';
  end if;
  o_outcome := public.finalize_datafy_channel_subscription('dddddddd-0065-0000-0000-000000000003', 'bbbbbbbb-0065-0000-0000-000000000001',
    'eeeeeeee-0065-0000-0000-000000000001', r.claim_id, 'cccccccc-0065-0000-0000-000000000001', o_grant, 'remote65', 0, 'local65');
  select g.replaces_channel_id, g.consumed_channel_id into o_pin, o_consumed
    from public.whatsapp_official_connection_grants g where g.id = o_grant;
  select o.state, (o.channel_token is not null or o.webhook_secret is not null) into o_onb_state, o_onb_creds
    from public.whatsapp_datafy_onboardings o where o.id = 'cccccccc-0065-0000-0000-000000000001';
  select c.activation_requested_at, c.is_active into o_requested, o_cd_active
    from public.whatsapp_channels c where c.id = 'dddddddd-0065-0000-0000-000000000003';
  select c.is_active into o_cu_active from public.whatsapp_channels c where c.id = 'dddddddd-0065-0000-0000-000000000001';
  select count(*) into o_events from public.whatsapp_channel_lifecycle_events e where e.channel_ref = 'dddddddd-0065-0000-0000-000000000003';
end $$;

-- M11 e controle (b): vínculo administrativo (`configure_webhook`, `p_grant_id`
-- nulo) num canal datafy que JÁ consumiu a liberação de migração, com a
-- UazAPI ativa. O estado pós-finalizador é montado direto (liberação
-- consumida, onboarding concluído) para que nenhuma ativação venha do
-- finalizador do onboarding: o que se mede é só o caminho administrativo.
create function pg_temp.m11(
  out o_outcome text, out o_requested timestamptz, out o_cd_active boolean, out o_cu_active boolean, out o_events bigint
) language plpgsql as $$
declare v_g uuid; r record;
begin
  v_g := pg_temp.f_grant('bbbbbbbb-0065-0000-0000-000000000001');
  perform pg_temp.f_target(v_g, true);
  update public.whatsapp_official_connection_grants
     set consumed_channel_id = 'dddddddd-0065-0000-0000-000000000003', consumed_at = now() where id = v_g;
  update public.whatsapp_datafy_onboardings set state = 'completed', completed_at = now()
   where id = 'cccccccc-0065-0000-0000-000000000001';
  select * into r from public.claim_datafy_channel_operation('dddddddd-0065-0000-0000-000000000003',
    'bbbbbbbb-0065-0000-0000-000000000001', 'eeeeeeee-0065-0000-0000-000000000001', 'configure_webhook');
  if not r.claimed or r.source <> 'channel' then raise exception 'M11: claim administrativo do canal nao obtido'; end if;
  o_outcome := public.finalize_datafy_channel_subscription('dddddddd-0065-0000-0000-000000000003', 'bbbbbbbb-0065-0000-0000-000000000001',
    'eeeeeeee-0065-0000-0000-000000000001', r.claim_id, null, null, 'remote65', 0, 'local65');
  select c.activation_requested_at, c.is_active into o_requested, o_cd_active
    from public.whatsapp_channels c where c.id = 'dddddddd-0065-0000-0000-000000000003';
  select c.is_active into o_cu_active from public.whatsapp_channels c where c.id = 'dddddddd-0065-0000-0000-000000000001';
  select count(*) into o_events from public.whatsapp_channel_lifecycle_events e where e.channel_ref = 'dddddddd-0065-0000-0000-000000000003';
end $$;

-- M14, M15 e controle (e): liberação criada com o legado UazAPI fora do ar
-- (sem binding), onboarding + canal datafy assinado, com eco e conectado, e o
-- finalizador com essa liberação.
create function pg_temp.m14(
  out o_pin uuid, out o_outcome text, out o_requested timestamptz, out o_cd_active boolean, out o_events bigint
) language plpgsql as $$
declare v_g uuid; r record;
begin
  v_g := pg_temp.f_grant('bbbbbbbb-0065-0000-0000-000000000008', gen_random_uuid());
  select g.replaces_channel_id into o_pin from public.whatsapp_official_connection_grants g where g.id = v_g;
  insert into public.whatsapp_datafy_onboardings(id, organization_id, unit_id, grant_id, reserved_channel_id, datafy_channel_id, state)
  values ('cccccccc-0065-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0065-0000-0000-000000000008',
          v_g, 'dddddddd-0065-0000-0000-000000000014', 'remote65-legado', 'connected');
  insert into public.whatsapp_channels(id, unit_id, provider, status, external_instance_id, is_active, provider_subscribed_at,
                                       manual_echo_verified_at, credentials)
  values ('dddddddd-0065-0000-0000-000000000014', 'bbbbbbbb-0065-0000-0000-000000000008', 'datafy', 'connected', 'remote65-legado',
          false, now(), now(), '{"phone_number_id":"6500014"}');
  select * into r from public.claim_datafy_onboarding_step('cccccccc-0065-0000-0000-000000000003',
    'bbbbbbbb-0065-0000-0000-000000000008', 'subscribe', 'eeeeeeee-0065-0000-0000-000000000001');
  o_outcome := public.finalize_datafy_channel_subscription('dddddddd-0065-0000-0000-000000000014', 'bbbbbbbb-0065-0000-0000-000000000008',
    'eeeeeeee-0065-0000-0000-000000000001', r.claim_id, 'cccccccc-0065-0000-0000-000000000003', v_g, 'remote65-legado', 0, 'local65');
  select c.activation_requested_at, c.is_active into o_requested, o_cd_active
    from public.whatsapp_channels c where c.id = 'dddddddd-0065-0000-0000-000000000014';
  select count(*) into o_events from public.whatsapp_channel_lifecycle_events e where e.channel_ref = 'dddddddd-0065-0000-0000-000000000014';
end $$;

-- Corte e reversão pelas RPCs existentes (o `begin_switch` é request + activate).
create function pg_temp.offline_target() returns void language plpgsql as $$
begin
  insert into public.whatsapp_channels(id,unit_id,provider,status,external_instance_id,is_active,
      provider_subscribed_at,manual_echo_verified_at,datafy_subscription_required,credentials)
    values ('dddddddd-0065-0000-0000-000000000014','bbbbbbbb-0065-0000-0000-000000000008',
      'datafy','connected','remote65-legado',false,now(),now(),true,'{"phone_number_id":"6500014"}');
end $$;

create function pg_temp.m17_admin_offline(
  out o_outcome text, out o_requested timestamptz, out o_cd_active boolean, out o_events bigint
) language plpgsql as $$
declare r record; v_subscribe_claim uuid;
begin
  perform pg_temp.m14();
  -- O adapter libera o lease do subscribe depois do finalizador. Sem essa
  -- etapa, o claim administrativo deve responder busy e o cenário M17 nunca
  -- alcança o finalizador que pretende medir.
  select claim_id into v_subscribe_claim from public.whatsapp_datafy_onboardings
    where id='cccccccc-0065-0000-0000-000000000003';
  if v_subscribe_claim is null or not public.release_datafy_onboarding_step(
    'cccccccc-0065-0000-0000-000000000003','bbbbbbbb-0065-0000-0000-000000000008',
    v_subscribe_claim,'subscribe','succeeded',null) then
    raise exception 'M17: release do subscribe ausente';
  end if;
  select * into r from public.claim_datafy_channel_operation('dddddddd-0065-0000-0000-000000000014',
    'bbbbbbbb-0065-0000-0000-000000000008', 'eeeeeeee-0065-0000-0000-000000000001', 'configure_webhook');
  if not r.claimed or r.source <> 'channel' then raise exception 'M17: claim administrativo ausente'; end if;
  o_outcome := public.finalize_datafy_channel_subscription('dddddddd-0065-0000-0000-000000000014',
    'bbbbbbbb-0065-0000-0000-000000000008', 'eeeeeeee-0065-0000-0000-000000000001',
    r.claim_id, null, null, 'remote65-legado', 0, 'local65');
  select activation_requested_at,is_active into o_requested,o_cd_active from public.whatsapp_channels
    where id='dddddddd-0065-0000-0000-000000000014';
  select count(*) into o_events from public.whatsapp_channel_lifecycle_events
    where channel_ref='dddddddd-0065-0000-0000-000000000014';
end $$;

create function pg_temp.switch_to(p_channel uuid) returns void language plpgsql as $$
begin
  perform public.request_whatsapp_channel_activation('bbbbbbbb-0065-0000-0000-000000000001', p_channel,
    'eeeeeeee-0065-0000-0000-000000000001', 'local65');
  perform public.activate_whatsapp_channel('bbbbbbbb-0065-0000-0000-000000000001', p_channel,
    'eeeeeeee-0065-0000-0000-000000000001', 'local65');
end $$;

do $$
declare
  a   uuid := 'eeeeeeee-0065-0000-0000-000000000001';
  u   uuid := 'bbbbbbbb-0065-0000-0000-000000000001';
  uc  uuid := 'bbbbbbbb-0065-0000-0000-000000000002';
  u0  uuid := 'bbbbbbbb-0065-0000-0000-000000000003';
  cu  uuid := 'dddddddd-0065-0000-0000-000000000001';
  cuc uuid := 'dddddddd-0065-0000-0000-000000000002';
  cd  uuid := 'dddddddd-0065-0000-0000-000000000003';
  v_forged uuid := gen_random_uuid();
  v_gid uuid; v_pin uuid; v_txt text; v_assert text; v_intent text; v_activate text;
  r record; v_n bigint; v_ok boolean;
begin
  -- ─── M1: o servidor sobrescreve o pin forjado ──────────────────────────────
  if pg_temp.pin_of(uc, v_forged) is distinct from cuc then raise exception 'M1: pin aleatorio forjado sobreviveu'; end if;
  if pg_temp.pin_of(uc, null) is distinct from cuc then raise exception 'M1: pin NULL forjado sobreviveu'; end if;
  if pg_temp.pin_of(uc, cu) is distinct from cuc then raise exception 'M1: id de canal de outra unidade sobreviveu'; end if;
  if pg_temp.pin_of(u, v_forged) is distinct from cu then raise exception 'M1: unidade em migracao nao prendeu a UazAPI'; end if;
  if pg_temp.pin_of('bbbbbbbb-0065-0000-0000-000000000006', v_forged) is distinct from 'dddddddd-0065-0000-0000-000000000006'::uuid then
    raise exception 'M1: legado NULL+connected nao e binding';
  end if;
  -- O papel real de produção (manage-channels usa service_role) também é sobrescrito.
  begin
    set local role service_role;
    insert into public.whatsapp_official_connection_grants(organization_id, unit_id, granted_by, replaces_channel_id)
      values ('aaaaaaaa-0000-0000-0000-000000000002', uc, a, v_forged) returning id into v_gid;
    reset role;
    select replaces_channel_id into v_pin from public.whatsapp_official_connection_grants where id = v_gid;
    raise exception 'rollback' using errcode = 'ZZ065';
  exception when sqlstate 'ZZ065' then null;
  end;
  if v_pin is distinct from cuc then raise exception 'M1: service_role gravou pin forjado (%)', v_pin; end if;
  raise notice '65 M1 OK: pin forjado (aleatorio, NULL, outra unidade, service_role) sobrescrito pelo binding';

  -- ─── M2: sem binding de outro provider → NULL ─────────────────────────────
  if pg_temp.pin_of(u0, v_forged) is not null then raise exception 'M2: unidade sem canal ganhou pin'; end if;
  if pg_temp.pin_of('bbbbbbbb-0065-0000-0000-000000000004', v_forged) is not null then raise exception 'M2: binding datafy ganhou pin'; end if;
  if pg_temp.pin_of('bbbbbbbb-0065-0000-0000-000000000005', v_forged) is not null then raise exception 'M2: canal false virou binding'; end if;
  if pg_temp.pin_of('bbbbbbbb-0065-0000-0000-000000000007', v_forged) is not null then raise exception 'M2: legado mais antigo venceu o ativo explicito'; end if;
  raise notice '65 M2 OK: sem canal, binding datafy, so false e datafy ativo a frente de legado -> NULL';

  -- ─── M3: imutável depois do INSERT ─────────────────────────────────────────
  begin
    v_gid := pg_temp.f_grant(u);
    begin
      update public.whatsapp_official_connection_grants set replaces_channel_id = gen_random_uuid() where id = v_gid;
      raise exception 'M3: troca do pin aceita';
    exception when check_violation then null; end;
    begin
      update public.whatsapp_official_connection_grants set replaces_channel_id = null where id = v_gid;
      raise exception 'M3: pin apagado';
    exception when check_violation then null; end;
    update public.whatsapp_official_connection_grants set replaces_channel_id = replaces_channel_id where id = v_gid;
    update public.whatsapp_official_connection_grants set revoked_at = now(), revoked_by = a where id = v_gid;
    select replaces_channel_id into v_pin from public.whatsapp_official_connection_grants where id = v_gid;
    raise exception 'rollback' using errcode = 'ZZ065';
  exception when sqlstate 'ZZ065' then null;
  end;
  if v_pin is distinct from cu then raise exception 'M3: revogacao/UPDATE sem mudanca alterou o pin (%)', v_pin; end if;
  raise notice '65 M3 OK: troca e apagamento recusados (23514); UPDATE sem mudanca e revogacao preservam o pin';

  -- ─── M4: a autoridade aceita só a liberação presa ao binding ──────────────
  begin
    perform pg_temp.f_grant(u);
    v_txt := pg_temp.assert_outcome(u);
    raise exception 'rollback' using errcode = 'ZZ065';
  exception when sqlstate 'ZZ065' then null;
  end;
  if v_txt <> 'passed' then raise exception 'M4: liberacao ativa presa ao binding recusada (%)', v_txt; end if;
  begin
    v_gid := pg_temp.f_grant(u);
    perform pg_temp.f_target(v_gid, false);
    update public.whatsapp_official_connection_grants set consumed_channel_id = cd, consumed_at = now() where id = v_gid;
    v_txt := pg_temp.assert_outcome(u);
    raise exception 'rollback' using errcode = 'ZZ065';
  exception when sqlstate 'ZZ065' then null;
  end;
  if v_txt <> 'passed' then raise exception 'M4: liberacao consumida pelo canal datafy recusada (%)', v_txt; end if;
  if pg_temp.assert_outcome(uc) not like '23514:datafy_migration_not_supported%' then raise exception 'M4: sem liberacao passou'; end if;
  begin
    v_txt := pg_temp.m4_revoked();
    raise exception 'rollback' using errcode = 'ZZ065';
  exception when sqlstate 'ZZ065' then null;
  end;
  if v_txt not like '23514:datafy_migration_not_supported%' then raise exception 'M4: liberacao revogada passou (%)', v_txt; end if;
  begin
    perform pg_temp.f_grant(u);
    insert into public.whatsapp_channels(id, unit_id, provider, status, is_active, manual_echo_verified_at)
      values ('dddddddd-0065-0000-0000-000000000011', u, 'uazapi', 'connected', null, now());
    update public.whatsapp_channels set is_active = false where id = cu;
    update public.whatsapp_channels set is_active = true where id = 'dddddddd-0065-0000-0000-000000000011';
    v_txt := pg_temp.assert_outcome(u);
    raise exception 'rollback' using errcode = 'ZZ065';
  exception when sqlstate 'ZZ065' then null;
  end;
  if v_txt not like '23514:datafy_migration_not_supported%' then raise exception 'M4: binding trocado passou (%)', v_txt; end if;
  begin
    v_gid := pg_temp.f_grant(u);
    update public.whatsapp_official_connection_grants set consumed_channel_id = cu, consumed_at = now() where id = v_gid;
    v_txt := pg_temp.assert_outcome(u);
    raise exception 'rollback' using errcode = 'ZZ065';
  exception when sqlstate 'ZZ065' then null;
  end;
  if v_txt not like '23514:datafy_migration_not_supported%' then raise exception 'M4: consumida por canal nao-datafy passou (%)', v_txt; end if;
  raise notice '65 M4 OK: passa ativa/consumida pelo datafy; recusa sem liberacao, revogada, binding trocado e consumo nao-datafy';

  -- ─── M5: ativação retida no finalizador ───────────────────────────────────
  begin
    select * into r from pg_temp.m5();
    raise exception 'rollback' using errcode = 'ZZ065';
  exception when sqlstate 'ZZ065' then null;
  end;
  if r.o_pin is distinct from cu then raise exception 'M5: liberacao nao era de migracao (pin %)', r.o_pin; end if;
  if not r.o_auth then raise exception 'M5: subscribe com liberacao de migracao nao autorizado'; end if;
  if r.o_outcome is distinct from 'finalized' then raise exception 'M5: outcome %', r.o_outcome; end if;
  if r.o_consumed is distinct from cd then raise exception 'M5: liberacao nao consumida pelo canal datafy (%)', r.o_consumed; end if;
  if r.o_onb_state is distinct from 'completed' or r.o_onb_creds then raise exception 'M5: onboarding nao concluido (% creds=%)', r.o_onb_state, r.o_onb_creds; end if;
  if r.o_requested is not null or r.o_cd_active is distinct from false or r.o_events <> 0 then
    raise exception 'M5: finalizador pediu intencao/ativou (requested=% ativo=% eventos=%)', r.o_requested, r.o_cd_active, r.o_events;
  end if;
  if r.o_cu_active is distinct from true then raise exception 'M5: UazAPI deixou de ser o canal ativo'; end if;
  raise notice '65 M5 OK: autorizado, finalized, consumida, onboarding concluido; sem intencao, sem evento, datafy inativa com eco; UazAPI ativa';

  -- ─── M6: corte atômico pelo begin_switch ──────────────────────────────────
  begin
    perform pg_temp.m5();
    perform pg_temp.switch_to(cd);
    select count(*) into v_n from public.whatsapp_channels where unit_id = u and is_active is true;
    select (select is_active from public.whatsapp_channels where id = cu) is false
       and (select is_active from public.whatsapp_channels where id = cd) is true
       and (select activation_requested_at from public.whatsapp_channels where id = cd) is null
       and exists(select 1 from public.whatsapp_channel_lifecycle_events e where e.channel_ref = cd
                   and e.event_type = 'activated' and e.related_channel_ref = cu and e.previous_provider = 'uazapi')
      into v_ok;
    raise exception 'rollback' using errcode = 'ZZ065';
  exception when sqlstate 'ZZ065' then null;
  end;
  if not v_ok or v_n <> 1 then raise exception 'M6: corte nao foi atomico (ok=% ativos=%)', v_ok, v_n; end if;
  raise notice '65 M6 OK: UazAPI false, datafy true, um unico ativo, evento activated com o anterior';

  -- ─── M7: reversão e novo corte ────────────────────────────────────────────
  begin
    perform pg_temp.m5();
    perform pg_temp.switch_to(cd);
    perform pg_temp.switch_to(cu);
    select count(*) into v_n from public.whatsapp_channels where unit_id = u and is_active is true;
    select (select is_active from public.whatsapp_channels where id = cu) is true
       and (select is_active from public.whatsapp_channels where id = cd) is false
      into v_ok;
    v_txt := pg_temp.assert_outcome(u);
    raise exception 'rollback' using errcode = 'ZZ065';
  exception when sqlstate 'ZZ065' then null;
  end;
  if not v_ok or v_n <> 1 then raise exception 'M7: reversao nao voltou a UazAPI (ok=% ativos=%)', v_ok, v_n; end if;
  if v_txt <> 'passed' then raise exception 'M7: depois da reversao a liberacao deixou de autorizar novo corte (%)', v_txt; end if;
  -- A reversão não consulta a autoridade Datafy: com ela recusando tudo, passa igual.
  begin
    perform pg_temp.m5();
    perform pg_temp.switch_to(cd);
    execute 'create or replace function public.assert_datafy_first_configuration(p_unit_id uuid) returns void language plpgsql security definer set search_path = '''' as $x$ begin raise exception ''datafy_migration_not_supported'' using errcode=''23514''; end $x$';
    perform pg_temp.switch_to(cu);
    select (select is_active from public.whatsapp_channels where id = cu) is true into v_ok;
    raise exception 'rollback' using errcode = 'ZZ065';
  exception when sqlstate 'ZZ065' then null;
  end;
  if not v_ok then raise exception 'M7: reversao dependeu da autoridade Datafy'; end if;
  raise notice '65 M7 OK: reversao volta a UazAPI (um ativo), liberacao segue autorizando novo corte, guard Datafy nao interfere';

  -- ─── M8: liberação comum continua recusando com binding UazAPI ────────────
  begin
    v_gid := pg_temp.f_grant(u0, v_forged);
    select replaces_channel_id into v_pin from public.whatsapp_official_connection_grants where id = v_gid;
    insert into public.whatsapp_channels(id, unit_id, provider, status, is_active, manual_echo_verified_at)
      values ('dddddddd-0065-0000-0000-000000000009', u0, 'uazapi', 'connected', true, now());
    v_txt := pg_temp.assert_outcome(u0);
    insert into public.whatsapp_datafy_onboardings(id, organization_id, unit_id, grant_id, reserved_channel_id, datafy_channel_id, state)
      values ('cccccccc-0065-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', u0, v_gid,
              'dddddddd-0065-0000-0000-000000000010', 'remote65-comum', 'connected');
    insert into public.whatsapp_channels(id, unit_id, provider, status, external_instance_id, is_active, provider_subscribed_at,
                                         manual_echo_verified_at, credentials)
      values ('dddddddd-0065-0000-0000-000000000010', u0, 'datafy', 'connected', 'remote65-comum', false, now(), now(),
              '{"phone_number_id":"6500010"}');
    select * into r from public.claim_datafy_onboarding_step('cccccccc-0065-0000-0000-000000000002', u0, 'subscribe', a);
    v_ok := true;
    begin
      perform public.authorize_datafy_mutation(u0, 'dddddddd-0065-0000-0000-000000000010', a, r.claim_id,
        'cccccccc-0065-0000-0000-000000000002', 'subscribe', 'remote65-comum', 0, v_gid);
      v_ok := false;
    exception when check_violation then null; end;
    begin
      perform public.finalize_datafy_channel_subscription('dddddddd-0065-0000-0000-000000000010', u0, a, r.claim_id,
        'cccccccc-0065-0000-0000-000000000002', v_gid, 'remote65-comum', 0, 'local65');
      v_ok := false;
    exception when check_violation then null; end;
    select v_ok and g.consumed_at is null into v_ok from public.whatsapp_official_connection_grants g where g.id = v_gid;
    select v_ok and c.activation_requested_at is null and c.is_active is false into v_ok
      from public.whatsapp_channels c where c.id = 'dddddddd-0065-0000-0000-000000000010';
    raise exception 'rollback' using errcode = 'ZZ065';
  exception when sqlstate 'ZZ065' then null;
  end;
  if v_pin is not null then raise exception 'M8: liberacao comum nasceu com pin (%)', v_pin; end if;
  if v_txt not like '23514:datafy_migration_not_supported%' then raise exception 'M8: liberacao comum autorizou binding UazAPI (%)', v_txt; end if;
  if not v_ok then raise exception 'M8: autorizacao/finalizador aceitou liberacao comum ou consumiu/ativou'; end if;
  raise notice '65 M8 OK: liberacao comum (pin NULL) recusada pela autoridade, autorizacao e finalizador, sem consumo';

  -- ─── M11: vínculo administrativo com migração liberada não corta sozinho ──
  begin
    select * into r from pg_temp.m11();
    raise exception 'rollback' using errcode = 'ZZ065';
  exception when sqlstate 'ZZ065' then null;
  end;
  if r.o_outcome is distinct from 'finalized' then raise exception 'M11: outcome %', r.o_outcome; end if;
  if r.o_requested is not null or r.o_cd_active is distinct from false or r.o_events <> 0 then
    raise exception 'M11: caminho administrativo pediu intencao/ativou (requested=% ativo=% eventos=%)', r.o_requested, r.o_cd_active, r.o_events;
  end if;
  if r.o_cu_active is distinct from true then raise exception 'M11: UazAPI deixou de ser o canal ativo'; end if;
  raise notice '65 M11 OK: configure_webhook (p_grant_id nulo) com migracao liberada -> finalized, datafy inativa sem intencao, UazAPI ativa';

  -- ─── M12: vínculo administrativo sem liberação de migração recusa ─────────
  begin
    insert into public.whatsapp_channels(id, unit_id, provider, status, external_instance_id, is_active, provider_subscribed_at,
                                         manual_echo_verified_at, credentials)
      values ('dddddddd-0065-0000-0000-000000000012', uc, 'datafy', 'connected', 'remote65-admin', false, now(), now(),
              '{"phone_number_id":"6500012"}');
    select * into r from public.claim_datafy_channel_operation('dddddddd-0065-0000-0000-000000000012', uc, a, 'configure_webhook');
    v_txt := 'passed';
    begin
      perform public.finalize_datafy_channel_subscription('dddddddd-0065-0000-0000-000000000012', uc, a, r.claim_id,
        null, null, 'remote65-admin', 0, 'local65');
    exception when others then v_txt := sqlstate || ':' || sqlerrm;
    end;
    select (select is_active from public.whatsapp_channels where id = 'dddddddd-0065-0000-0000-000000000012') is false
       and (select activation_requested_at from public.whatsapp_channels where id = 'dddddddd-0065-0000-0000-000000000012') is null
       and (select is_active from public.whatsapp_channels where id = cuc) is true
      into v_ok;
    raise exception 'rollback' using errcode = 'ZZ065';
  exception when sqlstate 'ZZ065' then null;
  end;
  if v_txt not like '23514:datafy_migration_not_supported%' then raise exception 'M12: vinculo administrativo sem liberacao nao recusou (%)', v_txt; end if;
  if not v_ok then raise exception 'M12: recusa deixou intencao/ativacao ou derrubou a UazAPI'; end if;
  raise notice '65 M12 OK: configure_webhook sem liberacao de migracao recusa (datafy_migration_not_supported), sem efeito';

  -- ─── M13: liberação de migração não ativa nem quando o binding some ───────
  begin
    select * into r from pg_temp.m5(true);
    raise exception 'rollback' using errcode = 'ZZ065';
  exception when sqlstate 'ZZ065' then null;
  end;
  if r.o_outcome is distinct from 'finalized' or r.o_consumed is distinct from cd then
    raise exception 'M13: outcome % consumo %', r.o_outcome, r.o_consumed;
  end if;
  if r.o_requested is not null or r.o_cd_active is distinct from false or r.o_events <> 0 then
    raise exception 'M13: liberacao de migracao ativou sem binding (requested=% ativo=% eventos=%)', r.o_requested, r.o_cd_active, r.o_events;
  end if;
  raise notice '65 M13 OK: binding removido antes do finalizador; liberacao de migracao consome sem intencao nem ativacao';

  -- ─── M14: legado NULL fora do ar é preso; o finalizador retém ────────────
  begin
    select * into r from pg_temp.m14();
    raise exception 'rollback' using errcode = 'ZZ065';
  exception when sqlstate 'ZZ065' then null;
  end;
  if r.o_pin is distinct from 'dddddddd-0065-0000-0000-000000000013'::uuid then
    raise exception 'M14: legado NULL desconectado nao foi preso (pin %)', r.o_pin;
  end if;
  if r.o_outcome is distinct from 'finalized' or r.o_requested is not null or r.o_cd_active is distinct from false or r.o_events <> 0 then
    raise exception 'M14: finalizador com legado fora do ar pediu intencao/ativou (outcome=% requested=% ativo=% eventos=%)',
      r.o_outcome, r.o_requested, r.o_cd_active, r.o_events;
  end if;
  raise notice '65 M14 OK: legado UazAPI NULL desconectado preso; finalized sem intencao, datafy inativa com eco';

  -- ─── M15: o legado reconecta, a autoridade casa com o pin e o corte passa ─
  begin
    perform pg_temp.m14();
    update public.whatsapp_channels set status = 'connected' where id = 'dddddddd-0065-0000-0000-000000000013';
    v_txt := pg_temp.assert_outcome('bbbbbbbb-0065-0000-0000-000000000008');
    perform public.request_whatsapp_channel_activation('bbbbbbbb-0065-0000-0000-000000000008', 'dddddddd-0065-0000-0000-000000000014', a, 'local65');
    perform public.activate_whatsapp_channel('bbbbbbbb-0065-0000-0000-000000000008', 'dddddddd-0065-0000-0000-000000000014', a, 'local65');
    select (select is_active from public.whatsapp_channels where id = 'dddddddd-0065-0000-0000-000000000014') is true
       and (select is_active from public.whatsapp_channels where id = 'dddddddd-0065-0000-0000-000000000013') is false
      into v_ok;
    raise exception 'rollback' using errcode = 'ZZ065';
  exception when sqlstate 'ZZ065' then null;
  end;
  if v_txt <> 'passed' then raise exception 'M15: legado reconectado nao casou com o pin (%)', v_txt; end if;
  if not v_ok then raise exception 'M15: begin_switch depois da reconexao nao trocou'; end if;
  raise notice '65 M15 OK: legado reconectado volta a ser o binding, autoridade passa pelo pin e o corte troca';

  -- ─── M16: só canal `false` de outro provider nunca é preso ───────────────
  if pg_temp.pin_of('bbbbbbbb-0065-0000-0000-000000000009', v_forged) is not null
     or pg_temp.pin_of('bbbbbbbb-0065-0000-0000-000000000005', v_forged) is not null then
    raise exception 'M16: canal is_active=false virou pin';
  end if;
  raise notice '65 M16 OK: unidade so com canal false (desconectado ou conectado) -> pin NULL';

  -- ─── M17: vínculo administrativo não ativa com legado NULL offline ───────
  begin
    select * into r from pg_temp.m17_admin_offline();
    raise exception 'rollback' using errcode = 'ZZ065';
  exception when sqlstate 'ZZ065' then null;
  end;
  if r.o_outcome is distinct from 'finalized' or r.o_requested is not null
     or r.o_cd_active is distinct from false or r.o_events <> 0 then
    raise exception 'M17: finalizador administrativo cortou legado offline (outcome=% intent=% active=% events=%)',
      r.o_outcome,r.o_requested,r.o_cd_active,r.o_events;
  end if;
  raise notice '65 M17 OK: configure_webhook sem grant no argumento preserva legado NULL offline';

  -- ─── M18: a autoridade protege intenção e eco mesmo sem binding ─────────
  -- Sem grant, as três entradas recusam; cada tentativa mantém alvo intacto.
  begin
    perform pg_temp.offline_target();
    v_assert := pg_temp.assert_outcome('bbbbbbbb-0065-0000-0000-000000000008');
    v_intent := pg_temp.cutover_outcome('bbbbbbbb-0065-0000-0000-000000000008','dddddddd-0065-0000-0000-000000000014','intent');
    v_activate := pg_temp.cutover_outcome('bbbbbbbb-0065-0000-0000-000000000008','dddddddd-0065-0000-0000-000000000014','activate');
    if v_assert not like '23514:datafy_migration_not_supported%'
      or v_intent not like '23514:datafy_migration_not_supported%'
      or v_activate not like '23514:datafy_migration_not_supported%' then
      raise exception 'M18: sem grant aceitou autoridade, intent ou activate';
    end if;
    select activation_requested_at is null and is_active is false into v_ok from public.whatsapp_channels
      where id='dddddddd-0065-0000-0000-000000000014';
    raise exception 'rollback' using errcode = 'ZZ065';
  exception when sqlstate 'ZZ065' then null;
  end;
  if not v_ok then raise exception 'M18: tentativa sem grant deixou efeito'; end if;
  -- Grant pendente protege o intervalo entre subscribe e finalizer.
  begin
    perform pg_temp.offline_target();
    v_gid := pg_temp.f_grant('bbbbbbbb-0065-0000-0000-000000000008');
    v_txt := pg_temp.assert_outcome('bbbbbbbb-0065-0000-0000-000000000008');
    v_intent := pg_temp.cutover_outcome('bbbbbbbb-0065-0000-0000-000000000008','dddddddd-0065-0000-0000-000000000014','intent');
    select activation_requested_at is not null and is_active is false into v_ok
      from public.whatsapp_channels where id='dddddddd-0065-0000-0000-000000000014';
    v_activate := pg_temp.cutover_outcome('bbbbbbbb-0065-0000-0000-000000000008','dddddddd-0065-0000-0000-000000000014','activate');
    v_ok := v_ok is true and v_intent='passed' and v_activate='passed';
    select v_ok and target.is_active is true and target.activation_requested_at is null
      and legacy.is_active is false into v_ok
      from public.whatsapp_channels target, public.whatsapp_channels legacy
      where target.id='dddddddd-0065-0000-0000-000000000014'
        and legacy.id='dddddddd-0065-0000-0000-000000000013';
    raise exception 'rollback' using errcode = 'ZZ065';
  exception when sqlstate 'ZZ065' then null;
  end;
  if v_txt<>'passed' or v_ok is not true then raise exception 'M18: grant pendente recusou corte atomico (authority=% ok=%)',v_txt,v_ok; end if;
  -- Grant consumido pelo alvo Datafy da mesma unidade também autoriza.
  begin
    perform pg_temp.offline_target();
    v_gid := pg_temp.f_grant('bbbbbbbb-0065-0000-0000-000000000008');
    update public.whatsapp_official_connection_grants set consumed_channel_id='dddddddd-0065-0000-0000-000000000014',consumed_at=now()
      where id=v_gid;
    v_txt := pg_temp.assert_outcome('bbbbbbbb-0065-0000-0000-000000000008');
    v_intent := pg_temp.cutover_outcome('bbbbbbbb-0065-0000-0000-000000000008','dddddddd-0065-0000-0000-000000000014','intent');
    select activation_requested_at is not null and is_active is false into v_ok
      from public.whatsapp_channels where id='dddddddd-0065-0000-0000-000000000014';
    v_activate := pg_temp.cutover_outcome('bbbbbbbb-0065-0000-0000-000000000008','dddddddd-0065-0000-0000-000000000014','activate');
    v_ok := v_ok is true and v_intent='passed' and v_activate='passed';
    select v_ok and target.is_active is true and target.activation_requested_at is null
      and legacy.is_active is false into v_ok
      from public.whatsapp_channels target, public.whatsapp_channels legacy
      where target.id='dddddddd-0065-0000-0000-000000000014'
        and legacy.id='dddddddd-0065-0000-0000-000000000013';
    raise exception 'rollback' using errcode = 'ZZ065';
  exception when sqlstate 'ZZ065' then null;
  end;
  if v_txt<>'passed' or v_ok is not true then raise exception 'M18: grant consumido recusou corte atomico (authority=% ok=%)',v_txt,v_ok; end if;
  -- Intenção antiga sobrevive à revogação, mas o callback não pode ativar.
  begin
    perform pg_temp.offline_target();
    v_gid := pg_temp.f_grant('bbbbbbbb-0065-0000-0000-000000000008');
    if pg_temp.cutover_outcome('bbbbbbbb-0065-0000-0000-000000000008','dddddddd-0065-0000-0000-000000000014','intent')<>'passed' then
      raise exception 'M18: nao conseguiu preparar intent antiga';
    end if;
    update public.whatsapp_official_connection_grants set revoked_at=now(),revoked_by=a where id=v_gid;
    v_assert := pg_temp.assert_outcome('bbbbbbbb-0065-0000-0000-000000000008');
    v_intent := pg_temp.cutover_outcome('bbbbbbbb-0065-0000-0000-000000000008','dddddddd-0065-0000-0000-000000000014','intent');
    v_activate := pg_temp.cutover_outcome('bbbbbbbb-0065-0000-0000-000000000008','dddddddd-0065-0000-0000-000000000014','activate');
    v_ok := v_assert like '23514:datafy_migration_not_supported%'
      and v_intent like '23514:datafy_migration_not_supported%'
      and v_activate like '23514:datafy_migration_not_supported%';
    select v_ok and activation_requested_at is not null and is_active is false into v_ok
      from public.whatsapp_channels where id='dddddddd-0065-0000-0000-000000000014';
    raise exception 'rollback' using errcode = 'ZZ065';
  exception when sqlstate 'ZZ065' then null;
  end;
  if not v_ok then raise exception 'M18: revogacao permitiu intent ou eco antigo ativar'; end if;
  -- Estado não conectado alternativo usa o mesmo fallback determinístico.
  begin
    update public.whatsapp_channels set status='error' where id='dddddddd-0065-0000-0000-000000000013';
    v_gid := pg_temp.f_grant('bbbbbbbb-0065-0000-0000-000000000008');
    v_ok := pg_temp.assert_outcome('bbbbbbbb-0065-0000-0000-000000000008')='passed';
    raise exception 'rollback' using errcode = 'ZZ065';
  exception when sqlstate 'ZZ065' then null;
  end;
  if not v_ok then raise exception 'M18: legado error com grant foi recusado'; end if;
  raise notice '65 M18 OK: offline sem/pending/consumed/revoked, request/activate, intent antiga, status error';
end $$;

-- ─── M9: forma e ACL ─────────────────────────────────────────────────────────
do $$
declare sig regprocedure; p record; v_trg text[]; v_def text;
begin
  if not exists (select 1 from pg_catalog.pg_attribute
                  where attrelid = 'public.whatsapp_official_connection_grants'::regclass and attname = 'replaces_channel_id'
                    and atttypid = 'uuid'::regtype and not attnotnull and not atthasdef and not attisdropped) then
    raise exception 'M9: coluna replaces_channel_id fora da forma (uuid, nula, sem default)';
  end if;
  if exists (select 1 from pg_catalog.pg_constraint c
              where c.conrelid = 'public.whatsapp_official_connection_grants'::regclass and c.contype = 'f'
                and (select attnum from pg_catalog.pg_attribute where attrelid = c.conrelid and attname = 'replaces_channel_id') = any(c.conkey)) then
    raise exception 'M9: replaces_channel_id ganhou FK (registro historico nao tem FK)';
  end if;
  select array_agg(tgname::text order by tgname) into v_trg from pg_catalog.pg_trigger
   where tgrelid = 'public.whatsapp_official_connection_grants'::regclass and not tgisinternal;
  if v_trg is distinct from array['whatsapp_official_connection_grants_guard_trg', 'whatsapp_official_connection_grants_migration_pin_trg'] then
    raise exception 'M9: triggers da tabela de liberacoes fora do esperado (%)', v_trg;
  end if;
  select pg_catalog.pg_get_triggerdef(oid) into v_def from pg_catalog.pg_trigger
   where tgrelid = 'public.whatsapp_official_connection_grants'::regclass and tgname = 'whatsapp_official_connection_grants_migration_pin_trg';
  if v_def not like '%BEFORE INSERT OR UPDATE OF replaces_channel_id ON %whatsapp_official_connection_grants FOR EACH ROW EXECUTE FUNCTION %whatsapp_official_connection_grants_migration_pin()' then
    raise exception 'M9: forma do trigger de pin (%)', v_def;
  end if;
  foreach sig in array array['public.whatsapp_official_connection_grants_migration_pin()'::regprocedure,
    'public.assert_datafy_first_configuration(uuid)'::regprocedure,
    'public.finalize_datafy_channel_subscription(uuid,uuid,uuid,uuid,uuid,uuid,text,bigint,text)'::regprocedure] loop
    select * into p from pg_catalog.pg_proc where oid = sig;
    if not p.prosecdef or p.proconfig is distinct from array['search_path=""'] then raise exception 'M9: forma SECURITY DEFINER/search_path %', sig; end if;
    if has_function_privilege('anon', sig, 'execute') or has_function_privilege('authenticated', sig, 'execute')
       or exists (select 1 from pg_catalog.aclexplode(p.proacl) where grantee = 0) then
      raise exception 'M9: EXECUTE aberto a PUBLIC/anon/authenticated em %', sig;
    end if;
  end loop;
  if has_function_privilege('service_role', 'public.whatsapp_official_connection_grants_migration_pin()', 'execute')
     or has_function_privilege('service_role', 'public.assert_datafy_first_configuration(uuid)', 'execute')
     or not has_function_privilege('service_role', 'public.finalize_datafy_channel_subscription(uuid,uuid,uuid,uuid,uuid,uuid,text,bigint,text)', 'execute') then
    raise exception 'M9: ACL do service_role fora do esperado (trigger/autoridade fechadas, finalizador aberto)';
  end if;
  -- Conta os pares que CASAM: um join vazio (assinatura impressa diferente)
  -- não pode passar por "nenhuma divergência".
  if (select count(*) from t_snap065 snap
        join pg_catalog.pg_proc fn on 'acl_antes:' || fn.oid::regprocedure::text = snap.k
       where snap.v = coalesce(fn.proacl::text, 'null')) <> 2 then
    raise exception 'M9: ACL das funcoes substituidas mudou em relacao a antes da migration (snapshot do 65a)';
  end if;
  raise notice '65 M9 OK: coluna sem FK, trigger depois do guard, SECURITY DEFINER/search_path vazio, ACL fechada e identica a de antes';
end $$;

-- ─── Controles positivos ─────────────────────────────────────────────────────
do $$
declare
  v_forged uuid := gen_random_uuid(); v_sig regprocedure; v_def text; v_acl text; v_sab text;
  v_pin uuid; v_txt text; r record;
begin
  -- (a) trigger sem o pin: o forjado sobrevive (M1 vermelho).
  v_sig := 'public.whatsapp_official_connection_grants_migration_pin()';
  select pg_catalog.pg_get_functiondef(oid), coalesce(proacl::text, 'null') into v_def, v_acl from pg_catalog.pg_proc where oid = v_sig;
  v_sab := regexp_replace(v_def, '-- <pin>.*?-- </pin>', '');
  if v_sab = v_def then raise exception 'CTRL-a: sabotagem nao mudou o corpo (marcadores ausentes?)'; end if;
  begin
    execute v_sab;
    v_pin := pg_temp.pin_of('bbbbbbbb-0065-0000-0000-000000000002', v_forged);
    raise exception 'rollback' using errcode = 'ZZ065';
  exception when sqlstate 'ZZ065' then null;
  end;
  if v_pin is distinct from v_forged then raise exception 'CTRL-a inerte: sem o pin o forjado deveria sobreviver (visto %)', v_pin; end if;
  if (select pg_catalog.pg_get_functiondef(oid) <> v_def or coalesce(proacl::text, 'null') <> v_acl from pg_catalog.pg_proc where oid = v_sig) then
    raise exception 'CTRL-a: restore falhou';
  end if;
  if pg_temp.pin_of('bbbbbbbb-0065-0000-0000-000000000002', v_forged) is distinct from 'dddddddd-0065-0000-0000-000000000002'::uuid then
    raise exception 'CTRL-a: M1 nao voltou a verde depois do restore';
  end if;
  raise notice '65 CTRL-a OK: sem -- <pin> o pin forjado sobrevive; restore conferido';

  -- (b) finalizador com o bloco de ativação ANTERIOR (20261014170540), verbatim:
  -- a datafy ativa sozinha no eco pelo onboarding (M5 vermelho) e pelo vínculo
  -- administrativo (M11 vermelho).
  v_sig := 'public.finalize_datafy_channel_subscription(uuid,uuid,uuid,uuid,uuid,uuid,text,bigint,text)';
  select pg_catalog.pg_get_functiondef(oid), coalesce(proacl::text, 'null') into v_def, v_acl from pg_catalog.pg_proc where oid = v_sig;
  v_sab := regexp_replace(v_def, '-- <ativacao-retida>.*?-- </ativacao-retida>', $old$if c.provider_subscription_canceled_at is null and c.provider_paused_at is null and c.is_active is distinct from true then
    perform public.assert_datafy_first_configuration(p_unit_id);
    if c.activation_requested_at is null then
      perform public.request_whatsapp_channel_activation(p_unit_id,p_channel_id,p_actor_id,p_request_id);
    end if;
    if c.manual_echo_verified_at is not null and c.status='connected' then
      perform public.activate_whatsapp_channel(p_unit_id,p_channel_id,p_actor_id,p_request_id);
    end if;
  end if;$old$);
  if v_sab = v_def then raise exception 'CTRL-b: sabotagem nao mudou o corpo (marcadores ausentes?)'; end if;
  begin
    execute v_sab;
    select * into r from pg_temp.m5();
    raise exception 'rollback' using errcode = 'ZZ065';
  exception when sqlstate 'ZZ065' then null;
  end;
  if r.o_cd_active is distinct from true or r.o_cu_active is distinct from false or r.o_outcome is distinct from 'finalized' then
    raise exception 'CTRL-b inerte (M5): bloco anterior deveria trocar sozinho (datafy=% uazapi=% outcome=%)', r.o_cd_active, r.o_cu_active, r.o_outcome;
  end if;
  begin
    execute v_sab;
    select * into r from pg_temp.m11();
    raise exception 'rollback' using errcode = 'ZZ065';
  exception when sqlstate 'ZZ065' then null;
  end;
  if r.o_cd_active is distinct from true or r.o_cu_active is distinct from false or r.o_outcome is distinct from 'finalized' then
    raise exception 'CTRL-b inerte (M11): bloco anterior deveria trocar pelo vinculo administrativo (datafy=% uazapi=% outcome=%)', r.o_cd_active, r.o_cu_active, r.o_outcome;
  end if;
  if (select pg_catalog.pg_get_functiondef(oid) <> v_def or coalesce(proacl::text, 'null') <> v_acl from pg_catalog.pg_proc where oid = v_sig) then
    raise exception 'CTRL-b: restore falhou';
  end if;
  raise notice '65 CTRL-b OK: com o bloco anterior o finalizador troca sozinho no eco (M5 e M11 vermelhos); restore conferido';

  -- (d) só a checagem de binding, sem a condição da liberação de migração: o
  -- M5 continua retido (binding UazAPI), mas com o binding removido antes do
  -- finalizador a liberação de migração ativa sozinha (M13 vermelho). É o que
  -- justifica manter as DUAS condições.
  v_sab := replace(v_def, 'and (p_grant_id is null or g.replaces_channel_id is null)', '');
  if v_sab = v_def then raise exception 'CTRL-d: sabotagem nao mudou o corpo'; end if;
  begin
    execute v_sab;
    select * into r from pg_temp.m5();
    raise exception 'rollback' using errcode = 'ZZ065';
  exception when sqlstate 'ZZ065' then null;
  end;
  if r.o_cd_active is distinct from false or r.o_requested is not null then
    raise exception 'CTRL-d: sem a condicao da liberacao o M5 ja deveria seguir retido pelo binding (ativo=%)', r.o_cd_active;
  end if;
  begin
    execute v_sab;
    select * into r from pg_temp.m5(true);
    raise exception 'rollback' using errcode = 'ZZ065';
  exception when sqlstate 'ZZ065' then null;
  end;
  if r.o_cd_active is distinct from true then
    raise exception 'CTRL-d inerte (M13): sem a condicao da liberacao a datafy deveria ativar sem binding (ativo=%)', r.o_cd_active;
  end if;
  if (select pg_catalog.pg_get_functiondef(oid) <> v_def or coalesce(proacl::text, 'null') <> v_acl from pg_catalog.pg_proc where oid = v_sig) then
    raise exception 'CTRL-d: restore falhou';
  end if;
  raise notice '65 CTRL-d OK: so com a checagem de binding o M5 segue retido mas o M13 ativa; restore conferido';

  -- (c) autoridade ignorando `revoked_at`: a liberação revogada passa (M4 vermelho).
  v_sig := 'public.assert_datafy_first_configuration(uuid)';
  select pg_catalog.pg_get_functiondef(oid), coalesce(proacl::text, 'null') into v_def, v_acl from pg_catalog.pg_proc where oid = v_sig;
  v_sab := replace(v_def, 'g.revoked_at is null', 'true');
  if v_sab = v_def then raise exception 'CTRL-c: sabotagem nao mudou o corpo'; end if;
  begin
    execute v_sab;
    v_txt := pg_temp.m4_revoked();
    raise exception 'rollback' using errcode = 'ZZ065';
  exception when sqlstate 'ZZ065' then null;
  end;
  if v_txt <> 'passed' then raise exception 'CTRL-c inerte: sem revoked_at a liberacao revogada deveria passar (%)', v_txt; end if;
  if (select pg_catalog.pg_get_functiondef(oid) <> v_def or coalesce(proacl::text, 'null') <> v_acl from pg_catalog.pg_proc where oid = v_sig) then
    raise exception 'CTRL-c: restore falhou';
  end if;
  begin
    v_txt := pg_temp.m4_revoked();
    raise exception 'rollback' using errcode = 'ZZ065';
  exception when sqlstate 'ZZ065' then null;
  end;
  if v_txt not like '23514:datafy_migration_not_supported%' then raise exception 'CTRL-c: M4 nao voltou a verde depois do restore (%)', v_txt; end if;
  raise notice '65 CTRL-c OK: sem revoked_at a revogada passa; restore conferido';

  -- (e) trigger sem o fallback do legado: a liberação nasce comum com o legado
  -- fora do ar e o finalizador ativa a datafy no eco (M14 vermelho).
  v_sig := 'public.whatsapp_official_connection_grants_migration_pin()';
  select pg_catalog.pg_get_functiondef(oid), coalesce(proacl::text, 'null') into v_def, v_acl from pg_catalog.pg_proc where oid = v_sig;
  v_sab := regexp_replace(v_def, '-- <fallback-legado>.*?-- </fallback-legado>', '');
  if v_sab = v_def then raise exception 'CTRL-e: sabotagem nao mudou o corpo (marcadores ausentes?)'; end if;
  begin
    execute v_sab;
    v_pin := pg_temp.pin_of('bbbbbbbb-0065-0000-0000-000000000008',v_forged);
    v_txt := 'passed';
    begin perform pg_temp.m14(); exception when others then v_txt := sqlstate || ':' || sqlerrm; end;
    raise exception 'rollback' using errcode = 'ZZ065';
  exception when sqlstate 'ZZ065' then null;
  end;
  if v_pin is not null or v_txt not like '23514:datafy_migration_not_supported%' then
    raise exception 'CTRL-e inerte: sem fallback o pin nasce NULL e autoridade deve recusar (pin=% outcome=%)',v_pin,v_txt;
  end if;
  if (select pg_catalog.pg_get_functiondef(oid) <> v_def or coalesce(proacl::text, 'null') <> v_acl from pg_catalog.pg_proc where oid = v_sig) then
    raise exception 'CTRL-e: restore falhou';
  end if;
  raise notice '65 CTRL-e OK: sem -- <fallback-legado> pin nasce comum e nova autoridade recusa finalizacao; restore conferido';

  -- (f) sem fallback na autoridade, pedido e callback tratam o legado offline
  -- como primeira configuração e aceitam o corte sem grant (M18 vermelho).
  v_sig := 'public.assert_datafy_first_configuration(uuid)';
  select pg_catalog.pg_get_functiondef(oid), coalesce(proacl::text,'null') into v_def,v_acl from pg_catalog.pg_proc where oid=v_sig;
  v_sab := regexp_replace(v_def, '-- <authority-offline-fallback>.*?-- </authority-offline-fallback>', '');
  if v_sab=v_def then raise exception 'CTRL-f: sabotagem nao mudou o corpo'; end if;
  begin
    execute v_sab;
    perform pg_temp.offline_target();
    v_txt := pg_temp.assert_outcome('bbbbbbbb-0065-0000-0000-000000000008');
    raise exception 'rollback' using errcode='ZZ065';
  exception when sqlstate 'ZZ065' then null;
  end;
  if v_txt<>'passed' then raise exception 'CTRL-f inerte: sem fallback a autoridade deveria aceitar primeira configuracao (%)',v_txt; end if;
  if (select pg_catalog.pg_get_functiondef(oid)<>v_def or coalesce(proacl::text,'null')<>v_acl from pg_catalog.pg_proc where oid=v_sig) then
    raise exception 'CTRL-f: restore falhou';
  end if;
  raise notice '65 CTRL-f OK: remover fallback libera autoridade sem grant; restore conferido';

  -- (g) sem fallback no finalizador administrativo, a assinatura/eco ativam
  -- sozinhos mesmo quando a autoridade reconhece grant valido (M17 vermelho).
  v_sig := 'public.finalize_datafy_channel_subscription(uuid,uuid,uuid,uuid,uuid,uuid,text,bigint,text)';
  select pg_catalog.pg_get_functiondef(oid), coalesce(proacl::text,'null') into v_def,v_acl from pg_catalog.pg_proc where oid=v_sig;
  v_sab := regexp_replace(v_def, '-- <finalizer-offline-fallback>.*?-- </finalizer-offline-fallback>', '');
  if v_sab=v_def then raise exception 'CTRL-g: sabotagem nao mudou o corpo'; end if;
  begin
    execute v_sab;
    select * into r from pg_temp.m17_admin_offline();
    raise exception 'rollback' using errcode='ZZ065';
  exception when sqlstate 'ZZ065' then null;
  end;
  if r.o_outcome is distinct from 'finalized' or r.o_cd_active is distinct from true then
    raise exception 'CTRL-g inerte: sem fallback finalizador deveria ativar offline (outcome=% active=%)',r.o_outcome,r.o_cd_active;
  end if;
  if (select pg_catalog.pg_get_functiondef(oid)<>v_def or coalesce(proacl::text,'null')<>v_acl from pg_catalog.pg_proc where oid=v_sig) then
    raise exception 'CTRL-g: restore falhou';
  end if;
  raise notice '65 CTRL-g OK: remover fallback ativa pelo finalizador administrativo; restore conferido';

  raise notice '65: M1..M9 e M11..M18 OK + 7 controles positivos OK (M10 reportado no topo)';
end $$;

rollback;
