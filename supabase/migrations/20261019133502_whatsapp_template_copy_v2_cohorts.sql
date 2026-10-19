-- Versioned candidate catalog. Installing this file grants no v2 submission.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- Both catalogs have nine immutable names. The zero-argument function remains
-- the version-1 authority consumed by every existing grant and worker.
alter table app_private.whatsapp_template_approved_submissions
  drop constraint if exists whatsapp_template_approved_submissions_version_check;
alter table app_private.whatsapp_template_approved_submissions
  add constraint whatsapp_template_approved_submissions_version_check check (version in (1,2));
alter table app_private.whatsapp_template_approved_submissions
  drop constraint if exists whatsapp_template_approved_submissions_logical_id_check;
alter table app_private.whatsapp_template_approved_submissions
  add constraint whatsapp_template_approved_submissions_logical_id_check check (
    (version=1 and logical_id in ('res_confirmacao_v1','res_confirmacao_desconto_v1','res_lembrete_dia_v1',
      'res_pesquisa_reserva_v1','fila_entrada_v1','fila_feedback_v1','mkt_voucher_programado_v1',
      'fila_mesa_pronta_v1','res_cancelada_v1'))
    or (version=2 and logical_id in ('res_confirmacao_v2','res_confirmacao_desconto_v2','res_lembrete_dia_v2',
      'res_pesquisa_reserva_v2','fila_entrada_v2','fila_feedback_v2','mkt_voucher_programado_v2',
      'fila_mesa_pronta_v2','res_cancelada_v2'))
  );

create or replace function app_private.whatsapp_template_approved_catalog_digest(p_version integer)
returns text language sql stable security definer set search_path='' as $$
  select case when p_version in (1,2) and count(*)=9 then
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(string_agg(
      logical_id || ':' || version::text || ':' || language || ':' || requested_category || ':' || desired_hash || ':' || payload_hash,
      E'\n' order by logical_id), 'UTF8')), 'hex') else null end
  from app_private.whatsapp_template_approved_submissions where version=p_version
$$;
revoke all on function app_private.whatsapp_template_approved_catalog_digest(integer)
  from public,anon,authenticated,service_role;

create or replace function app_private.whatsapp_template_approved_catalog_digest()
returns text language sql stable security definer set search_path='' as $$
  select app_private.whatsapp_template_approved_catalog_digest(1)
$$;
revoke all on function app_private.whatsapp_template_approved_catalog_digest()
  from public,anon,authenticated,service_role;

do $$ begin
  if app_private.whatsapp_template_approved_catalog_digest() is distinct from
    'a0fb939e3b2023c8f7c49a7f6fe77049fb312f6d274cf67f23e15f3906298965' then
    raise exception 'template_v1_digest_changed' using errcode='23514';
  end if;
end $$;

insert into app_private.whatsapp_template_approved_submissions
  (logical_id,version,language,requested_category,desired_hash,payload_hash) values
  ('res_confirmacao_v2',2,'pt_BR','UTILITY','2c6c958fea3540a686082cfcfcdb97c07d50f14eda492110998326582681a8cf','d8dd3a0de8cf5c1994f801a621a2927cdbe0e95a8b683bc84a3a1edbfbd961b2'),
  ('res_confirmacao_desconto_v2',2,'pt_BR','UTILITY','849e18669840b4d768635728943a8ab283169f027be42849551c4ece2dcbc8cd','7a5feea79c1677fbf32dcd63a0e6401cd82db1680812f8b4fab0456c90c130c9'),
  ('res_lembrete_dia_v2',2,'pt_BR','UTILITY','a5f46ba2e3e3befe852ae7168225d2117070d9c19ef20d57f99785a4d13b7e3b','93d19b8747d7dbbd3af06e6a564a6d3dd9fbac2e2d97b2b77e72f8cd35c5e6f6'),
  ('res_pesquisa_reserva_v2',2,'pt_BR','UTILITY','5192c9331f94743273dfe12082d84b81dfdae72377989bb139cb9bb5c030cbd6','2823e01a31bcc293aae6735e1ed00f7e50a3305ad9cae0d18af667247d5aa665'),
  ('fila_entrada_v2',2,'pt_BR','UTILITY','02280d702f9e7d510cf934be027c9e8c66241829df9d64e7253a48d93b8dd41f','660ab4655eebf4486a0511b51ddc286b6b1266692c5848def12b67e732c1746c'),
  ('fila_feedback_v2',2,'pt_BR','MARKETING','3a14c44bf14122506f6fead845bda012119ec3b59866da3cd7766de1534fff91','cc0613ede57717e6df2db3e784280622d19139a2c74233d2861aeeb9409fff2e'),
  ('mkt_voucher_programado_v2',2,'pt_BR','MARKETING','6c712bc43b0cb51192bec4392983c5b5f20ff31cb5b5dced862a1131b5b6de3b','d6954b9a606871a06a9b8d31b8691021f42db1dd3e44a6b0d825dc9808f7a162'),
  ('fila_mesa_pronta_v2',2,'pt_BR','UTILITY','5893c535677f123d799cbcfcd5815456f1838982745bc023cf166d4352870dd7','db6bf21efdb8aced77486ec4ae7cc0672ea767130ad25ca9c73e7c0e6e9d4c25'),
  ('res_cancelada_v2',2,'pt_BR','UTILITY','3ade2fc5eb5353fcb2de7da65b71b5e76cce2ea88eaad207aaf42cd6edf51423','1aeb3f759c31c89b7639051048a39e79de00d47e2988caa73c6e3d28dcf6f9be')
on conflict(logical_id) do nothing;

-- A content/example drift in either coorte aborts the whole migration.
do $$ begin
  if app_private.whatsapp_template_approved_catalog_digest(1) is distinct from
      'a0fb939e3b2023c8f7c49a7f6fe77049fb312f6d274cf67f23e15f3906298965'
    or app_private.whatsapp_template_approved_catalog_digest(2) is distinct from
      '74512848434a9be4b89916aea5b047f15ddcffc801dba9cb23e41f6f73dcad55' then
    raise exception 'template_v2_approved_catalog_incomplete' using errcode='23514';
  end if;
end $$;

alter table public.whatsapp_remote_templates drop constraint if exists whatsapp_remote_templates_logical_id_check;
alter table public.whatsapp_remote_templates add constraint whatsapp_remote_templates_logical_id_check
  check(logical_id in('res_confirmacao_v1','res_confirmacao_desconto_v1','res_lembrete_dia_v1',
    'res_pesquisa_reserva_v1','fila_entrada_v1','fila_feedback_v1','mkt_voucher_programado_v1',
    'fila_mesa_pronta_v1','res_cancelada_v1','res_confirmacao_v2','res_confirmacao_desconto_v2',
    'res_lembrete_dia_v2','res_pesquisa_reserva_v2','fila_entrada_v2','fila_feedback_v2',
    'mkt_voucher_programado_v2','fila_mesa_pronta_v2','res_cancelada_v2'));
alter table public.whatsapp_remote_templates drop constraint if exists whatsapp_remote_templates_version_name_check;
alter table public.whatsapp_remote_templates add constraint whatsapp_remote_templates_version_name_check
  check((version=1 and logical_id like '%\_v1' escape '\') or (version=2 and logical_id like '%\_v2' escape '\'));

-- Storage accepts v2 pins, but the existing enqueue/post functions still
-- select v1 only. No v2 dispatch is unlocked by this CHECK expansion.
alter table public.whatsapp_automation_jobs drop constraint if exists whatsapp_automation_pin_tuple_check;
alter table public.whatsapp_automation_jobs add constraint whatsapp_automation_pin_tuple_check check ((
  (initial_credential_revision is null or initial_credential_revision>=0)
  and (initial_catalog_key is null or initial_catalog_key in(
    'res_confirmacao_v1','res_confirmacao_desconto_v1','res_lembrete_dia_v1','res_pesquisa_reserva_v1',
    'fila_entrada_v1','fila_feedback_v1','mkt_voucher_programado_v1','fila_mesa_pronta_v1','res_cancelada_v1',
    'res_confirmacao_v2','res_confirmacao_desconto_v2','res_lembrete_dia_v2','res_pesquisa_reserva_v2',
    'fila_entrada_v2','fila_feedback_v2','mkt_voucher_programado_v2','fila_mesa_pronta_v2','res_cancelada_v2'))
  and (
    (pin_phase='bound' and channel_id is not null and provider is not null and binding_id is not null
      and binding_generation is not null and binding_generation>0 and transport is not null and (
        (transport='template' and provider in('official','datafy') and account_id is not null
          and remote_template_id is not null and template_version is not null and sync_epoch is not null)
        or (transport='text' and provider in('zapi','waha','uazapi')
          and num_nonnulls(account_id,remote_template_id,template_version,sync_epoch)=0)))
    or (pin_phase='preconfiguration' and initial_catalog_key is not null and remote_template_id is null
      and template_version is null and sync_epoch is null and (
        (num_nonnulls(channel_id,provider,transport,binding_id,binding_generation,account_id,
          initial_credential_revision)=0)
        or (channel_id is not null and provider is not null and transport is not null
          and initial_credential_revision is not null and binding_id is null
          and binding_generation is null and account_id is null and (
            (provider in('official','datafy') and transport='template')
            or (provider in('zapi','waha','uazapi') and transport='text')))
        or (channel_id is not null and provider in('official','datafy') and transport='template'
          and binding_id is not null and binding_generation is not null and binding_generation>0
          and account_id is not null and initial_credential_revision is not null))))
) is true);

-- V2 is a separate, initially disabled rollout. Neither v1 flags nor v1
-- submission grants can enable this cohort. Rows are retained as history.
create table if not exists app_private.whatsapp_template_v2_policy (
  id integer primary key check(id=1),
  enabled boolean not null default false,
  revision bigint not null default 0 check(revision>=0),
  catalog_digest text not null check(catalog_digest ~ '^[a-f0-9]{64}$'),
  actor_id uuid references auth.users(id) on delete restrict,
  enabled_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  check(not enabled or (actor_id is not null and enabled_at is not null))
);
alter table app_private.whatsapp_template_v2_policy enable row level security;
alter table app_private.whatsapp_template_v2_policy force row level security;
revoke all on app_private.whatsapp_template_v2_policy from public,anon,authenticated,service_role;
insert into app_private.whatsapp_template_v2_policy(id,enabled,revision,catalog_digest)
values(1,false,0,'74512848434a9be4b89916aea5b047f15ddcffc801dba9cb23e41f6f73dcad55')
on conflict(id) do nothing;

create table if not exists app_private.whatsapp_template_v2_policy_audit (
  revision bigint primary key,
  enabled boolean not null,
  catalog_digest text not null,
  actor_id uuid not null references auth.users(id) on delete restrict,
  changed_at timestamptz not null default clock_timestamp()
);
alter table app_private.whatsapp_template_v2_policy_audit enable row level security;
alter table app_private.whatsapp_template_v2_policy_audit force row level security;
revoke all on app_private.whatsapp_template_v2_policy_audit from public,anon,authenticated,service_role;

create table if not exists app_private.whatsapp_template_v2_enrollments (
  onboarding_id uuid primary key references public.whatsapp_datafy_onboardings(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  unit_id uuid not null references public.units(id) on delete cascade,
  channel_id uuid not null unique,
  policy_revision bigint not null check(policy_revision>=0),
  catalog_digest text not null check(catalog_digest ~ '^[a-f0-9]{64}$'),
  origin text not null default 'auto' check(origin in('auto','manual')),
  state text not null default 'pending' check(state in('pending','discovering','ready','needs_review')),
  reason_code text check(reason_code in('connection_pending','health_stale','binding_pending',
    'provider_unavailable','policy_changed','manual_review')),
  attempt_count integer not null default 0 check(attempt_count between 0 and 20),
  next_attempt_at timestamptz not null default clock_timestamp(),
  binding_id uuid,
  binding_generation bigint,
  credential_revision bigint,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  excluded_at timestamptz,
  excluded_by uuid references auth.users(id) on delete restrict,
  check((excluded_at is null)=(excluded_by is null)),
  check((binding_id is null)=(binding_generation is null)),
  check((origin='auto' and policy_revision>0) or (origin='manual' and policy_revision=0))
);
alter table app_private.whatsapp_template_v2_enrollments enable row level security;
alter table app_private.whatsapp_template_v2_enrollments force row level security;
revoke all on app_private.whatsapp_template_v2_enrollments from public,anon,authenticated,service_role;
create index if not exists whatsapp_template_v2_enrollments_due_idx
  on app_private.whatsapp_template_v2_enrollments(next_attempt_at,onboarding_id)
  where origin='auto' and excluded_at is null and state in('pending','discovering','ready');

-- A shared WABA has one immutable catalog cohort. The binding and credential
-- pins on each grant below are evaluated again at every POST boundary.
create table if not exists app_private.whatsapp_template_account_cohorts (
  account_id uuid primary key references public.whatsapp_template_accounts(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  version integer not null check(version=2),
  catalog_digest text not null check(catalog_digest ~ '^[a-f0-9]{64}$'),
  policy_revision bigint not null check(policy_revision>=0),
  origin text not null default 'auto' check(origin in('auto','manual')),
  first_binding_id uuid not null,
  actor_id uuid not null references auth.users(id) on delete restrict,
  selected_at timestamptz not null default clock_timestamp(),
  check((origin='auto' and policy_revision>0) or (origin='manual' and policy_revision=0))
);
alter table app_private.whatsapp_template_account_cohorts enable row level security;
alter table app_private.whatsapp_template_account_cohorts force row level security;
revoke all on app_private.whatsapp_template_account_cohorts from public,anon,authenticated,service_role;

create table if not exists app_private.whatsapp_template_v2_grants (
  id uuid primary key default gen_random_uuid(),
  onboarding_id uuid not null references public.whatsapp_datafy_onboardings(id) on delete restrict,
  binding_id uuid not null,
  channel_id uuid not null,
  unit_id uuid not null,
  account_id uuid not null references public.whatsapp_template_accounts(id) on delete cascade,
  organization_id uuid not null,
  binding_generation bigint not null check(binding_generation>0),
  credential_revision bigint not null check(credential_revision>=0),
  catalog_digest text not null check(catalog_digest ~ '^[a-f0-9]{64}$'),
  policy_revision bigint not null check(policy_revision>=0),
  origin text not null default 'auto' check(origin in('auto','manual')),
  actor_id uuid not null references auth.users(id) on delete restrict,
  granted_at timestamptz not null default clock_timestamp(),
  revoked_at timestamptz,
  check(revoked_at is null or revoked_at>=granted_at),
  check((origin='auto' and policy_revision>0) or (origin='manual' and policy_revision=0))
);
alter table app_private.whatsapp_template_v2_grants enable row level security;
alter table app_private.whatsapp_template_v2_grants force row level security;
create unique index if not exists whatsapp_template_v2_grants_one_active_idx
  on app_private.whatsapp_template_v2_grants(binding_id) where revoked_at is null;
create index if not exists whatsapp_template_v2_grants_account_idx
  on app_private.whatsapp_template_v2_grants(account_id,granted_at desc);
revoke all on app_private.whatsapp_template_v2_grants from public,anon,authenticated,service_role;

create or replace function public.get_whatsapp_template_v2_policy()
returns jsonb language plpgsql security definer set search_path='' as $$
declare p app_private.whatsapp_template_v2_policy%rowtype;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or not app_private.is_platform_admin(auth.uid()) then
    raise exception 'template_v2_policy_forbidden' using errcode='42501';
  end if;
  select * into p from app_private.whatsapp_template_v2_policy where id=1;
  if not found then raise exception 'template_v2_policy_unavailable' using errcode='PT503'; end if;
  return jsonb_build_object('version',2,'enabled',p.enabled,'revision',p.revision,
    'catalog_digest',p.catalog_digest,'updated_at',p.updated_at);
end $$;
revoke all on function public.get_whatsapp_template_v2_policy() from public,anon,authenticated,service_role;
grant execute on function public.get_whatsapp_template_v2_policy() to authenticated;

create or replace function public.configure_whatsapp_template_v2_policy(p_enabled boolean,p_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p app_private.whatsapp_template_v2_policy%rowtype; v_digest text;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or not app_private.is_platform_admin(auth.uid()) then
    raise exception 'template_v2_policy_forbidden' using errcode='42501';
  end if;
  if p_enabled is null or p_expected_revision is null then
    raise exception 'template_v2_policy_invalid' using errcode='22023';
  end if;
  select * into p from app_private.whatsapp_template_v2_policy where id=1 for update;
  if not found then raise exception 'template_v2_policy_unavailable' using errcode='PT503'; end if;
  if p.revision is distinct from p_expected_revision then
    raise exception 'template_v2_policy_changed' using errcode='PT409';
  end if;
  if p.enabled is distinct from p_enabled then
    v_digest:=app_private.whatsapp_template_approved_catalog_digest(2);
    if p_enabled and (v_digest is distinct from
      '74512848434a9be4b89916aea5b047f15ddcffc801dba9cb23e41f6f73dcad55'
      or not exists(select from public.platform_flags where key='whatsapp_template_catalog' and value='true'::jsonb)) then
      raise exception 'template_v2_catalog_unavailable' using errcode='PT503';
    end if;
    update app_private.whatsapp_template_v2_policy set enabled=p_enabled,revision=p.revision+1,
      catalog_digest=coalesce(v_digest,p.catalog_digest),actor_id=auth.uid(),
      enabled_at=case when p_enabled then clock_timestamp() else null end,
      updated_at=clock_timestamp() where id=1 returning * into p;
    if not p_enabled then
      update app_private.whatsapp_template_v2_grants set revoked_at=clock_timestamp()
        where origin='auto' and revoked_at is null;
    end if;
    insert into app_private.whatsapp_template_v2_policy_audit(revision,enabled,catalog_digest,actor_id)
      values(p.revision,p.enabled,p.catalog_digest,p.actor_id);
  end if;
  return jsonb_build_object('version',2,'enabled',p.enabled,'revision',p.revision,
    'catalog_digest',p.catalog_digest,'updated_at',p.updated_at);
end $$;
revoke all on function public.configure_whatsapp_template_v2_policy(boolean,bigint)
  from public,anon,authenticated,service_role;
grant execute on function public.configure_whatsapp_template_v2_policy(boolean,bigint) to authenticated;

-- Onboarding is pinned before the worker sees a channel. A bad/partial v2
-- policy never falls back to v1 while the v2 switch says ON.
create or replace function app_private.enroll_new_datafy_template_onboarding()
returns trigger language plpgsql security definer set search_path='' as $$
declare p1 app_private.whatsapp_template_auto_policy%rowtype;
  p2 app_private.whatsapp_template_v2_policy%rowtype;
begin
  select * into p2 from app_private.whatsapp_template_v2_policy where id=1 for share;
  if p2.enabled then
    if p2.actor_id is not null and p2.catalog_digest is not distinct from
        app_private.whatsapp_template_approved_catalog_digest(2) then
      insert into app_private.whatsapp_template_v2_enrollments
        (onboarding_id,organization_id,unit_id,channel_id,policy_revision,catalog_digest)
      values(new.id,new.organization_id,new.unit_id,new.reserved_channel_id,p2.revision,p2.catalog_digest);
    end if;
    return new;
  end if;
  select * into p1 from app_private.whatsapp_template_auto_policy where id=1 for share;
  if p1.enabled and p1.actor_id is not null
    and p1.catalog_digest=app_private.whatsapp_template_approved_catalog_digest() then
    insert into app_private.whatsapp_template_auto_enrollments
      (onboarding_id,organization_id,unit_id,channel_id,policy_revision,catalog_digest)
    values(new.id,new.organization_id,new.unit_id,new.reserved_channel_id,p1.revision,p1.catalog_digest);
  end if;
  return new;
end $$;
revoke all on function app_private.enroll_new_datafy_template_onboarding()
  from public,anon,authenticated,service_role;

-- Preserve the v1 gate's exact implementation under a private name. Existing
-- 4-argument worker RPCs resolve this wrapper at runtime and now fail closed
-- if the account was deliberately selected for v2.
do $$ begin
  if to_regprocedure('app_private.whatsapp_template_submission_gate_v1_core(uuid,uuid,bigint,text)') is null then
    alter function app_private.whatsapp_template_submission_gate(uuid,uuid,bigint,text)
      rename to whatsapp_template_submission_gate_v1_core;
  end if;
end $$;
revoke all on function app_private.whatsapp_template_submission_gate_v1_core(uuid,uuid,bigint,text)
  from public,anon,authenticated,service_role;
create or replace function app_private.whatsapp_template_submission_gate(
  p_job_id uuid,p_fence uuid,p_generation bigint,p_payload_hash text)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  if exists(select from public.whatsapp_template_jobs j
    join app_private.whatsapp_template_account_cohorts c on c.account_id=j.account_id
    where j.id=p_job_id) then return false; end if;
  return app_private.whatsapp_template_submission_gate_v1_core(
    p_job_id,p_fence,p_generation,p_payload_hash);
end $$;
revoke all on function app_private.whatsapp_template_submission_gate(uuid,uuid,bigint,text)
  from public,anon,authenticated,service_role;

-- The service receives only the binding's verified cohort, never a version
-- supplied by a browser. A v2 enrollment awaiting authorization returns
-- pending; an established v1 account stays v1 and is never silently upgraded.
create or replace function public.get_whatsapp_template_catalog_selection(p_binding_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.whatsapp_template_bindings%rowtype;
  a public.whatsapp_template_accounts%rowtype;
  c app_private.whatsapp_template_account_cohorts%rowtype;
  p app_private.whatsapp_template_v2_policy%rowtype;
  g2 app_private.whatsapp_template_v2_grants%rowtype;
  g1 app_private.whatsapp_template_submission_grants%rowtype;
  v_v1_history boolean;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'template_cohort_forbidden' using errcode='42501';
  end if;
  select * into b from public.whatsapp_template_bindings where id=p_binding_id;
  if not found or b.account_id is null then return null; end if;
  select * into a from public.whatsapp_template_accounts where id=b.account_id;
  if not found or not exists(select from public.units u
    where u.id=b.unit_id and u.organization_id=a.organization_id) then return null; end if;
  select * into c from app_private.whatsapp_template_account_cohorts where account_id=a.id;
  if found then
    select * into p from app_private.whatsapp_template_v2_policy where id=1;
    select * into g2 from app_private.whatsapp_template_v2_grants
      where binding_id=b.id and account_id=a.id and revoked_at is null;
    if (c.origin='manual' or (p.enabled and
        (p.revision,p.catalog_digest)=(c.policy_revision,c.catalog_digest)))
      and c.catalog_digest=app_private.whatsapp_template_approved_catalog_digest(2)
      and g2.id is not null and (g2.organization_id,g2.unit_id,g2.channel_id,g2.binding_generation,
          g2.credential_revision,g2.policy_revision,g2.catalog_digest,g2.origin)
        =(a.organization_id,b.unit_id,b.channel_id,b.generation,b.channel_credential_revision,
          c.policy_revision,c.catalog_digest,c.origin)
      and (c.origin='manual' or g2.actor_id=c.actor_id) then
      return jsonb_build_object('state','ready','version',2,'digest',c.catalog_digest,
        'grant_binding_id',b.id,'generation',b.generation,'credential_revision',b.channel_credential_revision);
    end if;
    return jsonb_build_object('state','paused','version',null);
  end if;
  select exists(select from public.whatsapp_remote_templates t where t.account_id=a.id and t.version=1)
    or exists(select from public.whatsapp_template_jobs j where j.account_id=a.id and j.target_key like '%\_v1' escape '\')
    or exists(select from app_private.whatsapp_template_submission_grants g
      where g.account_id=a.id) into v_v1_history;
  select * into p from app_private.whatsapp_template_v2_policy where id=1;
  if not v_v1_history and (exists(select from app_private.whatsapp_template_v2_enrollments e
      join public.whatsapp_template_bindings eb on eb.channel_id=e.channel_id
      where eb.account_id=a.id and e.excluded_at is null)
    or (p.enabled and a.created_at>=p.enabled_at and exists(
      select from public.whatsapp_datafy_onboardings o
      where o.reserved_channel_id=b.channel_id and o.unit_id=b.unit_id
        and o.organization_id=a.organization_id and o.created_at>=p.enabled_at))) then
    return jsonb_build_object('state','pending','version',null);
  end if;
  select * into g1 from app_private.whatsapp_template_submission_grants
    where binding_id=b.id and revoked_at is null;
  return jsonb_build_object('state','v1','version',1,
    'digest',app_private.whatsapp_template_approved_catalog_digest(),
    'grant_binding_id',case when g1.id is not null then b.id else null end,
    'generation',b.generation,'credential_revision',b.channel_credential_revision);
end $$;
revoke all on function public.get_whatsapp_template_catalog_selection(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.get_whatsapp_template_catalog_selection(uuid) to service_role;

create or replace function public.get_whatsapp_template_v2_enrollment(p_unit_id uuid,p_channel_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare e app_private.whatsapp_template_v2_enrollments%rowtype;
  p app_private.whatsapp_template_v2_policy%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'template_v2_enrollment_forbidden' using errcode='42501';
  end if;
  select * into e from app_private.whatsapp_template_v2_enrollments
    where unit_id=p_unit_id and channel_id=p_channel_id;
  if not found then
    select * into p from app_private.whatsapp_template_v2_policy where id=1;
    if p.enabled and exists(select from public.whatsapp_datafy_onboardings o
      where o.unit_id=p_unit_id and o.reserved_channel_id=p_channel_id
        and o.created_at>=p.enabled_at) then
      return jsonb_build_object('version',2,'state','held');
    end if;
    return null;
  end if;
  if not exists(select from public.whatsapp_datafy_onboardings o where o.id=e.onboarding_id
    and (o.organization_id,o.unit_id,o.reserved_channel_id)
      =(e.organization_id,e.unit_id,e.channel_id)) then return null; end if;
  select * into p from app_private.whatsapp_template_v2_policy where id=1;
  return jsonb_build_object('version',2,'state',case
    when e.excluded_at is not null then 'excluded'
    when e.origin='manual' then e.state
    when not p.enabled then 'disabled'
    when (e.policy_revision,e.catalog_digest) is distinct from (p.revision,p.catalog_digest)
      or p.catalog_digest is distinct from app_private.whatsapp_template_approved_catalog_digest(2) then 'stale'
    else e.state end,'digest',e.catalog_digest,'policy_revision',e.policy_revision,
    'origin',e.origin,'binding_id',e.binding_id);
end $$;
revoke all on function public.get_whatsapp_template_v2_enrollment(uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.get_whatsapp_template_v2_enrollment(uuid,uuid) to service_role;

create or replace function public.get_whatsapp_template_v2_preparation(p_unit_id uuid,p_channel_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare e app_private.whatsapp_template_v2_enrollments%rowtype;
  p app_private.whatsapp_template_v2_policy%rowtype;
  v_ready_valid boolean:=true;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'template_v2_preparation_forbidden' using errcode='42501'; end if;
  if p_unit_id is null or p_channel_id is null then return null; end if;
  select * into e from app_private.whatsapp_template_v2_enrollments
    where channel_id=p_channel_id and unit_id=p_unit_id;
  if not found then return null; end if;
  if not exists(select from public.whatsapp_datafy_onboardings o
      where o.id=e.onboarding_id and
        (o.organization_id,o.unit_id,o.reserved_channel_id)
          =(e.organization_id,e.unit_id,e.channel_id)) then return null; end if;
  select * into p from app_private.whatsapp_template_v2_policy where id=1;
  if e.state='ready' then
    select exists(select from public.whatsapp_template_bindings b
      join public.whatsapp_channels c on c.id=b.channel_id
      join public.whatsapp_template_accounts a on a.id=b.account_id
      join app_private.whatsapp_template_account_cohorts cohort on cohort.account_id=a.id
      join app_private.whatsapp_template_v2_grants g on g.binding_id=b.id and g.revoked_at is null
      where b.id=e.binding_id and (b.channel_id,b.unit_id,b.generation,b.channel_credential_revision)
        =(e.channel_id,e.unit_id,e.binding_generation,e.credential_revision)
        and a.organization_id=e.organization_id and c.template_credential_revision=e.credential_revision
        and (cohort.origin,cohort.catalog_digest,cohort.policy_revision)
          =(e.origin,e.catalog_digest,e.policy_revision)
        and (g.account_id,g.channel_id,g.unit_id,g.binding_generation,g.credential_revision,
          g.catalog_digest,g.policy_revision,g.origin)
          =(a.id,b.channel_id,b.unit_id,b.generation,b.channel_credential_revision,
            e.catalog_digest,e.policy_revision,e.origin)
    ) into v_ready_valid;
  end if;
  return jsonb_build_object(
    'version',2,'origin',e.origin,
    'enrollment',case when e.excluded_at is not null then 'excluded'
      when e.origin='manual' then 'eligible'
      when not p.enabled then 'disabled'
      when (e.policy_revision,e.catalog_digest) is distinct from (p.revision,p.catalog_digest)
        then 'stale' else 'eligible' end,
    'onboarding_id',e.onboarding_id,'organization_id',e.organization_id,
    'onboarding_state',(select o.state from public.whatsapp_datafy_onboardings o where o.id=e.onboarding_id),
    'state',case when e.state='ready' and not v_ready_valid then 'needs_review' else e.state end,
    'reason_code',case when e.state='ready' and not v_ready_valid then 'manual_review' else e.reason_code end,
    'updated_at',e.updated_at,'next_attempt_at',e.next_attempt_at,
    'policy_revision',e.policy_revision,'catalog_digest',e.catalog_digest,
    'binding_id',e.binding_id);
end $$;
revoke all on function public.get_whatsapp_template_v2_preparation(uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.get_whatsapp_template_v2_preparation(uuid,uuid) to service_role;

create or replace function public.claim_due_whatsapp_template_v2_preparations(p_limit integer)
returns table(onboarding_id uuid,channel_id uuid,unit_id uuid,organization_id uuid,
  credential_revision bigint,version integer)
language plpgsql security definer set search_path='' as $$
declare p app_private.whatsapp_template_v2_policy%rowtype;
  v_digest text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'template_v2_claim_forbidden' using errcode='42501'; end if;
  if p_limit is null or p_limit<1 or p_limit>20 then
    raise exception 'template_v2_limit_invalid' using errcode='22023'; end if;
  select * into p from app_private.whatsapp_template_v2_policy where id=1 for share;
  v_digest:=app_private.whatsapp_template_approved_catalog_digest(2);
  if not found or v_digest is distinct from
      '74512848434a9be4b89916aea5b047f15ddcffc801dba9cb23e41f6f73dcad55'
    or not exists(select from public.platform_flags
      where key='whatsapp_template_catalog' and value='true'::jsonb) then return; end if;
  return query
  with due as (
    select e.onboarding_id from app_private.whatsapp_template_v2_enrollments e
    join public.whatsapp_datafy_onboardings o on o.id=e.onboarding_id
    join public.whatsapp_channels c on c.id=e.channel_id
    where ((e.origin='auto' and p.enabled and e.policy_revision=p.revision
          and e.catalog_digest=p.catalog_digest and p.catalog_digest=v_digest)
        or (e.origin='manual' and e.policy_revision=0 and e.catalog_digest=v_digest
          and e.state='ready'))
      and e.excluded_at is null and e.state in('pending','discovering','ready')
      and e.next_attempt_at<=clock_timestamp() and o.state='completed'
      and (o.organization_id,o.unit_id,o.reserved_channel_id)
        =(e.organization_id,e.unit_id,e.channel_id)
      and c.unit_id=e.unit_id and c.provider='datafy'
      and (c.status='connected' or
        (c.is_active is distinct from true and c.status in('provider_error','disconnected')))
      and (e.state<>'ready' or (c.is_active is distinct from true
        and (e.reason_code is not null or c.status<>'connected' or c.last_health_check_at is null
          or c.last_health_check_at<=clock_timestamp()-interval '3 minutes')
        and c.template_credential_revision=e.credential_revision
        and exists(select from public.whatsapp_template_bindings b
          join public.whatsapp_template_accounts a on a.id=b.account_id
          join app_private.whatsapp_template_account_cohorts cohort on cohort.account_id=a.id
          join app_private.whatsapp_template_v2_grants g
            on g.binding_id=b.id and g.revoked_at is null
          where b.id=e.binding_id and b.channel_id=e.channel_id and b.unit_id=e.unit_id
            and b.provider='datafy' and b.verified_at is not null
            and b.generation=e.binding_generation
            and b.channel_credential_revision=e.credential_revision
            and a.organization_id=e.organization_id
            and (cohort.organization_id,cohort.version,cohort.origin,
              cohort.policy_revision,cohort.catalog_digest)
              =(a.organization_id,2,e.origin,e.policy_revision,e.catalog_digest)
            and (g.account_id,g.channel_id,g.unit_id,g.binding_generation,
              g.credential_revision,g.policy_revision,g.catalog_digest,g.origin,
              g.organization_id)
              =(b.account_id,b.channel_id,b.unit_id,b.generation,
                b.channel_credential_revision,e.policy_revision,e.catalog_digest,e.origin,
                a.organization_id)
            and (e.origin='manual' or (g.actor_id=cohort.actor_id
              and cohort.actor_id=p.actor_id)))))
    order by e.next_attempt_at,e.onboarding_id limit p_limit for update of e skip locked
  ), changed as (
    update app_private.whatsapp_template_v2_enrollments e
      set state=case when e.state='ready' then 'ready'
        when e.attempt_count>=20 then 'needs_review' else 'discovering' end,
      reason_code=case when e.state='ready' then e.reason_code
        when e.attempt_count>=20 then 'manual_review' else null end,
      attempt_count=case when e.state='ready' then e.attempt_count else least(20,e.attempt_count+1) end,
      next_attempt_at=case when e.state<>'ready' and e.attempt_count>=20
        then 'infinity'::timestamptz else clock_timestamp()+interval '2 minutes' end,
      updated_at=clock_timestamp()
    from due where e.onboarding_id=due.onboarding_id
    returning e.onboarding_id,e.channel_id,e.unit_id,e.organization_id,e.state
  )
  select changed.onboarding_id,changed.channel_id,changed.unit_id,changed.organization_id,
    c.template_credential_revision,2
  from changed join public.whatsapp_channels c on c.id=changed.channel_id
  where changed.state in('discovering','ready');
end $$;
revoke all on function public.claim_due_whatsapp_template_v2_preparations(integer)
  from public,anon,authenticated,service_role;
grant execute on function public.claim_due_whatsapp_template_v2_preparations(integer) to service_role;

create or replace function public.mark_whatsapp_template_v2_preparation(
  p_onboarding_id uuid,p_channel_id uuid,p_state text,p_reason_code text)
returns boolean language plpgsql security definer set search_path='' as $$
declare p app_private.whatsapp_template_v2_policy%rowtype;
  e app_private.whatsapp_template_v2_enrollments%rowtype;
  v_delay integer;
  v_digest text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'template_v2_mark_forbidden' using errcode='42501'; end if;
  if p_state is null or p_state not in('pending','discovering','ready','needs_review')
    or (p_reason_code is not null and p_reason_code not in('connection_pending','health_stale',
      'binding_pending','provider_unavailable','policy_changed','manual_review')) then
    raise exception 'template_v2_status_invalid' using errcode='22023'; end if;
  select * into p from app_private.whatsapp_template_v2_policy where id=1 for share;
  v_digest:=app_private.whatsapp_template_approved_catalog_digest(2);
  if p.id is null or v_digest is distinct from
      '74512848434a9be4b89916aea5b047f15ddcffc801dba9cb23e41f6f73dcad55'
    then return false; end if;
  select * into e from app_private.whatsapp_template_v2_enrollments
    where onboarding_id=p_onboarding_id and channel_id=p_channel_id for update;
  if not found or e.excluded_at is not null
    or not exists(select from public.whatsapp_datafy_onboardings o where o.id=e.onboarding_id
      and (o.organization_id,o.unit_id,o.reserved_channel_id)
        =(e.organization_id,e.unit_id,e.channel_id)) then return false; end if;
  if e.origin='auto' and (not p.enabled or
      (e.policy_revision,e.catalog_digest) is distinct from (p.revision,p.catalog_digest)
      or p.catalog_digest is distinct from v_digest) then return false; end if;
  -- A manual selection can only heartbeat its existing, pinned ready grant.
  -- It never enters discovery or inherits the future-onboarding switch.
  if e.origin='manual' and (e.state<>'ready' or e.policy_revision<>0
      or e.catalog_digest is distinct from v_digest
      or not exists(select from public.whatsapp_datafy_onboardings o
        where o.id=e.onboarding_id and o.state='completed')
      or not exists(select from public.platform_flags
        where key='whatsapp_template_catalog' and value='true'::jsonb)
      or p_state not in('ready','needs_review')
      or (p_state='ready' and p_reason_code is not null
        and p_reason_code not in('health_stale','provider_unavailable'))
      or (p_state='ready' and p_reason_code is null
        and not exists(select from public.whatsapp_channels c
          where c.id=e.channel_id and c.status='connected'
            and c.last_health_check_at between clock_timestamp()-interval '5 minutes'
              and clock_timestamp()))
      or (p_state='needs_review' and p_reason_code is distinct from 'manual_review'))
    then return false; end if;
  if (e.state='needs_review' and p_state<>'needs_review')
    or (e.state='ready' and p_state not in('ready','needs_review')) then return false; end if;
  if (p_state='ready' or e.origin='manual') and not exists(select from public.whatsapp_template_bindings b
    join public.whatsapp_channels c on c.id=b.channel_id
    join public.whatsapp_template_accounts a on a.id=b.account_id
    join app_private.whatsapp_template_account_cohorts cohort on cohort.account_id=a.id
    join app_private.whatsapp_template_v2_grants g on g.binding_id=b.id and g.revoked_at is null
    where b.id=e.binding_id and b.channel_id=e.channel_id and b.unit_id=e.unit_id
      and b.generation=e.binding_generation and b.channel_credential_revision=e.credential_revision
      and b.provider='datafy' and b.verified_at is not null
      and c.unit_id=e.unit_id and c.provider='datafy'
      and c.template_credential_revision=e.credential_revision
      and a.organization_id=e.organization_id
      and (cohort.organization_id,cohort.version,cohort.origin,
        cohort.policy_revision,cohort.catalog_digest)
        =(a.organization_id,2,e.origin,e.policy_revision,e.catalog_digest)
      and (g.account_id,g.channel_id,g.unit_id,g.binding_generation,g.credential_revision,
        g.policy_revision,g.catalog_digest,g.origin,g.organization_id)
        =(a.id,b.channel_id,b.unit_id,b.generation,b.channel_credential_revision,
          e.policy_revision,e.catalog_digest,e.origin,a.organization_id)
      and (e.origin='manual' or (g.actor_id=cohort.actor_id
        and cohort.actor_id=p.actor_id)))
    then return false; end if;
  v_delay:=least(3600,30*(2^least(e.attempt_count,7))::integer);
  update app_private.whatsapp_template_v2_enrollments set state=p_state,reason_code=p_reason_code,
    next_attempt_at=case when p_state='pending' then clock_timestamp()+make_interval(secs=>v_delay)
      when p_state='discovering' then clock_timestamp()+interval '2 minutes'
      when p_state='ready' and p_reason_code is not null then clock_timestamp()+interval '2 minutes'
      when p_state='ready' then clock_timestamp()+interval '3 minutes'
      else 'infinity'::timestamptz end,
    updated_at=clock_timestamp() where onboarding_id=e.onboarding_id;
  return true;
end $$;
revoke all on function public.mark_whatsapp_template_v2_preparation(uuid,uuid,text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.mark_whatsapp_template_v2_preparation(uuid,uuid,text,text)
  to service_role;

create or replace function public.authorize_whatsapp_template_v2_channel(
  p_onboarding_id uuid,p_binding_id uuid,p_generation bigint,p_credential_revision bigint)
returns boolean language plpgsql security definer set search_path='' as $$
declare p app_private.whatsapp_template_v2_policy%rowtype;
  e app_private.whatsapp_template_v2_enrollments%rowtype;
  o public.whatsapp_datafy_onboardings%rowtype;
  a public.whatsapp_template_accounts%rowtype;
  b public.whatsapp_template_bindings%rowtype;
  c public.whatsapp_channels%rowtype;
  cohort app_private.whatsapp_template_account_cohorts%rowtype;
  g app_private.whatsapp_template_v2_grants%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'template_v2_authorize_forbidden' using errcode='42501';
  end if;
  if p_onboarding_id is null or p_binding_id is null or p_generation is null
    or p_credential_revision is null then return false; end if;
  select * into p from app_private.whatsapp_template_v2_policy where id=1 for share;
  if not found or not p.enabled or p.actor_id is null or p.enabled_at is null
    or p.catalog_digest is distinct from app_private.whatsapp_template_approved_catalog_digest(2)
    or not exists(select from public.platform_flags where key='whatsapp_template_catalog' and value='true'::jsonb) then
    return false;
  end if;
  select * into e from app_private.whatsapp_template_v2_enrollments
    where onboarding_id=p_onboarding_id for update;
  if not found or e.origin<>'auto' or e.excluded_at is not null
    or (e.policy_revision,e.catalog_digest) is distinct from (p.revision,p.catalog_digest)
    or e.created_at<p.enabled_at then return false; end if;
  -- Datafy connection mutates channel before onboarding. Match that lock
  -- order so the worker never waits on the channel while holding onboarding.
  select * into c from public.whatsapp_channels where id=e.channel_id for share;
  if not found then return false; end if;
  select * into o from public.whatsapp_datafy_onboardings where id=e.onboarding_id for share;
  if not found or o.state<>'completed'
    or (o.organization_id,o.unit_id,o.reserved_channel_id)
      is distinct from (e.organization_id,e.unit_id,e.channel_id) then return false; end if;
  select * into b from public.whatsapp_template_bindings where id=p_binding_id;
  if not found or b.account_id is null then return false; end if;
  select * into a from public.whatsapp_template_accounts where id=b.account_id for update;
  select * into b from public.whatsapp_template_bindings where id=p_binding_id for share;
  if a.id is null or c.id is null or a.id is distinct from b.account_id
    or a.organization_id is distinct from e.organization_id or a.created_at<p.enabled_at
    or (b.channel_id,b.unit_id,b.provider,b.generation,b.channel_credential_revision)
      is distinct from (e.channel_id,e.unit_id,'datafy',p_generation,p_credential_revision)
    or b.verified_at is null or c.unit_id is distinct from e.unit_id or c.provider<>'datafy'
    or c.template_credential_revision is distinct from p_credential_revision
    or c.status<>'connected' or c.last_health_check_at is null
    or c.last_health_check_at<clock_timestamp()-interval '5 minutes'
    or not exists(select from public.units u where u.id=e.unit_id and u.organization_id=e.organization_id)
    or exists(select from public.whatsapp_remote_templates t where t.account_id=a.id and t.version=1)
    or exists(select from public.whatsapp_template_jobs j where j.account_id=a.id and j.target_key like '%\_v1' escape '\')
    or exists(select from app_private.whatsapp_template_submission_grants v1 where v1.account_id=a.id) then
    return false;
  end if;
  select * into cohort from app_private.whatsapp_template_account_cohorts where account_id=a.id;
  if cohort.account_id is null then
    insert into app_private.whatsapp_template_account_cohorts
      (account_id,organization_id,version,catalog_digest,policy_revision,first_binding_id,actor_id)
    values(a.id,a.organization_id,2,p.catalog_digest,p.revision,b.id,p.actor_id);
  elsif (cohort.organization_id,cohort.version,cohort.catalog_digest,cohort.policy_revision,cohort.actor_id)
      is distinct from (a.organization_id,2,p.catalog_digest,p.revision,p.actor_id) then
    return false;
  end if;
  select * into g from app_private.whatsapp_template_v2_grants where binding_id=b.id
    order by granted_at desc limit 1;
  if g.id is not null then
    if not (g.revoked_at is null and (g.onboarding_id,g.channel_id,g.unit_id,g.account_id,g.organization_id,
      g.binding_generation,g.credential_revision,g.policy_revision,g.catalog_digest,g.actor_id)
      = (e.onboarding_id,b.channel_id,b.unit_id,a.id,a.organization_id,b.generation,
        b.channel_credential_revision,p.revision,p.catalog_digest,p.actor_id)) then return false; end if;
  else
    insert into app_private.whatsapp_template_v2_grants
      (onboarding_id,binding_id,channel_id,unit_id,account_id,organization_id,binding_generation,
        credential_revision,catalog_digest,policy_revision,actor_id)
    values(e.onboarding_id,b.id,b.channel_id,b.unit_id,a.id,a.organization_id,b.generation,
      b.channel_credential_revision,p.catalog_digest,p.revision,p.actor_id);
  end if;
  update app_private.whatsapp_template_v2_enrollments set binding_id=b.id,
    binding_generation=b.generation,credential_revision=b.channel_credential_revision,
    updated_at=clock_timestamp() where onboarding_id=e.onboarding_id;
  return true;
end $$;
revoke all on function public.authorize_whatsapp_template_v2_channel(uuid,uuid,bigint,bigint)
  from public,anon,authenticated,service_role;
grant execute on function public.authorize_whatsapp_template_v2_channel(uuid,uuid,bigint,bigint) to service_role;

-- Existing v1 accounts (including Ren Sushi) require an explicit, audited
-- platform action. This does not depend on the future-onboarding switch and
-- never enqueues a job or changes the v1 remote records.
create or replace function public.select_whatsapp_template_v2_existing_account(
  p_binding_id uuid,p_expected_generation bigint,p_expected_credential_revision bigint,
  p_expected_digest text)
returns boolean language plpgsql security definer set search_path='' as $$
declare a public.whatsapp_template_accounts%rowtype;
  b public.whatsapp_template_bindings%rowtype;
  c public.whatsapp_channels%rowtype;
  o public.whatsapp_datafy_onboardings%rowtype;
  cohort app_private.whatsapp_template_account_cohorts%rowtype;
  e app_private.whatsapp_template_v2_enrollments%rowtype;
  v_digest text;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or not app_private.is_platform_admin(auth.uid()) then
    raise exception 'template_v2_manual_forbidden' using errcode='42501';
  end if;
  v_digest:=app_private.whatsapp_template_approved_catalog_digest(2);
  if p_binding_id is null or p_expected_generation is null
    or p_expected_credential_revision is null or p_expected_digest is distinct from v_digest
    or v_digest is distinct from '74512848434a9be4b89916aea5b047f15ddcffc801dba9cb23e41f6f73dcad55'
    or not exists(select from public.platform_flags
      where key='whatsapp_template_catalog' and value='true'::jsonb) then return false; end if;
  select * into b from public.whatsapp_template_bindings where id=p_binding_id;
  if not found or b.account_id is null then return false; end if;
  select * into c from public.whatsapp_channels where id=b.channel_id for share;
  if not found then return false; end if;
  select * into o from public.whatsapp_datafy_onboardings
    where reserved_channel_id=b.channel_id and unit_id=b.unit_id and state='completed'
    order by completed_at desc nulls last,id limit 1 for share;
  if not found then return false; end if;
  select * into a from public.whatsapp_template_accounts where id=b.account_id for update;
  select * into b from public.whatsapp_template_bindings where id=p_binding_id for share;
  if a.id is null or b.id is null or b.account_id is distinct from a.id
    or (b.generation,b.channel_credential_revision)
      is distinct from (p_expected_generation,p_expected_credential_revision)
    or b.verified_at is null or b.provider<>'datafy'
    or c.id is distinct from b.channel_id or c.unit_id is distinct from b.unit_id
    or c.provider<>'datafy' or c.status<>'connected'
    or c.template_credential_revision is distinct from b.channel_credential_revision
    or c.last_health_check_at is null
    or c.last_health_check_at<clock_timestamp()-interval '5 minutes'
    or (o.organization_id,o.unit_id,o.reserved_channel_id)
      is distinct from (a.organization_id,b.unit_id,b.channel_id)
    or not exists(select from public.units u
      where u.id=b.unit_id and u.organization_id=a.organization_id)
    or exists(select from public.whatsapp_template_jobs j
      where j.account_id=a.id and j.operation='provision' and j.revision=1
        and (j.state in('posting','uncertain')
          or (j.state='claimed' and j.claimed_until>clock_timestamp()))) then return false; end if;
  select * into cohort from app_private.whatsapp_template_account_cohorts where account_id=a.id;
  if cohort.account_id is not null and (cohort.origin<>'manual'
    or cohort.organization_id is distinct from a.organization_id
    or cohort.catalog_digest is distinct from v_digest) then return false; end if;
  select * into e from app_private.whatsapp_template_v2_enrollments
    where channel_id=b.channel_id;
  if e.onboarding_id is not null then return false; end if;
  if exists(select from app_private.whatsapp_template_v2_grants
      where binding_id=b.id) then return false; end if;
  if cohort.account_id is null then
    insert into app_private.whatsapp_template_account_cohorts
      (account_id,organization_id,version,catalog_digest,policy_revision,origin,first_binding_id,actor_id)
    values(a.id,a.organization_id,2,v_digest,0,'manual',b.id,auth.uid());
  end if;
  insert into app_private.whatsapp_template_v2_enrollments
    (onboarding_id,organization_id,unit_id,channel_id,policy_revision,catalog_digest,origin,
      state,binding_id,binding_generation,credential_revision,next_attempt_at)
  values(o.id,a.organization_id,b.unit_id,b.channel_id,0,v_digest,'manual',
    'ready',b.id,b.generation,b.channel_credential_revision,
    clock_timestamp()+interval '3 minutes');
  insert into app_private.whatsapp_template_v2_grants
    (onboarding_id,binding_id,channel_id,unit_id,account_id,organization_id,binding_generation,
      credential_revision,catalog_digest,policy_revision,origin,actor_id)
  values(o.id,b.id,b.channel_id,b.unit_id,a.id,a.organization_id,b.generation,
    b.channel_credential_revision,v_digest,0,'manual',auth.uid());
  insert into public.audit_log(table_name,record_id,action,new_values,actor_id,unit_id,organization_id)
  values('whatsapp_template_bindings',b.id::text,'UPDATE',
    jsonb_build_object('scope','catalog_v2','origin','manual','enabled',true,
      'version',2,'digest',v_digest,'generation',b.generation,
      'credential_revision',b.channel_credential_revision),
    auth.uid(),b.unit_id,a.organization_id);
  return true;
end $$;
revoke all on function public.select_whatsapp_template_v2_existing_account(uuid,bigint,bigint,text)
  from public,anon,authenticated,service_role;
grant execute on function public.select_whatsapp_template_v2_existing_account(uuid,bigint,bigint,text)
  to authenticated;

-- The four-argument RPC is the v1 entrypoint. Keep its old implementation
-- intact under a private name, but refuse a v2 provision from that route.
do $$ begin
  if to_regprocedure('app_private.enqueue_whatsapp_template_job_v1_core(uuid,text,text,bigint)') is null then
    alter function public.enqueue_whatsapp_template_job(uuid,text,text,bigint)
      set schema app_private;
    alter function app_private.enqueue_whatsapp_template_job(uuid,text,text,bigint)
      rename to enqueue_whatsapp_template_job_v1_core;
  end if;
end $$;
revoke all on function app_private.enqueue_whatsapp_template_job_v1_core(uuid,text,text,bigint)
  from public,anon,authenticated,service_role;
create or replace function public.enqueue_whatsapp_template_job(
  p_binding_id uuid,p_operation text,p_target_key text,p_revision bigint)
returns uuid language plpgsql security definer set search_path='' as $$
begin
  if p_operation='provision' and (p_revision is distinct from 1
    or p_target_key not like '%\_v1' escape '\') then
    raise exception 'template_submission_paused' using errcode='P0A03';
  end if;
  return app_private.enqueue_whatsapp_template_job_v1_core(
    p_binding_id,p_operation,p_target_key,p_revision);
end $$;
revoke all on function public.enqueue_whatsapp_template_job(uuid,text,text,bigint)
  from public,anon,authenticated,service_role;
grant execute on function public.enqueue_whatsapp_template_job(uuid,text,text,bigint) to service_role;

create or replace function public.enqueue_whatsapp_template_job(
  p_binding_id uuid,p_operation text,p_target_key text,p_revision bigint,p_version integer)
returns uuid language plpgsql security definer set search_path='' as $$
declare b public.whatsapp_template_bindings%rowtype;
  a public.whatsapp_template_accounts%rowtype;
  c public.whatsapp_channels%rowtype;
  e app_private.whatsapp_template_v2_enrollments%rowtype;
  cohort app_private.whatsapp_template_account_cohorts%rowtype;
  g app_private.whatsapp_template_v2_grants%rowtype;
  p app_private.whatsapp_template_v2_policy%rowtype;
  v_id uuid; v_digest text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'template_v2_enqueue_forbidden' using errcode='42501';
  end if;
  if p_operation is distinct from 'provision' or p_version is distinct from 2
    or p_revision is distinct from 2 or p_target_key not like '%\_v2' escape '\' then
    raise exception 'template_v2_enqueue_invalid' using errcode='22023';
  end if;
  v_digest:=app_private.whatsapp_template_approved_catalog_digest(2);
  if v_digest is distinct from '74512848434a9be4b89916aea5b047f15ddcffc801dba9cb23e41f6f73dcad55'
    or not exists(select from public.platform_flags
      where key='whatsapp_template_catalog' and value='true'::jsonb) then
    raise exception 'template_submission_paused' using errcode='P0A03';
  end if;
  select * into b from public.whatsapp_template_bindings where id=p_binding_id;
  if not found or b.account_id is null then
    raise exception 'template_binding_refused' using errcode='42501'; end if;
  select * into p from app_private.whatsapp_template_v2_policy where id=1 for share;
  select * into e from app_private.whatsapp_template_v2_enrollments
    where channel_id=b.channel_id for share;
  select * into c from public.whatsapp_channels where id=b.channel_id for share;
  select * into a from public.whatsapp_template_accounts where id=b.account_id for share;
  select * into b from public.whatsapp_template_bindings where id=p_binding_id for share;
  select * into cohort from app_private.whatsapp_template_account_cohorts where account_id=a.id;
  select * into g from app_private.whatsapp_template_v2_grants
    where binding_id=b.id and account_id=a.id and revoked_at is null;
  if e.onboarding_id is null or c.id is null or a.id is null or b.id is null
    or cohort.account_id is null or g.id is null
    or (e.organization_id,e.unit_id,e.channel_id,e.binding_id,e.binding_generation,
      e.credential_revision,e.catalog_digest,e.policy_revision,e.origin,e.state)
      is distinct from (a.organization_id,b.unit_id,b.channel_id,b.id,b.generation,
        b.channel_credential_revision,v_digest,cohort.policy_revision,cohort.origin,'ready')
    or e.excluded_at is not null
    or (g.organization_id,g.unit_id,g.channel_id,g.binding_generation,g.credential_revision,
      g.catalog_digest,g.policy_revision,g.origin)
      is distinct from (a.organization_id,b.unit_id,b.channel_id,b.generation,
        b.channel_credential_revision,v_digest,cohort.policy_revision,cohort.origin)
    or b.provider<>'datafy' or b.verified_at is null
    or c.provider<>'datafy' or c.unit_id is distinct from b.unit_id
    or c.status<>'connected' or c.template_credential_revision is distinct from b.channel_credential_revision
    or c.last_health_check_at is null or c.last_health_check_at<clock_timestamp()-interval '5 minutes'
    or not exists(select from public.units u where u.id=b.unit_id and u.organization_id=a.organization_id)
    or not exists(select from public.whatsapp_datafy_onboardings o
      where o.id=e.onboarding_id and o.state='completed'
        and (o.organization_id,o.unit_id,o.reserved_channel_id)
          =(a.organization_id,b.unit_id,b.channel_id))
    or (cohort.origin='auto' and (not p.enabled or p.revision<>cohort.policy_revision
      or p.catalog_digest<>v_digest or p.actor_id<>cohort.actor_id))
    or not exists(select from public.whatsapp_remote_templates t
      join app_private.whatsapp_template_approved_submissions ap
        on ap.logical_id=t.logical_id and ap.version=t.version and ap.language=t.language
        and ap.requested_category=t.requested_category and ap.desired_hash=t.desired_hash
      where t.account_id=a.id and t.logical_id=p_target_key and t.version=2
        and t.language='pt_BR' and t.name=t.logical_id) then
    raise exception 'template_submission_paused' using errcode='P0A03';
  end if;
  insert into public.whatsapp_template_jobs
    (organization_id,account_id,binding_id,binding_generation,operation,target_key,revision)
  values(a.organization_id,a.id,b.id,b.generation,'provision',p_target_key,2)
  on conflict(account_id,operation,target_key,revision) do nothing returning id into v_id;
  if v_id is null then
    select id into v_id from public.whatsapp_template_jobs
      where account_id=a.id and operation='provision' and target_key=p_target_key and revision=2;
  end if;
  return v_id;
end $$;
revoke all on function public.enqueue_whatsapp_template_job(uuid,text,text,bigint,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.enqueue_whatsapp_template_job(uuid,text,text,bigint,integer)
  to service_role;

create or replace function public.release_whatsapp_template_v2_channel(
  p_binding_id uuid,p_expected_generation bigint,p_expected_credential_revision bigint)
returns boolean language plpgsql security definer set search_path='' as $$
declare b public.whatsapp_template_bindings%rowtype;
  a public.whatsapp_template_accounts%rowtype;
  e app_private.whatsapp_template_v2_enrollments%rowtype;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or not app_private.is_platform_admin(auth.uid()) then
    raise exception 'template_v2_release_forbidden' using errcode='42501';
  end if;
  select * into b from public.whatsapp_template_bindings where id=p_binding_id;
  if not found or b.account_id is null then return false; end if;
  -- Keep the same enrollment -> account -> binding lock order as authorize.
  -- Otherwise a stop racing the first grant can deadlock across tenants
  -- sharing one WABA.
  select * into e from app_private.whatsapp_template_v2_enrollments
    where channel_id=b.channel_id for update;
  if not found then return false; end if;
  select * into a from public.whatsapp_template_accounts where id=b.account_id for share;
  select * into b from public.whatsapp_template_bindings where id=p_binding_id for update;
  if a.id is null or b.account_id is distinct from a.id
    or b.generation is distinct from p_expected_generation
    or b.channel_credential_revision is distinct from p_expected_credential_revision
    or not exists(select from public.units u where u.id=b.unit_id and u.organization_id=a.organization_id) then
    return false;
  end if;
  update app_private.whatsapp_template_v2_grants set revoked_at=clock_timestamp()
    where binding_id=b.id and account_id=a.id and revoked_at is null;
  update app_private.whatsapp_template_v2_enrollments set excluded_at=clock_timestamp(),excluded_by=auth.uid()
    where channel_id=b.channel_id and excluded_at is null;
  insert into public.audit_log(table_name,record_id,action,new_values,actor_id,unit_id,organization_id)
    values('whatsapp_template_bindings',b.id::text,'UPDATE',
      jsonb_build_object('scope','catalog_v2','enabled',false,'generation',b.generation),
      auth.uid(),b.unit_id,a.organization_id);
  return true;
end $$;
revoke all on function public.release_whatsapp_template_v2_channel(uuid,bigint,bigint)
  from public,anon,authenticated,service_role;
grant execute on function public.release_whatsapp_template_v2_channel(uuid,bigint,bigint) to authenticated;

alter table app_private.whatsapp_template_post_confirmations
  add column if not exists catalog_version integer not null default 1;
alter table app_private.whatsapp_template_post_confirmations
  drop constraint if exists whatsapp_template_post_confirmations_catalog_version_check;
alter table app_private.whatsapp_template_post_confirmations
  add constraint whatsapp_template_post_confirmations_catalog_version_check
  check(catalog_version in (1,2));

-- No v1 grant or v1 policy appears in this gate. The account cohort, future
-- onboarding, binding generation, credential revision and complete JSON hash
-- must still agree at prepare, confirm and final check.
create or replace function app_private.whatsapp_template_submission_gate(
  p_job_id uuid,p_fence uuid,p_generation bigint,p_payload_hash text,p_version integer)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_digest text;
begin
  if p_version is distinct from 2 or p_payload_hash is null
    or p_payload_hash !~ '^[a-f0-9]{64}$' then return false; end if;
  v_digest:=app_private.whatsapp_template_approved_catalog_digest(2);
  if v_digest is distinct from '74512848434a9be4b89916aea5b047f15ddcffc801dba9cb23e41f6f73dcad55' then
    return false;
  end if;
  return exists(
    select 1 from public.whatsapp_template_jobs j
    join public.whatsapp_template_accounts a on a.id=j.account_id
    join app_private.whatsapp_template_account_cohorts cohort on cohort.account_id=a.id
      and cohort.version=2 and cohort.organization_id=a.organization_id
      and cohort.catalog_digest=v_digest
    join public.whatsapp_remote_templates t on t.account_id=a.id
      and t.logical_id=j.target_key and t.version=2 and t.language='pt_BR'
    join app_private.whatsapp_template_approved_submissions ap on ap.logical_id=t.logical_id
      and (ap.version,ap.language,ap.requested_category,ap.desired_hash,ap.payload_hash)
        =(t.version,t.language,t.requested_category,t.desired_hash,p_payload_hash)
    join public.whatsapp_template_bindings b on b.id=j.binding_id and b.account_id=a.id
    join public.whatsapp_channels c on c.id=b.channel_id
    join public.units u on u.id=b.unit_id and u.organization_id=a.organization_id
    join app_private.whatsapp_template_v2_grants g on g.binding_id=b.id
      and g.account_id=a.id and g.revoked_at is null
    join app_private.whatsapp_template_v2_enrollments e on e.onboarding_id=g.onboarding_id
      and e.channel_id=b.channel_id and e.unit_id=b.unit_id and e.organization_id=a.organization_id
      and e.excluded_at is null
    join public.whatsapp_datafy_onboardings o on o.id=e.onboarding_id
      and o.state='completed' and (o.organization_id,o.unit_id,o.reserved_channel_id)
        =(e.organization_id,e.unit_id,e.channel_id)
    left join app_private.whatsapp_template_v2_policy p on p.id=1
    where j.id=p_job_id and j.organization_id=a.organization_id and j.revision=2
      and j.operation='provision' and j.claim_token=p_fence
      and j.binding_generation=p_generation and b.generation=p_generation
      and b.provider='datafy' and b.verified_at is not null
      and c.unit_id=b.unit_id and c.provider='datafy' and c.status='connected'
      and c.last_health_check_at>=clock_timestamp()-interval '5 minutes'
      and b.channel_credential_revision=c.template_credential_revision
      and (g.organization_id,g.unit_id,g.channel_id,g.binding_generation,g.credential_revision,
        g.catalog_digest,g.policy_revision,g.origin)
        =(a.organization_id,b.unit_id,b.channel_id,b.generation,b.channel_credential_revision,
          v_digest,cohort.policy_revision,cohort.origin)
      and (e.policy_revision,e.catalog_digest,e.origin,e.binding_id,e.binding_generation,
        e.credential_revision,e.state)
        =(cohort.policy_revision,v_digest,cohort.origin,b.id,b.generation,
          b.channel_credential_revision,'ready')
      and (cohort.origin='manual' and cohort.policy_revision=0
        or cohort.origin='auto' and p.enabled and p.catalog_digest=v_digest
          and p.revision=cohort.policy_revision and p.actor_id=cohort.actor_id
          and g.actor_id=p.actor_id)
      and t.name=t.logical_id and t.binding_generation=a.binding_generation
      and j.claimed_until>clock_timestamp()
      and exists(select from public.platform_flags where key='whatsapp_template_catalog' and value='true'::jsonb)
  );
end $$;
revoke all on function app_private.whatsapp_template_submission_gate(uuid,uuid,bigint,text,integer)
  from public,anon,authenticated,service_role;

-- Version 2 has no zero-POST revalidation route. Any attempted, uncertain,
-- rejected or already confirmed POST stays held for manual reconciliation.
create or replace function public.prepare_whatsapp_template_provision(
  p_job_id uuid,p_fence uuid,p_generation bigint,p_payload_hash text,p_version integer)
returns boolean language plpgsql security definer set search_path='' as $$
declare j public.whatsapp_template_jobs%rowtype;
  a public.whatsapp_template_accounts%rowtype;
  b public.whatsapp_template_bindings%rowtype;
  c public.whatsapp_channels%rowtype;
  t public.whatsapp_remote_templates%rowtype;
  v_now timestamptz;
begin
  if p_version is distinct from 2 then return false; end if;
  perform 1 from app_private.whatsapp_template_v2_policy where id=1 for share;
  select * into j from public.whatsapp_template_jobs where id=p_job_id;
  if not found then return false; end if;
  select * into a from public.whatsapp_template_accounts where id=j.account_id for share;
  select * into b from public.whatsapp_template_bindings where id=j.binding_id for share;
  select * into c from public.whatsapp_channels where id=b.channel_id for share;
  select * into t from public.whatsapp_remote_templates
    where account_id=a.id and logical_id=j.target_key and version=2 and language='pt_BR' for update;
  select * into j from public.whatsapp_template_jobs where id=p_job_id for update;
  v_now:=clock_timestamp();
  if j.state<>'claimed' or j.claim_token is distinct from p_fence
    or j.claimed_until<=v_now or j.posting_started_at is not null or j.attempts<>0
    or j.provider_outcome is not null
    or exists(select from app_private.whatsapp_template_post_confirmations where job_id=j.id) then return false; end if;
  if a.id is null or b.id is null or c.id is null or t.id is null
    or (b.account_id,b.generation) is distinct from (a.id,j.binding_generation)
    or b.generation is distinct from p_generation or b.verified_at is null
    or b.channel_credential_revision is distinct from c.template_credential_revision
    or (c.unit_id,c.provider) is distinct from (b.unit_id,b.provider) then return false; end if;
  if a.sync_capture_id is null or a.last_sync_published_at is null
    or exists(select from public.whatsapp_remote_templates
      where account_id=a.id and version=2 and sync_required)
    or t.sync_required or t.binding_generation<>a.binding_generation
    or t.last_synced_at is null or t.last_synced_at<v_now-interval '60 seconds'
    or t.remote_id is not null or t.remote_status<>'UNKNOWN'
    or t.observed_hash is not null or t.submission_attempted_at is not null
    or exists(select from public.whatsapp_template_jobs other
      where other.account_id=a.id and other.operation='provision'
        and other.target_key=j.target_key and other.id<>j.id
        and (other.posting_started_at is not null or other.provider_outcome is not null)) then return false; end if;
  if not app_private.whatsapp_template_submission_gate(
      p_job_id,p_fence,p_generation,p_payload_hash,2) then return false; end if;
  update public.whatsapp_remote_templates set submission_attempted_at=v_now,local_status='submitting'
    where id=t.id and submission_attempted_at is null;
  if not found then return false; end if;
  update public.whatsapp_template_jobs set state='posting',post_capture_id=a.sync_capture_id,
    posting_started_at=v_now,claimed_until=v_now+interval '90 seconds',attempts=attempts+1
    where id=j.id and claim_token=p_fence and attempts=0;
  return found;
end $$;
revoke all on function public.prepare_whatsapp_template_provision(uuid,uuid,bigint,text,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.prepare_whatsapp_template_provision(uuid,uuid,bigint,text,integer) to service_role;

create or replace function public.confirm_whatsapp_template_post(
  p_job_id uuid,p_fence uuid,p_generation bigint,p_payload_hash text,p_version integer)
returns boolean language plpgsql security definer set search_path='' as $$
declare j public.whatsapp_template_jobs%rowtype;
  a public.whatsapp_template_accounts%rowtype;
  b public.whatsapp_template_bindings%rowtype;
  c public.whatsapp_channels%rowtype;
  gb public.whatsapp_template_bindings%rowtype;
  gc public.whatsapp_channels%rowtype;
  t public.whatsapp_remote_templates%rowtype;
  v_grant uuid; v_confirmed uuid; v_now timestamptz;
begin
  if p_version is distinct from 2 then return false; end if;
  -- The policy lock serializes this confirmation against a global stop.
  perform 1 from app_private.whatsapp_template_v2_policy where id=1 for share;
  if not found then return false; end if;
  select * into j from public.whatsapp_template_jobs where id=p_job_id;
  if not found then return false; end if;
  select * into a from public.whatsapp_template_accounts where id=j.account_id for share;
  perform 1 from public.whatsapp_template_bindings
    where id in(j.binding_id,a.sync_binding_id) order by id for share;
  select * into b from public.whatsapp_template_bindings where id=j.binding_id;
  select * into gb from public.whatsapp_template_bindings where id=a.sync_binding_id;
  perform 1 from public.whatsapp_channels
    where id in(b.channel_id,gb.channel_id) order by id for share;
  select * into c from public.whatsapp_channels where id=b.channel_id;
  select * into gc from public.whatsapp_channels where id=gb.channel_id;
  perform 1 from public.whatsapp_remote_templates where account_id=a.id order by id for share;
  select * into t from public.whatsapp_remote_templates
    where account_id=a.id and logical_id=j.target_key and version=2 and language='pt_BR';
  select * into j from public.whatsapp_template_jobs where id=p_job_id for share;
  v_now:=clock_timestamp();
  if j.state<>'posting' or j.claim_token is distinct from p_fence
    or j.claimed_until<=v_now or j.posting_started_at is null or j.attempts<>1
    or j.provider_outcome is not null or j.post_capture_id is null
    or j.post_capture_id is distinct from a.sync_capture_id
    or j.operation<>'provision' or a.id is null or b.id is null or c.id is null
    or gb.id is null or gc.id is null or t.id is null or a.last_sync_published_at is null then return false; end if;
  if (b.account_id,b.generation) is distinct from (a.id,j.binding_generation)
    or b.generation is distinct from p_generation or b.provider<>'datafy' or b.verified_at is null
    or b.channel_credential_revision is distinct from c.template_credential_revision
    or (b.unit_id,b.provider) is distinct from (c.unit_id,c.provider)
    or c.status<>'connected' or c.last_health_check_at is null
    or c.last_health_check_at<v_now-interval '5 minutes' then return false; end if;
  if gb.account_id is distinct from a.id or gb.verified_at is null
    or gb.generation is distinct from a.sync_binding_generation
    or gb.channel_credential_revision is distinct from a.sync_credential_revision
    or gc.template_credential_revision is distinct from a.sync_credential_revision
    or (gb.unit_id,gb.provider) is distinct from (gc.unit_id,gc.provider)
    or gc.status<>'connected' then return false; end if;
  if t.name<>t.logical_id or t.binding_generation<>a.binding_generation
    or t.last_synced_at is null or t.last_synced_at<v_now-interval '60 seconds'
    or t.remote_id is not null or t.remote_status<>'UNKNOWN'
    or t.observed_hash is not null or t.submission_attempted_at is null
    or exists(select from public.whatsapp_remote_templates
      where account_id=a.id and version=2 and sync_required) then return false; end if;
  if not app_private.whatsapp_template_submission_gate(
      p_job_id,p_fence,p_generation,p_payload_hash,2) then return false; end if;
  select id into v_grant from app_private.whatsapp_template_v2_grants
    where binding_id=b.id and account_id=a.id and revoked_at is null
      and binding_generation=p_generation
      and catalog_digest=app_private.whatsapp_template_approved_catalog_digest(2);
  if v_grant is null then return false; end if;
  insert into app_private.whatsapp_template_post_confirmations
    (job_id,claim_token,binding_generation,payload_hash,grant_id,catalog_version)
  values(j.id,p_fence,p_generation,p_payload_hash,v_grant,2)
  on conflict(job_id) do nothing returning job_id into v_confirmed;
  return v_confirmed is not null;
end $$;
revoke all on function public.confirm_whatsapp_template_post(uuid,uuid,bigint,text,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.confirm_whatsapp_template_post(uuid,uuid,bigint,text,integer) to service_role;

create or replace function public.check_whatsapp_template_submission(
  p_job_id uuid,p_fence uuid,p_generation bigint,p_payload_hash text,p_version integer)
returns boolean language sql security definer set search_path='' as $$
  select p_version=2 and exists(
    select 1 from app_private.whatsapp_template_post_confirmations confirmation
    join public.whatsapp_template_jobs j on j.id=confirmation.job_id
    where confirmation.job_id=p_job_id and confirmation.catalog_version=2
      and confirmation.claim_token=p_fence and confirmation.binding_generation=p_generation
      and confirmation.payload_hash=p_payload_hash and j.state='posting'
      and j.claim_token=p_fence and j.claimed_until>clock_timestamp()
      and app_private.whatsapp_template_submission_gate(
        p_job_id,p_fence,p_generation,p_payload_hash,2)
  )
$$;
revoke all on function public.check_whatsapp_template_submission(uuid,uuid,bigint,text,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.check_whatsapp_template_submission(uuid,uuid,bigint,text,integer) to service_role;

-- Serialize an old v1 seed against the v2 cohort selection on the account
-- row. Whoever commits first wins: the other path fails closed. This also
-- protects a shared WABA when two channels complete in parallel.
create or replace function app_private.guard_whatsapp_template_catalog_cohort()
returns trigger language plpgsql security definer set search_path='' as $$
declare a public.whatsapp_template_accounts%rowtype;
  cohort app_private.whatsapp_template_account_cohorts%rowtype;
  v_v1_history boolean;
  v_version integer;
begin
  if tg_table_name='whatsapp_template_jobs' then
    if new.operation<>'provision' then return new; end if;
  end if;
  select * into a from public.whatsapp_template_accounts where id=new.account_id for share;
  if not found then return new; end if; -- FK/parent guard reports the error.
  select * into cohort from app_private.whatsapp_template_account_cohorts where account_id=a.id;
  if tg_table_name='whatsapp_remote_templates' then
    v_version:=new.version;
  elsif new.target_key like '%\_v1' escape '\' then
    v_version:=1;
  elsif new.target_key like '%\_v2' escape '\' then
    v_version:=2;
  end if;
  if v_version is null or (cohort.account_id is not null and v_version<>2)
    or (cohort.account_id is null and v_version=2) then
    raise exception 'template_catalog_cohort_mismatch' using errcode='23514';
  end if;
  if v_version=1 then
    select exists(select from public.whatsapp_remote_templates t where t.account_id=a.id and t.version=1)
      or exists(select from public.whatsapp_template_jobs j where j.account_id=a.id
        and j.operation='provision' and j.target_key like '%\_v1' escape '\')
      or exists(select from app_private.whatsapp_template_submission_grants g where g.account_id=a.id)
      into v_v1_history;
    if not v_v1_history and exists(
      select from app_private.whatsapp_template_v2_enrollments e
      join public.whatsapp_template_bindings b on b.channel_id=e.channel_id and b.account_id=a.id
      where e.excluded_at is null) then
      raise exception 'template_v2_pending_cohort' using errcode='23514';
    end if;
  end if;
  return new;
end $$;
revoke all on function app_private.guard_whatsapp_template_catalog_cohort()
  from public,anon,authenticated,service_role;
drop trigger if exists guard_whatsapp_template_catalog_cohort on public.whatsapp_remote_templates;
create trigger guard_whatsapp_template_catalog_cohort
  before insert on public.whatsapp_remote_templates for each row
  execute function app_private.guard_whatsapp_template_catalog_cohort();
drop trigger if exists guard_whatsapp_template_catalog_cohort on public.whatsapp_template_jobs;
create trigger guard_whatsapp_template_catalog_cohort
  before insert on public.whatsapp_template_jobs for each row
  execute function app_private.guard_whatsapp_template_catalog_cohort();

notify pgrst,'reload schema';
commit;
