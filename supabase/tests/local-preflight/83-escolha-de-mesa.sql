-- 83: escolha de mesa — combinações (C-*), ocupação multi-mesa (S-*, X-*, R-*).
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
  ('R1', '101'), ('R2', '102'), ('CA', 'ca1'), ('CB', 'cb1');
update t_ids set id = 'a0d81000-0000-4000-8000-' || lpad(id, 12, '0');

-- Canais de WhatsApp de A e B (Task 3; desfeitos no ROLLBACK final).
insert into public.whatsapp_channels (id, unit_id, display_phone) values
  ('a0d81000-0000-4000-8000-000000000ca1', 'a0d81000-0000-4000-8000-0000000000aa', '11999990001'),
  ('a0d81000-0000-4000-8000-000000000cb1', 'a0d81000-0000-4000-8000-0000000000bb', '11999990002');

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

-- ═══════════════════════════════════════════════════════════════════════════
-- Task 2 — ocupação multi-mesa (S-*), exclusão (X-*), RPCs da recepção (R-*)
-- ═══════════════════════════════════════════════════════════════════════════
-- Fixtures novas nascem dentro de cada caso (desfeito). Datas e horas
-- relativas ao now() da transação em BRT: D1 = amanhã; DN0/TN0 = agora;
-- DN30/TN30 = agora + 30 min. Reservas de amanhã às 19:00 não cruzam janela
-- nenhuma de "sentado agora".
insert into t_ids values
  ('N1', 'a0d81000-0000-4000-8000-000000000501'), ('N2', 'a0d81000-0000-4000-8000-000000000502'),
  ('N3', 'a0d81000-0000-4000-8000-000000000503'), ('N4', 'a0d81000-0000-4000-8000-000000000504'),
  ('N5', 'a0d81000-0000-4000-8000-000000000505'), ('N6', 'a0d81000-0000-4000-8000-000000000506'),
  ('N7', 'a0d81000-0000-4000-8000-000000000507'),
  ('WN1', 'a0d81000-0000-4000-8000-000000000601'), ('WN2', 'a0d81000-0000-4000-8000-000000000602'),
  ('W1', 'a0d81000-0000-4000-8000-000000000201'), ('W4', 'a0d81000-0000-4000-8000-000000000204'),
  ('P1', 'a0d81000-0000-4000-8000-000000000301'), ('PB', 'a0d81000-0000-4000-8000-0000000003b1'),
  ('RB', 'a0d81000-0000-4000-8000-0000000001b1'), ('F1', 'a0d81000-0000-4000-8000-0000000000f1'),
  ('D1', ((now() at time zone 'America/Sao_Paulo')::date + 1)::text),
  ('DN0', (now() at time zone 'America/Sao_Paulo')::date::text),
  ('TN0', to_char(now() at time zone 'America/Sao_Paulo', 'HH24:MI:SS')),
  ('DN30', ((now() + interval '30 minutes') at time zone 'America/Sao_Paulo')::date::text),
  ('TN30', to_char((now() + interval '30 minutes') at time zone 'America/Sao_Paulo', 'HH24:MI:SS'));

-- Reserva de A, cliente F1, código P83-<token>. Mesa e data são tokens.
create function pg_temp.res(p_tok text, p_mesa text, p_data text, p_hora text,
                            p_status text default 'confirmed', p_party int default 4)
returns text language sql as $f$
  select format($q$insert into public.reservations (id, customer_id, table_id, date, time, party_size, status, reservation_code, unit_id)
    values ('{%s}', '{F1}', %s, '{%s}', '%s', %s, '%s', 'P83-%s', '{A}');$q$,
    p_tok, case when p_mesa is null then 'null' else '''{' || p_mesa || '}''' end,
    p_data, p_hora, p_party, p_status, p_tok)
$f$;

-- Passante de A sentado agora na mesa dada.
create function pg_temp.passante(p_tok text, p_mesa text) returns text language sql as $f$
  select format($q$insert into public.walk_ins (id, unit_id, customer_name, party_size, status, table_id, seated_at)
    values ('{%s}', '{A}', 'Passante %s', 2, 'seated', '{%s}', now());$q$, p_tok, p_tok, p_mesa)
$f$;

-- Mesas (números) do ocupante em occupant_tables, '-' se nenhuma.
-- plpgsql: o corpo só é resolvido na chamada (o RED roda sem as tabelas).
create function pg_temp.mesas(p_id uuid) returns text language plpgsql as $f$
begin
  return (select coalesce(string_agg(t.number::text, '+' order by t.number), '-')
            from public.occupant_tables ot join public.tables t on t.id = ot.table_id
           where p_id in (ot.reservation_id, ot.walk_in_id, ot.waitlist_id));
end $f$;

-- blocks_slot/overlap_ok por mesa do ocupante: '13:t/f 14:t/f'.
create function pg_temp.flags(p_id uuid) returns text language plpgsql as $f$
begin
  return (select coalesce(string_agg(t.number || ':' || left(ot.blocks_slot::text, 1) || '/'
                                     || left(ot.overlap_ok::text, 1), ' ' order by t.number), '-')
            from public.occupant_tables ot join public.tables t on t.id = ot.table_id
           where p_id in (ot.reservation_id, ot.walk_in_id, ot.waitlist_id));
end $f$;

-- Contagens por status de reservations, walk_ins e waitlist.
create function pg_temp.contagens() returns text language plpgsql as $f$
begin
  return (select string_agg(x, '|' order by x) from (
    select 'r:' || string_agg(status || '=' || n, ',' order by status) as x
      from (select status, count(*) n from public.reservations group by 1) a
    union all
    select 'w:' || string_agg(status || '=' || n, ',' order by status)
      from (select status, count(*) n from public.walk_ins group by 1) b
    union all
    select 'q:' || string_agg(status || '=' || n, ',' order by status)
      from (select status, count(*) n from public.waitlist group by 1) c) s);
end $f$;

-- Linha para insert_reservation_with_tables (colunas do reserveSlot).
create function pg_temp.linha(p_tok text, p_hora text, p_extra text default '') returns text language sql as $f$
  select format($q$jsonb_build_object('customer_id', '{F1}', 'unit_id', '{A}', 'date', '{D1}', 'time', '%s',
      'party_size', 6, 'reservation_code', 'P83-%s', 'status', 'confirmed', 'table_choice', 'customer'%s)$q$,
    p_hora, p_tok, p_extra)
$f$;

-- ═══ S — sincronia a partir do table_id legado ══════════════════════════════
select pg_temp.caso(8550, 'S-1 INSERT de reserva com mesa cria 1 linha que bloqueia', 'postgres',
  pg_temp.res('N1', 'T13', 'D1', '19:00') || $s$ select 'x'$s$, 'ok',
  $c$pg_temp.flags('{N1}') = '13:t/f'
     and (select lower(slot) = ('{D1}'::date + time '19:00') at time zone 'America/Sao_Paulo'
                 and upper(slot) - lower(slot) = interval '90 minutes'
            from public.occupant_tables where reservation_id = '{N1}')$c$);
select pg_temp.caso(8551, 'S-2 UPDATE de table_id troca a linha', 'postgres',
  pg_temp.res('N1', 'T13', 'D1', '19:00') || $s$
  update public.reservations set table_id = '{T14}' where id = '{N1}'; select 'x'$s$, 'ok',
  $c$pg_temp.mesas('{N1}') = '14'$c$);
select pg_temp.caso(8552, 'S-3 table_id nulo apaga as linhas', 'postgres',
  pg_temp.res('N1', 'T13', 'D1', '19:00') || $s$
  update public.reservations set table_id = null where id = '{N1}'; select 'x'$s$, 'ok',
  $c$pg_temp.mesas('{N1}') = '-'$c$);
select pg_temp.caso(8553, 'S-4a seat_waitlist_entry cria a linha da fila', 'OPE',
  $s$select public.seat_waitlist_entry('{W1}', '{T13}')::text$s$, 'ok',
  $c$pg_temp.flags('{W1}') = '13:f/f'$c$);
select pg_temp.caso(8554, 'S-4b passante sentado cria linha sem janela', 'postgres',
  pg_temp.passante('WN1', 'T13') || $s$ select 'x'$s$, 'ok',
  $c$pg_temp.flags('{WN1}') = '13:f/f'
     and (select slot is null from public.occupant_tables where walk_in_id = '{WN1}')$c$);
select pg_temp.caso(8555, 'S-4c backfill: reservas, passantes e fila do 81a', 'postgres',
  $s$select 'x'$s$, 'ok',
  $c$pg_temp.mesas('{R1}') || ',' || pg_temp.mesas('{R2}') || ',' || pg_temp.mesas('{P1}') || ','
     || pg_temp.mesas('{PB}') || ',' || pg_temp.mesas('{W4}') = '11,12,12,31,-'$c$);
select pg_temp.caso(8556, 'S-5 cancelar a reserva zera blocks_slot', 'postgres',
  pg_temp.res('N1', 'T13', 'D1', '19:00') || $s$
  update public.reservations set status = 'cancelled' where id = '{N1}'; select 'x'$s$, 'ok',
  $c$pg_temp.flags('{N1}') = '13:f/f'$c$);
select pg_temp.caso(8557, 'S-6 reserva de A com mesa de B → table_unit_mismatch', 'postgres',
  pg_temp.res('N1', 'TB1', 'D1', '19:00') || $s$ select 'x'$s$, '42501 table_unit_mismatch');
select pg_temp.caso(8558, 'S-7 mudar a hora recalcula a janela', 'postgres',
  pg_temp.res('N1', 'T13', 'D1', '19:00') || $s$
  update public.reservations set time = '21:00' where id = '{N1}'; select 'x'$s$, 'ok',
  $c$(select lower(slot) = ('{D1}'::date + time '21:00') at time zone 'America/Sao_Paulo'
        from public.occupant_tables where reservation_id = '{N1}')$c$);
select pg_temp.caso(8559, 'S-CP sem o trigger de sincronia, nenhuma linha nasce', 'postgres',
  $s$alter table public.reservations disable trigger reservations_occupant_sync;
  $s$ || pg_temp.res('N1', 'T13', 'D1', '19:00') || $s$ select 'x'$s$, 'ok',
  $c$pg_temp.mesas('{N1}') = '-'$c$);

-- ═══ X — exclusão por janela ════════════════════════════════════════════════
select pg_temp.caso(8560, 'X-1 mesma mesa 19:00 e 19:30 (90 min) → 23P01', 'postgres',
  pg_temp.res('N1', 'T13', 'D1', '19:00') || pg_temp.res('N2', 'T13', 'D1', '19:30') || $s$ select 'x'$s$,
  '23P01 %occupant_tables_no_overlap%');
select pg_temp.caso(8561, 'X-2 mesma mesa 19:00 e 20:30 → ok', 'postgres',
  pg_temp.res('N1', 'T13', 'D1', '19:00') || pg_temp.res('N2', 'T13', 'D1', '20:30') || $s$ select 'x'$s$, 'ok',
  $c$pg_temp.flags('{N1}') = '13:t/f' and pg_temp.flags('{N2}') = '13:t/f'$c$);
select pg_temp.caso(8562, 'X-3a combinação T13+T14 às 19:00 e T14 sozinha às 19:30 → 23P01', 'service_role',
  'select public.insert_reservation_with_tables(' || pg_temp.linha('N1', '19:00') || $s$, array['{T13}', '{T14}']::uuid[]);
   select public.insert_reservation_with_tables($s$ || pg_temp.linha('N2', '19:30') || $s$, array['{T14}']::uuid[])::text$s$,
  '23P01 %occupant_tables_no_overlap%');
select pg_temp.caso(8563, 'X-3b a reserva recusada não deixa linha nenhuma', 'service_role',
  'select public.insert_reservation_with_tables(' || pg_temp.linha('N1', '19:00') || $s$, array['{T13}', '{T14}']::uuid[]);
   do $d$ begin
     perform public.insert_reservation_with_tables($s$ || pg_temp.linha('N2', '19:30') || $s$, array['{T14}']::uuid[]);
   exception when exclusion_violation then perform set_config('t83.x3', 'recusou', true);
   end $d$;
   select current_setting('t83.x3', true) || ':' || (select count(*) from public.reservations where reservation_code = 'P83-N2')$s$,
  'ok', $c$$1 = 'recusou:0'$c$);
select pg_temp.caso(8564, 'X-4 controle: sem a exclusão, o X-1 grava', 'postgres',
  $s$alter table public.occupant_tables drop constraint occupant_tables_no_overlap;
  $s$ || pg_temp.res('N1', 'T13', 'D1', '19:00') || pg_temp.res('N2', 'T13', 'D1', '19:30') || $s$ select 'x'$s$, 'ok',
  $c$pg_temp.flags('{N2}') = '13:t/f'$c$);

-- ═══ R — RPCs da recepção ═══════════════════════════════════════════════════
select pg_temp.caso(8570, 'R-1 operador junta T13+T14 para reserva a chegar', 'postgres',
  pg_temp.res('N3', 'T13', 'D1', '19:00') || pg_temp.como('OPE') || $s$
  select public.set_occupant_tables('reservation', '{N3}', array['{T13}', '{T14}']::uuid[])::text$s$, 'ok',
  $c$$1::jsonb ->> 'status' = 'ok' and pg_temp.flags('{N3}') = '13:t/f 14:t/f'
     and (select table_id::text || table_choice || status from public.reservations where id = '{N3}') = '{T13}staffconfirmed'
     and (select count(*) from public.occupancy_events
           where reservation_id = '{N3}' and kind = 'tables_changed' and unit_id = '{A}'
             and before -> 'tables' = '[13]' and after -> 'tables' = '[13, 14]'
             and actor_user_id = '{OPE}') = 1$c$);
select pg_temp.caso(8571, 'R-2 mesma junção repetida → noop sem evento novo', 'postgres',
  pg_temp.res('N3', 'T13', 'D1', '19:00') || pg_temp.como('OPE') || $s$
  select public.set_occupant_tables('reservation', '{N3}', array['{T13}', '{T14}']::uuid[]);
  select public.set_occupant_tables('reservation', '{N3}', array['{T14}', '{T13}']::uuid[])::text$s$, 'ok',
  $c$$1::jsonb ->> 'status' = 'noop'
     and (select count(*) from public.occupancy_events where reservation_id = '{N3}') = 1$c$);
select pg_temp.caso(8572, 'R-3 mesa de B → seat_forbidden', 'postgres',
  pg_temp.res('N3', 'T13', 'D1', '19:00') || pg_temp.como('GER') || $s$
  select public.set_occupant_tables('reservation', '{N3}', array['{T13}', '{TB1}']::uuid[])::text$s$,
  '42501 seat_forbidden');
select pg_temp.caso(8573, 'R-4a gerente de A na reserva de B → seat_forbidden', 'GER',
  $s$select public.set_occupant_tables('reservation', '{RB}', array['{T13}']::uuid[])::text$s$,
  '42501 seat_forbidden');
select pg_temp.caso(8574, 'R-4b id inexistente → a mesma mensagem', 'GER',
  $s$select public.set_occupant_tables('reservation', gen_random_uuid(), array['{T13}']::uuid[])::text$s$,
  '42501 seat_forbidden');
select pg_temp.caso(8575, 'R-5a passante sentado para mesa com reserva daqui a 30 min → conflict sem gravar', 'postgres',
  pg_temp.passante('WN1', 'T13') || pg_temp.res('N4', 'T14', 'DN30', '{TN30}') || pg_temp.como('OPE') || $s$
  select public.set_occupant_tables('walk_in', '{WN1}', array['{T14}']::uuid[])::text$s$, 'ok',
  $c$$1::jsonb ->> 'status' = 'conflict'
     and $1::jsonb -> 'conflicts' -> 0 ->> 'reservation_id' = '{N4}'
     and $1::jsonb -> 'conflicts' -> 0 ->> 'table_number' = '14'
     and $1::jsonb -> 'conflicts' -> 0 ->> 'customer_name' = 'Cliente 81'
     and $1::jsonb -> 'conflicts' -> 0 ->> 'time' = left('{TN30}', 5)
     and pg_temp.mesas('{WN1}') = '13'
     and (select count(*) from public.occupancy_events) = 0$c$);
select pg_temp.caso(8576, 'R-5b o mesmo com p_allow_overlap → grava e marca overlap_ok', 'postgres',
  pg_temp.passante('WN1', 'T13') || pg_temp.res('N4', 'T14', 'DN30', '{TN30}') || pg_temp.como('OPE') || $s$
  select public.set_occupant_tables('walk_in', '{WN1}', array['{T14}']::uuid[], true)::text$s$, 'ok',
  $c$$1::jsonb ->> 'status' = 'ok' and pg_temp.flags('{WN1}') = '14:f/t' and pg_temp.flags('{N4}') = '14:t/f'
     and (select table_id from public.walk_ins where id = '{WN1}') = '{T14}'
     and (select (after ->> 'overlap_confirmed')::boolean from public.occupancy_events where walk_in_id = '{WN1}')$c$);
select pg_temp.caso(8577, 'R-5c reserva a chegar sobreposta com confirmação: a linha dela não bloqueia', 'postgres',
  pg_temp.res('N5', 'T13', 'D1', '19:00') || pg_temp.res('N6', 'T14', 'D1', '19:30') || pg_temp.como('GER') || $s$
  select public.set_occupant_tables('reservation', '{N6}', array['{T13}']::uuid[], true)::text$s$, 'ok',
  $c$$1::jsonb ->> 'status' = 'ok' and pg_temp.flags('{N6}') = '13:f/t' and pg_temp.flags('{N5}') = '13:t/f'$c$);
select pg_temp.caso(8578, 'R-5d mudar a hora da sobreposta desfaz overlap_ok e a exclusão volta → 23P01', 'postgres',
  pg_temp.res('N5', 'T13', 'D1', '19:00') || pg_temp.res('N6', 'T14', 'D1', '19:30') || pg_temp.como('GER') || $s$
  select public.set_occupant_tables('reservation', '{N6}', array['{T13}']::uuid[], true);
  select set_config('role', 'postgres', true);
  update public.reservations set time = '19:45' where id = '{N6}'; select 'x'$s$,
  '23P01 %occupant_tables_no_overlap%');
select pg_temp.caso(8579, 'R-6 mesa com bloqueio na janela → seat_blocked', 'postgres',
  pg_temp.res('N3', 'T13', 'D1', '19:00') || $s$
  insert into public.table_blocks (unit_id, table_id, blocked_from, blocked_to, title)
  values ('{A}', '{T14}', ('{D1}'::date + time '18:00') at time zone 'America/Sao_Paulo',
          ('{D1}'::date + time '23:00') at time zone 'America/Sao_Paulo', 'Manutenção');
  $s$ || pg_temp.como('OPE') || $s$
  select public.set_occupant_tables('reservation', '{N3}', array['{T14}']::uuid[])::text$s$,
  '23514 seat_blocked');
select pg_temp.caso(8580, 'R-7a ajustar pessoas 4 → 8 guarda o original e o evento', 'postgres',
  pg_temp.res('N3', 'T13', 'D1', '19:00') || pg_temp.como('OPE') || $s$
  select public.set_occupant_party_size('reservation', '{N3}', 8)::text$s$, 'ok',
  $c$$1 = 'true'
     and (select party_size || '/' || original_party_size || '/' || status from public.reservations where id = '{N3}') = '8/4/confirmed'
     and (select count(*) from public.occupancy_events where reservation_id = '{N3}' and kind = 'party_size_changed'
             and before = '{"party_size": 4}' and after = '{"party_size": 8}') = 1$c$);
select pg_temp.caso(8581, 'R-7b 4 → 8 → 6: original fica 4; 6 → 6 devolve false', 'postgres',
  pg_temp.res('N3', 'T13', 'D1', '19:00') || pg_temp.como('OPE') || $s$
  select public.set_occupant_party_size('reservation', '{N3}', 8);
  select public.set_occupant_party_size('reservation', '{N3}', 6);
  select public.set_occupant_party_size('reservation', '{N3}', 6)::text$s$, 'ok',
  $c$$1 = 'false'
     and (select party_size || '/' || original_party_size from public.reservations where id = '{N3}') = '6/4'
     and (select count(*) from public.occupancy_events where reservation_id = '{N3}') = 2$c$);
select pg_temp.caso(8582, 'R-7c 0 pessoas → 22023', 'OPE',
  $s$select public.set_occupant_party_size('reservation', '{R1}', 0)::text$s$, '22023 seat_action_invalid');
select pg_temp.caso(8583, 'R-7d 51 pessoas → 22023', 'OPE',
  $s$select public.set_occupant_party_size('reservation', '{R1}', 51)::text$s$, '22023 seat_action_invalid');
select pg_temp.caso(8584, 'R-7e passante: ajustar pessoas 2 → 5', 'postgres',
  pg_temp.passante('WN1', 'T13') || pg_temp.como('OPE') || $s$
  select public.set_occupant_party_size('walk_in', '{WN1}', 5)::text$s$, 'ok',
  $c$$1 = 'true' and (select party_size || '/' || original_party_size || '/' || status
                        from public.walk_ins where id = '{WN1}') = '5/2/seated'$c$);
select pg_temp.caso(8585, 'R-8a mesa com passante sentado (P1 do 81a, backfill) → seat_taken', 'postgres',
  pg_temp.passante('WN2', 'T21') || pg_temp.como('OPE') || $s$
  select public.set_occupant_tables('walk_in', '{WN2}', array['{T12}']::uuid[])::text$s$,
  '23514 seat_taken');
select pg_temp.caso(8586, 'R-8b mesa com reserva que já chegou → seat_taken', 'postgres',
  pg_temp.res('N7', 'T14', 'DN0', '{TN0}') || $s$
  update public.reservations set arrived_at = now() where id = '{N7}';
  $s$ || pg_temp.passante('WN2', 'T21') || pg_temp.como('OPE') || $s$
  select public.set_occupant_tables('walk_in', '{WN2}', array['{T14}']::uuid[])::text$s$,
  '23514 seat_taken');
select pg_temp.caso(8587, 'R-8c passante já liberado não segura a mesa', 'postgres',
  pg_temp.passante('WN1', 'T13') || $s$
  update public.walk_ins set released_at = now() where id = '{WN1}';
  $s$ || pg_temp.passante('WN2', 'T21') || pg_temp.como('OPE') || $s$
  select public.set_occupant_tables('walk_in', '{WN2}', array['{T13}']::uuid[])::text$s$, 'ok',
  $c$$1::jsonb ->> 'status' = 'ok' and pg_temp.mesas('{WN2}') = '13'$c$);
select pg_temp.caso(8588, 'R-8d reserva cancelada não é ocupante → seat_action_invalid', 'postgres',
  pg_temp.res('N3', 'T13', 'D1', '19:00', 'cancelled') || pg_temp.como('OPE') || $s$
  select public.set_occupant_tables('reservation', '{N3}', array['{T14}']::uuid[])::text$s$,
  '23514 seat_action_invalid');
select pg_temp.caso(8589, 'R-9a anon sem EXECUTE em set_occupant_tables', 'anon',
  $s$select public.set_occupant_tables('reservation', '{R1}', array['{T13}']::uuid[])::text$s$,
  '42501 permission denied%');
select pg_temp.caso(8590, 'R-9b anon sem EXECUTE em set_occupant_party_size', 'anon',
  $s$select public.set_occupant_party_size('reservation', '{R1}', 3)::text$s$, '42501 permission denied%');
select pg_temp.caso(8591, 'R-9c authenticated sem membership → seat_forbidden', 'OUT',
  $s$select public.set_occupant_tables('reservation', '{R1}', array['{T13}']::uuid[])::text$s$,
  '42501 seat_forbidden');
select pg_temp.caso(8592, 'R-9d authenticated sem membership ajustando pessoas → seat_forbidden', 'OUT',
  $s$select public.set_occupant_party_size('reservation', '{R1}', 3)::text$s$, '42501 seat_forbidden');
select pg_temp.caso(8593, 'R-10a insert_reservation_with_tables por authenticated → permission denied', 'GER',
  'select public.insert_reservation_with_tables(' || pg_temp.linha('N1', '19:00') || $s$, array['{T13}']::uuid[])::text$s$,
  '42501 permission denied%');
select pg_temp.caso(8594, 'R-10b service_role grava reserva com T13+T14 numa transação', 'service_role',
  'select public.insert_reservation_with_tables(' || pg_temp.linha('N1', '19:00') || $s$, array['{T13}', '{T14}']::uuid[])::text$s$,
  'ok',
  $c$pg_temp.flags($1::uuid) = '13:t/f 14:t/f'
     and (select table_id::text || table_choice || party_size from public.reservations where id = $1::uuid) = '{T13}customer6'$c$);
select pg_temp.caso(8595, 'R-10c mesa não reservável no caminho automático → seat_forbidden', 'postgres',
  $s$update public.tables set bookable = false where id = '{T14}';
     select set_config('role', 'service_role', true);
     select public.insert_reservation_with_tables($s$ || pg_temp.linha('N1', '19:00') || $s$, array['{T13}', '{T14}']::uuid[])::text$s$,
  '42501 seat_forbidden');
select pg_temp.caso(8596, 'R-10d coluna fora da lista (id) → 22023', 'service_role',
  'select public.insert_reservation_with_tables(' || pg_temp.linha('N1', '19:00', $x$, 'id', '{N1}'$x$) || $s$, array['{T13}']::uuid[])::text$s$,
  '22023 reservation_row_invalid');
select pg_temp.caso(8597, 'R-11 platform_admin sem membership troca a mesa em A', 'postgres',
  pg_temp.res('N3', 'T13', 'D1', '19:00') || pg_temp.como('PA') || $s$
  select public.set_occupant_tables('reservation', '{N3}', array['{T14}']::uuid[])::text$s$, 'ok',
  $c$$1::jsonb ->> 'status' = 'ok' and pg_temp.mesas('{N3}') = '14'
     and (select actor_user_id from public.occupancy_events where reservation_id = '{N3}') = '{PA}'$c$);
select pg_temp.caso(8598, 'R-12 trocar, juntar e ajustar não mudam contagens por status', 'postgres',
  pg_temp.res('N3', 'T13', 'D1', '19:00') || pg_temp.passante('WN1', 'T21') || $s$
  select public.seat_waitlist_entry('{W1}', '{T11}');
  select set_config('t83.antes', pg_temp.contagens(), true);
  $s$ || pg_temp.como('OPE') || $s$
  select public.set_occupant_tables('reservation', '{N3}', array['{T13}', '{T14}']::uuid[]);
  select public.set_occupant_tables('walk_in', '{WN1}', array['{T21}', '{T13}']::uuid[], true);
  select public.set_occupant_party_size('reservation', '{N3}', 9);
  select public.set_occupant_party_size('walk_in', '{WN1}', 3);
  select public.set_occupant_tables('waitlist', '{W1}', array['{T11}', '{T14}']::uuid[], true);
  select public.set_occupant_party_size('waitlist', '{W1}', 4)::text$s$, 'ok',
  $c$$1 = 'true' and pg_temp.contagens() = current_setting('t83.antes')
     and (select count(*) from public.occupancy_events) = 6$c$);
select pg_temp.caso(8599, 'R-13 recepção usa mesa não reservável e de outro salão', 'postgres',
  pg_temp.res('N3', 'T13', 'D1', '19:00') || $s$
  update public.tables set bookable = false where id = '{T14}';
  $s$ || pg_temp.como('OPE') || $s$
  select public.set_occupant_tables('reservation', '{N3}', array['{T14}', '{T21}']::uuid[])::text$s$, 'ok',
  $c$$1::jsonb ->> 'status' = 'ok' and pg_temp.mesas('{N3}') = '14+21'
     and (select table_id from public.reservations where id = '{N3}') = '{T14}'$c$);
select pg_temp.caso(8611, 'R-14a authenticated não escreve occupant_tables direto', 'GER',
  $s$insert into public.occupant_tables (unit_id, table_id, reservation_id) values ('{A}', '{T13}', '{R1}'); select 'x'$s$,
  '42501 permission denied%');
select pg_temp.caso(8612, 'R-14b gerente de B só vê a ocupação de B (RB e PB)', 'GERB',
  $s$select count(*)::text from public.occupant_tables$s$, 'ok', $c$$1 = '2'$c$);
select pg_temp.caso(8613, 'R-14c outsider não vê ocupação', 'OUT',
  $s$select count(*)::text from public.occupant_tables$s$, 'ok', $c$$1 = '0'$c$);
select pg_temp.caso(8614, 'R-14d anon sem privilégio em occupant_tables', 'anon',
  $s$select count(*)::text from public.occupant_tables$s$, '42501 permission denied%');
select pg_temp.caso(8615, 'R-14e anon sem privilégio em occupancy_events', 'anon',
  $s$select count(*)::text from public.occupancy_events$s$, '42501 permission denied%');
select pg_temp.caso(8616, 'R-14f operador de A vê ocupação e histórico da unidade', 'postgres',
  pg_temp.res('N3', 'T13', 'D1', '19:00') || pg_temp.como('OPE') || $s$
  select public.set_occupant_party_size('reservation', '{N3}', 5);
  select (select count(*) from public.occupant_tables) || '/' || (select count(*) from public.occupancy_events)$s$,
  'ok', $c$$1 = '4/1'$c$);
select pg_temp.caso(8617, 'R-14g gerente de B não vê o histórico de A', 'postgres',
  pg_temp.res('N3', 'T13', 'D1', '19:00') || pg_temp.como('OPE') || $s$
  select public.set_occupant_party_size('reservation', '{N3}', 5);
  $s$ || pg_temp.como('GERB') || $s$
  select count(*)::text from public.occupancy_events$s$, 'ok', $c$$1 = '0'$c$);
select pg_temp.caso(8618, 'R-15a mesa repetida em p_table_ids → 22023', 'OPE',
  $s$select public.set_occupant_tables('reservation', '{R1}', array['{T13}', '{T13}']::uuid[])::text$s$,
  '22023 seat_action_invalid');
select pg_temp.caso(8619, 'R-15b p_kind inválido → 22023', 'OPE',
  $s$select public.set_occupant_tables('customer', '{R1}', array['{T13}']::uuid[])::text$s$,
  '22023 seat_action_invalid');
select pg_temp.caso(8620, 'R-15c p_table_ids vazio → 22023', 'OPE',
  $s$select public.set_occupant_tables('reservation', '{R1}', array[]::uuid[])::text$s$,
  '22023 seat_action_invalid');

-- ═══ K-*: links de escolha e limite do mapa público (Task 3) ═════════════════
-- INSERT de link (SQL a rodar como o ator do caso); campos sobrescrevíveis.
create function pg_temp.link(p_hall text default '{S1}', p_channel text default '{CA}',
                             p_hash text default null, p_party int default 4,
                             p_ttl text default '6 hours', p_unit text default '{A}')
returns text language sql as $f$
  select format($q$insert into public.seat_choice_links
      (unit_id, hall_id, channel_id, date, time, party_size, token_hash, expires_at)
    values ('%s', %s, %s, current_date, '19:00', %s, %L, now() + interval %L) returning id::text$q$,
    p_unit, quote_literal(p_hall) || '::uuid',
    case when p_channel is null then 'null' else quote_literal(p_channel) || '::uuid' end,
    p_party, coalesce(p_hash, repeat('ab', 32)), p_ttl)
$f$;

-- Chamada da RPC de limite; p_unit nulo = modo token.
create function pg_temp.rl(p_unit text, p_ip text default 'a') returns text language sql as $f$
  select format('public.check_public_seat_map_rate_limit(%s, %L)',
    case when p_unit is null then 'null::uuid' else quote_literal(p_unit) || '::uuid' end,
    'public-seat-map-ip:' || repeat(p_ip, 64))
$f$;

select pg_temp.caso(8601, 'K-1a anon lê seat_choice_links', 'anon',
  $s$select count(*)::text from public.seat_choice_links$s$, '42501 permission denied%');
select pg_temp.caso(8602, 'K-1b anon grava seat_choice_links', 'anon',
  pg_temp.link(), '42501 permission denied%');
select pg_temp.caso(8603, 'K-1c gerente de A lê seat_choice_links', 'GER',
  $s$select count(*)::text from public.seat_choice_links$s$, '42501 permission denied%');
select pg_temp.caso(8604, 'K-1d gerente de A grava seat_choice_links', 'GER',
  pg_temp.link(), '42501 permission denied%');
select pg_temp.caso(8605, 'K-2a service_role grava e lê o link pelo hash', 'service_role',
  pg_temp.link() || $s$; select count(*)::text from public.seat_choice_links
    where token_hash = repeat('ab', 32) and unit_id = '{A}' and expires_at > now()$s$,
  'ok', $c$$1 = '1'$c$);
select pg_temp.caso(8606, 'K-2b salão de B num link de A', 'service_role',
  pg_temp.link('{SB}'), '42501 seat_link_invalid');
select pg_temp.caso(8607, 'K-2c canal de B num link de A', 'service_role',
  pg_temp.link('{S1}', '{CB}'), '42501 seat_link_invalid');
select pg_temp.caso(8608, 'K-2d service_role não altera link', 'service_role',
  pg_temp.link() || $s$; update public.seat_choice_links set expires_at = now() + interval '20 hours' returning id::text$s$,
  '42501 permission denied%');
select pg_temp.caso(8609, 'K-2e hash fora do formato (token cru)', 'service_role',
  pg_temp.link('{S1}', '{CA}', 'tokencruAbc_-123'), '23514%seat_choice_links_token_hash_check%');
select pg_temp.caso(8610, 'K-2f validade acima de 24 h', 'service_role',
  pg_temp.link('{S1}', '{CA}', null, 4, '25 hours'), '23514%seat_choice_links_expiry_check%');
select pg_temp.caso(8621, 'K-2g party_size 51', 'service_role',
  pg_temp.link('{S1}', '{CA}', null, 51), '23514%seat_choice_links_party_size_check%');
select pg_temp.caso(8622, 'K-2h salão inexistente dá a mesma recusa', 'service_role',
  pg_temp.link('a0d81000-0000-4000-8000-0000000000f9'), '42501 seat_link_invalid');
select pg_temp.caso(8623, 'K-3a anon executa a RPC de limite', 'anon',
  'select ' || pg_temp.rl('{A}') || '::text', '42501 permission denied%');
select pg_temp.caso(8624, 'K-3b authenticated executa a RPC de limite', 'GER',
  'select ' || pg_temp.rl('{A}') || '::text', '42501 permission denied%');
select pg_temp.caso(8625, 'K-3c 30 chamadas em 60 s passam e a 31ª não', 'service_role',
  'select string_agg(case when ok then ''t'' else ''f'' end, '''' order by g) from (select g, '
    || pg_temp.rl('{A}') || ' as ok from generate_series(1, 31) g) s',
  'ok', $c$$1 = repeat('t', 30) || 'f'$c$);
select pg_temp.caso(8626, 'K-3d outro IP, outra unidade e o modo token têm balde próprio', 'service_role',
  'select count(*) from generate_series(1, 30) g where ' || pg_temp.rl('{A}') || '; select '
    || pg_temp.rl('{A}', 'b') || '::text || ' || pg_temp.rl('{B}') || '::text || '
    || pg_temp.rl(null) || '::text || ' || pg_temp.rl('{A}') || '::text',
  'ok', $c$$1 = 'truetruetruefalse'$c$);
select pg_temp.caso(8627, 'K-3e chamada de mais de 60 s não conta; de mais de 1 h é apagada', 'postgres',
  $s$insert into public.seat_map_rate_events (unit_id, ip_hash, created_at)
     select '{A}', 'public-seat-map-ip:' || repeat('a', 64), clock_timestamp() - interval '61 seconds'
       from generate_series(1, 30);
   insert into public.seat_map_rate_events (unit_id, ip_hash, created_at)
     values (null, 'public-seat-map-ip:' || repeat('c', 64), clock_timestamp() - interval '2 hours');
   select set_config('role', 'service_role', true);
   select $s$ || pg_temp.rl('{A}') || '::text',
  'ok', $c$$1 = 'true' and (select count(*) from public.seat_map_rate_events
     where created_at < clock_timestamp() - interval '1 hour') = 0
   and (select count(*) from public.seat_map_rate_events) = 31$c$);
select pg_temp.caso(8628, 'K-3f chave fora do formato (prefixo da fila de espera)', 'service_role',
  $s$select public.check_public_seat_map_rate_limit('{A}', 'public-waitlist-ip:' || repeat('a', 64))::text$s$,
  '22023 public_seat_map_rate_limit_invalid');
select pg_temp.caso(8629, 'K-3g service_role sem acesso direto à contagem', 'service_role',
  $s$select count(*)::text from public.seat_map_rate_events$s$, '42501 permission denied%');
select pg_temp.caso(8630, 'K-CP controle: sem o guard, salão de B entra num link de A', 'postgres',
  $s$drop trigger seat_choice_links_guard on public.seat_choice_links; $s$ || pg_temp.link('{SB}'),
  'ok');

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
