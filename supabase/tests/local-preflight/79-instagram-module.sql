-- 79: pré-voo do módulo Instagram (Fase 1), ordinais 7901–7999.
--
-- Task 1.1 (migration 20261020120000_instagram_module_grants.sql):
--   casos IG-1.1..IG-1.6 (7901–7906) e um controle positivo por caso,
--   C-IG-1.1..C-IG-1.6 (7908–7913). 7907, 7914 e 7915 ficam livres.
-- Task 1.2 (migration 20261020120100_instagram_accounts_contacts.sql):
--   casos IG-2.1..IG-2.6 (7920–7925) e um controle positivo por caso,
--   C-IG-2.1..C-IG-2.6 (7930–7935). 7926–7929 e 7936–7939 ficam livres.
--   Tasks seguintes: 7940+, 7960+, 7980+.
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
  if to_regclass('public.instagram_accounts') is null
     or to_regclass('public.instagram_contacts') is null
     or to_regclass('public.instagram_contact_reservations') is null
     or to_regprocedure('public.store_instagram_account_connection(uuid,text,text,text,text,timestamptz,uuid)') is null
     or to_regprocedure('public.get_instagram_account_token(uuid)') is null
     or to_regprocedure('public.record_instagram_account_subscription(uuid,text[])') is null
     or to_regprocedure('public.record_instagram_token_refresh(uuid,text,timestamptz)') is null
     or to_regprocedure('public.set_instagram_account_status(uuid,text,text)') is null
     or to_regprocedure('public.disconnect_instagram_account(uuid,uuid)') is null
     or to_regprocedure('public.get_instagram_account_status(uuid)') is null
     or to_regprocedure('public.upsert_instagram_contact(uuid,text,text,text)') is null
     or to_regprocedure('public.record_instagram_contact_reservation(uuid,uuid)') is null
     or to_regprocedure('public.instagram_contact_tenant_guard()') is null
     or to_regprocedure('public.instagram_contacts_anonymize_on_customer()') is null
     or to_regprocedure('public.anonymize_customer(uuid)') is null then
    raise exception '79: objetos da conta/contato do Instagram ausentes (instagram_accounts, instagram_contacts, instagram_contact_reservations e as RPCs). Aplique a migration 20261020120100_instagram_accounts_contacts antes (sem ela, este abort e o RED esperado).';
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

-- ═══ Task 1.2: conta, contato, ledger e anonimização ═══════════════════════
-- Fixtures próprias de cada caso (clientes, reservas, a unidade UA2 da org A)
-- nascem e morrem dentro da subtransação do caso.

-- SQL de store_instagram_account_connection (vencimento em 60 dias).
create or replace function pg_temp.ig79_store(p_unit uuid, p_ig text, p_user text, p_token text, p_actor uuid)
returns text language sql as $$
  select format('select public.store_instagram_account_connection(%L::uuid, %L, %L, ''BUSINESS'', %L, now() + interval ''60 days'', %L::uuid)::text',
                p_unit, p_ig, p_user, p_token, p_actor)
$$;

-- Envolve a chamada de uma RPC `void`: devolve 'ok' quando ela não lança.
create or replace function pg_temp.ig79_void(p_call text)
returns text language sql as $$
  select format('select (%s)::text || ''ok''', p_call)
$$;

-- SQL de get_instagram_account_status: 'n:usuario/status/assinado/erro/tem_vencimento/tem_conexao,…'.
create or replace function pg_temp.ig79_status(p_unit uuid)
returns text language sql as $$
  select format('select count(*) || '':'' || coalesce(string_agg(username || ''/'' || status || ''/'' || subscribed || ''/'' '
                '|| coalesce(last_error_code, ''-'') || ''/'' || (token_expires_at is not null) || ''/'' || (connected_at is not null), '',''), '''') '
                'from public.get_instagram_account_status(%L::uuid)', p_unit)
$$;

-- Texto -> uuid, ou NULL se o texto não for um uuid (ex.: 'ERR …').
create or replace function pg_temp.ig79_uuid(p text)
returns uuid language sql as $$
  select case when p ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p::uuid end
$$;

-- ─── IG-2.1: leitura por tenant e postura de ACL/RLS das tabelas ─────────────
-- Contas em UA e UB, um contato em cada. Membro de A não lê o contato de B e
-- lê o de A; gerente de B lê só o de B; platform_admin sem membership lê os
-- dois. get_instagram_account_status: A em B, unidade inexistente e sem `sub`
-- recebem o MESMO 42501; membro lê A; platform_admin lê B; sem conta ativa,
-- zero linhas; anon sem EXECUTE. authenticated não lê instagram_accounts nem
-- instagram_contact_reservations (42501). Catálogo: FORCE RLS nas três,
-- contas e ledger sem policy e sem privilégio para anon/authenticated,
-- contatos só com SELECT para authenticated.
create or replace function pg_temp.ig79_case_21() returns text language plpgsql as $f$
declare
  ua constant uuid := 'a0d79000-0000-4000-8000-0000000000aa';
  ub constant uuid := 'a0d79000-0000-4000-8000-0000000000bb';
  ghost constant uuid := 'a0d79000-0000-4000-8000-0000000000ff';
  owner_a constant uuid := 'a0d79000-0000-4000-8000-0000000000a1';
  op_a constant uuid := 'a0d79000-0000-4000-8000-0000000000a3';
  ger_b constant uuid := 'a0d79000-0000-4000-8000-0000000000b2';
  pa constant uuid := 'a0d79000-0000-4000-8000-0000000000c1';
  f constant text := 'ERR 42501:instagram_status_forbidden';
  acc_a uuid; acc_b uuid; k_a text; k_b text; sub text; dis text;
  r_ab text; r_aa text; r_a_tudo text; r_b_tudo text; r_pa text;
  st_ab text; st_gh text; st_ns text; st_aa text; st_pb text; st_anon text; st_vazio text;
  sel_acc text; sel_led text; ruins text := ''; r text;
begin
  begin
    acc_a := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ua, 'ig79-21a', 'loja_a', 'tok-21-A-000001', owner_a)));
    acc_b := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ub, 'ig79-21b', 'loja_b', 'tok-21-B-000001', ger_b)));
    sub := pg_temp.ig79_q('service_role', null, pg_temp.ig79_void(format(
      'public.record_instagram_account_subscription(%L::uuid, array[''messages''])', acc_a)));
    k_a := pg_temp.ig79_q('service_role', null, format(
      'select public.upsert_instagram_contact(%L::uuid, ''igsid-21a'', ''cli_a'', ''Cliente A'')::text', acc_a));
    k_b := pg_temp.ig79_q('service_role', null, format(
      'select public.upsert_instagram_contact(%L::uuid, ''igsid-21b'', ''cli_b'', ''Cliente B'')::text', acc_b));

    r_ab := pg_temp.ig79_q('authenticated', op_a,
      format('select count(*)::text from public.instagram_contacts where unit_id = %L::uuid', ub));
    r_aa := pg_temp.ig79_q('authenticated', op_a,
      format('select count(*)::text from public.instagram_contacts where unit_id = %L::uuid', ua));
    r_a_tudo := pg_temp.ig79_q('authenticated', owner_a,
      format('select count(*)::text from public.instagram_contacts where unit_id in (%L::uuid, %L::uuid)', ua, ub));
    r_b_tudo := pg_temp.ig79_q('authenticated', ger_b,
      format('select count(*)::text from public.instagram_contacts where unit_id in (%L::uuid, %L::uuid)', ua, ub));
    r_pa := pg_temp.ig79_q('authenticated', pa,
      format('select count(*)::text from public.instagram_contacts where unit_id in (%L::uuid, %L::uuid)', ua, ub));

    st_ab := pg_temp.ig79_q('authenticated', owner_a, pg_temp.ig79_status(ub));
    st_gh := pg_temp.ig79_q('authenticated', owner_a, pg_temp.ig79_status(ghost));
    st_ns := pg_temp.ig79_q('authenticated', null, pg_temp.ig79_status(ua));
    st_aa := pg_temp.ig79_q('authenticated', op_a, pg_temp.ig79_status(ua));
    st_pb := pg_temp.ig79_q('authenticated', pa, pg_temp.ig79_status(ub));
    st_anon := pg_temp.ig79_q('anon', null, pg_temp.ig79_status(ua));

    sel_acc := pg_temp.ig79_q('authenticated', owner_a, 'select count(*)::text from public.instagram_accounts');
    sel_led := pg_temp.ig79_q('authenticated', owner_a, 'select count(*)::text from public.instagram_contact_reservations');

    dis := pg_temp.ig79_q('service_role', null, pg_temp.ig79_void(format(
      'public.disconnect_instagram_account(%L::uuid, %L::uuid)', acc_a, owner_a)));
    st_vazio := pg_temp.ig79_q('authenticated', owner_a, pg_temp.ig79_status(ua));

    -- Postura de catálogo.
    foreach r in array array['anon', 'authenticated'] loop
      if has_table_privilege(r, 'public.instagram_accounts', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         or has_any_column_privilege(r, 'public.instagram_accounts', 'SELECT,INSERT,UPDATE,REFERENCES') then
        ruins := ruins || ' ' || r || '_accounts';
      end if;
      if has_table_privilege(r, 'public.instagram_contact_reservations', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         or has_any_column_privilege(r, 'public.instagram_contact_reservations', 'SELECT,INSERT,UPDATE,REFERENCES') then
        ruins := ruins || ' ' || r || '_ledger';
      end if;
    end loop;
    if not has_table_privilege('authenticated', 'public.instagram_contacts', 'SELECT') then ruins := ruins || ' auth_sem_select_contacts'; end if;
    if has_table_privilege('authenticated', 'public.instagram_contacts', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       or has_any_column_privilege('authenticated', 'public.instagram_contacts', 'INSERT,UPDATE,REFERENCES') then
      ruins := ruins || ' auth_escreve_contacts';
    end if;
    if has_table_privilege('anon', 'public.instagram_contacts', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       or has_any_column_privilege('anon', 'public.instagram_contacts', 'SELECT,INSERT,UPDATE,REFERENCES') then
      ruins := ruins || ' anon_contacts';
    end if;
    foreach r in array array['public.instagram_accounts', 'public.instagram_contacts', 'public.instagram_contact_reservations'] loop
      if not (select relrowsecurity and relforcerowsecurity from pg_class where oid = r::regclass) then
        ruins := ruins || ' sem_force_rls:' || r;
      end if;
    end loop;
    if exists (select 1 from pg_policy where polrelid in ('public.instagram_accounts'::regclass, 'public.instagram_contact_reservations'::regclass)) then
      ruins := ruins || ' accounts_ou_ledger_com_policy';
    end if;

    raise exception using errcode = 'P0R79', message =
      case when acc_a is not null and acc_b is not null and sub = 'ok'
            and pg_temp.ig79_uuid(k_a) is not null and pg_temp.ig79_uuid(k_b) is not null
            and r_ab = '0' and r_aa = '1' and r_a_tudo = '1' and r_b_tudo = '1' and r_pa = '2'
            and st_ab = f and st_gh = f and st_ns = f
            and st_aa = '1:loja_a/connected/true/-/true/true'
            and st_pb = '1:loja_b/connected/false/-/true/true'
            and st_anon like 'ERR 42501:permission denied for function get_instagram_account_status%'
            and sel_acc like 'ERR 42501:permission denied for table instagram_accounts%'
            and sel_led like 'ERR 42501:permission denied for table instagram_contact_reservations%'
            and dis = 'ok' and st_vazio = '0:'
            and ruins = '' then 'PASSOU'
           else 'FALHOU contas=' || coalesce(acc_a::text, '<null>') || '/' || coalesce(acc_b::text, '<null>')
                || ' assinatura=' || sub || ' contatos=' || k_a || '/' || k_b
                || ' opA_le_B=' || r_ab || ' opA_le_A=' || r_aa || ' ownerA_le_AB=' || r_a_tudo
                || ' gerB_le_AB=' || r_b_tudo || ' pa_le_AB=' || r_pa
                || ' status_A->B=' || st_ab || ' status_A->inexistente=' || st_gh || ' status_sem_sub=' || st_ns
                || ' status_opA=' || st_aa || ' status_pa->B=' || st_pb || ' status_anon=' || st_anon
                || ' select_accounts=' || sel_acc || ' select_ledger=' || sel_led
                || ' desconectar=' || dis || ' status_sem_conta=' || st_vazio || ' catalogo:' || ruins end;
  exception
    when sqlstate 'P0R79' then return sqlerrm;
    when others then return 'FALHOU erro inesperado ' || sqlstate || ':' || sqlerrm;
  end;
end $f$;

-- ─── IG-2.2: uma conta ativa por ig_user_id e por unidade ────────────────────
-- Conta X ativa em B: conectar X em A recebe instagram_account_in_use (P0001).
-- Y em A duas vezes reaproveita a linha (username e token novos). Z em A
-- desconecta Y (ponteiro zerado). Desconectar X em B e conectar X em A
-- funciona (linha nova, organização de A) e desconecta Z. Reconectar Y em A
-- reaproveita a linha desconectada de Y, com UM segredo no Vault.
create or replace function pg_temp.ig79_case_22() returns text language plpgsql as $f$
declare
  ua constant uuid := 'a0d79000-0000-4000-8000-0000000000aa';
  ub constant uuid := 'a0d79000-0000-4000-8000-0000000000bb';
  org_a constant uuid := 'a0d79000-0000-4000-8000-00000000000a';
  owner_a constant uuid := 'a0d79000-0000-4000-8000-0000000000a1';
  ger_b constant uuid := 'a0d79000-0000-4000-8000-0000000000b2';
  x_b text; em_uso text; y1 text; y2 text; z text; dis text; x_a text; y3 text;
  y_apos_y2 text; tok_y2 text; n_y int; y_apos_z text; ativos_a_z text;
  x_a_estado text; z_apos_x text; y_apos_y3 text; tok_y3 text; n_seg_y int; x_a_apos_y3 text; ativos_b int;
begin
  begin
    x_b := pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ub, 'ig79-22x', 'conta_x', 'tok-22-xB-00001', ger_b));
    em_uso := pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ua, 'ig79-22x', 'conta_x', 'tok-22-xA-00001', owner_a));

    y1 := pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ua, 'ig79-22y', 'conta_y', 'tok-22-yA-00001', owner_a));
    y2 := pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ua, 'ig79-22y', 'conta_y2', 'tok-22-yA-00002', owner_a));
    select a.username || '|' || a.status into y_apos_y2 from public.instagram_accounts a where a.id = pg_temp.ig79_uuid(y1);
    tok_y2 := pg_temp.ig79_q('service_role', null, format('select public.get_instagram_account_token(%L::uuid)', pg_temp.ig79_uuid(y1)));
    select count(*) into n_y from public.instagram_accounts a where a.unit_id = ua and a.ig_user_id = 'ig79-22y';

    z := pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ua, 'ig79-22z', 'conta_z', 'tok-22-zA-00001', owner_a));
    select a.status || '|' || (a.token_secret_id is null) || '|' || (a.disconnected_at is not null)
      into y_apos_z from public.instagram_accounts a where a.id = pg_temp.ig79_uuid(y1);
    select coalesce(string_agg(a.id::text, ','), '<nenhuma>') into ativos_a_z
      from public.instagram_accounts a where a.unit_id = ua and a.status <> 'disconnected';

    dis := pg_temp.ig79_q('service_role', null, pg_temp.ig79_void(format(
      'public.disconnect_instagram_account(%L::uuid, %L::uuid)', pg_temp.ig79_uuid(x_b), ger_b)));
    x_a := pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ua, 'ig79-22x', 'conta_x', 'tok-22-xA-00002', owner_a));
    select a.status || '|' || a.organization_id || '|' || a.connected_by into x_a_estado
      from public.instagram_accounts a where a.id = pg_temp.ig79_uuid(x_a);
    select a.status into z_apos_x from public.instagram_accounts a where a.id = pg_temp.ig79_uuid(z);

    y3 := pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ua, 'ig79-22y', 'conta_y3', 'tok-22-yA-00003', owner_a));
    select a.status || '|' || a.username || '|' || (a.disconnected_at is null) || '|' || (a.token_secret_id is not null)
      into y_apos_y3 from public.instagram_accounts a where a.id = pg_temp.ig79_uuid(y1);
    tok_y3 := pg_temp.ig79_q('service_role', null, format('select public.get_instagram_account_token(%L::uuid)', pg_temp.ig79_uuid(y1)));
    select count(*) into n_seg_y from vault.secrets s where s.name = 'instagram-account-' || pg_temp.ig79_uuid(y1) || '-token';
    select a.status into x_a_apos_y3 from public.instagram_accounts a where a.id = pg_temp.ig79_uuid(x_a);
    select count(*) into ativos_b from public.instagram_accounts a where a.unit_id = ub and a.status <> 'disconnected';

    raise exception using errcode = 'P0R79', message =
      case when pg_temp.ig79_uuid(x_b) is not null
            and em_uso = 'ERR P0001:instagram_account_in_use'
            and pg_temp.ig79_uuid(y1) is not null and y2 = y1
            and y_apos_y2 = 'conta_y2|connected' and tok_y2 = 'tok-22-yA-00002' and n_y = 1
            and pg_temp.ig79_uuid(z) is not null and z <> y1
            and y_apos_z = 'disconnected|true|true' and ativos_a_z = z
            and dis = 'ok'
            and pg_temp.ig79_uuid(x_a) is not null and x_a <> x_b
            and x_a_estado = 'connected|' || org_a || '|' || owner_a
            and z_apos_x = 'disconnected'
            and y3 = y1 and y_apos_y3 = 'connected|conta_y3|true|true' and tok_y3 = 'tok-22-yA-00003'
            and n_seg_y = 1 and x_a_apos_y3 = 'disconnected' and ativos_b = 0 then 'PASSOU'
           else 'FALHOU x_em_B=' || x_b || ' x_em_A=' || em_uso || ' y1=' || y1 || ' y2=' || y2
                || ' y_apos_y2=' || coalesce(y_apos_y2, '<null>') || ' token_y2=' || tok_y2 || ' linhas_y=' || n_y
                || ' z=' || z || ' y_apos_z=' || coalesce(y_apos_z, '<null>') || ' ativas_A=' || ativos_a_z
                || ' desconectar_xB=' || dis || ' x_em_A_depois=' || x_a || ' estado_xA=' || coalesce(x_a_estado, '<null>')
                || ' z_apos_x=' || coalesce(z_apos_x, '<null>') || ' y3=' || y3 || ' y_apos_y3=' || coalesce(y_apos_y3, '<null>')
                || ' token_y3=' || tok_y3 || ' segredos_y=' || n_seg_y || ' xA_apos_y3=' || coalesce(x_a_apos_y3, '<null>')
                || ' ativas_B=' || ativos_b end;
  exception
    when sqlstate 'P0R79' then return sqlerrm;
    when others then return 'FALHOU erro inesperado ' || sqlstate || ':' || sqlerrm;
  end;
end $f$;

-- ─── IG-2.3: token só por service_role; desconexão sobrescreve o Vault ──────
-- authenticated e anon recebem 42501 no EXECUTE de get_instagram_account_token;
-- service_role lê o token gravado. A renovação troca o valor no MESMO segredo
-- e carimba token_refreshed_at. Status só connected <-> reauth_required.
-- Depois de disconnect: a RPC dá P0002, token_secret_id é nulo, o segredo
-- (lido pelo nome) não é nenhum dos tokens, e renovar dá 55000. ACL: as oito
-- RPCs de serviço só para service_role; a de status só para authenticated;
-- PUBLIC fora de todas; trigger functions sem EXECUTE para anon/authenticated.
create or replace function pg_temp.ig79_case_23() returns text language plpgsql as $f$
declare
  ua constant uuid := 'a0d79000-0000-4000-8000-0000000000aa';
  owner_a constant uuid := 'a0d79000-0000-4000-8000-0000000000a1';
  t1 constant text := 'tok-23-original-0001';
  t2 constant text := 'tok-23-renovado-0002';
  acc uuid; e_auth text; e_anon text; l1 text; sid0 uuid; rf text; l2 text; sid1 text;
  st1 text; st_ruim text; dis text; l3 text; depois text; v_vault text; rf_depois text; st_depois text;
  ruins text := ''; fn text; r text;
begin
  begin
    acc := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ua, 'ig79-23', 'conta_t', t1, owner_a)));
    e_auth := pg_temp.ig79_q('authenticated', owner_a, format('select public.get_instagram_account_token(%L::uuid)', acc));
    e_anon := pg_temp.ig79_q('anon', null, format('select public.get_instagram_account_token(%L::uuid)', acc));
    l1 := pg_temp.ig79_q('service_role', null, format('select public.get_instagram_account_token(%L::uuid)', acc));
    select a.token_secret_id into sid0 from public.instagram_accounts a where a.id = acc;

    rf := pg_temp.ig79_q('service_role', null, pg_temp.ig79_void(format(
      'public.record_instagram_token_refresh(%L::uuid, %L, now() + interval ''60 days'')', acc, t2)));
    l2 := pg_temp.ig79_q('service_role', null, format('select public.get_instagram_account_token(%L::uuid)', acc));
    select (a.token_secret_id = sid0) || '|' || (a.token_refreshed_at is not null) into sid1
      from public.instagram_accounts a where a.id = acc;

    st1 := pg_temp.ig79_q('service_role', null, pg_temp.ig79_void(format(
      'public.set_instagram_account_status(%L::uuid, ''reauth_required'', ''expired'')', acc)));
    st_ruim := pg_temp.ig79_q('service_role', null, pg_temp.ig79_void(format(
      'public.set_instagram_account_status(%L::uuid, ''disconnected'', null)', acc)));

    dis := pg_temp.ig79_q('service_role', null, pg_temp.ig79_void(format(
      'public.disconnect_instagram_account(%L::uuid, %L::uuid)', acc, owner_a)));
    l3 := pg_temp.ig79_q('service_role', null, format('select public.get_instagram_account_token(%L::uuid)', acc));
    select a.status || '|' || (a.token_secret_id is null) into depois from public.instagram_accounts a where a.id = acc;
    select ds.decrypted_secret into v_vault from vault.decrypted_secrets ds
     where ds.name = 'instagram-account-' || acc || '-token';
    rf_depois := pg_temp.ig79_q('service_role', null, pg_temp.ig79_void(format(
      'public.record_instagram_token_refresh(%L::uuid, %L, now() + interval ''60 days'')', acc, t2)));
    st_depois := pg_temp.ig79_q('service_role', null, pg_temp.ig79_void(format(
      'public.set_instagram_account_status(%L::uuid, ''connected'', null)', acc)));

    foreach fn in array array[
      'public.store_instagram_account_connection(uuid,text,text,text,text,timestamptz,uuid)',
      'public.get_instagram_account_token(uuid)',
      'public.record_instagram_account_subscription(uuid,text[])',
      'public.record_instagram_token_refresh(uuid,text,timestamptz)',
      'public.set_instagram_account_status(uuid,text,text)',
      'public.disconnect_instagram_account(uuid,uuid)',
      'public.upsert_instagram_contact(uuid,text,text,text)',
      'public.record_instagram_contact_reservation(uuid,uuid)'] loop
      foreach r in array array['anon', 'authenticated'] loop
        if has_function_privilege(r, fn, 'EXECUTE') then ruins := ruins || ' ' || r || '_exec:' || fn; end if;
      end loop;
      if not has_function_privilege('service_role', fn, 'EXECUTE') then ruins := ruins || ' service_sem_exec:' || fn; end if;
    end loop;
    fn := 'public.get_instagram_account_status(uuid)';
    if has_function_privilege('anon', fn, 'EXECUTE') then ruins := ruins || ' anon_exec:' || fn; end if;
    if not has_function_privilege('authenticated', fn, 'EXECUTE') then ruins := ruins || ' auth_sem_exec:' || fn; end if;
    foreach fn in array array['public.instagram_contact_tenant_guard()', 'public.instagram_contacts_anonymize_on_customer()'] loop
      foreach r in array array['anon', 'authenticated'] loop
        if has_function_privilege(r, fn, 'EXECUTE') then ruins := ruins || ' ' || r || '_exec:' || fn; end if;
      end loop;
    end loop;
    if exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                where p.pronamespace = 'public'::regnamespace
                  and (p.proname like '%instagram%')
                  and a.grantee = 0) then
      ruins := ruins || ' public_exec_em_funcao_instagram';
    end if;

    raise exception using errcode = 'P0R79', message =
      case when acc is not null
            and e_auth like 'ERR 42501:permission denied for function get_instagram_account_token%'
            and e_anon like 'ERR 42501:permission denied for function get_instagram_account_token%'
            and l1 = t1 and sid0 is not null
            and rf = 'ok' and l2 = t2 and sid1 = 'true|true'
            and st1 = 'ok' and st_ruim = 'ERR 22023:invalid_instagram_account_status'
            and dis = 'ok' and l3 = 'ERR P0002:instagram_account_token_not_found'
            and depois = 'disconnected|true'
            and v_vault is not null and v_vault <> t1 and v_vault <> t2
            and rf_depois = 'ERR 55000:instagram_account_not_active'
            and st_depois = 'ERR 55000:instagram_account_not_active'
            and ruins = '' then 'PASSOU'
           else 'FALHOU conta=' || coalesce(acc::text, '<null>') || ' exec_auth=' || e_auth || ' exec_anon=' || e_anon
                || ' leitura1=' || l1 || ' renovar=' || rf || ' leitura2=' || l2 || ' mesmo_segredo|carimbo=' || coalesce(sid1, '<null>')
                || ' reauth=' || st1 || ' status_ruim=' || st_ruim || ' desconectar=' || dis || ' leitura3=' || l3
                || ' depois=' || coalesce(depois, '<null>')
                || ' vault_sobrescrito=' || coalesce((v_vault <> t1 and v_vault <> t2)::text, '<null>')
                || ' renovar_desconectada=' || rf_depois || ' status_desconectada=' || st_depois
                || ' acl:' || ruins end;
  exception
    when sqlstate 'P0R79' then return sqlerrm;
    when others then return 'FALHOU erro inesperado ' || sqlstate || ':' || sqlerrm;
  end;
end $f$;

-- ─── IG-2.4: guarda de coerência do contato e da conta ──────────────────────
-- Gravando como postgres (sem RLS), o guard é a única barreira: ligar o
-- contato a cliente de outra organização, contato com unidade/organização que
-- não são as da conta, mover o contato de conta e conta com organização de
-- outra unidade são recusados com 23514. O upsert tira unidade e organização
-- da conta e só sobrescreve username/name com valor não nulo.
create or replace function pg_temp.ig79_case_24() returns text language plpgsql as $f$
declare
  ua constant uuid := 'a0d79000-0000-4000-8000-0000000000aa';
  ub constant uuid := 'a0d79000-0000-4000-8000-0000000000bb';
  org_a constant uuid := 'a0d79000-0000-4000-8000-00000000000a';
  org_b constant uuid := 'a0d79000-0000-4000-8000-00000000000b';
  owner_a constant uuid := 'a0d79000-0000-4000-8000-0000000000a1';
  ger_b constant uuid := 'a0d79000-0000-4000-8000-0000000000b2';
  c_a constant uuid := 'a0d79000-0000-4000-8000-000000002401';
  c_b constant uuid := 'a0d79000-0000-4000-8000-000000002402';
  acc uuid; acc_b uuid; k uuid; k2 text; dono text; perfil text;
  x_cli text; ok_cli text; x_ins_b text; x_ins_conta text; x_mover text; x_conta text;
begin
  begin
    insert into public.customers (id, organization_id, name, phone) values
      (c_a, org_a, 'ig79 cliente A', '11990002401'),
      (c_b, org_b, 'ig79 cliente B', '11990002402');
    acc := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ua, 'ig79-24a', 'conta_a', 'tok-24-A-000001', owner_a)));
    acc_b := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ub, 'ig79-24b', 'conta_b', 'tok-24-B-000001', ger_b)));
    k := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, format(
      'select public.upsert_instagram_contact(%L::uuid, ''igsid-24'', ''user24'', ''Nome 24'')::text', acc)));
    k2 := pg_temp.ig79_q('service_role', null, format(
      'select public.upsert_instagram_contact(%L::uuid, ''igsid-24'', null, ''Nome novo'')::text', acc));
    select c.unit_id || '|' || c.organization_id into dono from public.instagram_contacts c where c.id = k;
    select c.username || '|' || c.name into perfil from public.instagram_contacts c where c.id = k;

    x_cli := pg_temp.ig79_q(null, null, format(
      'with u as (update public.instagram_contacts set customer_id = %L where id = %L returning 1) select count(*)::text from u', c_b, k));
    ok_cli := pg_temp.ig79_q(null, null, format(
      'with u as (update public.instagram_contacts set customer_id = %L, customer_linked_at = now() where id = %L returning 1) select count(*)::text from u', c_a, k));
    x_ins_b := pg_temp.ig79_q(null, null, format(
      'with i as (insert into public.instagram_contacts (organization_id, unit_id, instagram_account_id, igsid) '
      'values (%L, %L, %L, ''igsid-24x'') returning 1) select count(*)::text from i', org_b, ub, acc));
    x_ins_conta := pg_temp.ig79_q(null, null, format(
      'with i as (insert into public.instagram_contacts (organization_id, unit_id, instagram_account_id, igsid) '
      'values (%L, %L, %L, ''igsid-24y'') returning 1) select count(*)::text from i', org_a, ua, acc_b));
    x_mover := pg_temp.ig79_q(null, null, format(
      'with u as (update public.instagram_contacts set instagram_account_id = %L, unit_id = %L, organization_id = %L '
      'where id = %L returning 1) select count(*)::text from u', acc_b, ub, org_b, k));
    x_conta := pg_temp.ig79_q(null, null, format(
      'with i as (insert into public.instagram_accounts (organization_id, unit_id, ig_user_id, connected_by) '
      'values (%L, %L, ''ig79-24x'', %L) returning 1) select count(*)::text from i', org_b, ua, owner_a));

    raise exception using errcode = 'P0R79', message =
      case when acc is not null and acc_b is not null and k is not null and k2 = k::text
            and dono = ua || '|' || org_a and perfil = 'user24|Nome novo'
            and x_cli like 'ERR 23514:instagram_contacts: cliente % nao e da organizacao do contato'
            and ok_cli = '1'
            and x_ins_b like 'ERR 23514:instagram_contacts: unidade/organizacao do contato nao sao as da conta %'
            and x_ins_conta like 'ERR 23514:instagram_contacts: unidade/organizacao do contato nao sao as da conta %'
            and x_mover = 'ERR 23514:instagram_contacts: conta, unidade e organizacao sao imutaveis'
            and x_conta like 'ERR 23514:instagram_accounts: organizacao % nao e a da unidade %' then 'PASSOU'
           else 'FALHOU contas=' || coalesce(acc::text, '<null>') || '/' || coalesce(acc_b::text, '<null>')
                || ' contato=' || coalesce(k::text, '<null>') || ' upsert2=' || k2
                || ' dono=' || coalesce(dono, '<null>') || ' perfil=' || coalesce(perfil, '<null>')
                || ' cliente_outra_org=' || x_cli || ' cliente_mesma_org=' || ok_cli
                || ' contato_unidade_B=' || x_ins_b || ' contato_conta_B=' || x_ins_conta
                || ' mover_contato=' || x_mover || ' conta_org_errada=' || x_conta end;
  exception
    when sqlstate 'P0R79' then return sqlerrm;
    when others then return 'FALHOU erro inesperado ' || sqlstate || ':' || sqlerrm;
  end;
end $f$;

-- ─── IG-2.5: ledger contato × reserva ───────────────────────────────────────
-- Contato de UA ligado ao cliente C1. Reserva de C1 noutra unidade da mesma
-- organização (UA2), reserva de outro cliente em UA, contato sem cliente,
-- reserva inexistente: todos 42501. Reserva de C1 em UA grava uma linha com
-- unit_id de UA; repetir é no-op.
create or replace function pg_temp.ig79_case_25() returns text language plpgsql as $f$
declare
  ua constant uuid := 'a0d79000-0000-4000-8000-0000000000aa';
  ua2 constant uuid := 'a0d79000-0000-4000-8000-0000000025a2';
  org_a constant uuid := 'a0d79000-0000-4000-8000-00000000000a';
  owner_a constant uuid := 'a0d79000-0000-4000-8000-0000000000a1';
  c1 constant uuid := 'a0d79000-0000-4000-8000-000000002501';
  c2 constant uuid := 'a0d79000-0000-4000-8000-000000002502';
  r_ok constant uuid := 'a0d79000-0000-4000-8000-000000002511';
  r_unid constant uuid := 'a0d79000-0000-4000-8000-000000002512';
  r_cli constant uuid := 'a0d79000-0000-4000-8000-000000002513';
  r_ghost constant uuid := 'a0d79000-0000-4000-8000-0000000025ff';
  f constant text := 'ERR 42501:instagram_contact_reservation_forbidden';
  acc uuid; k uuid; k_sem uuid;
  e_unid text; e_cli text; e_sem text; e_ghost text; ok1 text; ok2 text; led text; n_ruins int;
begin
  begin
    insert into public.units (id, organization_id, name) values (ua2, org_a, 'ig79 UA2');
    insert into public.customers (id, organization_id, name, phone) values
      (c1, org_a, 'ig79 cliente 1', '11990002501'),
      (c2, org_a, 'ig79 cliente 2', '11990002502');
    insert into public.reservations (id, unit_id, customer_id, party_size, date, time, reservation_code) values
      (r_ok,   ua,  c1, 2, current_date + 1, '20:00', 'IG79-2511'),
      (r_unid, ua2, c1, 2, current_date + 1, '20:00', 'IG79-2512'),
      (r_cli,  ua,  c2, 2, current_date + 1, '20:00', 'IG79-2513');
    acc := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ua, 'ig79-25', 'conta_25', 'tok-25-A-000001', owner_a)));
    k := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, format(
      'select public.upsert_instagram_contact(%L::uuid, ''igsid-25'', ''user25'', null)::text', acc)));
    k_sem := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, format(
      'select public.upsert_instagram_contact(%L::uuid, ''igsid-25s'', ''user25s'', null)::text', acc)));
    update public.instagram_contacts set customer_id = c1, customer_linked_at = now() where id = k;

    e_unid := pg_temp.ig79_q('service_role', null, pg_temp.ig79_void(format(
      'public.record_instagram_contact_reservation(%L::uuid, %L::uuid)', k, r_unid)));
    e_cli := pg_temp.ig79_q('service_role', null, pg_temp.ig79_void(format(
      'public.record_instagram_contact_reservation(%L::uuid, %L::uuid)', k, r_cli)));
    e_sem := pg_temp.ig79_q('service_role', null, pg_temp.ig79_void(format(
      'public.record_instagram_contact_reservation(%L::uuid, %L::uuid)', k_sem, r_ok)));
    e_ghost := pg_temp.ig79_q('service_role', null, pg_temp.ig79_void(format(
      'public.record_instagram_contact_reservation(%L::uuid, %L::uuid)', k, r_ghost)));
    ok1 := pg_temp.ig79_q('service_role', null, pg_temp.ig79_void(format(
      'public.record_instagram_contact_reservation(%L::uuid, %L::uuid)', k, r_ok)));
    ok2 := pg_temp.ig79_q('service_role', null, pg_temp.ig79_void(format(
      'public.record_instagram_contact_reservation(%L::uuid, %L::uuid)', k, r_ok)));
    select coalesce(string_agg(l.instagram_contact_id || '|' || l.unit_id, ','), '<nenhuma>') into led
      from public.instagram_contact_reservations l where l.reservation_id = r_ok;
    select count(*) into n_ruins from public.instagram_contact_reservations l
     where l.reservation_id in (r_unid, r_cli, r_ghost) or l.instagram_contact_id = k_sem;

    raise exception using errcode = 'P0R79', message =
      case when acc is not null and k is not null and k_sem is not null
            and e_unid = f and e_cli = f and e_sem = f and e_ghost = f
            and ok1 = 'ok' and ok2 = 'ok'
            and led = k || '|' || ua and n_ruins = 0 then 'PASSOU'
           else 'FALHOU outra_unidade=' || e_unid || ' outro_cliente=' || e_cli || ' contato_sem_cliente=' || e_sem
                || ' reserva_inexistente=' || e_ghost || ' valido=' || ok1 || ' repetido=' || ok2
                || ' ledger=' || led || ' linhas_indevidas=' || n_ruins end;
  exception
    when sqlstate 'P0R79' then return sqlerrm;
    when others then return 'FALHOU erro inesperado ' || sqlstate || ':' || sqlerrm;
  end;
end $f$;

-- ─── IG-2.6: anonimização LGPD do contato ───────────────────────────────────
-- platform_admin (papel real + claims) chama anonymize_customer(CX): o contato
-- de CX fica com igsid/username/name nulos e anonymized_at preenchido; o de
-- CY fica intacto. Um UPDATE que toca deleted_at de CY sem soft delete (de
-- nulo para nulo) não anonimiza nada. O mesmo IGSID voltando abre contato novo.
create or replace function pg_temp.ig79_case_26() returns text language plpgsql as $f$
declare
  ua constant uuid := 'a0d79000-0000-4000-8000-0000000000aa';
  org_a constant uuid := 'a0d79000-0000-4000-8000-00000000000a';
  owner_a constant uuid := 'a0d79000-0000-4000-8000-0000000000a1';
  pa constant uuid := 'a0d79000-0000-4000-8000-0000000000c1';
  cx constant uuid := 'a0d79000-0000-4000-8000-000000002601';
  cy constant uuid := 'a0d79000-0000-4000-8000-000000002602';
  acc uuid; kx uuid; ky uuid; an text; cx_del text; kx_est text; ky_est1 text; noop text; ky_est2 text; novo text;
begin
  begin
    insert into public.customers (id, organization_id, name, phone) values
      (cx, org_a, 'ig79 cliente X', '11990002601'),
      (cy, org_a, 'ig79 cliente Y', '11990002602');
    acc := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ua, 'ig79-26', 'conta_26', 'tok-26-A-000001', owner_a)));
    kx := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, format(
      'select public.upsert_instagram_contact(%L::uuid, ''igsid-26x'', ''user_x'', ''Nome X'')::text', acc)));
    ky := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, format(
      'select public.upsert_instagram_contact(%L::uuid, ''igsid-26y'', ''user_y'', ''Nome Y'')::text', acc)));
    update public.instagram_contacts set customer_id = cx, customer_linked_at = now() where id = kx;
    update public.instagram_contacts set customer_id = cy, customer_linked_at = now() where id = ky;

    an := pg_temp.ig79_q('authenticated', pa, pg_temp.ig79_void(format('public.anonymize_customer(%L::uuid)', cx)));
    select (c.deleted_at is not null)::text into cx_del from public.customers c where c.id = cx;
    select coalesce(c.igsid, '<null>') || '|' || coalesce(c.username, '<null>') || '|' || coalesce(c.name, '<null>')
           || '|' || (c.anonymized_at is not null) || '|' || coalesce(c.customer_id::text, '<null>')
      into kx_est from public.instagram_contacts c where c.id = kx;
    select coalesce(c.igsid, '<null>') || '|' || coalesce(c.username, '<null>') || '|' || coalesce(c.name, '<null>')
           || '|' || (c.anonymized_at is not null)
      into ky_est1 from public.instagram_contacts c where c.id = ky;

    noop := pg_temp.ig79_q(null, null, format(
      'with u as (update public.customers set deleted_at = null where id = %L returning 1) select count(*)::text from u', cy));
    select coalesce(c.igsid, '<null>') || '|' || coalesce(c.username, '<null>') || '|' || coalesce(c.name, '<null>')
           || '|' || (c.anonymized_at is not null)
      into ky_est2 from public.instagram_contacts c where c.id = ky;

    novo := pg_temp.ig79_q('service_role', null, format(
      'select public.upsert_instagram_contact(%L::uuid, ''igsid-26x'', ''user_x'', null)::text', acc));

    raise exception using errcode = 'P0R79', message =
      case when acc is not null and kx is not null and ky is not null
            and an = 'ok' and cx_del = 'true'
            and kx_est = '<null>|<null>|<null>|true|' || cx
            and ky_est1 = 'igsid-26y|user_y|Nome Y|false'
            and noop = '1' and ky_est2 = ky_est1
            and pg_temp.ig79_uuid(novo) is not null and novo <> kx::text then 'PASSOU'
           else 'FALHOU anonimizar=' || an || ' cliente_x_apagado=' || coalesce(cx_del, '<null>')
                || ' contato_x=' || coalesce(kx_est, '<null>') || ' contato_y=' || coalesce(ky_est1, '<null>')
                || ' update_noop_y=' || noop || ' contato_y_depois=' || coalesce(ky_est2, '<null>')
                || ' igsid_volta=' || novo end;
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
  (7906, 'IG-1.6 guard de tenant: org errada, unidade inexistente e mover grant/settings recusados com 23514', pg_temp.ig79_case_16()),
  (7920, 'IG-2.1 A nao le contato de B; status A->B, inexistente e sem sub com o mesmo 42501; authenticated sem acesso a accounts e ledger; FORCE RLS e ACL de tabela', pg_temp.ig79_case_21()),
  (7921, 'IG-2.2 ig_user_id ativo em B recusado em A (instagram_account_in_use); mesma conta reaproveita a linha; outra conta da unidade desconectada; desconectar em B e conectar em A funciona', pg_temp.ig79_case_22()),
  (7922, 'IG-2.3 token so por service_role (authenticated/anon 42501 no EXECUTE); renovacao no mesmo segredo; disconnect sobrescreve o Vault e zera token_secret_id; ACL das RPCs', pg_temp.ig79_case_23()),
  (7923, 'IG-2.4 guarda do contato: cliente de outra org, unidade/org fora da conta e mover contato recusados com 23514; upsert tira unidade/org da conta', pg_temp.ig79_case_24()),
  (7924, 'IG-2.5 ledger: reserva de outra unidade, de outro cliente, contato sem cliente e reserva inexistente recebem 42501; valido grava 1 linha; repetir e no-op', pg_temp.ig79_case_25()),
  (7925, 'IG-2.6 anonymize_customer como platform_admin anonimiza o contato do cliente; contato de outro cliente e update noop de deleted_at intactos', pg_temp.ig79_case_26());

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

-- ─── Controles positivos da Task 1.2 ─────────────────────────────────────────

-- C-IG-2.1: (a) policy de SELECT de contatos aberta (`true`); (b)
-- get_instagram_account_status sem a perna de membro/admin; (c) SELECT em
-- instagram_accounts para authenticated; (d) SELECT no ledger para
-- authenticated.
do $$
declare
  v_def text; v_mut text; v_pol0 text; v_pol text; s1 text; s2 text; s3 text; s4 text; d text;
begin
  v_def := pg_get_functiondef('public.get_instagram_account_status(uuid)'::regprocedure);
  select string_agg(polname || ':' || pg_get_expr(polqual, polrelid), ';' order by polname)
    into v_pol0 from pg_policy where polrelid = 'public.instagram_contacts'::regclass;
  begin
    drop policy instagram_contacts_select on public.instagram_contacts;
    create policy instagram_contacts_select on public.instagram_contacts for select to authenticated using (true);
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_21();
  exception
    when sqlstate 'P0R79' then s1 := sqlerrm;
    when others then s1 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    v_mut := replace(v_def,
      'or not (app_private.is_unit_member(v_uid, p_unit_id) or app_private.is_platform_admin(v_uid))', '');
    if v_mut = v_def then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_21();
  exception
    when sqlstate 'P0R79' then s2 := sqlerrm;
    when others then s2 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    grant select on public.instagram_accounts to authenticated;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_21();
  exception
    when sqlstate 'P0R79' then s3 := sqlerrm;
    when others then s3 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    grant select on public.instagram_contact_reservations to authenticated;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_21();
  exception
    when sqlstate 'P0R79' then s4 := sqlerrm;
    when others then s4 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  d := pg_temp.ig79_case_21();
  raise notice 'C-IG-2.1 select aberto: %', s1;
  raise notice 'C-IG-2.1 status sem guarda: %', s2;
  raise notice 'C-IG-2.1 select accounts: %', s3;
  raise notice 'C-IG-2.1 select ledger: %', s4;
  select string_agg(polname || ':' || pg_get_expr(polqual, polrelid), ';' order by polname)
    into v_pol from pg_policy where polrelid = 'public.instagram_contacts'::regclass;
  insert into t_res values (7930, 'C-IG-2.1 policy de contatos aberta, status sem guarda, SELECT em accounts e no ledger para authenticated: IG-2.1 reprova nos quatro; restaurado passa',
    case when s1 like 'FALHOU%opA_le_B=1%'
          and s2 like 'FALHOU%status_A->B=1:loja_b%'
          and s3 like 'FALHOU%select_accounts=0%authenticated_accounts%'
          and s4 like 'FALHOU%select_ledger=0%authenticated_ledger%'
          and d = 'PASSOU' and v_pol = v_pol0
          and pg_get_functiondef('public.get_instagram_account_status(uuid)'::regprocedure) = v_def then 'PASSOU'
         else 'FALHOU select_aberto=' || s1 || ' status_sem_guarda=' || s2 || ' select_accounts=' || s3
              || ' select_ledger=' || s4 || ' restaurado=' || d end);
end $$;

-- C-IG-2.2: (a) store sem a recusa de conta em uso; (b) store sem desconectar
-- a outra conta da unidade; (c) store sem reaproveitar a linha da mesma conta.
do $$
declare
  v_def text; v_mut text; s1 text; s2 text; s3 text; d text;
begin
  v_def := pg_get_functiondef('public.store_instagram_account_connection(uuid,text,text,text,text,timestamptz,uuid)'::regprocedure);
  begin
    v_mut := replace(v_def, 'raise exception ''instagram_account_in_use'' using errcode = ''P0001'';', 'null;');
    if v_mut = v_def then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_22();
  exception
    when sqlstate 'P0R79' then s1 := sqlerrm;
    when others then s1 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    v_mut := replace(v_def, 'perform public.disconnect_instagram_account(v_other.id, p_actor);', 'null;');
    if v_mut = v_def then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_22();
  exception
    when sqlstate 'P0R79' then s2 := sqlerrm;
    when others then s2 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    v_mut := replace(v_def, 'where a.unit_id = p_unit_id and a.ig_user_id = p_ig_user_id', 'where false');
    if v_mut = v_def then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_22();
  exception
    when sqlstate 'P0R79' then s3 := sqlerrm;
    when others then s3 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  d := pg_temp.ig79_case_22();
  raise notice 'C-IG-2.2 sem recusa em uso: %', s1;
  raise notice 'C-IG-2.2 sem desconectar a outra: %', s2;
  raise notice 'C-IG-2.2 sem reaproveitar: %', s3;
  insert into t_res values (7931, 'C-IG-2.2 store sem recusa de conta em uso, sem desconectar a outra conta da unidade e sem reaproveitar a linha: IG-2.2 reprova nos tres; restaurado passa',
    case when s1 like 'FALHOU%x_em_A=ERR 23505%'
          and s2 like 'FALHOU%z=ERR 23505%'
          and s3 like 'FALHOU%y2=ERR 23505%'
          and d = 'PASSOU'
          and pg_get_functiondef('public.store_instagram_account_connection(uuid,text,text,text,text,timestamptz,uuid)'::regprocedure) = v_def then 'PASSOU'
         else 'FALHOU sem_recusa=' || s1 || ' sem_desconectar=' || s2 || ' sem_reaproveitar=' || s3 || ' restaurado=' || d end);
end $$;

-- C-IG-2.3: (a) EXECUTE de get_instagram_account_token para authenticated;
-- (b) disconnect sem sobrescrever o Vault; (c) disconnect sem zerar o ponteiro.
do $$
declare
  v_def text; v_mut text; s1 text; s2 text; s3 text; d text;
begin
  v_def := pg_get_functiondef('public.disconnect_instagram_account(uuid,uuid)'::regprocedure);
  begin
    grant execute on function public.get_instagram_account_token(uuid) to authenticated;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_23();
  exception
    when sqlstate 'P0R79' then s1 := sqlerrm;
    when others then s1 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    v_mut := replace(v_def,
      'perform vault.update_secret(v_secret_id, ''revoked-'' || gen_random_uuid()::text || gen_random_uuid()::text);', 'null;');
    if v_mut = v_def then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_23();
  exception
    when sqlstate 'P0R79' then s2 := sqlerrm;
    when others then s2 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    v_mut := replace(v_def, 'set token_secret_id = null,', 'set token_secret_id = a.token_secret_id,');
    if v_mut = v_def then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_23();
  exception
    when sqlstate 'P0R79' then s3 := sqlerrm;
    when others then s3 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  d := pg_temp.ig79_case_23();
  raise notice 'C-IG-2.3 token para authenticated: %', s1;
  raise notice 'C-IG-2.3 sem sobrescrever: %', s2;
  raise notice 'C-IG-2.3 sem zerar ponteiro: %', s3;
  insert into t_res values (7932, 'C-IG-2.3 token executavel por authenticated, disconnect sem sobrescrever o Vault e sem zerar o ponteiro: IG-2.3 reprova nos tres; restaurado passa',
    case when s1 like 'FALHOU%exec_auth=tok-23-original-0001%authenticated_exec:public.get_instagram_account_token(uuid)%'
          and s2 like 'FALHOU%vault_sobrescrito=false%'
          and s3 like 'FALHOU%leitura3=revoked-%depois=disconnected|false%'
          and d = 'PASSOU'
          and not has_function_privilege('authenticated', 'public.get_instagram_account_token(uuid)', 'EXECUTE')
          and pg_get_functiondef('public.disconnect_instagram_account(uuid,uuid)'::regprocedure) = v_def then 'PASSOU'
         else 'FALHOU token_auth=' || s1 || ' sem_sobrescrever=' || s2 || ' sem_zerar=' || s3 || ' restaurado=' || d end);
end $$;

-- C-IG-2.4: (a) guarda sem a checagem da organização do cliente; (b) guarda
-- sem a checagem de unidade/organização da conta.
do $$
declare
  v_def text; v_mut text; s1 text; s2 text; d text;
begin
  v_def := pg_get_functiondef('public.instagram_contact_tenant_guard()'::regprocedure);
  begin
    v_mut := replace(v_def, 'if v_cust_org is distinct from new.organization_id then', 'if false then');
    if v_mut = v_def then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_24();
  exception
    when sqlstate 'P0R79' then s1 := sqlerrm;
    when others then s1 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    v_mut := replace(v_def,
      'if new.unit_id is distinct from v_acc_unit or new.organization_id is distinct from v_acc_org then', 'if false then');
    if v_mut = v_def then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_24();
  exception
    when sqlstate 'P0R79' then s2 := sqlerrm;
    when others then s2 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  d := pg_temp.ig79_case_24();
  raise notice 'C-IG-2.4 sem org do cliente: %', s1;
  raise notice 'C-IG-2.4 sem coerencia com a conta: %', s2;
  insert into t_res values (7933, 'C-IG-2.4 guarda do contato sem a org do cliente e sem a coerencia com a conta: IG-2.4 reprova nos dois; restaurada passa',
    case when s1 like 'FALHOU%cliente_outra_org=1%'
          and s2 like 'FALHOU%contato_unidade_B=1%contato_conta_B=1%'
          and d = 'PASSOU'
          and pg_get_functiondef('public.instagram_contact_tenant_guard()'::regprocedure) = v_def then 'PASSOU'
         else 'FALHOU sem_org_cliente=' || s1 || ' sem_coerencia_conta=' || s2 || ' restaurado=' || d end);
end $$;

-- C-IG-2.5: (a) guarda do ledger sem a cláusula de unidade; (b) sem a
-- cláusula de cliente.
do $$
declare
  v_def text; v_mut text; s1 text; s2 text; d text;
begin
  v_def := pg_get_functiondef('public.record_instagram_contact_reservation(uuid,uuid)'::regprocedure);
  begin
    v_mut := replace(v_def, 'or v_r_unit is distinct from v_c_unit', '');
    if v_mut = v_def then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_25();
  exception
    when sqlstate 'P0R79' then s1 := sqlerrm;
    when others then s1 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    v_mut := replace(v_def, 'or v_c_cust is null or v_r_cust is distinct from v_c_cust', '');
    if v_mut = v_def then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_25();
  exception
    when sqlstate 'P0R79' then s2 := sqlerrm;
    when others then s2 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  d := pg_temp.ig79_case_25();
  raise notice 'C-IG-2.5 sem unidade: %', s1;
  raise notice 'C-IG-2.5 sem cliente: %', s2;
  insert into t_res values (7934, 'C-IG-2.5 guarda do ledger sem a clausula de unidade e sem a de cliente: IG-2.5 reprova nos dois; restaurada passa',
    case when s1 like 'FALHOU outra_unidade=ok%'
          and s2 like 'FALHOU%outro_cliente=ok%'
          and d = 'PASSOU'
          and pg_get_functiondef('public.record_instagram_contact_reservation(uuid,uuid)'::regprocedure) = v_def then 'PASSOU'
         else 'FALHOU sem_unidade=' || s1 || ' sem_cliente=' || s2 || ' restaurado=' || d end);
end $$;

-- C-IG-2.6: (a) trigger sem o `when` (dispara em qualquer UPDATE que cite
-- deleted_at); (b) função sem o filtro do cliente.
do $$
declare
  v_def text; v_mut text; v_trg0 text; v_trg text; s1 text; s2 text; d text;
begin
  v_def := pg_get_functiondef('public.instagram_contacts_anonymize_on_customer()'::regprocedure);
  select pg_get_triggerdef(t.oid) into v_trg0 from pg_trigger t
   where t.tgrelid = 'public.customers'::regclass and t.tgname = 'instagram_contacts_anonymize_on_customer_trg';
  begin
    if v_trg0 is null or v_trg0 not like '%WHEN (%(old.deleted_at IS NULL) AND (new.deleted_at IS NOT NULL)%' then
      raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE ' || coalesce(v_trg0, '<sem trigger>');
    end if;
    drop trigger instagram_contacts_anonymize_on_customer_trg on public.customers;
    create trigger instagram_contacts_anonymize_on_customer_trg
      after update of deleted_at on public.customers
      for each row execute function public.instagram_contacts_anonymize_on_customer();
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_26();
  exception
    when sqlstate 'P0R79' then s1 := sqlerrm;
    when others then s1 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    v_mut := replace(v_def, 'where c.customer_id = new.id', 'where true');
    if v_mut = v_def then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_26();
  exception
    when sqlstate 'P0R79' then s2 := sqlerrm;
    when others then s2 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  d := pg_temp.ig79_case_26();
  raise notice 'C-IG-2.6 sem when: %', s1;
  raise notice 'C-IG-2.6 sem filtro de cliente: %', s2;
  select pg_get_triggerdef(t.oid) into v_trg from pg_trigger t
   where t.tgrelid = 'public.customers'::regclass and t.tgname = 'instagram_contacts_anonymize_on_customer_trg';
  insert into t_res values (7935, 'C-IG-2.6 trigger sem o when e funcao sem o filtro do cliente: IG-2.6 reprova nos dois; restaurado passa',
    case when s1 like 'FALHOU%contato_y=igsid-26y|user_y|Nome Y|false%contato_y_depois=<null>|<null>|<null>|true%'
          and s2 like 'FALHOU%contato_y=<null>|<null>|<null>|true%'
          and d = 'PASSOU' and v_trg = v_trg0
          and pg_get_functiondef('public.instagram_contacts_anonymize_on_customer()'::regprocedure) = v_def then 'PASSOU'
         else 'FALHOU sem_when=' || s1 || ' sem_filtro=' || s2 || ' restaurado=' || d end);
end $$;

-- ─── Resultado ───────────────────────────────────────────────────────────────
select ord, caso, veredito from t_res where ord between 7901 and 7999 order by ord;
select count(*) as total, count(*) filter (where veredito = 'PASSOU') as passou
  from t_res where ord between 7901 and 7999;   -- esperado: 24 e 24

do $$
declare v_total int; v_ok int;
begin
  select count(*), count(*) filter (where veredito = 'PASSOU') into v_total, v_ok
    from t_res where ord between 7901 and 7999;
  if v_total <> 24 or v_ok <> 24 then
    raise exception '79: esperado 24 e 24, obtido % e %', v_total, v_ok;
  end if;
end $$;
