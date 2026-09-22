-- CODE-1..CODE-8 (ordinais 27..34): a RPC pública `resolve_tracking_token_by_code`
-- da migration 109, contra Postgres real.
--
-- CODE-1/5 são o caminho de ACHAR; CODE-2/3/4 o de NÃO achar — e os três têm de
-- devolver `null` indistinguivelmente, senão a recusa vira oráculo. CODE-6 mede
-- que a get_reservation_by_code SUMIU, CODE-7 a ACL e CODE-8 a idempotência
-- através de duas execuções.
--
-- Diferente da 108, aqui NÃO há `raise`: o retorno é uma linha ou nenhuma, então
-- `null` já é a resposta certa para código errado, unidade errada e unidade não
-- pública. Não há o que um `raise` acrescente, e por isso `language sql` basta.
--
-- Rodar depois de 00, 01, 09a, 106, 09 (2x), 10, 11, 107, 11, 108, 12, 13, 108,
-- 12 e da própria 109, com ON_ERROR_STOP=1. Este arquivo é RODADO DUAS VEZES,
-- com a 109 reaplicada no meio — é assim que CODE-8 mede idempotência.
--
-- Handlers `when others` gravam com `on conflict (ord) do update` pela mesma
-- razão documentada no `12`: o `delete from t_res` do início é desfeito pelo
-- rollback da subtransação, e na 2a passada o insert bateria em chave duplicada.

-- ─── GUARDA: este arquivo só faz sentido DEPOIS da 109 ──────────────────────
-- Rodado antes, CODE-2/3/4 passariam por acidente (a função não existe, tudo
-- "falha"), e CODE-8 gravaria snapshot de um mundo sem a função. Recusar é o
-- RED explícito, mesmo desenho do guard do `12`.
do $$
begin
  if to_regprocedure('public.resolve_tracking_token_by_code(text,uuid)') is null then
    raise exception '14-public-code-lookup-109.sql exige a migration 109 aplicada (public.resolve_tracking_token_by_code(text,uuid) ausente). Sequencia do README: ... -> 108 -> 12 -> 13 -> 108 -> 12 -> 109 -> 14.';
  end if;
  if not exists (select 1 from reservations where reservation_code = 'STATSA1') then
    raise exception '14-public-code-lookup-109.sql exige as reservas criadas por 12-customer-stats-108.sql (reservation_code STATSA1 ausente). Sem elas CODE-1 nao teria o que achar e os casos negativos ficariam verdes medindo nada.';
  end if;
end $$;

create table if not exists t_res (ord int primary key, caso text, veredito text);

-- Snapshot que atravessa as duas execuções (mesmo motivo do `t_stats_snap`).
create table if not exists t_code_snap (ord int primary key, def_md5 text, acl text);

-- ─── CODE-1: código certo, unidade certa e pública → devolve o token ────────
do $$
declare v_unit_a uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_esperado uuid := 'dddddddd-0000-0000-0000-000000000001';
        v_tok uuid;
begin
  delete from t_res where ord = 27;
  set local role anon;
  select resolve_tracking_token_by_code('STATSA1', v_unit_a) into v_tok;
  reset role;

  insert into t_res values (27, 'CODE-1 codigo certo em unidade publica devolve o token',
    case
      when v_tok = v_esperado then 'OK (devolveu ' || v_tok::text || ')'
      else 'FALHOU (esperado ' || v_esperado::text || ', veio ' || coalesce(v_tok::text,'null') || ')'
    end);
exception when others then
  reset role;
  insert into t_res values (27, 'CODE-1 codigo certo em unidade publica devolve o token', 'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── CODE-2: mesmo código, UNIDADE ERRADA → null ────────────────────────────
-- `reservation_code` tem UNIQUE GLOBAL, então sem o `and r.unit_id = p_unit_id`
-- o portal de qualquer loja resolveria código de qualquer outra. É o caso que o
-- CONTROLE-10 sabota.
do $$
declare v_unit_b uuid := 'bbbbbbbb-0000-0000-0000-000000000002';
        v_tok uuid;
begin
  delete from t_res where ord = 28;
  set local role anon;
  select resolve_tracking_token_by_code('STATSA1', v_unit_b) into v_tok;
  reset role;

  insert into t_res values (28, 'CODE-2 codigo de outra unidade nao resolve (sem oraculo cross-tenant)',
    case
      when v_tok is null then 'OK (null)'
      else 'FALHOU (vazou o token ' || v_tok::text || ' para a unidade errada)'
    end);
exception when others then
  reset role;
  insert into t_res values (28, 'CODE-2 codigo de outra unidade nao resolve (sem oraculo cross-tenant)', 'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── CODE-3: unidade NÃO pública → null ─────────────────────────────────────
-- STATSA5 mora na unidade A2, que é `is_public = false`. Este é o gate que tem
-- de casar com o de `get_public_tracking`: se o resolvedor for mais frouxo, o
-- cliente resolve o código e a pagina de acompanhamento recusa depois — beco
-- sem saída pior que a mensagem de hoje. É o caso que o CONTROLE-9 sabota.
do $$
declare v_unit_a2 uuid := 'bbbbbbbb-0000-0000-0000-000000000003';
        v_tok uuid;
begin
  delete from t_res where ord = 29;
  set local role anon;
  select resolve_tracking_token_by_code('STATSA5', v_unit_a2) into v_tok;
  reset role;

  insert into t_res values (29, 'CODE-3 unidade nao publica nao resolve',
    case
      when v_tok is null then 'OK (null)'
      else 'FALHOU (resolveu ' || v_tok::text || ' numa unidade is_public=false)'
    end);
exception when others then
  reset role;
  insert into t_res values (29, 'CODE-3 unidade nao publica nao resolve', 'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── CODE-4: código inexistente → null, igual aos outros dois ───────────────
do $$
declare v_unit_a uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_tok uuid;
begin
  delete from t_res where ord = 30;
  set local role anon;
  select resolve_tracking_token_by_code('ZZZZZZZZ', v_unit_a) into v_tok;
  reset role;

  insert into t_res values (30, 'CODE-4 codigo inexistente devolve null igual aos negados',
    case
      when v_tok is null then 'OK (null, indistinguivel de CODE-2 e CODE-3)'
      else 'FALHOU (devolveu ' || v_tok::text || ')'
    end);
exception when others then
  reset role;
  insert into t_res values (30, 'CODE-4 codigo inexistente devolve null igual aos negados', 'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── CODE-5: minúsculas e espaços resolvem igual ────────────────────────────
-- Cliente cola o código do WhatsApp com espaço em volta. `upper(btrim())`.
do $$
declare v_unit_a uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_esperado uuid := 'dddddddd-0000-0000-0000-000000000001';
        v_tok uuid;
begin
  delete from t_res where ord = 31;
  set local role anon;
  select resolve_tracking_token_by_code('  statsa1  ', v_unit_a) into v_tok;
  reset role;

  insert into t_res values (31, 'CODE-5 minusculas e espacos resolvem igual a CODE-1',
    case
      when v_tok = v_esperado then 'OK (devolveu ' || v_tok::text || ')'
      else 'FALHOU (esperado ' || v_esperado::text || ', veio ' || coalesce(v_tok::text,'null') || ')'
    end);
exception when others then
  reset role;
  insert into t_res values (31, 'CODE-5 minusculas e espacos resolvem igual a CODE-1', 'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── CODE-6: get_reservation_by_code NÃO EXISTE MAIS ────────────────────────
-- O P1 desta frente fecha por remoção. Medir a ausência é a asserção inteira.
do $$
declare v_2arg oid; v_1arg oid;
begin
  delete from t_res where ord = 32;
  v_2arg := to_regprocedure('public.get_reservation_by_code(text,uuid)');
  v_1arg := to_regprocedure('public.get_reservation_by_code(text)');

  insert into t_res values (32, 'CODE-6 get_reservation_by_code foi dropada (P1 fecha por remocao)',
    case
      when v_2arg is null and v_1arg is null then 'OK (nenhum overload existe)'
      when v_2arg is not null then 'FALHOU (o overload de 2 argumentos ainda existe)'
      else 'FALHOU (o overload de 1 argumento reapareceu — a 107 o dropou)'
    end);
exception when others then
  insert into t_res values (32, 'CODE-6 get_reservation_by_code foi dropada (P1 fecha por remocao)', 'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── CODE-7: ACL — anon e authenticated executam, PUBLIC não ────────────────
-- `proacl` nulo NÃO é "ninguém tem": é a ACL DEFAULT, que em função concede
-- EXECUTE a PUBLIC. Tratar nulo como falso deixaria passar exatamente o estado
-- que o `revoke` da migration existe para evitar. Mesmo desenho do STATS-7.
do $$
declare v_anon boolean; v_auth boolean; v_pub boolean;
begin
  delete from t_res where ord = 33;
  select has_function_privilege('anon',          'public.resolve_tracking_token_by_code(text,uuid)', 'EXECUTE') into v_anon;
  select has_function_privilege('authenticated', 'public.resolve_tracking_token_by_code(text,uuid)', 'EXECUTE') into v_auth;
  select case
           when p.proacl is null then true
           else coalesce((select true from aclexplode(p.proacl) a
                           where a.grantee = 0 and a.privilege_type = 'EXECUTE' limit 1), false)
         end
    into v_pub
    from pg_proc p where p.oid = 'public.resolve_tracking_token_by_code(text,uuid)'::regprocedure;

  insert into t_res values (33, 'CODE-7 ACL: anon e authenticated executam, PUBLIC nao',
    case
      when v_anon and v_auth and not v_pub then 'OK (anon=t, authenticated=t, PUBLIC=f)'
      else 'FALHOU (anon=' || v_anon || ', authenticated=' || v_auth || ', PUBLIC=' || v_pub || ')'
    end);
exception when others then
  insert into t_res values (33, 'CODE-7 ACL: anon e authenticated executam, PUBLIC nao', 'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── CODE-8: idempotência medida ATRAVÉS DE DUAS EXECUÇÕES ──────────────────
do $$
declare v_def_md5 text; v_acl text; s record;
begin
  delete from t_res where ord = 34;
  select md5(pg_get_functiondef(p.oid)), coalesce(p.proacl::text, '<null>')
    into v_def_md5, v_acl
    from pg_proc p where p.oid = 'public.resolve_tracking_token_by_code(text,uuid)'::regprocedure;

  select * into s from t_code_snap where ord = 34;
  if s is null then
    insert into t_code_snap values (34, v_def_md5, v_acl);
    insert into t_res values (34, 'CODE-8 reaplicar a 109 nao muda corpo nem ACL',
      'OK (1a passada: snapshot gravado, corpo md5 ' || left(v_def_md5, 8) || ', acl ' || v_acl || ')');
  elsif s.def_md5 = v_def_md5 and s.acl = v_acl then
    insert into t_res values (34, 'CODE-8 reaplicar a 109 nao muda corpo nem ACL',
      'OK (2a passada: corpo e ACL identicos ao snapshot)');
  else
    insert into t_res values (34, 'CODE-8 reaplicar a 109 nao muda corpo nem ACL',
      'FALHOU (mudou: corpo ' || left(s.def_md5,8) || ' -> ' || left(v_def_md5,8)
        || ', acl ' || s.acl || ' -> ' || v_acl || ')');
  end if;
exception when others then
  insert into t_res values (34, 'CODE-8 reaplicar a 109 nao muda corpo nem ACL', 'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;
