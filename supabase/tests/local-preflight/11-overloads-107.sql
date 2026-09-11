-- ACL-6 e CONTROLE-8 — a migration 107 dropa DOIS overloads sem caller e não
-- pode encostar nos de 2 argumentos, que são os que a UI usa de verdade.
--
-- ORDINAIS. 8 e 9 já pertencem a ACL-1b (em 09-advisor-hardening.sql) e a
-- CONTROLE-9 (em 10-controles-106.sql) — os três arquivos rodam no MESMO banco
-- `advisor106`, na mesma tabela `t_res`. Este arquivo usa 14 e 15, os primeiros
-- ordinais livres depois de ACL-3b/3c/3d (11-13). O README documenta a tabela
-- completa.
--
-- POR QUE OS DOIS CASOS FICAM NO MESMO ARQUIVO, RODADO COM ON_ERROR_STOP=1. A
-- convenção deste diretório separa "casos" de "controles" porque os controles
-- de sabotagem (04, 06, 10-controles-106.sql) rodam SEM ON_ERROR_STOP — alguns
-- deles (CONTROLE-6) deixam o banco propositalmente sabotado até um reapply
-- externo de migration restaurar, então a sessão psql roda com essa rede de
-- segurança. O CONTROLE-8 abaixo é diferente por construção: ele captura a
-- definição ANTES de dropar, restaura de dentro do próprio bloco `do $$` e
-- CONFERE o restore por comportamento observável antes de terminar — nenhum
-- erro real escapa para o psql, porque tanto o "deveria ter estourado" quanto
-- qualquer falha de restore são capturados e viram uma linha `FALHOU` em
-- `t_res`, nunca um ERROR solto. Não depende de nenhum passo externo depois
-- dele. Por isso é seguro rodar ao lado do ACL-6 num arquivo com
-- ON_ERROR_STOP=1, como mais um item da sequência normal — e por isso NÃO
-- entra em `10-controles-106.sql`, que é de outra fase e não deve ser tocado
-- por esta.
--
-- Rodar depois de 00, 01, 09a, 09 (a sequência do advisor), 106, 10 e — para o
-- estado GREEN — da 107. Antes da 107 existir, os dois já dão OK (nenhum dos
-- dois casos depende da 107 ter rodado: ela só remove os overloads de 1
-- argumento, que nenhum dos dois casos toca). O que muda entre "antes" e
-- "depois" da 107 não é o veredito de ACL-6/CONTROLE-8 — é que, sem a 107, os
-- overloads de 1 argumento (que a 107 vai dropar) ainda respondem; a prova de
-- que ELES saem é o `drop function if exists` da própria migration rodando sem
-- erro contra função que existe de verdade neste bootstrap (não um no-op vazio)
-- e a contagem do advisor caindo em produção (Step 9, fora deste harness).

-- ═══ ACL-6 — os overloads de 2 argumentos sobrevivem à 107 ═══
--
-- Roda como `authenticated` de verdade (GUC do claim + `set local role`), não
-- como o superusuário da sessão — sem isso o `grant`/`revoke` das duas funções
-- não estaria sendo exercitado, e o caso passaria mesmo se o ACL estivesse
-- errado.
do $$
declare
  v_unit uuid := 'bbbbbbbb-0000-0000-0000-000000000001';  -- Unidade Advisor A
  v_cust uuid := 'eeeeeeee-0000-0000-0000-000000000004';  -- Cliente Stats, org A
  v_user uuid;
  v_n    int;
begin
  delete from t_res where ord = 14;

  select user_id into v_user from unit_members where unit_id = v_unit limit 1;

  perform set_config('request.jwt.claims', json_build_object('sub', v_user)::text, true);
  set local role authenticated;
  select count(*) into v_n from get_customer_stats(v_cust, v_unit);
  perform * from get_reservation_by_code('QUALQUER', v_unit);
  reset role;

  insert into t_res values (14, 'ACL-6 overloads de 2 args sobrevivem',
    'OK (get_customer_stats devolveu ' || v_n || ' linha(s); get_reservation_by_code nao estourou)');
exception when others then
  reset role;
  insert into t_res values (14, 'ACL-6 overloads de 2 args sobrevivem', 'FALHOU: ' || sqlerrm);
end $$;

-- ═══ CONTROLE-8 — dropar o overload de 2 argumentos por engano quebra o call
-- site real ═══
--
-- Delimita o que a 107 pode dropar com segurança: ela só remove os overloads
-- de 1 argumento (sem caller). Sem este controle, "ACL-6 passou" não distingue
-- "a 107 dropou a assinatura certa" de "eu nunca exercitei a errada".
--
-- CAPTURA antes de derrubar, RESTAURA depois e CONFERE o restore por
-- comportamento observável — mesma disciplina do CONTROLE-9/10 em
-- 10-controles-106.sql. Mas o restore aqui é mais pesado que o deles: o
-- CONTROLE-9/10 sabota só o CORPO de um helper que continua existindo
-- (`create or replace`), então reaplicar a captura basta. Aqui a sabotagem é um
-- `drop function` de verdade — a função deixa de existir, e um `create` novo
-- nasceria com EXECUTE concedido a PUBLIC por default (a mesma razão pela qual
-- este bootstrap inteiro revoga antes de conceder). Por isso o restore refaz
-- as DUAS metades: o corpo (da captura de `pg_get_functiondef`) e o ACL
-- (`revoke`/`grant` explícitos), e só then confere que `authenticated` volta a
-- ver a RPC responder.
--
-- Nenhuma migration real restauraria isto: não existe migration que crie só
-- este overload isoladamente (ele nasce dentro de `013_multi_tenant.sql` junto
-- com o resto da função), e reaplicar essa migration inteira não é o padrão
-- deste harness para restaurar sabotagem pontual — o padrão estabelecido pelo
-- CONTROLE-9/10 é capturar e restaurar de dentro do próprio caso, e é o que
-- este faz.
do $$
declare
  v_unit uuid := 'bbbbbbbb-0000-0000-0000-000000000001';  -- Unidade Advisor A
  v_cust uuid := 'eeeeeeee-0000-0000-0000-000000000004';  -- Cliente Stats, org A
  v_user uuid;
  v_def  text;
  v_oid  oid;
  v_estourou   boolean := false;
  v_err        text;
  v_restaurado int;
begin
  delete from t_res where ord = 15;

  select user_id into v_user from unit_members where unit_id = v_unit limit 1;

  v_oid := to_regprocedure('public.get_customer_stats(uuid, uuid)');
  if v_oid is null then
    raise exception 'get_customer_stats(uuid, uuid) nao existe no bootstrap — 09a foi aplicado?';
  end if;
  select pg_get_functiondef(v_oid) into v_def;

  -- ── Sabota: dropa o overload de 2 args, o que a UI usa de verdade ─────────
  drop function public.get_customer_stats(uuid, uuid);

  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_user)::text, true);
    set local role authenticated;
    perform * from get_customer_stats(v_cust, v_unit);
    reset role;
  exception when undefined_function then
    get stacked diagnostics v_err = message_text;
    reset role;
    v_estourou := true;
  end;

  -- ── Restaura corpo (da captura) e ACL (o drop apagou as duas) ─────────────
  execute v_def;
  revoke all on function public.get_customer_stats(uuid, uuid) from public;
  grant execute on function public.get_customer_stats(uuid, uuid) to authenticated, service_role;

  -- ── Confere o restore por comportamento observável, não por suposição ─────
  perform set_config('request.jwt.claims', json_build_object('sub', v_user)::text, true);
  set local role authenticated;
  select count(*) into v_restaurado from get_customer_stats(v_cust, v_unit);
  reset role;

  insert into t_res values (15, 'CONTROLE-8 drop do overload errado',
    case
      when not v_estourou
        then 'FALHOU: deveria ter estourado (call site sobreviveu ao drop do overload de 2 args)'
      when v_restaurado <> 1
        then 'FALHOU: estourou como esperado (' || v_err
             || '), mas o RESTORE nao voltou (esperado 1 linha, veio ' || v_restaurado || ')'
      else 'OK (estourou como esperado: ' || v_err
           || '; restaurado, a RPC volta a responder com 1 linha)'
    end);
-- Handler do bloco EXTERNO: como DDL/GRANT em plpgsql roda na subtransação do
-- bloco, qualquer falha no meio (captura, drop, restore ou confere) desfaz por
-- rollback o `drop function` e qualquer restore parcial — nenhum caminho deixa
-- a função dropada de pé. Mesma disciplina do CONTROLE-9/10.
exception when others then
  reset role;
  insert into t_res values (15, 'CONTROLE-8 drop do overload errado',
    'FALHOU: ' || sqlerrm || ' (sabotagem desfeita por rollback da subtransacao)');
end $$;
