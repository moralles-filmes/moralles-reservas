-- S1..S9 e C1 (ordinais 8501-8510): migration
-- 20261106140000_seat_choice_enabled_setting.sql contra Postgres real.
--
-- BASE: a mesma do 80 (00 -> 01 -> 09a -> 106 -> 75a -> 20261019180000 -> 80a
-- -> 20261029120100), ver README §85. Atores e unidades do 80a (a0d78000-…).
-- RED: sem a migration, a guarda abaixo aborta. GREEN: o arquivo reaplica a
-- migration por `\i` (desfaz o que o 75/80 tenham recolocado), mede, e no fim
-- reaplica de novo para a idempotência. Roda da RAIZ DO REPO; pode repetir.

create table if not exists t_res (ord int primary key, caso text, veredito text);
delete from t_res where ord between 8501 and 8510;

do $$
begin
  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.settings'::regclass
                    and tgname = 'settings_write_value_guard' and not tgisinternal) then
    raise exception '85: guard de valor ausente. Aplique a 20261029120100 antes.';
  end if;
  if app_private.unit_setting_write_class('seat_choice_enabled') <> 'manager' then
    raise exception '85: seat_choice_enabled fora da classe manager. Aplique a 20261106140000 antes (sem ela, este abort e o RED esperado).';
  end if;
  if not exists (select 1 from platform_admins where user_id = 'a0d78000-0000-4000-8000-0000000000c2') then
    raise exception '85 exige o 80a (atores ai78).';
  end if;
end $$;

\i supabase/migrations/20261106140000_seat_choice_enabled_setting.sql

set session_replication_role = replica;
delete from public.settings
 where unit_id in ('a0d78000-0000-4000-8000-0000000000aa', 'a0d78000-0000-4000-8000-0000000000bb')
   and key in ('seat_choice_enabled', 'booking_window_days');
set session_replication_role = origin;

create or replace function pg_temp.s85_try(p_role text, p_sub uuid, p_sql text)
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

create or replace function pg_temp.s85_ups(p_unit uuid, p_key text, p_json text)
returns text language sql as $$
  select format('insert into public.settings (unit_id, key, value) values (%L, %L, %L::jsonb) '
                'on conflict (unit_id, key) do update set value = excluded.value',
                p_unit, p_key, p_json)
$$;

create or replace function pg_temp.s85_val(p_unit uuid, p_key text)
returns text language sql as $$
  select coalesce((select value::text from public.settings where unit_id = p_unit and key = p_key),
                  '<ausente>')
$$;

-- ─── S1: gerente U1 liga e desliga ───────────────────────────────────────────
do $$
declare r1 text; r2 text; v1 text; v2 text;
  u1 uuid := 'a0d78000-0000-4000-8000-0000000000aa';
  ger uuid := 'a0d78000-0000-4000-8000-0000000000a2';
begin
  r1 := pg_temp.s85_try('authenticated', ger, pg_temp.s85_ups(u1, 'seat_choice_enabled', 'true'));
  v1 := pg_temp.s85_val(u1, 'seat_choice_enabled');
  r2 := pg_temp.s85_try('authenticated', ger, pg_temp.s85_ups(u1, 'seat_choice_enabled', 'false'));
  v2 := pg_temp.s85_val(u1, 'seat_choice_enabled');
  insert into t_res values (8501, 'S1 gerente U1 grava true e depois false',
    case when r1 = 'ok' and v1 = 'true' and r2 = 'ok' and v2 = 'false' then 'PASSOU'
         else format('FALHOU %s/%s %s/%s', r1, v1, r2, v2) end);
end $$;

-- ─── S2: owner U1 grava ──────────────────────────────────────────────────────
do $$
declare r text;
  u1 uuid := 'a0d78000-0000-4000-8000-0000000000aa';
  own uuid := 'a0d78000-0000-4000-8000-0000000000a1';
begin
  r := pg_temp.s85_try('authenticated', own, pg_temp.s85_ups(u1, 'seat_choice_enabled', 'true'));
  insert into t_res values (8502, 'S2 owner U1 grava true',
    case when r = 'ok' and pg_temp.s85_val(u1, 'seat_choice_enabled') = 'true' then 'PASSOU'
         else format('FALHOU %s/%s', r, pg_temp.s85_val(u1, 'seat_choice_enabled')) end);
end $$;

-- ─── S3: operador U1 (valor válido e inválido) recebe 42501 primeiro ─────────
do $$
declare r1 text; r2 text;
  u1 uuid := 'a0d78000-0000-4000-8000-0000000000aa';
  op uuid := 'a0d78000-0000-4000-8000-0000000000a3';
begin
  r1 := pg_temp.s85_try('authenticated', op, pg_temp.s85_ups(u1, 'seat_choice_enabled', 'false'));
  r2 := pg_temp.s85_try('authenticated', op, pg_temp.s85_ups(u1, 'seat_choice_enabled', '"x"'));
  insert into t_res values (8503, 'S3 operador U1: 42501 setting_write_forbidden com valor valido e invalido, valor intacto',
    case when r1 = '42501:setting_write_forbidden' and r2 = '42501:setting_write_forbidden'
              and pg_temp.s85_val(u1, 'seat_choice_enabled') = 'true' then 'PASSOU'
         else format('FALHOU %s | %s | %s', r1, r2, pg_temp.s85_val(u1, 'seat_choice_enabled')) end);
end $$;

-- ─── S4: gerente de U2 não grava em U1 ───────────────────────────────────────
do $$
declare r text;
  u1 uuid := 'a0d78000-0000-4000-8000-0000000000aa';
  gerb uuid := 'a0d78000-0000-4000-8000-0000000000b2';
begin
  r := pg_temp.s85_try('authenticated', gerb, pg_temp.s85_ups(u1, 'seat_choice_enabled', 'false'));
  insert into t_res values (8504, 'S4 gerente U2 em U1: 42501, valor intacto',
    case when r like '42501:%' and pg_temp.s85_val(u1, 'seat_choice_enabled') = 'true' then 'PASSOU'
         else format('FALHOU %s | %s', r, pg_temp.s85_val(u1, 'seat_choice_enabled')) end);
end $$;

-- ─── S5: valor não booleano recusado (gerente, service_role, postgres) ───────
do $$
declare r text; bad text; who text; falhas text := '';
  u1 uuid := 'a0d78000-0000-4000-8000-0000000000aa';
  ger uuid := 'a0d78000-0000-4000-8000-0000000000a2';
begin
  foreach who in array array['ger', 'svc', 'pg'] loop
    foreach bad in array array['"true"', '1', '0', 'null', '{}', '[]', '"sim"'] loop
      r := pg_temp.s85_try(case who when 'ger' then 'authenticated' when 'svc' then 'service_role' end,
                           case who when 'ger' then ger end,
                           pg_temp.s85_ups(u1, 'seat_choice_enabled', bad));
      if r <> '22023:setting_value_invalid' then falhas := falhas || format(' %s %s=%s', who, bad, r); end if;
    end loop;
  end loop;
  insert into t_res values (8505, 'S5 "true", 1, 0, null, objeto, array, "sim" como gerente, service_role e postgres: 22023 setting_value_invalid, valor intacto',
    case when falhas = '' and pg_temp.s85_val(u1, 'seat_choice_enabled') = 'true' then 'PASSOU'
         else 'FALHOU' || falhas || ' | ' || pg_temp.s85_val(u1, 'seat_choice_enabled') end);
end $$;

-- ─── S6: anon não grava ──────────────────────────────────────────────────────
do $$
declare r text;
  u2 uuid := 'a0d78000-0000-4000-8000-0000000000bb';
begin
  r := pg_temp.s85_try('anon', null, pg_temp.s85_ups(u2, 'seat_choice_enabled', 'true'));
  insert into t_res values (8506, 'S6 anon em U2: 42501, nada gravado',
    case when r like '42501:%' and pg_temp.s85_val(u2, 'seat_choice_enabled') = '<ausente>' then 'PASSOU'
         else format('FALHOU %s | %s', r, pg_temp.s85_val(u2, 'seat_choice_enabled')) end);
end $$;

-- ─── S7: as outras classes não mudaram ───────────────────────────────────────
do $$
declare r1 text; r2 text;
  u1 uuid := 'a0d78000-0000-4000-8000-0000000000aa';
  ger uuid := 'a0d78000-0000-4000-8000-0000000000a2';
begin
  r1 := pg_temp.s85_try('authenticated', ger, pg_temp.s85_ups(u1, 'booking_window_days', '30'));
  r2 := pg_temp.s85_try('authenticated', ger, pg_temp.s85_ups(u1, 'ai_system_prompt', '"x"'));
  insert into t_res values (8507, 'S7 gerente U1: booking_window_days segue manager (ok), ai_system_prompt segue platform (42501)',
    case when r1 = 'ok' and r2 = '42501:setting_write_forbidden' then 'PASSOU'
         else format('FALHOU %s | %s', r1, r2) end);
end $$;

-- ─── S8: ACL das duas funções recriadas ──────────────────────────────────────
insert into t_res
select 8508, 'S8 anon/authenticated/service_role sem EXECUTE em unit_setting_write_class e guard_unit_setting_value',
  case when not has_function_privilege('anon', 'app_private.unit_setting_write_class(text)', 'execute')
        and not has_function_privilege('authenticated', 'app_private.unit_setting_write_class(text)', 'execute')
        and not has_function_privilege('service_role', 'app_private.unit_setting_write_class(text)', 'execute')
        and not has_function_privilege('anon', 'app_private.guard_unit_setting_value()', 'execute')
        and not has_function_privilege('authenticated', 'app_private.guard_unit_setting_value()', 'execute')
        and not has_function_privilege('service_role', 'app_private.guard_unit_setting_value()', 'execute')
       then 'PASSOU' else 'FALHOU' end;

-- ─── C1: controle — classe e guard antigos (120100) ──────────────────────────
-- Sem a migration o gerente recebe 42501 e o postgres grava "sim": os casos
-- acima têm força. Depois a migration volta.
\i supabase/migrations/20261029120100_ai_global_prompt_and_settings_value_guard.sql
do $$
declare r1 text; r2 text;
  u2 uuid := 'a0d78000-0000-4000-8000-0000000000bb';
  gerb uuid := 'a0d78000-0000-4000-8000-0000000000b2';
begin
  r1 := pg_temp.s85_try('authenticated', gerb, pg_temp.s85_ups(u2, 'seat_choice_enabled', 'true'));
  r2 := pg_temp.s85_try(null, null, pg_temp.s85_ups(u2, 'seat_choice_enabled', '"sim"'));
  insert into t_res values (8509, 'C1 controle sem a migration: gerente U2 42501 e postgres grava "sim" (S1/S5 teriam falhado)',
    case when r1 = '42501:setting_write_forbidden' and r2 = 'ok' then 'PASSOU'
         else format('FALHOU %s | %s', r1, r2) end);
  set session_replication_role = replica;
  delete from public.settings where unit_id = u2 and key = 'seat_choice_enabled';
  set session_replication_role = origin;
end $$;

-- ─── S9: idempotência — reaplicada, o gerente U2 grava em U2 ─────────────────
\i supabase/migrations/20261106140000_seat_choice_enabled_setting.sql
\i supabase/migrations/20261106140000_seat_choice_enabled_setting.sql
do $$
declare r1 text; r2 text;
  u2 uuid := 'a0d78000-0000-4000-8000-0000000000bb';
  gerb uuid := 'a0d78000-0000-4000-8000-0000000000b2';
begin
  r1 := pg_temp.s85_try('authenticated', gerb, pg_temp.s85_ups(u2, 'seat_choice_enabled', 'true'));
  r2 := pg_temp.s85_try('authenticated', gerb, pg_temp.s85_ups(u2, 'seat_choice_enabled', '"sim"'));
  insert into t_res values (8510, 'S9 migration reaplicada 2x: gerente U2 grava true em U2 e "sim" volta a 22023',
    case when r1 = 'ok' and r2 = '22023:setting_value_invalid'
              and pg_temp.s85_val(u2, 'seat_choice_enabled') = 'true' then 'PASSOU'
         else format('FALHOU %s | %s', r1, r2) end);
end $$;

select ord, caso, veredito from t_res where ord between 8501 and 8510 order by ord;
select count(*) filter (where veredito = 'PASSOU') as passou, count(*) as total
  from t_res where ord between 8501 and 8510;
