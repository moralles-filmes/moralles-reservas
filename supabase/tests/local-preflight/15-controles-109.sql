-- DOIS CONTROLES POSITIVOS da migration 109 — ordinais 35 e 36.
--
-- Rodar SEM ON_ERROR_STOP: os casos sabotam de propósito.
--
-- Sem eles, "CODE-2 e CODE-3 passaram" não distingue a guarda funcionando de
-- teste sem força — os dois casos afirmam `null`, e `null` é exatamente o que
-- uma função quebrada de qualquer outra maneira também devolveria.
--
--   CONTROLE-9   remove `and u.is_public = true` e vê CODE-3 resolver uma
--                unidade privada. É o gate que casa com o da get_public_tracking.
--   CONTROLE-10  remove `and r.unit_id = p_unit_id` e vê CODE-2 resolver código
--                de outra unidade — o portal de uma loja virando oráculo
--                universal, que é o que o UNIQUE GLOBAL de reservation_code
--                permite quando nada amarra o tenant.
--
-- AS DUAS ASSERÇÕES SÃO SOBRE O UUID QUE VOLTOU, não sobre "não estourou":
-- guarda quebrada aqui devolve dado, não erro. Foi essa a lição do CONTROLE-25.
--
-- A definição sabotada é construída a partir de `pg_get_functiondef`, não
-- redigitada: assinatura, volatilidade, modo de segurança e search_path vêm do
-- banco, e o ÚNICO delta é a linha removida. Cada caso confere que o `replace`
-- de fato mudou o texto — sabotagem que não sabota é o modo silencioso de um
-- controle positivo mentir.
--
-- RESTORE: a 109 DEFINE o corpo com `create or replace`, então reaplicar a
-- migration restaura as duas sabotagens. É o que o README manda fazer depois.
do $ctrl$
begin
  if to_regprocedure('public.resolve_tracking_token_by_code(text,uuid)') is null then
    raise exception '15-controles-109.sql exige a migration 109 aplicada.';
  end if;
  if not exists (select 1 from reservations where reservation_code = 'STATSA5') then
    raise exception '15-controles-109.sql exige as reservas do 12-customer-stats-108.sql (STATSA5, na unidade nao publica). Sem ela o CONTROLE-9 nao teria o que vazar e ficaria verde medindo nada.';
  end if;
end $ctrl$;

-- ═══ CONTROLE-9 — sem o gate is_public, unidade privada resolve ═════════════
do $ctrl$
declare v_def text; v_sab text;
        v_unit_a2 uuid := 'bbbbbbbb-0000-0000-0000-000000000003';
        v_esperado uuid := 'dddddddd-0000-0000-0000-000000000005';
        v_tok uuid;
begin
  delete from t_res where ord = 35;

  v_def := pg_get_functiondef('public.resolve_tracking_token_by_code(text,uuid)'::regprocedure);
  v_sab := replace(v_def, 'and u.is_public = true', 'and true');

  if v_sab = v_def then
    insert into t_res values (35, 'CONTROLE-9 sem o gate is_public, unidade privada resolve',
      'FALHOU (o replace nao mudou nada: `and u.is_public = true` nao esta no corpo com o texto esperado — a 109 nao esta aplicada ou o corpo mudou)');
    return;
  end if;

  execute v_sab;

  set local role anon;
  select resolve_tracking_token_by_code('STATSA5', v_unit_a2) into v_tok;
  reset role;

  insert into t_res values (35, 'CONTROLE-9 sem o gate is_public, unidade privada resolve',
    case
      when v_tok = v_esperado then 'OK (resolveu ' || v_tok::text || ' numa unidade is_public=false — o CODE-3 tem forca)'
      else 'FALHOU (sabotado e ainda assim nao resolveu: veio ' || coalesce(v_tok::text,'null')
             || '; o CODE-3 pode estar passando por outro motivo)'
    end);
exception when others then
  reset role;
  insert into t_res values (35, 'CONTROLE-9 sem o gate is_public, unidade privada resolve', 'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $ctrl$;

-- ═══ CONTROLE-10 — sem o casamento de unidade, código alheio resolve ════════
-- Este controle depende do CONTROLE-9 ter rodado antes? NÃO: ele reconstrói a
-- sabotagem a partir do corpo que estiver no banco. Mas se o 9 rodou e não
-- restaurou, o corpo já está sem `is_public` — por isso o caso confere que o
-- replace do `unit_id` mudou o texto, e o README reaplica a 109 no fim.
do $ctrl$
declare v_def text; v_sab text;
        v_unit_b uuid := 'bbbbbbbb-0000-0000-0000-000000000002';
        v_esperado uuid := 'dddddddd-0000-0000-0000-000000000001';
        v_tok uuid;
begin
  delete from t_res where ord = 36;

  v_def := pg_get_functiondef('public.resolve_tracking_token_by_code(text,uuid)'::regprocedure);
  v_sab := replace(v_def, 'and r.unit_id = p_unit_id', 'and true');

  if v_sab = v_def then
    insert into t_res values (36, 'CONTROLE-10 sem o casamento de unidade, codigo alheio resolve',
      'FALHOU (o replace nao mudou nada: `and r.unit_id = p_unit_id` nao esta no corpo com o texto esperado)');
    return;
  end if;

  execute v_sab;

  set local role anon;
  select resolve_tracking_token_by_code('STATSA1', v_unit_b) into v_tok;
  reset role;

  insert into t_res values (36, 'CONTROLE-10 sem o casamento de unidade, codigo alheio resolve',
    case
      when v_tok = v_esperado then 'OK (o portal da unidade B resolveu codigo da unidade A — o CODE-2 tem forca)'
      else 'FALHOU (sabotado e ainda assim nao resolveu: veio ' || coalesce(v_tok::text,'null')
             || '; o CODE-2 pode estar passando por outro motivo)'
    end);
exception when others then
  reset role;
  insert into t_res values (36, 'CONTROLE-10 sem o casamento de unidade, codigo alheio resolve', 'FALHOU: ' || sqlerrm)
    on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $ctrl$;
