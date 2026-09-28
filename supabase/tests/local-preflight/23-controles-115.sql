-- SEIS CONTROLES POSITIVOS da migration 115 — ordinais 97..101 e 104.
--
-- Rodar SEM ON_ERROR_STOP, pela convenção dos outros `NN-controles-*.sql`: os
-- casos sabotam de propósito e um erro no meio não deve sumir com os vereditos
-- dos seguintes.
--
-- Sem eles, "TP-* passaram" não distingue o guard funcionando de teste sem
-- força. Cada controle reintroduz UM defeito e mede que o comportamento que o
-- caso alvo protege QUEBRA:
--
--   C-115-1 (97)   guard sem `<excecao-set-null>`   -> apagar o canal ABORTA (TP-4)
--   C-115-2 (98)   guard sem `<coerencia-tenant>`   -> canal e cliente alheios entram (TP-5, TP-6)
--   C-115-3 (99)   guard sem `<guarda-update>`      -> o touchpoint é reescrito (TP-3)
--   C-115-4 (100)  purga como SECURITY INVOKER      -> soft delete apaga ZERO linhas, em silêncio (TP-9)
--   C-115-5 (101)  drop + create sem o `revoke`     -> `anon` volta a ter EXECUTE (TP-10)
--   C-115-6 (104)  guard sem `<cliente-vivo>`       -> cliente anonimizado aceito (TP-6b)
--
-- ═══ SABOTAGEM POR DELTA MÍNIMO ENTRE MARCADORES ════════════════════════════
--
-- C-115-1/2/3/6 não redigitam o guard: leem o corpo REAL de
-- `pg_get_functiondef`, recortam o trecho entre `-- <marcador>` e
-- `-- </marcador>` (os comentários da migration existem para isto — não os
-- remova) e executam o resultado. Redigitado à mão, o corpo divergiria do real
-- em mais de um ponto, e o vermelho não diria qual.
--
-- `pg_temp.sem_trecho` usa `.*?` sem flag nenhuma, e isso foi MEDIDO no
-- PostgreSQL 18.4: no ARE do Postgres `.` casa quebra de linha por default (só a
-- flag `n` a torna sensível a newline), e a gula do RE inteiro é a do primeiro
-- quantificador (`.*?`, não-guloso) — então o recorte vai do marcador de
-- abertura ao PRIMEIRO de fechamento, atravessando linhas. Cada controle confere
-- `mudou=t` antes de medir: sabotagem que não sabota é o modo silencioso de um
-- controle positivo mentir (a lição do `15-controles-109.sql`).
--
-- ═══ O RESTORE MORA DENTRO DE CADA CONTROLE ═════════════════════════════════
--
-- Reaplicar a 115 restauraria as FUNÇÕES (`create or replace function`,
-- `drop trigger if exists` + `create trigger`, e os `revoke`) — mas NÃO a
-- tabela: ela é `create table if not exists` + `create index if not exists`, e
-- com a tabela já existindo reaplicar é no-op sobre colunas, CHECKs, FKs e
-- índices (a nota "Por que reaplicar a 111 não restaura" do README). Um arquivo
-- de controles que dependa de o operador reaplicar a migration deixa schema
-- sabotado de pé quando ele esquece, e aqui a sabotagem esquecida é o guard de
-- tenant. Por isso cada controle, como no `17` e no `19`: (1) captura a
-- definição REAL do catálogo antes de mexer, (2) confere que a sabotagem mudou
-- o catálogo, (3) mede o defeito, (4) desfaz por ROLLBACK de subtransação
-- (`raise ... using errcode = 'ZZ115'`) e (5) confere o restore contra o
-- catálogo. O veredito só é `OK` se as três metades casarem: a sabotagem mudou,
-- o defeito apareceu, o catálogo voltou.
--
-- O handler `when others` de cada bloco também desfaz: DDL em plpgsql roda na
-- subtransação do bloco, então falha no meio volta atrás. Nenhum caminho deixa
-- função sabotada de pé.

-- ─── GUARDA com SENTINELA (ord = -23) ───────────────────────────────────────
-- Este arquivo roda SEM ON_ERROR_STOP: um `raise` aqui imprimiria ERROR e o psql
-- seguiria, e os controles "passariam" sobre zero caso TP. A linha sentinela é o
-- que faz a falha aparecer no topo de `select ... order by ord`.
--
-- Gravar e levantar em DOIS statements, não num só: o `raise` desfaz a
-- transação do próprio `do $$`, e a sentinela gravada nele sumiria junto.
-- Mesmo desenho da guarda do `17-controles-111.sql` (sentinela `ord = 0`) e do
-- `19` (`ord = -19`); ordinal PRÓPRIO, para que um `23` saudável nunca apague a
-- sentinela de outro arquivo de controles que falhou.
create table if not exists t_res (ord int primary key, caso text, veredito text);

do $$
begin
  delete from t_res where ord = -23;
  if to_regclass('public.whatsapp_ad_touchpoints') is null
     or not exists (select 1 from t_res where ord = 94) then
    insert into t_res values (-23, 'GUARDA-23', 'FALHOU: rode 00 -> 00a -> 22a -> 115 -> 22 antes deste arquivo');
  end if;
end $$;

do $$
begin
  if exists (select 1 from t_res where ord = -23) then
    raise exception '23-controles-115.sql: pre-requisitos ausentes (ver sentinela ord -23)';
  end if;
end $$;

create or replace function pg_temp.tp_res(p_ord int, p_caso text, p_veredito text)
returns void language sql as $$
  insert into t_res values (p_ord, p_caso, p_veredito)
  on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
$$;

create or replace function pg_temp.tp_ins(
  p_msg text,
  p_unit uuid default 'bbbbbbbb-0000-0000-0000-000000000001',
  p_channel uuid default 'dddddddd-0000-0000-0000-000000000001',
  p_customer uuid default 'cccccccc-0000-0000-0000-000000000001'
) returns uuid language sql as $$
  insert into public.whatsapp_ad_touchpoints
    (unit_id, channel_id, customer_id, provider, provider_message_id, message_at, ctwa_clid)
  values (p_unit, p_channel, p_customer, 'datafy', p_msg, now(), 'clid-' || p_msg)
  returning id;
$$;

-- Recorta o trecho entre `-- <marcador>` e `-- </marcador>` do corpo real.
create or replace function pg_temp.sem_trecho(p_def text, p_marcador text)
returns text language sql as $$
  select regexp_replace(p_def, '-- <' || p_marcador || '>.*?-- </' || p_marcador || '>', '')
$$;

-- ─── C-115-1 (97): sem a exceção do set null, apagar o canal ABORTA ─────────
do $$
declare
  v_fn regprocedure := 'public.whatsapp_ad_touchpoints_guard()'::regprocedure;
  v_real text := pg_get_functiondef('public.whatsapp_ad_touchpoints_guard()'::regprocedure);
  v_sabotado text; v_mudou boolean := false; v_abortou boolean := false; v_restaurou boolean;
  v_chan uuid := 'dddddddd-0000-0000-0000-0000000000c1';
begin
  begin
    v_sabotado := pg_temp.sem_trecho(v_real, 'excecao-set-null');
    execute v_sabotado;
    v_mudou := pg_get_functiondef(v_fn) <> v_real;
    insert into whatsapp_channels (id, unit_id, provider, status, display_phone)
    values (v_chan, 'bbbbbbbb-0000-0000-0000-000000000001', 'official', 'disconnected', '5511000000c1');
    perform pg_temp.tp_ins('wamid.C1151', p_channel => v_chan);
    begin
      delete from whatsapp_channels where id = v_chan;
    exception when check_violation then v_abortou := true;
    end;
    raise exception using errcode = 'ZZ115';
  exception when sqlstate 'ZZ115' then null;
  end;
  v_restaurou := pg_get_functiondef(v_fn) = v_real;
  perform pg_temp.tp_res(97, 'C-115-1', case when v_mudou and v_abortou and v_restaurou then 'OK'
    else format('FALHOU: mudou=%s abortou=%s restaurou=%s (sem a excecao, o DELETE do canal TEM de abortar)', v_mudou, v_abortou, v_restaurou) end);
exception when others then
  perform pg_temp.tp_res(97, 'C-115-1', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- ─── C-115-2 (98): sem as pernas de coerência, TP-5 e TP-6 passam ───────────
do $$
declare
  v_fn regprocedure := 'public.whatsapp_ad_touchpoints_guard()'::regprocedure;
  v_real text := pg_get_functiondef('public.whatsapp_ad_touchpoints_guard()'::regprocedure);
  v_mudou boolean := false; v_canal_passou boolean := false; v_org_passou boolean := false; v_restaurou boolean;
begin
  begin
    execute pg_temp.sem_trecho(v_real, 'coerencia-tenant');
    v_mudou := pg_get_functiondef(v_fn) <> v_real;
    perform pg_temp.tp_ins('wamid.C1152a', p_channel => 'dddddddd-0000-0000-0000-000000000002');
    v_canal_passou := true;
    perform pg_temp.tp_ins('wamid.C1152b', p_channel => null, p_customer => 'cccccccc-0000-0000-0000-000000000003');
    v_org_passou := true;
    raise exception using errcode = 'ZZ115';
  exception when sqlstate 'ZZ115' then null;
  end;
  v_restaurou := pg_get_functiondef(v_fn) = v_real;
  perform pg_temp.tp_res(98, 'C-115-2', case when v_mudou and v_canal_passou and v_org_passou and v_restaurou then 'OK'
    else format('FALHOU: mudou=%s canal_alheio=%s org_alheia=%s restaurou=%s', v_mudou, v_canal_passou, v_org_passou, v_restaurou) end);
exception when others then
  perform pg_temp.tp_res(98, 'C-115-2', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- ─── C-115-3 (99): sem a guarda de UPDATE, o touchpoint é reescrito ─────────
do $$
declare
  v_fn regprocedure := 'public.whatsapp_ad_touchpoints_guard()'::regprocedure;
  v_real text := pg_get_functiondef('public.whatsapp_ad_touchpoints_guard()'::regprocedure);
  v_mudou boolean := false; v_reescrito boolean := false; v_restaurou boolean; v_id uuid; v_clid text;
begin
  begin
    execute pg_temp.sem_trecho(v_real, 'guarda-update');
    v_mudou := pg_get_functiondef(v_fn) <> v_real;
    v_id := pg_temp.tp_ins('wamid.C1153');
    update public.whatsapp_ad_touchpoints set ctwa_clid = 'reescrito' where id = v_id;
    select ctwa_clid into v_clid from public.whatsapp_ad_touchpoints where id = v_id;
    v_reescrito := v_clid = 'reescrito';
    raise exception using errcode = 'ZZ115';
  exception when sqlstate 'ZZ115' then null;
  end;
  v_restaurou := pg_get_functiondef(v_fn) = v_real;
  perform pg_temp.tp_res(99, 'C-115-3', case when v_mudou and v_reescrito and v_restaurou then 'OK'
    else format('FALHOU: mudou=%s reescrito=%s restaurou=%s', v_mudou, v_reescrito, v_restaurou) end);
exception when others then
  perform pg_temp.tp_res(99, 'C-115-3', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- ─── C-115-4 (100): purga como INVOKER apaga ZERO linhas em silêncio ────────
do $$
declare
  v_fn regprocedure := 'public.purge_ad_touchpoints_on_customer_anonymize()'::regprocedure;
  v_mudou boolean := false; v_sobraram int; v_restaurou boolean;
begin
  begin
    alter function public.purge_ad_touchpoints_on_customer_anonymize() security invoker;
    select not prosecdef into v_mudou from pg_proc where oid = v_fn;
    perform pg_temp.tp_ins('wamid.C1154a');
    perform pg_temp.tp_ins('wamid.C1154b');
    set local role authenticated;
    update public.customers set deleted_at = now() where id = 'cccccccc-0000-0000-0000-000000000001';
    reset role;
    select count(*) into v_sobraram from public.whatsapp_ad_touchpoints where customer_id = 'cccccccc-0000-0000-0000-000000000001';
    raise exception using errcode = 'ZZ115';
  exception when sqlstate 'ZZ115' then null;
  end;
  select prosecdef into v_restaurou from pg_proc where oid = v_fn;
  perform pg_temp.tp_res(100, 'C-115-4', case when v_mudou and v_sobraram = 2 and v_restaurou then 'OK'
    else format('FALHOU: mudou=%s sobraram=%s (esperado 2: o defeito e o silencio) restaurou=%s', v_mudou, v_sobraram, v_restaurou) end);
exception when others then
  perform pg_temp.tp_res(100, 'C-115-4', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- ─── C-115-5 (101): drop + create sem revoke reabre EXECUTE a anon ──────────
do $$
declare
  v_real text := pg_get_functiondef('public.whatsapp_ad_touchpoints_guard()'::regprocedure);
  v_reabriu boolean := false; v_fechado boolean; v_trg boolean;
begin
  begin
    drop function public.whatsapp_ad_touchpoints_guard() cascade;
    execute v_real;
    v_reabriu := has_function_privilege('anon', 'public.whatsapp_ad_touchpoints_guard()', 'EXECUTE');
    raise exception using errcode = 'ZZ115';
  exception when sqlstate 'ZZ115' then null;
  end;
  v_fechado := not has_function_privilege('anon', 'public.whatsapp_ad_touchpoints_guard()', 'EXECUTE');
  select exists (select 1 from pg_trigger where tgname = 'whatsapp_ad_touchpoints_guard_trg' and not tgisinternal) into v_trg;
  perform pg_temp.tp_res(101, 'C-115-5', case when v_reabriu and v_fechado and v_trg then 'OK'
    else format('FALHOU: reabriu=%s fechado_apos_restore=%s trigger_restaurado=%s', v_reabriu, v_fechado, v_trg) end);
exception when others then
  perform pg_temp.tp_res(101, 'C-115-5', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

-- ─── C-115-6 (104): sem a perna cliente-vivo, TP-6b passa ───────────────────
do $$
declare
  v_fn regprocedure := 'public.whatsapp_ad_touchpoints_guard()'::regprocedure;
  v_real text := pg_get_functiondef('public.whatsapp_ad_touchpoints_guard()'::regprocedure);
  v_mudou boolean := false; v_passou boolean := false; v_restaurou boolean;
begin
  begin
    execute pg_temp.sem_trecho(v_real, 'cliente-vivo');
    v_mudou := pg_get_functiondef(v_fn) <> v_real;
    update public.customers set deleted_at = now() where id = 'cccccccc-0000-0000-0000-000000000002';
    perform pg_temp.tp_ins('wamid.C1156', p_customer => 'cccccccc-0000-0000-0000-000000000002');
    v_passou := true;
    raise exception using errcode = 'ZZ115';
  exception when sqlstate 'ZZ115' then null;
  end;
  v_restaurou := pg_get_functiondef(v_fn) = v_real;
  perform pg_temp.tp_res(104, 'C-115-6', case when v_mudou and v_passou and v_restaurou then 'OK'
    else format('FALHOU: mudou=%s anonimizado_aceito=%s restaurou=%s', v_mudou, v_passou, v_restaurou) end);
exception when others then
  perform pg_temp.tp_res(104, 'C-115-6', 'FALHOU: ' || sqlstate || ' ' || sqlerrm);
end $$;

select ord, caso, veredito from t_res order by ord;
