-- STATS-1..STATS-8 (ordinais 17..24): guard de tenant da migration 108 em
-- `public.get_customer_stats(uuid,uuid)` contra Postgres real.
--
-- STATS-1/4/6 são o caminho de PERMITIR; STATS-2/3/5 o de NEGAR; STATS-7 a ACL
-- e STATS-8 a idempotência através de duas execuções. Guard só testado no allow
-- não notaria um `if not (...)` invertido nem `is_org_member` trocado por
-- `is_unit_member` — é o mesmo motivo pelo qual o `09` ganhou
-- ACL-1b/3b/3c/3d depois de já estar verde.
--
-- Rodar depois de 00, 01, 09a, 106, 09 (2x), 10, 11, 107, 11 e da própria 108,
-- com ON_ERROR_STOP=1. Este arquivo é RODADO DUAS VEZES, com a 108 reaplicada
-- no meio — é assim que STATS-8 mede idempotência (ver o caso).
--
-- O CORPO PRÉ-108 NÃO É RECRIADO AQUI: o `09a-advisor-bootstrap.sql` já traz
-- `get_customer_stats` (os dois overloads, extraídos de produção) desde a Task 5
-- da 107. Quando este arquivo roda, a função já existe — na forma sem guard
-- antes da 108, com guard depois dela.
--
-- POR QUE OS HANDLERS `when others` GRAVAM COM `on conflict (ord) do update`:
-- o `delete from t_res where ord = N` do início de cada caso é DESFEITO pelo
-- próprio `exception` que o handler trata (em plpgsql o handler roda depois do
-- rollback da subtransação). Na 2a passada, caso que estoura tentaria INSERIR
-- ordinal que a 1a já gravou e morreria com chave duplicada — o que sob
-- ON_ERROR_STOP=1 aborta o arquivo e apaga justamente os vereditos de quem
-- precisa deles. Mesma razão documentada no `09`.

-- ─── GUARDA: este arquivo só faz sentido DEPOIS da 108 ──────────────────────
-- Rodado antes, STATS-2/3/5 reprovariam (é o RED que dá sentido ao GREEN), mas
-- STATS-1/6/7 passariam medindo o mundo pré-migration e STATS-8 gravaria um
-- snapshot do corpo SEM guard, contra o qual a 1a passada de verdade
-- reprovaria. Melhor recusar explicitamente, como o `09` faz.
do $$
begin
  if to_regprocedure('public.get_customer_stats(uuid,uuid)') is null then
    raise exception '12-customer-stats-108.sql exige 09a-advisor-bootstrap.sql aplicado antes (public.get_customer_stats(uuid,uuid) ausente). Sequencia do README: 00 -> 01 -> 09a -> 106 -> 09 -> 10 -> 11 -> 107 -> 11 -> 108 -> 12.';
  end if;
  if pg_get_functiondef('public.get_customer_stats(uuid,uuid)'::regprocedure) not like '%is_org_member%' then
    raise exception '12-customer-stats-108.sql exige a migration 108 aplicada (o corpo de public.get_customer_stats nao chama is_org_member, ou seja, nao tem guard de tenant). Este arquivo mede o estado DEPOIS do guard; rodado antes, metade dos casos reportaria OK sobre o mundo pre-migration. Aplique supabase/migrations/20260921120000_108_customer_stats_tenant_guard.sql e rode de novo.';
  end if;
end $$;

create table if not exists t_res (ord int primary key, caso text, veredito text);

-- Snapshot que atravessa as duas execuções. Mesmo motivo do `t_acl_snap` do
-- `09`: duas leituras dentro de um único `do $$` compararia o estado consigo
-- mesmo e não mediria nada.
create table if not exists t_stats_snap (ord int primary key, def_md5 text, acl text);

-- ─── Fixtures próprias deste arquivo ────────────────────────────────────────
-- Moram AQUI e não no `09a` por duas razões: (1) o `09a` é compartilhado com os
-- casos 1–16, que já rodaram quando este arquivo entra, e mexer nele arriscaria
-- mudar o que eles mediram; (2) a segunda unidade da org A é **não pública** de
-- propósito — os casos do `09` resolvem a unidade por `where is_public limit 1`
-- e uma segunda unidade pública tornaria aquela escolha não-determinística.
insert into auth.users (id, email) values
  ('44444444-4444-4444-4444-444444444444', 'platform-admin@teste.local')
on conflict do nothing;

insert into platform_admins (user_id) values
  ('44444444-4444-4444-4444-444444444444')
on conflict do nothing;

insert into units (id, organization_id, name, slug, is_public) values
  ('bbbbbbbb-0000-0000-0000-000000000003',
   'aaaaaaaa-0000-0000-0000-000000000001', 'Unidade Advisor A2', 'unidade-advisor-a2', false)
on conflict (id) do nothing;

-- Reservas: o harness não tinha NENHUMA. Os números da org A e da org B são
-- diferentes de propósito — é o que faz o vazamento do CONTROLE-25 ser
-- inconfundível em vez de parecer "cliente sem reserva nenhuma".
--
-- Cliente da org A, na unidade A: 2 confirmed, 1 no_show, 1 cancelled
--   => total 4, taxa round(1/3,3)=0.333, ultima presenca 2026-09-05
-- Mais 1 confirmed na SEGUNDA unidade da org A (nao publica), que so entra no
-- agregado de ORG => total 5, taxa round(1/4,3)=0.250, ultima 2026-09-09.
-- Sem essa linha, STATS-6 (`p_unit_id => null`) seria tautologia.
-- Cliente da org B: 3 confirmed, nenhum no_show, nenhum cancelled => total 3.
insert into reservations (id, unit_id, customer_id, status, party_size, date, time, reservation_code) values
  ('dddddddd-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000001','eeeeeeee-0000-0000-0000-000000000004','confirmed',2,'2026-09-01','19:00','STATSA1'),
  ('dddddddd-0000-0000-0000-000000000002','bbbbbbbb-0000-0000-0000-000000000001','eeeeeeee-0000-0000-0000-000000000004','confirmed',2,'2026-09-05','19:00','STATSA2'),
  ('dddddddd-0000-0000-0000-000000000003','bbbbbbbb-0000-0000-0000-000000000001','eeeeeeee-0000-0000-0000-000000000004','no_show',  2,'2026-09-03','19:00','STATSA3'),
  ('dddddddd-0000-0000-0000-000000000004','bbbbbbbb-0000-0000-0000-000000000001','eeeeeeee-0000-0000-0000-000000000004','cancelled',2,'2026-09-07','19:00','STATSA4'),
  ('dddddddd-0000-0000-0000-000000000005','bbbbbbbb-0000-0000-0000-000000000003','eeeeeeee-0000-0000-0000-000000000004','confirmed',2,'2026-09-09','19:00','STATSA5'),
  ('dddddddd-0000-0000-0000-000000000006','bbbbbbbb-0000-0000-0000-000000000002','eeeeeeee-0000-0000-0000-000000000005','confirmed',4,'2026-09-02','20:00','STATSB1'),
  ('dddddddd-0000-0000-0000-000000000007','bbbbbbbb-0000-0000-0000-000000000002','eeeeeeee-0000-0000-0000-000000000005','confirmed',4,'2026-09-04','20:00','STATSB2'),
  ('dddddddd-0000-0000-0000-000000000008','bbbbbbbb-0000-0000-0000-000000000002','eeeeeeee-0000-0000-0000-000000000005','confirmed',4,'2026-09-06','20:00','STATSB3')
on conflict (id) do nothing;

-- ─── STATS-1: membro da org lê o próprio cliente e os números batem ─────────
do $$
declare v_membro_a uuid := '11111111-1111-1111-1111-111111111111';
        v_unit_a   uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_cust_a   uuid := 'eeeeeeee-0000-0000-0000-000000000004';
        r record;
begin
  delete from t_res where ord = 17;
  perform set_config('request.jwt.claims', json_build_object('sub', v_membro_a)::text, true);
  set local role authenticated;
  select * into r from get_customer_stats(v_cust_a, v_unit_a);
  reset role;

  insert into t_res values (17, 'STATS-1 membro le o proprio cliente com os numeros certos',
    case
      when r.total = 4 and r.confirmed = 2 and r.no_shows = 1 and r.cancelled = 1
       and r.no_show_rate = 0.333 and r.last_visit = date '2026-09-05'
        then 'OK (4/2/1/1, taxa 0.333, ultima 2026-09-05)'
      else 'FALHOU (veio total=' || coalesce(r.total::text,'null')
             || ' conf=' || coalesce(r.confirmed::text,'null')
             || ' ns='   || coalesce(r.no_shows::text,'null')
             || ' canc=' || coalesce(r.cancelled::text,'null')
             || ' taxa=' || coalesce(r.no_show_rate::text,'null')
             || ' ult='  || coalesce(r.last_visit::text,'null') || ')'
    end);
exception when others then
  reset role;
  insert into t_res values (17, 'STATS-1 membro le o proprio cliente com os numeros certos', 'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── STATS-2: membro da org A pedindo cliente da org B é RECUSADO ───────────
-- O caso mais valioso: guard quebrado aqui não estoura, VAZA DADO de outro
-- tenant. Captura `insufficient_privilege` ESPECIFICAMENTE (não `when others`):
-- recusa e linha de zeros são resultados diferentes, e um `when others`
-- confundiria os dois com qualquer outro erro. O contra-caso é o STATS-1, que
-- chama a mesma função como membro e recebe linha — "recusou" aqui não é "a
-- função está quebrada".
do $$
declare v_membro_a uuid := '11111111-1111-1111-1111-111111111111';
        v_unit_a   uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_cust_b   uuid := 'eeeeeeee-0000-0000-0000-000000000005';
        v_total int; v_recusou boolean := false; v_err text;
begin
  delete from t_res where ord = 18;
  perform set_config('request.jwt.claims', json_build_object('sub', v_membro_a)::text, true);
  set local role authenticated;
  begin
    select total into v_total from get_customer_stats(v_cust_b, v_unit_a);
  exception when insufficient_privilege then
    v_recusou := true;
    get stacked diagnostics v_err = message_text;
  end;
  reset role;

  insert into t_res values (18, 'STATS-2 membro da org A nao le cliente da org B',
    case
      when v_recusou then 'OK (raise 42501 "' || v_err || '")'
      else 'FALHOU (nao recusou: devolveu total=' || coalesce(v_total::text,'null') || ')'
    end);
exception when others then
  reset role;
  insert into t_res values (18, 'STATS-2 membro da org A nao le cliente da org B', 'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── STATS-3: sem sessão é RECUSADO ─────────────────────────────────────────
-- `request.jwt.claims` em string vazia: o `auth.uid()` do `09a` faz
-- `nullif(...,'')` nas duas formas de GUC, então isto é exatamente "sem sessão".
-- Sem o guard, o corpo antigo devolveria uma LINHA DE ZEROS aqui, porque
-- `count(*)` sobre conjunto vazio sempre produz linha.
do $$
declare v_unit_a uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_cust_a uuid := 'eeeeeeee-0000-0000-0000-000000000004';
        v_total int; v_recusou boolean := false; v_err text;
begin
  delete from t_res where ord = 19;
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  set local role authenticated;
  begin
    select total into v_total from get_customer_stats(v_cust_a, v_unit_a);
  exception when insufficient_privilege then
    v_recusou := true;
    get stacked diagnostics v_err = message_text;
  end;
  reset role;

  insert into t_res values (19, 'STATS-3 sem sessao e recusado, nao devolve zeros',
    case
      when v_recusou then 'OK (raise 42501 "' || v_err || '")'
      else 'FALHOU (nao recusou: devolveu total=' || coalesce(v_total::text,'null') || ')'
    end);
exception when others then
  reset role;
  insert into t_res values (19, 'STATS-3 sem sessao e recusado, nao devolve zeros', 'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── STATS-4: platform_admin SEM linha em unit_members passa ────────────────
-- É o caso que o paralelo `is_platform_admin` existe para cobrir:
-- `useCurrentUnit` fabrica pseudo-membership "owner" para o super-admin operar
-- unidade alheia, e no banco não há linha em `unit_members` nenhuma. Sem esse
-- ramo, o guard bloquearia exatamente quem a UI mostra como "Proprietário".
-- A primeira condição do `case` é uma trava de FIXTURE: se o admin tiver linha
-- em `unit_members`, este caso passaria pelo ramo `is_org_member` e não mediria
-- nada do que promete.
do $$
declare v_admin  uuid := '44444444-4444-4444-4444-444444444444';
        v_unit_a uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_cust_a uuid := 'eeeeeeee-0000-0000-0000-000000000004';
        v_total int; v_membro boolean;
begin
  delete from t_res where ord = 20;
  select exists (select 1 from unit_members where user_id = v_admin) into v_membro;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin)::text, true);
  set local role authenticated;
  select total into v_total from get_customer_stats(v_cust_a, v_unit_a);
  reset role;

  insert into t_res values (20, 'STATS-4 platform_admin sem unit_members passa',
    case
      when v_membro then 'FALHOU (fixture invalida: o admin tem linha em unit_members, o caso nao mede o ramo is_platform_admin)'
      when v_total = 4 then 'OK (total=4 sem nenhuma linha em unit_members)'
      else 'FALHOU (esperado total=4, veio ' || coalesce(v_total::text,'null') || ')'
    end);
exception when others then
  reset role;
  insert into t_res values (20, 'STATS-4 platform_admin sem unit_members passa', 'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── STATS-5: id inexistente cai no MESMO ramo do proibido ──────────────────
-- Sem isto a recusa seria oráculo de existência: "42501" para cliente alheio e
-- "linha de zeros" para id inexistente diria ao atacante quais UUIDs existem.
-- A asserção é sobre a MENSAGEM, não só sobre ter recusado — é o que amarra os
-- dois ramos ao mesmo texto.
do $$
declare v_membro_a uuid := '11111111-1111-1111-1111-111111111111';
        v_unit_a   uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_fantasma uuid := '99999999-9999-9999-9999-999999999999';
        v_total int; v_recusou boolean := false; v_err text;
begin
  delete from t_res where ord = 21;
  perform set_config('request.jwt.claims', json_build_object('sub', v_membro_a)::text, true);
  set local role authenticated;
  begin
    select total into v_total from get_customer_stats(v_fantasma, v_unit_a);
  exception when insufficient_privilege then
    v_recusou := true;
    get stacked diagnostics v_err = message_text;
  end;
  reset role;

  insert into t_res values (21, 'STATS-5 id inexistente recusa igual a cliente alheio (sem oraculo)',
    case
      when v_recusou and v_err = 'forbidden' then 'OK (mesma mensagem "forbidden" do STATS-2)'
      when v_recusou then 'FALHOU (recusou com mensagem DIFERENTE do STATS-2: "' || v_err || '" - vira oraculo de existencia)'
      else 'FALHOU (nao recusou: devolveu total=' || coalesce(v_total::text,'null') || ')'
    end);
exception when others then
  reset role;
  insert into t_res values (21, 'STATS-5 id inexistente recusa igual a cliente alheio (sem oraculo)', 'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── STATS-6: `p_unit_id => null` continua sendo o agregado da ORG ──────────
-- O guard não estreitou a semântica: null segue significando "toda unidade da
-- org do cliente". A asserção é sobre a DIFERENÇA (5 na org, 4 na unidade) —
-- sem a reserva da segunda unidade nas fixtures isto seria tautologia.
do $$
declare v_membro_a uuid := '11111111-1111-1111-1111-111111111111';
        v_unit_a   uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_cust_a   uuid := 'eeeeeeee-0000-0000-0000-000000000004';
        v_org int; v_unidade int; v_ult date;
begin
  delete from t_res where ord = 22;
  perform set_config('request.jwt.claims', json_build_object('sub', v_membro_a)::text, true);
  set local role authenticated;
  select total, last_visit into v_org, v_ult from get_customer_stats(v_cust_a, null);
  select total                into v_unidade from get_customer_stats(v_cust_a, v_unit_a);
  reset role;

  insert into t_res values (22, 'STATS-6 p_unit_id null segue agregando a org inteira',
    case
      when v_org = 5 and v_unidade = 4 and v_ult = date '2026-09-09'
        then 'OK (org=5, unidade=4, ultima da org 2026-09-09)'
      else 'FALHOU (esperado org=5/unidade=4/ult=2026-09-09, veio org='
             || coalesce(v_org::text,'null') || '/unidade=' || coalesce(v_unidade::text,'null')
             || '/ult=' || coalesce(v_ult::text,'null') || ')'
    end);
exception when others then
  reset role;
  insert into t_res values (22, 'STATS-6 p_unit_id null segue agregando a org inteira', 'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── STATS-7: ACL — `authenticated` executa, `anon` e PUBLIC não ────────────
-- `proacl` nulo NÃO é "ninguém tem": é a ACL DEFAULT, que em função concede
-- EXECUTE a PUBLIC. Tratar nulo como falso aqui deixaria passar exatamente o
-- estado que a migration existe para evitar.
do $$
declare v_auth boolean; v_anon boolean; v_pub boolean;
begin
  delete from t_res where ord = 23;
  select has_function_privilege('authenticated', 'public.get_customer_stats(uuid,uuid)', 'EXECUTE') into v_auth;
  select has_function_privilege('anon',          'public.get_customer_stats(uuid,uuid)', 'EXECUTE') into v_anon;
  select case
           when p.proacl is null then true
           else coalesce((select true from aclexplode(p.proacl) a
                           where a.grantee = 0 and a.privilege_type = 'EXECUTE' limit 1), false)
         end
    into v_pub
    from pg_proc p where p.oid = 'public.get_customer_stats(uuid,uuid)'::regprocedure;

  insert into t_res values (23, 'STATS-7 ACL: authenticated executa, anon e PUBLIC nao',
    case
      when v_auth and not v_anon and not v_pub then 'OK (authenticated=t, anon=f, PUBLIC=f)'
      else 'FALHOU (authenticated=' || v_auth || ', anon=' || v_anon || ', PUBLIC=' || v_pub || ')'
    end);
exception when others then
  insert into t_res values (23, 'STATS-7 ACL: authenticated executa, anon e PUBLIC nao', 'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── STATS-8: idempotência medida ATRAVÉS DE DUAS EXECUÇÕES ─────────────────
-- A 1a passada grava corpo e ACL em `t_stats_snap`; a 2a compara. Reaplicar a
-- 108 no meio é o que está sendo medido. Mesmo desenho do ACL-5 no `09`.
do $$
declare v_def_md5 text; v_acl text; s record;
begin
  delete from t_res where ord = 24;
  select md5(pg_get_functiondef(p.oid)), coalesce(p.proacl::text, '<null>')
    into v_def_md5, v_acl
    from pg_proc p where p.oid = 'public.get_customer_stats(uuid,uuid)'::regprocedure;

  select * into s from t_stats_snap where ord = 24;
  if s is null then
    insert into t_stats_snap values (24, v_def_md5, v_acl);
    insert into t_res values (24, 'STATS-8 reaplicar a 108 nao muda corpo nem ACL',
      'OK (1a passada: snapshot gravado, corpo md5 ' || left(v_def_md5, 8) || ', acl ' || v_acl || ')');
  elsif s.def_md5 = v_def_md5 and s.acl = v_acl then
    insert into t_res values (24, 'STATS-8 reaplicar a 108 nao muda corpo nem ACL',
      'OK (2a passada: corpo e ACL identicos ao snapshot)');
  else
    insert into t_res values (24, 'STATS-8 reaplicar a 108 nao muda corpo nem ACL',
      'FALHOU (mudou: corpo ' || left(s.def_md5,8) || ' -> ' || left(v_def_md5,8)
        || ', acl ' || s.acl || ' -> ' || v_acl || ')');
  end if;
exception when others then
  insert into t_res values (24, 'STATS-8 reaplicar a 108 nao muda corpo nem ACL', 'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;
