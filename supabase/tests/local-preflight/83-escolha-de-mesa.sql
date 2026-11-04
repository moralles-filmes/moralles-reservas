-- 83: escolha de mesa — mesa reservável e combinações (C-*).
--
-- Base: 81a + migrations 20261030120000/120100 + 82a + 20261104120000 + 83a,
-- no contêiner exclusivo (README §83). Roda como `postgres`. Mesmo motor do
-- 82: cada caso roda num subbloco SEMPRE desfeito (sentinela `P8383`), troca
-- papel e claims por `set_config` como o PostgREST e confere SQLSTATE,
-- mensagem e efeito. Termina com erro se algum caso diverge; a transação é
-- desfeita.
\set ON_ERROR_STOP on
begin;

do $$ begin
  if to_regclass('public.hall_schedules') is null then
    raise exception '83: rode o 81a, as migrations da planta, o 82a e o 83a antes';
  end if;
end $$;

-- T14 em S1, fora de qualquer reserva (desfeita no ROLLBACK final: o 82 conta
-- as mesas de A).
insert into public.tables (id, number, capacity, unit_id, hall_id, min_capacity, max_capacity) values
  ('a0d81000-0000-4000-8000-000000000014', 14, 4, 'a0d81000-0000-4000-8000-0000000000aa', 'a0d81000-0000-4000-8000-000000000001', 1, 4);

create temp table t_ids (token text primary key, id text not null);
insert into t_ids values
  ('A', 'aa'), ('B', 'bb'), ('OWN', 'a1'), ('GER', 'a2'), ('OPE', 'a3'), ('GERB', 'b2'),
  ('OUT', 'e1'), ('PA', 'c1'), ('S1', '01'), ('S2', '02'), ('SB', '03'),
  ('T11', '11'), ('T12', '12'), ('T13', '13'), ('T14', '14'), ('T21', '21'), ('TB1', '31'),
  ('R1', '101'), ('R2', '102');
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
    raise exception using errcode = 'P8383';
  exception
    when sqlstate 'P8383' then null;
    when others then
      get stacked diagnostics v_detail = pg_exception_detail;
      v_actual := sqlstate || ' ' || sqlerrm || coalesce(' [' || nullif(v_detail, '') || ']', '');
  end;
  insert into t_res values (p_ord, p_caso, p_expect, v_actual);
end $f$;

create function pg_temp.como(p_tok text) returns text language sql as $f$
  select format($q$select set_config('role', 'authenticated', true),
    set_config('request.jwt.claims', '{"sub":"{%s}","role":"authenticated"}', true);$q$, p_tok)
$f$;

-- save_hall_plan de S1 com a revisão atual, salão fixo e mesas/combinações dadas.
create function pg_temp.salvar(p_combos text, p_tables text default '[]', p_hall text default '{S1}')
returns text language sql as $f$
  select format($q$select public.save_hall_plan('%s',
      (select h.updated_at from public.halls h where h.id = '%s'),
      '{"width_cm":800,"depth_cm":600,"entrance_wall":"bottom","entrance_offset_cm":100,"window_walls":[]}'::jsonb,
      %L::jsonb, %s)::text$q$, p_hall, p_hall, p_tables,
    case when p_combos is null then 'null' else quote_literal(p_combos) || '::jsonb' end)
$f$;

-- SQLSTATE da save_hall_plan de S1 com o payload de combinações dado ('ok' se gravou).
-- Roda já como o ator: sem pg_temp.sub (t_ids não é legível por authenticated).
create function pg_temp.salvar_recusa(p_combos text) returns text language plpgsql as $f$
begin
  execute pg_temp.salvar(p_combos, '[]', 'a0d81000-0000-4000-8000-000000000001');
  return 'ok';
exception when others then
  return sqlstate;
end $f$;

-- Combinações ativas de S1 com o conjunto de mesas (números) e a faixa.
-- plpgsql: o corpo só é resolvido na chamada (o RED roda sem as tabelas).
create function pg_temp.combos_s1() returns text language plpgsql as $f$
begin
  return (select coalesce(string_agg(x, ' ' order by x), '')
    from (select c.min_capacity || '-' || c.max_capacity || ':'
                 || (select string_agg(t.number::text, '+' order by t.number)
                       from public.table_combination_members m
                       join public.tables t on t.id = m.table_id
                      where m.combination_id = c.id) as x
            from public.table_combinations c
           where c.hall_id = 'a0d81000-0000-4000-8000-000000000001' and c.active) s);
end $f$;

-- Monta uma combinação ativa [T11,T12] direto (como postgres, sem claims).
create function pg_temp.semear_combo() returns text language sql as $f$
  select $q$with c as (insert into public.table_combinations (id, unit_id, hall_id, min_capacity, max_capacity)
      values ('a0d81000-0000-4000-8000-000000000c01', '{A}', '{S1}', 6, 8) returning id)
    insert into public.table_combination_members (combination_id, table_id, unit_id)
    select c.id, t, '{A}'::uuid from c, unnest(array['{T11}', '{T12}']::uuid[]) as t;$q$
$f$;

\o /dev/null
-- ═══ C-1 — gerente salva combinações pela planta ════════════════════════════
select pg_temp.caso(8501, 'C-1a gerente salva combinação 6-8 com T11+T12', 'GER',
  pg_temp.salvar('[{"min":6,"max":8,"table_ids":["{T11}","{T12}"]}]'), 'ok',
  $c$pg_temp.combos_s1() = '6-8:11+12'
     and (select count(*) from public.table_combination_members m
           join public.table_combinations c on c.id = m.combination_id
          where c.hall_id = '{S1}') = 2$c$);
select pg_temp.caso(8502, 'C-1b salvar o mesmo conjunto mantém o id e atualiza a faixa', 'postgres',
  pg_temp.semear_combo() || pg_temp.como('GER')
  || pg_temp.salvar('[{"min":5,"max":7,"table_ids":["{T12}","{T11}"]}]'), 'ok',
  $c$pg_temp.combos_s1() = '5-7:11+12'
     and (select count(*) from public.table_combinations where hall_id = '{S1}') = 1
     and exists (select 1 from public.table_combinations
                  where id = 'a0d81000-0000-4000-8000-000000000c01' and active)$c$);
select pg_temp.caso(8503, 'C-1c lista vazia desativa (não apaga) as combinações do salão', 'postgres',
  pg_temp.semear_combo() || pg_temp.como('GER') || pg_temp.salvar('[]'), 'ok',
  $c$pg_temp.combos_s1() = ''
     and exists (select 1 from public.table_combinations
                  where id = 'a0d81000-0000-4000-8000-000000000c01' and not active)$c$);
select pg_temp.caso(8504, 'C-1d várias combinações com mesas em comum', 'GER',
  pg_temp.salvar('[{"min":6,"max":8,"table_ids":["{T11}","{T12}"]},
                   {"min":8,"max":12,"table_ids":["{T11}","{T12}","{T13}"]},
                   {"min":5,"max":6,"table_ids":["{T13}","{T14}"]}]'), 'ok',
  $c$pg_temp.combos_s1() = '5-6:13+14 6-8:11+12 8-12:11+12+13'$c$);
select pg_temp.caso(8505, 'C-1e combinação que sai vira inativa e a que entra nasce com id novo', 'postgres',
  pg_temp.semear_combo() || pg_temp.como('GER')
  || pg_temp.salvar('[{"min":5,"max":6,"table_ids":["{T13}","{T14}"]}]'), 'ok',
  $c$pg_temp.combos_s1() = '5-6:13+14'
     and (select count(*) from public.table_combinations where hall_id = '{S1}') = 2$c$);

-- ═══ C-2 — operador não salva ═══════════════════════════════════════════════
select pg_temp.caso(8506, 'C-2 operador salva combinações', 'OPE',
  pg_temp.salvar('[{"min":6,"max":8,"table_ids":["{T11}","{T12}"]}]'), '42501 hall_plan_forbidden');

-- ═══ C-3 — mesa de outro salão ou unidade ═══════════════════════════════════
select pg_temp.caso(8507, 'C-3a combinação com mesa de S2', 'GER',
  pg_temp.salvar('[{"min":6,"max":8,"table_ids":["{T11}","{T21}"]}]'), '42501 hall_plan_forbidden');
select pg_temp.caso(8508, 'C-3b combinação com mesa de B', 'GER',
  pg_temp.salvar('[{"min":6,"max":8,"table_ids":["{T11}","{TB1}"]}]'), '42501 hall_plan_forbidden');
select pg_temp.caso(8509, 'C-3c combinação com mesa inexistente', 'GER',
  pg_temp.salvar('[{"min":6,"max":8,"table_ids":["{T11}","a0d81000-0000-4000-8000-0000000009ff"]}]'),
  '42501 hall_plan_forbidden');
select pg_temp.caso(8510, 'C-3d recusa não grava nada (combinação válida antes da inválida)', 'postgres',
  pg_temp.semear_combo() || pg_temp.como('GER') || $s$
  do $d$ begin
    perform public.save_hall_plan('{S1}', (select updated_at from public.halls where id = '{S1}'),
      '{"width_cm":800,"depth_cm":600,"entrance_wall":"bottom","entrance_offset_cm":100,"window_walls":[]}'::jsonb,
      '[]'::jsonb,
      '[{"min":5,"max":6,"table_ids":["{T13}","{T14}"]},{"min":6,"max":8,"table_ids":["{T11}","{TB1}"]}]'::jsonb);
  exception when insufficient_privilege then null;
  end $d$;
  select set_config('role', 'postgres', true)$s$, 'ok',
  $c$pg_temp.combos_s1() = '6-8:11+12'$c$);

-- ═══ C-4 — mesa não reservável não entra em combinação ══════════════════════
select pg_temp.caso(8511, 'C-4a combinação com mesa já não reservável', 'postgres',
  $s$update public.tables set bookable = false where id = '{T13}';
  $s$ || pg_temp.como('GER')
  || pg_temp.salvar('[{"min":4,"max":6,"table_ids":["{T12}","{T13}"]}]'), '42501 combination_invalid');
select pg_temp.caso(8512, 'C-4b desligar a mesa e combiná-la no mesmo payload', 'GER',
  pg_temp.salvar('[{"min":4,"max":6,"table_ids":["{T12}","{T13}"]}]',
    '[{"id":"{T13}","x":null,"y":null,"w":null,"h":null,"rotation":null,"shape":null,"bookable":false}]'),
  '42501 combination_invalid');
select pg_temp.caso(8513, 'C-4c combinação com mesa inativa', 'postgres',
  $s$update public.tables set active = false where id = '{T14}';
  $s$ || pg_temp.como('GER')
  || pg_temp.salvar('[{"min":4,"max":6,"table_ids":["{T13}","{T14}"]}]'), '42501 combination_invalid');

-- ═══ C-5 — payload malformado ═══════════════════════════════════════════════
select pg_temp.caso(8514, 'C-5a combinação de uma mesa', 'GER',
  pg_temp.salvar('[{"min":2,"max":4,"table_ids":["{T11}"]}]'), '22023 hall_plan_invalid');
select pg_temp.caso(8515, 'C-5b mesmo conjunto duas vezes (ordem diferente)', 'GER',
  pg_temp.salvar('[{"min":6,"max":8,"table_ids":["{T11}","{T12}"]},{"min":5,"max":7,"table_ids":["{T12}","{T11}"]}]'),
  '22023 hall_plan_invalid');
select pg_temp.caso(8516, 'C-5c mesa repetida na mesma combinação', 'GER',
  pg_temp.salvar('[{"min":6,"max":8,"table_ids":["{T11}","{T11}","{T12}"]}]'), '22023 hall_plan_invalid');
select pg_temp.caso(8517, 'C-5d faixa invertida cai no CHECK', 'GER',
  pg_temp.salvar('[{"min":8,"max":6,"table_ids":["{T11}","{T12}"]}]'), '23514 %table_combinations_capacity_range%');
select pg_temp.caso(8518, 'C-5e faixa em texto', 'GER',
  pg_temp.salvar('[{"min":"6","max":8,"table_ids":["{T11}","{T12}"]}]'), '22023 hall_plan_invalid');
select pg_temp.caso(8519, 'C-5f faixa não inteira', 'GER',
  pg_temp.salvar('[{"min":6.5,"max":8,"table_ids":["{T11}","{T12}"]}]'), '22023 hall_plan_invalid');
select pg_temp.caso(8520, 'C-5g chave faltando / objeto em vez de array / id não uuid', 'GER',
  $s$select count(*)::text from (values
     ($v$[{"min":6,"table_ids":["{T11}","{T12}"]}]$v$),
     ($v${"min":6,"max":8,"table_ids":["{T11}","{T12}"]}$v$),
     ($v$[{"min":6,"max":8,"table_ids":["{T11}","x"]}]$v$),
     ($v$[{"min":6,"max":8,"table_ids":"{T11}"}]$v$)) v(p)
   where pg_temp.salvar_recusa(p) = '22023'$s$, 'ok', $c$$1 = '4'$c$);
select pg_temp.caso(8521, 'C-5h bookable que não é boolean', 'GER',
  pg_temp.salvar(null,
    '[{"id":"{T13}","x":null,"y":null,"w":null,"h":null,"rotation":null,"shape":null,"bookable":"nao"}]'),
  '22023 hall_plan_invalid');

-- ═══ C-6 — desligar, desativar, mover ou apagar a mesa desativa a combinação ═
select pg_temp.caso(8522, 'C-6a gerente marca T11 não reservável', 'postgres',
  pg_temp.semear_combo() || pg_temp.como('GER') || $s$
  update public.tables set bookable = false where id = '{T11}';
  select set_config('role', 'postgres', true)$s$, 'ok',
  $c$pg_temp.combos_s1() = '' and (select count(*) from public.table_combinations where hall_id = '{S1}') = 1$c$);
select pg_temp.caso(8523, 'C-6b bookable false pela planta, sem mexer nas combinações', 'postgres',
  pg_temp.semear_combo() || pg_temp.como('GER')
  || pg_temp.salvar(null,
    '[{"id":"{T12}","x":null,"y":null,"w":null,"h":null,"rotation":null,"shape":null,"bookable":false}]'), 'ok',
  $c$pg_temp.combos_s1() = '' and not (select bookable from public.tables where id = '{T12}')$c$);
select pg_temp.caso(8524, 'C-6c mesa sai do salão ou é apagada', 'postgres',
  pg_temp.semear_combo() || $s$
  insert into public.table_combinations (id, unit_id, hall_id, min_capacity, max_capacity)
    values ('a0d81000-0000-4000-8000-000000000c02', '{A}', '{S1}', 5, 6);
  insert into public.table_combination_members (combination_id, table_id, unit_id)
    values ('a0d81000-0000-4000-8000-000000000c02', '{T13}', '{A}'),
           ('a0d81000-0000-4000-8000-000000000c02', '{T14}', '{A}');
  $s$ || pg_temp.como('GER') || $s$
  update public.tables set hall_id = '{S2}' where id = '{T12}';
  delete from public.tables where id = '{T14}';
  select set_config('role', 'postgres', true)$s$, 'ok',
  $c$pg_temp.combos_s1() = '' and (select count(*) from public.table_combinations where hall_id = '{S1}') = 2$c$);
select pg_temp.caso(8525, 'C-6d bookable ausente no payload não muda a mesa', 'postgres',
  $s$update public.tables set bookable = false where id = '{T13}';
  $s$ || pg_temp.como('GER')
  || pg_temp.salvar(null, '[{"id":"{T13}","x":null,"y":null,"w":null,"h":null,"rotation":null,"shape":null}]'), 'ok',
  $c$not (select bookable from public.tables where id = '{T13}')$c$);

-- ═══ C-7 — chamada de 4 argumentos (front publicado) ════════════════════════
select pg_temp.caso(8526, 'C-7 chamada nomeada de 4 argumentos não mexe nas combinações', 'postgres',
  pg_temp.semear_combo() || pg_temp.como('GER') || $s$
  select public.save_hall_plan(p_hall_id => '{S1}',
    p_expected_updated_at => (select updated_at from public.halls where id = '{S1}'),
    p_hall => '{"width_cm":800,"depth_cm":600,"entrance_wall":"bottom","entrance_offset_cm":100,"window_walls":[]}'::jsonb,
    p_tables => '[]'::jsonb)::text$s$, 'ok',
  $c$pg_temp.combos_s1() = '6-8:11+12'$c$);

-- ═══ C-8 — leitura ═══════════════════════════════════════════════════════════
select pg_temp.caso(8527, 'C-8a anon lê table_combinations', 'anon',
  $s$select count(*)::text from public.table_combinations$s$, '42501 permission denied%');
select pg_temp.caso(8528, 'C-8b anon lê table_combination_members', 'anon',
  $s$select count(*)::text from public.table_combination_members$s$, '42501 permission denied%');
select pg_temp.caso(8529, 'C-8c outsider não vê combinação nem membro', 'postgres',
  pg_temp.semear_combo() || pg_temp.como('OUT') || $s$
  select ((select count(*) from public.table_combinations)
        + (select count(*) from public.table_combination_members))::text$s$, 'ok', $c$$1 = '0'$c$);
select pg_temp.caso(8541, 'C-8d gerente de B não vê combinação de A', 'postgres',
  pg_temp.semear_combo() || pg_temp.como('GERB') || $s$
  select ((select count(*) from public.table_combinations)
        + (select count(*) from public.table_combination_members))::text$s$, 'ok', $c$$1 = '0'$c$);
select pg_temp.caso(8542, 'C-8e operador de A vê combinação e membros', 'postgres',
  pg_temp.semear_combo() || pg_temp.como('OPE') || $s$
  select ((select count(*) from public.table_combinations)
        + (select count(*) from public.table_combination_members))::text$s$, 'ok', $c$$1 = '3'$c$);

-- ═══ C-9 — platform_admin ════════════════════════════════════════════════════
select pg_temp.caso(8530, 'C-9 platform_admin sem membership salva combinação em A', 'PA',
  pg_temp.salvar('[{"min":6,"max":8,"table_ids":["{T11}","{T12}"]}]'), 'ok',
  $c$pg_temp.combos_s1() = '6-8:11+12'$c$);

-- ═══ C-10 — escrita direta pela API ═════════════════════════════════════════
select pg_temp.caso(8531, 'C-10a operador cria combinação direto', 'OPE',
  $s$insert into public.table_combinations (unit_id, hall_id, min_capacity, max_capacity)
     values ('{A}', '{S1}', 6, 8); select 'x'$s$, '42501 layout_write_forbidden');
select pg_temp.caso(8532, 'C-10b gerente de B cria combinação em A', 'GERB',
  $s$insert into public.table_combinations (unit_id, hall_id, min_capacity, max_capacity)
     values ('{A}', '{S1}', 6, 8); select 'x'$s$, '42501 layout_write_forbidden');
select pg_temp.caso(8533, 'C-10c gerente de A cria combinação num salão de B', 'GER',
  $s$insert into public.table_combinations (unit_id, hall_id, min_capacity, max_capacity)
     values ('{A}', '{SB}', 6, 8); select 'x'$s$, '42501 combination_invalid');
select pg_temp.caso(8534, 'C-10d gerente põe mesa de S2 numa combinação de S1', 'postgres',
  pg_temp.semear_combo() || pg_temp.como('GER') || $s$
  insert into public.table_combination_members (combination_id, table_id, unit_id)
    values ('a0d81000-0000-4000-8000-000000000c01', '{T21}', '{A}'); select 'x'$s$,
  '42501 combination_invalid');
select pg_temp.caso(8535, 'C-10e gerente reativa combinação desativada', 'postgres',
  pg_temp.semear_combo() || $s$
  update public.table_combinations set active = false where id = 'a0d81000-0000-4000-8000-000000000c01';
  $s$ || pg_temp.como('GER') || $s$
  update public.table_combinations set active = true where id = 'a0d81000-0000-4000-8000-000000000c01';
  select 'x'$s$, '42501 combination_invalid');
select pg_temp.caso(8536, 'C-10f gerente move combinação para outro salão', 'postgres',
  pg_temp.semear_combo() || pg_temp.como('GER') || $s$
  update public.table_combinations set hall_id = '{S2}' where id = 'a0d81000-0000-4000-8000-000000000c01';
  select 'x'$s$, '42501 combination_invalid');
select pg_temp.caso(8537, 'C-10g gerente apaga combinação direto', 'postgres',
  pg_temp.semear_combo() || pg_temp.como('GER') || $s$
  delete from public.table_combinations where id = 'a0d81000-0000-4000-8000-000000000c01';
  select 'x'$s$, '42501 permission denied%');
select pg_temp.caso(8538, 'C-10h salão sem mesas mas com combinação não muda de unidade', 'postgres',
  $s$insert into public.halls (id, unit_id, name) values ('a0d81000-0000-4000-8000-000000000004', '{A}', 'S3');
     insert into public.table_combinations (unit_id, hall_id, min_capacity, max_capacity)
     values ('{A}', 'a0d81000-0000-4000-8000-000000000004', 6, 8);
     update public.halls set unit_id = '{B}' where id = 'a0d81000-0000-4000-8000-000000000004';
     select 'x'$s$, '42501 hall_unit_mismatch');

-- ═══ Controles positivos ════════════════════════════════════════════════════
select pg_temp.caso(8539, 'C-CP1 sem o guard de membro, mesa não reservável entra', 'postgres',
  $s$alter table public.table_combination_members disable trigger table_combination_members_write_unit_guard;
     update public.tables set bookable = false where id = '{T13}';
     insert into public.table_combinations (id, unit_id, hall_id, min_capacity, max_capacity)
       values ('a0d81000-0000-4000-8000-000000000c03', '{A}', '{S1}', 4, 6);
     insert into public.table_combination_members (combination_id, table_id, unit_id)
       values ('a0d81000-0000-4000-8000-000000000c03', '{T12}', '{A}'),
              ('a0d81000-0000-4000-8000-000000000c03', '{T13}', '{A}');
     select 'x'$s$, 'ok',
  $c$pg_temp.combos_s1() = '4-6:12+13'$c$);
select pg_temp.caso(8540, 'C-CP2 sem o trigger de desativação, a combinação segue ativa', 'postgres',
  $s$alter table public.tables disable trigger tables_deactivate_combinations;
  $s$ || pg_temp.semear_combo() || $s$
     update public.tables set bookable = false where id = '{T11}'; select 'x'$s$, 'ok',
  $c$pg_temp.combos_s1() = '6-8:11+12'$c$);

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
  if v_fail > 0 then raise exception '83: % caso(s) divergente(s)', v_fail; end if;
end $$;
rollback;
