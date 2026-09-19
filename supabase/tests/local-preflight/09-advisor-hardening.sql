-- ACL-1..ACL-5, ACL-1b, ACL-3b/3c/3d e CONTROLE-16: comportamento da migration
-- 106 contra Postgres real.
--
-- Os cinco primeiros são o caminho de PERMITIR (policy sobrevive ao SET SCHEMA,
-- os quatro corpos reescritos resolvem o helper, `anon` entra na fila,
-- idempotência). Os quatro últimos são o de NEGAR, acrescentados depois porque
-- guard só testado no allow não notaria um `is_org_member` trocado por
-- `is_unit_member` nem um `if not (...)` invertido: ACL-1b (não-membro vê zero e
-- tenant cruzado não vaza), ACL-3b (anonimização recusa cliente de outra org),
-- ACL-3c (painel de Entregas recusa não-membro) e ACL-3d (listagem de clientes
-- não devolve agregado de outra org).
--
-- CONTROLE-16, no fim do arquivo, é o controle positivo do ACL-1 — o único caso
-- desta suíte que sustenta a frase da 106 sobre as policies não precisarem de
-- reescrita. Ele vive AQUI, e não em `10-controles-106.sql`, pelo mesmo motivo do
-- CONTROLE-8 em `11-overloads-107.sql`: a sabotagem é desfeita por ROLLBACK de
-- subtransação dentro do próprio caso, nunca deixa resíduo para um reapply
-- externo resolver, e por isso roda sob ON_ERROR_STOP=1 junto dos casos.
--
-- Ordinais casam com o número do NOME, não com a ordem de execução, e por isso
-- não são contíguos aqui: 1–5, 8, 11, 12, 13, 16. Os ordinais 6, 7, 9 e 10 são
-- dos controles positivos de `10-controles-106.sql`; 14 e 15, de
-- `11-overloads-107.sql`. Tabela completa no README.
--
-- O README deste diretório diz que o harness "não prova RLS, grants, ACL". Isso
-- descreve o conjunto de arquivos que existia, não um limite do ambiente: o
-- 00-bootstrap.sql cria os papéis anon/authenticated/service_role, então
-- `set local role` + `set local request.jwt.claims` exercitam policy e grant de
-- verdade. O que continua fora do alcance local é a EXPOSIÇÃO PostgREST — essa
-- metade é do audit-function-acl.ts contra o projeto real.
--
-- Rodar depois de 00-bootstrap.sql, 01-audit.sql, 09a-advisor-bootstrap.sql e da
-- própria 106, com ON_ERROR_STOP=1. Este arquivo é RODADO DUAS VEZES, com a 106
-- reaplicada no meio — é assim que ACL-5 mede idempotência (ver o caso).

-- ─── GUARDA: este arquivo só faz sentido DEPOIS da 106 e DEPOIS do `09a` ─────
-- Até a rodada em que a fixture `acl_probe` saiu daqui, rodar este arquivo sem a
-- 106 morria na criação da policy (`schema "app_private" does not exist`) — era
-- esse o RED que dava sentido ao GREEN. Com a fixture no `09a` (onde ela precisa
-- estar, para nascer ANTES do move), esse RED deixou de acontecer por acidente,
-- então vira explícito. Sem o guard, duas coisas ruins passariam caladas:
--   • os casos mediriam o mundo PRÉ-migration e vários reportariam OK — ACL-2/3/4
--     passam com os corpos antigos, porque produção funciona hoje;
--   • o ACL-5 gravaria em `t_acl_snap` um snapshot de ZERO funções em
--     `app_private`, e a 1a passada de verdade reprovaria comparando contra ele.
do $$
begin
  if to_regclass('public.acl_probe') is null or to_regclass('public.t_probe_prov') is null then
    raise exception '09-advisor-hardening.sql exige 09a-advisor-bootstrap.sql aplicado antes (fixture acl_probe / t_probe_prov ausente). Sequencia do README: 00 -> 01 -> 09a -> 106 -> 09.';
  end if;
  if not exists (select 1 from t_probe_prov where probe = 'acl_probe_member') then
    raise exception 'procedencia da fixture acl_probe ausente em t_probe_prov. Reaplique 09a-advisor-bootstrap.sql num banco novo — ela e gravada ANTES da 106 e nao pode ser reconstruida depois.';
  end if;
  if to_regprocedure('app_private.is_unit_member(uuid,uuid)') is null then
    raise exception '09-advisor-hardening.sql exige a migration 106 aplicada (app_private.is_unit_member nao existe). Este arquivo mede o estado DEPOIS do SET SCHEMA; rodado antes, reportaria OK sobre o mundo pre-migration. Aplique supabase/migrations/20260910120000_106_advisor_private_rls_helpers.sql e rode de novo.';
  end if;
end $$;

create table if not exists t_res (ord int primary key, caso text, veredito text);

-- Snapshot que atravessa as duas execuções. Uma leitura só, dentro de um
-- `do $$`, compararia o estado consigo mesmo.
create table if not exists t_acl_snap (ord int primary key, n_funcs int, acl text);

-- ─── ACL-1: a policy nascida contra `public.is_unit_member` continua avaliando
--     depois do SET SCHEMA ───────────────────────────────────────────────────
-- É ESTE o caso em que a 106 se apoia para deixar 42 policies de produção sem
-- reescrita. Ele NÃO cria a fixture: `acl_probe` e a policy `acl_probe_member`
-- nascem no `09a`, que roda ANTES da migration, na forma de produção
-- (`is_unit_member(auth.uid(), unit_id)` — sem qualificar, sem cláusula `TO`,
-- igual à 014). Aqui só se LÊ através dela. Criar ou recriar a policy neste
-- arquivo seria medir o contrário do que se quer: policy nascida depois do move
-- já aponta para o endereço novo, e passar não diria nada sobre as policies reais.
--
-- Quatro asserções — três de catálogo, uma de comportamento:
--   1. PROCEDÊNCIA: o `09a` gravou que o nome sem qualificação resolveu para
--      `public`. Depois do move a expressão renderiza `app_private.is_unit_member`
--      e fica indistinguível de uma policy escrita assim desde o início — sem o
--      registro de antes, não há como afirmar de onde ela veio;
--   2. A policy é a MESMA LINHA de `pg_policy` (mesmo OID) que o `09a` criou —
--      ninguém a recriou no caminho, o que incluiria o CONTROLE-16 e a 2a passada;
--   3. `public.is_unit_member(uuid,uuid)` NÃO existe mais, e o OID referenciado
--      pela policy é IDÊNTICO ao de antes do move, agora morando em
--      `app_private`. É "por OID, não por nome" lido no catálogo: a policy não
--      pode estar funcionando por resolução de nome, porque o nome não existe;
--   4. o membro autenticado vê a linha — a consequência observável, e a que o
--      CONTROLE-16 derruba para provar que esta asserção tem força.
do $$
declare v_unit uuid; v_user uuid; v_n int;
        v_prov_policy oid; v_prov_func oid; v_prov_schema text;
        v_hoje_policy oid; v_hoje_func oid; v_hoje_schema text;
        v_public_ainda regprocedure;
begin
  delete from t_res where ord = 1;

  select policy_oid, func_oid, func_schema
    into v_prov_policy, v_prov_func, v_prov_schema
    from t_probe_prov where probe = 'acl_probe_member';

  -- `pg_depend` de policy lista todas as funções da expressão (aqui `auth.uid()`
  -- e o helper) — daí o filtro por `proname`.
  select pol.oid, p.oid, n.nspname
    into v_hoje_policy, v_hoje_func, v_hoje_schema
    from pg_policy     pol
    join pg_class      c on c.oid = pol.polrelid
    join pg_depend     d on d.classid = 'pg_policy'::regclass and d.objid = pol.oid
                        and d.refclassid = 'pg_proc'::regclass
    join pg_proc       p on p.oid = d.refobjid
    join pg_namespace  n on n.oid = p.pronamespace
   where c.relname = 'acl_probe'
     and pol.polname = 'acl_probe_member'
     and p.proname = 'is_unit_member';

  v_public_ainda := to_regprocedure('public.is_unit_member(uuid,uuid)');

  select id into v_unit from units where is_public limit 1;
  select user_id into v_user from unit_members where unit_id = v_unit limit 1;
  delete from acl_probe;
  insert into acl_probe (unit_id, nota) values (v_unit, 'visivel ao membro');

  -- GUC antes do papel: setar GUC já como `authenticated` funciona, mas a ordem
  -- inversa deixa a falha ambígua entre "sem claim" e "sem privilégio".
  perform set_config('request.jwt.claims', json_build_object('sub', v_user)::text, true);
  set local role authenticated;
  select count(*) into v_n from acl_probe;
  reset role;

  insert into t_res values (1, 'ACL-1 policy pre-106 sobrevive ao SET SCHEMA',
    case
      when v_prov_schema is distinct from 'public'
        then 'FALHOU (procedencia: a policy resolveu ' || coalesce(v_prov_schema, '<nulo>')
             || ', nao public — a fixture nao nasceu na forma PRE-106)'
      when v_hoje_policy is null
        then 'FALHOU (a policy acl_probe_member nao existe mais)'
      when v_hoje_policy <> v_prov_policy
        then 'FALHOU (policy RECRIADA: oid ' || v_prov_policy::text || ' -> '
             || v_hoje_policy::text || '; o que esta sendo lido nao e o que sobreviveu ao move)'
      when v_public_ainda is not null
        then 'FALHOU (public.is_unit_member ainda existe: a policy pode estar resolvendo pelo nome)'
      when v_hoje_func <> v_prov_func
        then 'FALHOU (OID da funcao mudou: ' || v_prov_func::text || ' -> ' || v_hoje_func::text || ')'
      when v_hoje_schema is distinct from 'app_private'
        then 'FALHOU (a funcao referenciada esta em ' || coalesce(v_hoje_schema, '<nulo>') || ')'
      when v_n <> 1
        then 'FALHOU (membro viu ' || v_n || ' linha(s), esperado 1)'
      else 'OK (policy oid ' || v_hoje_policy::text || ' intacta; funcao oid '
           || v_hoje_func::text || ' migrou public -> app_private sem reescrita; membro ve 1 linha)'
    end);
exception when others then
  reset role;
  insert into t_res values (1, 'ACL-1 policy pre-106 sobrevive ao SET SCHEMA', 'FALHOU: ' || sqlerrm);
end $$;

-- ─── ACL-2: enter_waitlist conclui com os corpos reescritos ──────────────────
-- O claim é OBRIGATÓRIO aqui. Sem ele `auth.uid()` é NULL, a função entra no
-- ramo anon (unidade pública) e NÃO toca nos helpers — o caso passaria sem
-- exercitar nada do que a 106 muda. O ramo anon é medido no ACL-4, de propósito.
do $$
declare v_unit uuid; v_user uuid; v_id uuid;
begin
  delete from t_res where ord = 2;
  select id into v_unit from units where is_public limit 1;
  select user_id into v_user from unit_members where unit_id = v_unit limit 1;

  perform set_config('request.jwt.claims', json_build_object('sub', v_user)::text, true);
  set local role authenticated;
  -- A função devolve (waitlist_id, code), não (id, position).
  select waitlist_id into v_id
    from enter_waitlist(v_unit, 'Cliente Preflight', '11987654321', 2, null, 'normal', null);
  reset role;

  insert into t_res values (2, 'ACL-2 enter_waitlist apos o move',
    case when v_id is not null then 'OK' else 'FALHOU (retorno nulo)' end);
exception when others then
  reset role;
  insert into t_res values (2, 'ACL-2 enter_waitlist apos o move', 'FALHOU: ' || sqlerrm);
end $$;

-- ─── ACL-3: os outros três corpos reescritos resolvem o helper ──────────────
-- Não basta "não estourou": cada asserção confere que o helper devolveu TRUE.
-- Um helper que resolvesse e devolvesse FALSE faria anonymize_customer e
-- get_customer_stats_bulk falharem silenciosamente (forbidden / zero linhas).
do $$
declare v_unit uuid; v_user uuid;
        v_cust  uuid := 'eeeeeeee-0000-0000-0000-000000000003';  -- descartável, será anonimizado
        v_stats uuid := 'eeeeeeee-0000-0000-0000-000000000004';  -- vivo, para o stats
        v_n_stats int; v_n_undel int; v_deleted timestamptz;
begin
  delete from t_res where ord = 3;
  select id into v_unit from units where is_public limit 1;
  select user_id into v_user from unit_members where unit_id = v_unit limit 1;

  -- Cliente descartável próprio do caso: anonymize_customer marca deleted_at, e
  -- reusar o cliente do seed faria a 2a execução cair no no-op silencioso.
  delete from customers where id = v_cust;
  insert into customers (id, organization_id, name, phone)
  select v_cust, u.organization_id, 'Cliente ACL-3', '11988880003' from units u where u.id = v_unit;

  perform set_config('request.jwt.claims', json_build_object('sub', v_user)::text, true);
  set local role authenticated;

  perform anonymize_customer(v_cust);
  -- Cliente DIFERENTE aqui de propósito: alimentar o stats com o cliente que
  -- acabou de ser anonimizado faria a asserção "exatamente 1 linha" depender de
  -- o CTE `allowed` não filtrar `deleted_at` — verdade hoje, mas nada a ver com
  -- a 106. O que se quer medir é `is_org_member` devolvendo TRUE.
  select count(*) into v_n_stats from get_customer_stats_bulk(array[v_stats], v_unit);
  select count(*) into v_n_undel from get_undelivered_notifications(v_unit, now() - interval '7 days');

  reset role;
  select deleted_at into v_deleted from customers where id = v_cust;

  insert into t_res values (3, 'ACL-3 os outros tres corpos reescritos',
    case
      when v_deleted is null then 'FALHOU (anonymize_customer nao anonimizou: is_org_member deu falso)'
      when v_n_stats <> 1    then 'FALHOU (get_customer_stats_bulk devolveu ' || v_n_stats || ', esperado 1)'
      when v_n_undel < 1     then 'FALHOU (get_undelivered_notifications devolveu ' || v_n_undel || ', esperado >=1)'
      else 'OK'
    end);
exception when others then
  reset role;
  insert into t_res values (3, 'ACL-3 os outros tres corpos reescritos', 'FALHOU: ' || sqlerrm);
end $$;

-- ─── ACL-4: caminho da loja — anon entra na fila ponta a ponta ──────────────
do $$
declare v_unit uuid; v_id uuid;
begin
  delete from t_res where ord = 4;
  select id into v_unit from units where is_public limit 1;

  -- Sem claim: é o que faz auth.uid() ser NULL e a função tomar o ramo anon.
  perform set_config('request.jwt.claims', '', true);
  set local role anon;
  select waitlist_id into v_id
    from enter_waitlist(v_unit, 'Anon Preflight', '11912345678', 2, null, 'normal', null);
  reset role;

  insert into t_res values (4, 'ACL-4 anon entra na fila',
    case when v_id is not null then 'OK' else 'FALHOU (retorno nulo)' end);
exception when others then
  reset role;
  insert into t_res values (4, 'ACL-4 anon entra na fila', 'FALHOU: ' || sqlerrm);
end $$;

-- ─── ACL-5: idempotência — reaplicar a 106 não muda ACL nem contagem ────────
-- MEDIDO ATRAVÉS DE DUAS EXECUÇÕES DESTE ARQUIVO, com a 106 reaplicada entre
-- elas: 106 → 09 (grava snapshot) → 106 → 09 (compara). Um `do $$` com as duas
-- leituras seguidas não pode medir isso — a reaplicação só acontece depois que o
-- arquivo termina, então as duas leituras veriam o MESMO estado e o caso
-- reportaria OK mesmo se a migration fosse destrutiva.
--
-- O snapshot cobre contagem E `proacl` de cada função: migration que
-- silenciosamente derrubasse um grant é exatamente o que este caso existe para
-- pegar.
do $$
declare
  v_n int; v_acl text;
  v_n_antes int; v_acl_antes text;
begin
  delete from t_res where ord = 5;

  -- A ACL é serializada ORDENADA por concessionário, não na ordem em que o
  -- catálogo guarda: `proacl::text` cru preserva a ordem em que os grants foram
  -- feitos, e uma reconcessão semanticamente idêntica em outra ordem faria este
  -- caso reprovar por nada. O que se quer comparar é QUEM tem O QUÊ.
  select count(*),
         coalesce(string_agg(
           p.proname || '=' || coalesce(
             (select string_agg(a::text, ',' order by a::text) from unnest(p.proacl) a),
             '(default)'),
           '|' order by p.proname), '')
    into v_n, v_acl
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app_private';

  select n_funcs, acl into v_n_antes, v_acl_antes from t_acl_snap where ord = 5;

  if v_n_antes is null then
    insert into t_acl_snap values (5, v_n, v_acl);
    insert into t_res values (5, 'ACL-5 idempotencia da 106',
      'PENDENTE (1a passada: snapshot de ' || v_n || ' funcoes gravado; reaplique a 106 e rode este arquivo de novo)');
  else
    insert into t_res values (5, 'ACL-5 idempotencia da 106',
      case
        when v_n_antes = v_n and v_acl_antes is not distinct from v_acl then 'OK'
        when v_n_antes <> v_n then 'FALHOU (contagem mudou: ' || v_n_antes || ' -> ' || v_n || ')'
        else 'FALHOU (ACL mudou: ' || v_acl_antes || ' -> ' || v_acl || ')'
      end);
  end if;
end $$;

-- ─── ACL-1b: o lado NEGATIVO, e o tenant cruzado ────────────────────────────
-- ACL-1 prova que a policy CONTINUA avaliando; ela passaria idêntica contra um
-- helper reescrito para devolver TRUE sempre. Este caso é o que fecha essa
-- lacuna, e ele é uma asserção de isolamento multi-tenant, não de fumaça:
--   • usuário autenticado SEM linha em `unit_members` vê ZERO;
--   • membro da unidade A vê a linha de A e NÃO a de B;
--   • membro da unidade B vê a linha de B e NÃO a de A.
--
-- Ordinal 8 porque 6 e 7 são dos controles positivos do `10`, e os ordinais do
-- roteiro não se renumeram.
do $$
declare v_unit_a uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_unit_b uuid := 'bbbbbbbb-0000-0000-0000-000000000002';
        v_user_a uuid := '11111111-1111-1111-1111-111111111111';
        v_user_b uuid := '22222222-2222-2222-2222-222222222222';
        v_sem    uuid := '33333333-3333-3333-3333-333333333333';
        v_n_sem int; v_nota_a text; v_n_a int; v_nota_b text; v_n_b int;
begin
  delete from t_res where ord = 8;

  delete from acl_probe;
  insert into acl_probe (unit_id, nota) values (v_unit_a, 'linha da unidade A');
  insert into acl_probe (unit_id, nota) values (v_unit_b, 'linha da unidade B');

  -- 1) sem vínculo nenhum
  perform set_config('request.jwt.claims', json_build_object('sub', v_sem)::text, true);
  set local role authenticated;
  select count(*) into v_n_sem from acl_probe;
  reset role;

  -- 2) membro da unidade A
  perform set_config('request.jwt.claims', json_build_object('sub', v_user_a)::text, true);
  set local role authenticated;
  select count(*), min(nota) into v_n_a, v_nota_a from acl_probe;
  reset role;

  -- 3) membro da unidade B
  perform set_config('request.jwt.claims', json_build_object('sub', v_user_b)::text, true);
  set local role authenticated;
  select count(*), min(nota) into v_n_b, v_nota_b from acl_probe;
  reset role;

  insert into t_res values (8, 'ACL-1b nao-membro ve zero, tenant cruzado nao vaza',
    case
      when v_n_sem <> 0 then 'FALHOU (sem vinculo viu ' || v_n_sem || ' linha(s))'
      when v_n_a <> 1 or v_nota_a <> 'linha da unidade A'
        then 'FALHOU (membro A viu ' || v_n_a || ' linha(s): ' || coalesce(v_nota_a, '<nada>') || ')'
      when v_n_b <> 1 or v_nota_b <> 'linha da unidade B'
        then 'FALHOU (membro B viu ' || v_n_b || ' linha(s): ' || coalesce(v_nota_b, '<nada>') || ')'
      else 'OK'
    end);
exception when others then
  reset role;
  insert into t_res values (8, 'ACL-1b nao-membro ve zero, tenant cruzado nao vaza', 'FALHOU: ' || sqlerrm);
end $$;

-- ─── ACL-3b/3c/3d: o lado NEGATIVO das outras três funções ──────────────────
-- O ACL-3 exercita `anonymize_customer`, `get_customer_stats_bulk` e
-- `get_undelivered_notifications` só pelo caminho de PERMITIR. Isso deixava
-- `is_org_member` e `is_platform_admin`, COMO USADOS NESSES TRÊS CORPOS, sem
-- nenhum caso negativo — nada notaria um `is_org_member` trocado por
-- `is_unit_member`, ou um `if not (...)` invertido, numa reescrita futura.
--
-- O risco vindo DESTA migration é nulo (os corpos são idênticos aos de produção
-- a menos do qualificador, e o CONTROLE-6 mostra que qualificador errado falha
-- fechado com `undefined_function`). O motivo destes três casos existirem é a
-- fase ter reescrito quatro guards de tenant e ter deixado três sem rede.
--
-- Ordinais 11/12/13 para casar com o número do nome; o 10 é do CONTROLE-10.

-- ACL-3b: anonymize_customer NÃO anonimiza cliente de organização alheia.
--
-- O guard é `is_org_member(...) or is_platform_admin(...)`, então o chamador tem
-- de ser membro de uma segunda organização REAL e NÃO ser platform admin —
-- `platform_admins` fica vazia neste harness, o que garante a segunda metade.
--
-- Duas asserções, e a segunda é a que importa: além de a chamada ser RECUSADA,
-- o cliente tem de continuar NÃO anonimizado. Sem ela o caso não distinguiria
-- "recusou" de "anonimizou e estourou depois". E o cliente-alvo é escolhido
-- VIVO de propósito: `anonymize_customer` devolve no-op SILENCIOSO para cliente
-- já anonimizado (`deleted_at` não nulo), e um alvo morto faria o caso passar
-- sem o guard sequer ser alcançado.
do $$
declare v_alvo uuid := 'eeeeeeee-0000-0000-0000-000000000001';   -- org A, vivo
        v_intruso uuid := '22222222-2222-2222-2222-222222222222'; -- membro da org B
        v_recusou boolean := false; v_deleted timestamptz; v_err text;
begin
  delete from t_res where ord = 11;
  update customers set deleted_at = null where id = v_alvo;

  perform set_config('request.jwt.claims', json_build_object('sub', v_intruso)::text, true);
  set local role authenticated;
  begin
    perform anonymize_customer(v_alvo);
  exception when insufficient_privilege then
    v_recusou := true;
    get stacked diagnostics v_err = message_text;
  end;
  reset role;

  select deleted_at into v_deleted from customers where id = v_alvo;

  insert into t_res values (11, 'ACL-3b anonymize_customer recusa cliente de outra org',
    case
      when not v_recusou then 'FALHOU (nao recusou: membro da org B passou pelo guard)'
      when v_deleted is not null then 'FALHOU (recusou com "' || v_err
                                      || '" mas o cliente FOI anonimizado)'
      else 'OK (recusado com "' || v_err || '" e cliente intacto)'
    end);
exception when others then
  reset role;
  insert into t_res values (11, 'ACL-3b anonymize_customer recusa cliente de outra org', 'FALHOU: ' || sqlerrm);
end $$;

-- ACL-3c: get_undelivered_notifications recusa não-membro.
--
-- Li o corpo: ele RAISE `forbidden` com errcode 42501 antes de qualquer query —
-- não devolve lista vazia. Portanto o caso captura `insufficient_privilege`
-- ESPECIFICAMENTE, e não `when others`: lista vazia e recusa são resultados
-- diferentes, e um `when others` confundiria os dois com qualquer outro erro.
-- O contra-caso está no ACL-3, que chama a mesma função como membro e recebe
-- linha — ou seja, "recusou" aqui não é "a função está quebrada".
do $$
declare v_unit uuid; v_sem uuid := '33333333-3333-3333-3333-333333333333';
        v_n int; v_recusou boolean := false; v_err text;
begin
  delete from t_res where ord = 12;
  select id into v_unit from units where is_public limit 1;

  perform set_config('request.jwt.claims', json_build_object('sub', v_sem)::text, true);
  set local role authenticated;
  begin
    select count(*) into v_n from get_undelivered_notifications(v_unit, now() - interval '7 days');
  exception when insufficient_privilege then
    v_recusou := true;
    get stacked diagnostics v_err = message_text;
  end;
  reset role;

  insert into t_res values (12, 'ACL-3c get_undelivered_notifications recusa nao-membro',
    case
      when v_recusou then 'OK (raise 42501 "' || v_err || '", nao lista vazia)'
      else 'FALHOU (nao recusou: devolveu ' || coalesce(v_n::text, 'null') || ' linha(s))'
    end);
exception when others then
  reset role;
  insert into t_res values (12, 'ACL-3c get_undelivered_notifications recusa nao-membro', 'FALHOU: ' || sqlerrm);
end $$;

-- ACL-3d: get_customer_stats_bulk não devolve agregado de outra organização.
--
-- O mais valioso dos três: aqui um guard quebrado não estoura, ele VAZA FORMATO
-- DE DADO — devolve a agregação de outro tenant em vez de um erro. O caso passa
-- ids das DUAS organizações e exige que volte exatamente a linha da org do
-- chamador. Contar linhas não basta: confere-se QUAL id voltou.
do $$
declare v_unit uuid; v_membro_a uuid := '11111111-1111-1111-1111-111111111111';
        v_cust_a uuid := 'eeeeeeee-0000-0000-0000-000000000004';  -- org A
        v_cust_b uuid := 'eeeeeeee-0000-0000-0000-000000000005';  -- org B
        v_n int; v_ids text;
begin
  delete from t_res where ord = 13;
  select id into v_unit from units where is_public limit 1;

  perform set_config('request.jwt.claims', json_build_object('sub', v_membro_a)::text, true);
  set local role authenticated;
  select count(*), coalesce(string_agg(customer_id::text, ',' order by customer_id::text), '<vazio>')
    into v_n, v_ids
    from get_customer_stats_bulk(array[v_cust_a, v_cust_b], v_unit);
  reset role;

  insert into t_res values (13, 'ACL-3d get_customer_stats_bulk nao vaza agregado de outra org',
    case
      when v_n = 1 and v_ids = v_cust_a::text then 'OK (voltou so o cliente da org do chamador)'
      else 'FALHOU (esperado 1 linha [' || v_cust_a || '], veio ' || v_n || ': ' || v_ids || ')'
    end);
exception when others then
  reset role;
  insert into t_res values (13, 'ACL-3d get_customer_stats_bulk nao vaza agregado de outra org', 'FALHOU: ' || sqlerrm);
end $$;

-- ═══ CONTROLE-16 — o ACL-1 fica VERMELHO se a policy depender do NOME ════════
--
-- Sem este controle, "ACL-1 passou" não distingue a guarda funcionando de teste
-- sem força — e o ACL-1 é o único fundamento da frase da 106 que autoriza deixar
-- 42 policies de produção intocadas. Foi por falta dele que a versão anterior
-- desta suíte criava a fixture já na forma `app_private.` e ainda assim afirmava
-- medir a sobrevivência ao move.
--
-- A SABOTAGEM É A ÚNICA DISPONÍVEL, e é isso que ela demonstra: depois do move
-- não EXISTE como escrever uma policy que resolva `public.is_unit_member`. O caso
-- dropa a policy, observa a asserção do ACL-1 virar 0 (o vermelho), e tenta
-- reconstruí-la pelo nome antigo — `create policy` estoura `undefined_function`.
-- Ou seja: num mundo em que policy dependesse de nome, esta fixture não poderia
-- nem existir neste banco, e o ACL-1 estaria vermelho. Que ele esteja verde é
-- consequência do OID ter viajado com a função.
--
-- O RESTORE É ROLLBACK DE SUBTRANSAÇÃO, NÃO UM `create policy` DE VOLTA, e essa
-- escolha É o ponto. Recriar a policy aqui a resolveria pelo endereço NOVO, e a
-- 2a passada deste arquivo (a que o ACL-5 exige) leria uma policy nascida DEPOIS
-- do move — o próprio controle reintroduziria, pela porta de trás, o defeito de
-- evidência que ele existe para fechar. O `raise` com SQLSTATE próprio desfaz o
-- `drop` e devolve a MESMA linha de `pg_policy`, com o MESMO OID; quem confere
-- isso não é só este caso, é o ACL-1, que compara com o OID gravado pelo `09a`.
--
-- Variável de plpgsql não é transacional: os valores observados durante a
-- sabotagem sobrevivem ao rollback, e é isso que permite julgar depois de desfazer.
--
-- Roda sob ON_ERROR_STOP=1 junto dos casos, e não em `10-controles-106.sql`, pela
-- razão que o CONTROLE-8 já usa em `11-overloads-107.sql`: não deixa resíduo
-- nenhum para um reapply externo resolver. O handler `when others` cobre o resto —
-- DDL em plpgsql roda na subtransação do bloco, então falha em qualquer ponto
-- desfaz o `drop` por rollback. Nenhum caminho deixa `acl_probe` sem policy, o que
-- importa mais aqui do que nos outros controles: tabela com RLS e sem policy faria
-- todo caso posterior ver zero linha e reprovar pelo motivo errado.
do $$
declare v_unit uuid; v_user uuid;
        v_oid_antes oid; v_oid_depois oid;
        v_verde int; v_no_meio int; v_vermelho int; v_restaurado int;
        v_nome_resolveu boolean := null; v_err text;
begin
  delete from t_res where ord = 16;

  select id into v_unit from units where is_public limit 1;
  select user_id into v_user from unit_members where unit_id = v_unit limit 1;

  -- Cenário próprio, para não depender do que ACL-1b/ACL-3d deixaram.
  delete from acl_probe;
  insert into acl_probe (unit_id, nota) values (v_unit, 'controle 16');

  select pol.oid into v_oid_antes
    from pg_policy pol join pg_class c on c.oid = pol.polrelid
   where c.relname = 'acl_probe' and pol.polname = 'acl_probe_member';

  -- Linha de base: a MESMA leitura do ACL-1, verde.
  perform set_config('request.jwt.claims', json_build_object('sub', v_user)::text, true);
  set local role authenticated;
  select count(*) into v_verde from acl_probe;
  reset role;

  begin
    drop policy acl_probe_member on acl_probe;
    select count(*) into v_no_meio
      from pg_policy pol join pg_class c on c.oid = pol.polrelid
     where c.relname = 'acl_probe' and pol.polname = 'acl_probe_member';

    -- O VERMELHO: a asserção do ACL-1, agora sem a policy que a sustenta.
    perform set_config('request.jwt.claims', json_build_object('sub', v_user)::text, true);
    set local role authenticated;
    select count(*) into v_vermelho from acl_probe;
    reset role;

    -- A sabotagem: reconstruir a policy pelo NOME ANTIGO. Tem de ser recusada.
    begin
      create policy acl_probe_member on acl_probe
        for select using (public.is_unit_member(auth.uid(), unit_id));
      v_nome_resolveu := true;
    exception when undefined_function then
      v_nome_resolveu := false;
      get stacked diagnostics v_err = message_text;
    end;

    raise exception 'controle-16: desfaz a sabotagem' using errcode = 'ZZ106';
  exception when sqlstate 'ZZ106' then
    null;  -- rollback da subtransação: a policy ORIGINAL volta, com o mesmo OID
  end;

  select pol.oid into v_oid_depois
    from pg_policy pol join pg_class c on c.oid = pol.polrelid
   where c.relname = 'acl_probe' and pol.polname = 'acl_probe_member';

  perform set_config('request.jwt.claims', json_build_object('sub', v_user)::text, true);
  set local role authenticated;
  select count(*) into v_restaurado from acl_probe;
  reset role;

  insert into t_res values (16, 'CONTROLE-16 ACL-1 vermelho se a policy depender do nome',
    case
      when v_verde <> 1
        then 'FALHOU (linha de base: membro viu ' || v_verde || ', esperado 1)'
      when v_no_meio <> 0
        then 'FALHOU (o drop nao tirou a policy: ainda ha ' || v_no_meio || ')'
      when v_vermelho <> 0
        then 'FALHOU: deveria ter estourado (sem policy o membro ainda viu '
             || v_vermelho || ' linha(s) — a assercao do ACL-1 nao tem forca)'
      when v_nome_resolveu is not false
        then 'FALHOU: deveria ter estourado (create policy com public.is_unit_member foi ACEITO — o nome antigo ainda resolve neste banco)'
      when v_oid_depois is null or v_oid_depois <> v_oid_antes
        then 'FALHOU (restore nao devolveu a policy original: oid '
             || coalesce(v_oid_antes::text, '<nulo>') || ' -> '
             || coalesce(v_oid_depois::text, '<nulo>') || ')'
      when v_restaurado <> 1
        then 'FALHOU (restore nao devolveu comportamento: membro ve ' || v_restaurado || ')'
      else 'OK (sem policy o membro viu 0; reconstruir pelo nome antigo estourou "'
           || coalesce(v_err, '<sem mensagem>') || '"; restaurada por rollback, mesmo oid '
           || v_oid_depois::text || ', membro ve 1)'
    end);
exception when others then
  reset role;
  insert into t_res values (16, 'CONTROLE-16 ACL-1 vermelho se a policy depender do nome',
    'FALHOU: ' || sqlerrm || ' (sabotagem desfeita por rollback da subtransacao)');
end $$;
