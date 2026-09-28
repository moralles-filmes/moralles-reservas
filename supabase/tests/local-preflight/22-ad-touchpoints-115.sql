-- TP-1..TP-11, TP-1b, TP-4b e TP-6b (ordinais 85..96, 102 e 103): a tabela
-- `whatsapp_ad_touchpoints` da migration 115 (Fase D — touchpoint CTWA), contra
-- Postgres real.
--
-- O QUE ESTE ARQUIVO PROVA:
--   * o guard `whatsapp_ad_touchpoints_guard()`: imutabilidade (nenhum UPDATE,
--     nem o que não muda nada), a ÚNICA exceção da coerção do `on delete set
--     null` de `channel_id`, a coerência de tenant entre as três FKs (canal da
--     unidade, cliente da organização da unidade) e a recusa de cliente
--     anonimizado;
--   * os CHECKs (allowlist de `provider`, rede de 64 KiB da subárvore
--     `referral`) e o unique `(provider, provider_message_id)`;
--   * FK e cascade: apagar o canal não aborta o DELETE (TP-4), e apagar a
--     unidade com as DUAS ações de FK sobre a mesma linha também não (TP-4b);
--   * a purga LGPD por trigger SECURITY DEFINER disparada por um soft delete
--     feito com o PAPEL REAL `authenticated` (TP-9), e a gravação com o papel
--     real `service_role` (TP-1b) — os outros casos gravam como `postgres`,
--     superusuário, e não medem privilégio nenhum;
--   * RLS forçada sem policies, ACL e forma (INVOKER/DEFINER, `search_path`
--     vazio) das duas funções (TP-10), e idempotência da migration ATRAVÉS de
--     execuções (TP-11).
--
-- O QUE ELE NÃO PROVA: exposição PostgREST da tabela (depende de Supabase de
-- verdade) e o `rolbypassrls` do `postgres` de produção — aqui o `postgres` é
-- superusuário e ignora RLS de qualquer jeito. Ver a seção da 115 no README.
--
-- SEQUÊNCIA (banco PRÓPRIO `fased115`, ver a seção da 115 no README):
--   00-bootstrap.sql
--   00a-whatsapp-legacy-seed.sql
--   22a-ad-touchpoints-bootstrap.sql
--   supabase/migrations/20260927120000_115_whatsapp_ad_touchpoints.sql
--   22-ad-touchpoints-115.sql      <- este (1a passada: TP-11 = PENDENTE)
--   115 duas vezes
--   22-ad-touchpoints-115.sql      <- 2a passada: TP-11 = OK
--   23-controles-115.sql
--
-- CADA CASO SE DESFAZ: o corpo de cada um roda numa subtransação que termina com
-- `raise ... using errcode = 'ZZ115'`, capturado ali mesmo — a convenção do
-- CONTROLE-16 do `09` e do `ZZ111` do `16`. Consequência: o arquivo é
-- RE-RUNNABLE e não deixa linha nenhuma em `whatsapp_ad_touchpoints` (o TP-11
-- confere isso). Nos casos NEGATIVOS o `ZZ115` também é obrigatório: com o guard
-- defeituoso o insert PASSA, e sem o rollback a linha ficaria. Variável de
-- plpgsql não é transacional, então os valores observados sobrevivem ao rollback
-- e o veredito é julgado depois de desfazer.
--
-- Todo veredito é gravado por upsert em `t_res` (`pg_temp.tp_res`), pela razão
-- documentada no `09`: o handler `when others` roda DEPOIS do rollback da
-- subtransação do bloco, e na 2a passada um insert simples bateria em chave
-- duplicada — abortando o arquivo sob ON_ERROR_STOP e sumindo com o veredito de
-- todos os casos seguintes.

-- ─── GUARDA: só faz sentido DEPOIS da 115 e do 22a ──────────────────────────
-- Rodado antes, TP-5/6/6b/7 passariam POR ACIDENTE: sem a tabela todo insert
-- "falha" e todo caso negativo fica verde medindo nada.
do $$
begin
  if to_regclass('public.whatsapp_ad_touchpoints') is null then
    raise exception '22-ad-touchpoints-115.sql exige a migration 115 aplicada (tabela public.whatsapp_ad_touchpoints ausente). Sequencia: 00 -> 00a -> 22a -> 115 -> 22 -> 23.';
  end if;
  if not exists (select 1 from public.customers where id = 'cccccccc-0000-0000-0000-000000000003') then
    raise exception '22-ad-touchpoints-115.sql exige o 22a-ad-touchpoints-bootstrap.sql (clientes cccccccc-... ausentes).';
  end if;
end $$;

create table if not exists t_res (ord int primary key, caso text, veredito text);
create table if not exists t_snap115 (k text primary key, v text not null);

create or replace function pg_temp.tp_res(p_ord int, p_caso text, p_veredito text)
returns void language sql as $$
  insert into t_res values (p_ord, p_caso, p_veredito)
  on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
$$;

-- Insert válido por default: unidade A1, canal A1, cliente A1, datafy.
create or replace function pg_temp.tp_ins(
  p_msg      text,
  p_unit     uuid  default 'bbbbbbbb-0000-0000-0000-000000000001',
  p_channel  uuid  default 'dddddddd-0000-0000-0000-000000000001',
  p_customer uuid  default 'cccccccc-0000-0000-0000-000000000001',
  p_provider text  default 'datafy',
  p_referral jsonb default '{"ctwa_clid":"clid","source_type":"ad"}'::jsonb
) returns uuid language sql as $$
  insert into public.whatsapp_ad_touchpoints
    (unit_id, channel_id, customer_id, provider, provider_message_id, message_type,
     message_at, ctwa_clid, source_type, source_id, referral)
  values (p_unit, p_channel, p_customer, p_provider, p_msg, 'text',
          now(), 'clid-' || p_msg, 'ad', 'ad-1', p_referral)
  returning id;
$$;

-- ─── TP-1 (85): insert válido; source_type desconhecido entra ───────────────
do $$
declare v_id uuid; v_recv timestamptz; v_src text; v_ok boolean := false;
begin
  begin
    insert into public.whatsapp_ad_touchpoints
      (unit_id, channel_id, customer_id, provider, provider_message_id, message_type,
       message_at, ctwa_clid, source_type, source_id, referral)
    values ('bbbbbbbb-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000001',
            'cccccccc-0000-0000-0000-000000000001', 'official', 'wamid.TP1', 'image',
            now(), 'clid-tp1', 'reel', 'ad-1', '{"ctwa_clid":"clid-tp1","source_type":"reel"}'::jsonb)
    returning id, received_at, source_type into v_id, v_recv, v_src;
    v_ok := v_id is not null and v_recv is not null and v_src = 'reel';
    raise exception using errcode = 'ZZ115';
  exception when sqlstate 'ZZ115' then null;
  end;
  perform pg_temp.tp_res(85, 'TP-1', case when v_ok then 'OK'
    else 'FALHOU: insert valido nao gravou (source_type desconhecido tem de entrar: recusa viraria reentrega eterna)' end);
exception when others then
  perform pg_temp.tp_res(85, 'TP-1', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- ─── TP-1b (102): o service_role, que é quem grava em produção, insere ──────
-- O guard é SECURITY INVOKER e lê `customers ... for share`, que exige
-- privilégio de UPDATE (em ao menos uma coluna) além de SELECT. Todos os
-- outros casos gravam como `postgres`, superusuário, e não medem isso.
-- Sem pg_temp aqui: função temporária da sessão não é o que se quer medir.
do $$
declare v_ok boolean := false;
begin
  begin
    set local role service_role;
    insert into public.whatsapp_ad_touchpoints
      (unit_id, channel_id, customer_id, provider, provider_message_id, message_at, ctwa_clid)
    values ('bbbbbbbb-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000001',
            'cccccccc-0000-0000-0000-000000000001', 'datafy', 'wamid.TP1b', now(), 'clid-tp1b');
    v_ok := true;
    reset role;
    raise exception using errcode = 'ZZ115';
  exception when sqlstate 'ZZ115' then null;
  end;
  perform pg_temp.tp_res(102, 'TP-1b', case when v_ok then 'OK'
    else 'FALHOU: service_role nao gravou o touchpoint' end);
exception when others then
  perform pg_temp.tp_res(102, 'TP-1b', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- ─── TP-2 (86): reentrega da mesma mensagem → 23505 ─────────────────────────
do $$
declare v_state text;
begin
  begin
    perform pg_temp.tp_ins('wamid.TP2');
    begin
      perform pg_temp.tp_ins('wamid.TP2');
      v_state := 'aceitou';
    exception when unique_violation then v_state := '23505';
    end;
    raise exception using errcode = 'ZZ115';
  exception when sqlstate 'ZZ115' then null;
  end;
  perform pg_temp.tp_res(86, 'TP-2', case when v_state = '23505' then 'OK'
    else 'FALHOU: reentrega da mesma (provider, provider_message_id) nao estourou 23505: ' || coalesce(v_state, 'null') end);
exception when others then
  perform pg_temp.tp_res(86, 'TP-2', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- ─── TP-3 (87): nenhum UPDATE é aceito, nem o que não muda nada ─────────────
do $$
declare
  v_id uuid;
  v_stmt text;
  v_passaram text[] := '{}';
  v_stmts text[] := array[
    'update public.whatsapp_ad_touchpoints set ctwa_clid = ''outro'' where id = $1',
    'update public.whatsapp_ad_touchpoints set referral = ''{}''::jsonb where id = $1',
    'update public.whatsapp_ad_touchpoints set customer_id = ''cccccccc-0000-0000-0000-000000000002'' where id = $1',
    'update public.whatsapp_ad_touchpoints set message_at = now() - interval ''1 day'' where id = $1',
    'update public.whatsapp_ad_touchpoints set source_id = ''ad-2'' where id = $1',
    'update public.whatsapp_ad_touchpoints set channel_id = channel_id where id = $1',
    'update public.whatsapp_ad_touchpoints set channel_id = null, ctwa_clid = ''outro'' where id = $1'
  ];
begin
  begin
    v_id := pg_temp.tp_ins('wamid.TP3');
    foreach v_stmt in array v_stmts loop
      begin
        execute v_stmt using v_id;
        v_passaram := v_passaram || v_stmt;
      exception when check_violation then null;
      end;
    end loop;
    raise exception using errcode = 'ZZ115';
  exception when sqlstate 'ZZ115' then null;
  end;
  perform pg_temp.tp_res(87, 'TP-3', case when cardinality(v_passaram) = 0 then 'OK'
    else 'FALHOU: UPDATE aceito num touchpoint: ' || array_to_string(v_passaram, ' | ') end);
exception when others then
  perform pg_temp.tp_res(87, 'TP-3', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- ─── TP-4 (88): DELETE do canal conclui e a linha fica com channel_id nulo ──
do $$
declare
  v_chan uuid := 'dddddddd-0000-0000-0000-0000000000f4';
  v_id uuid; v_existe boolean := false; v_canal uuid; v_erro text;
begin
  begin
    insert into whatsapp_channels (id, unit_id, provider, status, display_phone)
    values (v_chan, 'bbbbbbbb-0000-0000-0000-000000000001', 'official', 'disconnected', '5511000000f4');
    v_id := pg_temp.tp_ins('wamid.TP4', p_channel => v_chan);
    delete from whatsapp_channels where id = v_chan;
    select true, channel_id into v_existe, v_canal from public.whatsapp_ad_touchpoints where id = v_id;
    raise exception using errcode = 'ZZ115';
  exception
    when sqlstate 'ZZ115' then null;
    when others then v_erro := sqlstate || ' ' || sqlerrm;
  end;
  perform pg_temp.tp_res(88, 'TP-4', case
    when v_erro is not null then 'FALHOU: DELETE do canal abortou (a excecao do set null sumiu?): ' || v_erro
    when v_existe and v_canal is null then 'OK'
    else 'FALHOU: touchpoint sumiu ou manteve channel_id apos apagar o canal' end);
exception when others then
  perform pg_temp.tp_res(88, 'TP-4', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- ─── TP-4b (103): DELETE da UNIDADE com dupla cascata conclui ───────────────
-- Apagar a unidade cascateia para o canal (cujo `on delete set null` mira
-- channel_id) E para o touchpoint direto. As duas ações de FK sobre a mesma
-- linha não podem abortar o DELETE.
--
-- MEDIDO (PostgreSQL 18.4), e é o contrário do que o rascunho supunha: este
-- caso NÃO passa pela exceção do guard. As ações de FK disparadas pelo DELETE
-- do canal entram na fila DEPOIS das ações irmãs do DELETE da unidade, então o
-- cascade direto apaga o touchpoint primeiro e o `set null` chega a zero linhas
-- — um trigger espião BEFORE UPDATE OR DELETE registrou só o DELETE. Com o
-- trecho `<excecao-set-null>` removido de forma PERSISTENTE este caso segue
-- verde. Ele prova que o DELETE da unidade conclui (pegaria, por exemplo, um
-- guard estendido a DELETE ou um `restrict`); quem prova a exceção é o TP-4,
-- com o C-115-1 como controle.
do $$
declare
  v_unit uuid := 'bbbbbbbb-0000-0000-0000-0000000000f4';
  v_chan uuid := 'dddddddd-0000-0000-0000-0000000000b4';
  v_restam int; v_erro text;
begin
  begin
    insert into units (id, organization_id, name)
    values (v_unit, 'aaaaaaaa-0000-0000-0000-000000000001', 'Unidade TP-4b');
    insert into whatsapp_channels (id, unit_id, provider, status, display_phone)
    values (v_chan, v_unit, 'official', 'disconnected', '5511000000b4');
    perform pg_temp.tp_ins('wamid.TP4b1', p_unit => v_unit, p_channel => v_chan);
    perform pg_temp.tp_ins('wamid.TP4b2', p_unit => v_unit, p_channel => null);
    delete from units where id = v_unit;
    select count(*) into v_restam from public.whatsapp_ad_touchpoints where unit_id = v_unit;
    raise exception using errcode = 'ZZ115';
  exception
    when sqlstate 'ZZ115' then null;
    when others then v_erro := sqlstate || ' ' || sqlerrm;
  end;
  perform pg_temp.tp_res(103, 'TP-4b', case
    when v_erro is not null then 'FALHOU: DELETE da unidade abortou: ' || v_erro
    when v_restam = 0 then 'OK'
    else 'FALHOU: sobraram ' || v_restam || ' touchpoints da unidade apagada' end);
exception when others then
  perform pg_temp.tp_res(103, 'TP-4b', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- ─── TP-5 (89) e TP-6 (90): coerência de tenant ─────────────────────────────
-- Nos casos NEGATIVOS o `ZZ115` também é obrigatório: com o guard defeituoso o
-- insert PASSA, e sem o rollback a linha ficaria — o arquivo deixaria de ser
-- re-runnable e o TP-11 acusaria "sobrou linha" apontando o lugar errado.
do $$
declare v_state text; v_msg text;
begin
  begin
    -- canal dddd...02 é da unidade B1; a linha diz unidade A1.
    perform pg_temp.tp_ins('wamid.TP5', p_channel => 'dddddddd-0000-0000-0000-000000000002');
    v_state := 'aceitou';
    raise exception using errcode = 'ZZ115';
  exception
    when check_violation then v_state := '23514'; v_msg := sqlerrm;
    when sqlstate 'ZZ115' then null;
  end;
  perform pg_temp.tp_res(89, 'TP-5', case when v_state = '23514' and v_msg ilike '%canal%' then 'OK'
    else 'FALHOU: canal de outra unidade aceito ou recusado pela perna errada: ' || coalesce(v_state, 'null') || ' ' || coalesce(v_msg, '') end);
exception when others then
  perform pg_temp.tp_res(89, 'TP-5', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

do $$
declare v_state text; v_msg text;
begin
  begin
    -- cliente cccc...03 é da org B; a unidade A1 é da org A.
    perform pg_temp.tp_ins('wamid.TP6', p_channel => null, p_customer => 'cccccccc-0000-0000-0000-000000000003');
    v_state := 'aceitou';
    raise exception using errcode = 'ZZ115';
  exception
    when check_violation then v_state := '23514'; v_msg := sqlerrm;
    when sqlstate 'ZZ115' then null;
  end;
  perform pg_temp.tp_res(90, 'TP-6', case when v_state = '23514' and v_msg ilike '%organizacao%' then 'OK'
    else 'FALHOU: cliente de outra organizacao aceito ou recusado pela perna errada: ' || coalesce(v_state, 'null') || ' ' || coalesce(v_msg, '') end);
exception when others then
  perform pg_temp.tp_res(90, 'TP-6', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- ─── TP-6b (91): cliente anonimizado recusado ───────────────────────────────
do $$
declare v_state text; v_msg text;
begin
  begin
    update public.customers set deleted_at = now() where id = 'cccccccc-0000-0000-0000-000000000002';
    begin
      perform pg_temp.tp_ins('wamid.TP6b', p_customer => 'cccccccc-0000-0000-0000-000000000002');
      v_state := 'aceitou';
    exception when check_violation then v_state := '23514'; v_msg := sqlerrm;
    end;
    raise exception using errcode = 'ZZ115';
  exception when sqlstate 'ZZ115' then null;
  end;
  perform pg_temp.tp_res(91, 'TP-6b', case when v_state = '23514' and v_msg ilike '%anonimizado%' then 'OK'
    else 'FALHOU: cliente com deleted_at aceito: ' || coalesce(v_state, 'null') || ' ' || coalesce(v_msg, '') end);
exception when others then
  perform pg_temp.tp_res(91, 'TP-6b', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- ─── TP-7 (92): provider sem adReferral recusado pelo CHECK ─────────────────
do $$
declare v_state text; v_msg text;
begin
  begin
    perform pg_temp.tp_ins('wamid.TP7', p_provider => 'zapi');
    v_state := 'aceitou';
    raise exception using errcode = 'ZZ115';
  exception
    when check_violation then v_state := '23514'; v_msg := sqlerrm;
    when sqlstate 'ZZ115' then null;
  end;
  perform pg_temp.tp_res(92, 'TP-7', case when v_state = '23514' and v_msg ilike '%provider%' then 'OK'
    else 'FALHOU: provider zapi aceito: ' || coalesce(v_state, 'null') || ' ' || coalesce(v_msg, '') end);
exception when others then
  perform pg_temp.tp_res(92, 'TP-7', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- ─── TP-8 (93): CHECK de tamanho da subárvore (a REDE, 64 KiB) ──────────────
do $$
declare v_grande text; v_pequeno boolean := false; v_msg text;
begin
  begin
    begin
      perform pg_temp.tp_ins('wamid.TP8g', p_referral => jsonb_build_object('x', repeat('a', 70000)));
      v_grande := 'aceitou';
    exception when check_violation then v_grande := '23514'; v_msg := sqlerrm;
    end;
    perform pg_temp.tp_ins('wamid.TP8p', p_referral => jsonb_build_object('x', repeat('a', 1000)));
    v_pequeno := true;
    raise exception using errcode = 'ZZ115';
  exception when sqlstate 'ZZ115' then null;
  end;
  perform pg_temp.tp_res(93, 'TP-8', case when v_grande = '23514' and v_msg ilike '%referral%' and v_pequeno then 'OK'
    else 'FALHOU: CHECK de tamanho: grande=' || coalesce(v_grande, 'null') || ' pequeno=' || v_pequeno end);
exception when others then
  perform pg_temp.tp_res(93, 'TP-8', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- ─── TP-9 (94): soft delete COMO authenticated apaga os touchpoints dele, e só os dele
do $$
declare v_antes int; v_depois int; v_outro int; v_linhas int;
begin
  begin
    perform pg_temp.tp_ins('wamid.TP9a');
    perform pg_temp.tp_ins('wamid.TP9b');
    perform pg_temp.tp_ins('wamid.TP9c', p_customer => 'cccccccc-0000-0000-0000-000000000002');
    select count(*) into v_antes from public.whatsapp_ad_touchpoints where customer_id = 'cccccccc-0000-0000-0000-000000000001';
    set local role authenticated;
    update public.customers set deleted_at = now() where id = 'cccccccc-0000-0000-0000-000000000001';
    get diagnostics v_linhas = row_count;
    reset role;
    select count(*) into v_depois from public.whatsapp_ad_touchpoints where customer_id = 'cccccccc-0000-0000-0000-000000000001';
    select count(*) into v_outro  from public.whatsapp_ad_touchpoints where customer_id = 'cccccccc-0000-0000-0000-000000000002';
    raise exception using errcode = 'ZZ115';
  exception when sqlstate 'ZZ115' then null;
  end;
  perform pg_temp.tp_res(94, 'TP-9', case when v_antes = 2 and v_linhas = 1 and v_depois = 0 and v_outro = 1 then 'OK'
    else format('FALHOU: antes=%s update=%s depois=%s outro_cliente=%s (esperado 2/1/0/1)', v_antes, v_linhas, v_depois, v_outro) end);
exception when others then
  perform pg_temp.tp_res(94, 'TP-9', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- ─── TP-10 (95): RLS forçada, zero policies, triggers, ACL e forma das funções
-- Os literais apendados a `v_falhas` levam `::text` e isso foi MEDIDO: sem o
-- cast, `text[] || 'purga deveria ser DEFINER'` resolve o literal como ARRAY e
-- estoura 22P02 (`malformed array literal`). O caso ficava vermelho, mas pelo
-- `when others`, com uma mensagem que não nomeava o defeito — apareceu ao
-- persistir a sabotagem do C-115-4. Os que já concatenam (`'policies=' || n`)
-- são `text` e não precisam.
do $$
declare
  v_rls boolean; v_force boolean; v_pol int; v_trg int; v_fn regprocedure; v_def boolean;
  v_falhas text[] := '{}';
begin
  select relrowsecurity, relforcerowsecurity into v_rls, v_force
    from pg_class where oid = 'public.whatsapp_ad_touchpoints'::regclass;
  select count(*) into v_pol from pg_policy where polrelid = 'public.whatsapp_ad_touchpoints'::regclass;
  if not (v_rls and v_force) then v_falhas := v_falhas || 'rls nao forcada'::text; end if;
  if v_pol <> 0 then v_falhas := v_falhas || ('policies=' || v_pol); end if;

  select count(*) into v_trg from pg_trigger
   where not tgisinternal
     and tgname in ('whatsapp_ad_touchpoints_guard_trg', 'customers_purge_ad_touchpoints_trg');
  if v_trg <> 2 then v_falhas := v_falhas || ('triggers=' || v_trg); end if;

  foreach v_fn in array array[
    'public.whatsapp_ad_touchpoints_guard()'::regprocedure,
    'public.purge_ad_touchpoints_on_customer_anonymize()'::regprocedure
  ] loop
    if has_function_privilege('anon', v_fn, 'EXECUTE') then v_falhas := v_falhas || (v_fn::text || ' anon'); end if;
    if has_function_privilege('authenticated', v_fn, 'EXECUTE') then v_falhas := v_falhas || (v_fn::text || ' authenticated'); end if;
    if exists (
      select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
       where p.oid = v_fn and a.grantee = 0 and a.privilege_type = 'EXECUTE'
    ) then v_falhas := v_falhas || (v_fn::text || ' PUBLIC'); end if;
    if not exists (select 1 from pg_proc where oid = v_fn and 'search_path=""' = any(proconfig)) then
      v_falhas := v_falhas || (v_fn::text || ' sem search_path vazio');
    end if;
  end loop;

  select prosecdef into v_def from pg_proc where oid = 'public.whatsapp_ad_touchpoints_guard()'::regprocedure;
  if v_def then v_falhas := v_falhas || 'guard deveria ser INVOKER'::text; end if;
  select prosecdef into v_def from pg_proc where oid = 'public.purge_ad_touchpoints_on_customer_anonymize()'::regprocedure;
  if not v_def then v_falhas := v_falhas || 'purga deveria ser DEFINER'::text; end if;

  -- O formato de `set search_path = ''` em `proconfig` foi MEDIDO no
  -- PostgreSQL 18.4: `{"search_path=\"\""}`, isto é, o elemento
  -- `search_path=""` — o que a comparação acima exige. Se uma versão futura
  -- gravar diferente, meça (`select proconfig from pg_proc where proname =
  -- 'whatsapp_ad_touchpoints_guard'`) e ajuste a comparação, registrando aqui.
  -- Nunca afrouxe para "tem search_path".
  perform pg_temp.tp_res(95, 'TP-10', case when cardinality(v_falhas) = 0 then 'OK'
    else 'FALHOU: ' || array_to_string(v_falhas, '; ') end);
exception when others then
  perform pg_temp.tp_res(95, 'TP-10', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- ─── TP-11 (96): idempotência ATRAVÉS DE EXECUÇÕES ──────────────────────────
-- A 1a execução deste arquivo grava a assinatura do catálogo; o README manda
-- reaplicar a 115 duas vezes e rodar este arquivo de novo, e a 2a compara. As
-- duas leituras num único `do $$` veriam o mesmo estado e não mediriam nada.
do $$
declare v_assinatura text; v_gravada text; v_linhas bigint;
begin
  select string_agg(x, E'\n' order by x) into v_assinatura from (
    select 'col:' || attname || ':' || format_type(atttypid, atttypmod) || ':' || attnotnull
      from pg_attribute where attrelid = 'public.whatsapp_ad_touchpoints'::regclass and attnum > 0 and not attisdropped
    union all
    select 'con:' || conname || ':' || pg_get_constraintdef(oid)
      from pg_constraint where conrelid = 'public.whatsapp_ad_touchpoints'::regclass
    union all
    select 'idx:' || indexrelid::regclass::text || ':' || pg_get_indexdef(indexrelid)
      from pg_index where indrelid = 'public.whatsapp_ad_touchpoints'::regclass
    union all
    select 'trg:' || tgname || ':' || pg_get_triggerdef(oid)
      from pg_trigger where not tgisinternal
       and tgrelid in ('public.whatsapp_ad_touchpoints'::regclass, 'public.customers'::regclass)
    union all
    select 'fn:' || p.oid::regprocedure::text || ':' || md5(pg_get_functiondef(p.oid)) || ':' || coalesce(p.proacl::text, 'null')
      from pg_proc p where p.proname in ('whatsapp_ad_touchpoints_guard', 'purge_ad_touchpoints_on_customer_anonymize')
    union all
    select 'rls:' || relrowsecurity || ':' || relforcerowsecurity
      from pg_class where oid = 'public.whatsapp_ad_touchpoints'::regclass
  ) s(x);
  select count(*) into v_linhas from public.whatsapp_ad_touchpoints;
  select v into v_gravada from t_snap115 where k = 'assinatura';

  if v_gravada is null then
    insert into t_snap115 values ('assinatura', v_assinatura);
    perform pg_temp.tp_res(96, 'TP-11', 'PENDENTE: assinatura gravada — reaplique a 115 duas vezes e rode este arquivo de novo');
  elsif v_gravada = v_assinatura and v_linhas = 0 then
    perform pg_temp.tp_res(96, 'TP-11', 'OK');
  else
    perform pg_temp.tp_res(96, 'TP-11', format('FALHOU: catalogo mudou entre execucoes da 115 (%s) ou sobrou linha (%s)',
      case when v_gravada = v_assinatura then 'igual' else 'diferente' end, v_linhas));
  end if;
exception when others then
  perform pg_temp.tp_res(96, 'TP-11', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

select ord, caso, veredito from t_res where ord between 85 and 96 or ord in (102, 103) order by ord;
