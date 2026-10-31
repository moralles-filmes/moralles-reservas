-- 81: planta do salão — layout (L-*) e presença (P-*).
--
-- Base: 81a no contêiner exclusivo (ver README §81). Roda como `postgres`.
-- Cada caso roda num subbloco que é SEMPRE desfeito (um erro sentinela
-- `P8181` desfaz o sucesso), então todo caso parte das fixtures do 81a e a
-- ordem não importa. O caso troca de papel por `set_config('role', …)` e de
-- usuário por `request.jwt.claims`, como o PostgREST.
--
-- `p_sql` termina num SELECT que devolve texto (vira `$1` no `p_check`, que
-- roda como `postgres` depois do sucesso). Tokens `{X}` viram os UUIDs do 81a.
-- Veredito: `ok` ou `SQLSTATE mensagem`; o esperado casa por LIKE.
-- Termina com erro (exit 3) se algum caso diverge; a transação é desfeita.
\set ON_ERROR_STOP on
begin;

do $$ begin
  if to_regclass('public.halls') is null then
    raise exception '81: rode o 81a antes';
  end if;
end $$;

create temp table t_ids (token text primary key, id text not null);
insert into t_ids values
  ('A', 'aa'), ('B', 'bb'), ('OWN', 'a1'), ('GER', 'a2'), ('OPE', 'a3'), ('GERB', 'b2'),
  ('OUT', 'e1'), ('PA', 'c1'), ('S1', '01'), ('S2', '02'), ('SB', '03'),
  ('T11', '11'), ('T12', '12'), ('T13', '13'), ('T21', '21'), ('TB1', '31'), ('NX', 'ffff'),
  ('CUST', 'f1'), ('R1', '101'), ('R2', '102'), ('R3', '103'), ('R4', '104'), ('R5', '105'),
  ('R6', '106'), ('R7', '107'), ('RB', '1b1'), ('W1', '201'), ('W2', '202'), ('W3', '203'),
  ('W4', '204'), ('WB', '2b1'), ('P1', '301'), ('P2', '302'), ('PB', '3b1');
update t_ids set id = 'a0d81000-0000-4000-8000-' || lpad(id, 12, '0');

-- Datas das reservas em BRT, relativas a hoje (desfeito no ROLLBACK final).
-- O trigger de presença não olha mudança de `date` sem chegada.
update public.reservations r set date = (now() at time zone 'America/Sao_Paulo')::date + d.off
  from (values ('101', 0), ('102', 0), ('103', 0), ('104', 0), ('105', 1), ('106', -1), ('107', 0), ('1b1', 0))
    as d(sfx, off)
 where r.id = ('a0d81000-0000-4000-8000-' || lpad(d.sfx, 12, '0'))::uuid;

-- Retrato das contagens por status antes de qualquer caso (P-12).
create temp table t_snap as
  select jsonb_object_agg(k, n) as snap from (
    select 'r:' || status as k, count(*) as n from public.reservations group by 1
    union all select 'w:' || status, count(*) from public.waitlist group by 1
    union all select 'p:' || status, count(*) from public.walk_ins group by 1) s;
create function pg_temp.contagens() returns jsonb language sql as $f$
  select jsonb_object_agg(k, n) from (
    select 'r:' || status as k, count(*) as n from public.reservations group by 1
    union all select 'w:' || status, count(*) from public.waitlist group by 1
    union all select 'p:' || status, count(*) from public.walk_ins group by 1) s
$f$;

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
    raise exception using errcode = 'P8181';
  exception
    when sqlstate 'P8181' then null;
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

\o /dev/null
-- ═══ L — Layout da planta (migration 20261030120000) ═════════════════════════
select pg_temp.caso(8101, 'L-1 owner grava plan_* de mesa de A', 'OWN',
  $s$update public.tables set plan_x=100, plan_y=100, plan_w=80, plan_h=80, plan_rotation=0, plan_shape='round'
     where id='{T11}'; select 'x'$s$, 'ok',
  $c$(select plan_x from public.tables where id='{T11}') = 100$c$);
select pg_temp.caso(8102, 'L-2 gerente grava plan_* de mesa de A', 'GER',
  $s$update public.tables set plan_x=100, plan_y=100, plan_w=120, plan_h=80, plan_rotation=45, plan_shape='rect'
     where id='{T12}'; select 'x'$s$, 'ok',
  $c$(select plan_rotation from public.tables where id='{T12}') = 45$c$);
select pg_temp.caso(8103, 'L-3 operador grava plan_x direto', 'OPE',
  $s$update public.tables set plan_x=100, plan_y=100, plan_w=80, plan_h=80, plan_rotation=0, plan_shape='round'
     where id='{T11}'; select 'x'$s$, '42501 plan_write_forbidden');
select pg_temp.caso(8104, 'L-4 operador muda max_capacity sem plan_*', 'OPE',
  $s$update public.tables set max_capacity=5 where id='{T11}'; select 'x'$s$, 'ok',
  $c$(select capacity from public.tables where id='{T11}') = 5$c$);
select pg_temp.caso(8105, 'L-5a operador cria mesa sem plan_*', 'OPE',
  $s$insert into public.tables (number, capacity, unit_id, hall_id, min_capacity, max_capacity)
     values (99, 2, '{A}', '{S1}', 1, 2); select 'x'$s$, 'ok');
select pg_temp.caso(8106, 'L-5b operador cria mesa com plan_*', 'OPE',
  $s$insert into public.tables (number, capacity, unit_id, hall_id, min_capacity, max_capacity,
       plan_x, plan_y, plan_w, plan_h, plan_rotation, plan_shape)
     values (99, 2, '{A}', '{S1}', 1, 2, 50, 50, 60, 60, 0, 'square'); select 'x'$s$,
  '42501 plan_write_forbidden');
select pg_temp.caso(8107, 'L-6 platform_admin sem membership grava plan_*', 'PA',
  $s$update public.tables set plan_x=100, plan_y=100, plan_w=80, plan_h=80, plan_rotation=0, plan_shape='round'
     where id='{T11}'; update public.halls set plan_width_cm=900, plan_depth_cm=700 where id='{S1}'; select 'x'$s$, 'ok',
  $c$(select plan_width_cm from public.halls where id='{S1}') = 900$c$);
select pg_temp.caso(8108, 'L-7 service_role grava plan_*', 'service_role',
  $s$update public.tables set plan_x=100, plan_y=100, plan_w=80, plan_h=80, plan_rotation=0, plan_shape='round'
     where id='{T11}'; select 'x'$s$, 'ok',
  $c$(select plan_shape from public.tables where id='{T11}') = 'round'$c$);
select pg_temp.caso(8109, 'L-8 owner de A atualiza mesa de B: 0 linhas', 'OWN',
  $s$with u as (update public.tables set plan_x=100, plan_y=100, plan_w=80, plan_h=80, plan_rotation=0, plan_shape='round'
     where id='{TB1}' returning 1) select count(*)::text from u$s$, 'ok',
  $c$$1 = '0' and (select plan_x from public.tables where id='{TB1}') is null$c$);
select pg_temp.caso(8110, 'L-9 owner salva a planta de S1', 'OWN',
  $s$update public.tables set plan_x=10, plan_y=10, plan_w=60, plan_h=60, plan_rotation=0, plan_shape='square' where id='{T13}';
     select public.save_hall_plan('{S1}', (select updated_at from public.halls where id='{S1}'), $s$ || pg_temp.plano_s1() || $s$)::text$s$,
  'ok',
  $c$$1::timestamptz > '2026-01-01 12:00:00+00'
     and $1::timestamptz = (select updated_at from public.halls where id='{S1}')
     and (select (plan_width_cm, plan_depth_cm, plan_entrance_wall, plan_entrance_offset_cm, plan_window_walls)
            from public.halls where id='{S1}') = (800, 600, 'bottom'::text, 100, array['top','left']::text[])
     and (select (plan_x, plan_y, plan_w, plan_h, plan_rotation, plan_shape) from public.tables where id='{T11}')
         = (150, 150, 80, 80, 0::smallint, 'round'::text)
     and (select (plan_x, plan_y, plan_w, plan_h, plan_rotation, plan_shape) from public.tables where id='{T12}')
         = (400, 300, 120, 80, 90::smallint, 'rect'::text)
     and (select num_nonnulls(plan_x, plan_y, plan_w, plan_h, plan_rotation, plan_shape) from public.tables where id='{T13}') = 0$c$);
select pg_temp.caso(8111, 'L-10 operador chama save_hall_plan', 'OPE',
  $s$select public.save_hall_plan('{S1}', (select updated_at from public.halls where id='{S1}'), $s$ || pg_temp.plano_s1() || $s$)::text$s$,
  '42501 hall_plan_forbidden');
select pg_temp.caso(8112, 'L-10b operador salva planta idêntica (nada muda): ainda recusa', 'OPE',
  $s$select public.save_hall_plan('{S1}', (select updated_at from public.halls where id='{S1}'),
     '{"width_cm":null,"depth_cm":null,"entrance_wall":null,"entrance_offset_cm":null,"window_walls":[]}',
     '[{"id":"{T11}","x":null,"y":null,"w":null,"h":null,"rotation":null,"shape":null}]')::text$s$,
  '42501 hall_plan_forbidden');
select pg_temp.caso(8113, 'L-11a owner de A salva planta do salão de B', 'OWN',
  $s$select public.save_hall_plan('{SB}', '2026-01-01 12:00:00+00',
     '{"width_cm":null,"depth_cm":null,"entrance_wall":null,"entrance_offset_cm":null,"window_walls":[]}', '[]')::text$s$,
  '42501 hall_plan_forbidden');
select pg_temp.caso(8114, 'L-11b owner de A salva planta de salão inexistente', 'OWN',
  $s$select public.save_hall_plan('{NX}', '2026-01-01 12:00:00+00',
     '{"width_cm":null,"depth_cm":null,"entrance_wall":null,"entrance_offset_cm":null,"window_walls":[]}', '[]')::text$s$,
  '42501 hall_plan_forbidden');
select pg_temp.caso(8115, 'L-12a payload com mesa de S2', 'OWN',
  $s$select public.save_hall_plan('{S1}', (select updated_at from public.halls where id='{S1}'),
     '{"width_cm":null,"depth_cm":null,"entrance_wall":null,"entrance_offset_cm":null,"window_walls":[]}',
     '[{"id":"{T11}","x":100,"y":100,"w":80,"h":80,"rotation":0,"shape":"round"},
       {"id":"{T21}","x":100,"y":100,"w":80,"h":80,"rotation":0,"shape":"round"}]')::text$s$,
  '42501 hall_plan_forbidden');
select pg_temp.caso(8116, 'L-12b payload com mesa de B', 'OWN',
  $s$select public.save_hall_plan('{S1}', (select updated_at from public.halls where id='{S1}'),
     '{"width_cm":null,"depth_cm":null,"entrance_wall":null,"entrance_offset_cm":null,"window_walls":[]}',
     '[{"id":"{TB1}","x":100,"y":100,"w":80,"h":80,"rotation":0,"shape":"round"}]')::text$s$,
  '42501 hall_plan_forbidden');
select pg_temp.caso(8117, 'L-12c payload com id inexistente', 'OWN',
  $s$select public.save_hall_plan('{S1}', (select updated_at from public.halls where id='{S1}'),
     '{"width_cm":null,"depth_cm":null,"entrance_wall":null,"entrance_offset_cm":null,"window_walls":[]}',
     '[{"id":"{NX}","x":100,"y":100,"w":80,"h":80,"rotation":0,"shape":"round"}]')::text$s$,
  '42501 hall_plan_forbidden');
select pg_temp.caso(8118, 'L-12d payload com id repetido', 'OWN',
  $s$select public.save_hall_plan('{S1}', (select updated_at from public.halls where id='{S1}'),
     '{"width_cm":null,"depth_cm":null,"entrance_wall":null,"entrance_offset_cm":null,"window_walls":[]}',
     '[{"id":"{T11}","x":100,"y":100,"w":80,"h":80,"rotation":0,"shape":"round"},
       {"id":"{T11}","x":300,"y":100,"w":80,"h":80,"rotation":0,"shape":"round"}]')::text$s$,
  '42501 hall_plan_forbidden');
select pg_temp.caso(8119, 'L-13 revisão velha', 'OWN',
  $s$select public.save_hall_plan('{S1}', '2025-06-01 12:00:00+00', $s$ || pg_temp.plano_s1() || $s$)::text$s$,
  '40001 hall_plan_stale');
select pg_temp.caso(8120, 'L-14a mesa parcial (só plan_x)', 'OWN',
  $s$update public.tables set plan_x=10 where id='{T11}'; select 'x'$s$,
  '23514 %tables_plan_all_or_none%');
select pg_temp.caso(8121, 'L-14b round com w diferente de h', 'OWN',
  $s$update public.tables set plan_x=10, plan_y=10, plan_w=80, plan_h=60, plan_rotation=0, plan_shape='round'
     where id='{T11}'; select 'x'$s$, '23514 %tables_plan_values%');
select pg_temp.caso(8122, 'L-15 parede de janela inválida', 'OWN',
  $s$update public.halls set plan_window_walls='{norte}' where id='{S1}'; select 'x'$s$,
  '23514 %halls_plan_windows%');
select pg_temp.caso(8123, 'L-16 anon executa save_hall_plan', 'anon',
  $s$select public.save_hall_plan('{S1}', now(), '{}', '[]')::text$s$,
  '42501 permission denied for function save_hall_plan');
select pg_temp.caso(8124, 'L-17 operador grava plan_* do salão direto', 'OPE',
  $s$update public.halls set plan_width_cm=900, plan_depth_cm=700 where id='{S1}'; select 'x'$s$,
  '42501 plan_write_forbidden');
select pg_temp.caso(8125, 'L-18a payload sem chave obrigatória', 'OWN',
  $s$select public.save_hall_plan('{S1}', (select updated_at from public.halls where id='{S1}'),
     '{"width_cm":null}', '[]')::text$s$, '22023 hall_plan_invalid');
select pg_temp.caso(8126, 'L-18b medida não inteira', 'OWN',
  $s$select public.save_hall_plan('{S1}', (select updated_at from public.halls where id='{S1}'),
     '{"width_cm":null,"depth_cm":null,"entrance_wall":null,"entrance_offset_cm":null,"window_walls":[]}',
     '[{"id":"{T11}","x":10.5,"y":100,"w":80,"h":80,"rotation":0,"shape":"round"}]')::text$s$,
  '22023 hall_plan_invalid');
select pg_temp.caso(8127, 'L-18c mais de 500 mesas', 'OWN',
  $s$select public.save_hall_plan('{S1}', (select updated_at from public.halls where id='{S1}'),
     '{"width_cm":null,"depth_cm":null,"entrance_wall":null,"entrance_offset_cm":null,"window_walls":[]}',
     (select jsonb_agg(jsonb_build_object('id', gen_random_uuid(), 'x', null, 'y', null, 'w', null, 'h', null,
        'rotation', null, 'shape', null)) from generate_series(1, 501)))::text$s$,
  '22023 hall_plan_invalid');
select pg_temp.caso(8128, 'L-18d medida como texto', 'OWN',
  $s$select public.save_hall_plan('{S1}', (select updated_at from public.halls where id='{S1}'),
     '{"width_cm":"800","depth_cm":600,"entrance_wall":null,"entrance_offset_cm":null,"window_walls":[]}', '[]')::text$s$,
  '22023 hall_plan_invalid');
select pg_temp.caso(8129, 'L-19 gerente de B grava plan_* de mesa de A: 0 linhas', 'GERB',
  $s$with u as (update public.tables set plan_x=100, plan_y=100, plan_w=80, plan_h=80, plan_rotation=0, plan_shape='round'
     where id='{T11}' returning 1) select count(*)::text from u$s$, 'ok', $c$$1 = '0'$c$);
-- BEFORE roda antes do WITH CHECK: sem claims, quem recusa é o ramo do GUC `role`.
select pg_temp.caso(8130, 'L-20 papel authenticated sem claims cria mesa com plan_*', 'postgres',
  $s$select set_config('role', 'authenticated', true), set_config('request.jwt.claims', '', true);
     insert into public.tables (number, capacity, unit_id, hall_id, min_capacity, max_capacity,
       plan_x, plan_y, plan_w, plan_h, plan_rotation, plan_shape)
     values (98, 2, '{A}', '{S1}', 1, 2, 50, 50, 60, 60, 0, 'square');
     select 'x'$s$, '42501 plan_write_forbidden');
select pg_temp.caso(8131, 'L-CP controle: sem o trigger, o operador grava plan_*', 'postgres',
  $s$alter table public.tables disable trigger tables_plan_write_guard;
     select set_config('role', 'authenticated', true),
            set_config('request.jwt.claims', '{"sub":"{OPE}","role":"authenticated"}', true);
     update public.tables set plan_x=100, plan_y=100, plan_w=80, plan_h=80, plan_rotation=0, plan_shape='round'
       where id='{T11}';
     select set_config('role', 'postgres', true)$s$, 'ok',
  $c$(select plan_x from public.tables where id='{T11}') = 100$c$);
-- Mutação do corpo instalado: falha se o trecho sumir (o replace não mudaria nada).
select pg_temp.caso(8132, 'L-CP2 controle: trigger sem o modo estrito, o L-10b do operador passa', 'postgres',
  $s$do $d$ declare v_def text := pg_get_functiondef('app_private.guard_plan_write()'::regprocedure); v_mut text;
     begin
       v_mut := replace(v_def, $m$= 'on';$m$, $m$= 'on' and false;$m$);
       if v_mut = v_def then raise exception 'L-CP2: trecho do modo estrito não encontrado'; end if;
       execute v_mut;
     end $d$;
     select set_config('role', 'authenticated', true),
            set_config('request.jwt.claims', '{"sub":"{OPE}","role":"authenticated"}', true);
     select public.save_hall_plan('{S1}', (select updated_at from public.halls where id='{S1}'),
       '{"width_cm":null,"depth_cm":null,"entrance_wall":null,"entrance_offset_cm":null,"window_walls":[]}',
       '[{"id":"{T11}","x":null,"y":null,"w":null,"h":null,"rotation":null,"shape":null}]')::text$s$,
  'ok', $c$$1::timestamptz > '2026-01-01 12:00:00+00'$c$);

select pg_temp.caso(8133, 'L-21a salão só com a largura', 'OWN',
  $s$update public.halls set plan_width_cm=800 where id='{S1}'; select 'x'$s$,
  '23514 %halls_plan_dims%');
select pg_temp.caso(8134, 'L-21b entrada sem a distância', 'OWN',
  $s$update public.halls set plan_entrance_wall='top' where id='{S1}'; select 'x'$s$,
  '23514 %halls_plan_entrance%');
select pg_temp.caso(8135, 'L-21c save_hall_plan com profundidade nula', 'OWN',
  $s$select public.save_hall_plan('{S1}', (select updated_at from public.halls where id='{S1}'),
     '{"width_cm":800,"depth_cm":null,"entrance_wall":null,"entrance_offset_cm":null,"window_walls":[]}', '[]')::text$s$,
  '23514 %halls_plan_dims%');
select pg_temp.caso(8136, 'L-CP3 controle: CHECK na forma antiga aceita só a largura', 'postgres',
  $s$alter table public.halls drop constraint halls_plan_dims;
     alter table public.halls add constraint halls_plan_dims check (
       (plan_width_cm is null and plan_depth_cm is null)
       or (plan_width_cm between 200 and 5000 and plan_depth_cm between 200 and 5000));
     update public.halls set plan_width_cm=800 where id='{S1}'; select 'x'$s$, 'ok',
  $c$(select plan_width_cm from public.halls where id='{S1}') = 800$c$);
-- Mesa de B pendurada no salão de A (o FK de hall_id não olha a unidade).
select pg_temp.caso(8137, 'L-22 platform_admin salva S1 com mesa de B pendurada nele', 'postgres',
  $s$update public.tables set hall_id='{S1}' where id='{TB1}';
     select set_config('role', 'authenticated', true),
            set_config('request.jwt.claims', '{"sub":"{PA}","role":"authenticated"}', true);
     select public.save_hall_plan('{S1}', (select updated_at from public.halls where id='{S1}'),
       '{"width_cm":null,"depth_cm":null,"entrance_wall":null,"entrance_offset_cm":null,"window_walls":[]}',
       '[{"id":"{TB1}","x":100,"y":100,"w":80,"h":80,"rotation":0,"shape":"round"}]')::text$s$,
  '42501 hall_plan_forbidden');

-- ═══ P — Presença (migration 20261030120100) ═════════════════════════════════
-- Casos com ator 'postgres' preparam estado (carimbo no passado, com o trigger
-- desligado só naquele UPDATE) e depois trocam de papel por pg_temp.como().
create function pg_temp.como(p_tok text) returns text language sql as $f$
  select format($q$select set_config('role', 'authenticated', true),
    set_config('request.jwt.claims', '{"sub":"{%s}","role":"authenticated"}', true);$q$, p_tok)
$f$;
create function pg_temp.carimbar(p_table text, p_id uuid, p_col text, p_ts timestamptz)
returns void language plpgsql as $f$
begin
  execute format('alter table public.%I disable trigger %I', p_table, p_table || '_presence_guard');
  execute format('update public.%I set %I = $1 where id = $2', p_table, p_col) using p_ts, p_id;
  execute format('alter table public.%I enable trigger %I', p_table, p_table || '_presence_guard');
end $f$;

select pg_temp.caso(8201, 'P-1a operador marca chegada: arrived_at = now()', 'OPE',
  $s$select public.set_reservation_presence('{R1}', 'arrive'); select 'x'$s$, 'ok',
  $c$(select arrived_at from public.reservations where id='{R1}') = now()$c$);
select pg_temp.caso(8202, 'P-1b UPDATE direto com arrived_at forjado grava now()', 'OPE',
  $s$update public.reservations set arrived_at = '2000-01-01 12:00+00' where id='{R1}'; select 'x'$s$, 'ok',
  $c$(select arrived_at from public.reservations where id='{R1}') = now()$c$);
select pg_temp.caso(8203, 'P-2 chegada repetida não muda o horário', 'postgres',
  $s$select pg_temp.carimbar('reservations', '{R1}', 'arrived_at', now() - interval '10 minutes');
  $s$ || pg_temp.como('OPE') || $s$
     select public.set_reservation_presence('{R1}', 'arrive'); select 'x'$s$, 'ok',
  $c$(select arrived_at from public.reservations where id='{R1}') = now() - interval '10 minutes'$c$);
select pg_temp.caso(8204, 'P-3a chegada em reserva cancelada', 'OPE',
  $s$select public.set_reservation_presence('{R3}', 'arrive'); select 'x'$s$,
  '23514 presence_invalid [arrival_not_allowed]');
select pg_temp.caso(8205, 'P-3b chegada em no_show', 'OPE',
  $s$select public.set_reservation_presence('{R4}', 'arrive'); select 'x'$s$,
  '23514 presence_invalid [arrival_not_allowed]');
select pg_temp.caso(8206, 'P-3c chegada em reserva de amanhã', 'OPE',
  $s$select public.set_reservation_presence('{R5}', 'arrive'); select 'x'$s$,
  '23514 presence_invalid [arrival_not_allowed]');
select pg_temp.caso(8207, 'P-3d chegada em reserva de ontem (virada da meia-noite)', 'OPE',
  $s$select public.set_reservation_presence('{R6}', 'arrive'); select 'x'$s$, 'ok',
  $c$(select arrived_at from public.reservations where id='{R6}') = now()$c$);
select pg_temp.caso(8208, 'P-3e chegada em reserva pending', 'OPE',
  $s$select public.set_reservation_presence('{R2}', 'arrive'); select 'x'$s$, 'ok',
  $c$(select arrived_at from public.reservations where id='{R2}') is not null$c$);
select pg_temp.caso(8209, 'P-4a liberar sem chegada', 'OPE',
  $s$select public.set_reservation_presence('{R1}', 'release'); select 'x'$s$,
  '23514 presence_invalid [release_requires_arrival]');
select pg_temp.caso(8210, 'P-4b chegar e liberar', 'OPE',
  $s$select public.set_reservation_presence('{R1}', 'arrive');
     select public.set_reservation_presence('{R1}', 'release'); select 'x'$s$, 'ok',
  $c$(select (arrived_at, released_at) from public.reservations where id='{R1}') = (now(), now())$c$);
select pg_temp.caso(8211, 'P-4c liberar de novo não muda o horário', 'postgres',
  $s$select pg_temp.carimbar('reservations', '{R1}', 'arrived_at', now() - interval '90 minutes');
     select pg_temp.carimbar('reservations', '{R1}', 'released_at', now() - interval '5 minutes');
  $s$ || pg_temp.como('OPE') || $s$
     select public.set_reservation_presence('{R1}', 'release'); select 'x'$s$, 'ok',
  $c$(select released_at from public.reservations where id='{R1}') = now() - interval '5 minutes'$c$);
select pg_temp.caso(8212, 'P-4d desfazer chegada depois de liberar', 'OPE',
  $s$select public.set_reservation_presence('{R1}', 'arrive');
     select public.set_reservation_presence('{R1}', 'release');
     select public.set_reservation_presence('{R1}', 'undo_arrive'); select 'x'$s$,
  '23514 presence_invalid [presence_final]');
select pg_temp.caso(8213, 'P-4e UPDATE direto troca released_at já gravado', 'postgres',
  $s$select pg_temp.carimbar('reservations', '{R1}', 'arrived_at', now() - interval '90 minutes');
     select pg_temp.carimbar('reservations', '{R1}', 'released_at', now() - interval '5 minutes');
  $s$ || pg_temp.como('GER') || $s$
     update public.reservations set released_at = null where id='{R1}'; select 'x'$s$,
  '23514 presence_invalid [presence_final]');
select pg_temp.caso(8214, 'P-5 desfazer chegada antes de liberar', 'OPE',
  $s$select public.set_reservation_presence('{R1}', 'arrive');
     select public.set_reservation_presence('{R1}', 'undo_arrive'); select 'x'$s$, 'ok',
  $c$(select arrived_at from public.reservations where id='{R1}') is null$c$);
select pg_temp.caso(8215, 'P-6a status intacto depois de chegar, liberar e desfazer', 'OPE',
  $s$select public.set_reservation_presence('{R1}', 'arrive');
     select public.set_reservation_presence('{R1}', 'release');
     select public.set_reservation_presence('{R2}', 'arrive');
     select public.set_reservation_presence('{R2}', 'undo_arrive');
     select public.set_reservation_presence('{R6}', 'arrive'); select 'x'$s$, 'ok',
  $c$(select array_agg(status order by reservation_code) from public.reservations
       where id in ('{R1}', '{R2}', '{R6}')) = array['confirmed', 'pending', 'confirmed']$c$);
select pg_temp.caso(8216, 'P-6b operador continua sem cancelar, mesmo com chegada', 'OPE',
  $s$select public.set_reservation_presence('{R1}', 'arrive');
     update public.reservations set status = 'cancelled' where id='{R1}'; select 'x'$s$,
  'P0001 operador_cannot_cancel');
select pg_temp.caso(8217, 'P-7a reserva da unidade B', 'OWN',
  $s$select public.set_reservation_presence('{RB}', 'arrive'); select 'x'$s$, '42501 presence_forbidden');
select pg_temp.caso(8218, 'P-7b reserva inexistente', 'OWN',
  $s$select public.set_reservation_presence('{NX}', 'arrive'); select 'x'$s$, '42501 presence_forbidden');
select pg_temp.caso(8219, 'P-7c ação inválida', 'OWN',
  $s$select public.set_reservation_presence('{R1}', 'seat'); select 'x'$s$, '22023 presence_action_invalid');
select pg_temp.caso(8220, 'P-8a sentar da fila (waiting) numa mesa de A', 'OPE',
  $s$select public.seat_waitlist_entry('{W1}', '{T13}'); select 'x'$s$, 'ok',
  $c$(select (status, table_id, seated_at is not null, released_at) from public.waitlist where id='{W1}')
     = ('seated'::text, '{T13}'::uuid, true, null::timestamptz)$c$);
select pg_temp.caso(8221, 'P-8b sentar da fila (notified)', 'OPE',
  $s$select public.seat_waitlist_entry('{W2}', '{T13}'); select 'x'$s$, 'ok',
  $c$(select (status, table_id) from public.waitlist where id='{W2}') = ('seated'::text, '{T13}'::uuid)$c$);
select pg_temp.caso(8222, 'P-8c sentar entrada cancelada', 'OPE',
  $s$select public.seat_waitlist_entry('{W3}', '{T13}'); select 'x'$s$,
  '23514 presence_invalid [not_seatable]');
select pg_temp.caso(8223, 'P-8d sentar numa mesa da unidade B', 'OPE',
  $s$select public.seat_waitlist_entry('{W1}', '{TB1}'); select 'x'$s$, '42501 table_unit_mismatch');
select pg_temp.caso(8224, 'P-8e sentar entrada da unidade B', 'OPE',
  $s$select public.seat_waitlist_entry('{WB}', '{T13}'); select 'x'$s$, '42501 presence_forbidden');
select pg_temp.caso(8225, 'P-8f sentar sem mesa', 'OPE',
  $s$select public.seat_waitlist_entry('{W1}', null); select 'x'$s$, '22023 presence_action_invalid');
select pg_temp.caso(8226, 'P-9a liberar entrada da fila sentada', 'OPE',
  $s$select public.release_waitlist_entry('{W4}'); select 'x'$s$, 'ok',
  $c$(select (status, released_at) from public.waitlist where id='{W4}') = ('seated'::text, now())$c$);
select pg_temp.caso(8227, 'P-9b liberar entrada da fila esperando', 'OPE',
  $s$select public.release_waitlist_entry('{W1}'); select 'x'$s$, '23514 presence_invalid [not_seated]');
select pg_temp.caso(8228, 'P-9c liberar entrada da fila de B', 'OPE',
  $s$select public.release_waitlist_entry('{WB}'); select 'x'$s$, '42501 presence_forbidden');
select pg_temp.caso(8229, 'P-9d liberar passante sentado e depois "Foi embora"', 'OPE',
  $s$select public.release_walk_in('{P1}');
     update public.walk_ins set status = 'left' where id='{P1}'; select 'x'$s$, 'ok',
  $c$(select (status, released_at) from public.walk_ins where id='{P1}') = ('left'::text, now())$c$);
select pg_temp.caso(8230, 'P-9e liberar passante esperando', 'OPE',
  $s$select public.release_walk_in('{P2}'); select 'x'$s$, '23514 presence_invalid [not_seated]');
select pg_temp.caso(8231, 'P-9f liberar passante de B', 'OPE',
  $s$select public.release_walk_in('{PB}'); select 'x'$s$, '42501 presence_forbidden');
select pg_temp.caso(8232, 'P-9g liberar passante de novo não muda o horário', 'postgres',
  $s$select pg_temp.carimbar('walk_ins', '{P1}', 'released_at', now() - interval '5 minutes');
  $s$ || pg_temp.como('OPE') || $s$
     select public.release_walk_in('{P1}'); select 'x'$s$, 'ok',
  $c$(select released_at from public.walk_ins where id='{P1}') = now() - interval '5 minutes'$c$);
select pg_temp.caso(8233, 'P-10 UPDATE direto de walk_ins.table_id com mesa de B', 'OPE',
  $s$update public.walk_ins set table_id = '{TB1}', status = 'seated' where id='{P2}'; select 'x'$s$,
  '42501 table_unit_mismatch');
select pg_temp.caso(8234, 'P-10b UPDATE direto de waitlist.table_id com mesa de B', 'OPE',
  $s$update public.waitlist set table_id = '{TB1}' where id='{W4}'; select 'x'$s$,
  '42501 table_unit_mismatch');
select pg_temp.caso(8235, 'P-11a platform_admin sem membership libera passante de A', 'PA',
  $s$select public.release_walk_in('{P1}'); select 'x'$s$, 'ok',
  $c$(select released_at from public.walk_ins where id='{P1}') = now()$c$);
select pg_temp.caso(8236, 'P-11b outsider libera passante de A', 'OUT',
  $s$select public.release_walk_in('{P1}'); select 'x'$s$, '42501 presence_forbidden');
select pg_temp.caso(8237, 'P-12 invariante de métricas: contagens por status e linhas', 'OPE',
  $s$select public.set_reservation_presence('{R1}', 'arrive');
     select public.set_reservation_presence('{R1}', 'release');
     select public.set_reservation_presence('{R2}', 'arrive');
     select public.set_reservation_presence('{R2}', 'undo_arrive');
     select public.seat_waitlist_entry('{W1}', '{T13}');
     select public.release_waitlist_entry('{W4}');
     select public.release_walk_in('{P1}'); select 'x'$s$, 'ok',
  $c$pg_temp.contagens() = (select snap || jsonb_build_object(
        'w:waiting', (snap ->> 'w:waiting')::int - 1,
        'w:seated', (snap ->> 'w:seated')::int + 1) from t_snap)$c$);
select pg_temp.caso(8238, 'P-13a anon cria reserva já com chegada', 'anon',
  $s$insert into public.reservations (customer_id, date, time, party_size, reservation_code, unit_id, arrived_at)
     values ('{CUST}', current_date, '20:00', 2, 'P81-X1', '{A}', now()); select 'x'$s$,
  '23514 presence_invalid [born_with_presence]');
select pg_temp.caso(8239, 'P-13b owner cria reserva já liberada', 'OWN',
  $s$insert into public.reservations (customer_id, date, time, party_size, reservation_code, unit_id, released_at)
     values ('{CUST}', current_date, '20:00', 2, 'P81-X2', '{A}', now()); select 'x'$s$,
  '23514 presence_invalid [born_with_presence]');
select pg_temp.caso(8240, 'P-13c operador cria passante já liberado', 'OPE',
  $s$insert into public.walk_ins (unit_id, customer_name, party_size, status, seated_at, released_at)
     values ('{A}', 'X', 2, 'seated', now(), now()); select 'x'$s$,
  '23514 presence_invalid [born_with_presence]');
select pg_temp.caso(8241, 'P-14a anon executa set_reservation_presence', 'anon',
  $s$select public.set_reservation_presence('{R1}', 'arrive'); select 'x'$s$,
  '42501 permission denied for function set_reservation_presence');
select pg_temp.caso(8242, 'P-14b anon executa seat_waitlist_entry', 'anon',
  $s$select public.seat_waitlist_entry('{W1}', '{T13}'); select 'x'$s$,
  '42501 permission denied for function seat_waitlist_entry');
select pg_temp.caso(8243, 'P-14c anon executa release_waitlist_entry', 'anon',
  $s$select public.release_waitlist_entry('{W4}'); select 'x'$s$,
  '42501 permission denied for function release_waitlist_entry');
select pg_temp.caso(8244, 'P-14d anon executa release_walk_in', 'anon',
  $s$select public.release_walk_in('{P1}'); select 'x'$s$,
  '42501 permission denied for function release_walk_in');
select pg_temp.caso(8245, 'P-CP controle: sem o trigger, o UPDATE forjado de P-1b grava 2000-01-01', 'postgres',
  $s$alter table public.reservations disable trigger reservations_presence_guard;
  $s$ || pg_temp.como('OPE') || $s$
     update public.reservations set arrived_at = '2000-01-01 12:00+00' where id='{R1}';
     select set_config('role', 'postgres', true)$s$, 'ok',
  $c$(select arrived_at from public.reservations where id='{R1}') = '2000-01-01 12:00+00'$c$);
select pg_temp.caso(8246, 'P-CP2 controle: sem a policy de admin em walk_ins, P-11a recusa', 'postgres',
  $s$drop policy platform_admin_all_walk_ins on public.walk_ins;
     select set_config('role', 'authenticated', true),
            set_config('request.jwt.claims', '{"sub":"{PA}","role":"authenticated"}', true);
     select public.release_walk_in('{P1}'); select 'x'$s$, '42501 presence_forbidden');

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
  if v_fail > 0 then raise exception '81: % caso(s) divergente(s)', v_fail; end if;
end $$;
rollback;
