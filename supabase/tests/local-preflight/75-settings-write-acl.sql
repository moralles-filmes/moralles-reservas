-- S1..S16, extras e CONTROLE-SET-1 (ordinais 751-770): migration
-- 20261019180000_settings_write_role_guard.sql contra Postgres real.
--
-- BASE: 00 -> 01 -> 09a -> 106 -> 75a (ver 75a e README §75). Os casos rodam
-- com a identidade de verdade: `set local role authenticated|service_role|anon`
-- + `request.jwt.claims` (`sub`, `role`), e a RLS de produção ligada (75a).
-- Cada caso confere o SQLSTATE e a MENSAGEM (`setting_write_forbidden` é do
-- trigger; a RLS e a ACL devolvem `42501` com outra mensagem) E o efeito na
-- tabela (valor intacto ou gravado).
--
-- RED: sem a migration, a guarda abaixo aborta (é o RED registrado no README).
-- GREEN: este arquivo reaplica a migration por `\i` (S15 mede um trigger só),
-- recoloca as linhas iniciais e mede. Roda da RAIZ DO REPO e pode ser repetido
-- no mesmo banco.

create table if not exists t_res (ord int primary key, caso text, veredito text);
delete from t_res where ord between 751 and 770;

do $$
begin
  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.settings'::regclass
                    and tgname = 'settings_write_role_guard' and not tgisinternal)
     or to_regprocedure('app_private.unit_setting_write_class(text)') is null
     or to_regprocedure('app_private.guard_unit_setting_write()') is null then
    raise exception '75: trigger settings_write_role_guard ausente. Aplique a migration 20261019180000 antes (sem ela, este abort é o RED esperado).';
  end if;
  if to_regprocedure('auth.role()') is null
     or not exists (select 1 from pg_trigger
                     where tgrelid = 'public.settings'::regclass
                       and tgname = 'whatsapp_legacy_template_write') then
    raise exception '75 exige o 75a (auth.role(), RLS de produção e guard legado).';
  end if;
end $$;

-- ─── Migration reaplicada (S15 mede o resultado) ─────────────────────────────
\i supabase/migrations/20261019180000_settings_write_role_guard.sql

-- ─── Linhas iniciais de volta (sem triggers, só para o setup) ────────────────
set session_replication_role = replica;
delete from public.settings
 where unit_id in ('a0d75000-0000-4000-8000-0000000000aa', 'a0d75000-0000-4000-8000-0000000000bb');
insert into public.settings (unit_id, key, value)
select 'a0d75000-0000-4000-8000-0000000000aa'::uuid, k, to_jsonb('set75-inicial-' || k)
  from unnest(array['ai_config', 'ai_system_prompt', 'ai_context_extra', 'agent_mode',
                    'agent_name', 'restaurant_menu', 'delivery_response',
                    'restaurant_extra_info', 'booking_window_days', 'restaurant_name']) as k;
set session_replication_role = origin;

-- ─── Helpers ─────────────────────────────────────────────────────────────────
-- Executa p_sql como (p_role, p_sub) e devolve 'ok' ou 'SQLSTATE:mensagem'.
-- p_role nulo = sem claims e sem trocar de papel (postgres, como `db push`).
create or replace function pg_temp.s75_try(p_role text, p_sub uuid, p_sql text)
returns text language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when p_role is null then ''
         else jsonb_strip_nulls(jsonb_build_object('sub', p_sub, 'role', p_role))::text end,
    true);
  begin
    if p_role is not null then execute format('set local role %I', p_role); end if;
    execute p_sql;
    reset role;
    perform set_config('request.jwt.claims', '', true);
    return 'ok';
  exception when others then
    reset role;
    perform set_config('request.jwt.claims', '', true);
    return sqlstate || ':' || sqlerrm;
  end;
end $$;

create or replace function pg_temp.s75_ups(p_unit uuid, p_key text, p_val text)
returns text language sql as $$
  select format('insert into public.settings (unit_id, key, value) values (%L, %L, %L::jsonb) '
                'on conflict (unit_id, key) do update set value = excluded.value',
                p_unit, p_key, to_jsonb(p_val)::text)
$$;

create or replace function pg_temp.s75_upd(p_unit uuid, p_key text, p_val text)
returns text language sql as $$
  select format('update public.settings set value = %L::jsonb where unit_id = %L and key = %L',
                to_jsonb(p_val)::text, p_unit, p_key)
$$;

create or replace function pg_temp.s75_del(p_unit uuid, p_key text)
returns text language sql as $$
  select format('delete from public.settings where unit_id = %L and key = %L', p_unit, p_key)
$$;

-- Valor atual (lido como postgres, dono da tabela, RLS não forçada).
create or replace function pg_temp.s75_val(p_unit uuid, p_key text)
returns text language sql as $$
  select coalesce((select value #>> '{}' from public.settings where unit_id = p_unit and key = p_key),
                  '<ausente>')
$$;

-- ─── S1: operador não grava ai_config (upsert, update, delete) ───────────────
do $$
declare a text; b text; c text; v text;
  u1 constant uuid := 'a0d75000-0000-4000-8000-0000000000aa';
  op constant uuid := 'a0d75000-0000-4000-8000-0000000000a3';
  f constant text := '42501:setting_write_forbidden';
begin
  a := pg_temp.s75_try('authenticated', op, pg_temp.s75_ups(u1, 'ai_config', 's75-op'));
  b := pg_temp.s75_try('authenticated', op, pg_temp.s75_upd(u1, 'ai_config', 's75-op'));
  c := pg_temp.s75_try('authenticated', op, pg_temp.s75_del(u1, 'ai_config'));
  v := pg_temp.s75_val(u1, 'ai_config');
  insert into t_res values (751, 'S1 operador U1: upsert/update/delete de ai_config recusados com 42501, linha intacta',
    case when a = f and b = f and c = f and v = 'set75-inicial-ai_config' then 'PASSOU'
         else 'FALHOU ups=' || a || ' upd=' || b || ' del=' || c || ' valor=' || v end);
end $$;

-- ─── S2: operador não grava nem chave manager ────────────────────────────────
do $$
declare a text; b text; c text; v text;
  u1 constant uuid := 'a0d75000-0000-4000-8000-0000000000aa';
  op constant uuid := 'a0d75000-0000-4000-8000-0000000000a3';
  f constant text := '42501:setting_write_forbidden';
begin
  a := pg_temp.s75_try('authenticated', op, pg_temp.s75_ups(u1, 'booking_window_days', 's75-op'));
  b := pg_temp.s75_try('authenticated', op, pg_temp.s75_ups(u1, 'reminder_d1_enabled', 's75-op'));
  c := pg_temp.s75_try('authenticated', op, pg_temp.s75_del(u1, 'booking_window_days'));
  v := pg_temp.s75_val(u1, 'booking_window_days') || '|' || pg_temp.s75_val(u1, 'reminder_d1_enabled');
  insert into t_res values (752, 'S2 operador U1: upsert de booking_window_days (existe) e reminder_d1_enabled (novo) e DELETE de booking_window_days recusados',
    case when a = f and b = f and c = f and v = 'set75-inicial-booking_window_days|<ausente>' then 'PASSOU'
         else 'FALHOU a=' || a || ' b=' || b || ' del=' || c || ' valores=' || v end);
end $$;

-- ─── S3: gerente não grava ai_config ─────────────────────────────────────────
do $$
declare a text; b text; c text; v text;
  u1 constant uuid := 'a0d75000-0000-4000-8000-0000000000aa';
  ger constant uuid := 'a0d75000-0000-4000-8000-0000000000a2';
  f constant text := '42501:setting_write_forbidden';
begin
  a := pg_temp.s75_try('authenticated', ger, pg_temp.s75_ups(u1, 'ai_config', 's75-ger'));
  b := pg_temp.s75_try('authenticated', ger, pg_temp.s75_upd(u1, 'ai_config', 's75-ger'));
  c := pg_temp.s75_try('authenticated', ger, pg_temp.s75_del(u1, 'ai_config'));
  v := pg_temp.s75_val(u1, 'ai_config');
  insert into t_res values (753, 'S3 gerente U1: upsert/update/delete de ai_config recusados com 42501, linha intacta',
    case when a = f and b = f and c = f and v = 'set75-inicial-ai_config' then 'PASSOU'
         else 'FALHOU ups=' || a || ' upd=' || b || ' del=' || c || ' valor=' || v end);
end $$;

-- ─── S4: gerente não atualiza nenhuma das 7 chaves de prompt ─────────────────
do $$
declare k text; r text; ruins text := '';
  u1 constant uuid := 'a0d75000-0000-4000-8000-0000000000aa';
  ger constant uuid := 'a0d75000-0000-4000-8000-0000000000a2';
begin
  foreach k in array array['agent_mode', 'agent_name', 'restaurant_menu', 'delivery_response',
                           'restaurant_extra_info', 'ai_system_prompt', 'ai_context_extra'] loop
    r := pg_temp.s75_try('authenticated', ger, pg_temp.s75_upd(u1, k, 's75-ger'));
    if r <> '42501:setting_write_forbidden' or pg_temp.s75_val(u1, k) <> 'set75-inicial-' || k then
      ruins := ruins || ' ' || k || '=' || r || '/' || pg_temp.s75_val(u1, k);
    end if;
  end loop;
  insert into t_res values (754, 'S4 gerente U1: UPDATE de cada uma das 7 chaves de prompt recusado, valores intactos',
    case when ruins = '' then 'PASSOU' else 'FALHOU' || ruins end);
end $$;

-- ─── S5: chave desconhecida é platform (fail-closed) ─────────────────────────
do $$
declare a text; v text;
  u1 constant uuid := 'a0d75000-0000-4000-8000-0000000000aa';
  ger constant uuid := 'a0d75000-0000-4000-8000-0000000000a2';
begin
  a := pg_temp.s75_try('authenticated', ger, pg_temp.s75_ups(u1, 'foo_bar', 's75-ger'));
  v := pg_temp.s75_val(u1, 'foo_bar');
  insert into t_res values (755, 'S5 gerente U1: chave desconhecida foo_bar recusada (fail-closed), nada gravado',
    case when a = '42501:setting_write_forbidden' and v = '<ausente>' then 'PASSOU'
         else 'FALHOU a=' || a || ' valor=' || v end);
end $$;

-- ─── S6: trocar a key num UPDATE, nos dois sentidos ──────────────────────────
-- a/b: manager -> platform (recusa pelo escopo NEW). ai_config já existe em U1:
-- sem o trigger, o UNIQUE daria 23505; a mensagem do guard prova que a recusa
-- vem antes. c: platform -> manager (ai_config -> additional_info, que ainda
-- não existe em U1): o NEW passa, só o escopo OLD recusa. Sem ele, o gerente
-- "apagaria" ai_config renomeando a linha (CONTROLE-SET-1 parte 2 mede).
do $$
declare a text; b text; c text; v text;
  u1 constant uuid := 'a0d75000-0000-4000-8000-0000000000aa';
  ger constant uuid := 'a0d75000-0000-4000-8000-0000000000a2';
  f constant text := '42501:setting_write_forbidden';
begin
  a := pg_temp.s75_try('authenticated', ger,
    format('update public.settings set key = %L where unit_id = %L and key = %L', 'ai_config', u1, 'booking_window_days'));
  b := pg_temp.s75_try('authenticated', ger,
    format('update public.settings set key = %L where unit_id = %L and key = %L', 'ai_new_key', u1, 'booking_window_days'));
  c := pg_temp.s75_try('authenticated', ger,
    format('update public.settings set key = %L where unit_id = %L and key = %L', 'additional_info', u1, 'ai_config'));
  v := pg_temp.s75_val(u1, 'booking_window_days') || '|' || pg_temp.s75_val(u1, 'ai_new_key')
       || '|' || pg_temp.s75_val(u1, 'ai_config') || '|' || pg_temp.s75_val(u1, 'additional_info');
  insert into t_res values (756, 'S6 gerente U1: UPDATE de key booking_window_days -> ai_config/ai_new_key (NEW) e ai_config -> additional_info (OLD) recusados',
    case when a = f and b = f and c = f
          and v = 'set75-inicial-booking_window_days|<ausente>|set75-inicial-ai_config|<ausente>' then 'PASSOU'
         else 'FALHOU a=' || a || ' b=' || b || ' c=' || c || ' valores=' || v end);
end $$;

-- ─── S7: mover unit_id para outra unidade ────────────────────────────────────
-- a: gerente U1 sem papel em U2 (NEW recusa). b: DUAL, operador em U1 e
-- gerente em U2: o NEW (U2) e a RLS (membro de U1) passam, só o escopo OLD
-- recusa (CONTROLE-SET-1 parte 2 mede).
do $$
declare a text; b text; v text;
  u1 constant uuid := 'a0d75000-0000-4000-8000-0000000000aa';
  u2 constant uuid := 'a0d75000-0000-4000-8000-0000000000bb';
  ger constant uuid := 'a0d75000-0000-4000-8000-0000000000a2';
  dual constant uuid := 'a0d75000-0000-4000-8000-0000000000a4';
  f constant text := '42501:setting_write_forbidden';
begin
  a := pg_temp.s75_try('authenticated', ger,
    format('update public.settings set unit_id = %L where unit_id = %L and key = %L', u2, u1, 'booking_window_days'));
  b := pg_temp.s75_try('authenticated', dual,
    format('update public.settings set unit_id = %L where unit_id = %L and key = %L', u2, u1, 'booking_window_days'));
  v := pg_temp.s75_val(u1, 'booking_window_days') || '|' || pg_temp.s75_val(u2, 'booking_window_days');
  insert into t_res values (757, 'S7 UPDATE que move booking_window_days de U1 para U2 recusado: gerente U1 sem papel em U2 (NEW) e operador U1 + gerente U2 (OLD)',
    case when a = f and b = f and v = 'set75-inicial-booking_window_days|<ausente>' then 'PASSOU'
         else 'FALHOU gerente=' || a || ' dual=' || b || ' valores=' || v end);
end $$;

-- ─── S8: owner e gerente gravam TODAS as 22 chaves manager ───────────────────
-- Lista literal independente do classificador: se a migration perder uma chave,
-- este caso falha. Para cada chave: upsert (INSERT ou ON CONFLICT UPDATE),
-- UPDATE simples e conferência do valor; no fim, DELETE de restaurant_name.
create or replace function pg_temp.s75_manager_roundtrip(p_actor uuid, p_tag text)
returns text language plpgsql as $$
declare k text; r1 text; r2 text; rd text; ruins text := '';
  u1 constant uuid := 'a0d75000-0000-4000-8000-0000000000aa';
begin
  foreach k in array array[
    'reservation_duration_minutes', 'booking_window_days', 'reservation_tolerance_minutes',
    'rules_and_conditions', 'additional_info', 'reminder_d1_enabled', 'survey_d1_enabled',
    'waitlist_qr_enabled', 'waitlist_menu_link_enabled', 'waitlist_priority_enabled',
    'waitlist_code_min', 'waitlist_code_max', 'waitlist_tolerance_minutes',
    'waitlist_remote_entry_enabled', 'waitlist_remote_entry_limit',
    'waitlist_entered_enabled', 'waitlist_feedback_enabled',
    'giftback_whatsapp_enabled', 'giftback_email_enabled', 'giftback_message_template',
    'allow_overbooking', 'restaurant_name'] loop
    r1 := pg_temp.s75_try('authenticated', p_actor, pg_temp.s75_ups(u1, k, p_tag || '-1-' || k));
    r2 := pg_temp.s75_try('authenticated', p_actor, pg_temp.s75_upd(u1, k, p_tag || '-2-' || k));
    if r1 <> 'ok' or r2 <> 'ok' or pg_temp.s75_val(u1, k) <> p_tag || '-2-' || k then
      ruins := ruins || ' ' || k || '=' || r1 || '/' || r2 || '/' || pg_temp.s75_val(u1, k);
    end if;
  end loop;
  rd := pg_temp.s75_try('authenticated', p_actor, pg_temp.s75_del(u1, 'restaurant_name'));
  if rd <> 'ok' or pg_temp.s75_val(u1, 'restaurant_name') <> '<ausente>' then
    ruins := ruins || ' delete restaurant_name=' || rd || '/' || pg_temp.s75_val(u1, 'restaurant_name');
  end if;
  return ruins;
end $$;

do $$
declare r text;
begin
  r := pg_temp.s75_manager_roundtrip('a0d75000-0000-4000-8000-0000000000a1', 's75-owner');
  insert into t_res values (758, 'S8 owner U1: upsert + UPDATE das 22 chaves manager gravados, DELETE de restaurant_name ok',
    case when r = '' then 'PASSOU' else 'FALHOU' || r end);
end $$;

do $$
declare r text;
begin
  r := pg_temp.s75_manager_roundtrip('a0d75000-0000-4000-8000-0000000000a2', 's75-ger');
  insert into t_res values (759, 'S8 gerente U1: upsert + UPDATE das 22 chaves manager gravados, DELETE de restaurant_name ok',
    case when r = '' then 'PASSOU' else 'FALHOU' || r end);
end $$;

-- ─── S9: platform_admin sem membership grava ai_config e prompt ──────────────
-- `agent_mode` recebe um valor do enum: desde a migration 20261020150000 o
-- guard de valor recusa outro valor para todo papel (pré-voo 78, V4).
do $$
declare k text; r text; v text; ruins text := '';
  u1 constant uuid := 'a0d75000-0000-4000-8000-0000000000aa';
  pa constant uuid := 'a0d75000-0000-4000-8000-0000000000c1';
begin
  foreach k in array array['ai_config', 'agent_mode', 'agent_name', 'restaurant_menu',
                           'delivery_response', 'restaurant_extra_info', 'ai_system_prompt',
                           'ai_context_extra', 'foo_bar'] loop
    v := case k when 'agent_mode' then 'reservations_faq' else 's75-pa-' || k end;
    r := pg_temp.s75_try('authenticated', pa, pg_temp.s75_ups(u1, k, v));
    if r <> 'ok' or pg_temp.s75_val(u1, k) <> v then
      ruins := ruins || ' ' || k || '=' || r || '/' || pg_temp.s75_val(u1, k);
    end if;
  end loop;
  r := pg_temp.s75_try('authenticated', pa, pg_temp.s75_del(u1, 'foo_bar'));
  if r <> 'ok' or pg_temp.s75_val(u1, 'foo_bar') <> '<ausente>' then
    ruins := ruins || ' delete foo_bar=' || r;
  end if;
  insert into t_res values (760, 'S9 platform_admin sem membership: upsert de ai_config, 7 chaves de prompt e chave desconhecida; DELETE ok',
    case when ruins = '' then 'PASSOU' else 'FALHOU' || ruins end);
end $$;

-- ─── S10: service_role passa ─────────────────────────────────────────────────
do $$
declare a text; v text;
  u1 constant uuid := 'a0d75000-0000-4000-8000-0000000000aa';
begin
  a := pg_temp.s75_try('service_role', null, pg_temp.s75_ups(u1, 'ai_config', 's75-sr'));
  v := pg_temp.s75_val(u1, 'ai_config');
  insert into t_res values (761, 'S10 service_role (claims role=service_role): upsert de ai_config gravado',
    case when a = 'ok' and v = 's75-sr' then 'PASSOU' else 'FALHOU a=' || a || ' valor=' || v end);
end $$;

-- ─── S11: sem claims (postgres, migration/cron) passa ────────────────────────
do $$
declare a text; v text;
  u1 constant uuid := 'a0d75000-0000-4000-8000-0000000000aa';
begin
  a := pg_temp.s75_try(null, null, pg_temp.s75_ups(u1, 'ai_config', 's75-pg'));
  v := pg_temp.s75_val(u1, 'ai_config');
  insert into t_res values (762, 'S11 sem claims (postgres, como db push/cron): upsert de ai_config gravado',
    case when a = 'ok' and v = 's75-pg' then 'PASSOU' else 'FALHOU a=' || a || ' valor=' || v end);
end $$;

-- ─── S12: anon recusado pela ACL e, com grant, pelo próprio trigger ──────────
-- Sem grant (estado pós-migration) a recusa é da ACL. No subbloco o grant de
-- INSERT volta (desfeito pelo raise) e a recusa tem de vir do trigger, ANTES da
-- RLS (anon não tem policy), pela mensagem.
do $$
declare a text; b text := '<nao rodou>'; v text;
  u2 constant uuid := 'a0d75000-0000-4000-8000-0000000000bb';
begin
  -- U2 não tem linha nenhuma (o S8 só grava em U1): ausente = nada gravado.
  a := pg_temp.s75_try('anon', null, pg_temp.s75_ups(u2, 'reminder_d1_enabled', 's75-anon'));
  begin
    grant insert on table public.settings to anon;
    b := pg_temp.s75_try('anon', null,
      format('insert into public.settings (unit_id, key, value) values (%L, %L, %L::jsonb)',
             u2, 'reminder_d1_enabled', '"s75-anon"'));
    raise exception 'desfazer grant';
  exception when raise_exception then null;
  end;
  v := pg_temp.s75_val(u2, 'reminder_d1_enabled');
  insert into t_res values (763, 'S12 anon: INSERT recusado pela ACL (42501) e, com grant temporario, pelo trigger (setting_write_forbidden)',
    case when a like '42501:permission denied%' and b = '42501:setting_write_forbidden' and v = '<ausente>'
           and not has_table_privilege('anon', 'public.settings', 'INSERT') then 'PASSOU'
         else 'FALHOU sem_grant=' || a || ' com_grant=' || b || ' valor=' || v end);
end $$;

-- ─── S13: os dois guards convivem em giftback_message_template ───────────────
do $$
declare a text; v text;
  u1 constant uuid := 'a0d75000-0000-4000-8000-0000000000aa';
  ger constant uuid := 'a0d75000-0000-4000-8000-0000000000a2';
begin
  a := pg_temp.s75_try('authenticated', ger, pg_temp.s75_ups(u1, 'giftback_message_template', 's75-gb'));
  v := pg_temp.s75_val(u1, 'giftback_message_template');
  insert into t_res values (764, 'S13 gerente U1 com canal nao oficial: giftback_message_template gravado (settings_write_role_guard e whatsapp_legacy_template_write passam)',
    case when a = 'ok' and v = 's75-gb' then 'PASSOU' else 'FALHOU a=' || a || ' valor=' || v end);
end $$;

-- ─── S14: ACL e forma das duas funções ───────────────────────────────────────
do $$
declare r text; ruins text := ''; v_n int;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(r, 'app_private.unit_setting_write_class(text)', 'EXECUTE') then
      ruins := ruins || ' classe:' || r; end if;
    if has_function_privilege(r, 'app_private.guard_unit_setting_write()', 'EXECUTE') then
      ruins := ruins || ' guard:' || r; end if;
  end loop;
  -- proacl nulo = grant implícito a PUBLIC; depois do revoke sobra só o dono.
  if exists (select 1 from pg_proc
              where oid in ('app_private.unit_setting_write_class(text)'::regprocedure,
                            'app_private.guard_unit_setting_write()'::regprocedure)
                and proacl::text is distinct from '{postgres=X/postgres}') then
    ruins := ruins || ' proacl_aberta';
  end if;
  if not exists (select 1 from pg_proc where oid = 'app_private.guard_unit_setting_write()'::regprocedure
                  and prosecdef and proconfig = array['search_path=""']) then
    ruins := ruins || ' guard_sem_definer_ou_search_path'; end if;
  if not exists (select 1 from pg_proc where oid = 'app_private.unit_setting_write_class(text)'::regprocedure
                  and provolatile = 'i' and proconfig = array['search_path=""']) then
    ruins := ruins || ' classe_nao_immutable_ou_search_path'; end if;
  -- Classificador: manager só na lista; desconhecida, platform e NULL caem em platform.
  if app_private.unit_setting_write_class('booking_window_days') <> 'manager'
     or app_private.unit_setting_write_class('restaurant_name') <> 'manager'
     or app_private.unit_setting_write_class('ai_config') <> 'platform'
     or app_private.unit_setting_write_class('ai_system_prompt') <> 'platform'
     or app_private.unit_setting_write_class('foo_bar') <> 'platform'
     or app_private.unit_setting_write_class(null) is distinct from 'platform' then
    ruins := ruins || ' classificador';
  end if;
  select count(*) into v_n from unnest(array[
    'reservation_duration_minutes', 'booking_window_days', 'reservation_tolerance_minutes',
    'rules_and_conditions', 'additional_info', 'reminder_d1_enabled', 'survey_d1_enabled',
    'waitlist_qr_enabled', 'waitlist_menu_link_enabled', 'waitlist_priority_enabled',
    'waitlist_code_min', 'waitlist_code_max', 'waitlist_tolerance_minutes',
    'waitlist_remote_entry_enabled', 'waitlist_remote_entry_limit',
    'waitlist_entered_enabled', 'waitlist_feedback_enabled',
    'giftback_whatsapp_enabled', 'giftback_email_enabled', 'giftback_message_template',
    'allow_overbooking', 'restaurant_name']) k
   where app_private.unit_setting_write_class(k) = 'manager';
  if v_n <> 22 then ruins := ruins || ' manager=' || v_n; end if;
  insert into t_res values (765, 'S14 funcoes sem EXECUTE para anon/authenticated/service_role, proacl so do dono; guard SECURITY DEFINER search_path vazio; classificador 22 manager e fail-closed',
    case when ruins = '' then 'PASSOU' else 'FALHOU' || ruins end);
end $$;

-- ─── S15: migration reaplicada = um trigger só, guard legado e policies intactos
-- tgtype 31 = ROW(1) + BEFORE(2) + INSERT(4) + DELETE(8) + UPDATE(16).
do $$
declare v_n int; v_ok int; v_leg int; v_pol text;
begin
  select count(*),
         count(*) filter (where tgfoid = 'app_private.guard_unit_setting_write()'::regprocedure
                            and tgtype = 31 and tgenabled = 'O')
    into v_n, v_ok from pg_trigger
   where tgrelid = 'public.settings'::regclass and tgname = 'settings_write_role_guard';
  select count(*) into v_leg from pg_trigger
   where tgrelid = 'public.settings'::regclass and tgname = 'whatsapp_legacy_template_write';
  select string_agg(policyname || '=' || cmd || ':' || qual || ':' || with_check, ' ; ' order by policyname)
    into v_pol from pg_policies where schemaname = 'public' and tablename = 'settings';
  insert into t_res values (766, 'S15 migration reaplicada: um unico settings_write_role_guard BEFORE INSERT/UPDATE/DELETE por linha, habilitado, guard legado presente, as duas policies sem mudanca',
    case when v_n = 1 and v_ok = 1 and v_leg = 1
          and v_pol = 'platform_admin_all_settings=ALL:app_private.is_platform_admin(auth.uid()):app_private.is_platform_admin(auth.uid())'
                   || ' ; unit_member_all_settings=ALL:app_private.is_unit_member(auth.uid(), unit_id):app_private.is_unit_member(auth.uid(), unit_id)'
         then 'PASSOU'
         else 'FALHOU n=' || v_n || ' forma_ok=' || v_ok || ' legado=' || v_leg || ' policies=' || coalesce(v_pol, '<null>') end);
end $$;

-- ─── S16: grants da tabela ───────────────────────────────────────────────────
do $$
declare ruins text := ''; p text;
begin
  foreach p in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] loop
    if has_table_privilege('anon', 'public.settings', p) then ruins := ruins || ' anon:' || p; end if;
  end loop;
  if has_any_column_privilege('anon', 'public.settings', 'INSERT')
     or has_any_column_privilege('anon', 'public.settings', 'UPDATE') then
    ruins := ruins || ' anon:coluna';
  end if;
  if has_table_privilege('authenticated', 'public.settings', 'TRUNCATE') then ruins := ruins || ' authenticated:TRUNCATE'; end if;
  -- Sem regressão: a Gestão continua gravando como authenticated e as EFs como service_role.
  foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
    if not has_table_privilege('authenticated', 'public.settings', p) then ruins := ruins || ' authenticated_perdeu:' || p; end if;
    if not has_table_privilege('service_role', 'public.settings', p) then ruins := ruins || ' service_role_perdeu:' || p; end if;
  end loop;
  insert into t_res values (767, 'S16 anon sem INSERT/UPDATE/DELETE/TRUNCATE (tabela e coluna), authenticated sem TRUNCATE; authenticated e service_role mantem SELECT/INSERT/UPDATE/DELETE',
    case when ruins = '' then 'PASSOU' else 'FALHOU' || ruins end);
end $$;

-- ─── EXTRA-1: authenticated sem sub, e papel authenticated sem claims ────────
-- a: claims com role=authenticated e sem sub (ramo `auth.uid() is null`).
-- b: papel de banco `authenticated` sem claims nenhuma (ramo `auth.role()`
-- nulo com `role` GUC de API). Nos dois a RLS sozinha também recusaria, com
-- outra mensagem; `setting_write_forbidden` prova que o guard recusa antes
-- (CONTROLE-SET-1 parte 3 mede o b sem esse ramo).
create or replace function pg_temp.s75_try_db_role_no_claims(p_db_role text, p_sql text)
returns text language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  begin
    execute format('set local role %I', p_db_role);
    execute p_sql;
    reset role;
    return 'ok';
  exception when others then
    reset role;
    return sqlstate || ':' || sqlerrm;
  end;
end $$;

do $$
declare a text; b text; v text;
  u2 constant uuid := 'a0d75000-0000-4000-8000-0000000000bb';
begin
  a := pg_temp.s75_try('authenticated', null, pg_temp.s75_ups(u2, 'reminder_d1_enabled', 's75-nosub'));
  b := pg_temp.s75_try_db_role_no_claims('authenticated', pg_temp.s75_ups(u2, 'reminder_d1_enabled', 's75-noclaims'));
  v := pg_temp.s75_val(u2, 'reminder_d1_enabled');
  insert into t_res values (768, 'EXTRA-1 authenticated sem sub e papel authenticated sem claims: upsert recusado pelo guard (setting_write_forbidden)',
    case when a = '42501:setting_write_forbidden' and b = '42501:setting_write_forbidden' and v = '<ausente>' then 'PASSOU'
         else 'FALHOU sem_sub=' || a || ' sem_claims=' || b || ' valor=' || v end);
end $$;

-- ─── EXTRA-2: membro de outra unidade continua vendo zero linhas ─────────────
-- Em UPDATE/DELETE o guard só dispara em linha que passou pelo USING da RLS:
-- UPDATE/DELETE de U1 por um gerente de U2 casam zero linhas sem erro, como
-- antes. Em INSERT o BEFORE roda antes do WITH CHECK, então o upsert recebe a
-- recusa do guard; ela tem de ser a MESMA para U1 (existe, alheia) e para uma
-- unidade inexistente, ou a resposta viraria oráculo de existência.
do $$
declare a text; b text; c text; d text; v0 text; v text;
  u1 constant uuid := 'a0d75000-0000-4000-8000-0000000000aa';
  ghost constant uuid := 'a0d75000-0000-4000-8000-0000000000ff';
  ger2 constant uuid := 'a0d75000-0000-4000-8000-0000000000b2';
begin
  v0 := pg_temp.s75_val(u1, 'booking_window_days');
  a := pg_temp.s75_try('authenticated', ger2, pg_temp.s75_upd(u1, 'booking_window_days', 's75-ger2'));
  b := pg_temp.s75_try('authenticated', ger2, pg_temp.s75_del(u1, 'booking_window_days'));
  c := pg_temp.s75_try('authenticated', ger2, pg_temp.s75_ups(u1, 'booking_window_days', 's75-ger2'));
  d := pg_temp.s75_try('authenticated', ger2, pg_temp.s75_ups(ghost, 'booking_window_days', 's75-ger2'));
  v := pg_temp.s75_val(u1, 'booking_window_days');
  insert into t_res values (769, 'EXTRA-2 gerente U2: UPDATE/DELETE em U1 casam zero linhas sem erro (RLS); upsert em U1 e em unidade inexistente recebem a mesma recusa; valor intacto',
    case when a = 'ok' and b = 'ok' and c = '42501:setting_write_forbidden' and d = c
          and v0 <> '<ausente>' and v = v0 then 'PASSOU'
         else 'FALHOU upd=' || a || ' del=' || b || ' ups_u1=' || c || ' ups_inexistente=' || d
              || ' antes=' || v0 || ' depois=' || v end);
end $$;

-- ─── CONTROLE-SET-1: os testes enxergam o defeito ────────────────────────────
-- Três partes, cada uma num subbloco desfeito por raise (DDL é transacional):
--   1. sem o trigger, o operador grava ai_config (controle de S1);
--   2. com o guard mutado para conferir OLD só no DELETE, os casos S6c e S7b
--      passam (controle do escopo OLD no UPDATE). Aqui o S6c renomeia para
--      restaurant_name: a única chave manager ausente em U1 neste ponto (o S8
--      grava as 22 e apaga essa), senão o UNIQUE recusaria pelo motivo errado;
--   3. com o guard mutado sem o ramo do `role` GUC, o papel authenticated sem
--      claims chega à RLS e a mensagem muda (controle do EXTRA-1b).
-- As mutações partem do corpo instalado (pg_get_functiondef + replace) e
-- falham se o trecho não existir. Depois, o guard real volta e recusa.
do $$
declare
  u1 constant uuid := 'a0d75000-0000-4000-8000-0000000000aa';
  u2 constant uuid := 'a0d75000-0000-4000-8000-0000000000bb';
  op constant uuid := 'a0d75000-0000-4000-8000-0000000000a3';
  ger constant uuid := 'a0d75000-0000-4000-8000-0000000000a2';
  dual constant uuid := 'a0d75000-0000-4000-8000-0000000000a4';
  f constant text := '42501:setting_write_forbidden';
  v_def text; v_mut text;
  v0 text; p1 text := '<nao rodou>'; p1v text := '<nao rodou>';
  p2a text := '<nao rodou>'; p2b text := '<nao rodou>'; p3 text := '<nao rodou>';
  d1 text; d2a text; d2b text; d3 text; v_depois text; v_trg int;
begin
  v0 := pg_temp.s75_val(u1, 'ai_config');
  if pg_temp.s75_val(u1, 'restaurant_name') <> '<ausente>' then
    raise exception 'CONTROLE-SET-1: restaurant_name deveria estar ausente em U1 (S8 apaga)';
  end if;
  v_def := pg_get_functiondef('app_private.guard_unit_setting_write()'::regprocedure);

  begin
    drop trigger settings_write_role_guard on public.settings;
    p1 := pg_temp.s75_try('authenticated', op, pg_temp.s75_ups(u1, 'ai_config', 's75-ctrl'));
    p1v := pg_temp.s75_val(u1, 'ai_config');
    raise exception 'desfazer controle';
  exception when raise_exception then null;
  end;

  begin
    v_mut := replace(v_def, 'if tg_op in (''UPDATE'', ''DELETE'') and (', 'if tg_op = ''DELETE'' and (');
    if v_mut = v_def then raise exception 'CONTROLE-SET-1: trecho do escopo OLD nao encontrado'; end if;
    execute v_mut;
    p2a := pg_temp.s75_try('authenticated', ger,
      format('update public.settings set key = %L where unit_id = %L and key = %L', 'restaurant_name', u1, 'ai_config'));
    p2b := pg_temp.s75_try('authenticated', dual,
      format('update public.settings set unit_id = %L where unit_id = %L and key = %L', u2, u1, 'booking_window_days'));
    raise exception 'desfazer controle';
  exception when raise_exception then null;
  end;

  begin
    v_mut := replace(v_def, 'if pg_catalog.current_setting(''role'', true) in (''anon'', ''authenticated'') then', 'if false then');
    if v_mut = v_def then raise exception 'CONTROLE-SET-1: trecho do role GUC nao encontrado'; end if;
    execute v_mut;
    p3 := pg_temp.s75_try_db_role_no_claims('authenticated', pg_temp.s75_ups(u2, 'reminder_d1_enabled', 's75-ctrl'));
    raise exception 'desfazer controle';
  exception when raise_exception then null;
  end;

  d1 := pg_temp.s75_try('authenticated', op, pg_temp.s75_ups(u1, 'ai_config', 's75-ctrl'));
  d2a := pg_temp.s75_try('authenticated', ger,
    format('update public.settings set key = %L where unit_id = %L and key = %L', 'restaurant_name', u1, 'ai_config'));
  d2b := pg_temp.s75_try('authenticated', dual,
    format('update public.settings set unit_id = %L where unit_id = %L and key = %L', u2, u1, 'booking_window_days'));
  d3 := pg_temp.s75_try_db_role_no_claims('authenticated', pg_temp.s75_ups(u2, 'reminder_d1_enabled', 's75-ctrl'));
  v_depois := pg_temp.s75_val(u1, 'ai_config');
  select count(*) into v_trg from pg_trigger
   where tgrelid = 'public.settings'::regclass and tgname = 'settings_write_role_guard';
  insert into t_res values (770, 'CONTROLE-SET-1 sem trigger o operador grava ai_config; guard sem OLD no UPDATE deixa S6c/S7b passar; guard sem ramo do role GUC muda a recusa do EXTRA-1b; guard real de volta recusa os tres',
    case when p1 = 'ok' and p1v = 's75-ctrl'
          and p2a = 'ok' and p2b = 'ok'
          and p3 like '42501:new row violates row-level security policy%'
          and d1 = f and d2a = f and d2b = f and d3 = f
          and v_depois = v0 and v_trg = 1 then 'PASSOU'
         else 'FALHOU p1=' || p1 || '/' || p1v || ' p2a=' || p2a || ' p2b=' || p2b || ' p3=' || p3
              || ' d1=' || d1 || ' d2a=' || d2a || ' d2b=' || d2b || ' d3=' || d3
              || ' ai_config=' || v0 || '->' || v_depois || ' triggers=' || v_trg end);
end $$;

select ord, caso, veredito from t_res where ord between 751 and 770 order by ord;
select count(*) as total, count(*) filter (where veredito = 'PASSOU') as passou
  from t_res where ord between 751 and 770;   -- esperado: 20 e 20
