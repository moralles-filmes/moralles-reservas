-- QUATRO CONTROLES POSITIVOS da migration 106 — ordinais 6, 7, 9 e 10.
--
-- Rodar SEM ON_ERROR_STOP: os casos de sabotagem quebram de propósito.
--
-- Sem eles, "ACL-x passou" não distingue a guarda funcionando de teste sem
-- força:
--   CONTROLE-6   reintroduz o defeito central desta fase (qualificador do helper
--                num corpo plpgsql) e vê a fila pública quebrar.
--   CONTROLE-7   responde QUAL privilégio sustenta as policies — 7a afirma a
--                postura entregue (sem USAGE para papel público), 7b sabota o
--                EXECUTE e vê 42501.
--   CONTROLE-9   sabota `is_unit_member` e vê o ACL-1b reprovar.
--   CONTROLE-10  sabota `is_org_member` e vê o agregado de outro tenant vazar no
--                ACL-3d.
--
-- O ordinal 8 está RESERVADO ao controle de overload errado de
-- `11-overloads-107.sql`, que vive em outro banco — daí o salto de 7 para 9.
--
-- RESTORE, e as duas formas dele: CONTROLE-6 desfaz a reescrita de
-- `enter_waitlist` e é REAPLICAR A 106 que restaura. CONTROLE-9 e CONTROLE-10
-- sabotam CORPO DE HELPER, e aí a 106 não restaura nada (ela só move o helper,
-- nunca define o corpo) — cada um restaura de dentro, a partir de
-- `pg_get_functiondef` capturado antes de sabotar. Ver o README.

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
-- Handler do bloco EXTERNO: sem ele, uma falha na reconstrução (o `select` do
-- functiondef, o `execute`, a resolução da unidade) deixaria o ordinal 6
-- simplesmente AUSENTE de t_res — e ausência não se lê como reprovação sem
-- alguém contar as linhas.
exception when others then
  insert into t_res values (6, 'CONTROLE-6 corpo sem reescrita', 'FALHOU: ' || sqlerrm);
end $$;

-- ═══ CONTROLE-7 — qual privilégio é load-bearing para as policies ═══
--
-- O rascunho desta fase supunha que `grant usage on schema app_private to anon`
-- era o que sustentava as 24 policies TO PUBLIC. NÃO É — e a 106 passou a NEGAR
-- esse USAGE a `anon` e `authenticated` justamente porque ele não é load-bearing
-- e é a última tranca se o schema for exposto à API por engano.
--
-- POR QUE O 7a MUDOU DE FORMA. Ele revogava USAGE de `anon` para mostrar que a
-- policy seguia avaliando. Isso deixou de ser uma sabotagem: `anon` já não tem
-- USAGE nenhum, e a SUÍTE INTEIRA passou a rodar nesse estado — o que é mais
-- forte que o controle antigo, não mais fraco. Então o 7a virou a AFIRMAÇÃO
-- EXPLÍCITA da postura entregue, e quem prova que ela é suficiente são os casos
-- do `09` rodando ao lado dela: ACL-1 (policy TO PUBLIC), ACL-1b (tenant
-- cruzado) e ACL-4 (`anon` entra na fila ponta a ponta), todos verdes sem USAGE.
--
--   7a  postura: `anon` e `authenticated` NÃO têm usage em `app_private`.
--   7b  EXECUTE revogado da função → a consulta ESTOURA com 42501. O privilégio
--       de função é conferido na inicialização da expressão, mesmo a expressão
--       sendo referenciada por identificador já resolvido. É ESTE o privilégio
--       que, se revogado, faz a query estourar em vez de negar linha — a razão
--       de mover em vez de revogar.
--
-- O veredito exige as DUAS metades: se 7a falhar, alguém reconcedeu USAGE a papel
-- público (regressão); se 7b parar de estourar, o argumento inteiro cai.
do $$
declare v_unit uuid; v_user uuid; v_n int;
        v_anon_usage boolean; v_auth_usage boolean;
        v_7a text; v_7b text;
begin
  delete from t_res where ord = 7;
  select id into v_unit from units where is_public limit 1;
  select user_id into v_user from unit_members where unit_id = v_unit limit 1;

  -- ── 7a: a postura entregue, afirmada e não suposta ────────────────────────
  v_anon_usage := has_schema_privilege('anon',          'app_private', 'usage');
  v_auth_usage := has_schema_privilege('authenticated', 'app_private', 'usage');
  v_7a := case
            when v_anon_usage or v_auth_usage
              then 'divergiu (usage concedido: anon=' || v_anon_usage
                   || ', authenticated=' || v_auth_usage || ')'
            else 'ok'
          end;

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
         then 'OK (anon/authenticated sem usage no schema, e ainda assim ACL-1/1b/4 passam; '
              || 'EXECUTE revogado estoura 42501)'
         else 'FALHOU: 7a postura=' || v_7a || ' / 7b EXECUTE=' || v_7b end);
-- Handler do bloco EXTERNO, mesma razão do CONTROLE-6: sem ele, falha FORA do
-- handler interno — o `revoke`/`grant` do 7b, um papel ausente, a resolução da
-- unidade — deixaria o ordinal 7 simplesmente AUSENTE de t_res, e ausência não se
-- lê como reprovação sem alguém contar as linhas. Como DDL/GRANT em plpgsql roda
-- na subtransação do bloco, a falha também desfaz por rollback um EXECUTE que
-- tivesse sido revogado e não reconcedido.
exception when others then
  reset role;
  insert into t_res values (7, 'CONTROLE-7 EXECUTE e load-bearing, USAGE nao',
    'FALHOU: ' || sqlerrm || ' (revoke/grant desfeitos por rollback da subtransacao)');
end $$;

-- ═══ CONTROLE-9 — o predicado de tenant é o que o ACL-1b mede ═══
--
-- Ordinal 9 porque o 8 está RESERVADO para o controle de overload errado que a
-- fase acrescenta em 11-overloads-107.sql. Os dois vivem em bancos diferentes,
-- mas ordinal repetido na documentação confunde de graça.
--
-- Reintroduz o defeito que o ACL-1b existe para pegar: helper que devolve TRUE
-- sem olhar `unit_members`. O que este caso mede é a metade do ACL-1b — que um
-- não-membro passa a VER linha. É a asserção de isolamento multi-tenant desta
-- migration, e sem este controle "ACL-1b passou" não distingue a guarda
-- funcionando de teste sem força. (Que o ACL-1 sozinho passaria contra este
-- mesmo helper é o motivo de o ACL-1b existir, e está dito no `09`.)
--
-- POR QUE O RESTORE MORA AQUI DENTRO, e não no reapply da 106 como nos controles
-- 6 e 7: a 106 apenas MOVE o helper (`alter function ... set schema`), guardada
-- por `to_regprocedure('public.is_unit_member(uuid,uuid)') is not null` — que é
-- NULL depois do move. Ela nunca redefine o corpo. Medido: sabotar, reaplicar a
-- 106 e reler `prosrc` devolve `select true` intacto. Se o restore dependesse do
-- reapply, este controle deixaria um helper permissivo no banco e TODO caso
-- posterior passaria em silêncio — que é o pior resultado possível num arquivo
-- de controle.
--
-- Duas coisas tornam o restore inequívoco:
--   1. a definição real é capturada de `pg_get_functiondef` ANTES da sabotagem,
--      então o que volta é o que estava lá — não uma cópia redigitada;
--   2. o restore é VERIFICADO no próprio caso (o não-membro tem de voltar a ver
--      zero), e o veredito só é OK se as duas metades casarem.
-- E o bloco tem handler `when others`: como DDL em plpgsql roda na subtransação
-- do bloco, qualquer falha no meio faz a sabotagem ser DESFEITA por rollback.
-- Não há caminho que deixe o helper permissivo de pé.
do $$
declare v_def text;
        v_unit_a uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_unit_b uuid := 'bbbbbbbb-0000-0000-0000-000000000002';
        v_sem    uuid := '33333333-3333-3333-3333-333333333333';
        v_sabotado int; v_restaurado int;
begin
  delete from t_res where ord = 9;

  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app_private' and p.proname = 'is_unit_member';
  if v_def is null then
    raise exception 'app_private.is_unit_member nao existe — a 106 foi aplicada?';
  end if;

  -- Cenário próprio: uma linha por unidade, para não depender do estado deixado
  -- pelo ACL-1b.
  delete from acl_probe;
  insert into acl_probe (unit_id, nota) values (v_unit_a, 'linha da unidade A');
  insert into acl_probe (unit_id, nota) values (v_unit_b, 'linha da unidade B');

  -- ── Sabota: nomes de parâmetro têm de ser os mesmos, senão o
  -- `create or replace` recusa ("cannot change name of input parameter").
  create or replace function app_private.is_unit_member(p_user_id uuid, p_unit_id uuid)
  returns boolean language sql stable security definer set search_path = public
  as $body$ select true $body$;

  perform set_config('request.jwt.claims', json_build_object('sub', v_sem)::text, true);
  set local role authenticated;
  select count(*) into v_sabotado from acl_probe;
  reset role;

  -- ── Restaura a definição capturada e CONFERE que restaurou.
  execute v_def;

  perform set_config('request.jwt.claims', json_build_object('sub', v_sem)::text, true);
  set local role authenticated;
  select count(*) into v_restaurado from acl_probe;
  reset role;

  insert into t_res values (9, 'CONTROLE-9 helper permissivo faz o ACL-1b reprovar',
    case
      when v_sabotado = 0
        then 'FALHOU: deveria ter estourado (nao-membro seguiu vendo zero com helper TRUE)'
      when v_restaurado <> 0
        then 'FALHOU: sabotagem detectada (' || v_sabotado
             || ' linhas), mas o RESTORE nao voltou (nao-membro ainda ve '
             || v_restaurado || ')'
      else 'OK (com helper TRUE o nao-membro viu ' || v_sabotado
           || ' linha(s); restaurado, voltou a ver zero)'
    end);
exception when others then
  reset role;
  insert into t_res values (9, 'CONTROLE-9 helper permissivo faz o ACL-1b reprovar',
    'FALHOU: ' || sqlerrm || ' (sabotagem desfeita por rollback da subtransacao)');
end $$;

-- ═══ CONTROLE-10 — `is_org_member` permissivo VAZA agregado de outro tenant ═══
--
-- O CONTROLE-9 sabota `is_unit_member`, alcançado por `acl_probe`. Este sabota
-- `is_org_member`, que é o guard das outras duas funções de cliente — sem ele,
-- os casos ACL-3b e ACL-3d passariam sem nada provar que eles pegam o defeito.
--
-- Mede pelo ACL-3d, e não pelo ACL-3b, porque ACL-3d é o caso de VAZAMENTO DE
-- DADO: com o helper devolvendo TRUE, `get_customer_stats_bulk` não estoura —
-- ele devolve a agregação do cliente da outra organização junto com a do
-- chamador. Recusa que deixa de recusar é visível; agregado que aparece a mais é
-- o que passa despercebido, e é o que este controle torna vermelho.
-- (O ACL-3b também ficaria vermelho: `anonymize_customer` usa o mesmo helper.
-- Um controle sobre `is_org_member` cobre os dois.)
--
-- Mesma disciplina do CONTROLE-9: captura de `pg_get_functiondef` ANTES de
-- sabotar, restore a partir dessa captura, restore VERIFICADO por comportamento
-- observável (a contagem tem de voltar a 1) e handler `when others` — DDL em
-- plpgsql roda na subtransação do bloco, então falha no meio desfaz a sabotagem
-- por rollback. E vale aqui o mesmo aviso do CONTROLE-9: reaplicar a 106 NÃO
-- restauraria, porque a 106 só move o helper e nunca define o corpo.
do $$
declare v_def text;
        v_unit uuid; v_membro_a uuid := '11111111-1111-1111-1111-111111111111';
        v_cust_a uuid := 'eeeeeeee-0000-0000-0000-000000000004';  -- org A
        v_cust_b uuid := 'eeeeeeee-0000-0000-0000-000000000005';  -- org B
        v_sabotado int; v_restaurado int;
begin
  delete from t_res where ord = 10;
  select id into v_unit from units where is_public limit 1;

  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app_private' and p.proname = 'is_org_member';
  if v_def is null then
    raise exception 'app_private.is_org_member nao existe — a 106 foi aplicada?';
  end if;

  -- Sabota. Nomes de parâmetro têm de bater com os reais (`p_user_id`,
  -- `p_org_id`), senão `create or replace` recusa.
  create or replace function app_private.is_org_member(p_user_id uuid, p_org_id uuid)
  returns boolean language sql stable security definer set search_path = public
  as $body$ select true $body$;

  perform set_config('request.jwt.claims', json_build_object('sub', v_membro_a)::text, true);
  set local role authenticated;
  select count(*) into v_sabotado from get_customer_stats_bulk(array[v_cust_a, v_cust_b], v_unit);
  reset role;

  -- Restaura da captura e confere pelo comportamento.
  execute v_def;

  perform set_config('request.jwt.claims', json_build_object('sub', v_membro_a)::text, true);
  set local role authenticated;
  select count(*) into v_restaurado from get_customer_stats_bulk(array[v_cust_a, v_cust_b], v_unit);
  reset role;

  insert into t_res values (10, 'CONTROLE-10 is_org_member permissivo vaza agregado alheio',
    case
      when v_sabotado <= 1
        then 'FALHOU: deveria ter estourado (com helper TRUE o agregado alheio nao apareceu; veio '
             || v_sabotado || ' linha(s))'
      when v_restaurado <> 1
        then 'FALHOU: vazamento detectado (' || v_sabotado
             || ' linhas), mas o RESTORE nao voltou (ainda vem ' || v_restaurado || ')'
      else 'OK (com helper TRUE vazaram ' || v_sabotado
           || ' linhas em vez de 1; restaurado, voltou a 1)'
    end);
exception when others then
  reset role;
  insert into t_res values (10, 'CONTROLE-10 is_org_member permissivo vaza agregado alheio',
    'FALHOU: ' || sqlerrm || ' (sabotagem desfeita por rollback da subtransacao)');
end $$;
