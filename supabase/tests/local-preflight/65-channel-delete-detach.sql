-- Disposable PostgreSQL only; run after 65a and the migration applied twice.
-- DETACH-1..6, ACL e controle positivo da RPC detach_whatsapp_channel_references.
-- Tudo em uma transação revertida: nada sobra no banco.
begin;
insert into public.units(id) values
  ('aaaaaaaa-0065-0000-0000-000000000001'),
  ('aaaaaaaa-0065-0000-0000-000000000002');
insert into public.whatsapp_channels(id, unit_id) values
  ('cccccccc-0065-0000-0000-00000000000a', 'aaaaaaaa-0065-0000-0000-000000000001'),
  ('cccccccc-0065-0000-0000-00000000000b', 'aaaaaaaa-0065-0000-0000-000000000001'),
  ('cccccccc-0065-0000-0000-00000000000c', 'aaaaaaaa-0065-0000-0000-000000000002');
insert into public.webhook_executions(channel_id)
  select 'cccccccc-0065-0000-0000-00000000000a' from generate_series(1, 5);
insert into public.webhook_executions(channel_id)
  select 'cccccccc-0065-0000-0000-00000000000b' from generate_series(1, 2);
insert into public.webhook_executions(channel_id)
  select 'cccccccc-0065-0000-0000-00000000000c' from generate_series(1, 2);
-- Canal A: duas entregues e uma pendente antiga (desvinculáveis) + uma pendente
-- recente sem recibo, que tem de ficar vinculada até o DELETE (DETACH-7).
insert into public.notifications_sent(whatsapp_channel_id, sent_at, delivered_at) values
  ('cccccccc-0065-0000-0000-00000000000a', now() - interval '1 hour', now()),
  ('cccccccc-0065-0000-0000-00000000000a', now() - interval '3 days', now() - interval '3 days'),
  ('cccccccc-0065-0000-0000-00000000000a', now() - interval '2 days', null),
  ('cccccccc-0065-0000-0000-00000000000a', now() - interval '5 minutes', null);

-- DETACH-2 primeiro: unidade errada não toca nada (tenant resolvido pelo recurso).
set local role service_role;
do $$ declare n int; begin
  n := public.detach_whatsapp_channel_references(
    'cccccccc-0065-0000-0000-00000000000c', 'aaaaaaaa-0065-0000-0000-000000000001', 100);
  if n <> 0 then raise exception 'DETACH-2: canal de outra unidade desvinculou % linhas', n; end if;
  n := public.detach_whatsapp_channel_references(
    'cccccccc-0065-0000-0000-0000000000ff', 'aaaaaaaa-0065-0000-0000-000000000001', 100);
  if n <> 0 then raise exception 'DETACH-2: canal inexistente devolveu %', n; end if;
end $$;
reset role;
do $$ begin
  if (select count(*) from public.webhook_executions where channel_id = 'cccccccc-0065-0000-0000-00000000000c') <> 2 then
    raise exception 'DETACH-2: referências do canal alheio mudaram';
  end if;
end $$;

-- DETACH-1: lotes de 4 sobre 5 execuções + 3 notificações = 4, 4, 0.
set local role service_role;
do $$ declare a int; b int; c int; begin
  a := public.detach_whatsapp_channel_references('cccccccc-0065-0000-0000-00000000000a', 'aaaaaaaa-0065-0000-0000-000000000001', 4);
  b := public.detach_whatsapp_channel_references('cccccccc-0065-0000-0000-00000000000a', 'aaaaaaaa-0065-0000-0000-000000000001', 4);
  c := public.detach_whatsapp_channel_references('cccccccc-0065-0000-0000-00000000000a', 'aaaaaaaa-0065-0000-0000-000000000001', 4);
  if (a, b, c) <> (4, 4, 0) then raise exception 'DETACH-1: lotes %, %, % (esperado 4, 4, 0)', a, b, c; end if;
end $$;
reset role;
do $$ begin
  if exists (select 1 from public.webhook_executions where channel_id = 'cccccccc-0065-0000-0000-00000000000a') then
    raise exception 'DETACH-1: sobrou execução vinculada ao canal A';
  end if;
  -- DETACH-7: só a pendente recente sem recibo continua vinculada.
  if (select count(*) from public.notifications_sent where whatsapp_channel_id = 'cccccccc-0065-0000-0000-00000000000a') <> 1
     or not exists (select 1 from public.notifications_sent
                     where whatsapp_channel_id = 'cccccccc-0065-0000-0000-00000000000a'
                       and delivered_at is null and sent_at > now() - interval '1 hour') then
    raise exception 'DETACH-7: pendente recente desvinculada cedo, ou outra sobrou';
  end if;
  -- DETACH-3: só o canal pedido; o canal B da mesma unidade fica intacto.
  if (select count(*) from public.webhook_executions where channel_id = 'cccccccc-0065-0000-0000-00000000000b') <> 2 then
    raise exception 'DETACH-3: canal vizinho da mesma unidade foi tocado';
  end if;
  -- Nada foi apagado: a RPC só faz set null.
  if (select count(*) from public.webhook_executions) <> 9 or (select count(*) from public.notifications_sent) <> 4 then
    raise exception 'DETACH-1: linhas apagadas em vez de desvinculadas';
  end if;
end $$;

-- DETACH-4: depois da desvinculação o DELETE do canal passa e o histórico fica.
delete from public.whatsapp_channels where id = 'cccccccc-0065-0000-0000-00000000000a';
do $$ begin
  if (select count(*) from public.webhook_executions where channel_id is null) <> 5
     or (select count(*) from public.notifications_sent where whatsapp_channel_id is null) <> 4 then
    raise exception 'DETACH-4: histórico perdido no delete, ou pendente recente sem set null da FK';
  end if;
end $$;

-- DETACH-5: argumentos nulos recusados com 22023.
set local role service_role;
do $$ begin
  begin
    perform public.detach_whatsapp_channel_references(null, 'aaaaaaaa-0065-0000-0000-000000000001', 10);
    raise exception 'DETACH-5: aceitou channel_id nulo';
  exception when sqlstate '22023' then null;
  end;
end $$;

-- DETACH-6: limite fora da faixa é grampeado em 1..10000.
do $$ declare n int; begin
  n := public.detach_whatsapp_channel_references('cccccccc-0065-0000-0000-00000000000b', 'aaaaaaaa-0065-0000-0000-000000000001', 0);
  if n <> 1 then raise exception 'DETACH-6: p_limit 0 desvinculou % (esperado 1)', n; end if;
end $$;
reset role;

-- ACL e forma da função.
do $$ declare sig text := 'public.detach_whatsapp_channel_references(uuid,uuid,integer)'; begin
  if has_function_privilege('anon', sig, 'execute')
     or has_function_privilege('authenticated', sig, 'execute')
     or not has_function_privilege('service_role', sig, 'execute') then
    raise exception 'ACL-65: EXECUTE fora de service_role';
  end if;
  if not (select prosecdef from pg_proc where oid = sig::regprocedure) then
    raise exception 'ACL-65: deixou de ser SECURITY DEFINER';
  end if;
  if (select proconfig from pg_proc where oid = sig::regprocedure) is distinct from array['search_path=""'] then
    raise exception 'ACL-65: search_path inesperado %', (select proconfig from pg_proc where oid = sig::regprocedure);
  end if;
  if not exists (select 1 from pg_indexes where indexname = 'idx_webhook_executions_channel')
     or not exists (select 1 from pg_indexes where indexname = 'idx_notifications_sent_whatsapp_channel') then
    raise exception 'IDX-65: índice ausente';
  end if;
end $$;

-- CONTROLE-65: sem a guarda de unidade, o canal alheio seria desvinculado.
-- Prova que DETACH-2 mede a guarda, e não um teste sem força.
savepoint controle;
do $$ declare def text; begin
  def := pg_get_functiondef('public.detach_whatsapp_channel_references(uuid,uuid,integer)'::regprocedure);
  if position('where id = p_channel_id and unit_id = p_unit_id' in def) = 0 then
    raise exception 'CONTROLE-65: âncora da guarda não encontrada';
  end if;
  execute replace(def, 'where id = p_channel_id and unit_id = p_unit_id', 'where id = p_channel_id');
end $$;
do $$ declare n int; begin
  n := public.detach_whatsapp_channel_references('cccccccc-0065-0000-0000-00000000000c', 'aaaaaaaa-0065-0000-0000-000000000001', 100);
  if n = 0 then raise exception 'CONTROLE-65: sabotagem não teve efeito — DETACH-2 não mede a guarda'; end if;
end $$;
rollback to savepoint controle;

-- CONTROLE-65b: sem o filtro de pendente recente, a notificação sem recibo seria
-- desvinculada antes do DELETE. Prova que DETACH-7 mede o filtro.
savepoint controle_b;
insert into public.whatsapp_channels(id, unit_id) values
  ('cccccccc-0065-0000-0000-00000000000d', 'aaaaaaaa-0065-0000-0000-000000000001');
insert into public.notifications_sent(whatsapp_channel_id, sent_at) values
  ('cccccccc-0065-0000-0000-00000000000d', now() - interval '5 minutes');
do $$ declare n int; begin
  n := public.detach_whatsapp_channel_references('cccccccc-0065-0000-0000-00000000000d', 'aaaaaaaa-0065-0000-0000-000000000001', 10);
  if n <> 0 then raise exception 'CONTROLE-65b: pendente recente desvinculada sem sabotagem (%)', n; end if;
end $$;
do $$ declare def text; begin
  def := pg_get_functiondef('public.detach_whatsapp_channel_references(uuid,uuid,integer)'::regprocedure);
  if position('sent_at > now() - interval ''24 hours''' in def) = 0 then
    raise exception 'CONTROLE-65b: âncora do filtro não encontrada';
  end if;
  execute replace(def, 'sent_at > now() - interval ''24 hours''', 'false');
end $$;
do $$ declare n int; begin
  n := public.detach_whatsapp_channel_references('cccccccc-0065-0000-0000-00000000000d', 'aaaaaaaa-0065-0000-0000-000000000001', 10);
  if n <> 1 then raise exception 'CONTROLE-65b: sabotagem sem efeito — DETACH-7 não mede o filtro'; end if;
end $$;
rollback to savepoint controle_b;
do $$ begin
  if position('sent_at > now() - interval ''24 hours''' in pg_get_functiondef('public.detach_whatsapp_channel_references(uuid,uuid,integer)'::regprocedure)) = 0 then
    raise exception 'CONTROLE-65b: corpo não restaurado';
  end if;
end $$;

do $$ begin
  if position('unit_id = p_unit_id' in pg_get_functiondef('public.detach_whatsapp_channel_references(uuid,uuid,integer)'::regprocedure)) = 0 then
    raise exception 'CONTROLE-65: corpo não restaurado';
  end if;
  raise notice 'CHANNEL65: DETACH-1..7, ACL-65, IDX-65, CONTROLE-65 e CONTROLE-65b passaram';
end $$;
rollback;
