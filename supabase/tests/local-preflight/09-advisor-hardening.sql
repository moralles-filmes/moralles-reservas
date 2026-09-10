-- ACL-1..ACL-5: comportamento da migration 106 contra Postgres real.
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

create table if not exists t_res (ord int primary key, caso text, veredito text);

-- Snapshot que atravessa as duas execuções. Uma leitura só, dentro de um
-- `do $$`, compararia o estado consigo mesmo.
create table if not exists t_acl_snap (ord int primary key, n_funcs int, acl text);

-- Fixture: uma policy TO PUBLIC que chama o helper, igual às 24 reais.
create table if not exists acl_probe (id uuid primary key default gen_random_uuid(), unit_id uuid not null, nota text);
alter table acl_probe enable row level security;
drop policy if exists acl_probe_member on acl_probe;
create policy acl_probe_member on acl_probe
  for select using (app_private.is_unit_member(auth.uid(), unit_id));
grant select on acl_probe to anon, authenticated;

-- ─── ACL-1: policy TO PUBLIC continua avaliando depois do SET SCHEMA ─────────
-- As policies referenciam a função por OID; o SET SCHEMA não muda OID. Este caso
-- é o que transforma essa frase em medição.
do $$
declare v_unit uuid; v_user uuid; v_n int;
begin
  delete from t_res where ord = 1;
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

  insert into t_res values (1, 'ACL-1 policy sobrevive ao SET SCHEMA',
    case when v_n = 1 then 'OK' else 'FALHOU (esperado 1, veio ' || v_n || ')' end);
exception when others then
  reset role;
  insert into t_res values (1, 'ACL-1 policy sobrevive ao SET SCHEMA', 'FALHOU: ' || sqlerrm);
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
declare v_unit uuid; v_user uuid; v_cust uuid := 'eeeeeeee-0000-0000-0000-000000000003';
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
  select count(*) into v_n_stats from get_customer_stats_bulk(array[v_cust], v_unit);
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

  select count(*), coalesce(string_agg(p.proname || '=' || coalesce(p.proacl::text, '(default)'), '|' order by p.proname), '')
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
