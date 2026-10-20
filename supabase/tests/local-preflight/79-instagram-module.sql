-- 79: pré-voo do módulo Instagram (Fase 1), ordinais 7901–7999.
--
-- Task 1.1 (migration 20261020120000_instagram_module_grants.sql):
--   casos IG-1.1..IG-1.6 (7901–7906) e um controle positivo por caso,
--   C-IG-1.1..C-IG-1.6 (7908–7913). 7907, 7914 e 7915 ficam livres.
--   Tasks seguintes: 7920+, 7940+, 7960+, 7980+.
--
-- BASE (banco próprio `ig79`, README seção 79):
--   00 -> 01 -> 09a -> 106 -> 79a -> [migrations do Instagram] -> 79.
-- Os casos usam a identidade real: `set local role authenticated` +
-- `request.jwt.claims` com `sub` e `role`. RLS de produção nas tabelas novas
-- (forçada) e em `unit_members` (79a).
--
-- RED: sem a migration, a guarda abaixo aborta (exit 3).
-- Cada caso é uma função `pg_temp.ig79_case_*()` que monta o que precisa,
-- mede e desfaz tudo por rollback de subtransação, devolvendo 'PASSOU' ou
-- 'FALHOU …'. Os controles positivos chamam a MESMA função sob sabotagem (num
-- subbloco desfeito), exigem 'FALHOU', e depois exigem 'PASSOU' de novo com o
-- objeto real conferido contra o catálogo. Nada sobra no banco: o arquivo é
-- re-executável no mesmo banco, depois de cada reaplicação da migration.

\set ON_ERROR_STOP on

create table if not exists t_res (ord int primary key, caso text, veredito text);
delete from t_res where ord between 7901 and 7999;

do $$
begin
  if to_regclass('public.unit_module_grants') is null
     or to_regclass('public.instagram_settings') is null
     or to_regprocedure('public.set_unit_module_grant(uuid,text,boolean)') is null
     or to_regprocedure('public.get_unit_modules(uuid)') is null
     or to_regprocedure('public.unit_module_tenant_guard()') is null
     or to_regprocedure('public.instagram_settings_touch()') is null then
    raise exception '79: objetos do modulo Instagram ausentes (unit_module_grants, instagram_settings, set_unit_module_grant, get_unit_modules). Aplique a migration 20261020120000_instagram_module_grants antes (sem ela, este abort e o RED esperado).';
  end if;
  if not exists (select 1 from public.units where id = 'a0d79000-0000-4000-8000-0000000000aa')
     or not exists (select 1 from public.platform_admins where user_id = 'a0d79000-0000-4000-8000-0000000000c1') then
    raise exception '79 exige o 79a (fixtures a0d79000-...).';
  end if;
end $$;

-- ─── Helpers ─────────────────────────────────────────────────────────────────
-- Executa p_sql como (p_role, p_sub) e devolve a primeira coluna da primeira
-- linha como texto ('<null>' se nula), ou 'ERR SQLSTATE:mensagem'.
-- p_role nulo = o próprio postgres, sem claims (como `db push`/superusuário).
create or replace function pg_temp.ig79_q(p_role text, p_sub uuid, p_sql text)
returns text language plpgsql as $$
declare v text;
begin
  perform set_config('request.jwt.claims',
    case when p_role is null then ''
         else jsonb_strip_nulls(jsonb_build_object('sub', p_sub, 'role', p_role))::text end,
    true);
  begin
    if p_role is not null then execute format('set local role %I', p_role); end if;
    execute p_sql into v;
    reset role;
    perform set_config('request.jwt.claims', '', true);
    return coalesce(v, '<null>');
  exception when others then
    reset role;
    perform set_config('request.jwt.claims', '', true);
    return 'ERR ' || sqlstate || ':' || sqlerrm;
  end;
end $$;

-- SQL que chama set_unit_module_grant e devolve 'modulo/ativo/tem_granted_at/tem_revoked_at'.
create or replace function pg_temp.ig79_set(p_unit uuid, p_active boolean)
returns text language sql as $$
  select format('select string_agg(module || ''/'' || active || ''/'' || (granted_at is not null) || ''/'' || (revoked_at is not null), '','') '
                'from public.set_unit_module_grant(%L::uuid, ''instagram'', %L::boolean)', p_unit, p_active)
$$;

-- SQL que chama get_unit_modules e devolve 'modulo/ativo/tem_granted_at'.
create or replace function pg_temp.ig79_get(p_unit uuid)
returns text language sql as $$
  select format('select string_agg(module || ''/'' || active || ''/'' || (granted_at is not null), '','' order by module) '
                'from public.get_unit_modules(%L::uuid)', p_unit)
$$;

-- SQL de UPDATE de dm_enabled que devolve quantas linhas casou.
create or replace function pg_temp.ig79_upd(p_unit uuid, p_val boolean)
returns text language sql as $$
  select format('with u as (update public.instagram_settings set dm_enabled = %L::boolean '
                'where unit_id = %L::uuid returning 1) select count(*)::text from u', p_val, p_unit)
$$;

-- ─── IG-1.1: só platform_admin concede ───────────────────────────────────────
-- Owner da unidade, gerente e authenticated sem `sub` recebem 42501 e nada é
-- gravado. platform_admin SEM membership concede: active=true, granted_by é
-- ele, organização tirada de `units`, e a linha de instagram_settings nasce
-- com dm_enabled=false.
create or replace function pg_temp.ig79_case_11() returns text language plpgsql as $f$
declare
  ua constant uuid := 'a0d79000-0000-4000-8000-0000000000aa';
  org_a constant uuid := 'a0d79000-0000-4000-8000-00000000000a';
  owner_a constant uuid := 'a0d79000-0000-4000-8000-0000000000a1';
  ger_a constant uuid := 'a0d79000-0000-4000-8000-0000000000a2';
  pa constant uuid := 'a0d79000-0000-4000-8000-0000000000c1';
  f constant text := 'ERR 42501:module_grant_forbidden';
  a text; b text; c text; n0 int; g text; d text; s text;
begin
  begin
    a := pg_temp.ig79_q('authenticated', owner_a, pg_temp.ig79_set(ua, true));
    b := pg_temp.ig79_q('authenticated', ger_a, pg_temp.ig79_set(ua, true));
    c := pg_temp.ig79_q('authenticated', null, pg_temp.ig79_set(ua, true));
    select count(*) into n0 from public.unit_module_grants where unit_id = ua;
    g := pg_temp.ig79_q('authenticated', pa, pg_temp.ig79_set(ua, true));
    select coalesce(string_agg(organization_id::text || '|' || granted_by::text || '|' || (revoked_at is null), ','), '<nenhum>')
      into d from public.unit_module_grants where unit_id = ua;
    select coalesce(string_agg(organization_id::text || '|' || dm_enabled, ','), '<nenhuma>')
      into s from public.instagram_settings where unit_id = ua;
    raise exception using errcode = 'P0R79', message =
      case when a = f and b = f and c = f and n0 = 0
            and g = 'instagram/true/true/false'
            and d = org_a || '|' || pa || '|true'
            and s = org_a || '|false' then 'PASSOU'
           else 'FALHOU owner=' || a || ' gerente=' || b || ' sem_sub=' || c || ' linhas_antes=' || n0
                || ' pa=' || g || ' grant=' || d || ' settings=' || s end;
  exception
    when sqlstate 'P0R79' then return sqlerrm;
    when others then return 'FALHOU erro inesperado ' || sqlstate || ':' || sqlerrm;
  end;
end $f$;

-- ─── IG-1.2: idempotência nos dois sentidos ─────────────────────────────────
-- Conceder duas vezes deixa UMA linha ativa e um INSERT no audit_log. Revogar
-- grava revoked_at e revoked_by = auth.uid(); revogar de novo não grava nada
-- (um UPDATE no audit_log). Conceder depois da revogação abre uma linha nova
-- e preserva o histórico.
create or replace function pg_temp.ig79_case_12() returns text language plpgsql as $f$
declare
  ua constant uuid := 'a0d79000-0000-4000-8000-0000000000aa';
  pa constant uuid := 'a0d79000-0000-4000-8000-0000000000c1';
  g1 text; g2 text; r1 text; r2 text; g3 text;
  n_ativos_1 int; n_total_1 int; n_ins_1 int;
  rev text; n_upd_2 int; n_total_2 int;
  n_ativos_3 int; n_total_3 int;
  a0 bigint;
begin
  begin
    select coalesce(max(id), 0) into a0 from public.audit_log;
    g1 := pg_temp.ig79_q('authenticated', pa, pg_temp.ig79_set(ua, true));
    g2 := pg_temp.ig79_q('authenticated', pa, pg_temp.ig79_set(ua, true));
    select count(*) filter (where revoked_at is null), count(*) into n_ativos_1, n_total_1
      from public.unit_module_grants where unit_id = ua;
    select count(*) into n_ins_1 from public.audit_log
     where id > a0 and table_name = 'unit_module_grants' and action = 'INSERT';

    r1 := pg_temp.ig79_q('authenticated', pa, pg_temp.ig79_set(ua, false));
    r2 := pg_temp.ig79_q('authenticated', pa, pg_temp.ig79_set(ua, false));
    select coalesce(string_agg((revoked_at is not null) || '|' || coalesce(revoked_by::text, '<null>'), ','), '<nenhum>'),
           count(*)
      into rev, n_total_2 from public.unit_module_grants where unit_id = ua;
    select count(*) into n_upd_2 from public.audit_log
     where id > a0 and table_name = 'unit_module_grants' and action = 'UPDATE';

    g3 := pg_temp.ig79_q('authenticated', pa, pg_temp.ig79_set(ua, true));
    select count(*) filter (where revoked_at is null), count(*) into n_ativos_3, n_total_3
      from public.unit_module_grants where unit_id = ua;

    raise exception using errcode = 'P0R79', message =
      case when g1 = 'instagram/true/true/false' and g2 = g1 and n_ativos_1 = 1 and n_total_1 = 1 and n_ins_1 = 1
            and r1 = 'instagram/false/true/true' and r2 = r1
            and rev = 'true|' || pa and n_total_2 = 1 and n_upd_2 = 1
            and g3 = 'instagram/true/true/false' and n_ativos_3 = 1 and n_total_3 = 2 then 'PASSOU'
           else 'FALHOU g1=' || g1 || ' g2=' || g2 || ' ativos/total=' || n_ativos_1 || '/' || n_total_1
                || ' audit_ins=' || n_ins_1 || ' r1=' || r1 || ' r2=' || r2 || ' revogado=' || rev
                || ' total=' || n_total_2 || ' audit_upd=' || n_upd_2
                || ' g3=' || g3 || ' ativos/total=' || n_ativos_3 || '/' || n_total_3 end;
  exception
    when sqlstate 'P0R79' then return sqlerrm;
    when others then return 'FALHOU erro inesperado ' || sqlstate || ':' || sqlerrm;
  end;
end $f$;

-- ─── IG-1.3: get_unit_modules por tenant ─────────────────────────────────────
-- Com UA concedida: membro de A (owner) chamando B recebe 42501, e a mesma
-- recusa vale para unidade inexistente (sem oráculo) e para authenticated sem
-- `sub`. Membro de A (operador) lê A ativo; gerente de B lê B inativo (linha
-- do catálogo); platform_admin sem membership lê B.
create or replace function pg_temp.ig79_case_13() returns text language plpgsql as $f$
declare
  ua constant uuid := 'a0d79000-0000-4000-8000-0000000000aa';
  ub constant uuid := 'a0d79000-0000-4000-8000-0000000000bb';
  ghost constant uuid := 'a0d79000-0000-4000-8000-0000000000ff';
  owner_a constant uuid := 'a0d79000-0000-4000-8000-0000000000a1';
  op_a constant uuid := 'a0d79000-0000-4000-8000-0000000000a3';
  ger_b constant uuid := 'a0d79000-0000-4000-8000-0000000000b2';
  pa constant uuid := 'a0d79000-0000-4000-8000-0000000000c1';
  f constant text := 'ERR 42501:module_read_forbidden';
  s text; a text; b text; c text; d text; e text; n text;
begin
  begin
    s := pg_temp.ig79_q('authenticated', pa, pg_temp.ig79_set(ua, true));
    a := pg_temp.ig79_q('authenticated', owner_a, pg_temp.ig79_get(ub));
    d := pg_temp.ig79_q('authenticated', owner_a, pg_temp.ig79_get(ghost));
    n := pg_temp.ig79_q('authenticated', null, pg_temp.ig79_get(ua));
    b := pg_temp.ig79_q('authenticated', op_a, pg_temp.ig79_get(ua));
    c := pg_temp.ig79_q('authenticated', ger_b, pg_temp.ig79_get(ub));
    e := pg_temp.ig79_q('authenticated', pa, pg_temp.ig79_get(ub));
    raise exception using errcode = 'P0R79', message =
      case when s = 'instagram/true/true/false'
            and a = f and d = f and n = f
            and b = 'instagram/true/true'
            and c = 'instagram/false/false'
            and e = 'instagram/false/false' then 'PASSOU'
           else 'FALHOU setup=' || s || ' A->B=' || a || ' A->inexistente=' || d || ' sem_sub=' || n
                || ' op_A->A=' || b || ' ger_B->B=' || c || ' pa->B=' || e end;
  exception
    when sqlstate 'P0R79' then return sqlerrm;
    when others then return 'FALHOU erro inesperado ' || sqlstate || ':' || sqlerrm;
  end;
end $f$;

-- ─── IG-1.4: instagram_settings por papel e tenant ──────────────────────────
-- Com UA e UB concedidas: operador de A atualiza dm_enabled e casa zero
-- linhas (valor fica false); gerente de B não alcança A; gerente de A muda
-- para true (updated_by = ele); platform_admin sem membership volta para false
-- (updated_by = ele). Membro de A não lê o de B e lê o de A.
create or replace function pg_temp.ig79_case_14() returns text language plpgsql as $f$
declare
  ua constant uuid := 'a0d79000-0000-4000-8000-0000000000aa';
  ub constant uuid := 'a0d79000-0000-4000-8000-0000000000bb';
  op_a constant uuid := 'a0d79000-0000-4000-8000-0000000000a3';
  ger_a constant uuid := 'a0d79000-0000-4000-8000-0000000000a2';
  ger_b constant uuid := 'a0d79000-0000-4000-8000-0000000000b2';
  pa constant uuid := 'a0d79000-0000-4000-8000-0000000000c1';
  s1 text; s2 text; op text; v_op text; gb text; v_gb text; ga text; v_ga text; p text; v_p text;
  r_ab text; r_aa text; r_tudo text;
begin
  begin
    s1 := pg_temp.ig79_q('authenticated', pa, pg_temp.ig79_set(ua, true));
    s2 := pg_temp.ig79_q('authenticated', pa, pg_temp.ig79_set(ub, true));

    op := pg_temp.ig79_q('authenticated', op_a, pg_temp.ig79_upd(ua, true));
    select dm_enabled::text into v_op from public.instagram_settings where unit_id = ua;

    gb := pg_temp.ig79_q('authenticated', ger_b, pg_temp.ig79_upd(ua, true));
    select dm_enabled::text into v_gb from public.instagram_settings where unit_id = ua;

    ga := pg_temp.ig79_q('authenticated', ger_a, pg_temp.ig79_upd(ua, true));
    select dm_enabled || '|' || coalesce(updated_by::text, '<null>') into v_ga
      from public.instagram_settings where unit_id = ua;

    p := pg_temp.ig79_q('authenticated', pa, pg_temp.ig79_upd(ua, false));
    select dm_enabled || '|' || coalesce(updated_by::text, '<null>') into v_p
      from public.instagram_settings where unit_id = ua;

    r_ab := pg_temp.ig79_q('authenticated', op_a,
      format('select count(*)::text from public.instagram_settings where unit_id = %L::uuid', ub));
    r_aa := pg_temp.ig79_q('authenticated', op_a,
      format('select count(*)::text from public.instagram_settings where unit_id = %L::uuid', ua));
    r_tudo := pg_temp.ig79_q('authenticated', ger_a, 'select count(*)::text from public.instagram_settings');

    raise exception using errcode = 'P0R79', message =
      case when s1 = 'instagram/true/true/false' and s2 = s1
            and op = '0' and v_op = 'false'
            and gb = '0' and v_gb = 'false'
            and ga = '1' and v_ga = 'true|' || ger_a
            and p = '1' and v_p = 'false|' || pa
            and r_ab = '0' and r_aa = '1' and r_tudo = '1' then 'PASSOU'
           else 'FALHOU setup=' || s1 || '/' || s2 || ' operador=' || op || '->' || v_op
                || ' gerente_B=' || gb || '->' || v_gb || ' gerente_A=' || ga || '->' || v_ga
                || ' pa=' || p || '->' || coalesce(v_p, '<null>')
                || ' op_A_le_B=' || r_ab || ' op_A_le_A=' || r_aa || ' ger_A_le_tudo=' || r_tudo end;
  exception
    when sqlstate 'P0R79' then return sqlerrm;
    when others then return 'FALHOU erro inesperado ' || sqlstate || ':' || sqlerrm;
  end;
end $f$;

-- ─── IG-1.5: ACL e postura de RLS ────────────────────────────────────────────
-- anon sem EXECUTE nas duas RPCs; authenticated com EXECUTE; PUBLIC fora do
-- proacl; trigger functions sem EXECUTE para anon/authenticated.
-- instagram_settings: authenticated só SELECT e UPDATE(dm_enabled), sem
-- INSERT/DELETE/TRUNCATE nem UPDATE de outra coluna; anon sem nada.
-- unit_module_grants: anon e authenticated sem privilégio algum (tabela e
-- coluna). As duas com RLS forçada; unit_module_grants sem policy.
create or replace function pg_temp.ig79_case_15() returns text language plpgsql as $f$
declare
  ruins text := '';
  fn text;
  r text;
begin
  begin
    foreach fn in array array['public.set_unit_module_grant(uuid,text,boolean)', 'public.get_unit_modules(uuid)'] loop
      if has_function_privilege('anon', fn, 'EXECUTE') then ruins := ruins || ' anon_exec:' || fn; end if;
      if not has_function_privilege('authenticated', fn, 'EXECUTE') then ruins := ruins || ' auth_sem_exec:' || fn; end if;
      if exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                  where p.oid = fn::regprocedure and a.grantee = 0) then
        ruins := ruins || ' public_exec:' || fn;
      end if;
    end loop;
    foreach fn in array array['public.unit_module_tenant_guard()', 'public.instagram_settings_touch()'] loop
      foreach r in array array['anon', 'authenticated'] loop
        if has_function_privilege(r, fn, 'EXECUTE') then ruins := ruins || ' ' || r || '_exec:' || fn; end if;
      end loop;
    end loop;

    if not has_table_privilege('authenticated', 'public.instagram_settings', 'SELECT') then ruins := ruins || ' auth_sem_select_settings'; end if;
    if has_table_privilege('authenticated', 'public.instagram_settings', 'INSERT') then ruins := ruins || ' auth_insert_settings'; end if;
    if has_table_privilege('authenticated', 'public.instagram_settings', 'DELETE') then ruins := ruins || ' auth_delete_settings'; end if;
    if has_table_privilege('authenticated', 'public.instagram_settings', 'TRUNCATE') then ruins := ruins || ' auth_truncate_settings'; end if;
    if has_table_privilege('authenticated', 'public.instagram_settings', 'UPDATE') then ruins := ruins || ' auth_update_tabela_settings'; end if;
    if has_any_column_privilege('authenticated', 'public.instagram_settings', 'INSERT') then ruins := ruins || ' auth_insert_coluna_settings'; end if;
    if not has_column_privilege('authenticated', 'public.instagram_settings', 'dm_enabled', 'UPDATE') then ruins := ruins || ' auth_sem_update_dm_enabled'; end if;
    foreach r in array array['unit_id', 'organization_id', 'updated_by', 'updated_at'] loop
      if has_column_privilege('authenticated', 'public.instagram_settings', r, 'UPDATE') then ruins := ruins || ' auth_update_' || r; end if;
    end loop;
    if has_table_privilege('anon', 'public.instagram_settings', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       or has_any_column_privilege('anon', 'public.instagram_settings', 'SELECT,INSERT,UPDATE,REFERENCES') then
      ruins := ruins || ' anon_settings';
    end if;

    foreach r in array array['anon', 'authenticated'] loop
      if has_table_privilege(r, 'public.unit_module_grants', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         or has_any_column_privilege(r, 'public.unit_module_grants', 'SELECT,INSERT,UPDATE,REFERENCES') then
        ruins := ruins || ' ' || r || '_grants';
      end if;
    end loop;

    if not (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.unit_module_grants'::regclass) then
      ruins := ruins || ' grants_sem_force_rls';
    end if;
    if not (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.instagram_settings'::regclass) then
      ruins := ruins || ' settings_sem_force_rls';
    end if;
    if exists (select 1 from pg_policy where polrelid = 'public.unit_module_grants'::regclass) then
      ruins := ruins || ' grants_com_policy';
    end if;

    raise exception using errcode = 'P0R79', message =
      case when ruins = '' then 'PASSOU' else 'FALHOU' || ruins end;
  exception
    when sqlstate 'P0R79' then return sqlerrm;
    when others then return 'FALHOU erro inesperado ' || sqlstate || ':' || sqlerrm;
  end;
end $f$;

-- ─── IG-1.6: coerência de tenant e vínculos imutáveis ───────────────────────
-- Gravando como postgres (superusuário, sem RLS), o guard é a única barreira:
-- grant com organização de outra unidade, grant para unidade inexistente,
-- mover um grant de unidade, settings com organização errada e mover settings
-- de unidade são recusados com 23514.
create or replace function pg_temp.ig79_case_16() returns text language plpgsql as $f$
declare
  ua constant uuid := 'a0d79000-0000-4000-8000-0000000000aa';
  ub constant uuid := 'a0d79000-0000-4000-8000-0000000000bb';
  ghost constant uuid := 'a0d79000-0000-4000-8000-0000000000ff';
  org_a constant uuid := 'a0d79000-0000-4000-8000-00000000000a';
  org_b constant uuid := 'a0d79000-0000-4000-8000-00000000000b';
  pa constant uuid := 'a0d79000-0000-4000-8000-0000000000c1';
  a text; b text; c text; d text; e text; ok1 text; ok2 text;
begin
  begin
    a := pg_temp.ig79_q(null, null, format(
      'with i as (insert into public.unit_module_grants (organization_id, unit_id, module, granted_by) '
      'values (%L, %L, ''instagram'', %L) returning 1) select count(*)::text from i', org_b, ua, pa));
    b := pg_temp.ig79_q(null, null, format(
      'with i as (insert into public.unit_module_grants (organization_id, unit_id, module, granted_by) '
      'values (%L, %L, ''instagram'', %L) returning 1) select count(*)::text from i', org_a, ghost, pa));
    ok1 := pg_temp.ig79_q(null, null, format(
      'with i as (insert into public.unit_module_grants (organization_id, unit_id, module, granted_by) '
      'values (%L, %L, ''instagram'', %L) returning 1) select count(*)::text from i', org_a, ua, pa));
    c := pg_temp.ig79_q(null, null, format(
      'with u as (update public.unit_module_grants set unit_id = %L, organization_id = %L '
      'where unit_id = %L returning 1) select count(*)::text from u', ub, org_b, ua));
    d := pg_temp.ig79_q(null, null, format(
      'with i as (insert into public.instagram_settings (unit_id, organization_id) values (%L, %L) returning 1) '
      'select count(*)::text from i', ua, org_b));
    ok2 := pg_temp.ig79_q(null, null, format(
      'with i as (insert into public.instagram_settings (unit_id, organization_id) values (%L, %L) returning 1) '
      'select count(*)::text from i', ua, org_a));
    e := pg_temp.ig79_q(null, null, format(
      'with u as (update public.instagram_settings set unit_id = %L where unit_id = %L returning 1) '
      'select count(*)::text from u', ub, ua));
    raise exception using errcode = 'P0R79', message =
      case when a like 'ERR 23514:unit_module_grants: organizacao % nao e a da unidade %'
            and b like 'ERR 23514:unit_module_grants: unidade % inexistente'
            and ok1 = '1'
            and c = 'ERR 23514:unit_module_grants: organizacao e unidade sao imutaveis'
            and d like 'ERR 23514:instagram_settings: organizacao % nao e a da unidade %'
            and ok2 = '1'
            and e like 'ERR 23514:instagram_settings: unidade e organizacao sao imutaveis%' then 'PASSOU'
           else 'FALHOU org_errada=' || a || ' unidade_inexistente=' || b || ' valido=' || ok1
                || ' mover_grant=' || c || ' settings_org_errada=' || d || ' settings_valido=' || ok2
                || ' mover_settings=' || e end;
  exception
    when sqlstate 'P0R79' then return sqlerrm;
    when others then return 'FALHOU erro inesperado ' || sqlstate || ':' || sqlerrm;
  end;
end $f$;

-- ─── Casos ───────────────────────────────────────────────────────────────────
insert into t_res values
  (7901, 'IG-1.1 owner/gerente/sem sub recebem 42501 sem gravar; platform_admin sem membership concede (active=true, granted_by, org de units, settings dm_enabled=false)', pg_temp.ig79_case_11()),
  (7902, 'IG-1.2 conceder 2x deixa 1 ativa e 1 INSERT auditado; revogar grava revoked_at/revoked_by=auth.uid(); revogar 2x nao regrava; reconceder abre linha nova', pg_temp.ig79_case_12()),
  (7903, 'IG-1.3 get_unit_modules: membro de A em B, unidade inexistente e sem sub recebem o mesmo 42501; membro le A; gerente B le B inativo; platform_admin le B', pg_temp.ig79_case_13()),
  (7904, 'IG-1.4 instagram_settings: operador e gerente de B casam 0 linhas (valor false); gerente A e platform_admin mudam (updated_by carimbado); membro de A nao le B', pg_temp.ig79_case_14()),
  (7905, 'IG-1.5 ACL: anon sem EXECUTE nas RPCs, PUBLIC fora; authenticated so SELECT + UPDATE(dm_enabled) em settings e nada em grants; FORCE RLS; grants sem policy', pg_temp.ig79_case_15()),
  (7906, 'IG-1.6 guard de tenant: org errada, unidade inexistente e mover grant/settings recusados com 23514', pg_temp.ig79_case_16());

-- ─── Controles positivos ─────────────────────────────────────────────────────
-- Cada sabotagem roda num subbloco desfeito por raise (DDL é transacional) e
-- tem de fazer o caso reprovar. Mutação de corpo parte de pg_get_functiondef +
-- replace e reprova o controle se o trecho não existir. Depois do subbloco o
-- caso tem de passar de novo e o objeto real tem de estar intacto.

-- C-IG-1.1: guarda de set_unit_module_grant trocada por `true` (nunca recusa).
do $$
declare
  v_def text; v_mut text; s1 text; d text;
begin
  v_def := pg_get_functiondef('public.set_unit_module_grant(uuid,text,boolean)'::regprocedure);
  begin
    v_mut := replace(v_def, 'if v_uid is null or not app_private.is_platform_admin(v_uid) then', 'if false then');
    if v_mut = v_def then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_11();
  exception
    when sqlstate 'P0R79' then s1 := sqlerrm;
    when others then s1 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  d := pg_temp.ig79_case_11();
  raise notice 'C-IG-1.1 sabotado: %', s1;
  insert into t_res values (7908, 'C-IG-1.1 guarda platform_admin de set_unit_module_grant trocada por true: IG-1.1 reprova; restaurada passa',
    case when s1 like 'FALHOU%' and d = 'PASSOU'
          and pg_get_functiondef('public.set_unit_module_grant(uuid,text,boolean)'::regprocedure) = v_def then 'PASSOU'
         else 'FALHOU sabotado=' || s1 || ' restaurado=' || d end);
end $$;

-- C-IG-1.2: (a) sem o índice único parcial, conceder 2x abre duas linhas;
-- (b) revoked_by gravado com outro valor que não auth.uid().
do $$
declare
  v_def text; v_mut text; s1 text; s2 text; d text; v_idx int;
begin
  v_def := pg_get_functiondef('public.set_unit_module_grant(uuid,text,boolean)'::regprocedure);
  begin
    drop index public.unit_module_grants_one_active_idx;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_12();
  exception
    when sqlstate 'P0R79' then s1 := sqlerrm;
    when others then s1 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    v_mut := replace(v_def, 'set revoked_at = now(), revoked_by = v_uid', 'set revoked_at = now(), revoked_by = p_unit_id');
    if v_mut = v_def then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_12();
  exception
    when sqlstate 'P0R79' then s2 := sqlerrm;
    when others then s2 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  d := pg_temp.ig79_case_12();
  raise notice 'C-IG-1.2 sem indice: %', s1;
  raise notice 'C-IG-1.2 revoked_by: %', s2;
  select count(*) into v_idx from pg_indexes
   where schemaname = 'public' and indexname = 'unit_module_grants_one_active_idx';
  insert into t_res values (7909, 'C-IG-1.2 sem o indice unico parcial e com revoked_by fora de auth.uid(): IG-1.2 reprova nos dois; restaurado passa',
    case when s1 like 'FALHOU%' and s2 like 'FALHOU%' and d = 'PASSOU' and v_idx = 1
          and pg_get_functiondef('public.set_unit_module_grant(uuid,text,boolean)'::regprocedure) = v_def then 'PASSOU'
         else 'FALHOU sem_indice=' || s1 || ' revoked_by=' || s2 || ' restaurado=' || d || ' indice=' || v_idx end);
end $$;

-- C-IG-1.3: guarda de get_unit_modules sem a perna de membership/admin.
do $$
declare
  v_def text; v_mut text; s1 text; d text;
begin
  v_def := pg_get_functiondef('public.get_unit_modules(uuid)'::regprocedure);
  begin
    v_mut := replace(v_def,
      'or not (app_private.is_unit_member(v_uid, p_unit_id) or app_private.is_platform_admin(v_uid))', '');
    if v_mut = v_def then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_13();
  exception
    when sqlstate 'P0R79' then s1 := sqlerrm;
    when others then s1 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  d := pg_temp.ig79_case_13();
  raise notice 'C-IG-1.3 sabotado: %', s1;
  insert into t_res values (7910, 'C-IG-1.3 get_unit_modules sem a guarda de membro/admin: IG-1.3 reprova (A le B); restaurada passa',
    case when s1 like 'FALHOU%' and d = 'PASSOU'
          and pg_get_functiondef('public.get_unit_modules(uuid)'::regprocedure) = v_def then 'PASSOU'
         else 'FALHOU sabotado=' || s1 || ' restaurado=' || d end);
end $$;

-- C-IG-1.4: (a) policy de UPDATE sem o filtro de papel (todo membro escreve);
-- (b) policy de SELECT aberta (`true`); (c) sem o trigger de carimbo.
do $$
declare
  s1 text; s2 text; s3 text; d text; v_pol text; v_trg int;
  v_pol0 text;
begin
  select string_agg(polname || ':' || pg_get_expr(polqual, polrelid) || ':' || coalesce(pg_get_expr(polwithcheck, polrelid), ''), ';' order by polname)
    into v_pol0 from pg_policy where polrelid = 'public.instagram_settings'::regclass;
  begin
    drop policy instagram_settings_update on public.instagram_settings;
    create policy instagram_settings_update on public.instagram_settings for update to authenticated
      using (app_private.is_unit_member(auth.uid(), unit_id) or app_private.is_platform_admin(auth.uid()))
      with check (app_private.is_unit_member(auth.uid(), unit_id) or app_private.is_platform_admin(auth.uid()));
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_14();
  exception
    when sqlstate 'P0R79' then s1 := sqlerrm;
    when others then s1 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    drop policy instagram_settings_select on public.instagram_settings;
    create policy instagram_settings_select on public.instagram_settings for select to authenticated using (true);
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_14();
  exception
    when sqlstate 'P0R79' then s2 := sqlerrm;
    when others then s2 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    drop trigger instagram_settings_touch_trg on public.instagram_settings;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_14();
  exception
    when sqlstate 'P0R79' then s3 := sqlerrm;
    when others then s3 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  d := pg_temp.ig79_case_14();
  raise notice 'C-IG-1.4 update sem papel: %', s1;
  raise notice 'C-IG-1.4 select aberto: %', s2;
  raise notice 'C-IG-1.4 sem carimbo: %', s3;
  select string_agg(polname || ':' || pg_get_expr(polqual, polrelid) || ':' || coalesce(pg_get_expr(polwithcheck, polrelid), ''), ';' order by polname)
    into v_pol from pg_policy where polrelid = 'public.instagram_settings'::regclass;
  select count(*) into v_trg from pg_trigger
   where tgrelid = 'public.instagram_settings'::regclass and tgname = 'instagram_settings_touch_trg';
  insert into t_res values (7911, 'C-IG-1.4 policy UPDATE sem papel, policy SELECT aberta e sem trigger de carimbo: IG-1.4 reprova nos tres; restaurado passa',
    case when s1 like 'FALHOU%' and s2 like 'FALHOU%' and s3 like 'FALHOU%' and d = 'PASSOU'
          and v_pol = v_pol0 and v_trg = 1 then 'PASSOU'
         else 'FALHOU update_sem_papel=' || s1 || ' select_aberto=' || s2 || ' sem_carimbo=' || s3
              || ' restaurado=' || d || ' policies_intactas=' || (v_pol = v_pol0) || ' trigger=' || v_trg end);
end $$;

-- C-IG-1.5: (a) EXECUTE de get_unit_modules para anon; (b) INSERT em
-- instagram_settings para authenticated; (c) SELECT em unit_module_grants para
-- authenticated; (d) unit_module_grants sem FORCE RLS.
do $$
declare
  s1 text; s2 text; s3 text; s4 text; d text;
begin
  begin
    grant execute on function public.get_unit_modules(uuid) to anon;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_15();
  exception
    when sqlstate 'P0R79' then s1 := sqlerrm;
    when others then s1 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    grant insert on public.instagram_settings to authenticated;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_15();
  exception
    when sqlstate 'P0R79' then s2 := sqlerrm;
    when others then s2 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    grant select on public.unit_module_grants to authenticated;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_15();
  exception
    when sqlstate 'P0R79' then s3 := sqlerrm;
    when others then s3 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    alter table public.unit_module_grants no force row level security;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_15();
  exception
    when sqlstate 'P0R79' then s4 := sqlerrm;
    when others then s4 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  d := pg_temp.ig79_case_15();
  raise notice 'C-IG-1.5 anon exec: %', s1;
  raise notice 'C-IG-1.5 insert settings: %', s2;
  raise notice 'C-IG-1.5 select grants: %', s3;
  raise notice 'C-IG-1.5 sem force: %', s4;
  insert into t_res values (7912, 'C-IG-1.5 anon com EXECUTE, authenticated com INSERT em settings, SELECT em grants e grants sem FORCE RLS: IG-1.5 reprova nos quatro; restaurado passa',
    case when s1 like 'FALHOU%anon_exec:public.get_unit_modules(uuid)%'
          and s2 like 'FALHOU%auth_insert_settings%'
          and s3 like 'FALHOU%authenticated_grants%'
          and s4 like 'FALHOU%grants_sem_force_rls%'
          and d = 'PASSOU' then 'PASSOU'
         else 'FALHOU anon_exec=' || s1 || ' insert=' || s2 || ' select_grants=' || s3 || ' sem_force=' || s4
              || ' restaurado=' || d end);
end $$;

-- C-IG-1.6: (a) guard sem a checagem de coerência; (b) guard sem a
-- imutabilidade do UPDATE; (c) carimbo sem congelar unit_id.
do $$
declare
  v_guard text; v_touch text; v_mut text; s1 text; s2 text; s3 text; d text;
begin
  v_guard := pg_get_functiondef('public.unit_module_tenant_guard()'::regprocedure);
  v_touch := pg_get_functiondef('public.instagram_settings_touch()'::regprocedure);
  begin
    v_mut := replace(v_guard, 'if new.organization_id is distinct from v_unit_org then', 'if false then');
    if v_mut = v_guard then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_16();
  exception
    when sqlstate 'P0R79' then s1 := sqlerrm;
    when others then s1 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    v_mut := replace(v_guard, 'if tg_op = ''UPDATE''', 'if false');
    if v_mut = v_guard then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_16();
  exception
    when sqlstate 'P0R79' then s2 := sqlerrm;
    when others then s2 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    v_mut := replace(v_touch, 'if new.unit_id is distinct from old.unit_id', 'if false and new.unit_id is distinct from old.unit_id');
    if v_mut = v_touch then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_16();
  exception
    when sqlstate 'P0R79' then s3 := sqlerrm;
    when others then s3 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  d := pg_temp.ig79_case_16();
  raise notice 'C-IG-1.6 sem coerencia: %', s1;
  raise notice 'C-IG-1.6 sem imutabilidade: %', s2;
  raise notice 'C-IG-1.6 sem congelar: %', s3;
  insert into t_res values (7913, 'C-IG-1.6 guard sem coerencia, guard sem imutabilidade e carimbo sem congelar unit_id: IG-1.6 reprova nos tres; restaurado passa',
    case when s1 like 'FALHOU%' and s2 like 'FALHOU%' and s3 like 'FALHOU%' and d = 'PASSOU'
          and pg_get_functiondef('public.unit_module_tenant_guard()'::regprocedure) = v_guard
          and pg_get_functiondef('public.instagram_settings_touch()'::regprocedure) = v_touch then 'PASSOU'
         else 'FALHOU sem_coerencia=' || s1 || ' sem_imutabilidade=' || s2 || ' sem_congelar=' || s3
              || ' restaurado=' || d end);
end $$;

-- ─── Resultado ───────────────────────────────────────────────────────────────
select ord, caso, veredito from t_res where ord between 7901 and 7999 order by ord;
select count(*) as total, count(*) filter (where veredito = 'PASSOU') as passou
  from t_res where ord between 7901 and 7999;   -- esperado: 12 e 12

do $$
declare v_total int; v_ok int;
begin
  select count(*), count(*) filter (where veredito = 'PASSOU') into v_total, v_ok
    from t_res where ord between 7901 and 7999;
  if v_total <> 12 or v_ok <> 12 then
    raise exception '79: esperado 12 e 12, obtido % e %', v_total, v_ok;
  end if;
end $$;
