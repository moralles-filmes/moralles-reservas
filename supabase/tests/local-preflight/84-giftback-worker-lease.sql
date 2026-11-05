-- 84: lease do process-voucher-triggers (migration 20261106120000).
--
-- LEASE-1…LEASE-10: aquisição exclusiva, renovação pelo dono, soltura só pelo
-- dono, retomada depois da validade, argumentos inválidos, ACL das funções e
-- da tabela, chamada real como `service_role` (FORCE RLS + SECURITY DEFINER).
-- Controles: LEASE-CP1 tira o WHERE do upsert e vê o segundo dono roubar a
-- trava viva; LEASE-CP2 mede que o dono da tabela tem BYPASSRLS (é o que deixa
-- as funções DEFINER passarem pela FORCE RLS sem policy).
--
-- Roda como `postgres` depois do 84a e da migration. Tudo numa transação
-- desfeita no fim; termina com erro se algum caso divergir.
\set ON_ERROR_STOP on
begin;

do $$ begin
  if to_regprocedure('public.acquire_giftback_lease(uuid,integer)') is null then
    raise exception '84: aplique a 20261106120000 antes';
  end if;
end $$;

create temp table t_res (ord int primary key, caso text not null, esperado text not null, veredito text not null);
grant all on t_res to service_role;

create function pg_temp.acq(h text) returns text language sql as
  $f$ select public.acquire_giftback_lease(('00000000-0000-4000-8000-' || lpad(h, 12, '0'))::uuid, 900)::text $f$;
create function pg_temp.rel(h text) returns text language sql as
  $f$ select public.release_giftback_lease(('00000000-0000-4000-8000-' || lpad(h, 12, '0'))::uuid)::text $f$;

delete from app_private.giftback_worker_lease;

insert into t_res values (1, 'LEASE-1 primeira aquisição vence', 'true', pg_temp.acq('1'));
insert into t_res values (2, 'LEASE-2 segundo dono com lease vivo perde', 'false', pg_temp.acq('2'));
insert into t_res values (3, 'LEASE-3 dono renova', 'true', pg_temp.acq('1'));
insert into t_res values (4, 'LEASE-4a soltura por outro dono não vale', 'false', pg_temp.rel('2'));
insert into t_res values (5, 'LEASE-4b trava segue com o dono', 'false', pg_temp.acq('2'));
insert into t_res values (6, 'LEASE-5a dono solta', 'true', pg_temp.rel('1'));
insert into t_res values (7, 'LEASE-5b soltura repetida', 'false', pg_temp.rel('1'));
insert into t_res values (8, 'LEASE-5c outro dono adquire depois da soltura', 'true', pg_temp.acq('2'));

-- LEASE-6: EF morta no meio — lease vencido é retomado sem soltura.
update app_private.giftback_worker_lease set lease_until = clock_timestamp() - interval '1 second';
insert into t_res values (9, 'LEASE-6 lease vencido é retomado', 'true', pg_temp.acq('3'));
insert into t_res select 10, 'LEASE-6b dono novo gravado', '00000000-0000-4000-8000-000000000003', holder::text
  from app_private.giftback_worker_lease;

-- LEASE-7: argumentos inválidos.
do $$
declare v text;
begin
  begin
    perform public.acquire_giftback_lease(gen_random_uuid(), 10);
    v := 'sem erro';
  exception when others then v := sqlstate || ' ' || sqlerrm;
  end;
  insert into t_res values (11, 'LEASE-7a TTL < 60 recusado', '22023 giftback_lease_invalid_args', v);
  begin
    perform public.acquire_giftback_lease(null, 900);
    v := 'sem erro';
  exception when others then v := sqlstate || ' ' || sqlerrm;
  end;
  insert into t_res values (12, 'LEASE-7b holder nulo recusado', '22023 giftback_lease_invalid_args', v);
end $$;

-- LEASE-8/9: ACL.
insert into t_res select 13, 'LEASE-8a anon sem EXECUTE', 'false',
  (has_function_privilege('anon', 'public.acquire_giftback_lease(uuid,integer)', 'execute')
   or has_function_privilege('anon', 'public.release_giftback_lease(uuid)', 'execute'))::text;
insert into t_res select 14, 'LEASE-8b authenticated sem EXECUTE', 'false',
  (has_function_privilege('authenticated', 'public.acquire_giftback_lease(uuid,integer)', 'execute')
   or has_function_privilege('authenticated', 'public.release_giftback_lease(uuid)', 'execute'))::text;
insert into t_res select 15, 'LEASE-8c service_role com EXECUTE', 'true',
  (has_function_privilege('service_role', 'public.acquire_giftback_lease(uuid,integer)', 'execute')
   and has_function_privilege('service_role', 'public.release_giftback_lease(uuid)', 'execute'))::text;
insert into t_res select 16, 'LEASE-9 nenhum papel de API com privilégio na tabela', 'false',
  (has_table_privilege('anon', 'app_private.giftback_worker_lease', 'select,insert,update,delete')
   or has_table_privilege('authenticated', 'app_private.giftback_worker_lease', 'select,insert,update,delete')
   or has_table_privilege('service_role', 'app_private.giftback_worker_lease', 'select,insert,update,delete'))::text;
insert into t_res select 17, 'LEASE-9b FORCE RLS ligada', 'true', relforcerowsecurity::text
  from pg_class where oid = 'app_private.giftback_worker_lease'::regclass;

-- LEASE-10: caminho real da EF — `service_role` chama as funções.
update app_private.giftback_worker_lease set lease_until = clock_timestamp() - interval '1 second';
set local role service_role;
insert into t_res values (18, 'LEASE-10a service_role adquire', 'true', pg_temp.acq('4'));
insert into t_res values (19, 'LEASE-10b service_role concorrente perde', 'false', pg_temp.acq('5'));
insert into t_res values (20, 'LEASE-10c service_role solta', 'true', pg_temp.rel('4'));
reset role;

-- LEASE-CP1: sem o WHERE do upsert, o segundo dono rouba a trava viva.
do $$
declare v text;
begin
  begin
    execute replace(pg_get_functiondef('public.acquire_giftback_lease(uuid,integer)'::regprocedure),
      'where l.lease_until <= clock_timestamp() or l.holder = excluded.holder', '');
    delete from app_private.giftback_worker_lease;
    perform pg_temp.acq('6');
    v := pg_temp.acq('7');
    raise exception using errcode = 'P8484', message = v;
  exception when sqlstate 'P8484' then v := sqlerrm;
  end;
  insert into t_res values (21, 'LEASE-CP1 sem WHERE o 2º dono vence (controle)', 'true', v);
end $$;
insert into t_res values (22, 'LEASE-CP1b corpo real restaurado', 'false',
  (select (pg_temp.acq('8') = 'true' and pg_temp.acq('9') = 'true')::text));

insert into t_res select 23, 'LEASE-CP2 dono da tabela tem BYPASSRLS', 'true', r.rolbypassrls::text
  from pg_class c join pg_roles r on r.oid = c.relowner
 where c.oid = 'app_private.giftback_worker_lease'::regclass;

\pset footer off
select ord, caso, esperado, veredito, case when veredito = esperado then 'PASS' else 'FAIL' end as r
  from t_res order by ord;
select count(*) filter (where veredito = esperado) as pass, count(*) as total from t_res;
do $$
declare v_fail int;
begin
  select count(*) into v_fail from t_res where veredito <> esperado;
  if v_fail > 0 then raise exception '84: % caso(s) divergente(s)', v_fail; end if;
end $$;
rollback;
