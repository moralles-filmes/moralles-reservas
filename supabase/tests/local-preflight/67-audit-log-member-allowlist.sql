-- AUD-1..5 e CONTROLE-AUD-1 (ordinais 321-325 e 331): migration
-- 20261015233000_audit_log_member_read_allowlist.sql contra Postgres real.
--
-- BASE: a sequência do advisor (00 -> 01 -> 09a -> 106), banco próprio, e NÃO o
-- `fase6c`. Motivo: é a única que já tem `app_private.is_unit_member`,
-- `is_org_member` e `is_platform_admin` (a policy nova os qualifica), mais
-- `unit_members`, `platform_admins` e o `audit_log` verbatim de produção. O
-- `fase6c` não tem `app_private`. Os casos exercitam RLS DE VERDADE:
-- `set local role authenticated` + `request.jwt.claims`, como o 09/10.
--
-- O QUE ESTE ARQUIVO MONTA, porque a base não tem. `01-audit.sql` cria a tabela
-- e o trigger, mas nenhuma policy nem RLS (009/013 não são replay aqui). A
-- seção SETUP abaixo reproduz o estado de PRODUÇÃO antes da migration: RLS
-- ligada, `platform_admin_read_audit` e a `unit_member_read_audit` ANTIGA, com o
-- texto conferido em produção (pg_policies.qual) e os helpers qualificados em
-- `app_private`, que é como a 106 os deixa. Origem das policies: 009 (RLS) e 013
-- §8.15; a qualificação `app_private.` é a da 106.
--
-- ESTE ARQUIVO APLICA A MIGRATION (`\i`, duas vezes) no meio — roda a partir da
-- RAIZ DO REPO, como os demais comandos do README. Aplicar de dentro é o que
-- garante o RED antes do GREEN (a guarda mede o vazamento ANTES) e é o que
-- mede a idempotência (AUD-5). Re-executável: o SETUP recoloca a policy antiga.
-- Linhas de audit_log da fixture levam record_id 'aud67-*', e as contagens
-- filtram por ele (nada aqui depende de o trigger ter gravado outras linhas).

create table if not exists t_res (ord int primary key, caso text, veredito text);

do $$
begin
  if to_regprocedure('app_private.is_unit_member(uuid,uuid)') is null
     or to_regprocedure('app_private.is_org_member(uuid,uuid)') is null
     or to_regprocedure('app_private.is_platform_admin(uuid)') is null then
    raise exception '67 exige a base advisor (00 -> 01 -> 09a -> 106): helpers app_private ausentes.';
  end if;
end $$;

-- ─── SETUP: estado de produção ANTES da migration ────────────────────────────
alter table audit_log enable row level security;
grant select on audit_log to authenticated;

drop policy if exists "platform_admin_read_audit" on public.audit_log;
create policy "platform_admin_read_audit" on public.audit_log
  for select to authenticated
  using (app_private.is_platform_admin(auth.uid()));

drop policy if exists "unit_member_read_audit" on public.audit_log;
create policy "unit_member_read_audit" on public.audit_log
  for select to authenticated
  using (((unit_id is not null) and app_private.is_unit_member(auth.uid(), unit_id))
      or ((organization_id is not null) and app_private.is_org_member(auth.uid(), organization_id)));

-- ─── FIXTURES ────────────────────────────────────────────────────────────────
-- A: dono da org A / unidade A.  B: dono da org B.  PA: platform admin (sem
-- vínculo com nenhuma org — vê pela policy platform_admin_read_audit).
insert into auth.users (id, email) values
  ('a0d70000-0000-4000-8000-0000000000a1', 'aud67-a@example.test'),
  ('a0d70000-0000-4000-8000-0000000000b1', 'aud67-b@example.test'),
  ('a0d70000-0000-4000-8000-0000000000c1', 'aud67-pa@example.test')
on conflict (id) do nothing;

insert into organizations (id, name) values
  ('a0d70000-0000-4000-8000-00000000000a', 'aud67 org A'),
  ('a0d70000-0000-4000-8000-00000000000b', 'aud67 org B')
on conflict (id) do nothing;

insert into units (id, organization_id, name) values
  ('a0d70000-0000-4000-8000-0000000000aa', 'a0d70000-0000-4000-8000-00000000000a', 'aud67 unit A'),
  ('a0d70000-0000-4000-8000-0000000000bb', 'a0d70000-0000-4000-8000-00000000000b', 'aud67 unit B')
on conflict (id) do nothing;

insert into unit_members (user_id, unit_id, role) values
  ('a0d70000-0000-4000-8000-0000000000a1', 'a0d70000-0000-4000-8000-0000000000aa', 'owner'),
  ('a0d70000-0000-4000-8000-0000000000b1', 'a0d70000-0000-4000-8000-0000000000bb', 'owner')
on conflict (user_id, unit_id) do nothing;

insert into platform_admins (user_id) values ('a0d70000-0000-4000-8000-0000000000c1')
on conflict (user_id) do nothing;

delete from audit_log where record_id like 'aud67-%';

-- Org A: as seis tabelas auditadas em produção, cada uma com organization_id E
-- unit_id da A (o caso que a policy antiga liberava). Mais duas linhas das
-- tabelas permitidas, só com um dos dois ids, para provar que as DUAS pernas
-- (unidade e organização) continuam funcionando com a lista.
insert into audit_log (table_name, record_id, action, organization_id, unit_id)
select t, 'aud67-' || t, 'UPDATE',
       'a0d70000-0000-4000-8000-00000000000a'::uuid, 'a0d70000-0000-4000-8000-0000000000aa'::uuid
  from unnest(array['customers', 'reservations', 'unit_members',
                    'whatsapp_instances', 'whatsapp_implementations',
                    'organization_entitlement_overrides']) as t;
insert into audit_log (table_name, record_id, action, organization_id, unit_id) values
  ('customers',    'aud67-customers-org-only',    'INSERT', 'a0d70000-0000-4000-8000-00000000000a', null),
  ('reservations', 'aud67-reservations-unit-only', 'INSERT', null, 'a0d70000-0000-4000-8000-0000000000aa'),
  -- Org B: uma linha própria, para B provar que a policy não é um "nega tudo".
  ('customers',    'aud67-customers-orgB',        'INSERT', 'a0d70000-0000-4000-8000-00000000000b', 'a0d70000-0000-4000-8000-0000000000bb');

-- Conta linhas 'aud67-*' visíveis para o usuário, no papel authenticated.
-- p_tables nulo = todas; p_org filtra pelo dono da linha (nulo = qualquer).
create or replace function pg_temp.aud67_visible(p_user uuid, p_tables text[], p_org uuid)
returns int language plpgsql as $$
declare v_n int; v_units uuid[];
begin
  -- Unidades da org resolvidas ANTES de trocar de papel: authenticated nao le units.
  select coalesce(array_agg(id), '{}') into v_units from units where organization_id = p_org;
  perform set_config('request.jwt.claims', json_build_object('sub', p_user)::text, true);
  set local role authenticated;
  select count(*) into v_n from audit_log
   where record_id like 'aud67-%'
     and (p_tables is null or table_name = any (p_tables))
     and (p_org is null or organization_id = p_org
          or unit_id = any (v_units));
  reset role;
  return v_n;
end $$;

-- ─── RED: antes da migration a policy antiga VAZA ────────────────────────────
-- Sem isto, a suíte inteira poderia passar medindo uma fixture que o membro
-- nunca enxergou (JWT mal formado, grant ausente) — o GREEN sem RED.
do $$
declare v_leak int;
begin
  v_leak := pg_temp.aud67_visible('a0d70000-0000-4000-8000-0000000000a1',
    array['whatsapp_instances', 'whatsapp_implementations', 'organization_entitlement_overrides'], null);
  if v_leak <> 3 then
    raise exception '67: antes da migration o membro A deveria ver as 3 linhas de plataforma (policy antiga) e viu %. Fixture/grant/JWT nao exercita a policy.', v_leak;
  end if;
end $$;

-- ─── Migration: aplicada DUAS vezes (AUD-5 mede o resultado) ─────────────────
\i supabase/migrations/20261015233000_audit_log_member_read_allowlist.sql
\i supabase/migrations/20261015233000_audit_log_member_read_allowlist.sql

-- ─── AUD-1: membro vê customers, reservations e unit_members da própria org ──
do $$
declare v_c int; v_r int; v_m int;
  a constant uuid := 'a0d70000-0000-4000-8000-0000000000a1';
  org constant uuid := 'a0d70000-0000-4000-8000-00000000000a';
begin
  v_c := pg_temp.aud67_visible(a, array['customers'], org);
  v_r := pg_temp.aud67_visible(a, array['reservations'], org);
  v_m := pg_temp.aud67_visible(a, array['unit_members'], org);
  insert into t_res (ord, caso, veredito) values (321,
    'AUD-1 membro da org A le customers (2: org+unit e so org), reservations (2: org+unit e so unit) e unit_members (1)',
    case when v_c = 2 and v_r = 2 and v_m = 1 then 'PASSOU'
         else 'FALHOU customers=' || v_c || ' reservations=' || v_r || ' unit_members=' || v_m end)
  on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── AUD-2: o mesmo membro NÃO vê as três tabelas da plataforma ──────────────
do $$
declare v_p int; v_all int;
  a constant uuid := 'a0d70000-0000-4000-8000-0000000000a1';
begin
  v_p := pg_temp.aud67_visible(a,
    array['whatsapp_instances', 'whatsapp_implementations', 'organization_entitlement_overrides'], null);
  v_all := pg_temp.aud67_visible(a, null, null);
  insert into t_res (ord, caso, veredito) values (322,
    'AUD-2 membro da org A nao ve whatsapp_instances/whatsapp_implementations/organization_entitlement_overrides (0 linhas) mesmo com organization_id e unit_id dele',
    case when v_p = 0 and v_all = 5 then 'PASSOU'
         else 'FALHOU plataforma=' || v_p || ' total_visivel=' || v_all || ' (esperado 0 e 5)' end)
  on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── AUD-3: membro de outra org não vê nada da org A ─────────────────────────
-- Vê a própria linha (1): prova que a policy filtra por tenant, não nega tudo.
do $$
declare v_a int; v_all int;
  b constant uuid := 'a0d70000-0000-4000-8000-0000000000b1';
begin
  v_a := pg_temp.aud67_visible(b, null, 'a0d70000-0000-4000-8000-00000000000a');
  v_all := pg_temp.aud67_visible(b, null, null);
  insert into t_res (ord, caso, veredito) values (323,
    'AUD-3 membro da org B nao ve nada da org A e ve so a propria linha',
    case when v_a = 0 and v_all = 1 then 'PASSOU'
         else 'FALHOU orgA=' || v_a || ' total_visivel=' || v_all || ' (esperado 0 e 1)' end)
  on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── AUD-4: platform admin vê as seis tabelas da org A ───────────────────────
do $$
declare v_tabelas int; v_linhas int;
  pa constant uuid := 'a0d70000-0000-4000-8000-0000000000c1';
  org constant uuid := 'a0d70000-0000-4000-8000-00000000000a';
begin
  perform set_config('request.jwt.claims', json_build_object('sub', pa)::text, true);
  set local role authenticated;
  select count(distinct table_name), count(*) into v_tabelas, v_linhas from audit_log
   where record_id like 'aud67-%' and organization_id = org;
  reset role;
  insert into t_res (ord, caso, veredito) values (324,
    'AUD-4 platform admin le as seis tabelas da org A',
    case when v_tabelas = 6 and v_linhas = 7 then 'PASSOU'
         else 'FALHOU tabelas=' || v_tabelas || ' linhas=' || v_linhas || ' (esperado 6 e 7)' end)
  on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── AUD-5: migration aplicada duas vezes = uma policy, com a lista ──────────
do $$
declare v_n int; v_qual text; v_pa int;
begin
  select count(*), max(qual) into v_n, v_qual from pg_policies
   where schemaname = 'public' and tablename = 'audit_log' and policyname = 'unit_member_read_audit';
  select count(*) into v_pa from pg_policies
   where schemaname = 'public' and tablename = 'audit_log' and policyname = 'platform_admin_read_audit';
  insert into t_res (ord, caso, veredito) values (325,
    'AUD-5 migration aplicada duas vezes deixa uma unica unit_member_read_audit, com a lista e os helpers app_private; platform_admin_read_audit intacta',
    case when v_n = 1 and v_pa = 1
          and v_qual like '%customers%' and v_qual like '%reservations%' and v_qual like '%unit_members%'
          and v_qual not like '%whatsapp_%' and v_qual not like '%organization_entitlement_overrides%'
          and v_qual like '%app_private.is_unit_member%' and v_qual like '%app_private.is_org_member%'
         then 'PASSOU'
         else 'FALHOU n=' || v_n || ' pa=' || v_pa || ' qual=' || coalesce(v_qual, '<null>') end)
  on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;

-- ─── CONTROLE-AUD-1: com a policy ANTIGA o vazamento reaparece ───────────────
-- Controle positivo de AUD-2. Recria a policy do rollback num subbloco desfeito
-- por raise (o DDL de policy é transacional), mede o membro A vendo as 3 linhas
-- de plataforma, e depois do subbloco confere que a policy nova voltou e esconde.
do $$
declare v_leak int := -1; v_after int := -1; v_qual text;
  a constant uuid := 'a0d70000-0000-4000-8000-0000000000a1';
  plat constant text[] := array['whatsapp_instances', 'whatsapp_implementations', 'organization_entitlement_overrides'];
begin
  begin
    drop policy "unit_member_read_audit" on public.audit_log;
    create policy "unit_member_read_audit" on public.audit_log for select to authenticated
      using (((unit_id is not null) and app_private.is_unit_member(auth.uid(), unit_id))
          or ((organization_id is not null) and app_private.is_org_member(auth.uid(), organization_id)));
    v_leak := pg_temp.aud67_visible(a, plat, null);
    raise exception 'desfazer controle';
  exception when raise_exception then null;
  end;
  v_after := pg_temp.aud67_visible(a, plat, null);
  select qual into v_qual from pg_policies
   where schemaname = 'public' and tablename = 'audit_log' and policyname = 'unit_member_read_audit';
  insert into t_res (ord, caso, veredito) values (331,
    'CONTROLE-AUD-1 com a policy antiga o membro ve as 3 linhas de plataforma; desfeito, a policy nova volta a esconde-las',
    case when v_leak = 3 and v_after = 0 and v_qual like '%unit_members%' then 'PASSOU'
         else 'FALHOU com_antiga=' || v_leak || ' depois=' || v_after || ' (esperado 3 e 0)' end)
  on conflict (ord) do update set caso = excluded.caso, veredito = excluded.veredito;
end $$;
