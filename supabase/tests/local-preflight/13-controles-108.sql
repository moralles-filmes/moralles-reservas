-- DOIS CONTROLES POSITIVOS da migration 108 — ordinais 25 e 26.
--
-- Rodar SEM ON_ERROR_STOP: os casos sabotam de propósito.
--
-- Sem eles, "STATS-2 passou" não distingue a guarda funcionando de teste sem
-- força:
--   CONTROLE-25  neutraliza SÓ o `raise` de `forbidden`, com delta mínimo sobre
--                `pg_get_functiondef`, e vê o agregado da org B chegar ao
--                membro da org A. É o defeito central desta migration.
--   CONTROLE-26  repõe o corpo `language sql` pré-108 INTEIRO e vê as DUAS
--                regressões de uma vez: o vazamento cross-org e a chamada sem
--                sessão devolvendo linha de zeros em vez de 42501. Mede que é a
--                estrutura toda que fecha, não só a linha do `raise`.
--
-- POR QUE A SABOTAGEM DO 25 É O `raise`, E NÃO O `if`. A tentativa óbvia —
-- trocar `if v_org is null` por `if false and v_org is null` — NÃO neutraliza
-- nada, e isso foi medido, não deduzido: `and` liga mais forte que `or`, então
-- a condição vira `(false and v_org is null) or not (is_platform_admin or
-- is_org_member)`, e o segundo disjunto continua verdadeiro para membro da org
-- A pedindo cliente da org B — o raise dispararia igual e o controle ficaria
-- "OK" tendo sabotado coisa nenhuma. Trocar o `raise` por `null;` neutraliza o
-- ramo inteiro sem tocar em precedência, e deixa o ramo `unauthenticated`
-- intacto: é exatamente a sabotagem do guard de ORG, nada mais.
--
-- Este arquivo depende das RESERVAS que o `12` cria. Sem elas o agregado da org
-- B seria zero e "vazou" ficaria indistinguível de "cliente sem reserva
-- nenhuma" — o controle pareceria verde medindo nada. O guard abaixo recusa
-- rodar nesse estado.
--
-- RESTORE: a 108 DEFINE o corpo (diferente da 106, que só move helpers), então
-- reaplicar a migration restaura as duas sabotagens. É o que o README manda
-- fazer depois deste arquivo.
do $ctrl$
begin
  if not exists (select 1 from reservations
                  where customer_id = 'eeeeeeee-0000-0000-0000-000000000005') then
    raise exception '13-controles-108.sql exige as reservas criadas por 12-customer-stats-108.sql (o cliente da org B nao tem nenhuma). Sem elas o vazamento seria indistinguivel de cliente sem reserva e o controle ficaria verde medindo nada.';
  end if;
end $ctrl$;

-- ═══ CONTROLE-25 — sem o raise do guard, o agregado de outra org vaza ═══════
--
-- Duas coisas fazem este controle medir de fato:
--   1. A definição sabotada é construída a partir de `pg_get_functiondef`, não
--      redigitada: assinatura, DEFAULTs, volatilidade, modo de segurança e
--      search_path vêm do banco, e o ÚNICO delta é o `raise` de `forbidden`.
--      Mesmo método do CONTROLE-6. O caso ainda confere que o `replace` de fato
--      mudou o texto — sabotagem que não sabota é o modo silencioso de um
--      controle positivo mentir.
--   2. A asserção é sobre o NÚMERO que voltou (3, da org B), não sobre "não
--      estourou": guard quebrado aqui vaza dado, não erro.
do $ctrl$
declare v_def text; v_sab text;
        v_membro_a uuid := '11111111-1111-1111-1111-111111111111';
        v_cust_b   uuid := 'eeeeeeee-0000-0000-0000-000000000005';
        v_total int;
begin
  delete from t_res where ord = 25;

  v_def := pg_get_functiondef('public.get_customer_stats(uuid,uuid)'::regprocedure);
  v_sab := replace(v_def,
                   'raise exception ''forbidden'' using errcode = ''42501'';',
                   'null;');

  if v_sab = v_def then
    insert into t_res values (25, 'CONTROLE-25 sem o raise do guard, o agregado de outra org vaza',
      'FALHOU (o replace nao mudou nada: o raise de forbidden nao esta no corpo com o texto esperado — a 108 nao esta aplicada ou o corpo mudou)');
    return;
  end if;

  execute v_sab;

  perform set_config('request.jwt.claims', json_build_object('sub', v_membro_a)::text, true);
  set local role authenticated;
  select total into v_total from get_customer_stats(v_cust_b, null);
  reset role;

  insert into t_res values (25, 'CONTROLE-25 sem o raise do guard, o agregado de outra org vaza',
    case
      when v_total = 3 then 'OK (vazou total=3 da org B para membro da org A — o guard do STATS-2 tem forca)'
      else 'FALHOU (sabotado e ainda assim nao vazou: total=' || coalesce(v_total::text,'null')
             || '; o STATS-2 pode estar passando por outro motivo)'
    end);
exception when others then
  reset role;
  insert into t_res values (25, 'CONTROLE-25 sem o raise do guard, o agregado de outra org vaza', 'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $ctrl$;

-- ═══ CONTROLE-26 — repõe o corpo pré-108 e vê as DUAS regressões ════════════
--
-- Este é o corpo que estava em produção até a 108 (o mesmo que o
-- `09a-advisor-bootstrap.sql` extraiu). Repô-lo mede o que a migration inteira
-- fecha, não só a linha do `raise`: sem sessão, o corpo antigo devolve uma
-- LINHA DE ZEROS em vez de recusar, porque `count(*)` sobre conjunto vazio
-- sempre produz linha. É essa a diferença entre "negar" e "não achar nada", e é
-- o motivo de a 108 ter virado plpgsql em vez de ganhar um `where` a mais.
do $ctrl$
declare v_membro_a uuid := '11111111-1111-1111-1111-111111111111';
        v_cust_b   uuid := 'eeeeeeee-0000-0000-0000-000000000005';
        v_unit_a   uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
        v_cust_a   uuid := 'eeeeeeee-0000-0000-0000-000000000004';
        v_vazou int; v_sem_sessao int; v_recusou boolean := false;
begin
  delete from t_res where ord = 26;

  execute $ddl$
    create or replace function public.get_customer_stats(p_customer_id uuid, p_unit_id uuid default null)
    returns table(total integer, confirmed integer, no_shows integer,
                  cancelled integer, no_show_rate numeric, last_visit date)
    language sql stable security definer set search_path = 'public'
    as $body$
      with r as (
        select status, date from reservations
        where customer_id = p_customer_id and (p_unit_id is null or unit_id = p_unit_id)
      ),
      agg as (
        select count(*)::int as total,
          count(*) filter (where status = 'confirmed')::int as confirmed,
          count(*) filter (where status = 'no_show')::int as no_shows,
          count(*) filter (where status = 'cancelled')::int as cancelled,
          max(date) filter (where status in ('confirmed', 'no_show')) as last_visit
        from r
      )
      select total, confirmed, no_shows, cancelled,
        case when (confirmed + no_shows) > 0 then round(no_shows::numeric / (confirmed + no_shows), 3) else 0::numeric end,
        last_visit
      from agg;
    $body$;
  $ddl$;

  -- Regressão 1: tenant cruzado vaza.
  perform set_config('request.jwt.claims', json_build_object('sub', v_membro_a)::text, true);
  set local role authenticated;
  select total into v_vazou from get_customer_stats(v_cust_b, null);
  reset role;

  -- Regressão 2: sem sessão devolve zeros em vez de recusar.
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  set local role authenticated;
  begin
    select total into v_sem_sessao from get_customer_stats(v_cust_a, v_unit_a);
  exception when insufficient_privilege then
    v_recusou := true;
  end;
  reset role;

  insert into t_res values (26, 'CONTROLE-26 corpo pre-108 volta a vazar e a nao recusar sem sessao',
    case
      when v_vazou = 3 and not v_recusou and v_sem_sessao = 4
        then 'OK (vazou total=3 da org B, e sem sessao devolveu 4 em vez de 42501)'
      else 'FALHOU (esperado vazou=3 e sem_sessao=4 sem recusa; veio vazou='
             || coalesce(v_vazou::text,'null') || ', recusou=' || v_recusou
             || ', sem_sessao=' || coalesce(v_sem_sessao::text,'null') || ')'
    end);
exception when others then
  reset role;
  insert into t_res values (26, 'CONTROLE-26 corpo pre-108 volta a vazar e a nao recusar sem sessao', 'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $ctrl$;
