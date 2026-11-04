-- 82: endurecimento da planta — escrita de layout só para gestor (H-1…H-11,
-- H-13), mesa presa à unidade do salão (H-7, H-8) e retorno de
-- set_reservation_presence (H-12). Controles positivos H-CP1…H-CP3.
--
-- Base: 81a + migrations 20261030120000/120100 + 82a, no contêiner exclusivo
-- (README §82). Roda como `postgres`. Mesmo motor do 81: cada caso roda num
-- subbloco SEMPRE desfeito (sentinela `P8282`), troca papel e claims por
-- `set_config` como o PostgREST e confere SQLSTATE, mensagem e efeito.
-- Termina com erro se algum caso diverge; a transação é desfeita.
\set ON_ERROR_STOP on
begin;

do $$ begin
  if to_regclass('public.hall_schedules') is null then
    raise exception '82: rode o 81a, as migrations de 20261030 e o 82a antes';
  end if;
end $$;

create temp table t_ids (token text primary key, id text not null);
insert into t_ids values
  ('A', 'aa'), ('B', 'bb'), ('OWN', 'a1'), ('GER', 'a2'), ('OPE', 'a3'), ('GERB', 'b2'),
  ('OUT', 'e1'), ('PA', 'c1'), ('S1', '01'), ('S2', '02'), ('SB', '03'),
  ('T11', '11'), ('T12', '12'), ('T13', '13'), ('T21', '21'), ('TB1', '31'),
  ('H1', '401'), ('H2', '402'), ('HB', '4b1'), ('R1', '101'), ('R2', '102');
update t_ids set id = 'a0d81000-0000-4000-8000-' || lpad(id, 12, '0');

-- Datas das reservas em BRT (desfeito no ROLLBACK final).
update public.reservations r set date = (now() at time zone 'America/Sao_Paulo')::date
 where r.id in ('a0d81000-0000-4000-8000-000000000101', 'a0d81000-0000-4000-8000-000000000102');

create temp table t_res (ord int primary key, caso text not null, esperado text not null, veredito text not null);

create function pg_temp.sub(p text) returns text language plpgsql as $f$
declare r record;
begin
  for r in select token, id from t_ids loop
    p := replace(p, '{' || r.token || '}', r.id);
  end loop;
  return p;
end $f$;


-- p_actor: token de usuário (vira claims de `authenticated`), 'anon',
-- 'service_role' ou 'postgres' (sem troca de papel nem claims).
create function pg_temp.caso(p_ord int, p_caso text, p_actor text, p_sql text,
                             p_expect text, p_check text default null)
returns void language plpgsql as $f$
declare v_ret text; v_ok boolean; v_actual text; v_sql text := pg_temp.sub(p_sql);
        v_check text := pg_temp.sub(p_check); v_claims text; v_detail text;
begin
  if p_actor not in ('anon', 'service_role', 'postgres') then
    select json_build_object('sub', id, 'role', 'authenticated')::text into strict v_claims
      from t_ids where token = p_actor;
  end if;
  begin
    if p_actor = 'anon' then
      perform set_config('role', 'anon', true);
      perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    elsif p_actor = 'service_role' then
      perform set_config('role', 'service_role', true);
      perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
    elsif p_actor <> 'postgres' then
      perform set_config('role', 'authenticated', true);
      perform set_config('request.jwt.claims', v_claims, true);
    end if;
    execute v_sql into v_ret;
    perform set_config('role', 'postgres', true);
    perform set_config('request.jwt.claims', '', true);
    v_actual := 'ok';
    if v_check is not null then
      execute 'select (' || v_check || ')' into v_ok using v_ret;
      if v_ok is not true then v_actual := 'check_failed ret=' || coalesce(v_ret, 'null'); end if;
    end if;
    raise exception using errcode = 'P8282';
  exception
    when sqlstate 'P8282' then null;
    when others then
      get stacked diagnostics v_detail = pg_exception_detail;
      v_actual := sqlstate || ' ' || sqlerrm || coalesce(' [' || nullif(v_detail, '') || ']', '');
  end;
  insert into t_res values (p_ord, p_caso, p_expect, v_actual);
end $f$;

-- Payload de planta válido para S1: T11 redonda, T12 retangular, T13 fora da planta.
create function pg_temp.plano_s1() returns text language sql as $f$
  select $j$'{"width_cm":800,"depth_cm":600,"entrance_wall":"bottom","entrance_offset_cm":100,"window_walls":["top","left"]}'::jsonb,
  '[{"id":"{T11}","x":150,"y":150,"w":80,"h":80,"rotation":0,"shape":"round"},
    {"id":"{T12}","x":400,"y":300,"w":120,"h":80,"rotation":90,"shape":"rect"},
    {"id":"{T13}","x":null,"y":null,"w":null,"h":null,"rotation":null,"shape":null}]'::jsonb$j$
$f$;
create function pg_temp.como(p_tok text) returns text language sql as $f$
  select format($q$select set_config('role', 'authenticated', true),
    set_config('request.jwt.claims', '{"sub":"{%s}","role":"authenticated"}', true);$q$, p_tok)
$f$;

\o /dev/null
-- ═══ H-1…H-3 — operador não escreve layout ══════════════════════════════════
select pg_temp.caso(8401, 'H-1a operador cria mesa', 'OPE',
  $s$insert into public.tables (number, capacity, unit_id, hall_id, min_capacity, max_capacity)
     values (99, 2, '{A}', '{S1}', 1, 2); select 'x'$s$, '42501 layout_write_forbidden');
select pg_temp.caso(8402, 'H-1b operador muda capacidade', 'OPE',
  $s$update public.tables set max_capacity=8 where id='{T11}'; select 'x'$s$, '42501 layout_write_forbidden');
select pg_temp.caso(8403, 'H-1c operador desativa mesa', 'OPE',
  $s$update public.tables set active=false where id='{T11}'; select 'x'$s$, '42501 layout_write_forbidden');
select pg_temp.caso(8404, 'H-1d operador troca o salão da mesa (mesma unidade)', 'OPE',
  $s$update public.tables set hall_id='{S2}' where id='{T11}'; select 'x'$s$, '42501 layout_write_forbidden');
select pg_temp.caso(8405, 'H-1e operador apaga mesa', 'OPE',
  $s$delete from public.tables where id='{T13}'; select 'x'$s$, '42501 layout_write_forbidden');
select pg_temp.caso(8406, 'H-2a operador cria salão', 'OPE',
  $s$insert into public.halls (unit_id, name) values ('{A}', 'X'); select 'x'$s$, '42501 layout_write_forbidden');
select pg_temp.caso(8407, 'H-2b operador renomeia salão', 'OPE',
  $s$update public.halls set name='Y' where id='{S2}'; select 'x'$s$, '42501 layout_write_forbidden');
select pg_temp.caso(8408, 'H-2c operador apaga salão', 'OPE',
  $s$delete from public.halls where id='{S2}'; select 'x'$s$, '42501 layout_write_forbidden');
select pg_temp.caso(8409, 'H-3a operador cria horário', 'OPE',
  $s$insert into public.hall_schedules (hall_id, day_of_week, open_time, close_time)
     values ('{S1}', 1, '18:00', '22:00'); select 'x'$s$, '42501 layout_write_forbidden');
select pg_temp.caso(8410, 'H-3b operador liga caução no horário', 'OPE',
  $s$update public.hall_schedules set charge_enabled=true, charge_amount_cents=1 where id='{H1}'; select 'x'$s$,
  '42501 layout_write_forbidden');
select pg_temp.caso(8411, 'H-3c operador apaga horário', 'OPE',
  $s$delete from public.hall_schedules where id='{H1}'; select 'x'$s$, '42501 layout_write_forbidden');

-- ═══ H-4 — gestor, admin e service_role escrevem ════════════════════════════
select pg_temp.caso(8412, 'H-4a gerente muda capacidade', 'GER',
  $s$update public.tables set max_capacity=8 where id='{T11}'; select 'x'$s$, 'ok',
  $c$(select capacity from public.tables where id='{T11}') = 8$c$);
select pg_temp.caso(8413, 'H-4b owner apaga mesa', 'OWN',
  $s$delete from public.tables where id='{T13}'; select 'x'$s$, 'ok',
  $c$not exists (select 1 from public.tables where id='{T13}')$c$);
select pg_temp.caso(8414, 'H-4c gerente cria mesa', 'GER',
  $s$insert into public.tables (number, capacity, unit_id, hall_id, min_capacity, max_capacity)
     values (99, 2, '{A}', '{S1}', 1, 2); select 'x'$s$, 'ok',
  $c$exists (select 1 from public.tables where number=99 and unit_id='{A}')$c$);
select pg_temp.caso(8415, 'H-4d owner cria salão', 'OWN',
  $s$insert into public.halls (unit_id, name) values ('{A}', 'X'); select 'x'$s$, 'ok');
select pg_temp.caso(8416, 'H-4e platform_admin sem membership renomeia salão', 'PA',
  $s$update public.halls set name='Y' where id='{S2}'; select 'x'$s$, 'ok',
  $c$(select name from public.halls where id='{S2}') = 'Y'$c$);
select pg_temp.caso(8417, 'H-4f gerente liga caução no horário', 'GER',
  $s$update public.hall_schedules set charge_enabled=true, charge_amount_cents=500 where id='{H1}'; select 'x'$s$, 'ok',
  $c$(select charge_amount_cents from public.hall_schedules where id='{H1}') = 500$c$);
select pg_temp.caso(8418, 'H-4g gerente apaga horário', 'GER',
  $s$delete from public.hall_schedules where id='{H2}'; select 'x'$s$, 'ok',
  $c$not exists (select 1 from public.hall_schedules where id='{H2}')$c$);
select pg_temp.caso(8419, 'H-4h service_role cria horário', 'service_role',
  $s$insert into public.hall_schedules (hall_id, day_of_week, open_time, close_time)
     values ('{S1}', 1, '18:00', '22:00'); select 'x'$s$, 'ok');

-- ═══ H-5, H-6, H-11, H-13 — escopo e leitura ════════════════════════════════
select pg_temp.caso(8420, 'H-5a gerente só de B não enxerga mesa de A', 'GERB',
  $s$with u as (update public.tables set max_capacity=8 where id='{T11}' returning 1)
     select count(*)::text from u$s$, 'ok', $c$$1 = '0'$c$);
select pg_temp.caso(8421, 'H-5b gerente de A move mesa para a unidade B', 'GER',
  $s$update public.tables set unit_id='{B}', hall_id=null where id='{T13}'; select 'x'$s$,
  '42501 layout_write_forbidden');
select pg_temp.caso(8422, 'H-6 operador segue lendo mesas, salões e horários de A', 'OPE',
  $s$select (select count(*) from public.tables) || '/' || (select count(*) from public.halls)
     || '/' || (select count(*) from public.hall_schedules)$s$, 'ok', $c$$1 = '4/2/2'$c$);
select pg_temp.caso(8423, 'H-11 gerente de A move horário de S1 para SB', 'GER',
  $s$update public.hall_schedules set hall_id='{SB}' where id='{H1}'; select 'x'$s$,
  '42501 layout_write_forbidden');
select pg_temp.caso(8424, 'H-13 authenticated sem claims cria mesa', 'postgres',
  $s$select set_config('role', 'authenticated', true), set_config('request.jwt.claims', '', true);
     insert into public.tables (number, capacity, unit_id, hall_id, min_capacity, max_capacity)
     values (98, 2, '{A}', '{S1}', 1, 2); select 'x'$s$, '42501 layout_write_forbidden');

-- ═══ H-7, H-8 — mesa presa à unidade do salão ═══════════════════════════════
select pg_temp.caso(8425, 'H-7a platform_admin pendura mesa de A em salão de B', 'PA',
  $s$update public.tables set hall_id='{SB}' where id='{T11}'; select 'x'$s$, '42501 hall_unit_mismatch');
select pg_temp.caso(8426, 'H-7b platform_admin troca para salão da mesma unidade', 'PA',
  $s$update public.tables set hall_id='{S2}' where id='{T11}'; select 'x'$s$, 'ok',
  $c$(select hall_id from public.tables where id='{T11}') = '{S2}'$c$);
select pg_temp.caso(8427, 'H-7c service_role cria mesa de A em salão de B', 'service_role',
  $s$insert into public.tables (number, capacity, unit_id, hall_id, min_capacity, max_capacity)
     values (97, 2, '{A}', '{SB}', 1, 2); select 'x'$s$, '42501 hall_unit_mismatch');
select pg_temp.caso(8428, 'H-7d gerente cria mesa em salão inexistente', 'GER',
  $s$insert into public.tables (number, capacity, unit_id, hall_id, min_capacity, max_capacity)
     values (97, 2, '{A}', 'a0d81000-0000-4000-8000-00000000ffff', 1, 2); select 'x'$s$,
  '42501 hall_unit_mismatch');
select pg_temp.caso(8429, 'H-8a platform_admin move salão com mesas para B', 'PA',
  $s$update public.halls set unit_id='{B}' where id='{S1}'; select 'x'$s$, '42501 hall_unit_mismatch');
select pg_temp.caso(8430, 'H-8b platform_admin move salão vazio para B', 'PA',
  $s$insert into public.halls (id, unit_id, name) values ('a0d81000-0000-4000-8000-0000000000d1', '{A}', 'Vazio');
     update public.halls set unit_id='{B}' where id='a0d81000-0000-4000-8000-0000000000d1'; select 'x'$s$, 'ok');

select pg_temp.caso(8443, 'H-8c salão vazio com bloqueio não muda de unidade', 'PA',
  $s$insert into public.halls (id, unit_id, name) values ('a0d81000-0000-4000-8000-0000000000d1', '{A}', 'Vazio');
     insert into public.table_blocks (unit_id, hall_id) values ('{A}', 'a0d81000-0000-4000-8000-0000000000d1');
     update public.halls set unit_id='{B}' where id='a0d81000-0000-4000-8000-0000000000d1'; select 'x'$s$,
  '42501 hall_unit_mismatch');
select pg_temp.caso(8444, 'H-8d salão vazio com data especial não muda de unidade', 'PA',
  $s$insert into public.halls (id, unit_id, name) values ('a0d81000-0000-4000-8000-0000000000d1', '{A}', 'Vazio');
     insert into public.special_dates (unit_id, hall_id) values ('{A}', 'a0d81000-0000-4000-8000-0000000000d1');
     update public.halls set unit_id='{B}' where id='a0d81000-0000-4000-8000-0000000000d1'; select 'x'$s$,
  '42501 hall_unit_mismatch');
-- Sem oráculo: quem não tem papel recebe a recusa de papel antes da de unidade.
select pg_temp.caso(8445, 'H-7e gerente só de B cria mesa de A no salão SB', 'GERB',
  $s$insert into public.tables (number, capacity, unit_id, hall_id, min_capacity, max_capacity)
     values (96, 2, '{A}', '{SB}', 1, 2); select 'x'$s$, '42501 layout_write_forbidden');
select pg_temp.caso(8446, 'H-7f operador pendura mesa de A em salão de B', 'OPE',
  $s$update public.tables set hall_id='{SB}' where id='{T11}'; select 'x'$s$, '42501 layout_write_forbidden');
-- No DELETE a RLS filtra antes do trigger: sem claims, zero linhas e a mesa fica.
select pg_temp.caso(8447, 'H-13b authenticated sem claims apaga mesa', 'postgres',
  $s$select set_config('role', 'authenticated', true), set_config('request.jwt.claims', '', true);
     with d as (delete from public.tables where id='{T13}' returning 1) select count(*)::text from d$s$, 'ok',
  $c$$1 = '0' and exists (select 1 from public.tables where id='{T13}')$c$);

-- ═══ H-9, H-10 — cascata e save_hall_plan ═══════════════════════════════════
select pg_temp.caso(8431, 'H-9 gerente apaga S1 com horário e mesas', 'GER',
  $s$delete from public.halls where id='{S1}'; select 'x'$s$, 'ok',
  $c$not exists (select 1 from public.hall_schedules where id='{H1}')
     and (select count(*) from public.tables where id in ('{T11}','{T12}','{T13}') and hall_id is null) = 3$c$);
select pg_temp.caso(8432, 'H-10a gerente salva a planta de S1', 'GER',
  $s$select public.save_hall_plan('{S1}', (select updated_at from public.halls where id='{S1}'), $s$
     || pg_temp.plano_s1() || $s$)::text$s$, 'ok');
select pg_temp.caso(8433, 'H-10b operador salva a planta de S1', 'OPE',
  $s$select public.save_hall_plan('{S1}', (select updated_at from public.halls where id='{S1}'), $s$
     || pg_temp.plano_s1() || $s$)::text$s$, '42501 hall_plan_forbidden');

-- ═══ H-12 — set_reservation_presence devolve se gravou ══════════════════════
select pg_temp.caso(8434, 'H-12a primeira chegada devolve true', 'OPE',
  $s$select public.set_reservation_presence('{R1}', 'arrive')::text$s$, 'ok', $c$$1 = 'true'$c$);
select pg_temp.caso(8435, 'H-12b chegada repetida devolve false e mantém o horário', 'OPE',
  $s$select public.set_reservation_presence('{R1}', 'arrive');
     select public.set_reservation_presence('{R1}', 'arrive')::text$s$, 'ok',
  $c$$1 = 'false' and (select arrived_at from public.reservations where id='{R1}') is not null$c$);
select pg_temp.caso(8436, 'H-12c desfazer chegada inexistente devolve false', 'OPE',
  $s$select public.set_reservation_presence('{R2}', 'undo_arrive')::text$s$, 'ok', $c$$1 = 'false'$c$);
select pg_temp.caso(8437, 'H-12d liberar duas vezes devolve false', 'OPE',
  $s$select public.set_reservation_presence('{R1}', 'arrive');
     select public.set_reservation_presence('{R1}', 'release');
     select public.set_reservation_presence('{R1}', 'release')::text$s$, 'ok', $c$$1 = 'false'$c$);
select pg_temp.caso(8438, 'H-12e anon executa set_reservation_presence', 'anon',
  $s$select public.set_reservation_presence('{R1}', 'arrive')::text$s$,
  '42501 permission denied for function set_reservation_presence');
select pg_temp.caso(8439, 'H-12f gerente só de B na reserva de A', 'GERB',
  $s$select public.set_reservation_presence('{R1}', 'arrive')::text$s$, '42501 presence_forbidden');

-- ═══ Controles positivos ════════════════════════════════════════════════════
select pg_temp.caso(8440, 'H-CP1 sem o trigger, o operador muda a capacidade', 'postgres',
  $s$alter table public.tables disable trigger tables_write_role_guard;
  $s$ || pg_temp.como('OPE') || $s$
     update public.tables set max_capacity=8 where id='{T11}';
     select set_config('role', 'postgres', true)$s$, 'ok',
  $c$(select capacity from public.tables where id='{T11}') = 8$c$);
select pg_temp.caso(8441, 'H-CP2 sem o trigger, a mesa de A vai para salão de B', 'postgres',
  $s$alter table public.tables disable trigger tables_write_unit_hall_guard;
     update public.tables set hall_id='{SB}' where id='{T11}'; select 'x'$s$, 'ok',
  $c$(select hall_id from public.tables where id='{T11}') = '{SB}'$c$);
select pg_temp.caso(8442, 'H-CP3 sem o trigger, o operador apaga horário', 'postgres',
  $s$alter table public.hall_schedules disable trigger hall_schedules_write_role_guard;
  $s$ || pg_temp.como('OPE') || $s$
     delete from public.hall_schedules where id='{H1}';
     select set_config('role', 'postgres', true)$s$, 'ok',
  $c$not exists (select 1 from public.hall_schedules where id='{H1}')$c$);

-- ═══ Resultado ═══════════════════════════════════════════════════════════════
\o
\pset footer off
select ord, caso, esperado, veredito, case when veredito like esperado then 'PASS' else 'FAIL' end as r
  from t_res order by ord;
select count(*) filter (where veredito like esperado) as pass, count(*) as total from t_res;
do $$
declare v_fail int;
begin
  select count(*) into v_fail from t_res where veredito not like esperado;
  if v_fail > 0 then raise exception '82: % caso(s) divergente(s)', v_fail; end if;
end $$;
rollback;
