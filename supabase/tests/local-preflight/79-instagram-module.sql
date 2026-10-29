-- 79: pré-voo do módulo Instagram (Fase 1), ordinais 7901–7999.
--
-- Task 1.1 (migration 20261029200000_instagram_module_grants.sql):
--   casos IG-1.1..IG-1.6 (7901–7906) e um controle positivo por caso,
--   C-IG-1.1..C-IG-1.6 (7908–7913). 7907 fica livre (7914–7917 são da 1.6).
-- Task 1.2 (migration 20261029200100_instagram_accounts_contacts.sql):
--   casos IG-2.1..IG-2.6 (7920–7925) e IG-2.7..IG-2.10 (7926–7929, fix
--   round 1: auditoria, ponteiro do Vault preso ao nome, soft delete direto
--   e normalização), com um controle positivo por caso, C-IG-2.1..C-IG-2.6
--   (7930–7935) e C-IG-2.7..C-IG-2.10 (7936–7939).
-- Task 1.3 (migration 20261029200200_instagram_inbound_queue.sql):
--   casos IG-3.1..IG-3.8 (7940–7947) e um controle positivo por caso,
--   C-IG-3.1..C-IG-3.8 (7950–7957). Fix round 1: os fixes 1–4 estendem
--   IG-3.1/3.3/3.5/3.6 e os controles deles; o fix 5 é o IG-3.8.
--   7948–7949 e 7958–7959 ficam livres.
-- Task 1.4 (migration 20261029200300_conversations_instagram_channel.sql):
--   casos IG-4.1..IG-4.7 (7960–7966) e um controle positivo por caso,
--   C-IG-4.1..C-IG-4.7 (7970–7976). Fix round 1: IG-4.8 (7967) e
--   C-IG-4.8 (7978); o IG-4.4 e o C-IG-4.4 crescem no lugar (unidade
--   imutável e cliente da conversa IG = cliente do contato). 7968–7969,
--   7977 e 7979 ficam livres.
-- Task 1.5 (migrations 20261029200400_reservations_source_instagram.sql e
--   20261029200500_instagram_cron.sql; a de cron não roda aqui, sem pg_cron,
--   e é lida como texto pelo gêmeo): casos IG-5.1..IG-5.2 (7980–7981) e um
--   controle positivo por caso, C-IG-5.1..C-IG-5.2 (7990–7991). Fix round 1:
--   IG-5.3 (7982), a guarda de drift da migration (reaplicada via \ir),
--   com controle positivo manual (README §79). Base:
--   `reservations.source` e `notification_outbox` + trigger da 028 no 79a
--   (seção 3c). 7983–7989 ficam livres.
-- Task 1.6 (fix round 1 dos gates; migrations 120000/120100/120200/120300
--   editadas no lugar): casos IG-6.1..IG-6.4 (7914–7917) e um controle
--   positivo por caso, C-IG-6.1..C-IG-6.4 (7992–7995): autorização no SQL de
--   store/disconnect, contatos só por RPC/trigger DEFINER e anonimização
--   irreversível, conversa IG sem wa_chat_lid. O IG-2.1 passa a conferir
--   service_role só com SELECT em contatos. 7918–7919 e 7996–7999 livres.
--
-- BASE (banco próprio `ig79`, README seção 79):
--   00 -> 01 -> 09a -> 106 -> 79a -> 20260905143453 -> 20261017160000
--   -> [migrations do Instagram] -> 79.
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
    raise exception '79: objetos do modulo Instagram ausentes (unit_module_grants, instagram_settings, set_unit_module_grant, get_unit_modules). Aplique a migration 20261029200000_instagram_module_grants antes (sem ela, este abort e o RED esperado).';
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
    raise exception '79: objetos da conta/contato do Instagram ausentes (instagram_accounts, instagram_contacts, instagram_contact_reservations e as RPCs). Aplique a migration 20261029200100_instagram_accounts_contacts antes (sem ela, este abort e o RED esperado).';
  end if;
  if to_regclass('public.instagram_inbound_events') is null
     or to_regclass('public.instagram_processed_messages') is null
     or to_regprocedure('public.claim_instagram_inbound_event(uuid)') is null
     or to_regprocedure('public.finalize_instagram_inbound_event(uuid,uuid,text,text,text,integer)') is null
     or to_regprocedure('public.select_due_instagram_inbound_events(integer)') is null
     or to_regprocedure('public.purge_instagram_inbound_events()') is null
     or to_regprocedure('public.claim_instagram_message(uuid,text)') is null
     or to_regprocedure('public.complete_instagram_message(uuid,text,uuid,text,text,jsonb)') is null
     or to_regprocedure('public.record_instagram_message_outcome(uuid,text,text,jsonb)') is null
     or to_regprocedure('public.purge_instagram_processed_messages()') is null
     or to_regprocedure('public.get_instagram_diagnostics(uuid)') is null
     or to_regprocedure('public.instagram_queue_tenant_guard()') is null
     or to_regprocedure('public.trigger_instagram_inbound_sweep()') is null
     or to_regprocedure('public.trigger_instagram_token_refresh()') is null then
    raise exception '79: objetos da fila de inbound do Instagram ausentes (instagram_inbound_events, instagram_processed_messages, RPCs de claim/finalize/purga, diagnostico e wrappers). Aplique a migration 20261029200200_instagram_inbound_queue antes (sem ela, este abort e o RED esperado).';
  end if;
  if to_regclass('public.conversations') is null
     or to_regclass('public.whatsapp_automation_jobs') is null
     or to_regprocedure('public.append_conversation_message(uuid,jsonb)') is null then
    raise exception '79 exige o 79a da Task 1.4 (conversations, stub de whatsapp_automation_jobs) e a migration 20260905143453 aplicados antes (README, secao 79).';
  end if;
  if not exists (select 1 from pg_attribute where attrelid = 'public.conversations'::regclass and attname = 'channel' and not attisdropped)
     or not exists (select 1 from pg_attribute where attrelid = 'public.conversations'::regclass and attname = 'instagram_contact_id' and not attisdropped)
     or to_regprocedure('public.get_or_create_instagram_conversation(uuid)') is null
     or to_regprocedure('public.link_instagram_contact_customer(uuid,uuid)') is null
     or to_regprocedure('public.conversations_channel_guard()') is null
     or to_regprocedure('public.conversations_clear_instagram_contact_name()') is null
     or to_regprocedure('app_private.reconcile_whatsapp_automation_acceptance_inner(uuid)') is null then
    raise exception '79: objetos de conversa do Instagram ausentes (conversations.channel, conversations.instagram_contact_id, get_or_create_instagram_conversation, link_instagram_contact_customer, conversations_channel_guard, reconcile inner). Aplique a migration 20261029200300_conversations_instagram_channel antes (sem ela, este abort e o RED esperado).';
  end if;
  if to_regclass('public.notification_outbox') is null
     or to_regprocedure('public.enqueue_confirmation_notification()') is null
     or not exists (select 1 from pg_attribute where attrelid = 'public.reservations'::regclass and attname = 'source' and not attisdropped) then
    raise exception '79 exige o 79a da Task 1.5 (reservations.source, notification_outbox e o trigger de confirmacao da 028; README, secao 79).';
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.reservations'::regclass and conname = 'reservations_source_check'
                    and pg_get_constraintdef(oid) like '%''instagram''%') then
    raise exception '79: reservations_source_check sem a origem instagram. Aplique a migration 20261029200400_reservations_source_instagram antes (sem ela, este abort e o RED esperado).';
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

-- Texto sem CR. Com core.autocrlf=true (checkout no Windows) as migrations
-- chegam ao psql em CRLF e o corpo no catálogo (pg_get_functiondef/prosrc)
-- carrega os CRs; os trechos dos controles são LF. Todo controle que muta um
-- corpo por replace() procura o trecho (e confere "uma vez só"/TRECHO
-- AUSENTE) no corpo SEM CR e executa o texto LF sabotado; a restauração é o
-- rollback da subtransação, que devolve o corpo original byte a byte (com os
-- CRs), e por isso a comparação final com o catálogo usa o texto como lido.
create or replace function pg_temp.ig79_lf(p text)
returns text language sql immutable as $$
  select replace(p, E'\r', '')
$$;

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

-- SQL de store_instagram_account_connection (vencimento em 60 dias), SEM
-- efeito colateral: o IG-6.1 mede a autorização com ele.
create or replace function pg_temp.ig79_store_raw(p_unit uuid, p_ig text, p_user text, p_token text, p_actor uuid)
returns text language sql as $$
  select format('select public.store_instagram_account_connection(%L::uuid, %L, %L, ''BUSINESS'', %L, now() + interval ''60 days'', %L::uuid)::text',
                p_unit, p_ig, p_user, p_token, p_actor)
$$;

-- O mesmo SQL, e ANTES (como postgres, dentro da subtransação do caso, desfeito
-- com ela) garante um grant ativo do módulo na unidade: desde a Task 1.6 a RPC
-- exige o módulo liberado (IG-6.1). Os casos das Tasks 1.2–1.5 medem outras
-- coisas e conectam sempre com owner/gerente da unidade, então só precisam do
-- grant. Unidade inexistente: nada é gravado e a RPC recusa como antes.
create or replace function pg_temp.ig79_store(p_unit uuid, p_ig text, p_user text, p_token text, p_actor uuid)
returns text language plpgsql as $$
begin
  insert into public.unit_module_grants (organization_id, unit_id, module, granted_by)
  select u.organization_id, u.id, 'instagram', 'a0d79000-0000-4000-8000-0000000000c1'
    from public.units u where u.id = p_unit
  on conflict do nothing;
  return pg_temp.ig79_store_raw(p_unit, p_ig, p_user, p_token, p_actor);
end $$;

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
-- instagram_contact_reservations (42501); service_role lê contas mas o UPDATE
-- direto dá 42501. Catálogo: FORCE RLS nas três, contas e ledger sem policy e
-- sem privilégio para anon/authenticated e só SELECT para service_role,
-- contatos só com SELECT para authenticated e para service_role (Task 1.6).
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
  sel_acc text; sel_led text; sv_sel text; sv_upd text; ruins text := ''; r text;
begin
  begin
    acc_a := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ua, '79210001', 'loja_a', 'tok-21-A-000001', owner_a)));
    acc_b := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ub, '79210002', 'loja_b', 'tok-21-B-000001', ger_b)));
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
    -- service_role lê contas, mas não escreve direto (só pelas RPCs).
    sv_sel := pg_temp.ig79_q('service_role', null,
      format('select count(*)::text from public.instagram_accounts where unit_id in (%L::uuid, %L::uuid)', ua, ub));
    sv_upd := pg_temp.ig79_q('service_role', null,
      'with u as (update public.instagram_accounts set username = username returning 1) select count(*)::text from u');

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
    foreach r in array array['public.instagram_accounts', 'public.instagram_contact_reservations'] loop
      if not has_table_privilege('service_role', r, 'SELECT') then ruins := ruins || ' service_sem_select:' || r; end if;
      if has_table_privilege('service_role', r, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         or has_any_column_privilege('service_role', r, 'INSERT,UPDATE,REFERENCES') then
        ruins := ruins || ' service_escreve:' || r;
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
    -- Task 1.6: contatos só por RPC/trigger DEFINER; service_role só LÊ.
    if not has_table_privilege('service_role', 'public.instagram_contacts', 'SELECT') then ruins := ruins || ' service_sem_select_contacts'; end if;
    if has_table_privilege('service_role', 'public.instagram_contacts', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       or has_any_column_privilege('service_role', 'public.instagram_contacts', 'INSERT,UPDATE,REFERENCES') then
      ruins := ruins || ' service_escreve_contacts';
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
            and sv_sel = '2'
            and sv_upd like 'ERR 42501:permission denied for table instagram_accounts%'
            and dis = 'ok' and st_vazio = '0:'
            and ruins = '' then 'PASSOU'
           else 'FALHOU contas=' || coalesce(acc_a::text, '<null>') || '/' || coalesce(acc_b::text, '<null>')
                || ' assinatura=' || sub || ' contatos=' || k_a || '/' || k_b
                || ' opA_le_B=' || r_ab || ' opA_le_A=' || r_aa || ' ownerA_le_AB=' || r_a_tudo
                || ' gerB_le_AB=' || r_b_tudo || ' pa_le_AB=' || r_pa
                || ' status_A->B=' || st_ab || ' status_A->inexistente=' || st_gh || ' status_sem_sub=' || st_ns
                || ' status_opA=' || st_aa || ' status_pa->B=' || st_pb || ' status_anon=' || st_anon
                || ' select_accounts=' || sel_acc || ' select_ledger=' || sel_led
                || ' service_le_accounts=' || sv_sel || ' service_update_accounts=' || sv_upd
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
    x_b := pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ub, '79220001', 'conta_x', 'tok-22-xB-00001', ger_b));
    em_uso := pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ua, '79220001', 'conta_x', 'tok-22-xA-00001', owner_a));

    y1 := pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ua, '79220002', 'conta_y', 'tok-22-yA-00001', owner_a));
    y2 := pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ua, '79220002', 'conta_y2', 'tok-22-yA-00002', owner_a));
    select a.username || '|' || a.status into y_apos_y2 from public.instagram_accounts a where a.id = pg_temp.ig79_uuid(y1);
    tok_y2 := pg_temp.ig79_q('service_role', null, format('select public.get_instagram_account_token(%L::uuid)', pg_temp.ig79_uuid(y1)));
    select count(*) into n_y from public.instagram_accounts a where a.unit_id = ua and a.ig_user_id = '79220002';

    z := pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ua, '79220003', 'conta_z', 'tok-22-zA-00001', owner_a));
    select a.status || '|' || (a.token_secret_id is null) || '|' || (a.disconnected_at is not null)
      into y_apos_z from public.instagram_accounts a where a.id = pg_temp.ig79_uuid(y1);
    select coalesce(string_agg(a.id::text, ','), '<nenhuma>') into ativos_a_z
      from public.instagram_accounts a where a.unit_id = ua and a.status <> 'disconnected';

    dis := pg_temp.ig79_q('service_role', null, pg_temp.ig79_void(format(
      'public.disconnect_instagram_account(%L::uuid, %L::uuid)', pg_temp.ig79_uuid(x_b), ger_b)));
    x_a := pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ua, '79220001', 'conta_x', 'tok-22-xA-00002', owner_a));
    select a.status || '|' || a.organization_id || '|' || a.connected_by into x_a_estado
      from public.instagram_accounts a where a.id = pg_temp.ig79_uuid(x_a);
    select a.status into z_apos_x from public.instagram_accounts a where a.id = pg_temp.ig79_uuid(z);

    y3 := pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ua, '79220002', 'conta_y3', 'tok-22-yA-00003', owner_a));
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
    acc := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ua, '79230001', 'conta_t', t1, owner_a)));
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
    acc := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ua, '79240001', 'conta_a', 'tok-24-A-000001', owner_a)));
    acc_b := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ub, '79240002', 'conta_b', 'tok-24-B-000001', ger_b)));
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
      'values (%L, %L, ''79240003'', %L) returning 1) select count(*)::text from i', org_b, ua, owner_a));

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
  sv_ins text; sv_sel text;
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
    acc := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ua, '79250001', 'conta_25', 'tok-25-A-000001', owner_a)));
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
    -- service_role não grava o ledger direto (a RPC é o único caminho), mas lê.
    sv_ins := pg_temp.ig79_q('service_role', null, format(
      'with i as (insert into public.instagram_contact_reservations (reservation_id, instagram_contact_id, unit_id) '
      'values (%L, %L, %L) returning 1) select count(*)::text from i', r_cli, k, ua));
    sv_sel := pg_temp.ig79_q('service_role', null, format(
      'select count(*)::text from public.instagram_contact_reservations where reservation_id = %L::uuid', r_ok));
    select coalesce(string_agg(l.instagram_contact_id || '|' || l.unit_id, ','), '<nenhuma>') into led
      from public.instagram_contact_reservations l where l.reservation_id = r_ok;
    select count(*) into n_ruins from public.instagram_contact_reservations l
     where l.reservation_id in (r_unid, r_cli, r_ghost) or l.instagram_contact_id = k_sem;

    raise exception using errcode = 'P0R79', message =
      case when acc is not null and k is not null and k_sem is not null
            and e_unid = f and e_cli = f and e_sem = f and e_ghost = f
            and ok1 = 'ok' and ok2 = 'ok'
            and led = k || '|' || ua and n_ruins = 0
            and sv_ins like 'ERR 42501:permission denied for table instagram_contact_reservations%'
            and sv_sel = '1' then 'PASSOU'
           else 'FALHOU outra_unidade=' || e_unid || ' outro_cliente=' || e_cli || ' contato_sem_cliente=' || e_sem
                || ' reserva_inexistente=' || e_ghost || ' valido=' || ok1 || ' repetido=' || ok2
                || ' ledger=' || led || ' linhas_indevidas=' || n_ruins
                || ' service_insere_ledger=' || sv_ins || ' service_le_ledger=' || sv_sel end;
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
    acc := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ua, '79260001', 'conta_26', 'tok-26-A-000001', owner_a)));
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

-- ─── IG-2.7: trilha de auditoria da conta ──────────────────────────────────
-- Conectar (INSERT), reconectar e desconectar deixam linhas no audit_log da
-- conta; a desconexão grava disconnected_by = ator (também em new_values,
-- porque o actor_id do audit_log é nulo sob service_role). Reconectar limpa
-- disconnected_by e carimba connected_by.
create or replace function pg_temp.ig79_case_27() returns text language plpgsql as $f$
declare
  ua constant uuid := 'a0d79000-0000-4000-8000-0000000000aa';
  owner_a constant uuid := 'a0d79000-0000-4000-8000-0000000000a1';
  ger_a constant uuid := 'a0d79000-0000-4000-8000-0000000000a2';
  acc uuid; a0 bigint; c2 text; d text; c3 text;
  n1 int; n_ins int; n2 int; n3 int; n4 int; ult text; col1 text; col2 text;
begin
  begin
    select coalesce(max(id), 0) into a0 from public.audit_log;
    acc := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ua, '79270001', 'conta_27', 'tok-27-A-000001', owner_a)));
    select count(*), count(*) filter (where action = 'INSERT') into n1, n_ins
      from public.audit_log where id > a0 and table_name = 'instagram_accounts' and record_id = acc::text;

    c2 := pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ua, '79270001', 'conta_27b', 'tok-27-A-000002', owner_a));
    select count(*) into n2 from public.audit_log where id > a0 and table_name = 'instagram_accounts' and record_id = acc::text;

    d := pg_temp.ig79_q('service_role', null, pg_temp.ig79_void(format(
      'public.disconnect_instagram_account(%L::uuid, %L::uuid)', acc, ger_a)));
    select count(*) into n3 from public.audit_log where id > a0 and table_name = 'instagram_accounts' and record_id = acc::text;
    select l.action || '|' || coalesce(l.new_values->>'status', '<null>') || '|' || coalesce(l.new_values->>'disconnected_by', '<null>')
      into ult from public.audit_log l
     where l.id > a0 and l.table_name = 'instagram_accounts' and l.record_id = acc::text
     order by l.id desc limit 1;
    select a.status || '|' || coalesce(a.disconnected_by::text, '<null>') into col1
      from public.instagram_accounts a where a.id = acc;

    c3 := pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ua, '79270001', 'conta_27c', 'tok-27-A-000003', owner_a));
    select count(*) into n4 from public.audit_log where id > a0 and table_name = 'instagram_accounts' and record_id = acc::text;
    select a.status || '|' || coalesce(a.disconnected_by::text, '<null>') || '|' || a.connected_by into col2
      from public.instagram_accounts a where a.id = acc;

    raise exception using errcode = 'P0R79', message =
      case when acc is not null and n1 >= 1 and n_ins = 1
            and c2 = acc::text and n2 > n1
            and d = 'ok' and n3 > n2
            and ult = 'UPDATE|disconnected|' || ger_a and col1 = 'disconnected|' || ger_a
            and c3 = acc::text and n4 > n3 and col2 = 'connected|<null>|' || owner_a then 'PASSOU'
           else 'FALHOU conta=' || coalesce(acc::text, '<null>') || ' audit_conectar=' || n1 || '/insert=' || n_ins
                || ' reconectar=' || c2 || ' audit_reconectar=' || n2 || ' desconectar=' || d || ' audit_desconectar=' || n3
                || ' ultima=' || coalesce(ult, '<null>') || ' coluna=' || coalesce(col1, '<null>')
                || ' reconectar2=' || c3 || ' audit_reconectar2=' || n4 || ' depois=' || coalesce(col2, '<null>') end;
  exception
    when sqlstate 'P0R79' then return sqlerrm;
    when others then return 'FALHOU erro inesperado ' || sqlstate || ':' || sqlerrm;
  end;
end $f$;

-- ─── IG-2.8: ponteiro do Vault preso ao nome da conta ───────────────────────
-- Com token_secret_id apontado (como postgres) para um segredo alheio
-- (`internal_api_key`): leitura, renovação, reconexão e desconexão recebem
-- 42501 instagram_account_secret_mismatch, e o segredo alheio fica intacto
-- (valor e nome), assim como o próprio segredo da conta.
create or replace function pg_temp.ig79_case_28() returns text language plpgsql as $f$
declare
  ua constant uuid := 'a0d79000-0000-4000-8000-0000000000aa';
  owner_a constant uuid := 'a0d79000-0000-4000-8000-0000000000a1';
  t1 constant text := 'tok-28-original-0001';
  alheio constant text := 'ig79-foreign-value-0001';
  mm constant text := 'ERR 42501:instagram_account_secret_mismatch';
  acc uuid; f_id uuid; s_id uuid; g text; rf text; st text; d text; f_est text; s_val text; ptr text;
begin
  begin
    f_id := vault.create_secret(alheio, 'internal_api_key', 'ig79 segredo alheio');
    acc := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ua, '79280001', 'conta_28', t1, owner_a)));
    select a.token_secret_id into s_id from public.instagram_accounts a where a.id = acc;
    update public.instagram_accounts set token_secret_id = f_id where id = acc;

    g := pg_temp.ig79_q('service_role', null, format('select public.get_instagram_account_token(%L::uuid)', acc));
    rf := pg_temp.ig79_q('service_role', null, pg_temp.ig79_void(format(
      'public.record_instagram_token_refresh(%L::uuid, ''tok-28-novo-0002'', now() + interval ''60 days'')', acc)));
    st := pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ua, '79280001', 'conta_28', 'tok-28-novo-0003', owner_a));
    d := pg_temp.ig79_q('service_role', null, pg_temp.ig79_void(format(
      'public.disconnect_instagram_account(%L::uuid, %L::uuid)', acc, owner_a)));

    select ds.decrypted_secret || '|' || ds.name into f_est from vault.decrypted_secrets ds where ds.id = f_id;
    select ds.decrypted_secret into s_val from vault.decrypted_secrets ds where ds.id = s_id;
    select a.status || '|' || (a.token_secret_id = f_id) into ptr from public.instagram_accounts a where a.id = acc;

    raise exception using errcode = 'P0R79', message =
      case when acc is not null and s_id is not null
            and g = mm and rf = mm and st = mm and d = mm
            and f_est = alheio || '|internal_api_key'
            and s_val = t1 and ptr = 'connected|true' then 'PASSOU'
           else 'FALHOU getter=' || g || ' refresh=' || rf || ' store=' || st || ' disconnect=' || d
                || ' alheio=' || coalesce(f_est, '<null>') || ' proprio=' || coalesce(s_val, '<null>')
                || ' conta=' || coalesce(ptr, '<null>') end;
  exception
    when sqlstate 'P0R79' then return sqlerrm;
    when others then return 'FALHOU erro inesperado ' || sqlstate || ':' || sqlerrm;
  end;
end $f$;

-- ─── IG-2.9: soft delete direto por authenticated anonimiza o contato ──────
-- O owner de A, com papel real + claims, faz `update customers set
-- deleted_at = now()` direto (o caminho PostgREST, sem anonymize_customer).
-- O trigger, SECURITY DEFINER, anonimiza o contato apesar de authenticated
-- não ter UPDATE em instagram_contacts.
create or replace function pg_temp.ig79_case_29() returns text language plpgsql as $f$
declare
  ua constant uuid := 'a0d79000-0000-4000-8000-0000000000aa';
  org_a constant uuid := 'a0d79000-0000-4000-8000-00000000000a';
  owner_a constant uuid := 'a0d79000-0000-4000-8000-0000000000a1';
  cz constant uuid := 'a0d79000-0000-4000-8000-000000002901';
  acc uuid; kz uuid; upd text; del text; kz_est text;
begin
  begin
    insert into public.customers (id, organization_id, name, phone) values (cz, org_a, 'ig79 cliente Z', '11990002901');
    acc := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ua, '79290001', 'conta_29', 'tok-29-A-000001', owner_a)));
    kz := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, format(
      'select public.upsert_instagram_contact(%L::uuid, ''igsid-29'', ''user_z'', ''Nome Z'')::text', acc)));
    update public.instagram_contacts set customer_id = cz, customer_linked_at = now() where id = kz;

    upd := pg_temp.ig79_q('authenticated', owner_a, format(
      'with u as (update public.customers set deleted_at = now() where id = %L returning 1) select count(*)::text from u', cz));
    select (c.deleted_at is not null)::text into del from public.customers c where c.id = cz;
    select coalesce(c.igsid, '<null>') || '|' || coalesce(c.username, '<null>') || '|' || coalesce(c.name, '<null>')
           || '|' || (c.anonymized_at is not null)
      into kz_est from public.instagram_contacts c where c.id = kz;

    raise exception using errcode = 'P0R79', message =
      case when acc is not null and kz is not null and upd = '1' and del = 'true'
            and kz_est = '<null>|<null>|<null>|true' then 'PASSOU'
           else 'FALHOU soft_delete=' || upd || ' apagado=' || coalesce(del, '<null>')
                || ' contato=' || coalesce(kz_est, '<null>') end;
  exception
    when sqlstate 'P0R79' then return sqlerrm;
    when others then return 'FALHOU erro inesperado ' || sqlstate || ':' || sqlerrm;
  end;
end $f$;

-- ─── IG-2.10: normalização, contato em conta desconectada e erro limpo ─────
-- ' 79300001' e '79300001' são a mesma conta (uma linha, ig_user_id sem
-- espaço, token gravado sem espaços nas pontas) e '79300001 ' em B é
-- instagram_account_in_use; ig_user_id não numérico recusado pela RPC (22023)
-- e pelo CHECK (23514). Voltar a connected limpa last_error_code. Contato em
-- conta reauth_required é aceito; em conta desconectada, 55000.
create or replace function pg_temp.ig79_case_30() returns text language plpgsql as $f$
declare
  ua constant uuid := 'a0d79000-0000-4000-8000-0000000000aa';
  ub constant uuid := 'a0d79000-0000-4000-8000-0000000000bb';
  org_a constant uuid := 'a0d79000-0000-4000-8000-00000000000a';
  owner_a constant uuid := 'a0d79000-0000-4000-8000-0000000000a1';
  ger_b constant uuid := 'a0d79000-0000-4000-8000-0000000000b2';
  na constant text := 'ERR 55000:instagram_account_not_active';
  a1 text; tk1 text; igv text; a2 text; n int; em_uso text; ruim text; chk text;
  s1 text; st1 text; s2 text; le text; s3 text; k1 text; d text; k2 text; k3 text;
begin
  begin
    a1 := pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ua, ' 79300001', 'conta_30', '  tok-30-A-000001  ', owner_a));
    tk1 := pg_temp.ig79_q('service_role', null, format('select public.get_instagram_account_token(%L::uuid)', pg_temp.ig79_uuid(a1)));
    select a.ig_user_id into igv from public.instagram_accounts a where a.id = pg_temp.ig79_uuid(a1);
    a2 := pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ua, '79300001', 'conta_30', 'tok-30-A-000002', owner_a));
    select count(*) into n from public.instagram_accounts a where a.ig_user_id like '%79300001%';
    em_uso := pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ub, '79300001 ', 'conta_30', 'tok-30-B-000001', ger_b));
    ruim := pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ua, '7930abc', 'conta_30', 'tok-30-A-000003', owner_a));
    chk := pg_temp.ig79_q(null, null, format(
      'with i as (insert into public.instagram_accounts (organization_id, unit_id, ig_user_id, status, connected_by) '
      'values (%L, %L, ''7930x'', ''disconnected'', %L) returning 1) select count(*)::text from i', org_a, ua, owner_a));

    s1 := pg_temp.ig79_q('service_role', null, pg_temp.ig79_void(format(
      'public.set_instagram_account_status(%L::uuid, ''reauth_required'', ''expired'')', pg_temp.ig79_uuid(a1))));
    st1 := pg_temp.ig79_q('authenticated', owner_a, pg_temp.ig79_status(ua));
    s2 := pg_temp.ig79_q('service_role', null, pg_temp.ig79_void(format(
      'public.set_instagram_account_status(%L::uuid, ''connected'', ''ignorado'')', pg_temp.ig79_uuid(a1))));
    select coalesce(a.last_error_code, '<null>') into le from public.instagram_accounts a where a.id = pg_temp.ig79_uuid(a1);

    s3 := pg_temp.ig79_q('service_role', null, pg_temp.ig79_void(format(
      'public.set_instagram_account_status(%L::uuid, ''reauth_required'', ''expired'')', pg_temp.ig79_uuid(a1))));
    k1 := pg_temp.ig79_q('service_role', null, format(
      'select public.upsert_instagram_contact(%L::uuid, ''igsid-30a'', ''user30'', null)::text', pg_temp.ig79_uuid(a1)));
    d := pg_temp.ig79_q('service_role', null, pg_temp.ig79_void(format(
      'public.disconnect_instagram_account(%L::uuid, %L::uuid)', pg_temp.ig79_uuid(a1), owner_a)));
    k2 := pg_temp.ig79_q('service_role', null, format(
      'select public.upsert_instagram_contact(%L::uuid, ''igsid-30b'', ''user30b'', null)::text', pg_temp.ig79_uuid(a1)));
    k3 := pg_temp.ig79_q('service_role', null, format(
      'select public.upsert_instagram_contact(%L::uuid, ''igsid-30a'', ''user30'', null)::text', pg_temp.ig79_uuid(a1)));

    raise exception using errcode = 'P0R79', message =
      case when pg_temp.ig79_uuid(a1) is not null and tk1 = 'tok-30-A-000001' and igv = '79300001'
            and a2 = a1 and n = 1
            and em_uso = 'ERR P0001:instagram_account_in_use'
            and ruim = 'ERR 22023:invalid_instagram_account_argument'
            and chk like 'ERR 23514:%instagram_accounts_ig_user_id_chk%'
            and s1 = 'ok' and st1 = '1:conta_30/reauth_required/false/expired/true/true'
            and s2 = 'ok' and le = '<null>'
            and s3 = 'ok' and pg_temp.ig79_uuid(k1) is not null and d = 'ok'
            and k2 = na and k3 = na then 'PASSOU'
           else 'FALHOU a1=' || a1 || ' token1=' || tk1 || ' ig_user_id=' || coalesce(igv, '<null>')
                || ' a2=' || a2 || ' linhas=' || n || ' em_uso_B=' || em_uso || ' nao_numerico=' || ruim
                || ' check=' || chk || ' reauth=' || s1 || ' status=' || st1 || ' volta_connected=' || s2
                || ' last_error=' || coalesce(le, '<null>') || ' reauth2=' || s3 || ' contato_reauth=' || k1
                || ' desconectar=' || d || ' contato_novo_desconectada=' || k2 || ' contato_existente_desconectada=' || k3 end;
  exception
    when sqlstate 'P0R79' then return sqlerrm;
    when others then return 'FALHOU erro inesperado ' || sqlstate || ':' || sqlerrm;
  end;
end $f$;

-- ═══ Task 1.3: fila de inbound, ledger por mensagem e diagnóstico ══════════
-- `now()` é o instante da transação: dentro de um caso ele não anda, então
-- "lease vencido" e "idade" se fabricam movendo a coluna para o passado (como
-- postgres), nunca esperando.

-- SQL do INSERT de um evento (o que o webhook da Task 2.3 faz como
-- service_role): corpo em hex, sha256 calculado do mesmo corpo. Devolve o id.
create or replace function pg_temp.ig79_ev(p_acc uuid, p_unit uuid, p_body bytea, p_sig text)
returns text language sql as $$
  select format('with i as (insert into public.instagram_inbound_events '
                '(instagram_account_id, unit_id, raw_body, body_sha256, signature_secret) '
                'values (%L::uuid, %L::uuid, decode(%L, ''hex''), encode(sha256(decode(%L, ''hex'')), ''hex''), %L) '
                'returning id) select id::text from i',
                p_acc, p_unit, encode(p_body, 'hex'), encode(p_body, 'hex'), p_sig)
$$;

-- SQL do claim do evento: 'n:claim_id|attempts,…'.
create or replace function pg_temp.ig79_claim(p_ev uuid)
returns text language sql as $$
  select format('select count(*) || '':'' || coalesce(string_agg(c.claim_id::text || ''|'' || c.attempts, '',''), '''') '
                'from public.claim_instagram_inbound_event(%L::uuid) c', p_ev)
$$;

-- SQL do finalize: devolve o número de linhas que ele afirma ter escrito.
create or replace function pg_temp.ig79_fin(p_ev uuid, p_claim uuid, p_status text, p_outcome text, p_error text, p_delay integer)
returns text language sql as $$
  select format('select public.finalize_instagram_inbound_event(%L::uuid, %L::uuid, %L, %L, %L, %L::integer)::text',
                p_ev, p_claim, p_status, p_outcome, p_error, p_delay)
$$;

-- SQL das RPCs do ledger.
create or replace function pg_temp.ig79_mclaim(p_acc uuid, p_mid text)
returns text language sql as $$
  select format('select public.claim_instagram_message(%L::uuid, %L)::text', p_acc, p_mid)
$$;
create or replace function pg_temp.ig79_mdone(p_acc uuid, p_mid text, p_claim uuid, p_outcome text, p_meta jsonb)
returns text language sql as $$
  select format('select public.complete_instagram_message(%L::uuid, %L, %L::uuid, %L, null, %L::jsonb)::text',
                p_acc, p_mid, p_claim, p_outcome, p_meta)
$$;
create or replace function pg_temp.ig79_mrec(p_acc uuid, p_mid text, p_outcome text)
returns text language sql as $$
  select pg_temp.ig79_void(format('public.record_instagram_message_outcome(%L::uuid, %L, %L, ''{}''::jsonb)',
                p_acc, p_mid, p_outcome))
$$;

-- ─── IG-3.1: cerca do claim e do finalize do evento ─────────────────────────
-- O claim devolve conta, unidade, tentativas e o corpo cru byte a byte (com
-- \u0000 e acento). O segundo claim com o lease vivo devolve zero linhas; com
-- o lease vencido, o takeover entrega um claim_id NOVO e gasta uma tentativa.
-- O finalize com um uuid qualquer e com o claim antigo devolve 0 e não mexe
-- na linha; com o claim vigente devolve 1. Retentativa reagenda (a seleção
-- só a enxerga depois de devida), `last_error` sobrevive ao `done` sem erro
-- novo, e o `done` não é reivindicável nem refinalizável.
create or replace function pg_temp.ig79_case_31() returns text language plpgsql as $f$
declare
  ua constant uuid := 'a0d79000-0000-4000-8000-0000000000aa';
  owner_a constant uuid := 'a0d79000-0000-4000-8000-0000000000a1';
  corpo bytea := convert_to('{"object":"instagram","t":"', 'UTF8') || '\x00'::bytea || convert_to('é"}', 'UTF8');
  acc uuid; ev uuid; r1 text; c1 uuid; r2 text; f_rand text; r3 text; c2 uuid; f_old text; est_old text;
  f_proc text; f_bogus text; est_proc text;
  f_retry text; est_retry text; due1 text; due2 text; r4 text; c3 uuid; f_done text; est_done text; f_again text; r5 text;
begin
  begin
    acc := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ua, '79310001', 'conta_31', 'tok-31-A-000001', owner_a)));
    ev := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_ev(acc, ua, corpo, 'instagram')));

    r1 := pg_temp.ig79_q('service_role', null, format(
      'select string_agg(c.id || ''|'' || c.instagram_account_id || ''|'' || c.unit_id || ''|'' || c.attempts '
      '|| ''|'' || encode(c.raw_body, ''hex'') || ''|'' || c.claim_id, '','') '
      'from public.claim_instagram_inbound_event(%L::uuid) c', ev));
    c1 := pg_temp.ig79_uuid(split_part(r1, '|', 6));
    r2 := pg_temp.ig79_q('service_role', null, pg_temp.ig79_claim(ev));
    f_rand := pg_temp.ig79_q('service_role', null, pg_temp.ig79_fin(ev, gen_random_uuid(), 'done', 'processed', null, null));

    update public.instagram_inbound_events set claimed_until = now() - interval '1 second' where id = ev;
    r3 := pg_temp.ig79_q('service_role', null, pg_temp.ig79_claim(ev));
    c2 := pg_temp.ig79_uuid(split_part(split_part(r3, ':', 2), '|', 1));
    -- Fix 1: o finalize só aceita status de saída; `processing` e status
    -- desconhecido devolvem 0 e a linha fica com o claim e o lease vigentes.
    f_proc := pg_temp.ig79_q('service_role', null, pg_temp.ig79_fin(ev, c2, 'processing', 'x', null, null));
    f_bogus := pg_temp.ig79_q('service_role', null, pg_temp.ig79_fin(ev, c2, 'bogus', 'x', null, null));
    select e.status || '|' || coalesce((e.claim_id = c2)::text, '<null>') || '|' || (e.claimed_until is not null) into est_proc
      from public.instagram_inbound_events e where e.id = ev;
    f_old :=pg_temp.ig79_q('service_role', null, pg_temp.ig79_fin(ev, c1, 'done', 'processed', null, null));
    select e.status || '|' || (e.claim_id = c2) into est_old from public.instagram_inbound_events e where e.id = ev;

    f_retry := pg_temp.ig79_q('service_role', null, pg_temp.ig79_fin(ev, c2, 'received', 'transient', 'erro-31', 30));
    select e.status || '|' || e.attempts || '|' || (e.next_attempt_at > now() + interval '25 seconds')
           || '|' || (e.claim_id is null) || '|' || (e.claimed_until is null) || '|' || coalesce(e.last_error, '<null>')
      into est_retry from public.instagram_inbound_events e where e.id = ev;
    due1 := pg_temp.ig79_q('service_role', null, format(
      'select (%L::uuid in (select * from public.select_due_instagram_inbound_events(100)))::text', ev));
    update public.instagram_inbound_events set next_attempt_at = now() - interval '1 second' where id = ev;
    due2 := pg_temp.ig79_q('service_role', null, format(
      'select (%L::uuid in (select * from public.select_due_instagram_inbound_events(100)))::text', ev));

    r4 := pg_temp.ig79_q('service_role', null, pg_temp.ig79_claim(ev));
    c3 := pg_temp.ig79_uuid(split_part(split_part(r4, ':', 2), '|', 1));
    f_done := pg_temp.ig79_q('service_role', null, pg_temp.ig79_fin(ev, c3, 'done', 'processed', null, null));
    select e.status || '|' || e.outcome || '|' || e.attempts || '|' || (e.claim_id is null) || '|' || coalesce(e.last_error, '<null>')
      into est_done from public.instagram_inbound_events e where e.id = ev;
    f_again := pg_temp.ig79_q('service_role', null, pg_temp.ig79_fin(ev, c3, 'dead', 'x', null, null));
    r5 := pg_temp.ig79_q('service_role', null, pg_temp.ig79_claim(ev));

    raise exception using errcode = 'P0R79', message =
      case when acc is not null and ev is not null
            and r1 = ev || '|' || acc || '|' || ua || '|0|' || encode(corpo, 'hex') || '|' || c1 and c1 is not null
            and r2 = '0:' and f_rand = '0'
            and c2 is not null and c2 <> c1 and r3 = '1:' || c2 || '|1'
            and f_proc = '0' and f_bogus = '0' and est_proc = 'processing|true|true'
            and f_old = '0' and est_old = 'processing|true'
            and f_retry = '1' and est_retry = 'received|2|true|true|true|erro-31'
            and due1 = 'false' and due2 = 'true'
            and c3 is not null and r4 = '1:' || c3 || '|2'
            and f_done = '1' and est_done = 'done|processed|2|true|erro-31'
            and f_again = '0' and r5 = '0:' then 'PASSOU'
           else 'FALHOU claim1=' || coalesce(r1, '<null>') || ' claim2_lease_vivo=' || r2 || ' finalize_aleatorio=' || f_rand
                || ' takeover=' || r3 || ' finalize_processing=' || f_proc || ' finalize_status_desconhecido=' || f_bogus
                || ' estado_apos_processing=' || coalesce(est_proc, '<null>') || ' finalize_claim_antigo=' || f_old || ' estado=' || coalesce(est_old, '<null>')
                || ' retry=' || f_retry || ' estado_retry=' || coalesce(est_retry, '<null>')
                || ' devido_antes=' || due1 || ' devido_depois=' || due2 || ' claim3=' || r4
                || ' done=' || f_done || ' estado_done=' || coalesce(est_done, '<null>')
                || ' refinalizar=' || f_again || ' claim_done=' || r5 end;
  exception
    when sqlstate 'P0R79' then return sqlerrm;
    when others then return 'FALHOU erro inesperado ' || sqlstate || ':' || sqlerrm;
  end;
end $f$;

-- ─── IG-3.2: ledger por mensagem ────────────────────────────────────────────
-- claim duas vezes: a segunda devolve null. Lease vencido: claim novo, e o
-- complete com o claim antigo devolve false; com o vigente, true (done, com
-- outcome, meta e unidade da conta). done não é reivindicável. O registro de
-- eco/descarte grava done e não sobrescreve (nem a si mesmo nem uma mensagem
-- já concluída). mid vazio dá 22023 e conta inexistente P0002.
create or replace function pg_temp.ig79_case_32() returns text language plpgsql as $f$
declare
  ua constant uuid := 'a0d79000-0000-4000-8000-0000000000aa';
  ghost constant uuid := 'a0d79000-0000-4000-8000-0000000000ff';
  owner_a constant uuid := 'a0d79000-0000-4000-8000-0000000000a1';
  acc uuid; m1 text; m2 text; m3 text; c_old text; c_new text; est text; m4 text; c_again text;
  rec1 text; rec2 text; rec3 text; est_eco text; est_a text; m5 text; ruim text; fantasma text;
begin
  begin
    acc := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ua, '79320001', 'conta_32', 'tok-32-A-000001', owner_a)));
    m1 := pg_temp.ig79_q('service_role', null, pg_temp.ig79_mclaim(acc, 'mid-32-a'));
    m2 := pg_temp.ig79_q('service_role', null, pg_temp.ig79_mclaim(acc, 'mid-32-a'));

    update public.instagram_processed_messages set claimed_until = now() - interval '1 second'
     where instagram_account_id = acc and mid = 'mid-32-a';
    m3 := pg_temp.ig79_q('service_role', null, pg_temp.ig79_mclaim(acc, 'mid-32-a'));
    c_old := pg_temp.ig79_q('service_role', null, pg_temp.ig79_mdone(acc, 'mid-32-a', pg_temp.ig79_uuid(m1), 'replied', '{}'));
    c_new := pg_temp.ig79_q('service_role', null, pg_temp.ig79_mdone(acc, 'mid-32-a', pg_temp.ig79_uuid(m3), 'replied', '{"turns":1}'));
    select m.status || '|' || m.outcome || '|' || (m.claim_id is null) || '|' || (m.claimed_until is null)
           || '|' || (m.completed_at is not null) || '|' || m.unit_id || '|' || m.meta::text
      into est from public.instagram_processed_messages m where m.instagram_account_id = acc and m.mid = 'mid-32-a';
    m4 := pg_temp.ig79_q('service_role', null, pg_temp.ig79_mclaim(acc, 'mid-32-a'));
    c_again := pg_temp.ig79_q('service_role', null, pg_temp.ig79_mdone(acc, 'mid-32-a', pg_temp.ig79_uuid(m3), 'outro', '{}'));

    rec1 := pg_temp.ig79_q('service_role', null, pg_temp.ig79_mrec(acc, 'mid-32-eco', 'echo_own'));
    rec2 := pg_temp.ig79_q('service_role', null, pg_temp.ig79_mrec(acc, 'mid-32-eco', 'echo_unknown'));
    rec3 := pg_temp.ig79_q('service_role', null, pg_temp.ig79_mrec(acc, 'mid-32-a', 'echo_unknown'));
    select m.status || '|' || m.outcome || '|' || (m.completed_at is not null) || '|' || m.unit_id || '|' || (m.claim_id is null)
      into est_eco from public.instagram_processed_messages m where m.instagram_account_id = acc and m.mid = 'mid-32-eco';
    select m.outcome into est_a from public.instagram_processed_messages m where m.instagram_account_id = acc and m.mid = 'mid-32-a';
    m5 := pg_temp.ig79_q('service_role', null, pg_temp.ig79_mclaim(acc, 'mid-32-eco'));

    ruim := pg_temp.ig79_q('service_role', null, pg_temp.ig79_mclaim(acc, ''));
    fantasma := pg_temp.ig79_q('service_role', null, pg_temp.ig79_mclaim(ghost, 'mid-32-x'));

    raise exception using errcode = 'P0R79', message =
      case when acc is not null and pg_temp.ig79_uuid(m1) is not null
            and m2 = '<null>'
            and pg_temp.ig79_uuid(m3) is not null and m3 <> m1
            and c_old = 'false' and c_new = 'true'
            and est = 'done|replied|true|true|true|' || ua || '|{"turns": 1}'
            and m4 = '<null>' and c_again = 'false'
            and rec1 = 'ok' and rec2 = 'ok' and rec3 = 'ok'
            and est_eco = 'done|echo_own|true|' || ua || '|true' and est_a = 'replied'
            and m5 = '<null>'
            and ruim = 'ERR 22023:invalid_instagram_message_argument'
            and fantasma = 'ERR P0002:instagram_account_not_found' then 'PASSOU'
           else 'FALHOU claim1=' || m1 || ' claim2=' || m2 || ' retomada=' || m3
                || ' complete_antigo=' || c_old || ' complete_vigente=' || c_new || ' estado=' || coalesce(est, '<null>')
                || ' claim_done=' || m4 || ' complete_de_novo=' || c_again
                || ' eco=' || rec1 || '/' || rec2 || '/' || rec3 || ' estado_eco=' || coalesce(est_eco, '<null>')
                || ' outcome_a=' || coalesce(est_a, '<null>') || ' claim_eco=' || m5
                || ' mid_vazio=' || ruim || ' conta_inexistente=' || fantasma end;
  exception
    when sqlstate 'P0R79' then return sqlerrm;
    when others then return 'FALHOU erro inesperado ' || sqlstate || ':' || sqlerrm;
  end;
end $f$;

-- ─── IG-3.3: unidade do registro é a da conta; formato e dedupe ─────────────
-- service_role (o escritor real da fila) grava evento com a unidade da conta;
-- com a unidade de outra conta recebe 23514, e como postgres também (o guard
-- é a única barreira). Conta inexistente, mover de unidade e mover de conta:
-- 23514. sha256 fora do formato, sha256 de outro corpo (fix 2) e
-- signature_secret desconhecido: CHECK. O
-- mesmo corpo na mesma conta é 23505; na outra conta, entra. O ledger tem a
-- mesma guarda (INSERT direto com unidade alheia e UPDATE de unidade).
create or replace function pg_temp.ig79_case_33() returns text language plpgsql as $f$
declare
  ua constant uuid := 'a0d79000-0000-4000-8000-0000000000aa';
  ub constant uuid := 'a0d79000-0000-4000-8000-0000000000bb';
  ghost constant uuid := 'a0d79000-0000-4000-8000-0000000000ff';
  owner_a constant uuid := 'a0d79000-0000-4000-8000-0000000000a1';
  ger_b constant uuid := 'a0d79000-0000-4000-8000-0000000000b2';
  c1 bytea := convert_to('{"ig79":"corpo-33-1"}', 'UTF8');
  c2 bytea := convert_to('{"ig79":"corpo-33-2"}', 'UTF8');
  c3 bytea := convert_to('{"ig79":"corpo-33-3"}', 'UTF8');
  acc_a uuid; acc_b uuid; ok text; mv text; dup text; outra text; x_sv text; x_pg text; x_ghost text; x_hash text;
  x_move text; x_move_acc text; x_sha text; x_sig text; rec text; x_led text; x_led_move text; led_unit text;
begin
  begin
    acc_a := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ua, '79330001', 'conta_33a', 'tok-33-A-000001', owner_a)));
    acc_b := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ub, '79330002', 'conta_33b', 'tok-33-B-000001', ger_b)));

    ok := pg_temp.ig79_q('service_role', null, pg_temp.ig79_ev(acc_a, ua, c1, 'meta'));
    dup := pg_temp.ig79_q('service_role', null, pg_temp.ig79_ev(acc_a, ua, c1, 'instagram'));
    outra := pg_temp.ig79_q('service_role', null, pg_temp.ig79_ev(acc_b, ub, c1, 'instagram'));
    x_sv := pg_temp.ig79_q('service_role', null, pg_temp.ig79_ev(acc_a, ub, c2, 'instagram'));
    x_pg := pg_temp.ig79_q(null, null, pg_temp.ig79_ev(acc_b, ua, c2, 'instagram'));
    x_ghost := pg_temp.ig79_q(null, null, pg_temp.ig79_ev(ghost, ua, c2, 'instagram'));
    -- Linha só para as tentativas de mover (corpo que a conta B não tem).
    mv := pg_temp.ig79_q('service_role', null, pg_temp.ig79_ev(acc_a, ua, c3, 'instagram'));
    x_move := pg_temp.ig79_q(null, null, format(
      'with u as (update public.instagram_inbound_events set unit_id = %L where id = %L returning 1) select count(*)::text from u',
      ub, pg_temp.ig79_uuid(mv)));
    x_move_acc := pg_temp.ig79_q(null, null, format(
      'with u as (update public.instagram_inbound_events set instagram_account_id = %L, unit_id = %L where id = %L returning 1) select count(*)::text from u',
      acc_b, ub, pg_temp.ig79_uuid(mv)));
    x_sha := pg_temp.ig79_q(null, null, format(
      'with i as (insert into public.instagram_inbound_events (instagram_account_id, unit_id, raw_body, body_sha256, signature_secret) '
      'values (%L, %L, ''\x7b7d''::bytea, ''ABC'', ''meta'') returning 1) select count(*)::text from i', acc_a, ua));
    x_sig := pg_temp.ig79_q(null, null, format(
      'with i as (insert into public.instagram_inbound_events (instagram_account_id, unit_id, raw_body, body_sha256, signature_secret) '
      'values (%L, %L, ''\x7b7d''::bytea, encode(sha256(''\x7b7d''::bytea), ''hex''), ''whatsapp'') returning 1) select count(*)::text from i', acc_a, ua));
    -- Fix 2: hash bem formado, mas de OUTRO corpo (que nenhuma linha usa).
    x_hash := pg_temp.ig79_q('service_role', null, format(
      'with i as (insert into public.instagram_inbound_events (instagram_account_id, unit_id, raw_body, body_sha256, signature_secret) '
      'values (%L, %L, decode(%L, ''hex''), encode(sha256(convert_to(''ig79-outro-corpo-33'', ''UTF8'')), ''hex''), ''meta'') '
      'returning 1) select count(*)::text from i', acc_a, ua, encode(c2, 'hex')));

    rec := pg_temp.ig79_q('service_role', null, pg_temp.ig79_mrec(acc_b, 'mid-33', 'echo_own'));
    select m.unit_id::text into led_unit from public.instagram_processed_messages m where m.instagram_account_id = acc_b and m.mid = 'mid-33';
    x_led := pg_temp.ig79_q(null, null, format(
      'with i as (insert into public.instagram_processed_messages (instagram_account_id, unit_id, mid, status) '
      'values (%L, %L, ''mid-33x'', ''done'') returning 1) select count(*)::text from i', acc_a, ub));
    x_led_move := pg_temp.ig79_q(null, null, format(
      'with u as (update public.instagram_processed_messages set unit_id = %L where instagram_account_id = %L and mid = ''mid-33'' returning 1) '
      'select count(*)::text from u', ua, acc_b));

    raise exception using errcode = 'P0R79', message =
      case when acc_a is not null and acc_b is not null
            and pg_temp.ig79_uuid(ok) is not null and pg_temp.ig79_uuid(mv) is not null
            and dup like 'ERR 23505:%instagram_inbound_events_account_body_key%'
            and pg_temp.ig79_uuid(outra) is not null
            and x_sv like 'ERR 23514:instagram_inbound_events: unidade do registro nao e a da conta %'
            and x_pg like 'ERR 23514:instagram_inbound_events: unidade do registro nao e a da conta %'
            and x_ghost like 'ERR 23514:instagram_inbound_events: conta % inexistente'
            and x_move = 'ERR 23514:instagram_inbound_events: conta e unidade sao imutaveis'
            and x_move_acc = 'ERR 23514:instagram_inbound_events: conta e unidade sao imutaveis'
            and x_sha like 'ERR 23514:%instagram_inbound_events_body_sha256_chk%'
            and x_sig like 'ERR 23514:%instagram_inbound_events_signature_secret_chk%'
            and x_hash like 'ERR 23514:%instagram_inbound_events_body_sha256_raw_chk%'
            and rec = 'ok' and led_unit = ub::text
            and x_led like 'ERR 23514:instagram_processed_messages: unidade do registro nao e a da conta %'
            and x_led_move = 'ERR 23514:instagram_processed_messages: conta e unidade sao imutaveis' then 'PASSOU'
           else 'FALHOU valido=' || ok || ' duplicado=' || dup || ' mesmo_corpo_outra_conta=' || outra
                || ' service_unidade_alheia=' || x_sv || ' postgres_unidade_alheia=' || x_pg || ' conta_inexistente=' || x_ghost
                || ' mover_unidade=' || x_move || ' mover_conta=' || x_move_acc
                || ' sha_ruim=' || x_sha || ' segredo_ruim=' || x_sig || ' hash_alheio=' || x_hash
                || ' ledger_rpc=' || rec || ' ledger_unidade=' || coalesce(led_unit, '<null>')
                || ' ledger_unidade_alheia=' || x_led || ' ledger_mover=' || x_led_move end;
  exception
    when sqlstate 'P0R79' then return sqlerrm;
    when others then return 'FALHOU erro inesperado ' || sqlstate || ':' || sqlerrm;
  end;
end $f$;

-- ─── IG-3.4: diagnóstico só para platform_admin, sem conteúdo ───────────────
-- UA com um evento de cada estado (o `done` antigo fora da janela de 24h) e
-- duas mensagens no ledger; UB com um evento recebido. Owner, gerente,
-- operador de A e sessão sem `sub` recebem o MESMO 42501; anon não tem
-- EXECUTE. platform_admin sem membership lê UA com as contagens e os
-- desfechos de 24h esperados e as chaves exatas; o texto devolvido não traz
-- corpo, erro, mid nem meta (marcador SEGREDO em todos). UB vê só o seu, e
-- unidade inexistente sai zerada.
create or replace function pg_temp.ig79_case_34() returns text language plpgsql as $f$
declare
  ua constant uuid := 'a0d79000-0000-4000-8000-0000000000aa';
  ub constant uuid := 'a0d79000-0000-4000-8000-0000000000bb';
  ghost constant uuid := 'a0d79000-0000-4000-8000-0000000000ff';
  owner_a constant uuid := 'a0d79000-0000-4000-8000-0000000000a1';
  ger_a constant uuid := 'a0d79000-0000-4000-8000-0000000000a2';
  op_a constant uuid := 'a0d79000-0000-4000-8000-0000000000a3';
  ger_b constant uuid := 'a0d79000-0000-4000-8000-0000000000b2';
  pa constant uuid := 'a0d79000-0000-4000-8000-0000000000c1';
  f constant text := 'ERR 42501:instagram_diagnostics_forbidden';
  acc_a uuid; acc_b uuid; e1 uuid; e2 uuid; e3 uuid; e4 uuid; e5 uuid; c text; mc text;
  d_owner text; d_ger text; d_op text; d_ns text; d_anon text; d_a text; d_b text; d_g text; j jsonb; jb jsonb; jg jsonb;
begin
  begin
    acc_a := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ua, '79340001', 'conta_34a', 'tok-34-A-000001', owner_a)));
    acc_b := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ub, '79340002', 'conta_34b', 'tok-34-B-000001', ger_b)));
    e1 := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_ev(acc_a, ua, convert_to('{"t":"SEGREDO-DM-79 1"}', 'UTF8'), 'instagram')));
    e2 := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_ev(acc_a, ua, convert_to('{"t":"SEGREDO-DM-79 2"}', 'UTF8'), 'instagram')));
    e3 := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_ev(acc_a, ua, convert_to('{"t":"SEGREDO-DM-79 3"}', 'UTF8'), 'meta')));
    e4 := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_ev(acc_a, ua, convert_to('{"t":"SEGREDO-DM-79 4"}', 'UTF8'), 'instagram')));
    e5 := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_ev(acc_a, ua, convert_to('{"t":"SEGREDO-DM-79 5"}', 'UTF8'), 'instagram')));
    perform pg_temp.ig79_q('service_role', null, pg_temp.ig79_ev(acc_b, ub, convert_to('{"t":"SEGREDO-DM-79 B"}', 'UTF8'), 'instagram'));
    update public.instagram_inbound_events set received_at = now() - interval '1 hour' where id = e1;
    -- e2 em voo; e3 done; e4 dead com erro; e5 done há 2 dias.
    perform pg_temp.ig79_q('service_role', null, pg_temp.ig79_claim(e2));
    c := pg_temp.ig79_q('service_role', null, pg_temp.ig79_claim(e3));
    perform pg_temp.ig79_q('service_role', null, pg_temp.ig79_fin(e3, pg_temp.ig79_uuid(split_part(split_part(c, ':', 2), '|', 1)), 'done', 'processed', null, null));
    c := pg_temp.ig79_q('service_role', null, pg_temp.ig79_claim(e4));
    perform pg_temp.ig79_q('service_role', null, pg_temp.ig79_fin(e4, pg_temp.ig79_uuid(split_part(split_part(c, ':', 2), '|', 1)), 'dead', 'queue_dead_letter', 'SEGREDO-ERRO-79', null));
    c := pg_temp.ig79_q('service_role', null, pg_temp.ig79_claim(e5));
    perform pg_temp.ig79_q('service_role', null, pg_temp.ig79_fin(e5, pg_temp.ig79_uuid(split_part(split_part(c, ':', 2), '|', 1)), 'done', 'antigo', null, null));
    update public.instagram_inbound_events set updated_at = now() - interval '2 days' where id = e5;
    -- Ledger de A: um eco e uma mensagem respondida (meta com marcador).
    perform pg_temp.ig79_q('service_role', null, pg_temp.ig79_mrec(acc_a, 'SEGREDO-MID-79-eco', 'echo_own'));
    mc := pg_temp.ig79_q('service_role', null, pg_temp.ig79_mclaim(acc_a, 'SEGREDO-MID-79-txt'));
    perform pg_temp.ig79_q('service_role', null, pg_temp.ig79_mdone(acc_a, 'SEGREDO-MID-79-txt', pg_temp.ig79_uuid(mc), 'replied', '{"nota":"SEGREDO-META-79"}'));

    d_owner := pg_temp.ig79_q('authenticated', owner_a, format('select public.get_instagram_diagnostics(%L::uuid)::text', ua));
    d_ger := pg_temp.ig79_q('authenticated', ger_a, format('select public.get_instagram_diagnostics(%L::uuid)::text', ua));
    d_op := pg_temp.ig79_q('authenticated', op_a, format('select public.get_instagram_diagnostics(%L::uuid)::text', ua));
    d_ns := pg_temp.ig79_q('authenticated', null, format('select public.get_instagram_diagnostics(%L::uuid)::text', ua));
    d_anon := pg_temp.ig79_q('anon', null, format('select public.get_instagram_diagnostics(%L::uuid)::text', ua));
    d_a := pg_temp.ig79_q('authenticated', pa, format('select public.get_instagram_diagnostics(%L::uuid)::text', ua));
    d_b := pg_temp.ig79_q('authenticated', pa, format('select public.get_instagram_diagnostics(%L::uuid)::text', ub));
    d_g := pg_temp.ig79_q('authenticated', pa, format('select public.get_instagram_diagnostics(%L::uuid)::text', ghost));
    if d_a like '{%' then j := d_a::jsonb; end if;
    if d_b like '{%' then jb := d_b::jsonb; end if;
    if d_g like '{%' then jg := d_g::jsonb; end if;

    raise exception using errcode = 'P0R79', message =
      case when acc_a is not null and acc_b is not null and e5 is not null and pg_temp.ig79_uuid(mc) is not null
            and d_owner = f and d_ger = f and d_op = f and d_ns = f
            and d_anon like 'ERR 42501:permission denied for function get_instagram_diagnostics%'
            and j is not null
            and (select array_agg(k order by k) from jsonb_object_keys(j) k)
                = array['last_event_at', 'oldest_pending_received_at', 'outcomes_24h', 'queue']
            and j->'queue' = '{"received":1,"processing":1,"done_24h":1,"dead":1}'::jsonb
            and j->'outcomes_24h' = '{"processed":1,"queue_dead_letter":1,"echo_own":1,"replied":1}'::jsonb
            and (j->>'last_event_at')::timestamptz = now()
            and (j->>'oldest_pending_received_at')::timestamptz = now() - interval '1 hour'
            and position('SEGREDO' in d_a) = 0
            and position(encode(convert_to('SEGREDO', 'UTF8'), 'hex') in d_a) = 0
            and position(encode(convert_to('SEGREDO', 'UTF8'), 'base64') in d_a) = 0
            and jb->'queue' = '{"received":1,"processing":0,"done_24h":0,"dead":0}'::jsonb
            and jb->'outcomes_24h' = '{}'::jsonb
            and jg->'queue' = '{"received":0,"processing":0,"done_24h":0,"dead":0}'::jsonb
            and jg->>'last_event_at' is null and jg->>'oldest_pending_received_at' is null then 'PASSOU'
           else 'FALHOU owner=' || d_owner || ' gerente=' || d_ger || ' operador=' || d_op || ' sem_sub=' || d_ns
                || ' anon=' || d_anon || ' pa_A=' || d_a || ' pa_B=' || d_b || ' pa_inexistente=' || d_g end;
  exception
    when sqlstate 'P0R79' then return sqlerrm;
    when others then return 'FALHOU erro inesperado ' || sqlstate || ':' || sqlerrm;
  end;
end $f$;

-- ─── IG-3.5: purga só do que passou da idade ────────────────────────────────
-- Fila: done de 8 dias e dead de 31 saem; done de 6, dead de 29, e received e
-- processing de 40 dias ficam (linha viva nunca é apagada). Ledger: com mais
-- de 30 dias saem o done e o processing de lease vencido; o processing de
-- lease vivo (fix 4) e o de 29 dias ficam. Repetir a purga não apaga mais nada.
create or replace function pg_temp.ig79_case_35() returns text language plpgsql as $f$
declare
  ua constant uuid := 'a0d79000-0000-4000-8000-0000000000aa';
  owner_a constant uuid := 'a0d79000-0000-4000-8000-0000000000a1';
  acc uuid; d8 uuid; d6 uuid; x31 uuid; x29 uuid; r40 uuid; p40 uuid;
  n1 text; n2 text; n3 text; n4 text; restam text; restam_led text;
begin
  begin
    acc := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ua, '79350001', 'conta_35', 'tok-35-A-000001', owner_a)));
    d8 := pg_temp.ig79_uuid(pg_temp.ig79_q(null, null, pg_temp.ig79_ev(acc, ua, convert_to('35-d8', 'UTF8'), 'instagram')));
    d6 := pg_temp.ig79_uuid(pg_temp.ig79_q(null, null, pg_temp.ig79_ev(acc, ua, convert_to('35-d6', 'UTF8'), 'instagram')));
    x31 := pg_temp.ig79_uuid(pg_temp.ig79_q(null, null, pg_temp.ig79_ev(acc, ua, convert_to('35-x31', 'UTF8'), 'instagram')));
    x29 := pg_temp.ig79_uuid(pg_temp.ig79_q(null, null, pg_temp.ig79_ev(acc, ua, convert_to('35-x29', 'UTF8'), 'instagram')));
    r40 := pg_temp.ig79_uuid(pg_temp.ig79_q(null, null, pg_temp.ig79_ev(acc, ua, convert_to('35-r40', 'UTF8'), 'instagram')));
    p40 := pg_temp.ig79_uuid(pg_temp.ig79_q(null, null, pg_temp.ig79_ev(acc, ua, convert_to('35-p40', 'UTF8'), 'instagram')));
    update public.instagram_inbound_events set status = 'done', received_at = now() - interval '8 days' where id = d8;
    update public.instagram_inbound_events set status = 'done', received_at = now() - interval '6 days' where id = d6;
    update public.instagram_inbound_events set status = 'dead', received_at = now() - interval '31 days' where id = x31;
    update public.instagram_inbound_events set status = 'dead', received_at = now() - interval '29 days' where id = x29;
    update public.instagram_inbound_events set received_at = now() - interval '40 days' where id = r40;
    update public.instagram_inbound_events set status = 'processing', claim_id = gen_random_uuid(),
           claimed_until = now() - interval '40 days', received_at = now() - interval '41 days' where id = p40;

    perform pg_temp.ig79_q('service_role', null, pg_temp.ig79_mrec(acc, 'mid-35-l31', 'echo_own'));
    perform pg_temp.ig79_q('service_role', null, pg_temp.ig79_mrec(acc, 'mid-35-l29', 'echo_own'));
    perform pg_temp.ig79_q('service_role', null, pg_temp.ig79_mclaim(acc, 'mid-35-p31'));
    perform pg_temp.ig79_q('service_role', null, pg_temp.ig79_mclaim(acc, 'mid-35-v31'));
    update public.instagram_processed_messages set created_at = now() - interval '31 days'
     where instagram_account_id = acc and mid in ('mid-35-l31', 'mid-35-p31', 'mid-35-v31');
    -- p31: processing com lease vencido (abandono); v31: processing com lease
    -- vivo (turno em curso), que a purga não pode apagar.
    update public.instagram_processed_messages set claimed_until = now() - interval '1 second'
     where instagram_account_id = acc and mid = 'mid-35-p31';
    update public.instagram_processed_messages set created_at = now() - interval '29 days'
     where instagram_account_id = acc and mid = 'mid-35-l29';

    n1 := pg_temp.ig79_q('service_role', null, 'select public.purge_instagram_inbound_events()::text');
    n2 := pg_temp.ig79_q('service_role', null, 'select public.purge_instagram_processed_messages()::text');
    n3 := pg_temp.ig79_q('service_role', null, 'select public.purge_instagram_inbound_events()::text');
    n4 := pg_temp.ig79_q('service_role', null, 'select public.purge_instagram_processed_messages()::text');
    select string_agg(case e.id when d6 then 'd6' when x29 then 'x29' when r40 then 'r40' when p40 then 'p40' else e.id::text end, ',' order by e.received_at desc)
      into restam from public.instagram_inbound_events e where e.instagram_account_id = acc;
    select string_agg(m.mid, ',' order by m.mid) into restam_led
      from public.instagram_processed_messages m where m.instagram_account_id = acc;

    raise exception using errcode = 'P0R79', message =
      case when acc is not null and p40 is not null
            and n1 = '2' and n2 = '2' and n3 = '0' and n4 = '0'
            and restam = 'd6,x29,r40,p40' and restam_led = 'mid-35-l29,mid-35-v31' then 'PASSOU'
           else 'FALHOU purga_fila=' || n1 || ' purga_ledger=' || n2 || ' repetir=' || n3 || '/' || n4
                || ' restam_fila=' || coalesce(restam, '<nenhum>') || ' restam_ledger=' || coalesce(restam_led, '<nenhum>') end;
  exception
    when sqlstate 'P0R79' then return sqlerrm;
    when others then return 'FALHOU erro inesperado ' || sqlstate || ':' || sqlerrm;
  end;
end $f$;

-- ─── IG-3.6: ACL das funções e das tabelas; postura de RLS ──────────────────
-- As oito RPCs da fila e do ledger só para service_role; o diagnóstico só
-- para authenticated; wrappers e trigger function para ninguém da API; PUBLIC
-- fora de todas. Tabelas com FORCE RLS e sem policy, nada para anon e
-- authenticated; service_role só SELECT na fila e INSERT apenas das cinco
-- colunas que o webhook declara (fix 3: INSERT com status, claim_id, attempts,
-- outcome ou received_at dá 42501), e só SELECT no ledger. Medido também pelo
-- comportamento: authenticated não lê a
-- fila nem chama o claim; service_role não faz UPDATE na fila nem INSERT no
-- ledger.
create or replace function pg_temp.ig79_case_36() returns text language plpgsql as $f$
declare
  ruins text := '';
  fn text; r text; t text; cols text; v text;
  a_sel text; a_claim text; s_upd text; s_ins text; s_sel text;
begin
  begin
    foreach fn in array array[
      'public.claim_instagram_inbound_event(uuid)',
      'public.finalize_instagram_inbound_event(uuid,uuid,text,text,text,integer)',
      'public.select_due_instagram_inbound_events(integer)',
      'public.purge_instagram_inbound_events()',
      'public.claim_instagram_message(uuid,text)',
      'public.complete_instagram_message(uuid,text,uuid,text,text,jsonb)',
      'public.record_instagram_message_outcome(uuid,text,text,jsonb)',
      'public.purge_instagram_processed_messages()'] loop
      foreach r in array array['anon', 'authenticated'] loop
        if has_function_privilege(r, fn, 'EXECUTE') then ruins := ruins || ' ' || r || '_exec:' || fn; end if;
      end loop;
      if not has_function_privilege('service_role', fn, 'EXECUTE') then ruins := ruins || ' service_sem_exec:' || fn; end if;
    end loop;
    fn := 'public.get_instagram_diagnostics(uuid)';
    if has_function_privilege('anon', fn, 'EXECUTE') then ruins := ruins || ' anon_exec:' || fn; end if;
    if has_function_privilege('service_role', fn, 'EXECUTE') then ruins := ruins || ' service_exec:' || fn; end if;
    if not has_function_privilege('authenticated', fn, 'EXECUTE') then ruins := ruins || ' auth_sem_exec:' || fn; end if;
    foreach fn in array array['public.trigger_instagram_inbound_sweep()', 'public.trigger_instagram_token_refresh()',
                              'public.instagram_queue_tenant_guard()'] loop
      foreach r in array array['anon', 'authenticated', 'service_role'] loop
        if has_function_privilege(r, fn, 'EXECUTE') then ruins := ruins || ' ' || r || '_exec:' || fn; end if;
      end loop;
    end loop;
    if exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                where p.pronamespace = 'public'::regnamespace and p.proname like '%instagram%' and a.grantee = 0) then
      ruins := ruins || ' public_exec_em_funcao_instagram';
    end if;

    foreach t in array array['public.instagram_inbound_events', 'public.instagram_processed_messages'] loop
      foreach r in array array['anon', 'authenticated'] loop
        if has_table_privilege(r, t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
           or has_any_column_privilege(r, t, 'SELECT,INSERT,UPDATE,REFERENCES') then
          ruins := ruins || ' ' || r || ':' || t;
        end if;
      end loop;
      if not has_table_privilege('service_role', t, 'SELECT') then ruins := ruins || ' service_sem_select:' || t; end if;
      if has_table_privilege('service_role', t, 'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         or has_any_column_privilege('service_role', t, 'UPDATE,REFERENCES') then
        ruins := ruins || ' service_escreve:' || t;
      end if;
      if not (select relrowsecurity and relforcerowsecurity from pg_class where oid = t::regclass) then
        ruins := ruins || ' sem_force_rls:' || t;
      end if;
      if exists (select 1 from pg_policy where polrelid = t::regclass) then ruins := ruins || ' com_policy:' || t; end if;
    end loop;
    -- Fix 3: INSERT só por coluna, e exatamente as cinco que o webhook declara.
    if has_table_privilege('service_role', 'public.instagram_inbound_events', 'INSERT') then
      ruins := ruins || ' service_insert_tabela_fila';
    end if;
    select coalesce(string_agg(a.attname::text, ',' order by a.attname), '') into cols
      from pg_attribute a
     where a.attrelid = 'public.instagram_inbound_events'::regclass and a.attnum > 0 and not a.attisdropped
       and has_column_privilege('service_role', a.attrelid, a.attnum, 'INSERT');
    if cols <> 'body_sha256,instagram_account_id,raw_body,signature_secret,unit_id' then
      ruins := ruins || ' service_insert_colunas_fila=' || cols;
    end if;
    foreach r in array array['status', 'claim_id', 'attempts', 'outcome', 'received_at'] loop
      v := pg_temp.ig79_q('service_role', null, format(
        'with i as (insert into public.instagram_inbound_events '
        '(instagram_account_id, unit_id, raw_body, body_sha256, signature_secret, %I) '
        'values (gen_random_uuid(), gen_random_uuid(), ''\x7b7d''::bytea, encode(sha256(''\x7b7d''::bytea), ''hex''), ''meta'', %L) '
        'returning 1) select count(*)::text from i', r,
        case r when 'status' then 'done' when 'claim_id' then '00000000-0000-4000-8000-000000000001'
               when 'attempts' then '5' when 'outcome' then 'processed' else '2020-01-01 00:00:00+00' end));
      if v not like 'ERR 42501:permission denied for table instagram_inbound_events%' then
        ruins := ruins || ' service_insere_' || r || '=' || v;
      end if;
    end loop;
    if has_table_privilege('service_role', 'public.instagram_processed_messages', 'INSERT')
       or has_any_column_privilege('service_role', 'public.instagram_processed_messages', 'INSERT') then
      ruins := ruins || ' service_insere_ledger';
    end if;

    a_sel := pg_temp.ig79_q('authenticated', 'a0d79000-0000-4000-8000-0000000000c1', 'select count(*)::text from public.instagram_inbound_events');
    a_claim := pg_temp.ig79_q('authenticated', 'a0d79000-0000-4000-8000-0000000000c1',
      'select count(*)::text from public.claim_instagram_inbound_event(gen_random_uuid())');
    s_upd := pg_temp.ig79_q('service_role', null,
      'with u as (update public.instagram_inbound_events set attempts = attempts returning 1) select count(*)::text from u');
    s_ins := pg_temp.ig79_q('service_role', null,
      'with i as (insert into public.instagram_processed_messages (instagram_account_id, unit_id, mid, status) '
      'values (gen_random_uuid(), gen_random_uuid(), ''m'', ''done'') returning 1) select count(*)::text from i');
    s_sel := pg_temp.ig79_q('service_role', null, 'select count(*)::text from public.instagram_processed_messages');

    raise exception using errcode = 'P0R79', message =
      case when ruins = ''
            and a_sel like 'ERR 42501:permission denied for table instagram_inbound_events%'
            and a_claim like 'ERR 42501:permission denied for function claim_instagram_inbound_event%'
            and s_upd like 'ERR 42501:permission denied for table instagram_inbound_events%'
            and s_ins like 'ERR 42501:permission denied for table instagram_processed_messages%'
            and s_sel = '0' then 'PASSOU'
           else 'FALHOU' || ruins || ' auth_le_fila=' || a_sel || ' auth_claim=' || a_claim
                || ' service_update_fila=' || s_upd || ' service_insert_ledger=' || s_ins || ' service_le_ledger=' || s_sel end;
  exception
    when sqlstate 'P0R79' then return sqlerrm;
    when others then return 'FALHOU erro inesperado ' || sqlstate || ':' || sqlerrm;
  end;
end $f$;

-- ─── IG-3.7: wrappers de pg_cron leem o Vault e pulam sem segredo ───────────
-- Sem `pg_net` no harness: o caso instala, dentro da própria subtransação, um
-- `net.http_post` falso que recusa com a URL e o header recebidos. Sem
-- `internal_api_key`, sem `project_url`, ou com a chave vazia, os dois
-- wrappers voltam sem POST ('ok'). Com os dois segredos, o POST sai para
-- `<project_url>/functions/v1/process-instagram-inbound?sweep=1` e
-- `.../process-instagram-token-refresh`, com `x-internal-key` = valor do Vault.
create or replace function pg_temp.ig79_case_37() returns text language plpgsql as $f$
declare
  sw constant text := 'public.trigger_instagram_inbound_sweep()';
  tr constant text := 'public.trigger_instagram_token_refresh()';
  a0 text; b0 text; a1 text; b1 text; a2 text; b2 text; a3 text; b3 text; a4 text; b4 text;
begin
  begin
    delete from vault.secrets where name in ('internal_api_key', 'project_url');
    create schema if not exists net;
    create or replace function net.http_post(
      url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
      headers jsonb default '{}'::jsonb, timeout_milliseconds integer default 5000)
    returns bigint language plpgsql as $n$
    begin
      raise exception using errcode = 'P0N79', message =
        coalesce(url, '<null>') || '|' || coalesce(headers->>'x-internal-key', '<null>') || '|'
        || coalesce(headers->>'Content-Type', '<null>') || '|' || coalesce(body::text, '<null>') || '|' || timeout_milliseconds;
    end $n$;

    a0 := pg_temp.ig79_q(null, null, pg_temp.ig79_void(sw));
    b0 := pg_temp.ig79_q(null, null, pg_temp.ig79_void(tr));
    perform vault.create_secret('ig79-chave-interna', 'internal_api_key', 'ig79');
    a1 := pg_temp.ig79_q(null, null, pg_temp.ig79_void(sw));
    b1 := pg_temp.ig79_q(null, null, pg_temp.ig79_void(tr));
    delete from vault.secrets where name = 'internal_api_key';
    perform vault.create_secret('http://ig79.invalid', 'project_url', 'ig79');
    a2 := pg_temp.ig79_q(null, null, pg_temp.ig79_void(sw));
    b2 := pg_temp.ig79_q(null, null, pg_temp.ig79_void(tr));
    perform vault.create_secret('ig79-chave-interna', 'internal_api_key', 'ig79');
    a3 := pg_temp.ig79_q(null, null, pg_temp.ig79_void(sw));
    b3 := pg_temp.ig79_q(null, null, pg_temp.ig79_void(tr));
    update vault.secrets set secret = '' where name = 'internal_api_key';
    a4 := pg_temp.ig79_q(null, null, pg_temp.ig79_void(sw));
    b4 := pg_temp.ig79_q(null, null, pg_temp.ig79_void(tr));

    raise exception using errcode = 'P0R79', message =
      case when a0 = 'ok' and b0 = 'ok' and a1 = 'ok' and b1 = 'ok' and a2 = 'ok' and b2 = 'ok'
            and a3 = 'ERR P0N79:http://ig79.invalid/functions/v1/process-instagram-inbound?sweep=1|ig79-chave-interna|application/json|{}|30000'
            and b3 = 'ERR P0N79:http://ig79.invalid/functions/v1/process-instagram-token-refresh|ig79-chave-interna|application/json|{}|30000'
            and a4 = 'ok' and b4 = 'ok' then 'PASSOU'
           else 'FALHOU sem_segredos=' || a0 || '/' || b0 || ' so_chave=' || a1 || '/' || b1
                || ' so_url=' || a2 || '/' || b2 || ' os_dois=' || a3 || ' / ' || b3
                || ' chave_vazia=' || a4 || '/' || b4 end;
  exception
    when sqlstate 'P0R79' then return sqlerrm;
    when others then return 'FALHOU erro inesperado ' || sqlstate || ':' || sqlerrm;
  end;
end $f$;

-- ─── IG-3.8: desfecho é código, nunca texto (fix 5) ─────────────────────────
-- finalize, complete e record com desfecho em texto livre (espaço, maiúscula,
-- acento) ou com 65 caracteres falham com 23514 e não gravam: o evento segue
-- `processing` com o claim, a mensagem segue `processing`, o eco não nasce.
-- INSERT direto no ledger como postgres também é recusado. Todos os desfechos
-- usados no harness, no plano e no núcleo da fila casam o formato, e os
-- válidos gravam.
create or replace function pg_temp.ig79_case_38() returns text language plpgsql as $f$
declare
  ua constant uuid := 'a0d79000-0000-4000-8000-0000000000aa';
  owner_a constant uuid := 'a0d79000-0000-4000-8000-0000000000a1';
  acc uuid; ev uuid; c text; cl uuid; f_txt text; f_long text; est_ev text; f_ok text;
  m text; c_txt text; est_m text; c_ok text; r_txt text; n_eco int; r1 text; r2 text; r3 text; x_pg text;
  literais_ok boolean;
begin
  begin
    acc := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ua, '79380001', 'conta_38', 'tok-38-A-000001', owner_a)));
    ev := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_ev(acc, ua, convert_to('{"t":"38"}', 'UTF8'), 'instagram')));
    c := pg_temp.ig79_q('service_role', null, pg_temp.ig79_claim(ev));
    cl := pg_temp.ig79_uuid(split_part(split_part(c, ':', 2), '|', 1));
    f_txt := pg_temp.ig79_q('service_role', null, pg_temp.ig79_fin(ev, cl, 'done', 'Cliente disse: quero reservar', null, null));
    f_long := pg_temp.ig79_q('service_role', null, pg_temp.ig79_fin(ev, cl, 'done', repeat('a', 65), null, null));
    select e.status || '|' || (e.claim_id = cl) || '|' || coalesce(e.outcome, '<null>') into est_ev
      from public.instagram_inbound_events e where e.id = ev;
    f_ok := pg_temp.ig79_q('service_role', null, pg_temp.ig79_fin(ev, cl, 'done', 'discarded_no_grant', null, null));

    m := pg_temp.ig79_q('service_role', null, pg_temp.ig79_mclaim(acc, 'mid-38'));
    c_txt := pg_temp.ig79_q('service_role', null, pg_temp.ig79_mdone(acc, 'mid-38', pg_temp.ig79_uuid(m), 'Respondido às 20h', '{}'));
    select x.status || '|' || coalesce(x.outcome, '<null>') into est_m
      from public.instagram_processed_messages x where x.instagram_account_id = acc and x.mid = 'mid-38';
    c_ok := pg_temp.ig79_q('service_role', null, pg_temp.ig79_mdone(acc, 'mid-38', pg_temp.ig79_uuid(m), 'replied', '{}'));

    r_txt := pg_temp.ig79_q('service_role', null, pg_temp.ig79_mrec(acc, 'mid-38-eco', 'Echo Own'));
    select count(*) into n_eco from public.instagram_processed_messages x where x.instagram_account_id = acc and x.mid = 'mid-38-eco';
    r1 := pg_temp.ig79_q('service_role', null, pg_temp.ig79_mrec(acc, 'mid-38-e1', 'echo_own'));
    r2 := pg_temp.ig79_q('service_role', null, pg_temp.ig79_mrec(acc, 'mid-38-e2', 'echo_unknown'));
    r3 := pg_temp.ig79_q('service_role', null, pg_temp.ig79_mrec(acc, 'mid-38-e3', 'ignored_story_mention'));
    x_pg := pg_temp.ig79_q(null, null, format(
      'with i as (insert into public.instagram_processed_messages (instagram_account_id, unit_id, mid, status, outcome) '
      'values (%L, %L, ''mid-38-pg'', ''done'', ''a b'') returning 1) select count(*)::text from i', acc, ua));

    select bool_and(o ~ '^[a-z0-9_]{1,64}$') into literais_ok from unnest(array[
      -- harness 79
      'processed', 'transient', 'x', 'queue_dead_letter', 'antigo', 'replied', 'outro',
      'echo_own', 'echo_unknown', 'discarded_no_grant',
      -- plano (Tasks 4.x) e núcleo da fila (`queuedEventVerdict`)
      'ignored_story_mention', 'ignored_self', 'queue_processed', 'queue_retry_scheduled',
      'queue_dead_letter_no_verdict', 'queue_unauthorized_terminal']) o;

    raise exception using errcode = 'P0R79', message =
      case when acc is not null and ev is not null and cl is not null
            and f_txt like 'ERR 23514:%instagram_inbound_events_outcome_chk%'
            and f_long like 'ERR 23514:%instagram_inbound_events_outcome_chk%'
            and est_ev = 'processing|true|<null>' and f_ok = '1'
            and pg_temp.ig79_uuid(m) is not null
            and c_txt like 'ERR 23514:%instagram_processed_messages_outcome_chk%'
            and est_m = 'processing|<null>' and c_ok = 'true'
            and r_txt like 'ERR 23514:%instagram_processed_messages_outcome_chk%' and n_eco = 0
            and r1 = 'ok' and r2 = 'ok' and r3 = 'ok'
            and x_pg like 'ERR 23514:%instagram_processed_messages_outcome_chk%'
            and literais_ok then 'PASSOU'
           else 'FALHOU finalize_texto=' || f_txt || ' finalize_65=' || f_long || ' evento=' || coalesce(est_ev, '<null>')
                || ' finalize_codigo=' || f_ok || ' complete_texto=' || c_txt || ' mensagem=' || coalesce(est_m, '<null>')
                || ' complete_codigo=' || c_ok || ' record_texto=' || r_txt || ' eco_linhas=' || n_eco
                || ' record_codigos=' || r1 || '/' || r2 || '/' || r3 || ' insert_postgres=' || x_pg
                || ' literais=' || coalesce(literais_ok::text, '<null>') end;
  exception
    when sqlstate 'P0R79' then return sqlerrm;
    when others then return 'FALHOU erro inesperado ' || sqlstate || ':' || sqlerrm;
  end;
end $f$;

-- ═══ Task 1.4: conversations com canal e cliente opcional ═══════════════════
-- Fixtures próprias (clientes, reservas, contas, contatos, canal WhatsApp,
-- jobs de automação) nascem e morrem dentro da subtransação de cada caso.
-- A conversa WhatsApp "antiga" nasce por INSERT com `updated_at` no passado:
-- o trigger de updated_at só age em UPDATE, e dentro da transação `now()` é
-- constante, então é assim que a conversa do Instagram fica "a mais recente"
-- e a busca SEM filtro de canal a escolheria.

-- SQL de upsert_instagram_contact devolvendo o id.
create or replace function pg_temp.ig79_contact(p_acc uuid, p_igsid text, p_user text, p_name text)
returns text language sql as $$
  select format('select public.upsert_instagram_contact(%L::uuid, %L, %L, %L)::text', p_acc, p_igsid, p_user, p_name)
$$;

-- Quantas mensagens da conversa têm o event_id dado.
create or replace function pg_temp.ig79_evt(p_conv uuid, p_event text)
returns int language sql as $$
  select count(*)::int from public.conversations cv
    cross join lateral jsonb_array_elements(coalesce(cv.messages, '[]'::jsonb)) m
   where cv.id = p_conv and m->>'event_id' = p_event
$$;

-- ─── IG-4.1: CHECK de identidade do canal ───────────────────────────────────
-- Como postgres (sem RLS; o guard não olha a forma): WhatsApp sem cliente,
-- Instagram sem contato e WhatsApp com contato violam
-- `conversations_channel_identity_check`; canal fora da lista viola
-- `conversations_channel_check`. Instagram com contato e sem cliente passa, e
-- WhatsApp com cliente nasce `channel = 'whatsapp'` pelo default. Catálogo:
-- três constraints validadas, `customer_id` aceita nulo, `channel` NOT NULL
-- com default 'whatsapp'.
create or replace function pg_temp.ig79_case_41() returns text language plpgsql as $f$
declare
  ua constant uuid := 'a0d79000-0000-4000-8000-0000000000aa';
  org_a constant uuid := 'a0d79000-0000-4000-8000-00000000000a';
  owner_a constant uuid := 'a0d79000-0000-4000-8000-0000000000a1';
  c_a constant uuid := 'a0d79000-0000-4000-8000-000000004101';
  acc uuid; k uuid;
  x_wa_sem text; x_ig_sem text; x_wa_contato text; x_canal text; ok_ig text; ok_wa text; cat text; col text;
begin
  begin
    insert into public.customers (id, organization_id, name, phone) values (c_a, org_a, 'ig79 cliente 41', '11990004101');
    acc := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ua, '79410001', 'conta_41', 'tok-41-A-000001', owner_a)));
    k := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_contact(acc, 'igsid-41', 'user41', 'Nome 41')));

    x_wa_sem := pg_temp.ig79_q(null, null, format(
      'with i as (insert into public.conversations (unit_id, channel) values (%L, ''whatsapp'') returning 1) select count(*)::text from i', ua));
    x_ig_sem := pg_temp.ig79_q(null, null, format(
      'with i as (insert into public.conversations (unit_id, customer_id, channel) values (%L, %L, ''instagram'') returning 1) select count(*)::text from i', ua, c_a));
    x_wa_contato := pg_temp.ig79_q(null, null, format(
      'with i as (insert into public.conversations (unit_id, customer_id, channel, instagram_contact_id) values (%L, %L, ''whatsapp'', %L) returning 1) select count(*)::text from i', ua, c_a, k));
    x_canal := pg_temp.ig79_q(null, null, format(
      'with i as (insert into public.conversations (unit_id, customer_id, channel) values (%L, %L, ''email'') returning 1) select count(*)::text from i', ua, c_a));
    ok_ig := pg_temp.ig79_q(null, null, format(
      'with i as (insert into public.conversations (unit_id, channel, instagram_contact_id) values (%L, ''instagram'', %L) returning channel) select string_agg(channel, '','') from i', ua, k));
    ok_wa := pg_temp.ig79_q(null, null, format(
      'with i as (insert into public.conversations (unit_id, customer_id) values (%L, %L) returning channel) select string_agg(channel, '','') from i', ua, c_a));

    select string_agg(conname || ':' || convalidated, ',' order by conname) into cat
      from pg_constraint where conrelid = 'public.conversations'::regclass
       and conname in ('conversations_channel_check', 'conversations_channel_identity_check', 'conversations_instagram_contact_id_fkey');
    select string_agg(a.attname || ':' || a.attnotnull || ':' || coalesce(pg_get_expr(d.adbin, d.adrelid), '-'), ',' order by a.attname) into col
      from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
     where a.attrelid = 'public.conversations'::regclass and a.attname in ('channel', 'customer_id', 'instagram_contact_id');

    raise exception using errcode = 'P0R79', message =
      case when acc is not null and k is not null
            and x_wa_sem like 'ERR 23514:%conversations_channel_identity_check%'
            and x_ig_sem like 'ERR 23514:%conversations_channel_identity_check%'
            and x_wa_contato like 'ERR 23514:%conversations_channel_identity_check%'
            and x_canal like 'ERR 23514:%conversations_channel_check%'
            and ok_ig = 'instagram' and ok_wa = 'whatsapp'
            and cat = 'conversations_channel_check:true,conversations_channel_identity_check:true,conversations_instagram_contact_id_fkey:true'
            and col = 'channel:true:''whatsapp''::text,customer_id:false:-,instagram_contact_id:false:-' then 'PASSOU'
           else 'FALHOU wa_sem_cliente=' || x_wa_sem || ' ig_sem_contato=' || x_ig_sem || ' wa_com_contato=' || x_wa_contato
                || ' canal_email=' || x_canal || ' ig_ok=' || ok_ig || ' wa_ok=' || ok_wa
                || ' catalogo=' || coalesce(cat, '<null>') || ' colunas=' || coalesce(col, '<null>') end;
  exception
    when sqlstate 'P0R79' then return sqlerrm;
    when others then return 'FALHOU erro inesperado ' || sqlstate || ':' || sqlerrm;
  end;
end $f$;

-- ─── IG-4.2: get_or_create_whatsapp_conversation ignora a conversa IG ──────
-- Cliente C com a conversa WhatsApp X (mais antiga) e a conversa IG Y ligada
-- (mais recente): a RPC, como service_role, devolve X e não toca o
-- `contact_name`/`wa_chat_lid` de Y. Cliente C2 só com a conversa IG Y2: a RPC
-- cria uma conversa nova `whatsapp` do C2, diferente de Y2, e a segunda
-- chamada devolve a mesma.
create or replace function pg_temp.ig79_case_42() returns text language plpgsql as $f$
declare
  ua constant uuid := 'a0d79000-0000-4000-8000-0000000000aa';
  org_a constant uuid := 'a0d79000-0000-4000-8000-00000000000a';
  owner_a constant uuid := 'a0d79000-0000-4000-8000-0000000000a1';
  c1 constant uuid := 'a0d79000-0000-4000-8000-000000004201';
  c2 constant uuid := 'a0d79000-0000-4000-8000-000000004202';
  x constant uuid := 'a0d79000-0000-4000-8000-000000004210';
  acc uuid; k1 uuid; k2 uuid; y uuid; y2 uuid; r1 text; r2 text; r2b text;
  y_depois text; y2_depois text; novo text; link1 text; link2 text;
begin
  begin
    insert into public.customers (id, organization_id, name, phone) values
      (c1, org_a, 'ig79 cliente 42a', '11990004201'),
      (c2, org_a, 'ig79 cliente 42b', '11990004202');
    insert into public.conversations (id, unit_id, customer_id, messages, contact_name, updated_at)
      values (x, ua, c1, '[]'::jsonb, 'Nome WA antigo', now() - interval '1 day');
    acc := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ua, '79420001', 'conta_42', 'tok-42-A-000001', owner_a)));
    k1 := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_contact(acc, 'igsid-42a', 'user42a', 'IG 42a')));
    k2 := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_contact(acc, 'igsid-42b', 'user42b', 'IG 42b')));
    link1 := pg_temp.ig79_q('service_role', null, pg_temp.ig79_void(format('select public.link_instagram_contact_customer(%L::uuid, %L::uuid)', k1, c1)));
    link2 := pg_temp.ig79_q('service_role', null, pg_temp.ig79_void(format('select public.link_instagram_contact_customer(%L::uuid, %L::uuid)', k2, c2)));
    y := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, format('select public.get_or_create_instagram_conversation(%L::uuid)::text', k1)));
    y2 := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, format('select public.get_or_create_instagram_conversation(%L::uuid)::text', k2)));

    r1 := pg_temp.ig79_q('service_role', null, format(
      'select public.get_or_create_whatsapp_conversation(%L::uuid, %L::uuid, ''Nome WA novo'', ''lid-42'')::text', c1, ua));
    r2 := pg_temp.ig79_q('service_role', null, format(
      'select public.get_or_create_whatsapp_conversation(%L::uuid, %L::uuid, ''Nome WA 2'', ''lid-42b'')::text', c2, ua));
    r2b := pg_temp.ig79_q('service_role', null, format(
      'select public.get_or_create_whatsapp_conversation(%L::uuid, %L::uuid, null, null)::text', c2, ua));

    select cv.contact_name || '|' || coalesce(cv.wa_chat_lid, '-') || '|' || cv.customer_id into y_depois from public.conversations cv where cv.id = y;
    select cv.contact_name || '|' || coalesce(cv.wa_chat_lid, '-') || '|' || cv.customer_id into y2_depois from public.conversations cv where cv.id = y2;
    select cv.channel || '|' || cv.customer_id || '|' || cv.unit_id || '|' || coalesce(cv.instagram_contact_id::text, '-') into novo
      from public.conversations cv where cv.id = pg_temp.ig79_uuid(r2);

    raise exception using errcode = 'P0R79', message =
      case when link1 = 'ok' and link2 = 'ok' and y is not null and y2 is not null
            and r1 = x::text
            and y_depois = 'IG 42a|-|' || c1
            and r2 is distinct from y2::text and pg_temp.ig79_uuid(r2) is not null
            and novo = 'whatsapp|' || c2 || '|' || ua || '|-'
            and r2b = r2
            and y2_depois = 'IG 42b|-|' || c2 then 'PASSOU'
           else 'FALHOU link=' || link1 || '/' || link2 || ' y=' || coalesce(y::text, '<null>') || ' y2=' || coalesce(y2::text, '<null>')
                || ' wa_c1=' || r1 || ' esperado_x=' || x || ' y_depois=' || coalesce(y_depois, '<null>')
                || ' wa_c2=' || r2 || ' wa_c2_de_novo=' || r2b || ' nova=' || coalesce(novo, '<null>')
                || ' y2_depois=' || coalesce(y2_depois, '<null>') end;
  exception
    when sqlstate 'P0R79' then return sqlerrm;
    when others then return 'FALHOU erro inesperado ' || sqlstate || ':' || sqlerrm;
  end;
end $f$;

-- ─── IG-4.3: reconcile de aceitação ignora a conversa IG ───────────────────
-- O corpo REAL de app_private.reconcile_whatsapp_automation_acceptance_inner
-- (instalado pela migration), chamado como postgres (o EXECUTE é só do dono:
-- o wrapper guardado não existe no harness), sobre o stub de
-- `whatsapp_automation_jobs` do 79a. Cenário A: cliente C com a conversa
-- WhatsApp X (mais antiga) e a conversa IG Y ligada que JÁ contém o event_id
-- `automation:<job>:accepted` — o reconcile ainda assim registra o aceite em X
-- (uma vez) e Y fica como estava. Cenário B: cliente C2 só com a conversa IG
-- Y2: o reconcile cria a conversa WhatsApp do C2 e registra nela; Y2 intacta.
-- Os dois jobs terminam `reconciled` com `history = recorded` e a notificação
-- `sent` no canal histórico.
create or replace function pg_temp.ig79_case_43() returns text language plpgsql as $f$
declare
  ua constant uuid := 'a0d79000-0000-4000-8000-0000000000aa';
  org_a constant uuid := 'a0d79000-0000-4000-8000-00000000000a';
  owner_a constant uuid := 'a0d79000-0000-4000-8000-0000000000a1';
  c1 constant uuid := 'a0d79000-0000-4000-8000-000000004301';
  c2 constant uuid := 'a0d79000-0000-4000-8000-000000004302';
  r1 constant uuid := 'a0d79000-0000-4000-8000-000000004311';
  r2 constant uuid := 'a0d79000-0000-4000-8000-000000004312';
  ch constant uuid := 'a0d79000-0000-4000-8000-000000004320';
  x constant uuid := 'a0d79000-0000-4000-8000-000000004330';
  j1 constant uuid := 'a0d79000-0000-4000-8000-000000004341';
  j2 constant uuid := 'a0d79000-0000-4000-8000-000000004342';
  e1 text := 'automation:a0d79000-0000-4000-8000-000000004341:accepted';
  e2 text := 'automation:a0d79000-0000-4000-8000-000000004342:accepted';
  acc uuid; k1 uuid; k2 uuid; y uuid; y2 uuid; res1 text; res2 text; w2 uuid;
  y_msgs text; y2_msgs text; jobs text; notif text; n_x int; n_y int; n_w2 int; n_y2 int; n_wa_c2 int;
begin
  begin
    insert into public.customers (id, organization_id, name, phone) values
      (c1, org_a, 'ig79 cliente 43a', '11990004301'),
      (c2, org_a, 'ig79 cliente 43b', '11990004302');
    insert into public.reservations (id, unit_id, customer_id, party_size, date, time, reservation_code) values
      (r1, ua, c1, 2, current_date + 1, '20:00', 'IG7943A'),
      (r2, ua, c2, 2, current_date + 1, '20:30', 'IG7943B');
    insert into public.whatsapp_channels (id, unit_id, provider, status) values (ch, ua, 'zapi', 'connected');
    insert into public.conversations (id, unit_id, customer_id, messages, updated_at)
      values (x, ua, c1, '[]'::jsonb, now() - interval '1 day');

    acc := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ua, '79430001', 'conta_43', 'tok-43-A-000001', owner_a)));
    k1 := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_contact(acc, 'igsid-43a', 'user43a', 'IG 43a')));
    k2 := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_contact(acc, 'igsid-43b', 'user43b', 'IG 43b')));
    perform pg_temp.ig79_q('service_role', null, pg_temp.ig79_void(format('select public.link_instagram_contact_customer(%L::uuid, %L::uuid)', k1, c1)));
    perform pg_temp.ig79_q('service_role', null, pg_temp.ig79_void(format('select public.link_instagram_contact_customer(%L::uuid, %L::uuid)', k2, c2)));
    y := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, format('select public.get_or_create_instagram_conversation(%L::uuid)::text', k1)));
    y2 := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, format('select public.get_or_create_instagram_conversation(%L::uuid)::text', k2)));
    -- Y já traz o event_id do aceite do job 1 (a dedupe sem canal o acharia).
    update public.conversations set messages = jsonb_build_array(jsonb_build_object(
      'event_id', e1, 'role', 'user', 'author', 'customer', 'content', 'ig 43', 'timestamp', now()))
     where id = y;

    insert into public.whatsapp_automation_jobs (id, unit_id, organization_id, kind, reservation_id, customer_id,
      channel_id, provider, safe_log_body, state, claim_token, posting_started_at, provider_message_id, finished_at)
    values
      (j1, ua, org_a, 'confirmation', r1, c1, ch, 'zapi', 'ig79 aceite 43a', 'accepted', gen_random_uuid(),
       now() - interval '2 minutes', 'wamid-ig79-43a', now() - interval '1 minute'),
      (j2, ua, org_a, 'confirmation', r2, c2, ch, 'zapi', 'ig79 aceite 43b', 'accepted', gen_random_uuid(),
       now() - interval '2 minutes', 'wamid-ig79-43b', now() - interval '1 minute');

    res1 := pg_temp.ig79_q(null, null, format('select app_private.reconcile_whatsapp_automation_acceptance_inner(%L::uuid)::text', j1));
    res2 := pg_temp.ig79_q(null, null, format('select app_private.reconcile_whatsapp_automation_acceptance_inner(%L::uuid)::text', j2));

    n_x := pg_temp.ig79_evt(x, e1);
    n_y := pg_temp.ig79_evt(y, e1);
    select jsonb_array_length(messages)::text into y_msgs from public.conversations where id = y;
    select cv.id into w2 from public.conversations cv where cv.customer_id = c2 and cv.unit_id = ua and cv.channel = 'whatsapp';
    select count(*)::int into n_wa_c2 from public.conversations cv where cv.customer_id = c2 and cv.unit_id = ua and cv.channel = 'whatsapp';
    n_w2 := pg_temp.ig79_evt(w2, e2);
    n_y2 := pg_temp.ig79_evt(y2, e2);
    select jsonb_array_length(messages)::text into y2_msgs from public.conversations where id = y2;
    select string_agg(state || '/' || reconcile_required, ',' order by id) into jobs from public.whatsapp_automation_jobs where id in (j1, j2);
    select string_agg(n.status || '/' || n.whatsapp_provider || '/' || (n.whatsapp_channel_id = ch), ',' order by n.reservation_id) into notif
      from public.notifications_sent n where n.reservation_id in (r1, r2);

    raise exception using errcode = 'P0R79', message =
      case when y is not null and y2 is not null
            and res1 = '{"state": "reconciled", "history": "recorded"}'
            and res2 = '{"state": "reconciled", "history": "recorded"}'
            and n_x = 1 and n_y = 1 and y_msgs = '1'
            and w2 is not null and w2 <> y2 and n_wa_c2 = 1 and n_w2 = 1 and n_y2 = 0 and y2_msgs = '0'
            and jobs = 'reconciled/false,reconciled/false'
            and notif = 'sent/zapi/true,sent/zapi/true' then 'PASSOU'
           else 'FALHOU res1=' || res1 || ' res2=' || res2 || ' aceite_em_X=' || n_x || ' evento_em_Y=' || n_y
                || ' msgs_Y=' || coalesce(y_msgs, '<null>') || ' wa_c2=' || coalesce(w2::text, '<null>') || '/' || n_wa_c2
                || ' aceite_em_wa_c2=' || coalesce(n_w2::text, '<null>') || ' aceite_em_Y2=' || n_y2
                || ' msgs_Y2=' || coalesce(y2_msgs, '<null>') || ' jobs=' || coalesce(jobs, '<null>')
                || ' notif=' || coalesce(notif, '<null>') end;
  exception
    when sqlstate 'P0R79' then return sqlerrm;
    when others then return 'FALHOU erro inesperado ' || sqlstate || ':' || sqlerrm;
  end;
end $f$;

-- ─── IG-4.4: guarda de canal e tenant ──────────────────────────────────────
-- Conversa IG na unidade A com contato da unidade B (como service_role, o
-- escritor real, e como postgres), conversa IG em B com contato de A, mover a
-- conversa IG de unidade, cliente de outra organização numa conversa WhatsApp
-- e trocar o canal (WhatsApp→Instagram e Instagram→WhatsApp) dão 23514 sem
-- gravar. Fix round 1: mover de unidade é recusado para QUALQUER canal (a
-- conversa WhatsApp para a UA2 da mesma organização, onde nenhuma outra regra
-- recusaria), e a conversa IG só aceita o cliente do próprio contato (UPDATE
-- e INSERT com cliente quando o contato não tem nenhum).
create or replace function pg_temp.ig79_case_44() returns text language plpgsql as $f$
declare
  ua constant uuid := 'a0d79000-0000-4000-8000-0000000000aa';
  ub constant uuid := 'a0d79000-0000-4000-8000-0000000000bb';
  org_a constant uuid := 'a0d79000-0000-4000-8000-00000000000a';
  org_b constant uuid := 'a0d79000-0000-4000-8000-00000000000b';
  owner_a constant uuid := 'a0d79000-0000-4000-8000-0000000000a1';
  ger_b constant uuid := 'a0d79000-0000-4000-8000-0000000000b2';
  c_a constant uuid := 'a0d79000-0000-4000-8000-000000004401';
  c_b constant uuid := 'a0d79000-0000-4000-8000-000000004402';
  w constant uuid := 'a0d79000-0000-4000-8000-000000004410';
  ua2 constant uuid := 'a0d79000-0000-4000-8000-000000004420';
  acc_a uuid; acc_b uuid; k_a uuid; k_b uuid; k_a2 uuid; k_a3 uuid; k_a4 uuid; k_b2 uuid; y uuid;
  x_sr text; x_pg text; x_ba text; x_mover text; x_cli text; x_wa_ig text; x_ig_wa text; estado text;
  x_mover_wa text; x_ig_cli text; x_ig_cli_ins text;
begin
  begin
    insert into public.customers (id, organization_id, name, phone) values
      (c_a, org_a, 'ig79 cliente 44a', '11990004401'),
      (c_b, org_b, 'ig79 cliente 44b', '11990004402');
    insert into public.units (id, organization_id, name) values (ua2, org_a, 'ig79 UA2 44');
    insert into public.conversations (id, unit_id, customer_id) values (w, ua, c_a);
    acc_a := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ua, '79440001', 'conta_44a', 'tok-44-A-000001', owner_a)));
    acc_b := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ub, '79440002', 'conta_44b', 'tok-44-B-000001', ger_b)));
    k_a := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_contact(acc_a, 'igsid-44a', 'user44a', 'IG 44a')));
    k_b := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_contact(acc_b, 'igsid-44b', 'user44b', 'IG 44b')));
    k_a2 := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_contact(acc_a, 'igsid-44a2', 'user44a2', 'IG 44a2')));
    k_a3 := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_contact(acc_a, 'igsid-44a3', 'user44a3', 'IG 44a3')));
    k_b2 := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_contact(acc_b, 'igsid-44b2', 'user44b2', 'IG 44b2')));
    k_a4 := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_contact(acc_a, 'igsid-44a4', 'user44a4', 'IG 44a4')));
    y := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, format('select public.get_or_create_instagram_conversation(%L::uuid)::text', k_a)));

    -- Cada tentativa usa um contato ainda sem conversa: sob sabotagem a
    -- gravacao passa (e o indice unico por contato nao mascara o defeito).
    x_sr := pg_temp.ig79_q('service_role', null, format(
      'with i as (insert into public.conversations (unit_id, channel, instagram_contact_id) values (%L, ''instagram'', %L) returning 1) select count(*)::text from i', ua, k_b));
    x_pg := pg_temp.ig79_q(null, null, format(
      'with i as (insert into public.conversations (unit_id, channel, instagram_contact_id) values (%L, ''instagram'', %L) returning 1) select count(*)::text from i', ua, k_b2));
    x_ba := pg_temp.ig79_q(null, null, format(
      'with i as (insert into public.conversations (unit_id, channel, instagram_contact_id) values (%L, ''instagram'', %L) returning 1) select count(*)::text from i', ub, k_a2));
    x_mover := pg_temp.ig79_q(null, null, format(
      'with u as (update public.conversations set unit_id = %L where id = %L returning 1) select count(*)::text from u', ub, y));
    x_cli := pg_temp.ig79_q('service_role', null, format(
      'with i as (insert into public.conversations (unit_id, customer_id) values (%L, %L) returning 1) select count(*)::text from i', ua, c_b));
    x_mover_wa := pg_temp.ig79_q('service_role', null, format(
      'with u as (update public.conversations set unit_id = %L where id = %L returning 1) select count(*)::text from u', ua2, w));
    x_ig_cli := pg_temp.ig79_q('service_role', null, format(
      'with u as (update public.conversations set customer_id = %L where id = %L returning 1) select count(*)::text from u', c_a, y));
    x_ig_cli_ins := pg_temp.ig79_q('service_role', null, format(
      'with i as (insert into public.conversations (unit_id, customer_id, channel, instagram_contact_id) values (%L, %L, ''instagram'', %L) returning 1) select count(*)::text from i', ua, c_a, k_a4));
    x_wa_ig := pg_temp.ig79_q(null, null, format(
      'with u as (update public.conversations set channel = ''instagram'', customer_id = null, instagram_contact_id = %L where id = %L returning 1) select count(*)::text from u', k_a3, w));
    x_ig_wa := pg_temp.ig79_q(null, null, format(
      'with u as (update public.conversations set channel = ''whatsapp'', instagram_contact_id = null, customer_id = %L where id = %L returning 1) select count(*)::text from u', c_a, y));
    select string_agg(cv.channel || '/' || cv.unit_id, ',' order by cv.channel) into estado from public.conversations cv where cv.id in (w, y);

    raise exception using errcode = 'P0R79', message =
      case when y is not null and k_a2 is not null and k_a3 is not null and k_a4 is not null and k_b2 is not null
            and x_sr = 'ERR 23514:conversations: contato do Instagram nao e da unidade da conversa'
            and x_pg = 'ERR 23514:conversations: contato do Instagram nao e da unidade da conversa'
            and x_ba = 'ERR 23514:conversations: contato do Instagram nao e da unidade da conversa'
            and x_mover = 'ERR 23514:conversations: unidade e imutavel'
            and x_mover_wa = 'ERR 23514:conversations: unidade e imutavel'
            and x_ig_cli = 'ERR 23514:conversations: cliente da conversa do Instagram nao e o do contato'
            and x_ig_cli_ins = 'ERR 23514:conversations: cliente da conversa do Instagram nao e o do contato'
            and x_cli = 'ERR 23514:conversations: cliente nao e da organizacao da unidade'
            and x_wa_ig = 'ERR 23514:conversations: canal e imutavel'
            and x_ig_wa = 'ERR 23514:conversations: canal e imutavel'
            and estado = 'instagram/' || ua || ',whatsapp/' || ua then 'PASSOU'
           else 'FALHOU ig_contato_B_service_role=' || x_sr || ' ig_contato_B_postgres=' || x_pg
                || ' ig_em_B_contato_A=' || x_ba || ' mover_ig=' || x_mover || ' mover_wa=' || x_mover_wa
                || ' ig_cli_upd=' || x_ig_cli || ' ig_cli_ins=' || x_ig_cli_ins || ' cliente_outra_org=' || x_cli
                || ' wa_para_ig=' || x_wa_ig || ' ig_para_wa=' || x_ig_wa || ' estado=' || coalesce(estado, '<null>') end;
  exception
    when sqlstate 'P0R79' then return sqlerrm;
    when others then return 'FALHOU erro inesperado ' || sqlstate || ':' || sqlerrm;
  end;
end $f$;

-- ─── IG-4.5: get_or_create_instagram_conversation ──────────────────────────
-- Duas chamadas dão o mesmo id e UMA linha; unidade e cliente vêm do contato
-- (contato sem cliente nasce com `customer_id` nulo; contato ligado nasce com
-- o cliente); `contact_name = coalesce(name, '@'||username)` e é renovado
-- quando o perfil muda. Contato anonimizado: 42501; inexistente: P0002; nulo:
-- 22023. `authenticated` e `anon` sem EXECUTE (42501).
create or replace function pg_temp.ig79_case_45() returns text language plpgsql as $f$
declare
  ua constant uuid := 'a0d79000-0000-4000-8000-0000000000aa';
  org_a constant uuid := 'a0d79000-0000-4000-8000-00000000000a';
  owner_a constant uuid := 'a0d79000-0000-4000-8000-0000000000a1';
  c_a constant uuid := 'a0d79000-0000-4000-8000-000000004501';
  acc uuid; k1 uuid; k2 uuid; k3 uuid; a1 text; a2 text; b1 text; n int; v1 text; v2 text; v_ren text;
  x_anon text; x_nada text; x_nulo text; x_auth text; x_anon_role text;
begin
  begin
    insert into public.customers (id, organization_id, name, phone) values (c_a, org_a, 'ig79 cliente 45', '11990004501');
    acc := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ua, '79450001', 'conta_45', 'tok-45-A-000001', owner_a)));
    k1 := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_contact(acc, 'igsid-45a', 'user45a', null)));
    k2 := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_contact(acc, 'igsid-45b', 'user45b', 'Nome 45b')));
    k3 := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_contact(acc, 'igsid-45c', 'user45c', 'Nome 45c')));
    perform pg_temp.ig79_q('service_role', null, pg_temp.ig79_void(format('select public.link_instagram_contact_customer(%L::uuid, %L::uuid)', k2, c_a)));

    a1 := pg_temp.ig79_q('service_role', null, format('select public.get_or_create_instagram_conversation(%L::uuid)::text', k1));
    a2 := pg_temp.ig79_q('service_role', null, format('select public.get_or_create_instagram_conversation(%L::uuid)::text', k1));
    b1 := pg_temp.ig79_q('service_role', null, format('select public.get_or_create_instagram_conversation(%L::uuid)::text', k2));
    select count(*)::int into n from public.conversations where instagram_contact_id = k1;
    select cv.channel || '|' || cv.unit_id || '|' || coalesce(cv.customer_id::text, '-') || '|' || cv.contact_name into v1
      from public.conversations cv where cv.id = pg_temp.ig79_uuid(a1);
    select cv.channel || '|' || cv.unit_id || '|' || coalesce(cv.customer_id::text, '-') || '|' || cv.contact_name into v2
      from public.conversations cv where cv.id = pg_temp.ig79_uuid(b1);
    perform pg_temp.ig79_q('service_role', null, pg_temp.ig79_contact(acc, 'igsid-45a', null, 'Nome novo 45a'));
    perform pg_temp.ig79_q('service_role', null, format('select public.get_or_create_instagram_conversation(%L::uuid)::text', k1));
    select cv.contact_name into v_ren from public.conversations cv where cv.id = pg_temp.ig79_uuid(a1);

    update public.instagram_contacts set igsid = null, username = null, name = null, anonymized_at = now() where id = k3;
    x_anon := pg_temp.ig79_q('service_role', null, format('select public.get_or_create_instagram_conversation(%L::uuid)::text', k3));
    x_nada := pg_temp.ig79_q('service_role', null, format('select public.get_or_create_instagram_conversation(%L::uuid)::text', gen_random_uuid()));
    x_nulo := pg_temp.ig79_q('service_role', null, 'select public.get_or_create_instagram_conversation(null)::text');
    x_auth := pg_temp.ig79_q('authenticated', owner_a, format('select public.get_or_create_instagram_conversation(%L::uuid)::text', k1));
    x_anon_role := pg_temp.ig79_q('anon', null, format('select public.get_or_create_instagram_conversation(%L::uuid)::text', k1));

    raise exception using errcode = 'P0R79', message =
      case when pg_temp.ig79_uuid(a1) is not null and a2 = a1 and n = 1
            and v1 = 'instagram|' || ua || '|-|@user45a'
            and v2 = 'instagram|' || ua || '|' || c_a || '|Nome 45b'
            and v_ren = 'Nome novo 45a'
            and x_anon = 'ERR 42501:instagram_contact_anonymized'
            and x_nada = 'ERR P0002:instagram_contact_not_found'
            and x_nulo = 'ERR 22023:invalid_instagram_contact_argument'
            and x_auth like 'ERR 42501:permission denied for function get_or_create_instagram_conversation%'
            and x_anon_role like 'ERR 42501:permission denied for function get_or_create_instagram_conversation%' then 'PASSOU'
           else 'FALHOU primeira=' || a1 || ' segunda=' || a2 || ' linhas=' || n || ' sem_cliente=' || coalesce(v1, '<null>')
                || ' ligado=' || coalesce(v2, '<null>') || ' renovado=' || coalesce(v_ren, '<null>')
                || ' anonimizado=' || x_anon || ' inexistente=' || x_nada || ' nulo=' || x_nulo
                || ' authenticated=' || x_auth || ' anon=' || x_anon_role end;
  exception
    when sqlstate 'P0R79' then return sqlerrm;
    when others then return 'FALHOU erro inesperado ' || sqlstate || ':' || sqlerrm;
  end;
end $f$;

-- ─── IG-4.6: link_instagram_contact_customer ───────────────────────────────
-- Cliente de outra organização, cliente apagado, cliente inexistente, contato
-- inexistente e contato anonimizado: o MESMO 42501, sem gravar. Depois do
-- link, `customer_id`/`customer_linked_at` no contato e `customer_id` na
-- conversa; religar a outro cliente da organização troca os dois.
-- `authenticated` sem EXECUTE.
create or replace function pg_temp.ig79_case_46() returns text language plpgsql as $f$
declare
  ua constant uuid := 'a0d79000-0000-4000-8000-0000000000aa';
  org_a constant uuid := 'a0d79000-0000-4000-8000-00000000000a';
  org_b constant uuid := 'a0d79000-0000-4000-8000-00000000000b';
  owner_a constant uuid := 'a0d79000-0000-4000-8000-0000000000a1';
  c_a constant uuid := 'a0d79000-0000-4000-8000-000000004601';
  c_a2 constant uuid := 'a0d79000-0000-4000-8000-000000004602';
  c_b constant uuid := 'a0d79000-0000-4000-8000-000000004603';
  c_del constant uuid := 'a0d79000-0000-4000-8000-000000004604';
  acc uuid; k uuid; k_anon uuid; y uuid;
  x_b text; x_del text; x_inex text; x_contato text; x_anon text; x_auth text; antes text; ok1 text; depois1 text; ok2 text; depois2 text;
begin
  begin
    insert into public.customers (id, organization_id, name, phone, deleted_at) values
      (c_a, org_a, 'ig79 cliente 46a', '11990004601', null),
      (c_a2, org_a, 'ig79 cliente 46a2', '11990004602', null),
      (c_b, org_b, 'ig79 cliente 46b', '11990004603', null),
      (c_del, org_a, 'ig79 cliente 46 apagado', '11990004604', now());
    acc := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ua, '79460001', 'conta_46', 'tok-46-A-000001', owner_a)));
    k := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_contact(acc, 'igsid-46', 'user46', 'IG 46')));
    k_anon := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_contact(acc, 'igsid-46x', 'user46x', 'IG 46x')));
    update public.instagram_contacts set igsid = null, username = null, name = null, anonymized_at = now() where id = k_anon;
    y := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, format('select public.get_or_create_instagram_conversation(%L::uuid)::text', k)));

    x_b := pg_temp.ig79_q('service_role', null, pg_temp.ig79_void(format('select public.link_instagram_contact_customer(%L::uuid, %L::uuid)', k, c_b)));
    x_del := pg_temp.ig79_q('service_role', null, pg_temp.ig79_void(format('select public.link_instagram_contact_customer(%L::uuid, %L::uuid)', k, c_del)));
    x_inex := pg_temp.ig79_q('service_role', null, pg_temp.ig79_void(format('select public.link_instagram_contact_customer(%L::uuid, %L::uuid)', k, gen_random_uuid())));
    x_contato := pg_temp.ig79_q('service_role', null, pg_temp.ig79_void(format('select public.link_instagram_contact_customer(%L::uuid, %L::uuid)', gen_random_uuid(), c_a)));
    x_anon := pg_temp.ig79_q('service_role', null, pg_temp.ig79_void(format('select public.link_instagram_contact_customer(%L::uuid, %L::uuid)', k_anon, c_a)));
    x_auth := pg_temp.ig79_q('authenticated', owner_a, pg_temp.ig79_void(format('select public.link_instagram_contact_customer(%L::uuid, %L::uuid)', k, c_a)));
    select coalesce(c.customer_id::text, '-') || '|' || (c.customer_linked_at is not null) || '|' || coalesce(cv.customer_id::text, '-') into antes
      from public.instagram_contacts c join public.conversations cv on cv.instagram_contact_id = c.id where c.id = k;

    ok1 := pg_temp.ig79_q('service_role', null, pg_temp.ig79_void(format('select public.link_instagram_contact_customer(%L::uuid, %L::uuid)', k, c_a)));
    select coalesce(c.customer_id::text, '-') || '|' || (c.customer_linked_at is not null) || '|' || coalesce(cv.customer_id::text, '-') into depois1
      from public.instagram_contacts c join public.conversations cv on cv.instagram_contact_id = c.id where c.id = k;
    ok2 := pg_temp.ig79_q('service_role', null, pg_temp.ig79_void(format('select public.link_instagram_contact_customer(%L::uuid, %L::uuid)', k, c_a2)));
    select coalesce(c.customer_id::text, '-') || '|' || (c.customer_linked_at is not null) || '|' || coalesce(cv.customer_id::text, '-') into depois2
      from public.instagram_contacts c join public.conversations cv on cv.instagram_contact_id = c.id where c.id = k;

    raise exception using errcode = 'P0R79', message =
      case when y is not null
            and x_b = 'ERR 42501:instagram_contact_link_forbidden'
            and x_del = 'ERR 42501:instagram_contact_link_forbidden'
            and x_inex = 'ERR 42501:instagram_contact_link_forbidden'
            and x_contato = 'ERR 42501:instagram_contact_link_forbidden'
            and x_anon = 'ERR 42501:instagram_contact_link_forbidden'
            and x_auth like 'ERR 42501:permission denied for function link_instagram_contact_customer%'
            and antes = '-|false|-'
            and ok1 = 'ok' and depois1 = c_a || '|true|' || c_a
            and ok2 = 'ok' and depois2 = c_a2 || '|true|' || c_a2 then 'PASSOU'
           else 'FALHOU cliente_org_B=' || x_b || ' cliente_apagado=' || x_del || ' cliente_inexistente=' || x_inex
                || ' contato_inexistente=' || x_contato || ' contato_anonimizado=' || x_anon || ' authenticated=' || x_auth
                || ' antes=' || coalesce(antes, '<null>') || ' link=' || ok1 || ' depois=' || coalesce(depois1, '<null>')
                || ' religar=' || ok2 || ' depois_religar=' || coalesce(depois2, '<null>') end;
  exception
    when sqlstate 'P0R79' then return sqlerrm;
    when others then return 'FALHOU erro inesperado ' || sqlstate || ':' || sqlerrm;
  end;
end $f$;

-- ─── IG-4.7: A×B na conversa IG e ACL das colunas e funções novas ─────────
-- Papel real + claims: o owner de A lê a própria conversa IG e não lê a de B;
-- o gerente de B lê a de B; o platform_admin sem membership lê as duas.
-- `authenticated`/`anon` sem UPDATE nem INSERT em `channel` e
-- `instagram_contact_id` (e o UPDATE real do owner dá 42501), as cinco
-- colunas de handoff continuam com UPDATE. EXECUTE: as duas RPCs novas e o
-- get_or_create do WhatsApp só para service_role; o guard e o reconcile
-- inner para ninguém (fora o dono).
create or replace function pg_temp.ig79_case_47() returns text language plpgsql as $f$
declare
  ua constant uuid := 'a0d79000-0000-4000-8000-0000000000aa';
  ub constant uuid := 'a0d79000-0000-4000-8000-0000000000bb';
  owner_a constant uuid := 'a0d79000-0000-4000-8000-0000000000a1';
  ger_b constant uuid := 'a0d79000-0000-4000-8000-0000000000b2';
  pa constant uuid := 'a0d79000-0000-4000-8000-0000000000c1';
  acc_a uuid; acc_b uuid; k_a uuid; k_b uuid; y_a uuid; y_b uuid;
  r_a_a text; r_a_b text; r_b_b text; r_pa text; x_upd text; col_acl text; handoff text; fn_acl text;
begin
  begin
    acc_a := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ua, '79470001', 'conta_47a', 'tok-47-A-000001', owner_a)));
    acc_b := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ub, '79470002', 'conta_47b', 'tok-47-B-000001', ger_b)));
    k_a := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_contact(acc_a, 'igsid-47a', 'user47a', 'IG 47a')));
    k_b := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_contact(acc_b, 'igsid-47b', 'user47b', 'IG 47b')));
    y_a := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, format('select public.get_or_create_instagram_conversation(%L::uuid)::text', k_a)));
    y_b := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, format('select public.get_or_create_instagram_conversation(%L::uuid)::text', k_b)));

    r_a_a := pg_temp.ig79_q('authenticated', owner_a, format('select count(*)::text from public.conversations where id = %L', y_a));
    r_a_b := pg_temp.ig79_q('authenticated', owner_a, format('select count(*)::text from public.conversations where id = %L', y_b));
    r_b_b := pg_temp.ig79_q('authenticated', ger_b, format('select count(*)::text from public.conversations where id = %L', y_b));
    r_pa := pg_temp.ig79_q('authenticated', pa, format('select count(*)::text from public.conversations where id in (%L, %L)', y_a, y_b));
    x_upd := pg_temp.ig79_q('authenticated', owner_a, format(
      'with u as (update public.conversations set instagram_contact_id = null, channel = ''whatsapp'' where id = %L returning 1) select count(*)::text from u', y_a));

    select string_agg(r || ':' || c || ':' || p || '=' || has_column_privilege(r, 'public.conversations', c, p), ',' order by r, c, p) into col_acl
      from unnest(array['anon', 'authenticated']) r, unnest(array['channel', 'instagram_contact_id']) c, unnest(array['INSERT', 'UPDATE']) p;
    select string_agg(c || '=' || has_column_privilege('authenticated', 'public.conversations', c, 'UPDATE'), ',' order by c) into handoff
      from unnest(array['assigned_to', 'handoff_at', 'handoff_reason', 'status', 'updated_at']) c;
    select string_agg(f || '=' || coalesce((
        select string_agg(coalesce(r.rolname, 'PUBLIC'), '+' order by coalesce(r.rolname, 'PUBLIC'))
          from pg_proc p cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
          left join pg_roles r on r.oid = a.grantee
         where p.oid = f::regprocedure and a.privilege_type = 'EXECUTE' and coalesce(r.rolname, 'PUBLIC') <> 'postgres'), '-'), ',' order by f) into fn_acl
      from unnest(array['public.get_or_create_instagram_conversation(uuid)', 'public.link_instagram_contact_customer(uuid,uuid)',
                        'public.get_or_create_whatsapp_conversation(uuid,uuid,text,text)', 'public.conversations_channel_guard()',
                        'app_private.reconcile_whatsapp_automation_acceptance_inner(uuid)']) f;

    raise exception using errcode = 'P0R79', message =
      case when y_a is not null and y_b is not null
            and r_a_a = '1' and r_a_b = '0' and r_b_b = '1' and r_pa = '2'
            and x_upd like 'ERR 42501:permission denied for table conversations%'
            and col_acl = 'anon:channel:INSERT=false,anon:channel:UPDATE=false,anon:instagram_contact_id:INSERT=false,anon:instagram_contact_id:UPDATE=false,'
                       || 'authenticated:channel:INSERT=false,authenticated:channel:UPDATE=false,authenticated:instagram_contact_id:INSERT=false,authenticated:instagram_contact_id:UPDATE=false'
            and handoff = 'assigned_to=true,handoff_at=true,handoff_reason=true,status=true,updated_at=true'
            and fn_acl = 'app_private.reconcile_whatsapp_automation_acceptance_inner(uuid)=-,public.conversations_channel_guard()=-,'
                      || 'public.get_or_create_instagram_conversation(uuid)=service_role,public.get_or_create_whatsapp_conversation(uuid,uuid,text,text)=service_role,'
                      || 'public.link_instagram_contact_customer(uuid,uuid)=service_role' then 'PASSOU'
           else 'FALHOU A_le_A=' || r_a_a || ' A_le_B=' || r_a_b || ' B_le_B=' || r_b_b || ' admin=' || r_pa
                || ' update_owner=' || x_upd || ' colunas=' || coalesce(col_acl, '<null>')
                || ' handoff=' || coalesce(handoff, '<null>') || ' funcoes=' || coalesce(fn_acl, '<null>') end;
  exception
    when sqlstate 'P0R79' then return sqlerrm;
    when others then return 'FALHOU erro inesperado ' || sqlstate || ':' || sqlerrm;
  end;
end $f$;

-- ─── IG-4.8: anonimizar o contato limpa o nome da conversa IG (fix 1) ──────
-- Pelo caminho REAL: o platform_admin (papel real + claims) chama
-- anonymize_customer(CX) e o owner, como `authenticated`, faz o soft delete
-- direto de CZ. As conversas IG dos contatos de CX e CZ ficam com
-- `contact_name` nulo; a de CY (outro contato) fica intacta. A função do
-- trigger é SECURITY DEFINER e ninguém além do dono a executa.
create or replace function pg_temp.ig79_case_48() returns text language plpgsql as $f$
declare
  ua constant uuid := 'a0d79000-0000-4000-8000-0000000000aa';
  org_a constant uuid := 'a0d79000-0000-4000-8000-00000000000a';
  owner_a constant uuid := 'a0d79000-0000-4000-8000-0000000000a1';
  pa constant uuid := 'a0d79000-0000-4000-8000-0000000000c1';
  cx constant uuid := 'a0d79000-0000-4000-8000-000000004801';
  cy constant uuid := 'a0d79000-0000-4000-8000-000000004802';
  cz constant uuid := 'a0d79000-0000-4000-8000-000000004803';
  acc uuid; kx uuid; ky uuid; kz uuid; vx uuid; vy uuid; vz uuid;
  an text; sd text; nx text; ny text; nz text; antes text; fn text;
begin
  begin
    insert into public.customers (id, organization_id, name, phone) values
      (cx, org_a, 'ig79 cliente 48x', '11990004801'),
      (cy, org_a, 'ig79 cliente 48y', '11990004802'),
      (cz, org_a, 'ig79 cliente 48z', '11990004803');
    acc := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ua, '79480001', 'conta_48', 'tok-48-A-000001', owner_a)));
    kx := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_contact(acc, 'igsid-48x', 'user48x', 'Nome 48x')));
    ky := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_contact(acc, 'igsid-48y', 'user48y', 'Nome 48y')));
    kz := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_contact(acc, 'igsid-48z', 'user48z', null)));
    perform pg_temp.ig79_q('service_role', null, pg_temp.ig79_void(format('select public.link_instagram_contact_customer(%L::uuid, %L::uuid)', kx, cx)));
    perform pg_temp.ig79_q('service_role', null, pg_temp.ig79_void(format('select public.link_instagram_contact_customer(%L::uuid, %L::uuid)', ky, cy)));
    perform pg_temp.ig79_q('service_role', null, pg_temp.ig79_void(format('select public.link_instagram_contact_customer(%L::uuid, %L::uuid)', kz, cz)));
    vx := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, format('select public.get_or_create_instagram_conversation(%L::uuid)::text', kx)));
    vy := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, format('select public.get_or_create_instagram_conversation(%L::uuid)::text', ky)));
    vz := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, format('select public.get_or_create_instagram_conversation(%L::uuid)::text', kz)));
    select (select coalesce(contact_name, '<null>') from public.conversations where id = vx) || ','
        || (select coalesce(contact_name, '<null>') from public.conversations where id = vy) || ','
        || (select coalesce(contact_name, '<null>') from public.conversations where id = vz) into antes;

    an := pg_temp.ig79_q('authenticated', pa, pg_temp.ig79_void(format('public.anonymize_customer(%L::uuid)', cx)));
    sd := pg_temp.ig79_q('authenticated', owner_a, format(
      'with u as (update public.customers set deleted_at = now() where id = %L returning 1) select count(*)::text from u', cz));

    select coalesce(cv.contact_name, '<null>') into nx from public.conversations cv where cv.id = vx;
    select coalesce(cv.contact_name, '<null>') into ny from public.conversations cv where cv.id = vy;
    select coalesce(cv.contact_name, '<null>') into nz from public.conversations cv where cv.id = vz;
    select p.prosecdef || '/' || coalesce((
        select string_agg(coalesce(r.rolname, 'PUBLIC'), '+' order by coalesce(r.rolname, 'PUBLIC'))
          from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
          left join pg_roles r on r.oid = a.grantee
         where a.privilege_type = 'EXECUTE' and coalesce(r.rolname, 'PUBLIC') <> 'postgres'), '-') into fn
      from pg_proc p where p.oid = 'public.conversations_clear_instagram_contact_name()'::regprocedure;

    raise exception using errcode = 'P0R79', message =
      case when vx is not null and vy is not null and vz is not null
            and antes = 'Nome 48x,Nome 48y,@user48z'
            and an = 'ok' and sd = '1'
            and nx = '<null>' and nz = '<null>' and ny = 'Nome 48y'
            and fn = 'true/-' then 'PASSOU'
           else 'FALHOU antes=' || coalesce(antes, '<null>') || ' anonymize_x=' || an || ' soft_delete_z=' || sd
                || ' nome_x=' || coalesce(nx, '<null>') || ' nome_y=' || coalesce(ny, '<null>')
                || ' nome_z=' || coalesce(nz, '<null>') || ' funcao=' || coalesce(fn, '<null>') end;
  exception
    when sqlstate 'P0R79' then return sqlerrm;
    when others then return 'FALHOU erro inesperado ' || sqlstate || ':' || sqlerrm;
  end;
end $f$;

-- ─── Casos da Task 1.5 (origem `instagram`, D6) ─────────────────────────────
-- IG-5.1: com o escritor real (`service_role`, o worker do Instagram), a
-- reserva `source='instagram'` é aceita e o trigger REAL da 028 (79a, seção
-- 3c) enfileira UMA `confirmation` pendente na unidade da reserva — D6: a
-- confirmação de reserva do Instagram vai pelo WhatsApp. `whatsapp` não
-- enfileira; `web` enfileira; origem fora da lista dá 23514 no
-- `reservations_source_check`.
create or replace function pg_temp.ig79_case_51() returns text language plpgsql as $f$
declare
  ua constant uuid := 'a0d79000-0000-4000-8000-0000000000aa';
  org_a constant uuid := 'a0d79000-0000-4000-8000-00000000000a';
  cu constant uuid := 'a0d79000-0000-4000-8000-000000005101';
  r_ig constant uuid := 'a0d79000-0000-4000-8000-000000005111';
  r_wa constant uuid := 'a0d79000-0000-4000-8000-000000005112';
  r_web constant uuid := 'a0d79000-0000-4000-8000-000000005113';
  r_x constant uuid := 'a0d79000-0000-4000-8000-000000005114';
  ins_ig text; ins_wa text; ins_web text; ins_x text; src text; ob_ig text; ob_wa text; ob_web text; ob_x text;
begin
  begin
    insert into public.customers (id, organization_id, name, phone) values (cu, org_a, 'ig79 cliente 51', '11990005101');
    ins_ig := pg_temp.ig79_q('service_role', null, format(
      'with i as (insert into public.reservations (id, unit_id, customer_id, party_size, date, time, reservation_code, source) '
      'values (%L, %L, %L, 2, current_date + 1, ''20:00'', ''IG51IG'', ''instagram'') returning 1) select count(*)::text from i', r_ig, ua, cu));
    ins_wa := pg_temp.ig79_q('service_role', null, format(
      'with i as (insert into public.reservations (id, unit_id, customer_id, party_size, date, time, reservation_code, source) '
      'values (%L, %L, %L, 2, current_date + 1, ''20:30'', ''IG51WA'', ''whatsapp'') returning 1) select count(*)::text from i', r_wa, ua, cu));
    ins_web := pg_temp.ig79_q('service_role', null, format(
      'with i as (insert into public.reservations (id, unit_id, customer_id, party_size, date, time, reservation_code) '
      'values (%L, %L, %L, 2, current_date + 1, ''21:00'', ''IG51WB'') returning 1) select count(*)::text from i', r_web, ua, cu));
    ins_x := pg_temp.ig79_q('service_role', null, format(
      'with i as (insert into public.reservations (id, unit_id, customer_id, party_size, date, time, reservation_code, source) '
      'values (%L, %L, %L, 2, current_date + 1, ''21:30'', ''IG51TT'', ''tiktok'') returning 1) select count(*)::text from i', r_x, ua, cu));

    select coalesce(r.source, '<null>') into src from public.reservations r where r.id = r_ig;
    select string_agg(o.kind || '/' || o.status || '/' || (o.unit_id = ua), ',') into ob_ig from public.notification_outbox o where o.reservation_id = r_ig;
    select string_agg(o.kind || '/' || o.status || '/' || (o.unit_id = ua), ',') into ob_wa from public.notification_outbox o where o.reservation_id = r_wa;
    select string_agg(o.kind || '/' || o.status || '/' || (o.unit_id = ua), ',') into ob_web from public.notification_outbox o where o.reservation_id = r_web;
    select count(*)::text into ob_x from public.reservations r where r.id = r_x;

    raise exception using errcode = 'P0R79', message =
      case when ins_ig = '1' and src = 'instagram' and ob_ig = 'confirmation/pending/true'
            and ins_wa = '1' and ob_wa is null
            and ins_web = '1' and ob_web = 'confirmation/pending/true'
            and ins_x like 'ERR 23514:%reservations_source_check%' and ob_x = '0' then 'PASSOU'
           else 'FALHOU ins_ig=' || ins_ig || ' source_ig=' || coalesce(src, '<null>') || ' outbox_ig=' || coalesce(ob_ig, '<null>')
                || ' ins_wa=' || ins_wa || ' outbox_wa=' || coalesce(ob_wa, '<null>')
                || ' ins_web=' || ins_web || ' outbox_web=' || coalesce(ob_web, '<null>')
                || ' ins_tiktok=' || ins_x || ' ' end;
  exception
    when sqlstate 'P0R79' then return sqlerrm;
    when others then return 'FALHOU erro inesperado ' || sqlstate || ':' || sqlerrm;
  end;
end $f$;

-- IG-5.2: catálogo. UM CHECK sobre `source` em `reservations`, com o nome de
-- produção, a lista nova e VALIDADO (entrou NOT VALID e foi validado); a
-- coluna segue `not null default 'web'`; o trigger da 028 está lá, AFTER
-- INSERT, e o corpo é o da 028 — filtra só `whatsapp` e não menciona
-- `instagram` (D6: a migration não toca o trigger).
create or replace function pg_temp.ig79_case_52() returns text language plpgsql as $f$
declare
  chk text; col text; trg text; fn text;
begin
  select string_agg(c.conname || '=' || pg_get_constraintdef(c.oid) || '/' || c.convalidated, ',' order by c.conname) into chk
    from pg_constraint c
   where c.conrelid = 'public.reservations'::regclass and c.contype = 'c'
     and pg_get_constraintdef(c.oid) ~ '\msource\M';
  select a.attnotnull || '/' || coalesce(pg_get_expr(d.adbin, d.adrelid), '-') into col
    from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where a.attrelid = 'public.reservations'::regclass and a.attname = 'source' and not a.attisdropped;
  select t.tgenabled::text || '/' || pg_get_triggerdef(t.oid) into trg
    from pg_trigger t
   where t.tgrelid = 'public.reservations'::regclass and t.tgname = 'enqueue_confirmation_after_insert';
  select case when pg_temp.ig79_lf(p.prosrc) like '%if new.source is distinct from ''whatsapp'' then%'
               and pg_temp.ig79_lf(p.prosrc) not like '%instagram%' then 'corpo_028' else 'corpo_alterado' end into fn
    from pg_proc p where p.oid = 'public.enqueue_confirmation_notification()'::regprocedure;
  if chk = 'reservations_source_check=CHECK ((source = ANY (ARRAY[''web''::text, ''whatsapp''::text, ''instagram''::text])))/true'
     and col = 'true/''web''::text'
     and trg = 'O/CREATE TRIGGER enqueue_confirmation_after_insert AFTER INSERT ON public.reservations FOR EACH ROW EXECUTE FUNCTION enqueue_confirmation_notification()'
     and fn = 'corpo_028' then
    return 'PASSOU';
  end if;
  return 'FALHOU check=' || coalesce(chk, '<null>') || ' coluna=' || coalesce(col, '<null>')
         || ' trigger=' || coalesce(trg, '<null>') || ' funcao=' || coalesce(fn, '<null>') || ' ';
end $f$;

-- ═══ Task 1.6 (fix round 1): autorização nas RPCs de conta, contatos só por
-- RPC e conversa IG sem wa_chat_lid ═══════════════════════════════════════════

-- ─── IG-6.1: store_instagram_account_connection autoriza no SQL ─────────────
-- Sem grant (nunca concedido) o owner E o platform_admin recebem 42501 (o
-- admin não pula o módulo). Com UA e UB liberadas pelo
-- platform_admin real: operador de UA, owner de A na unidade B, unidade
-- inexistente e ator nulo recebem o MESMO 42501 e nenhuma conta nasce. Owner
-- e gerente de UA conectam (a mesma linha). Revogado o grant de UA, o owner
-- volta a receber 42501. platform_admin SEM membership conecta em UB
-- (connected_by = ele, organização de B).
create or replace function pg_temp.ig79_case_61() returns text language plpgsql as $f$
declare
  ua constant uuid := 'a0d79000-0000-4000-8000-0000000000aa';
  ub constant uuid := 'a0d79000-0000-4000-8000-0000000000bb';
  ghost constant uuid := 'a0d79000-0000-4000-8000-0000000000ff';
  org_b constant uuid := 'a0d79000-0000-4000-8000-00000000000b';
  owner_a constant uuid := 'a0d79000-0000-4000-8000-0000000000a1';
  ger_a constant uuid := 'a0d79000-0000-4000-8000-0000000000a2';
  op_a constant uuid := 'a0d79000-0000-4000-8000-0000000000a3';
  pa constant uuid := 'a0d79000-0000-4000-8000-0000000000c1';
  f constant text := 'ERR 42501:instagram_account_forbidden';
  sem_grant text; pa_sem_grant text; g1 text; g2 text; op text; outra text; inex text; sem_ator text; n0 int;
  ok_owner text; ok_ger text; rv text; revogado text; ok_pa text; estado_pa text;
begin
  begin
    sem_grant := pg_temp.ig79_q('service_role', null, pg_temp.ig79_store_raw(ua, '79610001', 'conta_61', 'tok-61-A-000001', owner_a));
    pa_sem_grant := pg_temp.ig79_q('service_role', null, pg_temp.ig79_store_raw(ua, '79610001', 'conta_61', 'tok-61-A-000007', pa));
    g1 := pg_temp.ig79_q('authenticated', pa, pg_temp.ig79_set(ua, true));
    g2 := pg_temp.ig79_q('authenticated', pa, pg_temp.ig79_set(ub, true));
    op := pg_temp.ig79_q('service_role', null, pg_temp.ig79_store_raw(ua, '79610001', 'conta_61', 'tok-61-A-000002', op_a));
    outra := pg_temp.ig79_q('service_role', null, pg_temp.ig79_store_raw(ub, '79610002', 'conta_61b', 'tok-61-B-000001', owner_a));
    inex := pg_temp.ig79_q('service_role', null, pg_temp.ig79_store_raw(ghost, '79610003', 'conta_61x', 'tok-61-X-000001', owner_a));
    sem_ator := pg_temp.ig79_q('service_role', null, pg_temp.ig79_store_raw(ua, '79610001', 'conta_61', 'tok-61-A-000003', null));
    select count(*) into n0 from public.instagram_accounts a where a.unit_id in (ua, ub) or a.ig_user_id like '7961%';

    ok_owner := pg_temp.ig79_q('service_role', null, pg_temp.ig79_store_raw(ua, '79610001', 'conta_61', 'tok-61-A-000004', owner_a));
    ok_ger := pg_temp.ig79_q('service_role', null, pg_temp.ig79_store_raw(ua, '79610001', 'conta_61g', 'tok-61-A-000005', ger_a));

    rv := pg_temp.ig79_q('authenticated', pa, pg_temp.ig79_set(ua, false));
    revogado := pg_temp.ig79_q('service_role', null, pg_temp.ig79_store_raw(ua, '79610001', 'conta_61', 'tok-61-A-000006', owner_a));

    ok_pa := pg_temp.ig79_q('service_role', null, pg_temp.ig79_store_raw(ub, '79610002', 'conta_61b', 'tok-61-B-000002', pa));
    select a.status || '|' || a.connected_by || '|' || a.organization_id into estado_pa
      from public.instagram_accounts a where a.id = pg_temp.ig79_uuid(ok_pa);

    raise exception using errcode = 'P0R79', message =
      case when sem_grant = f and pa_sem_grant = f
            and g1 = 'instagram/true/true/false' and g2 = 'instagram/true/true/false'
            and op = f and outra = f and inex = f and sem_ator = f and n0 = 0
            and pg_temp.ig79_uuid(ok_owner) is not null and ok_ger = ok_owner
            and rv = 'instagram/false/true/true' and revogado = f
            and pg_temp.ig79_uuid(ok_pa) is not null
            and estado_pa = 'connected|' || pa || '|' || org_b then 'PASSOU'
           else 'FALHOU sem_grant=' || sem_grant || ' pa_sem_grant=' || pa_sem_grant || ' grants=' || g1 || '/' || g2 || ' operador=' || op
                || ' owner_A_em_B=' || outra || ' inexistente=' || inex || ' ator_nulo=' || sem_ator
                || ' contas_apos_recusas=' || n0 || ' owner=' || ok_owner || ' gerente=' || ok_ger
                || ' revogar=' || rv || ' owner_revogado=' || revogado || ' pa=' || ok_pa
                || ' estado_pa=' || coalesce(estado_pa, '<null>') end;
  exception
    when sqlstate 'P0R79' then return sqlerrm;
    when others then return 'FALHOU erro inesperado ' || sqlstate || ':' || sqlerrm;
  end;
end $f$;

-- ─── IG-6.2: disconnect_instagram_account prende o ator à unidade da conta ──
-- Contas em UA e UB. Operador de UA, owner de A na conta de B, gerente de B na
-- conta de A, ator nulo e conta inexistente (owner de A) recebem o MESMO 42501 e a conta segue conectada com o
-- token legível. Com o grant de UA revogado, o owner de UA desconecta (o
-- disconnect não exige o módulo) e o platform_admin sem membership desconecta
-- a de B; `disconnected_by` é o ator.
create or replace function pg_temp.ig79_case_62() returns text language plpgsql as $f$
declare
  ua constant uuid := 'a0d79000-0000-4000-8000-0000000000aa';
  ub constant uuid := 'a0d79000-0000-4000-8000-0000000000bb';
  owner_a constant uuid := 'a0d79000-0000-4000-8000-0000000000a1';
  op_a constant uuid := 'a0d79000-0000-4000-8000-0000000000a3';
  ger_b constant uuid := 'a0d79000-0000-4000-8000-0000000000b2';
  pa constant uuid := 'a0d79000-0000-4000-8000-0000000000c1';
  f constant text := 'ERR 42501:instagram_account_forbidden';
  acc_a uuid; acc_b uuid; d_op text; d_outra text; d_ger_b text; d_nulo text; d_ghost text; est_a text; tok_a text; est_b text;
  d_owner text; d_pa text; fim_a text; fim_b text;
begin
  begin
    acc_a := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ua, '79620001', 'conta_62', 'tok-62-A-000001', owner_a)));
    acc_b := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ub, '79620002', 'conta_62b', 'tok-62-B-000001', ger_b)));

    d_op := pg_temp.ig79_q('service_role', null, pg_temp.ig79_void(format(
      'public.disconnect_instagram_account(%L::uuid, %L::uuid)', acc_a, op_a)));
    d_outra := pg_temp.ig79_q('service_role', null, pg_temp.ig79_void(format(
      'public.disconnect_instagram_account(%L::uuid, %L::uuid)', acc_b, owner_a)));
    d_ger_b := pg_temp.ig79_q('service_role', null, pg_temp.ig79_void(format(
      'public.disconnect_instagram_account(%L::uuid, %L::uuid)', acc_a, ger_b)));
    d_nulo := pg_temp.ig79_q('service_role', null, pg_temp.ig79_void(format(
      'public.disconnect_instagram_account(%L::uuid, null::uuid)', acc_a)));
    d_ghost := pg_temp.ig79_q('service_role', null, pg_temp.ig79_void(format(
      'public.disconnect_instagram_account(%L::uuid, %L::uuid)', 'a0d79000-0000-4000-8000-0000000062ff', owner_a)));
    select a.status || '|' || (a.token_secret_id is not null) into est_a from public.instagram_accounts a where a.id = acc_a;
    select a.status || '|' || (a.token_secret_id is not null) into est_b from public.instagram_accounts a where a.id = acc_b;
    tok_a := pg_temp.ig79_q('service_role', null, format('select public.get_instagram_account_token(%L::uuid)', acc_a));

    update public.unit_module_grants g set revoked_at = now(), revoked_by = pa
     where g.unit_id = ua and g.module = 'instagram' and g.revoked_at is null;
    d_owner := pg_temp.ig79_q('service_role', null, pg_temp.ig79_void(format(
      'public.disconnect_instagram_account(%L::uuid, %L::uuid)', acc_a, owner_a)));
    d_pa := pg_temp.ig79_q('service_role', null, pg_temp.ig79_void(format(
      'public.disconnect_instagram_account(%L::uuid, %L::uuid)', acc_b, pa)));
    select a.status || '|' || a.disconnected_by into fim_a from public.instagram_accounts a where a.id = acc_a;
    select a.status || '|' || a.disconnected_by into fim_b from public.instagram_accounts a where a.id = acc_b;

    raise exception using errcode = 'P0R79', message =
      case when acc_a is not null and acc_b is not null
            and d_op = f and d_outra = f and d_ger_b = f and d_nulo = f and d_ghost = f
            and est_a = 'connected|true' and est_b = 'connected|true' and tok_a = 'tok-62-A-000001'
            and d_owner = 'ok' and d_pa = 'ok'
            and fim_a = 'disconnected|' || owner_a and fim_b = 'disconnected|' || pa then 'PASSOU'
           else 'FALHOU contas=' || coalesce(acc_a::text, '<null>') || '/' || coalesce(acc_b::text, '<null>')
                || ' operador=' || d_op || ' owner_A_em_B=' || d_outra || ' gerente_B_em_A=' || d_ger_b
                || ' ator_nulo=' || d_nulo || ' conta_inexistente=' || d_ghost || ' estado_A=' || coalesce(est_a, '<null>') || ' estado_B=' || coalesce(est_b, '<null>')
                || ' token_A=' || tok_a || ' owner_revogado=' || d_owner || ' pa=' || d_pa
                || ' fim_A=' || coalesce(fim_a, '<null>') || ' fim_B=' || coalesce(fim_b, '<null>') end;
  exception
    when sqlstate 'P0R79' then return sqlerrm;
    when others then return 'FALHOU erro inesperado ' || sqlstate || ':' || sqlerrm;
  end;
end $f$;

-- ─── IG-6.3: contatos só por RPC/trigger DEFINER; anonimização sem volta ────
-- `service_role` lê o contato, mas UPDATE direto (de `customer_id`), INSERT e
-- DELETE diretos dão 42501; o link pela RPC (DEFINER) continua gravando.
-- Anonimizado o contato (como postgres), devolver `anonymized_at` a nulo,
-- mesmo com um IGSID novo que satisfaz o CHECK, dá 23514 da guarda. Catálogo:
-- os escritores de contato são SECURITY DEFINER.
create or replace function pg_temp.ig79_case_63() returns text language plpgsql as $f$
declare
  ua constant uuid := 'a0d79000-0000-4000-8000-0000000000aa';
  org_a constant uuid := 'a0d79000-0000-4000-8000-00000000000a';
  owner_a constant uuid := 'a0d79000-0000-4000-8000-0000000000a1';
  c_a constant uuid := 'a0d79000-0000-4000-8000-000000006301';
  acc uuid; k uuid; upd text; ins text; del text; sel text; lnk text; cli text; desanon text; estado text; defs text;
begin
  begin
    insert into public.customers (id, organization_id, name, phone) values (c_a, org_a, 'ig79 cliente 63', '11990006301');
    acc := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ua, '79630001', 'conta_63', 'tok-63-A-000001', owner_a)));
    k := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_contact(acc, 'igsid-63', 'user63', 'Nome 63')));

    upd := pg_temp.ig79_q('service_role', null, format(
      'with u as (update public.instagram_contacts set customer_id = %L where id = %L returning 1) select count(*)::text from u', c_a, k));
    ins := pg_temp.ig79_q('service_role', null, format(
      'with i as (insert into public.instagram_contacts (organization_id, unit_id, instagram_account_id, igsid) '
      'values (%L, %L, %L, ''igsid-63x'') returning 1) select count(*)::text from i', org_a, ua, acc));
    del := pg_temp.ig79_q('service_role', null, format(
      'with d as (delete from public.instagram_contacts where id = %L returning 1) select count(*)::text from d', k));
    sel := pg_temp.ig79_q('service_role', null, format('select count(*)::text from public.instagram_contacts where id = %L', k));
    lnk := pg_temp.ig79_q('service_role', null, pg_temp.ig79_void(format(
      'public.link_instagram_contact_customer(%L::uuid, %L::uuid)', k, c_a)));
    select coalesce(c.customer_id::text, '<null>') into cli from public.instagram_contacts c where c.id = k;

    update public.instagram_contacts c
       set igsid = null, username = null, name = null, anonymized_at = now()
     where c.id = k;
    desanon := pg_temp.ig79_q(null, null, format(
      'with u as (update public.instagram_contacts set anonymized_at = null, igsid = ''igsid-63-volta'' where id = %L returning 1) '
      'select count(*)::text from u', k));
    select (c.anonymized_at is not null) || '|' || coalesce(c.igsid, '<null>') into estado
      from public.instagram_contacts c where c.id = k;

    select string_agg(p.proname || ':' || p.prosecdef, ',' order by p.proname) into defs
      from pg_proc p
     where p.oid in ('public.upsert_instagram_contact(uuid,text,text,text)'::regprocedure,
                     'public.link_instagram_contact_customer(uuid,uuid)'::regprocedure,
                     'public.instagram_contacts_anonymize_on_customer()'::regprocedure,
                     'public.get_or_create_instagram_conversation(uuid)'::regprocedure);

    raise exception using errcode = 'P0R79', message =
      case when acc is not null and k is not null
            and upd like 'ERR 42501:permission denied for table instagram_contacts%'
            and ins like 'ERR 42501:permission denied for table instagram_contacts%'
            and del like 'ERR 42501:permission denied for table instagram_contacts%'
            and sel = '1' and lnk = 'ok' and cli = c_a::text
            and desanon = 'ERR 23514:instagram_contacts: anonimizacao e irreversivel'
            and estado = 'true|<null>'
            and defs = 'get_or_create_instagram_conversation:true,instagram_contacts_anonymize_on_customer:true,link_instagram_contact_customer:true,upsert_instagram_contact:true' then 'PASSOU'
           else 'FALHOU update_direto=' || upd || ' insert_direto=' || ins || ' delete_direto=' || del
                || ' service_le=' || sel || ' link=' || lnk || ' cliente=' || coalesce(cli, '<null>')
                || ' desanonimizar=' || desanon || ' estado=' || coalesce(estado, '<null>')
                || ' definer=' || coalesce(defs, '<null>') end;
  exception
    when sqlstate 'P0R79' then return sqlerrm;
    when others then return 'FALHOU erro inesperado ' || sqlstate || ':' || sqlerrm;
  end;
end $f$;

-- ─── IG-6.4: conversa do Instagram nunca carrega wa_chat_lid ─────────────────
-- Como postgres: INSERT de conversa IG com `wa_chat_lid` e UPDATE que o põe
-- numa conversa IG existente violam `conversations_channel_identity_check`
-- (23514). WhatsApp com `wa_chat_lid` segue aceito. Catálogo: o CHECK cita
-- `wa_chat_lid IS NULL` e está validado.
create or replace function pg_temp.ig79_case_64() returns text language plpgsql as $f$
declare
  ua constant uuid := 'a0d79000-0000-4000-8000-0000000000aa';
  org_a constant uuid := 'a0d79000-0000-4000-8000-00000000000a';
  owner_a constant uuid := 'a0d79000-0000-4000-8000-0000000000a1';
  c_a constant uuid := 'a0d79000-0000-4000-8000-000000006401';
  acc uuid; k uuid; ig_lid text; conv text; upd_lid text; wa_lid text; cat text;
begin
  begin
    insert into public.customers (id, organization_id, name, phone) values (c_a, org_a, 'ig79 cliente 64', '11990006401');
    acc := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_store(ua, '79640001', 'conta_64', 'tok-64-A-000001', owner_a)));
    k := pg_temp.ig79_uuid(pg_temp.ig79_q('service_role', null, pg_temp.ig79_contact(acc, 'igsid-64', 'user64', 'Nome 64')));

    ig_lid := pg_temp.ig79_q(null, null, format(
      'with i as (insert into public.conversations (unit_id, channel, instagram_contact_id, wa_chat_lid) '
      'values (%L, ''instagram'', %L, ''lid-64@lid'') returning 1) select count(*)::text from i', ua, k));
    conv := pg_temp.ig79_q('service_role', null, format('select public.get_or_create_instagram_conversation(%L::uuid)::text', k));
    upd_lid := pg_temp.ig79_q(null, null, format(
      'with u as (update public.conversations set wa_chat_lid = ''lid-64b@lid'' where id = %L returning 1) select count(*)::text from u',
      pg_temp.ig79_uuid(conv)));
    wa_lid := pg_temp.ig79_q(null, null, format(
      'with i as (insert into public.conversations (unit_id, customer_id, wa_chat_lid) values (%L, %L, ''lid-64w@lid'') returning channel) '
      'select string_agg(channel, '','') from i', ua, c_a));
    select pg_get_constraintdef(c.oid) || '/' || c.convalidated into cat
      from pg_constraint c where c.conrelid = 'public.conversations'::regclass and c.conname = 'conversations_channel_identity_check';

    raise exception using errcode = 'P0R79', message =
      case when acc is not null and k is not null
            and ig_lid like 'ERR 23514:%conversations_channel_identity_check%'
            and pg_temp.ig79_uuid(conv) is not null
            and upd_lid like 'ERR 23514:%conversations_channel_identity_check%'
            and wa_lid = 'whatsapp'
            and cat like '%''instagram''::text) AND (instagram_contact_id IS NOT NULL) AND (wa_chat_lid IS NULL)%/true' then 'PASSOU'
           else 'FALHOU ig_com_lid=' || ig_lid || ' conversa_ig=' || conv || ' update_lid=' || upd_lid
                || ' wa_com_lid=' || wa_lid || ' check=' || coalesce(cat, '<null>') end;
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
  (7925, 'IG-2.6 anonymize_customer como platform_admin anonimiza o contato do cliente; contato de outro cliente e update noop de deleted_at intactos', pg_temp.ig79_case_26()),
  (7926, 'IG-2.7 conectar, reconectar e desconectar deixam linha no audit_log; disconnected_by = ator (coluna e new_values); reconectar limpa', pg_temp.ig79_case_27()),
  (7927, 'IG-2.8 ponteiro do Vault apontado para segredo alheio: getter, refresh, store e disconnect recusam com 42501 e o segredo alheio fica intacto', pg_temp.ig79_case_28()),
  (7928, 'IG-2.9 owner de A como authenticated faz soft delete direto em customers e o contato e anonimizado (trigger DEFINER)', pg_temp.ig79_case_29()),
  (7929, 'IG-2.10 ig_user_id e token normalizados (espaco colide), nao numerico recusado (22023/23514), connected limpa last_error_code, contato em conta desconectada 55000', pg_temp.ig79_case_30());

insert into t_res values
  (7940, 'IG-3.1 claim do evento: lease vivo nega o 2o claim, takeover da claim_id novo e gasta tentativa; finalize com claim aleatorio ou antigo devolve 0; retry reagenda; done nao volta', pg_temp.ig79_case_31()),
  (7941, 'IG-3.2 ledger: claim 2x devolve null; lease vencido da claim novo e complete com o antigo devolve false; eco/descarte gravado done sem sobrescrever', pg_temp.ig79_case_32()),
  (7942, 'IG-3.3 evento/ledger com unidade de outra conta, conta inexistente e mover recusados com 23514 (service_role e postgres); CHECK de sha256/segredo; dedupe por conta', pg_temp.ig79_case_33()),
  (7943, 'IG-3.4 get_instagram_diagnostics: owner/gerente/operador/sem sub com o mesmo 42501, anon sem EXECUTE; platform_admin le contagens e desfechos 24h sem conteudo; escopo por unidade', pg_temp.ig79_case_34()),
  (7944, 'IG-3.5 purga: done 7d e dead 30d na fila, 30d no ledger; linha viva e linha dentro da janela ficam; repetir nao apaga mais', pg_temp.ig79_case_35()),
  (7945, 'IG-3.6 ACL: RPCs da fila/ledger so service_role, diagnostico so authenticated, wrappers e guard para ninguem; FORCE RLS sem policy; service_role so SELECT+INSERT na fila e SELECT no ledger', pg_temp.ig79_case_36()),
  (7946, 'IG-3.7 wrappers de cron: sem internal_api_key, sem project_url ou chave vazia voltam sem POST; com os dois, POST na EF certa com x-internal-key do Vault', pg_temp.ig79_case_37()),
  (7947, 'IG-3.8 desfecho em texto livre ou com 65 caracteres recusado com 23514 em finalize/complete/record e no INSERT direto, sem gravar; os codigos do harness/plano/nucleo casam o formato', pg_temp.ig79_case_38());

insert into t_res values
  (7960, 'IG-4.1 CHECK de identidade: whatsapp sem cliente, instagram sem contato e whatsapp com contato 23514; canal invalido 23514; constraints validadas, customer_id opcional, channel default whatsapp', pg_temp.ig79_case_41()),
  (7961, 'IG-4.2 get_or_create_whatsapp_conversation devolve a conversa WhatsApp X e nao a IG Y mais recente do cliente ligado (Y intacta); sem X cria uma whatsapp nova e nao devolve Y2', pg_temp.ig79_case_42()),
  (7962, 'IG-4.3 reconcile de aceitacao (corpo real) registra o aceite na conversa WhatsApp mesmo com o event_id na IG do mesmo cliente; sem conversa WhatsApp cria uma e a IG fica intacta', pg_temp.ig79_case_43()),
  (7963, 'IG-4.4 guarda: conversa IG com contato de outra unidade (service_role e postgres), mover de unidade, cliente de outra org e trocar canal nos dois sentidos dao 23514', pg_temp.ig79_case_44()),
  (7964, 'IG-4.5 get_or_create_instagram_conversation: mesmo id 2x, unidade/cliente do contato, contact_name coalesce(name, @username) renovado; anonimizado 42501, inexistente P0002, nulo 22023, sem EXECUTE para authenticated/anon', pg_temp.ig79_case_45()),
  (7965, 'IG-4.6 link_instagram_contact_customer: cliente de outra org/apagado/inexistente e contato inexistente/anonimizado com o mesmo 42501; link grava contato e conversa; religar troca os dois', pg_temp.ig79_case_46()),
  (7966, 'IG-4.7 A x B: membro de A nao le a conversa IG de B, B e admin leem; colunas novas sem INSERT/UPDATE para authenticated/anon; EXECUTE so service_role, guard e reconcile inner para ninguem', pg_temp.ig79_case_47()),
  (7967, 'IG-4.8 anonimizar o cliente (anonymize_customer do platform_admin e soft delete direto do owner) limpa o contact_name da conversa IG do contato; a de outro contato fica; funcao DEFINER sem EXECUTE para ninguem', pg_temp.ig79_case_48());

insert into t_res values
  (7980, 'IG-5.1 service_role grava reserva source=instagram e o trigger real enfileira 1 confirmation pendente na unidade (D6: confirmacao pelo WhatsApp); whatsapp nao enfileira; web enfileira; origem fora da lista 23514', pg_temp.ig79_case_51()),
  (7981, 'IG-5.2 catalogo: um unico CHECK de source em reservations, reservations_source_check com web/whatsapp/instagram e validado; coluna not null default web; trigger e corpo da 028 intactos (D6)', pg_temp.ig79_case_52());

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
    v_mut := replace(pg_temp.ig79_lf(v_def), 'if v_uid is null or not app_private.is_platform_admin(v_uid) then', 'if false then');
    if v_mut = pg_temp.ig79_lf(v_def) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
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
    v_mut := replace(pg_temp.ig79_lf(v_def), 'set revoked_at = now(), revoked_by = v_uid', 'set revoked_at = now(), revoked_by = p_unit_id');
    if v_mut = pg_temp.ig79_lf(v_def) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
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
    v_mut := replace(pg_temp.ig79_lf(v_def),
      'or not (app_private.is_unit_member(v_uid, p_unit_id) or app_private.is_platform_admin(v_uid))', '');
    if v_mut = pg_temp.ig79_lf(v_def) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
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
    v_mut := replace(pg_temp.ig79_lf(v_guard), 'if new.organization_id is distinct from v_unit_org then', 'if false then');
    if v_mut = pg_temp.ig79_lf(v_guard) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_16();
  exception
    when sqlstate 'P0R79' then s1 := sqlerrm;
    when others then s1 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    v_mut := replace(pg_temp.ig79_lf(v_guard), 'if tg_op = ''UPDATE''', 'if false');
    if v_mut = pg_temp.ig79_lf(v_guard) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_16();
  exception
    when sqlstate 'P0R79' then s2 := sqlerrm;
    when others then s2 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    v_mut := replace(pg_temp.ig79_lf(v_touch), 'if new.unit_id is distinct from old.unit_id', 'if false and new.unit_id is distinct from old.unit_id');
    if v_mut = pg_temp.ig79_lf(v_touch) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
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
-- authenticated; (e) INSERT/UPDATE em instagram_accounts para service_role.
do $$
declare
  v_def text; v_mut text; v_pol0 text; v_pol text; s1 text; s2 text; s3 text; s4 text; s5 text; d text;
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
    v_mut := replace(pg_temp.ig79_lf(v_def),
      'or not (app_private.is_unit_member(v_uid, p_unit_id) or app_private.is_platform_admin(v_uid))', '');
    if v_mut = pg_temp.ig79_lf(v_def) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
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
  begin
    grant insert, update on public.instagram_accounts to service_role;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_21();
  exception
    when sqlstate 'P0R79' then s5 := sqlerrm;
    when others then s5 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  d := pg_temp.ig79_case_21();
  raise notice 'C-IG-2.1 service_role escreve accounts: %', s5;
  raise notice 'C-IG-2.1 select aberto: %', s1;
  raise notice 'C-IG-2.1 status sem guarda: %', s2;
  raise notice 'C-IG-2.1 select accounts: %', s3;
  raise notice 'C-IG-2.1 select ledger: %', s4;
  select string_agg(polname || ':' || pg_get_expr(polqual, polrelid), ';' order by polname)
    into v_pol from pg_policy where polrelid = 'public.instagram_contacts'::regclass;
  insert into t_res values (7930, 'C-IG-2.1 policy de contatos aberta, status sem guarda, SELECT em accounts e no ledger para authenticated, INSERT/UPDATE em accounts para service_role: IG-2.1 reprova nos cinco; restaurado passa',
    case when s1 like 'FALHOU%opA_le_B=1%'
          and s2 like 'FALHOU%status_A->B=1:loja_b%'
          and s3 like 'FALHOU%select_accounts=0%authenticated_accounts%'
          and s4 like 'FALHOU%select_ledger=0%authenticated_ledger%'
          and s5 like 'FALHOU%service_update_accounts=2%service_escreve:public.instagram_accounts%'
          and d = 'PASSOU' and v_pol = v_pol0
          and not has_table_privilege('service_role', 'public.instagram_accounts', 'INSERT,UPDATE')
          and pg_get_functiondef('public.get_instagram_account_status(uuid)'::regprocedure) = v_def then 'PASSOU'
         else 'FALHOU select_aberto=' || s1 || ' status_sem_guarda=' || s2 || ' select_accounts=' || s3
              || ' select_ledger=' || s4 || ' service_escreve=' || s5 || ' restaurado=' || d end);
end $$;

-- C-IG-2.2: (a) store sem a recusa de conta em uso; (b) store sem desconectar
-- a outra conta da unidade; (c) store sem reaproveitar a linha da mesma conta.
do $$
declare
  v_def text; v_mut text; s1 text; s2 text; s3 text; d text;
begin
  v_def := pg_get_functiondef('public.store_instagram_account_connection(uuid,text,text,text,text,timestamptz,uuid)'::regprocedure);
  begin
    v_mut := replace(pg_temp.ig79_lf(v_def), 'raise exception ''instagram_account_in_use'' using errcode = ''P0001'';', 'null;');
    if v_mut = pg_temp.ig79_lf(v_def) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_22();
  exception
    when sqlstate 'P0R79' then s1 := sqlerrm;
    when others then s1 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    v_mut := replace(pg_temp.ig79_lf(v_def), 'perform public.disconnect_instagram_account(v_other.id, p_actor);', 'null;');
    if v_mut = pg_temp.ig79_lf(v_def) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_22();
  exception
    when sqlstate 'P0R79' then s2 := sqlerrm;
    when others then s2 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    v_mut := replace(pg_temp.ig79_lf(v_def), 'where a.unit_id = p_unit_id and a.ig_user_id = p_ig_user_id', 'where false');
    if v_mut = pg_temp.ig79_lf(v_def) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
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
    v_mut := replace(pg_temp.ig79_lf(v_def),
      'perform vault.update_secret(v_secret_id, ''revoked-'' || gen_random_uuid()::text || gen_random_uuid()::text);', 'null;');
    if v_mut = pg_temp.ig79_lf(v_def) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_23();
  exception
    when sqlstate 'P0R79' then s2 := sqlerrm;
    when others then s2 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    v_mut := replace(pg_temp.ig79_lf(v_def), 'set token_secret_id = null,', 'set token_secret_id = a.token_secret_id,');
    if v_mut = pg_temp.ig79_lf(v_def) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
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
    v_mut := replace(pg_temp.ig79_lf(v_def), 'if v_cust_org is distinct from new.organization_id then', 'if false then');
    if v_mut = pg_temp.ig79_lf(v_def) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_24();
  exception
    when sqlstate 'P0R79' then s1 := sqlerrm;
    when others then s1 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    v_mut := replace(pg_temp.ig79_lf(v_def),
      'if new.unit_id is distinct from v_acc_unit or new.organization_id is distinct from v_acc_org then', 'if false then');
    if v_mut = pg_temp.ig79_lf(v_def) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
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
-- cláusula de cliente; (c) INSERT no ledger para service_role.
do $$
declare
  v_def text; v_mut text; s1 text; s2 text; s3 text; d text;
begin
  v_def := pg_get_functiondef('public.record_instagram_contact_reservation(uuid,uuid)'::regprocedure);
  begin
    v_mut := replace(pg_temp.ig79_lf(v_def), 'or v_r_unit is distinct from v_c_unit', '');
    if v_mut = pg_temp.ig79_lf(v_def) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_25();
  exception
    when sqlstate 'P0R79' then s1 := sqlerrm;
    when others then s1 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    v_mut := replace(pg_temp.ig79_lf(v_def), 'or v_c_cust is null or v_r_cust is distinct from v_c_cust', '');
    if v_mut = pg_temp.ig79_lf(v_def) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_25();
  exception
    when sqlstate 'P0R79' then s2 := sqlerrm;
    when others then s2 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    grant insert on public.instagram_contact_reservations to service_role;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_25();
  exception
    when sqlstate 'P0R79' then s3 := sqlerrm;
    when others then s3 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  d := pg_temp.ig79_case_25();
  raise notice 'C-IG-2.5 sem unidade: %', s1;
  raise notice 'C-IG-2.5 sem cliente: %', s2;
  raise notice 'C-IG-2.5 service_role insere no ledger: %', s3;
  insert into t_res values (7934, 'C-IG-2.5 guarda do ledger sem a clausula de unidade e sem a de cliente, e INSERT no ledger para service_role: IG-2.5 reprova nos tres; restaurada passa',
    case when s1 like 'FALHOU outra_unidade=ok%'
          and s2 like 'FALHOU%outro_cliente=ok%'
          and s3 like 'FALHOU%service_insere_ledger=1%'
          and d = 'PASSOU'
          and not has_table_privilege('service_role', 'public.instagram_contact_reservations', 'INSERT')
          and pg_get_functiondef('public.record_instagram_contact_reservation(uuid,uuid)'::regprocedure) = v_def then 'PASSOU'
         else 'FALHOU sem_unidade=' || s1 || ' sem_cliente=' || s2 || ' service_insere=' || s3 || ' restaurado=' || d end);
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
    v_mut := replace(pg_temp.ig79_lf(v_def), 'where c.customer_id = new.id', 'where true');
    if v_mut = pg_temp.ig79_lf(v_def) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
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

-- C-IG-2.7: (a) sem o trigger de auditoria; (b) disconnect sem gravar o ator;
-- (c) store sem limpar disconnected_by ao reconectar.
do $$
declare
  v_disc text; v_store text; v_mut text; s1 text; s2 text; s3 text; d text; v_trg int;
begin
  v_disc := pg_get_functiondef('public.disconnect_instagram_account(uuid,uuid)'::regprocedure);
  v_store := pg_get_functiondef('public.store_instagram_account_connection(uuid,text,text,text,text,timestamptz,uuid)'::regprocedure);
  begin
    drop trigger instagram_accounts_audit on public.instagram_accounts;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_27();
  exception
    when sqlstate 'P0R79' then s1 := sqlerrm;
    when others then s1 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    v_mut := replace(pg_temp.ig79_lf(v_disc), 'then p_actor else a.disconnected_by end', 'then null else a.disconnected_by end');
    if v_mut = pg_temp.ig79_lf(v_disc) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_27();
  exception
    when sqlstate 'P0R79' then s2 := sqlerrm;
    when others then s2 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    v_mut := replace(pg_temp.ig79_lf(v_store), 'disconnected_by = null,', 'disconnected_by = a.disconnected_by,');
    if v_mut = pg_temp.ig79_lf(v_store) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_27();
  exception
    when sqlstate 'P0R79' then s3 := sqlerrm;
    when others then s3 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  d := pg_temp.ig79_case_27();
  raise notice 'C-IG-2.7 sem trigger de auditoria: %', s1;
  raise notice 'C-IG-2.7 disconnect sem ator: %', s2;
  raise notice 'C-IG-2.7 store sem limpar: %', s3;
  select count(*) into v_trg from pg_trigger
   where tgrelid = 'public.instagram_accounts'::regclass and tgname = 'instagram_accounts_audit';
  insert into t_res values (7936, 'C-IG-2.7 sem trigger de auditoria, disconnect sem gravar o ator e store sem limpar disconnected_by: IG-2.7 reprova nos tres; restaurado passa',
    case when s1 like 'FALHOU%audit_conectar=0/insert=0%'
          and s2 like 'FALHOU%ultima=UPDATE|disconnected|<null>%coluna=disconnected|<null>%'
          and s3 like 'FALHOU%depois=connected|a0d79000-%'
          and d = 'PASSOU' and v_trg = 1
          and pg_get_functiondef('public.disconnect_instagram_account(uuid,uuid)'::regprocedure) = v_disc
          and pg_get_functiondef('public.store_instagram_account_connection(uuid,text,text,text,text,timestamptz,uuid)'::regprocedure) = v_store then 'PASSOU'
         else 'FALHOU sem_trigger=' || s1 || ' sem_ator=' || s2 || ' sem_limpar=' || s3 || ' restaurado=' || d || ' trigger=' || v_trg end);
end $$;

-- C-IG-2.8: tira a amarração por nome (`and s.name = v_name`) de cada uma das
-- quatro funções que tocam o segredo, uma por vez.
do $$
declare
  fns text[] := array[
    'public.get_instagram_account_token(uuid)',
    'public.record_instagram_token_refresh(uuid,text,timestamptz)',
    'public.store_instagram_account_connection(uuid,text,text,text,text,timestamptz,uuid)',
    'public.disconnect_instagram_account(uuid,uuid)'];
  fn text; v_def text; v_mut text; s text; res text[] := '{}'; ok boolean := true; d text; intactas boolean := true;
  defs text[] := '{}';
begin
  foreach fn in array fns loop
    v_def := pg_get_functiondef(fn::regprocedure);
    defs := defs || v_def;
    begin
      v_mut := replace(pg_temp.ig79_lf(v_def), 'and s.name = v_name;', ';');
      if v_mut = pg_temp.ig79_lf(v_def) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
      execute v_mut;
      raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_28();
    exception
      when sqlstate 'P0R79' then s := sqlerrm;
      when others then s := 'ERRO ' || sqlstate || ':' || sqlerrm;
    end;
    raise notice 'C-IG-2.8 % sem nome: %', fn, s;
    res := res || s;
  end loop;
  d := pg_temp.ig79_case_28();
  for i in 1 .. array_length(fns, 1) loop
    if pg_get_functiondef(fns[i]::regprocedure) <> defs[i] then intactas := false; end if;
  end loop;
  insert into t_res values (7937, 'C-IG-2.8 getter, refresh, store e disconnect sem a amarracao por nome: IG-2.8 reprova em cada um (getter decifra o alheio, disconnect sobrescreve o alheio); restaurado passa',
    case when res[1] like 'FALHOU getter=ig79-foreign-value-0001%'
          and res[2] like 'FALHOU%' and res[2] not like 'FALHOU%refresh=ERR 42501:instagram_account_secret_mismatch%'
          and res[3] like 'FALHOU%' and res[3] not like 'FALHOU%store=ERR 42501:instagram_account_secret_mismatch%'
          and res[4] like 'FALHOU%disconnect=ok%alheio=revoked-%'
          and d = 'PASSOU' and intactas then 'PASSOU'
         else 'FALHOU getter=' || res[1] || ' refresh=' || res[2] || ' store=' || res[3] || ' disconnect=' || res[4]
              || ' restaurado=' || d || ' intactas=' || intactas end);
end $$;

-- C-IG-2.9: função de anonimização recriada como SECURITY INVOKER.
do $$
declare
  v_def text; v_mut text; s1 text; d text;
begin
  v_def := pg_get_functiondef('public.instagram_contacts_anonymize_on_customer()'::regprocedure);
  begin
    v_mut := replace(pg_temp.ig79_lf(v_def), 'SECURITY DEFINER', 'SECURITY INVOKER');
    if v_mut = pg_temp.ig79_lf(v_def) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    if (select prosecdef from pg_proc where oid = 'public.instagram_contacts_anonymize_on_customer()'::regprocedure) then
      raise exception using errcode = 'P0R79', message = 'SABOTAGEM NAO APLICADA';
    end if;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_29();
  exception
    when sqlstate 'P0R79' then s1 := sqlerrm;
    when others then s1 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  d := pg_temp.ig79_case_29();
  raise notice 'C-IG-2.9 invoker: %', s1;
  insert into t_res values (7938, 'C-IG-2.9 trigger de anonimizacao como SECURITY INVOKER: o soft delete direto do owner estoura 42501 em instagram_contacts e IG-2.9 reprova; restaurado passa',
    case when s1 like 'FALHOU soft_delete=ERR 42501:permission denied for table instagram_contacts%'
          and d = 'PASSOU'
          and (select prosecdef from pg_proc where oid = 'public.instagram_contacts_anonymize_on_customer()'::regprocedure)
          and pg_get_functiondef('public.instagram_contacts_anonymize_on_customer()'::regprocedure) = v_def then 'PASSOU'
         else 'FALHOU invoker=' || s1 || ' restaurado=' || d end);
end $$;

-- C-IG-2.10: (a) store sem normalizar ig_user_id; (b) store sem normalizar o
-- token; (c) sem o CHECK numérico; (d) upsert aceitando conta desconectada;
-- (e) set_status sem limpar last_error_code.
do $$
declare
  v_store text; v_up text; v_st text; v_mut text; s1 text; s2 text; s3 text; s4 text; s5 text; d text; v_chk int;
begin
  v_store := pg_get_functiondef('public.store_instagram_account_connection(uuid,text,text,text,text,timestamptz,uuid)'::regprocedure);
  v_up := pg_get_functiondef('public.upsert_instagram_contact(uuid,text,text,text)'::regprocedure);
  v_st := pg_get_functiondef('public.set_instagram_account_status(uuid,text,text)'::regprocedure);
  begin
    v_mut := replace(pg_temp.ig79_lf(v_store), 'p_ig_user_id := btrim(p_ig_user_id);', 'null;');
    if v_mut = pg_temp.ig79_lf(v_store) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_30();
  exception
    when sqlstate 'P0R79' then s1 := sqlerrm;
    when others then s1 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    v_mut := replace(pg_temp.ig79_lf(v_store), 'p_token := btrim(p_token);', 'null;');
    if v_mut = pg_temp.ig79_lf(v_store) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_30();
  exception
    when sqlstate 'P0R79' then s2 := sqlerrm;
    when others then s2 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    alter table public.instagram_accounts drop constraint instagram_accounts_ig_user_id_chk;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_30();
  exception
    when sqlstate 'P0R79' then s3 := sqlerrm;
    when others then s3 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    v_mut := replace(pg_temp.ig79_lf(v_up), 'if v_status = ''disconnected'' then', 'if false then');
    if v_mut = pg_temp.ig79_lf(v_up) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_30();
  exception
    when sqlstate 'P0R79' then s4 := sqlerrm;
    when others then s4 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    v_mut := replace(pg_temp.ig79_lf(v_st), 'case when p_status = ''connected'' then null else p_error_code end', 'p_error_code');
    if v_mut = pg_temp.ig79_lf(v_st) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_30();
  exception
    when sqlstate 'P0R79' then s5 := sqlerrm;
    when others then s5 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  d := pg_temp.ig79_case_30();
  raise notice 'C-IG-2.10 sem normalizar ig_user_id: %', s1;
  raise notice 'C-IG-2.10 sem normalizar token: %', s2;
  raise notice 'C-IG-2.10 sem CHECK: %', s3;
  raise notice 'C-IG-2.10 upsert em desconectada: %', s4;
  raise notice 'C-IG-2.10 sem limpar erro: %', s5;
  select count(*) into v_chk from pg_constraint
   where conrelid = 'public.instagram_accounts'::regclass and conname = 'instagram_accounts_ig_user_id_chk';
  insert into t_res values (7939, 'C-IG-2.10 sem normalizar ig_user_id e token, sem o CHECK numerico, upsert em conta desconectada e connected sem limpar o erro: IG-2.10 reprova nos cinco; restaurado passa',
    case when s1 like 'FALHOU a1=ERR 22023:invalid_instagram_account_argument%'
          and s2 like 'FALHOU%token1=  tok-30-A-000001  %'
          and s3 like 'FALHOU%check=1%'
          and s4 like 'FALHOU%contato_novo_desconectada=________-%'
          and s5 like 'FALHOU%last_error=ignorado%'
          and d = 'PASSOU' and v_chk = 1
          and pg_get_functiondef('public.store_instagram_account_connection(uuid,text,text,text,text,timestamptz,uuid)'::regprocedure) = v_store
          and pg_get_functiondef('public.upsert_instagram_contact(uuid,text,text,text)'::regprocedure) = v_up
          and pg_get_functiondef('public.set_instagram_account_status(uuid,text,text)'::regprocedure) = v_st then 'PASSOU'
         else 'FALHOU sem_norm_ig=' || s1 || ' sem_norm_token=' || s2 || ' sem_check=' || s3
              || ' upsert_desconectada=' || s4 || ' sem_limpar=' || s5 || ' restaurado=' || d || ' check=' || v_chk end);
end $$;

-- ─── Controles positivos da Task 1.3 ─────────────────────────────────────────

-- C-IG-3.1: (a) finalize sem a perna `claim_id = p_claim_id` (o perdedor do
-- takeover escreve por cima); (b) claim sem o lease (`processing` sempre
-- reivindicável); (c) finalize aceitando `processing` (fix 1: a linha fica
-- `processing` sem lease, inalcançável).
do $$
declare
  v_fin text; v_cl text; v_mut text; s1 text; s2 text; s3 text; d text;
begin
  v_fin := pg_get_functiondef('public.finalize_instagram_inbound_event(uuid,uuid,text,text,text,integer)'::regprocedure);
  v_cl := pg_get_functiondef('public.claim_instagram_inbound_event(uuid)'::regprocedure);
  begin
    v_mut := replace(pg_temp.ig79_lf(v_fin), 'and e.claim_id = p_claim_id', '');
    if v_mut = pg_temp.ig79_lf(v_fin) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_31();
  exception
    when sqlstate 'P0R79' then s1 := sqlerrm;
    when others then s1 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    v_mut := replace(pg_temp.ig79_lf(v_cl), '(e.status = ''processing'' and e.claimed_until < now())', 'e.status = ''processing''');
    if v_mut = pg_temp.ig79_lf(v_cl) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_31();
  exception
    when sqlstate 'P0R79' then s2 := sqlerrm;
    when others then s2 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    v_mut := replace(pg_temp.ig79_lf(v_fin), 'and p_status in (''received'', ''done'', ''dead'')', '');
    if v_mut = pg_temp.ig79_lf(v_fin) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_31();
  exception
    when sqlstate 'P0R79' then s3 := sqlerrm;
    when others then s3 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  d := pg_temp.ig79_case_31();
  raise notice 'C-IG-3.1 finalize sem claim_id: %', s1;
  raise notice 'C-IG-3.1 claim sem lease: %', s2;
  raise notice 'C-IG-3.1 finalize aceita processing: %', s3;
  insert into t_res values (7950, 'C-IG-3.1 finalize sem o filtro de claim_id, claim sem o lease e finalize aceitando processing: IG-3.1 reprova nos tres; restaurado passa',
    case when s1 like 'FALHOU%finalize_aleatorio=1%' and s2 like 'FALHOU%claim2_lease_vivo=1:%'
          and s3 like 'FALHOU%finalize_processing=1%estado_apos_processing=processing|<null>|false%'
          and d = 'PASSOU'
          and pg_get_functiondef('public.finalize_instagram_inbound_event(uuid,uuid,text,text,text,integer)'::regprocedure) = v_fin
          and pg_get_functiondef('public.claim_instagram_inbound_event(uuid)'::regprocedure) = v_cl then 'PASSOU'
         else 'FALHOU sem_claim_id=' || s1 || ' sem_lease=' || s2 || ' aceita_processing=' || s3 || ' restaurado=' || d end);
end $$;

-- C-IG-3.2: (a) claim da mensagem sem o lease na retomada; (b) complete sem o
-- filtro de claim_id; (c) registro de desfecho que sobrescreve.
do $$
declare
  v_cl text; v_co text; v_rec text; v_mut text; s1 text; s2 text; s3 text; d text;
begin
  v_cl := pg_get_functiondef('public.claim_instagram_message(uuid,text)'::regprocedure);
  v_co := pg_get_functiondef('public.complete_instagram_message(uuid,text,uuid,text,text,jsonb)'::regprocedure);
  v_rec := pg_get_functiondef('public.record_instagram_message_outcome(uuid,text,text,jsonb)'::regprocedure);
  begin
    v_mut := replace(pg_temp.ig79_lf(v_cl), 'and m.claimed_until < now()', '');
    if v_mut = pg_temp.ig79_lf(v_cl) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_32();
  exception
    when sqlstate 'P0R79' then s1 := sqlerrm;
    when others then s1 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    v_mut := replace(pg_temp.ig79_lf(v_co), 'and m.claim_id = p_claim_id', '');
    if v_mut = pg_temp.ig79_lf(v_co) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_32();
  exception
    when sqlstate 'P0R79' then s2 := sqlerrm;
    when others then s2 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    v_mut := replace(pg_temp.ig79_lf(v_rec), 'on conflict (instagram_account_id, mid) do nothing',
                     'on conflict (instagram_account_id, mid) do update set outcome = excluded.outcome');
    if v_mut = pg_temp.ig79_lf(v_rec) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_32();
  exception
    when sqlstate 'P0R79' then s3 := sqlerrm;
    when others then s3 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  d := pg_temp.ig79_case_32();
  raise notice 'C-IG-3.2 claim sem lease: %', s1;
  raise notice 'C-IG-3.2 complete sem claim_id: %', s2;
  raise notice 'C-IG-3.2 registro sobrescreve: %', s3;
  insert into t_res values (7951, 'C-IG-3.2 claim da mensagem sem lease, complete sem filtro de claim_id e registro que sobrescreve: IG-3.2 reprova nos tres; restaurado passa',
    case when s1 like 'FALHOU claim1=________-%claim2=________-%'
          and s2 like 'FALHOU%complete_antigo=true%'
          and s3 like 'FALHOU%estado_eco=done|echo_unknown|%'
          and d = 'PASSOU'
          and pg_get_functiondef('public.claim_instagram_message(uuid,text)'::regprocedure) = v_cl
          and pg_get_functiondef('public.complete_instagram_message(uuid,text,uuid,text,text,jsonb)'::regprocedure) = v_co
          and pg_get_functiondef('public.record_instagram_message_outcome(uuid,text,text,jsonb)'::regprocedure) = v_rec then 'PASSOU'
         else 'FALHOU claim_sem_lease=' || s1 || ' complete_sem_claim=' || s2 || ' sobrescreve=' || s3 || ' restaurado=' || d end);
end $$;

-- C-IG-3.3: (a) guard sem a coerência de unidade; (b) guard sem a
-- imutabilidade; (c) sem o unique (conta, sha256); (d) sem o CHECK que amarra
-- o hash ao corpo (fix 2).
do $$
declare
  v_guard text; v_mut text; s1 text; s2 text; s3 text; s4 text; d text; v_uq int;
begin
  v_guard := pg_get_functiondef('public.instagram_queue_tenant_guard()'::regprocedure);
  begin
    v_mut := replace(pg_temp.ig79_lf(v_guard), 'if new.unit_id is distinct from v_acc_unit then', 'if false then');
    if v_mut = pg_temp.ig79_lf(v_guard) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_33();
  exception
    when sqlstate 'P0R79' then s1 := sqlerrm;
    when others then s1 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    v_mut := replace(pg_temp.ig79_lf(v_guard), 'if tg_op = ''UPDATE''', 'if false');
    if v_mut = pg_temp.ig79_lf(v_guard) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_33();
  exception
    when sqlstate 'P0R79' then s2 := sqlerrm;
    when others then s2 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    alter table public.instagram_inbound_events drop constraint instagram_inbound_events_account_body_key;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_33();
  exception
    when sqlstate 'P0R79' then s3 := sqlerrm;
    when others then s3 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    alter table public.instagram_inbound_events drop constraint instagram_inbound_events_body_sha256_raw_chk;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_33();
  exception
    when sqlstate 'P0R79' then s4 := sqlerrm;
    when others then s4 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  d := pg_temp.ig79_case_33();
  raise notice 'C-IG-3.3 sem coerencia: %', s1;
  raise notice 'C-IG-3.3 sem imutabilidade: %', s2;
  raise notice 'C-IG-3.3 sem unique: %', s3;
  raise notice 'C-IG-3.3 sem hash amarrado: %', s4;
  select count(*) into v_uq from pg_constraint
   where conrelid = 'public.instagram_inbound_events'::regclass
     and conname in ('instagram_inbound_events_account_body_key', 'instagram_inbound_events_body_sha256_raw_chk');
  insert into t_res values (7952, 'C-IG-3.3 guard sem coerencia de unidade, guard sem imutabilidade, sem o unique (conta, sha256) e sem o CHECK do hash do corpo: IG-3.3 reprova nos quatro; restaurado passa',
    case when s1 like 'FALHOU%service_unidade_alheia=________-%'
          and s2 like 'FALHOU%mover_conta=1%'
          and s3 like 'FALHOU%duplicado=________-%'
          and s4 like 'FALHOU%hash_alheio=1%'
          and d = 'PASSOU' and v_uq = 2
          and pg_get_functiondef('public.instagram_queue_tenant_guard()'::regprocedure) = v_guard then 'PASSOU'
         else 'FALHOU sem_coerencia=' || s1 || ' sem_imutabilidade=' || s2 || ' sem_unique=' || s3 || ' sem_hash=' || s4
              || ' restaurado=' || d || ' unique=' || v_uq end);
end $$;

-- C-IG-3.4: (a) guarda aberta a membro da unidade; (b) sem o filtro de
-- unidade; (c) diagnóstico que vaza o corpo cru.
do $$
declare
  v_def text; v_mut text; s1 text; s2 text; s3 text; d text;
begin
  v_def := pg_get_functiondef('public.get_instagram_diagnostics(uuid)'::regprocedure);
  begin
    v_mut := replace(pg_temp.ig79_lf(v_def), 'if v_uid is null or not app_private.is_platform_admin(v_uid) then',
      'if v_uid is null or not (app_private.is_platform_admin(v_uid) or app_private.is_unit_member(v_uid, p_unit_id)) then');
    if v_mut = pg_temp.ig79_lf(v_def) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_34();
  exception
    when sqlstate 'P0R79' then s1 := sqlerrm;
    when others then s1 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    v_mut := replace(pg_temp.ig79_lf(v_def), 'e.unit_id = p_unit_id', 'true');
    if v_mut = pg_temp.ig79_lf(v_def) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_34();
  exception
    when sqlstate 'P0R79' then s2 := sqlerrm;
    when others then s2 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    v_mut := replace(pg_temp.ig79_lf(v_def), '''last_event_at'',',
      '''amostra'', (select string_agg(encode(x.raw_body, ''escape''), '','') from public.instagram_inbound_events x where x.unit_id = p_unit_id), ''last_event_at'',');
    if v_mut = pg_temp.ig79_lf(v_def) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_34();
  exception
    when sqlstate 'P0R79' then s3 := sqlerrm;
    when others then s3 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  d := pg_temp.ig79_case_34();
  raise notice 'C-IG-3.4 aberto a membro: %', s1;
  raise notice 'C-IG-3.4 sem filtro de unidade: %', s2;
  raise notice 'C-IG-3.4 vaza corpo: %', s3;
  insert into t_res values (7953, 'C-IG-3.4 diagnostico aberto a membro, sem filtro de unidade e vazando o corpo: IG-3.4 reprova nos tres; restaurado passa',
    case when s1 like 'FALHOU owner={%'
          and s2 like 'FALHOU%pa_B={%'
          and s3 like 'FALHOU%SEGREDO-DM-79%'
          and d = 'PASSOU'
          and pg_get_functiondef('public.get_instagram_diagnostics(uuid)'::regprocedure) = v_def then 'PASSOU'
         else 'FALHOU aberto=' || s1 || ' sem_filtro=' || s2 || ' vaza=' || s3 || ' restaurado=' || d end);
end $$;

-- C-IG-3.5: (a) done com 5 dias; (b) perna dead sem o status (apaga linha
-- viva); (c) ledger com 28 dias; (d) ledger sem a perna que poupa a linha
-- em voo (fix 4).
do $$
declare
  v_ev text; v_led text; v_mut text; s1 text; s2 text; s3 text; s4 text; d text;
begin
  v_ev := pg_get_functiondef('public.purge_instagram_inbound_events()'::regprocedure);
  v_led := pg_get_functiondef('public.purge_instagram_processed_messages()'::regprocedure);
  begin
    v_mut := replace(pg_temp.ig79_lf(v_ev), 'interval ''7 days''', 'interval ''5 days''');
    if v_mut = pg_temp.ig79_lf(v_ev) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_35();
  exception
    when sqlstate 'P0R79' then s1 := sqlerrm;
    when others then s1 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    v_mut := replace(pg_temp.ig79_lf(v_ev), '(status = ''dead'' and received_at < now() - interval ''30 days'')',
                     '(received_at < now() - interval ''30 days'')');
    if v_mut = pg_temp.ig79_lf(v_ev) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_35();
  exception
    when sqlstate 'P0R79' then s2 := sqlerrm;
    when others then s2 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    v_mut := replace(pg_temp.ig79_lf(v_led), 'interval ''30 days''', 'interval ''28 days''');
    if v_mut = pg_temp.ig79_lf(v_led) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_35();
  exception
    when sqlstate 'P0R79' then s3 := sqlerrm;
    when others then s3 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    v_mut := replace(pg_temp.ig79_lf(v_led), 'and (status = ''done'' or claimed_until < now())', '');
    if v_mut = pg_temp.ig79_lf(v_led) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_35();
  exception
    when sqlstate 'P0R79' then s4 := sqlerrm;
    when others then s4 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  d := pg_temp.ig79_case_35();
  raise notice 'C-IG-3.5 done 5 dias: %', s1;
  raise notice 'C-IG-3.5 dead sem status: %', s2;
  raise notice 'C-IG-3.5 ledger 28 dias: %', s3;
  raise notice 'C-IG-3.5 ledger apaga em voo: %', s4;
  insert into t_res values (7954, 'C-IG-3.5 purga com done em 5 dias, perna dead sem o status, ledger em 28 dias e ledger apagando linha em voo: IG-3.5 reprova nos quatro; restaurado passa',
    case when s1 like 'FALHOU purga_fila=3%restam_fila=x29,r40,p40%'
          and s2 like 'FALHOU purga_fila=4%restam_fila=d6,x29 %'
          and s3 like 'FALHOU%purga_ledger=3%restam_ledger=mid-35-v31'
          and s4 like 'FALHOU%purga_ledger=3%restam_ledger=mid-35-l29'
          and d = 'PASSOU'
          and pg_get_functiondef('public.purge_instagram_inbound_events()'::regprocedure) = v_ev
          and pg_get_functiondef('public.purge_instagram_processed_messages()'::regprocedure) = v_led then 'PASSOU'
         else 'FALHOU done_5d=' || s1 || ' dead_sem_status=' || s2 || ' ledger_28d=' || s3 || ' ledger_em_voo=' || s4 || ' restaurado=' || d end);
end $$;

-- C-IG-3.6: (a) UPDATE na fila para service_role; (b) EXECUTE do diagnóstico
-- para anon; (c) EXECUTE do claim da mensagem para authenticated; (d) ledger
-- sem FORCE RLS; (e) EXECUTE do wrapper para service_role; (f) INSERT de
-- TABELA na fila para service_role (fix 3), com o catálogo conferido depois.
do $$
declare
  s1 text; s2 text; s3 text; s4 text; s5 text; s6 text; d text; v_acl text;
begin
  begin
    grant update on public.instagram_inbound_events to service_role;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_36();
  exception
    when sqlstate 'P0R79' then s1 := sqlerrm;
    when others then s1 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    grant execute on function public.get_instagram_diagnostics(uuid) to anon;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_36();
  exception
    when sqlstate 'P0R79' then s2 := sqlerrm;
    when others then s2 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    grant execute on function public.claim_instagram_message(uuid, text) to authenticated;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_36();
  exception
    when sqlstate 'P0R79' then s3 := sqlerrm;
    when others then s3 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    alter table public.instagram_processed_messages no force row level security;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_36();
  exception
    when sqlstate 'P0R79' then s4 := sqlerrm;
    when others then s4 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    grant execute on function public.trigger_instagram_inbound_sweep() to service_role;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_36();
  exception
    when sqlstate 'P0R79' then s5 := sqlerrm;
    when others then s5 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    grant insert on public.instagram_inbound_events to service_role;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_36();
  exception
    when sqlstate 'P0R79' then s6 := sqlerrm;
    when others then s6 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  d := pg_temp.ig79_case_36();
  raise notice 'C-IG-3.6 update fila service_role: %', s1;
  raise notice 'C-IG-3.6 diagnostico anon: %', s2;
  raise notice 'C-IG-3.6 claim authenticated: %', s3;
  raise notice 'C-IG-3.6 ledger sem force: %', s4;
  raise notice 'C-IG-3.6 wrapper service_role: %', s5;
  raise notice 'C-IG-3.6 insert de tabela: %', s6;
  -- INSERT de tabela vive em relacl (o de coluna, em pg_attribute.attacl).
  select string_agg(x.privilege_type, ',') into v_acl
    from pg_class c, aclexplode(c.relacl) x
   where c.oid = 'public.instagram_inbound_events'::regclass
     and x.grantee = 'service_role'::regrole and x.privilege_type = 'INSERT';
  insert into t_res values (7955, 'C-IG-3.6 UPDATE na fila para service_role, diagnostico para anon, claim para authenticated, ledger sem FORCE RLS, wrapper para service_role e INSERT de tabela na fila: IG-3.6 reprova nos seis; restaurado passa',
    case when s1 like 'FALHOU%service_escreve:public.instagram_inbound_events%'
          and s2 like 'FALHOU%anon_exec:public.get_instagram_diagnostics(uuid)%'
          and s3 like 'FALHOU%authenticated_exec:public.claim_instagram_message(uuid,text)%'
          and s4 like 'FALHOU%sem_force_rls:public.instagram_processed_messages%'
          and s5 like 'FALHOU%service_role_exec:public.trigger_instagram_inbound_sweep()%'
          and s6 like 'FALHOU%service_insert_tabela_fila%service_insere_status=ERR 23514:%'
          and d = 'PASSOU' and v_acl is null then 'PASSOU'
         else 'FALHOU update_fila=' || s1 || ' diag_anon=' || s2 || ' claim_auth=' || s3
              || ' ledger_sem_force=' || s4 || ' wrapper_service=' || s5 || ' insert_tabela=' || s6
              || ' restaurado=' || d || ' insert_tabela_restante=' || coalesce(v_acl, '<nenhum>') end);
end $$;

-- C-IG-3.7: (a) sweep sem a guarda da chave (com só a URL no Vault, o POST
-- sai sem `x-internal-key`); (b) sweep
-- apontando para outra EF; (c) refresh sem a guarda da URL.
do $$
declare
  v_sw text; v_tr text; v_mut text; s1 text; s2 text; s3 text; d text;
begin
  v_sw := pg_get_functiondef('public.trigger_instagram_inbound_sweep()'::regprocedure);
  v_tr := pg_get_functiondef('public.trigger_instagram_token_refresh()'::regprocedure);
  begin
    v_mut := replace(pg_temp.ig79_lf(v_sw), 'if v_key is null or v_key = '''' then', 'if false then');
    if v_mut = pg_temp.ig79_lf(v_sw) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_37();
  exception
    when sqlstate 'P0R79' then s1 := sqlerrm;
    when others then s1 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    v_mut := replace(pg_temp.ig79_lf(v_sw), '/functions/v1/process-instagram-inbound?sweep=1', '/functions/v1/webhook-whatsapp?sweep=1');
    if v_mut = pg_temp.ig79_lf(v_sw) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_37();
  exception
    when sqlstate 'P0R79' then s2 := sqlerrm;
    when others then s2 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    v_mut := replace(pg_temp.ig79_lf(v_tr), 'if v_url is null or v_url = '''' then', 'if false then');
    if v_mut = pg_temp.ig79_lf(v_tr) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_37();
  exception
    when sqlstate 'P0R79' then s3 := sqlerrm;
    when others then s3 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  d := pg_temp.ig79_case_37();
  raise notice 'C-IG-3.7 sweep sem guarda da chave: %', s1;
  raise notice 'C-IG-3.7 sweep para outra EF: %', s2;
  raise notice 'C-IG-3.7 refresh sem guarda da URL: %', s3;
  insert into t_res values (7956, 'C-IG-3.7 sweep sem a guarda da chave, sweep para outra EF e refresh sem a guarda da URL: IG-3.7 reprova nos tres; restaurado passa',
    case when s1 like 'FALHOU%so_url=ERR P0N79:http://ig79.invalid/functions/v1/process-instagram-inbound?sweep=1|<null>|%'
          and s2 like 'FALHOU%os_dois=ERR P0N79:http://ig79.invalid/functions/v1/webhook-whatsapp?sweep=1|%'
          and s3 like 'FALHOU%so_chave=ok/ERR P0N79:<null>|ig79-chave-interna|%'
          and d = 'PASSOU'
          and pg_get_functiondef('public.trigger_instagram_inbound_sweep()'::regprocedure) = v_sw
          and pg_get_functiondef('public.trigger_instagram_token_refresh()'::regprocedure) = v_tr then 'PASSOU'
         else 'FALHOU sem_guarda_chave=' || s1 || ' outra_ef=' || s2 || ' sem_guarda_url=' || s3 || ' restaurado=' || d end);
end $$;

-- C-IG-3.8: sem o CHECK de formato do desfecho (a) na fila e (b) no ledger
-- (fix 5); o catálogo é conferido depois.
do $$
declare
  s1 text; s2 text; d text; v_chk int;
begin
  begin
    alter table public.instagram_inbound_events drop constraint instagram_inbound_events_outcome_chk;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_38();
  exception
    when sqlstate 'P0R79' then s1 := sqlerrm;
    when others then s1 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    alter table public.instagram_processed_messages drop constraint instagram_processed_messages_outcome_chk;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_38();
  exception
    when sqlstate 'P0R79' then s2 := sqlerrm;
    when others then s2 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  d := pg_temp.ig79_case_38();
  raise notice 'C-IG-3.8 fila sem CHECK: %', s1;
  raise notice 'C-IG-3.8 ledger sem CHECK: %', s2;
  select count(*) into v_chk from pg_constraint
   where (conrelid = 'public.instagram_inbound_events'::regclass and conname = 'instagram_inbound_events_outcome_chk')
      or (conrelid = 'public.instagram_processed_messages'::regclass and conname = 'instagram_processed_messages_outcome_chk');
  insert into t_res values (7957, 'C-IG-3.8 sem o CHECK de formato do desfecho na fila e no ledger: o texto livre e gravado e IG-3.8 reprova nos dois; restaurado passa',
    case when s1 like 'FALHOU finalize_texto=1%'
          and s2 like 'FALHOU%complete_texto=true%'
          and d = 'PASSOU' and v_chk = 2 then 'PASSOU'
         else 'FALHOU fila_sem_check=' || s1 || ' ledger_sem_check=' || s2 || ' restaurado=' || d || ' checks=' || v_chk end);
end $$;

-- ─── Controles positivos da Task 1.4 ─────────────────────────────────────────
-- Mesmo desenho: o MESMO caso roda sob sabotagem num subbloco desfeito e tem
-- de reprovar com o motivo certo; depois roda de novo e tem de passar, com o
-- objeto conferido contra o catálogo.

-- C-IG-4.1: sem o CHECK de identidade e sem o CHECK de canal.
do $$
declare
  s1 text; s2 text; d text; v_cat text; v_cat2 text;
begin
  select string_agg(conname || '=' || pg_get_constraintdef(oid), ',' order by conname) into v_cat
    from pg_constraint where conrelid = 'public.conversations'::regclass
     and conname in ('conversations_channel_check', 'conversations_channel_identity_check');
  begin
    alter table public.conversations drop constraint conversations_channel_identity_check;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_41();
  exception
    when sqlstate 'P0R79' then s1 := sqlerrm;
    when others then s1 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    alter table public.conversations drop constraint conversations_channel_check;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_41();
  exception
    when sqlstate 'P0R79' then s2 := sqlerrm;
    when others then s2 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  d := pg_temp.ig79_case_41();
  select string_agg(conname || '=' || pg_get_constraintdef(oid), ',' order by conname) into v_cat2
    from pg_constraint where conrelid = 'public.conversations'::regclass
     and conname in ('conversations_channel_check', 'conversations_channel_identity_check');
  raise notice 'C-IG-4.1 sem CHECK de identidade: %', s1;
  raise notice 'C-IG-4.1 sem CHECK de canal: %', s2;
  insert into t_res values (7970, 'C-IG-4.1 sem o CHECK de identidade e sem o CHECK de canal: WhatsApp sem cliente/IG sem contato/canal invalido gravam e IG-4.1 reprova; restaurado passa',
    case when s1 like 'FALHOU wa_sem_cliente=1 ig_sem_contato=1 wa_com_contato=1 %'
          and s2 like 'FALHOU%canal_email=ERR 23514:%conversations_channel_identity_check%'
          and d = 'PASSOU' and v_cat2 = v_cat then 'PASSOU'
         else 'FALHOU sem_identidade=' || s1 || ' sem_canal=' || s2 || ' restaurado=' || d end);
end $$;

-- C-IG-4.2: get_or_create_whatsapp_conversation SEM o filtro de canal (a
-- forma de 20260905143453): acha a conversa IG do cliente ligado e, sem
-- conversa WhatsApp, devolve a IG em vez de criar. Desde a Task 1.6 o CHECK de
-- identidade proíbe `wa_chat_lid` em conversa IG, então a chamada sabotada COM
-- lid estoura 23514 ao tentar gravá-lo na IG (Y fica intacta) e a chamada SEM
-- lid devolve a própria Y2.
do $$
declare
  v_def text; v_mut text; s1 text; d text;
begin
  v_def := pg_get_functiondef('public.get_or_create_whatsapp_conversation(uuid,uuid,text,text)'::regprocedure);
  begin
    v_mut := replace(pg_temp.ig79_lf(v_def), E'where customer_id = p_customer_id and unit_id = p_unit_id\n    and channel = ''whatsapp''',
                            'where customer_id = p_customer_id and unit_id = p_unit_id');
    if v_mut = pg_temp.ig79_lf(v_def) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_42();
  exception
    when sqlstate 'P0R79' then s1 := sqlerrm;
    when others then s1 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  d := pg_temp.ig79_case_42();
  raise notice 'C-IG-4.2 get_or_create sem filtro de canal: %', s1;
  insert into t_res values (7971, 'C-IG-4.2 get_or_create_whatsapp_conversation sem o filtro de canal: acha a conversa IG (com lid: 23514 do CHECK de identidade; sem lid: devolve Y2) e IG-4.2 reprova; restaurada passa',
    case when s1 like 'FALHOU%'
          and s1 like '%wa_c1=ERR 23514:%conversations_channel_identity_check%'
          and s1 like '%y_depois=IG 42a|-|%'
          and substring(s1 from 'wa_c2_de_novo=([0-9a-f-]{36})') = substring(s1 from ' y2=([0-9a-f-]{36})')
          and d = 'PASSOU'
          and pg_get_functiondef('public.get_or_create_whatsapp_conversation(uuid,uuid,text,text)'::regprocedure) = v_def then 'PASSOU'
         else 'FALHOU sem_filtro=' || s1 || ' restaurado=' || d end);
end $$;

-- C-IG-4.3: (a) reconcile SEM o filtro de canal no exists (a forma de
-- 20261019183559): o event_id na conversa IG faz o aceite NÃO ir para a
-- conversa WhatsApp; (b) reconcile real, mas get_or_create SEM o filtro: o
-- aceite do cliente sem conversa WhatsApp cai na conversa IG.
do $$
declare
  v_rec text; v_goc text; v_mut text; s1 text; s2 text; d text;
begin
  v_rec := pg_get_functiondef('app_private.reconcile_whatsapp_automation_acceptance_inner(uuid)'::regprocedure);
  v_goc := pg_get_functiondef('public.get_or_create_whatsapp_conversation(uuid,uuid,text,text)'::regprocedure);
  begin
    v_mut := replace(pg_temp.ig79_lf(v_rec), E'where conversation.unit_id=j.unit_id and conversation.customer_id=j.customer_id\n        and conversation.channel = ''whatsapp''',
                            'where conversation.unit_id=j.unit_id and conversation.customer_id=j.customer_id');
    if v_mut = pg_temp.ig79_lf(v_rec) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_43();
  exception
    when sqlstate 'P0R79' then s1 := sqlerrm;
    when others then s1 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    v_mut := replace(pg_temp.ig79_lf(v_goc), E'where customer_id = p_customer_id and unit_id = p_unit_id\n    and channel = ''whatsapp''',
                            'where customer_id = p_customer_id and unit_id = p_unit_id');
    if v_mut = pg_temp.ig79_lf(v_goc) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_43();
  exception
    when sqlstate 'P0R79' then s2 := sqlerrm;
    when others then s2 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  d := pg_temp.ig79_case_43();
  raise notice 'C-IG-4.3 reconcile sem filtro de canal: %', s1;
  raise notice 'C-IG-4.3 get_or_create sem filtro de canal: %', s2;
  insert into t_res values (7972, 'C-IG-4.3 reconcile sem o filtro de canal no exists (aceite some da conversa WhatsApp) e get_or_create sem o filtro (aceite cai na conversa IG): IG-4.3 reprova nos dois; restaurado passa',
    case when s1 like 'FALHOU%aceite_em_X=0 %aceite_em_Y2=0 %'
          and s2 like 'FALHOU%aceite_em_Y2=1 %'
          and d = 'PASSOU'
          and pg_get_functiondef('app_private.reconcile_whatsapp_automation_acceptance_inner(uuid)'::regprocedure) = v_rec
          and pg_get_functiondef('public.get_or_create_whatsapp_conversation(uuid,uuid,text,text)'::regprocedure) = v_goc then 'PASSOU'
         else 'FALHOU reconcile_sem_filtro=' || s1 || ' get_or_create_sem_filtro=' || s2 || ' restaurado=' || d end);
end $$;

-- C-IG-4.4: guarda sem (a) a unidade do contato, (b) a imutabilidade do
-- canal, (c) a organização do cliente, (d) a imutabilidade da unidade e (e) o
-- cliente do contato na conversa IG (d e e: fix round 1).
do $$
declare
  v_def text; v_mut text; s1 text; s2 text; s3 text; s4 text; s5 text; d text;
begin
  v_def := pg_get_functiondef('public.conversations_channel_guard()'::regprocedure);
  begin
    v_mut := replace(pg_temp.ig79_lf(v_def), 'if v_contact_unit is null or v_contact_unit is distinct from new.unit_id then', 'if false then');
    if v_mut = pg_temp.ig79_lf(v_def) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_44();
  exception
    when sqlstate 'P0R79' then s1 := sqlerrm;
    when others then s1 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    v_mut := replace(pg_temp.ig79_lf(v_def), 'if tg_op = ''UPDATE'' and new.channel is distinct from old.channel then', 'if false then');
    if v_mut = pg_temp.ig79_lf(v_def) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_44();
  exception
    when sqlstate 'P0R79' then s2 := sqlerrm;
    when others then s2 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    v_mut := replace(pg_temp.ig79_lf(v_def), 'if v_cust_org is null or v_cust_org is distinct from v_unit_org then', 'if false then');
    if v_mut = pg_temp.ig79_lf(v_def) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_44();
  exception
    when sqlstate 'P0R79' then s3 := sqlerrm;
    when others then s3 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    v_mut := replace(pg_temp.ig79_lf(v_def), 'if tg_op = ''UPDATE'' and new.unit_id is distinct from old.unit_id then', 'if false then');
    if v_mut = pg_temp.ig79_lf(v_def) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_44();
  exception
    when sqlstate 'P0R79' then s4 := sqlerrm;
    when others then s4 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    v_mut := replace(pg_temp.ig79_lf(v_def), 'if new.customer_id is distinct from v_contact_cust then', 'if false then');
    if v_mut = pg_temp.ig79_lf(v_def) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_44();
  exception
    when sqlstate 'P0R79' then s5 := sqlerrm;
    when others then s5 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  d := pg_temp.ig79_case_44();
  raise notice 'C-IG-4.4 guarda sem unidade do contato: %', s1;
  raise notice 'C-IG-4.4 guarda sem imutabilidade do canal: %', s2;
  raise notice 'C-IG-4.4 guarda sem organizacao do cliente: %', s3;
  raise notice 'C-IG-4.4 guarda sem imutabilidade da unidade: %', s4;
  raise notice 'C-IG-4.4 guarda sem cliente do contato na conversa IG: %', s5;
  insert into t_res values (7973, 'C-IG-4.4 guarda sem a unidade do contato, sem a imutabilidade do canal, sem a organizacao do cliente, sem a imutabilidade da unidade e sem o cliente do contato: IG-4.4 reprova nos cinco; restaurada passa',
    case when s1 like 'FALHOU ig_contato_B_service_role=1 ig_contato_B_postgres=1 ig_em_B_contato_A=1 %'
          and s2 like 'FALHOU%wa_para_ig=1 ig_para_wa=1 %'
          and s3 like 'FALHOU%cliente_outra_org=1 %'
          and s4 like 'FALHOU%mover_wa=1 %'
          and s5 like 'FALHOU%ig_cli_upd=1 ig_cli_ins=1 %'
          and d = 'PASSOU'
          and pg_get_functiondef('public.conversations_channel_guard()'::regprocedure) = v_def then 'PASSOU'
         else 'FALHOU sem_unidade=' || s1 || ' sem_imutabilidade=' || s2 || ' sem_org_cliente=' || s3
              || ' sem_unidade_imutavel=' || s4 || ' sem_cliente_do_contato=' || s5 || ' restaurada=' || d end);
end $$;

-- C-IG-4.5: get_or_create_instagram_conversation (a) aceitando contato
-- anonimizado e (b) sem achar a conversa existente (cria de novo).
do $$
declare
  v_def text; v_mut text; s1 text; s2 text; d text;
begin
  v_def := pg_get_functiondef('public.get_or_create_instagram_conversation(uuid)'::regprocedure);
  begin
    v_mut := replace(pg_temp.ig79_lf(v_def), 'if v_anon is not null then', 'if false then');
    if v_mut = pg_temp.ig79_lf(v_def) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_45();
  exception
    when sqlstate 'P0R79' then s1 := sqlerrm;
    when others then s1 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    v_mut := replace(pg_temp.ig79_lf(v_def), 'where cv.instagram_contact_id = p_contact_id;', 'where false;');
    if v_mut = pg_temp.ig79_lf(v_def) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_45();
  exception
    when sqlstate 'P0R79' then s2 := sqlerrm;
    when others then s2 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  d := pg_temp.ig79_case_45();
  raise notice 'C-IG-4.5 aceita anonimizado: %', s1;
  raise notice 'C-IG-4.5 sem achar a existente: %', s2;
  insert into t_res values (7974, 'C-IG-4.5 get_or_create_instagram_conversation aceitando contato anonimizado e sem achar a conversa existente: IG-4.5 reprova nos dois; restaurada passa',
    case when s1 like 'FALHOU%' and s1 not like '%anonimizado=ERR%'
          and s2 like 'FALHOU%segunda=ERR 23505:%'
          and d = 'PASSOU'
          and pg_get_functiondef('public.get_or_create_instagram_conversation(uuid)'::regprocedure) = v_def then 'PASSOU'
         else 'FALHOU aceita_anonimizado=' || s1 || ' recria=' || s2 || ' restaurada=' || d end);
end $$;

-- C-IG-4.6: link (a) sem a organização do cliente (sobra o guard do contato,
-- que responde 23514 em vez do 42501 uniforme), (b) aceitando cliente
-- apagado, (c) sem espelhar o cliente na conversa.
do $$
declare
  v_def text; v_mut text; s1 text; s2 text; s3 text; d text;
begin
  v_def := pg_get_functiondef('public.link_instagram_contact_customer(uuid,uuid)'::regprocedure);
  begin
    v_mut := replace(pg_temp.ig79_lf(v_def), E'\n       and cu.organization_id = v_org', '');
    if v_mut = pg_temp.ig79_lf(v_def) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_46();
  exception
    when sqlstate 'P0R79' then s1 := sqlerrm;
    when others then s1 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    v_mut := replace(pg_temp.ig79_lf(v_def), E'\n       and cu.deleted_at is null', '');
    if v_mut = pg_temp.ig79_lf(v_def) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_46();
  exception
    when sqlstate 'P0R79' then s2 := sqlerrm;
    when others then s2 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    v_mut := replace(pg_temp.ig79_lf(v_def), E'where cv.instagram_contact_id = p_contact_id\n     and cv.customer_id is distinct from p_customer_id;', 'where false;');
    if v_mut = pg_temp.ig79_lf(v_def) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_46();
  exception
    when sqlstate 'P0R79' then s3 := sqlerrm;
    when others then s3 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  d := pg_temp.ig79_case_46();
  raise notice 'C-IG-4.6 sem organizacao do cliente: %', s1;
  raise notice 'C-IG-4.6 aceita cliente apagado: %', s2;
  raise notice 'C-IG-4.6 sem espelhar na conversa: %', s3;
  insert into t_res values (7975, 'C-IG-4.6 link sem a organizacao do cliente, aceitando cliente apagado e sem espelhar o cliente na conversa: IG-4.6 reprova nos tres; restaurado passa',
    case when s1 like 'FALHOU cliente_org_B=ERR 23514:%'
          and s2 like 'FALHOU%cliente_apagado=ok %'
          and s3 like 'FALHOU%depois=a0d79000-0000-4000-8000-000000004601|true|- %'
          and d = 'PASSOU'
          and pg_get_functiondef('public.link_instagram_contact_customer(uuid,uuid)'::regprocedure) = v_def then 'PASSOU'
         else 'FALHOU sem_org=' || s1 || ' apagado=' || s2 || ' sem_espelho=' || s3 || ' restaurado=' || d end);
end $$;

-- C-IG-4.7: (a) UPDATE em `channel` para authenticated, (b) policy de membro
-- aberta, (c) EXECUTE da RPC nova para authenticated.
do $$
declare
  v_acl text; v_pol text; v_fn text; s1 text; s2 text; s3 text; d text;
begin
  select coalesce(relacl::text, '-') || '#' || (select string_agg(attname || '=' || coalesce(attacl::text, '-'), ',' order by attnum)
           from pg_attribute where attrelid = 'public.conversations'::regclass and attnum > 0 and not attisdropped) into v_acl
    from pg_class where oid = 'public.conversations'::regclass;
  select string_agg(polname || '=' || coalesce(pg_get_expr(polqual, polrelid), '-') || '/' || coalesce(pg_get_expr(polwithcheck, polrelid), '-'), ',' order by polname) into v_pol
    from pg_policy where polrelid = 'public.conversations'::regclass;
  select coalesce(proacl::text, '-') into v_fn from pg_proc where oid = 'public.get_or_create_instagram_conversation(uuid)'::regprocedure;
  begin
    grant update (channel) on public.conversations to authenticated;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_47();
  exception
    when sqlstate 'P0R79' then s1 := sqlerrm;
    when others then s1 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    drop policy "unit_member_all_conversations" on public.conversations;
    create policy "unit_member_all_conversations" on public.conversations for all to authenticated using (true) with check (true);
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_47();
  exception
    when sqlstate 'P0R79' then s2 := sqlerrm;
    when others then s2 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    grant execute on function public.get_or_create_instagram_conversation(uuid) to authenticated;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_47();
  exception
    when sqlstate 'P0R79' then s3 := sqlerrm;
    when others then s3 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  d := pg_temp.ig79_case_47();
  raise notice 'C-IG-4.7 UPDATE em channel: %', s1;
  raise notice 'C-IG-4.7 policy aberta: %', s2;
  raise notice 'C-IG-4.7 EXECUTE para authenticated: %', s3;
  insert into t_res values (7976, 'C-IG-4.7 UPDATE em channel para authenticated, policy de membro aberta e EXECUTE da RPC nova para authenticated: IG-4.7 reprova nos tres; restaurado passa',
    case when s1 like 'FALHOU%authenticated:channel:UPDATE=true%'
          and s2 like 'FALHOU A_le_A=1 A_le_B=1 %'
          and s3 like 'FALHOU%public.get_or_create_instagram_conversation(uuid)=authenticated+service_role%'
          and d = 'PASSOU'
          and (select coalesce(relacl::text, '-') || '#' || (select string_agg(attname || '=' || coalesce(attacl::text, '-'), ',' order by attnum)
                 from pg_attribute where attrelid = 'public.conversations'::regclass and attnum > 0 and not attisdropped)
                 from pg_class where oid = 'public.conversations'::regclass) = v_acl
          and (select string_agg(polname || '=' || coalesce(pg_get_expr(polqual, polrelid), '-') || '/' || coalesce(pg_get_expr(polwithcheck, polrelid), '-'), ',' order by polname)
                 from pg_policy where polrelid = 'public.conversations'::regclass) = v_pol
          and (select coalesce(proacl::text, '-') from pg_proc where oid = 'public.get_or_create_instagram_conversation(uuid)'::regprocedure) = v_fn then 'PASSOU'
         else 'FALHOU update_channel=' || s1 || ' policy_aberta=' || s2 || ' execute_auth=' || s3 || ' restaurado=' || d end);
end $$;

-- C-IG-4.8: (a) sem o trigger de limpeza do nome; (b) função sem o filtro do
-- contato (limpa o nome de TODA conversa IG). Trigger e função conferidos
-- contra o catálogo depois.
do $$
declare
  v_def text; v_trg text; v_mut text; s1 text; s2 text; d text;
begin
  v_def := pg_get_functiondef('public.conversations_clear_instagram_contact_name()'::regprocedure);
  select pg_get_triggerdef(t.oid) into v_trg from pg_trigger t
   where t.tgrelid = 'public.instagram_contacts'::regclass and t.tgname = 'conversations_clear_instagram_contact_name_trg';
  begin
    drop trigger conversations_clear_instagram_contact_name_trg on public.instagram_contacts;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_48();
  exception
    when sqlstate 'P0R79' then s1 := sqlerrm;
    when others then s1 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    v_mut := replace(pg_temp.ig79_lf(v_def), E'where cv.instagram_contact_id = new.id\n     and cv.contact_name is not null;', 'where cv.contact_name is not null and cv.channel = ''instagram'';');
    if v_mut = pg_temp.ig79_lf(v_def) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_48();
  exception
    when sqlstate 'P0R79' then s2 := sqlerrm;
    when others then s2 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  d := pg_temp.ig79_case_48();
  raise notice 'C-IG-4.8 sem trigger de limpeza: %', s1;
  raise notice 'C-IG-4.8 limpeza sem filtro do contato: %', s2;
  insert into t_res values (7978, 'C-IG-4.8 sem o trigger de limpeza (o nome sobrevive a anonimizacao) e limpeza sem o filtro do contato (apaga o nome de outro contato): IG-4.8 reprova nos dois; restaurado passa',
    case when s1 like 'FALHOU%nome_x=Nome 48x nome_y=Nome 48y nome_z=@user48z %'
          and s2 like 'FALHOU%nome_x=<null> nome_y=<null> nome_z=<null> %'
          and d = 'PASSOU'
          and pg_get_functiondef('public.conversations_clear_instagram_contact_name()'::regprocedure) = v_def
          and (select pg_get_triggerdef(t.oid) from pg_trigger t
                where t.tgrelid = 'public.instagram_contacts'::regclass and t.tgname = 'conversations_clear_instagram_contact_name_trg') = v_trg then 'PASSOU'
         else 'FALHOU sem_trigger=' || s1 || ' sem_filtro=' || s2 || ' restaurado=' || d end);
end $$;

-- ─── Controles positivos da Task 1.5 ────────────────────────────────────────
-- C-IG-5.1: (a) o trigger passa a pular também `instagram` (`not in
-- ('whatsapp','instagram')`) — é a prova de D6: IG-5.1 reprova sem a
-- confirmação; (b) o CHECK antigo de volta (web/whatsapp) — a reserva do
-- Instagram é recusada. Corpo e CHECK conferidos contra o catálogo depois.
do $$
declare
  v_def text; v_mut text; v_chk text; s1 text; s2 text; d text;
begin
  v_def := pg_get_functiondef('public.enqueue_confirmation_notification()'::regprocedure);
  select pg_get_constraintdef(c.oid) || '/' || c.convalidated into v_chk
    from pg_constraint c where c.conrelid = 'public.reservations'::regclass and c.conname = 'reservations_source_check';
  begin
    v_mut := replace(pg_temp.ig79_lf(v_def), $s$if new.source is distinct from 'whatsapp' then$s$, $s$if new.source not in ('whatsapp', 'instagram') then$s$);
    if v_mut = pg_temp.ig79_lf(v_def) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_51();
  exception
    when sqlstate 'P0R79' then s1 := sqlerrm;
    when others then s1 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    alter table public.reservations drop constraint reservations_source_check;
    alter table public.reservations add constraint reservations_source_check check (source in ('web', 'whatsapp'));
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_51();
  exception
    when sqlstate 'P0R79' then s2 := sqlerrm;
    when others then s2 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  d := pg_temp.ig79_case_51();
  raise notice 'C-IG-5.1 trigger pulando instagram: %', s1;
  raise notice 'C-IG-5.1 CHECK antigo: %', s2;
  insert into t_res values (7990, 'C-IG-5.1 trigger com not in (whatsapp, instagram) e CHECK antigo web/whatsapp: IG-5.1 reprova nos dois (sem confirmacao; reserva recusada); restaurado passa',
    case when s1 like 'FALHOU ins_ig=1 source_ig=instagram outbox_ig=<null> ins_wa=1 outbox_wa=<null> ins_web=1 outbox_web=confirmation/pending/true %'
          and s2 like 'FALHOU ins_ig=ERR 23514:%reservations_source_check%outbox_ig=<null>%'
          and d = 'PASSOU'
          and pg_get_functiondef('public.enqueue_confirmation_notification()'::regprocedure) = v_def
          and (select pg_get_constraintdef(c.oid) || '/' || c.convalidated
                 from pg_constraint c where c.conrelid = 'public.reservations'::regclass and c.conname = 'reservations_source_check') = v_chk then 'PASSOU'
         else 'FALHOU trigger=' || s1 || ' check_antigo=' || s2 || ' restaurado=' || d end);
end $$;

-- C-IG-5.2: (a) CHECK novo deixado NOT VALID (sem o VALIDATE); (b) o CHECK
-- novo somado ao antigo em vez de substituí-lo (ADD sem o DROP por nome);
-- (c) o corpo do trigger alterado para citar `instagram` (D6 violada).
do $$
declare
  v_def text; v_mut text; v_chk text; s1 text; s2 text; s3 text; d text;
begin
  v_def := pg_get_functiondef('public.enqueue_confirmation_notification()'::regprocedure);
  select string_agg(c.conname || '=' || pg_get_constraintdef(c.oid) || '/' || c.convalidated, ',' order by c.conname) into v_chk
    from pg_constraint c where c.conrelid = 'public.reservations'::regclass and c.contype = 'c';
  begin
    alter table public.reservations drop constraint reservations_source_check;
    alter table public.reservations add constraint reservations_source_check
      check (source in ('web', 'whatsapp', 'instagram')) not valid;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_52();
  exception
    when sqlstate 'P0R79' then s1 := sqlerrm;
    when others then s1 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    alter table public.reservations drop constraint reservations_source_check;
    alter table public.reservations add constraint reservations_source_check check (source in ('web', 'whatsapp'));
    alter table public.reservations add constraint reservations_source_check1 check (source in ('web', 'whatsapp', 'instagram'));
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_52();
  exception
    when sqlstate 'P0R79' then s2 := sqlerrm;
    when others then s2 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    v_mut := replace(pg_temp.ig79_lf(v_def), $s$if new.source is distinct from 'whatsapp' then$s$, $s$if new.source not in ('whatsapp', 'instagram') then$s$);
    if v_mut = pg_temp.ig79_lf(v_def) then raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE'; end if;
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_52();
  exception
    when sqlstate 'P0R79' then s3 := sqlerrm;
    when others then s3 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  d := pg_temp.ig79_case_52();
  raise notice 'C-IG-5.2 NOT VALID sem VALIDATE: %', s1;
  raise notice 'C-IG-5.2 CHECK novo somado ao antigo: %', s2;
  raise notice 'C-IG-5.2 corpo do trigger alterado: %', s3;
  insert into t_res values (7991, 'C-IG-5.2 CHECK deixado NOT VALID, CHECK novo somado ao antigo e corpo do trigger citando instagram: IG-5.2 reprova nos tres; restaurado passa',
    case when s1 like 'FALHOU check=reservations_source_check=%instagram%/false coluna=%'
          and s2 like 'FALHOU check=reservations_source_check=%whatsapp''::text])))/true,reservations_source_check1=%instagram%/true coluna=%'
          and s3 like 'FALHOU %funcao=corpo_alterado %'
          and d = 'PASSOU'
          and pg_get_functiondef('public.enqueue_confirmation_notification()'::regprocedure) = v_def
          and (select string_agg(c.conname || '=' || pg_get_constraintdef(c.oid) || '/' || c.convalidated, ',' order by c.conname)
                 from pg_constraint c where c.conrelid = 'public.reservations'::regclass and c.contype = 'c') = v_chk then 'PASSOU'
         else 'FALHOU not_valid=' || s1 || ' somado=' || s2 || ' corpo=' || s3 || ' restaurado=' || d end);
end $$;

-- ─── Task 1.6 (fix round 1): casos e controles positivos ────────────────────
insert into t_res values
  (7914, 'IG-6.1 store autoriza no SQL: sem grant (owner e platform_admin), operador, owner de outra unidade, unidade inexistente, ator nulo e grant revogado com o mesmo 42501; owner/gerente com grant e platform_admin sem membership conectam', pg_temp.ig79_case_61()),
  (7915, 'IG-6.2 disconnect prende o ator a unidade da conta: operador, owner de outra unidade, gerente de B, ator nulo e conta inexistente com o mesmo 42501 (conta intacta); owner sem grant e platform_admin desconectam', pg_temp.ig79_case_62()),
  (7916, 'IG-6.3 contatos: service_role le mas UPDATE/INSERT/DELETE diretos dao 42501; link pela RPC grava; desanonimizar (mesmo com IGSID novo) da 23514; escritores SECURITY DEFINER', pg_temp.ig79_case_63()),
  (7917, 'IG-6.4 conversa IG com wa_chat_lid (INSERT e UPDATE) viola o CHECK de identidade com 23514; WhatsApp com wa_chat_lid aceito; CHECK validado cita wa_chat_lid IS NULL', pg_temp.ig79_case_64());

-- C-IG-6.1: (a) store sem a perna de papel (todo membro conecta); (b) store
-- sem a perna do grant (conecta sem o módulo liberado); (c) platform_admin
-- isento do grant.
do $$
declare
  v_def text; v_mut text; s1 text; s2 text; s3 text; d text;
  leg_papel constant text := 'and um.role in (''owner'', ''gerente'')';
  leg_grant constant text := pg_temp.ig79_lf('or not exists (
       select 1 from public.unit_module_grants g');
begin
  v_def := pg_get_functiondef('public.store_instagram_account_connection(uuid,text,text,text,text,timestamptz,uuid)'::regprocedure);
  begin
    if array_length(string_to_array(pg_temp.ig79_lf(v_def), leg_papel), 1) <> 2 then
      raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE OU REPETIDO (papel)';
    end if;
    v_mut := replace(pg_temp.ig79_lf(v_def), leg_papel, '');
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_61();
  exception
    when sqlstate 'P0R79' then s1 := sqlerrm;
    when others then s1 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    if array_length(string_to_array(pg_temp.ig79_lf(v_def), leg_grant), 1) <> 2 then
      raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE OU REPETIDO (grant)';
    end if;
    v_mut := replace(pg_temp.ig79_lf(v_def), leg_grant, 'or false and not exists (
       select 1 from public.unit_module_grants g');
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_61();
  exception
    when sqlstate 'P0R79' then s2 := sqlerrm;
    when others then s2 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  -- (c) guarda virando `(papel e grant) ou platform_admin`: o admin pula o
  -- módulo (conecta numa unidade sem grant).
  begin
    if array_length(string_to_array(pg_temp.ig79_lf(v_def), leg_grant), 1) <> 2 then
      raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE OU REPETIDO (grant)';
    end if;
    v_mut := replace(pg_temp.ig79_lf(v_def), leg_grant, 'or not app_private.is_platform_admin(p_actor) and not exists (
       select 1 from public.unit_module_grants g');
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_61();
  exception
    when sqlstate 'P0R79' then s3 := sqlerrm;
    when others then s3 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  d := pg_temp.ig79_case_61();
  raise notice 'C-IG-6.1 sem papel: %', s1;
  raise notice 'C-IG-6.1 sem grant: %', s2;
  raise notice 'C-IG-6.1 admin pula o grant: %', s3;
  insert into t_res values (7992, 'C-IG-6.1 store sem a perna de papel, sem a perna do grant e com o admin pulando o grant: IG-6.1 reprova nos tres (operador conecta; conecta sem modulo; admin conecta sem modulo); restaurado passa',
    case when s1 like 'FALHOU sem_grant=ERR 42501:instagram_account_forbidden %operador=________-%'
          and s2 like 'FALHOU sem_grant=________-%'
          and s3 like 'FALHOU sem_grant=ERR 42501:instagram_account_forbidden pa_sem_grant=________-%'
          and d = 'PASSOU'
          and pg_get_functiondef('public.store_instagram_account_connection(uuid,text,text,text,text,timestamptz,uuid)'::regprocedure) = v_def then 'PASSOU'
         else 'FALHOU sem_papel=' || s1 || ' sem_grant=' || s2 || ' admin_pula_grant=' || s3 || ' restaurado=' || d end);
end $$;

-- C-IG-6.2: (a) disconnect sem a perna de papel; (b) disconnect sem prender o
-- ator à unidade da conta; (c) conta inexistente de volta a P0002.
do $$
declare
  v_def text; v_mut text; s1 text; s2 text; s3 text; d text;
  leg_papel constant text := 'and um.role in (''owner'', ''gerente'')';
  leg_unid constant text := 'where um.unit_id = v_acc.unit_id';
  leg_inex constant text := 'if v_acc.id is null or p_actor is null';
begin
  v_def := pg_get_functiondef('public.disconnect_instagram_account(uuid,uuid)'::regprocedure);
  begin
    if array_length(string_to_array(pg_temp.ig79_lf(v_def), leg_papel), 1) <> 2 then
      raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE OU REPETIDO (papel)';
    end if;
    v_mut := replace(pg_temp.ig79_lf(v_def), leg_papel, '');
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_62();
  exception
    when sqlstate 'P0R79' then s1 := sqlerrm;
    when others then s1 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    if array_length(string_to_array(pg_temp.ig79_lf(v_def), leg_unid), 1) <> 2 then
      raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE OU REPETIDO (unidade)';
    end if;
    v_mut := replace(pg_temp.ig79_lf(v_def), leg_unid, 'where true');
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_62();
  exception
    when sqlstate 'P0R79' then s2 := sqlerrm;
    when others then s2 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  -- (c) o ramo P0002 de conta inexistente de volta (oráculo de existência).
  begin
    if array_length(string_to_array(pg_temp.ig79_lf(v_def), leg_inex), 1) <> 2 then
      raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE OU REPETIDO (inexistente)';
    end if;
    v_mut := replace(pg_temp.ig79_lf(v_def), leg_inex, 'if not found then
    raise exception ''instagram_account_not_found'' using errcode = ''P0002'';
  end if;
  if p_actor is null');
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_62();
  exception
    when sqlstate 'P0R79' then s3 := sqlerrm;
    when others then s3 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  d := pg_temp.ig79_case_62();
  raise notice 'C-IG-6.2 sem papel: %', s1;
  raise notice 'C-IG-6.2 sem unidade da conta: %', s2;
  raise notice 'C-IG-6.2 P0002 de volta: %', s3;
  insert into t_res values (7993, 'C-IG-6.2 disconnect sem a perna de papel, sem prender o ator a unidade da conta e com o P0002 de conta inexistente: IG-6.2 reprova nos tres; restaurado passa',
    case when s1 like 'FALHOU%operador=ok%'
          and s2 like 'FALHOU%owner_A_em_B=ok%'
          and s3 like 'FALHOU%conta_inexistente=ERR P0002:instagram_account_not_found%'
          and d = 'PASSOU'
          and pg_get_functiondef('public.disconnect_instagram_account(uuid,uuid)'::regprocedure) = v_def then 'PASSOU'
         else 'FALHOU sem_papel=' || s1 || ' sem_unidade=' || s2 || ' p0002=' || s3 || ' restaurado=' || d end);
end $$;

-- C-IG-6.3: (a) UPDATE em instagram_contacts de volta para service_role;
-- (b) guarda do contato sem a perna da anonimização irreversível.
do $$
declare
  v_def text; v_mut text; s1 text; s2 text; d text; c21 text;
  leg_anon constant text := 'if tg_op = ''UPDATE'' and old.anonymized_at is not null and new.anonymized_at is null then';
begin
  v_def := pg_get_functiondef('public.instagram_contact_tenant_guard()'::regprocedure);
  begin
    grant update on public.instagram_contacts to service_role;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_63() || ' | IG-2.1: ' || pg_temp.ig79_case_21();
  exception
    when sqlstate 'P0R79' then s1 := sqlerrm;
    when others then s1 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  begin
    if array_length(string_to_array(pg_temp.ig79_lf(v_def), leg_anon), 1) <> 2 then
      raise exception using errcode = 'P0R79', message = 'TRECHO AUSENTE OU REPETIDO (anonimizacao)';
    end if;
    v_mut := replace(pg_temp.ig79_lf(v_def), leg_anon, 'if false then');
    execute v_mut;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_63();
  exception
    when sqlstate 'P0R79' then s2 := sqlerrm;
    when others then s2 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  d := pg_temp.ig79_case_63();
  c21 := pg_temp.ig79_case_21();
  raise notice 'C-IG-6.3 service_role com UPDATE: %', s1;
  raise notice 'C-IG-6.3 sem a perna da anonimizacao: %', s2;
  insert into t_res values (7994, 'C-IG-6.3 UPDATE de contatos para service_role e guarda sem a perna da anonimizacao irreversivel: IG-6.3 (e o catalogo do IG-2.1) reprovam; restaurado passa',
    case when s1 like 'FALHOU update_direto=1 %IG-2.1: FALHOU%service_escreve_contacts%'
          and s2 like 'FALHOU%desanonimizar=1 estado=false|igsid-63-volta%'
          and d = 'PASSOU' and c21 = 'PASSOU'
          and not has_table_privilege('service_role', 'public.instagram_contacts', 'UPDATE')
          and pg_get_functiondef('public.instagram_contact_tenant_guard()'::regprocedure) = v_def then 'PASSOU'
         else 'FALHOU update_service=' || s1 || ' sem_perna_anon=' || s2 || ' restaurado=' || d || ' ig21=' || c21 end);
end $$;

-- C-IG-6.4: CHECK de identidade recriado (NOT VALID + VALIDATE) sem a perna
-- `wa_chat_lid is null` no ramo do Instagram.
do $$
declare
  s1 text; d text; v_cat text; v_cat2 text;
begin
  select pg_get_constraintdef(c.oid) || '/' || c.convalidated into v_cat
    from pg_constraint c where c.conrelid = 'public.conversations'::regclass and c.conname = 'conversations_channel_identity_check';
  begin
    alter table public.conversations drop constraint conversations_channel_identity_check;
    alter table public.conversations add constraint conversations_channel_identity_check
      check (
        (channel = 'whatsapp' and customer_id is not null and instagram_contact_id is null)
        or (channel = 'instagram' and instagram_contact_id is not null)
      ) not valid;
    alter table public.conversations validate constraint conversations_channel_identity_check;
    raise exception using errcode = 'P0R79', message = pg_temp.ig79_case_64();
  exception
    when sqlstate 'P0R79' then s1 := sqlerrm;
    when others then s1 := 'ERRO ' || sqlstate || ':' || sqlerrm;
  end;
  d := pg_temp.ig79_case_64();
  select pg_get_constraintdef(c.oid) || '/' || c.convalidated into v_cat2
    from pg_constraint c where c.conrelid = 'public.conversations'::regclass and c.conname = 'conversations_channel_identity_check';
  raise notice 'C-IG-6.4 sem a perna wa_chat_lid: %', s1;
  insert into t_res values (7995, 'C-IG-6.4 CHECK de identidade sem a perna wa_chat_lid is null: conversa IG com wa_chat_lid grava e IG-6.4 reprova; restaurado passa',
    case when s1 like 'FALHOU ig_com_lid=1 %update_lid=1 %'
          and d = 'PASSOU' and v_cat2 = v_cat then 'PASSOU'
         else 'FALHOU sem_perna=' || s1 || ' restaurado=' || d end);
end $$;

-- ─── IG-5.3 (Task 1.5, fix round 1): guarda de drift da migration ───────────
-- A migration 20261029200400 exige, antes do COMMIT, exatamente UM CHECK de
-- `source` (o `reservations_source_check`, validado). Este caso REAPLICA o
-- arquivo da migration (via `\ir`) sobre um banco com drift: o CHECK antigo
-- (web/whatsapp) mais um CHECK de origem com outro nome. Esperado: a migration
-- aborta com P0001 `reservations_source_check_drift` e o catálogo fica como
-- estava (o CHECK antigo NÃO é trocado). Depois o drift sai e a migration é
-- reaplicada de verdade, restaurando o estado — conferido contra o catálogo
-- capturado antes e pelo IG-5.2.
-- O `ERROR: reservations_source_check_drift` que o psql imprime aqui é o
-- ESPERADO (ON_ERROR_STOP desligado só em volta do `\ir`).
-- Controle positivo: manual, fora do 79 (README §79): a mesma sequência com
-- uma cópia da migration sem a guarda aplica com exit 0 e o drift sobrevive
-- (dois CHECKs, que o IG-5.2 reprova).
drop table if exists pg_temp.t_ig53;
create temp table t_ig53 (k text primary key, v text);
insert into t_ig53
select 'orig', string_agg(c.conname || '=' || pg_get_constraintdef(c.oid) || '/' || c.convalidated, ',' order by c.conname)
  from pg_constraint c where c.conrelid = 'public.reservations'::regclass and c.contype = 'c';

begin;
alter table public.reservations drop constraint reservations_source_check;
alter table public.reservations add constraint reservations_source_check check (source in ('web', 'whatsapp'));
alter table public.reservations add constraint reservations_source_drift79 check (source <> '');
commit;
insert into t_ig53
select 'antes', string_agg(c.conname || '=' || pg_get_constraintdef(c.oid) || '/' || c.convalidated, ',' order by c.conname)
  from pg_constraint c where c.conrelid = 'public.reservations'::regclass and c.contype = 'c';

\set LAST_ERROR_SQLSTATE 00000
\set LAST_ERROR_MESSAGE ''
\set ON_ERROR_STOP off
\ir ../../migrations/20261029200400_reservations_source_instagram.sql
\set ON_ERROR_STOP on
insert into t_ig53 values ('erro', :'LAST_ERROR_SQLSTATE' || ':' || :'LAST_ERROR_MESSAGE');
insert into t_ig53
select 'depois', string_agg(c.conname || '=' || pg_get_constraintdef(c.oid) || '/' || c.convalidated, ',' order by c.conname)
  from pg_constraint c where c.conrelid = 'public.reservations'::regclass and c.contype = 'c';

-- Restauração: tira o drift e reaplica a migration (agora tem de passar).
alter table public.reservations drop constraint if exists reservations_source_drift79;
\ir ../../migrations/20261029200400_reservations_source_instagram.sql
insert into t_ig53
select 'restaurado', string_agg(c.conname || '=' || pg_get_constraintdef(c.oid) || '/' || c.convalidated, ',' order by c.conname)
  from pg_constraint c where c.conrelid = 'public.reservations'::regclass and c.contype = 'c';

do $$
declare o text; a text; e text; d text; r text; c52 text;
begin
  select v into o from t_ig53 where k = 'orig';
  select v into a from t_ig53 where k = 'antes';
  select v into e from t_ig53 where k = 'erro';
  select v into d from t_ig53 where k = 'depois';
  select v into r from t_ig53 where k = 'restaurado';
  c52 := pg_temp.ig79_case_52();
  raise notice 'IG-5.3 erro da reaplicacao com drift: %', e;
  insert into t_res values (7982, 'IG-5.3 reaplicar a migration com um segundo CHECK de source (drift) aborta com P0001 reservations_source_check_drift sem mudar o catalogo; sem o drift reaplica e restaura',
    case when e = 'P0001:reservations_source_check_drift'
          and a like '%reservations_source_check=CHECK ((source = ANY (ARRAY[''web''::text, ''whatsapp''::text])))/true%'
          and a like '%reservations_source_drift79=%'
          and d = a
          and r = o
          and c52 = 'PASSOU' then 'PASSOU'
         else 'FALHOU erro=' || coalesce(e, '<null>') || ' antes=' || coalesce(a, '<null>') || ' depois=' || coalesce(d, '<null>')
              || ' restaurado=' || coalesce(r, '<null>') || ' orig=' || coalesce(o, '<null>') || ' ig52=' || c52 end);
end $$;
drop table if exists pg_temp.t_ig53;

-- ─── Resultado ───────────────────────────────────────────────────────────────
select ord, caso, veredito from t_res where ord between 7901 and 7999 order by ord;
select count(*) as total, count(*) filter (where veredito = 'PASSOU') as passou
  from t_res where ord between 7901 and 7999;   -- esperado: 77 e 77

do $$
declare v_total int; v_ok int;
begin
  select count(*), count(*) filter (where veredito = 'PASSOU') into v_total, v_ok
    from t_res where ord between 7901 and 7999;
  if v_total <> 77 or v_ok <> 77 then
    raise exception '79: esperado 77 e 77, obtido % e %', v_total, v_ok;
  end if;
end $$;
