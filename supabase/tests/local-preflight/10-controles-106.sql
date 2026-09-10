-- DOIS CONTROLES POSITIVOS da migration 106.
--
-- Rodar SEM ON_ERROR_STOP: os dois casos quebram de propósito.
--
-- Sem eles, "ACL-2 passou" e "ACL-1 passou" não distinguem a guarda funcionando
-- de teste sem força. CONTROLE-6 reintroduz o defeito central desta fase;
-- CONTROLE-7 responde QUAL grant sustenta as policies.
--
-- CONTROLE-6 desfaz a reescrita de enter_waitlist. Reaplicar a 106 restaura a
-- versão real — ver o README.

-- ═══ CONTROLE-6 — desfaz a reescrita e mostra a fila quebrando ═══
--
-- Reproduz o achado que decide a fase: em plpgsql o nome da função é resolvido
-- em TEMPO DE EXECUÇÃO, então `public.is_unit_member` num corpo que sobreviveu
-- ao SET SCHEMA aponta para função que não existe mais.
--
-- Duas coisas fazem este controle medir de fato:
--   1. A definição antiga é reconstruída a partir de `pg_get_functiondef`, não
--      redigitada. Assim assinatura, DEFAULTs, volatilidade, modo de segurança e
--      search_path vêm do banco — o ÚNICO delta é a qualificação do helper. Um
--      `create or replace` redigitado à mão erraria o tipo de retorno (a função
--      devolve `(waitlist_id, code)`) e falharia por outro motivo, o que pareceria
--      sucesso do controle.
--   2. O claim JWT é setado. Sem ele `auth.uid()` é NULL, `enter_waitlist` toma o
--      ramo anon e NÃO chama helper nenhum — o controle reportaria "deveria ter
--      estourado" mesmo com o defeito presente.
--
-- Note que `app_private` PERMANECE no search_path da função reconstruída: é o que
-- mostra que a quebra vem da qualificação explícita, não de search_path faltando.
do $$
declare v_def text; v_unit uuid; v_user uuid; v_err text;
begin
  delete from t_res where ord = 6;

  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'enter_waitlist';

  -- Volta a qualificação antiga, mantendo todo o resto da definição intacto.
  execute replace(v_def, 'app_private.is_', 'public.is_');

  select id into v_unit from units where is_public limit 1;
  select user_id into v_user from unit_members where unit_id = v_unit limit 1;
  perform set_config('request.jwt.claims', json_build_object('sub', v_user)::text, true);

  begin
    perform enter_waitlist(v_unit, 'Controle 6', '11900000000', 2, null, 'normal', null);
    insert into t_res values (6, 'CONTROLE-6 corpo sem reescrita', 'FALHOU: deveria ter estourado');
  exception when undefined_function then
    get stacked diagnostics v_err = message_text;
    insert into t_res values (6, 'CONTROLE-6 corpo sem reescrita',
      'OK (estourou como esperado: ' || v_err || ')');
  end;
end $$;

-- ═══ CONTROLE-7 — qual grant é load-bearing para as policies ═══
--
-- O rascunho desta fase supunha que `grant usage on schema app_private to anon`
-- era o que sustentava as 24 policies TO PUBLIC. NÃO É, e este controle mede as
-- duas metades para que ninguém volte a supor:
--
--   7a  USAGE revogado do schema  → a consulta CONTINUA funcionando. Expressão de
--       policy fica guardada no catálogo já resolvida por OID; nenhum nome é
--       procurado na hora da consulta, e USAGE só governa procura de nome.
--   7b  EXECUTE revogado da função → a consulta ESTOURA com 42501. O privilégio
--       de função é conferido na inicialização da expressão, mesmo referenciada
--       por OID. É ESTE o grant que, se revogado, faz a query estourar em vez de
--       negar linha — a razão de mover em vez de revogar.
--
-- O veredito exige as DUAS metades: se 7a passar a estourar, o cabeçalho da 106
-- está desatualizado; se 7b parar de estourar, o argumento inteiro cai.
do $$
declare v_unit uuid; v_user uuid; v_n int;
        v_7a text; v_7b text;
begin
  delete from t_res where ord = 7;
  select id into v_unit from units where is_public limit 1;
  select user_id into v_user from unit_members where unit_id = v_unit limit 1;

  -- ── 7a: revogar USAGE do schema ────────────────────────────────────────────
  revoke usage on schema app_private from anon;
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_user)::text, true);
    set local role anon;
    select count(*) into v_n from acl_probe;
    reset role;
    v_7a := case when v_n = 1 then 'ok' else 'divergiu (contou ' || v_n || ')' end;
  exception when others then
    reset role;
    v_7a := 'divergiu (estourou: ' || sqlerrm || ')';
  end;
  grant usage on schema app_private to anon;

  -- ── 7b: revogar EXECUTE da função ─────────────────────────────────────────
  revoke execute on function app_private.is_unit_member(uuid, uuid) from anon;
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_user)::text, true);
    set local role anon;
    select count(*) into v_n from acl_probe;
    reset role;
    v_7b := 'divergiu (NAO estourou, contou ' || v_n || ')';
  exception when insufficient_privilege then
    reset role;
    v_7b := 'ok';
  when others then
    reset role;
    v_7b := 'divergiu (erro inesperado: ' || sqlstate || ' ' || sqlerrm || ')';
  end;
  grant execute on function app_private.is_unit_member(uuid, uuid) to anon;

  insert into t_res values (7, 'CONTROLE-7 EXECUTE e load-bearing, USAGE nao',
    case when v_7a = 'ok' and v_7b = 'ok'
         then 'OK (USAGE revogado nao afeta policy; EXECUTE revogado estoura 42501)'
         else 'FALHOU: 7a USAGE=' || v_7a || ' / 7b EXECUTE=' || v_7b end);
end $$;
