-- Pré-voo da migration 20261107140000_whatsapp_channel_unit_immutable.sql.
-- Ordinais 8601–8612 e controle C-86-1. Cada caso desfaz o que escreve
-- (subtransação), então o arquivo é re-runnable. Aborta no fim se algum falhar.
-- Sem a migration o arquivo recusa rodar (RED).
do $$
begin
  if to_regprocedure('app_private.guard_whatsapp_channel_unit()') is null then
    raise exception '86: guard_whatsapp_channel_unit ausente (migration 20261107140000 não aplicada)';
  end if;
end $$;

create temp table t_res(ord int primary key, caso text, ok boolean, detalhe text);
grant all on t_res to service_role;

-- Tenta mover o canal p_id para a unidade p_to com o papel p_role.
-- Devolve 'ok' se o UPDATE passou (e desfaz), ou SQLSTATE:mensagem.
create function pg_temp.try_move(p_role text, p_id uuid, p_to uuid) returns text
language plpgsql as $$
declare v text;
begin
  begin
    execute format('set local role %I', p_role);
    update public.whatsapp_channels set unit_id = p_to where id = p_id;
    if not found then v := 'zero_linhas'; else v := 'ok'; end if;
    raise exception using errcode = 'P0086', message = v;
  exception
    when sqlstate 'P0086' then reset role; return sqlerrm;
    when others then reset role; return sqlstate || ':' || sqlerrm;
  end;
end $$;

do $$
declare
  ua1 uuid := 'a0d86000-0000-4000-8000-0000000000a1';
  ua2 uuid := 'a0d86000-0000-4000-8000-0000000000a2';
  r text;
  p record;
begin
  -- 8601–8604: service_role (o único que escreve no canal) recusado em todo provedor.
  for p in select * from (values
      (8601,'zapi','a0d86000-0000-4000-8000-0000000000c1'::uuid),
      (8602,'uazapi','a0d86000-0000-4000-8000-0000000000c2'::uuid),
      (8603,'official','a0d86000-0000-4000-8000-0000000000c3'::uuid),
      (8604,'datafy','a0d86000-0000-4000-8000-0000000000c4'::uuid)) v(ord, prov, id)
  loop
    r := pg_temp.try_move('service_role', p.id, ua2);
    insert into t_res values (p.ord, 'service_role move canal ' || p.prov,
      r = '42501:whatsapp_channel_unit_immutable', r);
  end loop;

  -- 8605: dono da tabela (postgres) também recusado.
  r := pg_temp.try_move('postgres', 'a0d86000-0000-4000-8000-0000000000c1', ua2);
  insert into t_res values (8605, 'postgres move canal', r = '42501:whatsapp_channel_unit_immutable', r);

  -- 8606: unit_id para NULL recusado pelo guard (antes do NOT NULL).
  r := pg_temp.try_move('service_role', 'a0d86000-0000-4000-8000-0000000000c1', null);
  insert into t_res values (8606, 'unit_id -> null', r = '42501:whatsapp_channel_unit_immutable', r);

  -- 8607: SET unit_id com o mesmo valor (PATCH que reenvia a coluna) passa.
  r := pg_temp.try_move('service_role', 'a0d86000-0000-4000-8000-0000000000c1', ua1);
  insert into t_res values (8607, 'unit_id mesmo valor passa', r = 'ok', r);

  -- 8608: o canal continua na unidade original depois das recusas.
  insert into t_res
  select 8608, 'canais seguem na unidade original',
         count(*) = 4, count(*)::text
  from public.whatsapp_channels where unit_id = ua1;
end $$;

-- 8609: UPDATE de outras colunas segue como service_role.
do $$
declare v_n int; v_err text;
begin
  begin
    set local role service_role;
    update public.whatsapp_channels
       set status = 'connected', is_active = true, display_phone = '11999990000', updated_at = now()
     where unit_id = 'a0d86000-0000-4000-8000-0000000000a1';
    get diagnostics v_n = row_count;
    raise exception using errcode = 'P0086';
  exception
    when sqlstate 'P0086' then null;
    when others then v_err := sqlstate || ':' || sqlerrm;
  end;
  reset role;
  insert into t_res values (8609, 'outras colunas atualizam', v_err is null and v_n = 4, coalesce(v_err, v_n::text));
end $$;

-- 8610: excluir a unidade continua apagando o canal pela FK (cascade).
do $$
declare v_n int; v_err text; v_depois int;
begin
  begin
    delete from public.units where id = 'a0d86000-0000-4000-8000-0000000000a3';
    select count(*) into v_n from public.whatsapp_channels where id = 'a0d86000-0000-4000-8000-0000000000c5';
    raise exception using errcode = 'P0086';
  exception
    when sqlstate 'P0086' then null;
    when others then v_err := sqlstate || ':' || sqlerrm;
  end;
  select count(*) into v_depois from public.whatsapp_channels where id = 'a0d86000-0000-4000-8000-0000000000c5';
  insert into t_res values (8610, 'delete unidade apaga canal', v_err is null and v_n = 0 and v_depois = 1,
    coalesce(v_err, format('durante=%s depois_rollback=%s', v_n, v_depois)));
end $$;

-- 8611: ACL e forma da função.
insert into t_res
select 8611, 'ACL/forma do guard',
       p.prosecdef
       and p.proconfig = array['search_path=""']
       and not has_function_privilege('anon', p.oid, 'execute')
       and not has_function_privilege('authenticated', p.oid, 'execute')
       and not has_function_privilege('service_role', p.oid, 'execute')
       and not exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0),
       format('secdef=%s cfg=%s acl=%s', p.prosecdef, p.proconfig, p.proacl)
from pg_proc p where p.oid = 'app_private.guard_whatsapp_channel_unit()'::regprocedure;

-- 8612: trigger BEFORE UPDATE OF unit_id, por linha, habilitado, único.
insert into t_res
select 8612, 'trigger before update of unit_id',
       count(*) = 1
       and bool_and(t.tgenabled = 'O')
       and bool_and(t.tgtype = 19)  -- ROW(1) + BEFORE(2) + UPDATE(16)
       and bool_and(t.tgattr::text = (select attnum::text from pg_attribute
                                       where attrelid = 'public.whatsapp_channels'::regclass and attname = 'unit_id')),
       string_agg(format('%s type=%s attr=%s en=%s', t.tgname, t.tgtype, t.tgattr, t.tgenabled), '; ')
from pg_trigger t
where t.tgrelid = 'public.whatsapp_channels'::regclass and t.tgname = 'whatsapp_channels_unit_immutable';

-- C-86-1, controle positivo: sem o trigger o mesmo UPDATE do 8601 passa.
-- Prova que 8601–8606 medem o guard, não outra coisa. Desfeito por rollback.
do $$
declare r text;
begin
  begin
    alter table public.whatsapp_channels disable trigger whatsapp_channels_unit_immutable;
    r := pg_temp.try_move('service_role', 'a0d86000-0000-4000-8000-0000000000c1', 'a0d86000-0000-4000-8000-0000000000a2');
    raise exception using errcode = 'P0086';
  exception
    when sqlstate 'P0086' then null;
  end;
  insert into t_res values (8699, 'C-86-1 sem trigger o move passa', r = 'ok', r);
end $$;

insert into t_res
select 8698, 'C-86-1 trigger restaurado', tgenabled = 'O', tgenabled::text
from pg_trigger where tgrelid = 'public.whatsapp_channels'::regclass and tgname = 'whatsapp_channels_unit_immutable';

select ord, caso, case when ok then 'PASSOU' else 'FALHOU' end as veredito, detalhe from t_res order by ord;

do $$
declare v_ok int; v_tot int;
begin
  select count(*) filter (where ok), count(*) into v_ok, v_tot from t_res;
  raise notice 'GREEN86 %/%', v_ok, v_tot;
  if v_ok <> v_tot or v_tot <> 14 then
    raise exception '86: % de % casos passaram (esperado 14/14)', v_ok, v_tot;
  end if;
end $$;
