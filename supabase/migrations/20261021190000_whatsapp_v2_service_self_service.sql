-- Future automatic Datafy v2 cohorts: store controlled service dispatch.
-- Rollout starts OFF; existing manual cohorts are unchanged.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table if not exists app_private.whatsapp_v2_service_rollout (
  singleton boolean primary key default true check (singleton),
  ready boolean not null default false,
  revision bigint not null default 0 check (revision >= 0),
  actor_id uuid references auth.users(id) on delete restrict,
  changed_at timestamptz not null default clock_timestamp()
);
insert into app_private.whatsapp_v2_service_rollout(singleton, ready)
values (true, false) on conflict (singleton) do nothing;
alter table app_private.whatsapp_v2_service_rollout enable row level security;
alter table app_private.whatsapp_v2_service_rollout force row level security;
revoke all on app_private.whatsapp_v2_service_rollout from public, anon, authenticated, service_role;

create table if not exists app_private.whatsapp_v2_service_preferences (
  binding_id uuid not null,
  kind text not null check (kind in ('confirmation','reminder_d1','survey_d1',
    'waitlist_entered','cancellation','waitlist_table_ready')),
  unit_id uuid not null references public.units(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  channel_id uuid not null,
  binding_generation bigint not null check (binding_generation > 0),
  credential_revision bigint not null check (credential_revision >= 0),
  enabled boolean not null default false,
  enabled_at timestamptz,
  revision bigint not null check (revision > 0),
  actor_id uuid not null references auth.users(id) on delete restrict,
  changed_at timestamptz not null default clock_timestamp(),
  primary key (binding_id, kind),
  check ((not enabled) or enabled_at is not null)
);
alter table app_private.whatsapp_v2_service_preferences enable row level security;
alter table app_private.whatsapp_v2_service_preferences force row level security;
revoke all on app_private.whatsapp_v2_service_preferences from public, anon, authenticated, service_role;
create index if not exists whatsapp_v2_service_preferences_unit_idx
  on app_private.whatsapp_v2_service_preferences(unit_id, binding_id);

create table if not exists app_private.whatsapp_v2_service_preference_events (
  id bigint generated always as identity primary key,
  binding_id uuid not null,
  unit_id uuid not null,
  organization_id uuid not null,
  kind text not null,
  enabled boolean not null,
  revision bigint not null,
  actor_id uuid not null,
  changed_at timestamptz not null default clock_timestamp()
);
alter table app_private.whatsapp_v2_service_preference_events enable row level security;
alter table app_private.whatsapp_v2_service_preference_events force row level security;
revoke all on app_private.whatsapp_v2_service_preference_events from public, anon, authenticated, service_role;
revoke all on sequence app_private.whatsapp_v2_service_preference_events_id_seq
  from public, anon, authenticated, service_role;

-- This permit is consumed by the existing broad scope guard, before the
-- cutover permit is consumed by its separate trigger. No caller can mint it.
create table if not exists app_private.whatsapp_v2_service_binding_permits (
  tx_id bigint not null,
  binding_id uuid not null,
  unit_id uuid not null,
  actor_id uuid not null,
  old_generation bigint not null,
  old_credential_revision bigint not null,
  expected_adopted_at timestamptz not null,
  consumed_at timestamptz,
  primary key (tx_id, binding_id)
);
alter table app_private.whatsapp_v2_service_binding_permits
  add column if not exists consumed_at timestamptz;
alter table app_private.whatsapp_v2_service_binding_permits enable row level security;
alter table app_private.whatsapp_v2_service_binding_permits force row level security;
revoke all on app_private.whatsapp_v2_service_binding_permits from public, anon, authenticated, service_role;

create or replace function app_private.whatsapp_v2_service_candidate(p_unit_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.whatsapp_channels c
    join public.whatsapp_datafy_onboardings o
      on o.reserved_channel_id = c.id and o.unit_id = c.unit_id
    left join public.whatsapp_official_connection_grants connection_grant
      on connection_grant.id = o.grant_id
    join app_private.whatsapp_template_v2_policy policy on policy.id = 1
    where c.unit_id = p_unit_id and c.provider = 'datafy' and c.is_active is true
      and (o.grant_id is null or (connection_grant.id is not null
        and connection_grant.replaces_channel_id is null))
      and not exists (select 1 from public.whatsapp_channels legacy
        where legacy.unit_id = p_unit_id and legacy.is_active is true
          and legacy.status = 'connected' and legacy.provider in ('uazapi','zapi','waha'))
      and (exists (select 1 from app_private.whatsapp_template_v2_enrollments e
        where e.onboarding_id = o.id and e.unit_id = p_unit_id
          and e.channel_id = c.id and e.origin = 'auto')
        or (policy.enabled_at is not null and o.created_at >= policy.enabled_at))
  );
$$;
revoke all on function app_private.whatsapp_v2_service_candidate(uuid)
  from public, anon, authenticated, service_role;

create or replace function app_private.whatsapp_v2_service_fact_marker(
  p_unit_id uuid, p_kind text, p_resource_id uuid)
returns timestamptz language plpgsql stable security definer set search_path = '' as $$
declare v_at timestamptz;
begin
  if p_unit_id is null or p_resource_id is null then return null; end if;
  if p_kind in ('confirmation','reminder_d1','survey_d1') then
    select r.created_at into v_at from public.reservations r
      where r.id = p_resource_id and r.unit_id = p_unit_id;
  elsif p_kind = 'cancellation' then
    select r.cancelled_at into v_at from public.reservations r
      where r.id = p_resource_id and r.unit_id = p_unit_id;
  elsif p_kind = 'waitlist_entered' then
    select w.created_at into v_at from public.waitlist w
      where w.id = p_resource_id and w.unit_id = p_unit_id;
  elsif p_kind = 'waitlist_table_ready' then
    select w.notified_server_at into v_at from public.waitlist w
      where w.id = p_resource_id and w.unit_id = p_unit_id
        and w.notified_at = w.notified_server_at;
  end if;
  return v_at;
end $$;
revoke all on function app_private.whatsapp_v2_service_fact_marker(uuid,text,uuid)
  from public, anon, authenticated, service_role;

create or replace function app_private.whatsapp_v2_service_authorized_inner(
  p_unit_id uuid, p_channel_id uuid, p_binding_id uuid, p_kind text, p_resource_id uuid,
  p_pre_fact boolean)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare b public.whatsapp_template_bindings%rowtype;
  e app_private.whatsapp_template_v2_enrollments%rowtype;
  g app_private.whatsapp_template_v2_grants%rowtype;
  p app_private.whatsapp_template_v2_policy%rowtype;
  pref app_private.whatsapp_v2_service_preferences%rowtype;
  c public.whatsapp_channels%rowtype;
  v_marker timestamptz;
begin
  if not app_private.whatsapp_v2_service_candidate(p_unit_id) then return true; end if;
  if p_kind not in ('confirmation','reminder_d1','survey_d1','waitlist_entered',
      'cancellation','waitlist_table_ready') or p_binding_id is null then return false; end if;
  if not exists (select 1 from app_private.whatsapp_v2_service_rollout
      where singleton and ready) then return false; end if;
  select * into b from public.whatsapp_template_bindings where id = p_binding_id;
  select * into c from public.whatsapp_channels where id = p_channel_id;
  select * into e from app_private.whatsapp_template_v2_enrollments
    where unit_id = p_unit_id and origin = 'auto' and excluded_at is null;
  if not found then return false; end if;
  if (select count(*) from app_private.whatsapp_template_v2_enrollments
      where unit_id = p_unit_id and origin = 'auto' and excluded_at is null) <> 1 then return false; end if;
  select * into g from app_private.whatsapp_template_v2_grants
    where binding_id = b.id and revoked_at is null;
  select * into p from app_private.whatsapp_template_v2_policy where id = 1;
  select * into pref from app_private.whatsapp_v2_service_preferences
    where binding_id = b.id and kind = p_kind;
  if p_pre_fact then
    -- notify-waitlist-ready chooses the route before recording the server fact.
    -- Only this brand-new, unnotified table-ready fact may use pre-fact routing.
    if p_kind is distinct from 'waitlist_table_ready' or not exists (
      select 1 from public.waitlist w where w.id = p_resource_id and w.unit_id = p_unit_id
        and w.notified_at is null and w.notified_server_at is null) then return false; end if;
    v_marker := clock_timestamp();
  else
    v_marker := app_private.whatsapp_v2_service_fact_marker(p_unit_id,p_kind,p_resource_id);
  end if;
  return coalesce(p.enabled
    and p.catalog_digest = app_private.whatsapp_template_approved_catalog_digest(2)
    and exists(select 1 from public.platform_flags f
      where f.key = 'whatsapp_automation_dispatch' and f.value = 'true'::jsonb)
    and b.dispatch_enabled and b.adopted_at is not null
    and c.status = 'connected' and c.is_active is true and c.provider = 'datafy'
    and c.provider_subscribed_at is not null and c.provider_subscription_canceled_at is null
    and c.provider_paused_at is null and c.manual_echo_verified_at is not null
    and (b.unit_id,b.channel_id,b.provider,b.generation,b.channel_credential_revision)
      = (p_unit_id,p_channel_id,'datafy',e.binding_generation,c.template_credential_revision)
    and (e.binding_id,e.channel_id,e.credential_revision,e.state,e.policy_revision,e.catalog_digest)
      = (b.id,c.id,c.template_credential_revision,'ready',p.revision,p.catalog_digest)
    and (g.onboarding_id,g.binding_id,g.channel_id,g.unit_id,g.binding_generation,
      g.credential_revision,g.origin,g.policy_revision,g.catalog_digest)
      = (e.onboarding_id,b.id,c.id,p_unit_id,b.generation,
        c.template_credential_revision,'auto',p.revision,p.catalog_digest)
    and pref.enabled and (pref.unit_id,pref.channel_id,pref.binding_generation,
      pref.credential_revision) = (p_unit_id,c.id,b.generation,c.template_credential_revision)
    and v_marker > pref.enabled_at, false);
end $$;
revoke all on function app_private.whatsapp_v2_service_authorized_inner(uuid,uuid,uuid,text,uuid,boolean)
  from public, anon, authenticated, service_role;

create or replace function app_private.whatsapp_v2_service_authorized(
  p_unit_id uuid, p_channel_id uuid, p_binding_id uuid, p_kind text, p_resource_id uuid)
returns boolean language sql volatile security definer set search_path = '' as $$
  select app_private.whatsapp_v2_service_authorized_inner(
    p_unit_id,p_channel_id,p_binding_id,p_kind,p_resource_id,false);
$$;
revoke all on function app_private.whatsapp_v2_service_authorized(uuid,uuid,uuid,text,uuid)
  from public, anon, authenticated, service_role;

create or replace function app_private.guard_whatsapp_v2_service_job()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_resource uuid;
begin
  if tg_op = 'INSERT' or (tg_op = 'UPDATE' and old.posting_started_at is null
      and new.posting_started_at is not null) then
    v_resource := coalesce(new.reservation_id,new.waitlist_id,new.voucher_id);
    if not app_private.whatsapp_v2_service_authorized(new.unit_id,new.channel_id,
        new.binding_id,new.kind,v_resource) then
      raise exception 'v2_service_preference_required' using errcode = 'P0A01';
    end if;
    if app_private.whatsapp_v2_service_candidate(new.unit_id) and
      (new.initial_selection_source is distinct from 'auto'
       or new.initial_template_version is distinct from 2) then
      raise exception 'v2_service_version_required' using errcode = 'P0A03';
    end if;
  end if;
  return new;
end $$;
revoke all on function app_private.guard_whatsapp_v2_service_job()
  from public, anon, authenticated, service_role;
drop trigger if exists zzz_whatsapp_v2_service_job on public.whatsapp_automation_jobs;
create trigger zzz_whatsapp_v2_service_job before insert or update
  on public.whatsapp_automation_jobs for each row
  execute function app_private.guard_whatsapp_v2_service_job();

-- A mixed/old EF bundle may still attempt the legacy route. The claim is
-- refused before it can advance to POST, regardless of per-kind preference.
create or replace function app_private.guard_whatsapp_v2_service_legacy()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.owner = 'legacy' and new.state in ('claimed','posting')
    and app_private.whatsapp_v2_service_candidate(new.unit_id) then
    raise exception 'v2_service_managed_only' using errcode = 'P0A01';
  end if;
  return new;
end $$;
revoke all on function app_private.guard_whatsapp_v2_service_legacy()
  from public, anon, authenticated, service_role;
drop trigger if exists zzz_whatsapp_v2_service_legacy on app_private.whatsapp_cutover_intents;
create trigger zzz_whatsapp_v2_service_legacy before insert or update
  on app_private.whatsapp_cutover_intents for each row
  execute function app_private.guard_whatsapp_v2_service_legacy();

create or replace function public.get_whatsapp_v2_service_route(p_kind text,p_resource_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare f record; v_channel uuid; v_binding uuid; v_auto boolean; v_allowed boolean;
  v_verified_off boolean := false;
begin
  if auth.role() is distinct from 'service_role' or p_kind not in
    ('confirmation','reminder_d1','survey_d1','waitlist_entered','cancellation','waitlist_table_ready') then
    raise exception 'v2_service_route_forbidden' using errcode = '42501';
  end if;
  select * into f from app_private.whatsapp_cutover_lock_fact(p_kind,p_resource_id);
  if not found then raise exception 'v2_service_route_forbidden' using errcode = '42501'; end if;
  v_auto := app_private.whatsapp_v2_service_candidate(f.unit_id);
  if not v_auto then return '{"auto_cohort":false,"allowed":true}'::jsonb; end if;
  select c.id into v_channel from public.whatsapp_channels c where c.unit_id = f.unit_id
    and c.provider = 'datafy' and c.is_active is true order by c.created_at,c.id limit 1;
  select b.id into v_binding from public.whatsapp_template_bindings b
    where b.channel_id = v_channel;
  v_allowed := app_private.whatsapp_v2_service_authorized_inner(
    f.unit_id,v_channel,v_binding,p_kind,p_resource_id,
    p_kind = 'waitlist_table_ready' and exists(select 1 from public.waitlist w
      where w.id = p_resource_id and w.unit_id = f.unit_id
        and w.notified_at is null and w.notified_server_at is null));
  if not v_allowed and v_binding is not null then
    -- OFF is durable even if Meta, catalog policy, grant, subscription or sync
    -- are temporarily unavailable. Resolve the exact current auto onboarding,
    -- channel, binding and adoption, then inspect only the store preference.
    -- Those volatile send gates are enforced by authorized_inner for WhatsApp.
    -- Ambiguous identity remains a dependency failure, not a store choice.
    select exists (
      select 1 from public.whatsapp_template_bindings b
      join public.whatsapp_channels c on c.id = b.channel_id
      join app_private.whatsapp_template_v2_enrollments e
        on e.channel_id = c.id and e.unit_id = f.unit_id
      join public.whatsapp_datafy_onboardings o on o.id = e.onboarding_id
        and o.unit_id = e.unit_id and o.reserved_channel_id = e.channel_id
      left join public.whatsapp_official_connection_grants connection_grant
        on connection_grant.id = o.grant_id
      left join app_private.whatsapp_v2_service_preferences pref
        on pref.binding_id = b.id and pref.kind = p_kind
      where b.id = v_binding and b.unit_id = f.unit_id and b.channel_id = v_channel
        and b.provider = 'datafy' and c.provider = 'datafy' and c.is_active is true
        and e.origin = 'auto' and e.excluded_at is null
        and (e.binding_id is null or e.binding_id = b.id)
        and (o.grant_id is null or (connection_grant.id is not null
          and connection_grant.replaces_channel_id is null))
        and (e.binding_generation is null or e.binding_generation = b.generation)
        and (e.credential_revision is null
          or e.credential_revision = c.template_credential_revision)
        and b.channel_credential_revision = c.template_credential_revision
        and (select count(*) from app_private.whatsapp_template_v2_enrollments only_e
          where only_e.unit_id = f.unit_id and only_e.origin = 'auto'
            and only_e.excluded_at is null) = 1
        and ((b.adopted_at is null and b.dispatch_enabled is false
            and not exists(select 1 from public.whatsapp_automation_adoptions adoption
              where adoption.unit_id = f.unit_id))
          or (b.adopted_at is not null and exists(
            select 1 from public.whatsapp_automation_adoptions adoption
            where adoption.unit_id = f.unit_id and adoption.adopted_at = b.adopted_at)))
        and (pref.binding_id is null or pref.enabled is false)
    ) into v_verified_off;
  end if;
  if not v_allowed and not v_verified_off then
    -- Automatic onboarding can become the active Datafy route before a WABA
    -- binding or enrollment is visible. No store preference can exist yet,
    -- even if ensureAccount created the binding first.
    -- Prove this is one new, unmigrated channel with no prior adoption; then
    -- let email proceed while authorized_inner keeps WhatsApp closed.
    select exists (
      select 1 from public.whatsapp_channels c
      join public.whatsapp_datafy_onboardings o
        on o.reserved_channel_id = c.id and o.unit_id = c.unit_id
      left join public.whatsapp_official_connection_grants connection_grant
        on connection_grant.id = o.grant_id
      join app_private.whatsapp_template_v2_policy policy on policy.id = 1
      left join app_private.whatsapp_template_v2_enrollments e
        on e.onboarding_id = o.id
      left join public.whatsapp_template_bindings b on b.id = v_binding
      where c.id = v_channel and c.unit_id = f.unit_id
        and c.provider = 'datafy' and c.is_active is true
        and (e.onboarding_id is not null or (policy.enabled_at is not null
          and o.created_at >= policy.enabled_at))
        and (o.grant_id is null or (connection_grant.id is not null
          and connection_grant.replaces_channel_id is null))
        and (e.onboarding_id is null or (e.origin = 'auto'
          and e.unit_id = f.unit_id and e.channel_id = c.id
          and e.excluded_at is null
          and (e.binding_id is null or e.binding_id = b.id)))
        and (b.id is null or (b.unit_id = f.unit_id and b.channel_id = c.id
          and b.provider = 'datafy' and b.channel_credential_revision = c.template_credential_revision
          and b.adopted_at is null and b.dispatch_enabled is false))
        and (select count(*) from public.whatsapp_channels current_datafy
          where current_datafy.unit_id = f.unit_id
            and current_datafy.provider = 'datafy' and current_datafy.is_active is true) = 1
        and (select count(*) from public.whatsapp_datafy_onboardings current_onboarding
          where current_onboarding.unit_id = f.unit_id
            and current_onboarding.reserved_channel_id = c.id) = 1
        and not exists (select 1 from public.whatsapp_channels other
          where other.unit_id = f.unit_id and other.id <> c.id
            and other.provider <> 'datafy')
        and not exists (select 1 from public.whatsapp_template_bindings other_binding
          where other_binding.unit_id = f.unit_id
            and (b.id is null or other_binding.id <> b.id))
        and not exists (select 1 from app_private.whatsapp_template_v2_enrollments conflicting
          where conflicting.unit_id = f.unit_id and conflicting.onboarding_id <> o.id)
        and not exists (select 1 from app_private.whatsapp_v2_service_preferences existing_pref
          where existing_pref.unit_id = f.unit_id and existing_pref.enabled)
        and not exists (select 1 from public.whatsapp_automation_adoptions adoption
          where adoption.unit_id = f.unit_id)
    ) into v_verified_off;
  end if;
  return jsonb_build_object('auto_cohort',true,'allowed',v_allowed,
    'reason_code',case when v_allowed then 'ready'
      when v_verified_off then 'service_not_enabled' else 'dependency_unavailable' end);
end $$;
revoke all on function public.get_whatsapp_v2_service_route(text,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_whatsapp_v2_service_route(text,uuid) to service_role;

create or replace function public.get_whatsapp_v2_service_preferences(p_unit_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare b public.whatsapp_template_bindings%rowtype;
  c public.whatsapp_channels%rowtype;
  p app_private.whatsapp_v2_service_preferences%rowtype;
  v_kind text; v_kinds jsonb := '[]'::jsonb; v_ready jsonb;
  v_actor uuid := auth.uid(); v_manage boolean; v_eligible boolean;
  v_auto_cohort boolean;
  v_rollout boolean; v_global_dispatch boolean;
begin
  if auth.role() is distinct from 'authenticated' or v_actor is null
    or not (app_private.is_platform_admin(v_actor)
      or exists(select 1 from public.unit_members m where m.unit_id = p_unit_id
        and m.user_id = v_actor and m.role in ('owner','gerente','operador'))) then
    raise exception 'v2_service_preferences_forbidden' using errcode = '42501';
  end if;
  v_manage := app_private.is_platform_admin(v_actor)
    or exists(select 1 from public.unit_members m where m.unit_id = p_unit_id
      and m.user_id = v_actor and m.role in ('owner','gerente'));
  select * into c from public.whatsapp_channels
    where unit_id = p_unit_id and provider = 'datafy' and is_active is true
    order by created_at,id limit 1;
  if c.id is not null then
    select * into b from public.whatsapp_template_bindings where channel_id = c.id;
  end if;
  select ready into v_rollout from app_private.whatsapp_v2_service_rollout where singleton;
  select value = 'true'::jsonb into v_global_dispatch
    from public.platform_flags where key = 'whatsapp_automation_dispatch';
  v_auto_cohort := app_private.whatsapp_v2_service_candidate(p_unit_id);
  v_eligible := v_auto_cohort and b.id is not null and exists(select 1
    from app_private.whatsapp_template_v2_enrollments e
    join public.whatsapp_datafy_onboardings o on o.id = e.onboarding_id
      and o.unit_id = e.unit_id and o.reserved_channel_id = e.channel_id
    left join public.whatsapp_official_connection_grants connection_grant
      on connection_grant.id = o.grant_id
    join app_private.whatsapp_template_v2_grants g on g.onboarding_id = e.onboarding_id
      and g.binding_id = b.id and g.revoked_at is null
    where e.unit_id = p_unit_id and e.channel_id = c.id and e.binding_id = b.id
      and e.origin = 'auto' and e.excluded_at is null and e.state = 'ready'
      and g.origin = 'auto'
      and (e.binding_generation,e.credential_revision)
        is not distinct from (b.generation,c.template_credential_revision)
      and (o.grant_id is null or (connection_grant.id is not null
        and connection_grant.replaces_channel_id is null)));
  foreach v_kind in array array['confirmation','reminder_d1','survey_d1',
      'waitlist_entered','cancellation','waitlist_table_ready'] loop
    select * into p from app_private.whatsapp_v2_service_preferences
      where binding_id = b.id and kind = v_kind;
    if b.id is not null then
      v_ready := app_private.whatsapp_automation_v2_readiness(b.id,v_kind);
    else
      v_ready := '{"ready":false,"reason_code":"binding_changed","variants":[]}'::jsonb;
    end if;
    v_kinds := v_kinds || jsonb_build_array(jsonb_build_object(
      'kind',v_kind,'enabled',coalesce(p.enabled,false),'revision',coalesce(p.revision,0),
      'enabled_at',p.enabled_at,'ready',coalesce((v_ready->>'ready')::boolean,false),
      'reason_code',v_ready->>'reason_code','variants',v_ready->'variants'));
  end loop;
  return jsonb_build_object('eligible',coalesce(v_eligible,false),
    'auto_cohort',coalesce(v_auto_cohort,false),
    'admin_paused',coalesce(b.adopted_at is not null and not b.dispatch_enabled,false),
    'rollout_ready',coalesce(v_rollout,false),
    'global_dispatch_enabled',coalesce(v_global_dispatch,false),
    'can_manage',v_manage,
    'unit_id',p_unit_id,'channel_id',c.id,'binding_id',b.id,
    'binding_generation',b.generation,'credential_revision',c.template_credential_revision,
    'provider_subscription_confirmed',coalesce(c.provider_subscribed_at is not null
      and c.provider_subscription_canceled_at is null and c.provider_paused_at is null,false),
    'kinds',v_kinds);
end $$;
revoke all on function public.get_whatsapp_v2_service_preferences(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_whatsapp_v2_service_preferences(uuid) to authenticated;

create or replace function public.set_whatsapp_v2_service_preference(
  p_binding_id uuid,p_kind text,p_enabled boolean,p_expected_revision bigint,
  p_expected_generation bigint,p_expected_credential_revision bigint)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare b public.whatsapp_template_bindings%rowtype;
  c public.whatsapp_channels%rowtype;
  e app_private.whatsapp_template_v2_enrollments%rowtype;
  g app_private.whatsapp_template_v2_grants%rowtype;
  p app_private.whatsapp_v2_service_preferences%rowtype;
  v_actor uuid := auth.uid(); v_org uuid; v_now timestamptz;
  v_revision bigint; v_readiness jsonb; v_count integer;
begin
  if auth.role() is distinct from 'authenticated' or v_actor is null
    or p_binding_id is null or p_kind not in ('confirmation','reminder_d1',
      'survey_d1','waitlist_entered','cancellation','waitlist_table_ready')
    or p_enabled is null or p_expected_revision is null or p_expected_revision < 0
    or p_expected_generation is null or p_expected_credential_revision is null then
    raise exception 'v2_service_preference_invalid' using errcode = '22023';
  end if;
  select b0.unit_id,u.organization_id into b.unit_id,v_org
    from public.whatsapp_template_bindings b0
    join public.units u on u.id = b0.unit_id where b0.id = p_binding_id;
  if not found or not (app_private.is_platform_admin(v_actor)
      or exists(select 1 from public.unit_members m where m.unit_id = b.unit_id
        and m.user_id = v_actor and m.role in ('owner','gerente'))) then
    raise exception 'v2_service_preference_forbidden' using errcode = '42501';
  end if;
  -- Same mutex as the legacy/managed fact claims; adoption and the first
  -- preference become visible atomically when this transaction commits.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('whatsapp-cutover-unit:'||b.unit_id::text,0));
  select * into e from app_private.whatsapp_template_v2_enrollments
    where unit_id = b.unit_id and origin = 'auto' and excluded_at is null for update;
  select * into b from public.whatsapp_template_bindings where id = p_binding_id for update;
  select * into c from public.whatsapp_channels where id = b.channel_id for share;
  if b.id is null or c.id is null or c.unit_id is distinct from b.unit_id
    or not exists(select 1 from public.units u
      where u.id = b.unit_id and u.organization_id = v_org) then
    raise exception 'v2_service_preference_forbidden' using errcode = '42501';
  end if;
  select * into p from app_private.whatsapp_v2_service_preferences
    where binding_id = b.id and kind = p_kind for update;
  if coalesce(p.revision,0) is distinct from p_expected_revision
    or b.generation is distinct from p_expected_generation
    or c.template_credential_revision is distinct from p_expected_credential_revision then
    raise exception 'v2_service_preference_stale' using errcode = 'PT409';
  end if;
  if not p_enabled and p.binding_id is null then
    return jsonb_build_object('kind',p_kind,'enabled',false,'revision',0,'enabled_at',null);
  end if;
  if p_enabled then
    select count(*) into v_count from app_private.whatsapp_template_v2_enrollments
      where unit_id = b.unit_id and origin = 'auto' and excluded_at is null;
    select * into g from app_private.whatsapp_template_v2_grants
      where binding_id = b.id and revoked_at is null for share;
    if v_count <> 1 or e.onboarding_id is null or e.state <> 'ready'
      or not app_private.whatsapp_v2_service_candidate(b.unit_id)
      or not exists(select 1 from public.whatsapp_datafy_onboardings o
        left join public.whatsapp_official_connection_grants connection_grant
          on connection_grant.id = o.grant_id
        where o.id = e.onboarding_id and o.unit_id = b.unit_id
          and o.reserved_channel_id = c.id
          and (o.grant_id is null or (connection_grant.id is not null
            and connection_grant.replaces_channel_id is null)))
      or (e.binding_id,e.channel_id,e.binding_generation,e.credential_revision)
        is distinct from (b.id,c.id,b.generation,c.template_credential_revision)
      or g.id is null or g.onboarding_id is distinct from e.onboarding_id
      or g.origin <> 'auto'
      or (b.unit_id,b.provider,b.channel_credential_revision)
        is distinct from (c.unit_id,'datafy',c.template_credential_revision)
      or c.is_active is distinct from true or c.status <> 'connected'
      or c.provider_subscribed_at is null or c.provider_subscription_canceled_at is not null
      or c.provider_paused_at is not null or c.manual_echo_verified_at is null
      or exists(select 1 from public.whatsapp_channels other
        where other.unit_id = b.unit_id and other.id <> c.id and other.provider <> 'datafy')
      or not exists(select 1 from app_private.whatsapp_v2_service_rollout
        where singleton and ready)
      or not exists(select 1 from public.platform_flags
        where key = 'whatsapp_automation_dispatch' and value = 'true'::jsonb)
      or (app_private.resolve_whatsapp_automation_version(b.unit_id,c.id,p_kind)
        ->> 'source') is distinct from 'auto' then
      raise exception 'v2_service_preference_unavailable' using errcode = 'P0A01';
    end if;
    v_readiness := app_private.whatsapp_automation_v2_readiness(b.id,p_kind);
    if (v_readiness->>'ready') is distinct from 'true' then
      raise exception 'v2_service_preference_unavailable' using errcode = 'P0A01';
    end if;
    if b.adopted_at is not null and not b.dispatch_enabled then
      raise exception 'v2_service_admin_paused' using errcode = 'P0A01';
    end if;
    if b.adopted_at is null then
      if b.dispatch_enabled or exists(select 1 from public.whatsapp_automation_adoptions
          where unit_id = b.unit_id)
        or exists(select 1 from app_private.whatsapp_cutover_intents i
          where i.unit_id = b.unit_id and i.state in ('claimed','posting','uncertain'))
        or app_private.whatsapp_cutover_has_active_legacy_uncertainty(b.unit_id)
        or exists(select 1 from public.whatsapp_automation_jobs j
          where j.unit_id = b.unit_id and (j.posting_started_at is not null
            or j.state in ('claimed','posting','uncertain'))) then
        raise exception 'v2_service_exclusivity_unproved' using errcode = 'P0A01';
      end if;
    end if;
  end if;
  v_revision := coalesce(p.revision,0) + 1;
  v_now := clock_timestamp();
  insert into app_private.whatsapp_v2_service_preferences
    (binding_id,kind,unit_id,organization_id,channel_id,binding_generation,
      credential_revision,enabled,enabled_at,revision,actor_id,changed_at)
  values (b.id,p_kind,b.unit_id,v_org,c.id,b.generation,c.template_credential_revision,
    p_enabled,case when p_enabled then v_now else null end,v_revision,v_actor,v_now)
  on conflict (binding_id,kind) do update set
    enabled = excluded.enabled, enabled_at = excluded.enabled_at,
    revision = excluded.revision, actor_id = excluded.actor_id,
    changed_at = excluded.changed_at,
    unit_id = excluded.unit_id, organization_id = excluded.organization_id,
    channel_id = excluded.channel_id, binding_generation = excluded.binding_generation,
    credential_revision = excluded.credential_revision;
  insert into app_private.whatsapp_v2_service_preference_events
    (binding_id,unit_id,organization_id,kind,enabled,revision,actor_id,changed_at)
  values (b.id,b.unit_id,v_org,p_kind,p_enabled,v_revision,v_actor,v_now);
  if p_enabled and b.adopted_at is null then
    -- The scope guard consumes the store-specific permit; the cutover
    -- adoption guard consumes its own two existing typed permits.
    insert into app_private.whatsapp_v2_service_binding_permits
      (tx_id,binding_id,unit_id,actor_id,old_generation,old_credential_revision,expected_adopted_at)
    values (txid_current(),b.id,b.unit_id,v_actor,b.generation,b.channel_credential_revision,now());
    insert into app_private.whatsapp_cutover_adoption_permits
      (tx_id,operation,unit_id,binding_id,actor_id,old_generation,
        old_credential_revision,old_adopted_at,new_adopted_at,
        expected_adoption_at,old_dispatch_enabled,new_dispatch_enabled)
    values (txid_current(),'adoption_insert',b.unit_id,b.id,v_actor,b.generation,
        b.channel_credential_revision,null,now(),now(),false,true);
    insert into app_private.whatsapp_cutover_adoption_permits
      (tx_id,operation,unit_id,binding_id,actor_id,old_generation,
        old_credential_revision,old_adopted_at,new_adopted_at,
        old_dispatch_enabled,new_dispatch_enabled)
    values (txid_current(),'binding_enable',b.unit_id,b.id,v_actor,b.generation,
        b.channel_credential_revision,null,now(),false,true);
    update public.whatsapp_template_bindings
      set adopted_at = now(), dispatch_enabled = true where id = b.id;
    if not found or exists(select 1 from app_private.whatsapp_v2_service_binding_permits
        where tx_id = txid_current() and binding_id = b.id)
      or exists(select 1 from app_private.whatsapp_cutover_adoption_permits
        where tx_id = txid_current() and binding_id = b.id) then
      raise exception 'v2_service_permit_not_consumed' using errcode = '23514';
    end if;
  end if;
  return jsonb_build_object('kind',p_kind,'enabled',p_enabled,
    'revision',v_revision,'enabled_at',case when p_enabled then v_now else null end);
end $$;
revoke all on function public.set_whatsapp_v2_service_preference(uuid,text,boolean,bigint,bigint,bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.set_whatsapp_v2_service_preference(uuid,text,boolean,bigint,bigint,bigint)
  to authenticated;

create or replace function public.set_whatsapp_v2_service_rollout_ready(
  p_ready boolean,p_expected_revision bigint)
returns bigint language plpgsql volatile security definer set search_path = '' as $$
declare v_revision bigint;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or not app_private.is_platform_admin(auth.uid()) then
    raise exception 'v2_service_rollout_forbidden' using errcode = '42501';
  end if;
  if p_ready is null or p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'v2_service_rollout_invalid' using errcode = '22023'; end if;
  update app_private.whatsapp_v2_service_rollout
    set ready = p_ready, revision = revision + 1,actor_id = auth.uid(),
      changed_at = clock_timestamp()
    where singleton and revision = p_expected_revision
    returning revision into v_revision;
  if not found then raise exception 'v2_service_rollout_stale' using errcode = 'PT409'; end if;
  return v_revision;
end $$;
revoke all on function public.set_whatsapp_v2_service_rollout_ready(boolean,bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.set_whatsapp_v2_service_rollout_ready(boolean,bigint)
  to authenticated;

-- Exact latest post_core wrapper from 20261019183559, with a second gate
-- immediately before both prepare and confirm-only. Both sides take the
-- existing fact mutex, so a concurrent store opt-out cannot race the POST.
create or replace function app_private.whatsapp_automation_post_core(
  p_job_id uuid,p_fence uuid,p_generation bigint,p_consent_revision bigint,p_sync_epoch bigint,
  p_confirm_only boolean,p_expected jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.whatsapp_automation_jobs%rowtype; f record; m app_private.whatsapp_cutover_intents%rowtype;
  v_resource uuid; v_kind text; v_result jsonb;
begin
  select * into j from public.whatsapp_automation_jobs where id=p_job_id;
  if not found then return '{"allowed":false,"reason":"authority_changed"}'::jsonb; end if;
  v_resource:=coalesce(j.reservation_id,j.waitlist_id,j.voucher_id); v_kind:=j.kind;
  select * into f from app_private.whatsapp_cutover_lock_fact(j.kind,v_resource);
  if f.unit_id is distinct from j.unit_id or f.organization_id is distinct from j.organization_id then
    return '{"allowed":false,"reason":"authority_changed"}'::jsonb; end if;
  select * into j from public.whatsapp_automation_jobs where id=p_job_id;
  if not found or coalesce(j.reservation_id,j.waitlist_id,j.voucher_id) is distinct from v_resource
    or j.unit_id is distinct from f.unit_id or j.kind is distinct from v_kind then
    return '{"allowed":false,"reason":"authority_changed"}'::jsonb; end if;
  select * into m from app_private.whatsapp_cutover_intents
    where unit_id=j.unit_id and kind=j.kind and resource_type=f.resource_type and resource_id=v_resource for update;
  if not found or m.owner<>'managed' or m.managed_job_id is distinct from j.id
    or m.state not in ('ready','preproxy_refused') then
    return '{"allowed":false,"reason":"authority_changed"}'::jsonb; end if;
  if app_private.whatsapp_cutover_historical_state(j.unit_id,j.kind,f.resource_type,v_resource) is not null then
    return '{"allowed":false,"reason":"authority_changed"}'::jsonb; end if;
  if not app_private.whatsapp_v2_service_authorized(j.unit_id,j.channel_id,j.binding_id,
      j.kind,v_resource) then
    return '{"allowed":false,"reason":"service_not_enabled"}'::jsonb; end if;
  v_result:=app_private.whatsapp_automation_post_inner(p_job_id,p_fence,p_generation,p_consent_revision,
    p_sync_epoch,p_confirm_only,p_expected);
  if p_confirm_only is true and v_result->>'allowed'='true' then
    update app_private.whatsapp_cutover_intents set state='posting',fence=p_fence,
      channel_id=j.channel_id,provider=j.provider,credential_revision=j.initial_credential_revision,
      attempt_count=attempt_count+1,posting_at=clock_timestamp(),updated_at=clock_timestamp()
      where id=m.id and state in ('ready','preproxy_refused') and managed_job_id=j.id;
    if not found then raise exception 'cutover_intent_conflict' using errcode='P0A01'; end if;
  end if;
  return v_result;
end $$;
revoke all on function app_private.whatsapp_automation_post_core(uuid,uuid,bigint,bigint,bigint,boolean,jsonb)
  from public,anon,authenticated,service_role;




-- Exact latest guard body from 20261017203000, with one narrow store permit branch.
create or replace function public.guard_whatsapp_template_scope()
returns trigger language plpgsql security definer set search_path='' as $$
declare
  v_org uuid; v_customer_org uuid; v_deleted timestamptz;
  v_binding public.whatsapp_template_bindings%rowtype;
  v_channel public.whatsapp_channels%rowtype;
  v_remote public.whatsapp_remote_templates%rowtype;
  v_job public.whatsapp_automation_jobs%rowtype;
  v_resource_unit uuid; v_resource_customer uuid; v_resource_invalid boolean:=false; v_reset boolean:=false; v_erasure boolean:=false;
  v_initialize boolean:=false; v_revalidate boolean:=false; v_catalog_revalidate boolean:=false; v_exclusive_stop boolean:=false; v_auto_submission boolean:=false; v_store_dispatch boolean:=false; v_logical text; v_selected uuid;
  old_pins app_private.whatsapp_automation_pin_tuple; new_pins app_private.whatsapp_automation_pin_tuple;
begin
  -- UPDATE already owns the job: never acquire earlier parent locks here.
  if tg_op='UPDATE' and tg_table_name='whatsapp_automation_jobs' then
    old_pins:=row(old.pin_phase,old.channel_id,old.provider,old.binding_id,old.binding_generation,old.transport,old.account_id,old.remote_template_id,old.template_version,old.sync_epoch,old.initial_credential_revision,old.initial_catalog_key)::app_private.whatsapp_automation_pin_tuple;
    new_pins:=row(new.pin_phase,new.channel_id,new.provider,new.binding_id,new.binding_generation,new.transport,new.account_id,new.remote_template_id,new.template_version,new.sync_epoch,new.initial_credential_revision,new.initial_catalog_key)::app_private.whatsapp_automation_pin_tuple;
    if old.pin_phase='bound' and exists(select from app_private.whatsapp_automation_pin_revalidation_permits where transaction_id=txid_current() and job_id=old.id) then
      if old.state not in('blocked','needs_review') or new.state<>'queued' or old.expires_at<clock_timestamp()
        or old.customer_erased_at is not null or old.reconcile_required or old.finished_at is not null
        or old.posting_started_at is not null or old.provider_message_id is not null or (old.claimed_until is not null and old.claimed_until>clock_timestamp())
        or num_nonnulls(new.claim_token,new.claimed_until,new.safe_log_body,new.consent_revision,new.cost_authorization_id,new.error_code)>0
        or (to_jsonb(new)-array['channel_id','provider','binding_id','binding_generation','account_id','remote_template_id','template_version','sync_epoch','state','error_code','claim_token','claimed_until','safe_log_body','consent_revision','cost_authorization_id'])
          is distinct from (to_jsonb(old)-array['channel_id','provider','binding_id','binding_generation','account_id','remote_template_id','template_version','sync_epoch','state','error_code','claim_token','claimed_until','safe_log_body','consent_revision','cost_authorization_id'])
        or not app_private.consume_whatsapp_automation_pin_revalidation(old.id,old_pins,new_pins) then raise exception 'automation_pin_revalidation_refused' using errcode='23514'; end if;
      v_revalidate:=true;
    end if;
    if new.pin_phase is distinct from old.pin_phase then
      if old.pin_phase<>'preconfiguration' or new.pin_phase<>'bound'
        or old.state not in('blocked','paused','needs_review') or new.state not in('queued','blocked','paused','needs_review')
        or old.customer_erased_at is not null or new.customer_id is distinct from old.customer_id or new.customer_erased_at is not null
        or old.expires_at<clock_timestamp() or new.attempts<>0 or old.attempts<>0 or new.due_at is distinct from old.due_at
        or num_nonnulls(old.claim_token,old.claimed_until,old.posting_started_at,old.provider_message_id,new.claim_token,new.claimed_until,new.posting_started_at,new.provider_message_id,new.safe_log_body,new.consent_revision,new.cost_authorization_id)>0
        or new.reconcile_required
        or (old.channel_id is not null and new.channel_id is distinct from old.channel_id)
        or (old.provider is not null and new.provider is distinct from old.provider)
        or (old.binding_id is not null and new.binding_id is distinct from old.binding_id)
        or (old.binding_generation is not null and new.binding_generation is distinct from old.binding_generation)
        or (old.transport is not null and new.transport is distinct from old.transport)
        or (old.account_id is not null and new.account_id is distinct from old.account_id)
        or (old.remote_template_id is not null and new.remote_template_id is distinct from old.remote_template_id)
        or (old.template_version is not null and new.template_version is distinct from old.template_version)
        or (old.sync_epoch is not null and new.sync_epoch is distinct from old.sync_epoch)
        or (old.initial_credential_revision is not null and new.initial_credential_revision is distinct from old.initial_credential_revision)
        or (old.initial_catalog_key is not null and new.initial_catalog_key is distinct from old.initial_catalog_key)
        or new.channel_id is null or new.provider is null or new.binding_id is null or new.binding_generation is null or new.transport is null or new.initial_catalog_key is null or new.initial_credential_revision is null
        or not app_private.consume_whatsapp_automation_pin_initialization(old.id,old_pins,new_pins)
      then raise exception 'automation_pin_initialization_refused' using errcode='23514'; end if;
      v_initialize:=true;
    elsif not v_revalidate and (new.pin_phase,new.channel_id,new.provider,new.binding_id,new.binding_generation,new.transport,new.account_id,new.remote_template_id,new.template_version,new.initial_credential_revision,new.initial_catalog_key)
      is distinct from (old.pin_phase,old.channel_id,old.provider,old.binding_id,old.binding_generation,old.transport,old.account_id,old.remote_template_id,old.template_version,old.initial_credential_revision,old.initial_catalog_key)
    then raise exception 'automation_intent_immutable' using errcode='23514'; end if;
    if (new.id,new.unit_id,new.organization_id,new.kind,new.reservation_id,new.waitlist_id,new.voucher_id,new.source_event_key,new.fact_at,new.expires_at,new.notification_id) is distinct from (old.id,old.unit_id,old.organization_id,old.kind,old.reservation_id,old.waitlist_id,old.voucher_id,old.source_event_key,old.fact_at,old.expires_at,old.notification_id) then raise exception 'automation_intent_immutable' using errcode='23514'; end if;
    if old.customer_id is not null and new.customer_id is null then
      select deleted_at into v_deleted from public.customers where id=old.customer_id;
      v_erasure:=not found or v_deleted is not null;
      if not v_erasure then raise exception 'customer_erasure_not_authorized' using errcode='23514'; end if;
      new.customer_erased_at:=clock_timestamp(); new.safe_log_body:=null;
      if old.state not in('posting','uncertain','accepted','reconciled') then new.state:='blocked'; new.error_code:='customer_not_alive'; end if;
    elsif new.customer_id is distinct from old.customer_id or new.customer_erased_at is distinct from old.customer_erased_at then raise exception 'customer_erasure_immutable' using errcode='23514'; end if;
    if old.customer_erased_at is not null and new.safe_log_body is not null then raise exception 'automation_erased_render_forbidden' using errcode='23514'; end if;
    if old.posting_started_at is not null and new.posting_started_at is distinct from old.posting_started_at then
      v_reset:=new.posting_started_at is null and old.state='posting' and old.provider_message_id is null and new.provider_message_id is null and (
        (new.state='retry_wait' and old.provider='datafy' and new.claim_token=old.claim_token and new.attempts=old.attempts) or
        (old.claimed_until>clock_timestamp() and ((new.state in('blocked','paused','needs_review') and new.error_code in('final_service_suspended','final_channel_changed','final_consent_changed','final_resource_changed','final_gate_paused')) or (old.customer_erased_at is not null and new.state='blocked' and new.error_code='customer_not_alive')) and new.claim_token is null and new.claimed_until is null and new.attempts=old.attempts-1)
      ) and app_private.consume_whatsapp_post_reset(tg_table_name,old.id,old.claim_token,old.attempts,old.posting_started_at);
      if not coalesce(v_reset,false) then raise exception 'automation_post_marker_immutable' using errcode='23514'; end if;
    end if;
    if not v_initialize and not v_revalidate and new.sync_epoch is distinct from old.sync_epoch then
      if old.posting_started_at is not null or new.sync_epoch<old.sync_epoch then raise exception 'automation_posted_epoch_immutable' using errcode='23514'; end if;
      perform 1 from public.whatsapp_remote_templates r join public.whatsapp_template_accounts a on a.id=r.account_id join public.whatsapp_template_bindings b on b.id=new.binding_id
        where r.id=new.remote_template_id and r.account_id=new.account_id and r.version=new.template_version and r.binding_generation=a.binding_generation
          and r.sync_epoch=new.sync_epoch and not r.sync_required and r.remote_status='APPROVED' and r.local_status='usable' and r.observed_hash=r.desired_hash
          and b.generation=new.binding_generation and (b.unit_id,b.channel_id,b.provider,b.account_id)=(new.unit_id,new.channel_id,new.provider,new.account_id);
      if not found then raise exception 'automation_epoch_snapshot_invalid' using errcode='23514'; end if;
    end if;
    if old.posting_started_at is not null and not v_reset and not v_erasure and new.safe_log_body is distinct from old.safe_log_body then raise exception 'automation_render_immutable' using errcode='23514'; end if;
    if old.posting_started_at is not null and not v_reset and (new.consent_revision,new.cost_authorization_id) is distinct from (old.consent_revision,old.cost_authorization_id) then raise exception 'automation_posted_authority_immutable' using errcode='23514'; end if;
    if old.provider_message_id is not null and new.provider_message_id is distinct from old.provider_message_id then raise exception 'automation_provider_identity_immutable' using errcode='23514'; end if;
    return new;
  end if;
  if tg_op='UPDATE' and tg_table_name='whatsapp_template_jobs' then
    if exists(select from app_private.whatsapp_catalog_pin_revalidation_permits where transaction_id=txid_current() and job_id=old.id) then
      if old.state not in('paused','needs_review') or new.state<>'queued' or old.attempts<>0 or old.provider_outcome is not null
        or num_nonnulls(old.posting_started_at,old.post_capture_id,old.claim_token,old.claimed_until,old.finished_at,new.error_code)>0
        or (to_jsonb(new)-array['binding_id','binding_generation','state','error_code']) is distinct from (to_jsonb(old)-array['binding_id','binding_generation','state','error_code'])
        or not app_private.consume_whatsapp_catalog_pin_revalidation(old.id,row(old.binding_id,old.binding_generation)::app_private.whatsapp_catalog_pin_tuple,row(new.binding_id,new.binding_generation)::app_private.whatsapp_catalog_pin_tuple)
        then raise exception 'template_pin_revalidation_refused' using errcode='23514'; end if;
      v_catalog_revalidate:=true;
    end if;
    if (new.id,new.organization_id,new.account_id,new.operation,new.target_key,new.revision) is distinct from (old.id,old.organization_id,old.account_id,old.operation,old.target_key,old.revision)
      or (not v_catalog_revalidate and (new.binding_id,new.binding_generation) is distinct from (old.binding_id,old.binding_generation)) then raise exception 'template_job_identity_immutable' using errcode='23514'; end if;
    if old.posting_started_at is not null and new.posting_started_at is distinct from old.posting_started_at then
      v_reset:=new.posting_started_at is null and old.state='posting' and old.provider_outcome is distinct from 'accepted' and (
        (new.state='queued' and new.provider_outcome='rejected' and new.claim_token=old.claim_token and new.attempts=old.attempts) or
        (old.claimed_until>clock_timestamp() and new.state in('paused','needs_review') and new.error_code in('final_service_suspended','final_channel_changed','final_gate_paused') and new.provider_outcome is null and new.claim_token is null and new.claimed_until is null and new.attempts=old.attempts-1)
      ) and app_private.consume_whatsapp_post_reset(tg_table_name,old.id,old.claim_token,old.attempts,old.posting_started_at);
      if not coalesce(v_reset,false) then raise exception 'template_post_marker_immutable' using errcode='23514'; end if;
    end if;
    if old.posting_started_at is not null then
      if (v_reset and new.post_capture_id is not null) or (not v_reset and new.post_capture_id is distinct from old.post_capture_id) then raise exception 'template_post_capture_immutable' using errcode='23514'; end if;
    elsif new.post_capture_id is distinct from old.post_capture_id then
      if old.state<>'claimed' or new.state<>'posting' or new.posting_started_at is null or new.post_capture_id is null or
        not exists(select from public.whatsapp_template_accounts where id=new.account_id and sync_capture_id=new.post_capture_id and last_sync_published_at is not null) then raise exception 'template_post_capture_invalid' using errcode='23514'; end if;
    end if;
    return new;
  end if;
  if tg_op='UPDATE' and tg_table_name='whatsapp_automation_receipt_events' then return new; end if;
  if tg_table_name='whatsapp_template_accounts' then
    if tg_op='UPDATE' and (new.id,new.organization_id,new.waba_id) is distinct from (old.id,old.organization_id,old.waba_id) then raise exception 'template_identity_immutable' using errcode='23514'; end if;
    if tg_op='UPDATE' and new.binding_generation<old.binding_generation then raise exception 'template_generation_regression' using errcode='23514'; end if;
    if tg_op='UPDATE' and new.reconciliation_revision<old.reconciliation_revision then raise exception 'template_reconciliation_revision_regression' using errcode='23514'; end if;
    return new;
  end if;
  if tg_table_name in('whatsapp_message_consent_events','whatsapp_message_preference_tokens','whatsapp_promotion_slots','whatsapp_automation_jobs') then
    if new.customer_id is not null then
      if tg_table_name='whatsapp_message_consent_events' then
        select organization_id,deleted_at into v_customer_org,v_deleted from public.customers where id=new.customer_id for update;
      else
        select organization_id,deleted_at into v_customer_org,v_deleted from public.customers where id=new.customer_id for share;
      end if;
      if not found or v_deleted is not null then raise exception 'customer_not_alive' using errcode='P0A15'; end if;
    end if;
    select organization_id into v_org from public.units where id=new.unit_id;
    if not found or (new.customer_id is not null and v_customer_org is distinct from v_org) then raise exception 'template_tenant_mismatch' using errcode='23514'; end if;
  end if;
  if tg_table_name='whatsapp_template_bindings' then
    if tg_op='UPDATE' and auth.role()='authenticated' and auth.uid() is not null and app_private.is_platform_admin(auth.uid()) then
      v_exclusive_stop:=(old.dispatch_enabled is true and new.dispatch_enabled is false
        and (to_jsonb(new)-'dispatch_enabled') is not distinct from (to_jsonb(old)-'dispatch_enabled'))
        or (old.submission_authorized_at is not null and old.submission_authorized_by is not null and new.submission_authorized_at is null and new.submission_authorized_by is null
        and (to_jsonb(new)-array['submission_authorized_at','submission_authorized_by']) is not distinct from (to_jsonb(old)-array['submission_authorized_at','submission_authorized_by']));
    end if;
    select organization_id into v_org from public.units where id=new.unit_id;
    if not found then raise exception 'template_tenant_mismatch' using errcode='23514'; end if;
    if new.account_id is not null then
      perform 1 from public.whatsapp_template_accounts where id=new.account_id and organization_id=v_org for share;
      if not found then raise exception 'template_tenant_mismatch' using errcode='23514'; end if;
    end if;
    select * into v_channel from public.whatsapp_channels where id=new.channel_id for share;
    if not found or v_channel.unit_id is distinct from new.unit_id or (not v_exclusive_stop and v_channel.provider is distinct from new.provider) then raise exception 'template_channel_mismatch' using errcode='23514'; end if;
    if tg_op='UPDATE' then
      if (new.id,new.unit_id,new.channel_id) is distinct from (old.id,old.unit_id,old.channel_id) then raise exception 'template_binding_identity_immutable' using errcode='23514'; end if;
      if new.generation<old.generation or ((new.provider,new.account_id) is distinct from (old.provider,old.account_id) and new.generation<=old.generation) then raise exception 'template_generation_regression' using errcode='23514'; end if;
      if old.adopted_at is not null and new.adopted_at is distinct from old.adopted_at then raise exception 'template_adoption_immutable' using errcode='23514'; end if;
    end if;
    if (tg_op='INSERT' and (new.adopted_at is not null or new.dispatch_enabled or new.submission_authorized_at is not null)) or
       (tg_op='UPDATE' and ((old.adopted_at is null and new.adopted_at is not null) or (not old.dispatch_enabled and new.dispatch_enabled) or (new.submission_authorized_at is not null and (new.submission_authorized_at,new.submission_authorized_by) is distinct from (old.submission_authorized_at,old.submission_authorized_by)))) then
      if tg_op='UPDATE' and old.submission_authorized_at is null
        and new.submission_authorized_at is not null and auth.role()='service_role'
        and old.adopted_at is not distinct from new.adopted_at and old.dispatch_enabled is not distinct from new.dispatch_enabled
        and (to_jsonb(new)-array['submission_authorized_at','submission_authorized_by'])
          is not distinct from (to_jsonb(old)-array['submission_authorized_at','submission_authorized_by']) then
        v_auto_submission:=app_private.consume_whatsapp_template_auto_permit(
          new.id,new.generation,new.channel_credential_revision,new.submission_authorized_by);
      end if;
      if tg_op='UPDATE' and old.dispatch_enabled is false and new.dispatch_enabled is true
        and old.adopted_at is null and new.adopted_at is not null
        and old.submission_authorized_at is not distinct from new.submission_authorized_at
        and old.submission_authorized_by is not distinct from new.submission_authorized_by
        and (to_jsonb(new)-array['dispatch_enabled','adopted_at'])
          is not distinct from (to_jsonb(old)-array['dispatch_enabled','adopted_at'])
        and auth.role()='authenticated' and auth.uid() is not null then
        update app_private.whatsapp_v2_service_binding_permits permit
          set consumed_at=clock_timestamp()
          where permit.tx_id=txid_current() and permit.binding_id=old.id
            and permit.unit_id=old.unit_id and permit.actor_id=auth.uid()
            and permit.old_generation=old.generation
            and permit.old_credential_revision=old.channel_credential_revision
            and permit.expected_adopted_at is not distinct from new.adopted_at
            and permit.consumed_at is null
          returning true into v_store_dispatch;
      end if;
      if not v_auto_submission and not v_store_dispatch and (auth.role() is distinct from 'authenticated' or auth.uid() is null or not app_private.is_platform_admin(auth.uid())) then
        raise exception 'template_admin_required' using errcode='42501';
      end if;
      if not v_auto_submission and new.submission_authorized_at is not null and (tg_op='INSERT' or (new.submission_authorized_at,new.submission_authorized_by) is distinct from (old.submission_authorized_at,old.submission_authorized_by)) then
        new.submission_authorized_by:=auth.uid(); new.submission_authorized_at:=clock_timestamp();
      end if;
      if new.adopted_at is not null and (tg_op='INSERT' or old.adopted_at is null) then
        new.adopted_at:=now();
        insert into public.whatsapp_automation_adoptions(unit_id,adopted_at) values(new.unit_id,now()) on conflict(unit_id) do nothing;
      end if;
    end if;
  elsif tg_table_name='whatsapp_remote_templates' then
    if tg_op='UPDATE' and (new.id,new.account_id,new.logical_id,new.version,new.language,new.name,new.desired_hash,new.requested_category) is distinct from (old.id,old.account_id,old.logical_id,old.version,old.language,old.name,old.desired_hash,old.requested_category) then raise exception 'template_identity_immutable' using errcode='23514'; end if;
    if tg_op='UPDATE' and new.sync_epoch<old.sync_epoch then raise exception 'template_epoch_regression' using errcode='23514'; end if;
  elsif tg_table_name in('whatsapp_template_jobs','whatsapp_template_cost_authorizations') then
    select organization_id into v_org from public.whatsapp_template_accounts where id=new.account_id for share;
    if not found then raise exception 'template_tenant_mismatch' using errcode='23514'; end if;
    if tg_table_name='whatsapp_template_jobs' then
      if new.organization_id is not null and new.organization_id is distinct from v_org then raise exception 'template_tenant_mismatch' using errcode='23514'; end if;
      new.organization_id:=v_org;
    end if;
    select * into v_binding from public.whatsapp_template_bindings where id=new.binding_id for share;
    if not found or v_binding.account_id is distinct from new.account_id or (tg_op='INSERT' and v_binding.generation is distinct from new.binding_generation) then raise exception 'template_binding_mismatch' using errcode='23514'; end if;
    if tg_table_name='whatsapp_template_cost_authorizations' and tg_op='INSERT' then
      if auth.role() is distinct from 'authenticated' or auth.uid() is distinct from new.actor_id or not app_private.is_platform_admin(auth.uid()) then raise exception 'template_admin_required' using errcode='42501'; end if;
    end if;
  elsif tg_table_name='whatsapp_automation_jobs' then
    if new.organization_id is distinct from v_org then raise exception 'template_tenant_mismatch' using errcode='23514'; end if;
    if new.reservation_id is not null then select unit_id,customer_id into v_resource_unit,v_resource_customer from public.reservations where id=new.reservation_id;
    elsif new.waitlist_id is not null then
      select w.unit_id,c.id,(w.customer_id is not null and c.id is null) into v_resource_unit,v_resource_customer,v_resource_invalid from public.waitlist w
        join public.units u on u.id=w.unit_id left join public.customers c on c.organization_id=u.organization_id and c.phone=public.normalize_br_phone(w.customer_phone) and (w.customer_id is null or c.id=w.customer_id) where w.id=new.waitlist_id;
    elsif new.voucher_id is not null then select unit_id,customer_id into v_resource_unit,v_resource_customer from public.vouchers where id=new.voucher_id;
    end if;
    if v_resource_invalid or v_resource_unit is distinct from new.unit_id or v_resource_customer is distinct from new.customer_id then raise exception 'template_resource_mismatch' using errcode='23514'; end if;
    if tg_op='INSERT' and (new.customer_erased_at is not null or (new.customer_id is null and new.waitlist_id is null)) then raise exception 'template_resource_mismatch' using errcode='23514'; end if;
    v_logical:=case new.kind when 'confirmation' then case when (select applied_discount_percent>0 from public.reservations where id=new.reservation_id) then 'res_confirmacao_desconto_v1' else 'res_confirmacao_v1' end when 'reminder_d1' then 'res_lembrete_dia_v1' when 'survey_d1' then 'res_pesquisa_reserva_v1' when 'waitlist_entered' then 'fila_entrada_v1' when 'waitlist_feedback' then 'fila_feedback_v1' when 'voucher_issued' then 'mkt_voucher_programado_v1' when 'cancellation' then 'res_cancelada_v1' when 'waitlist_table_ready' then 'fila_mesa_pronta_v1' end;
    new.initial_catalog_key:=v_logical;
    if new.pin_phase='preconfiguration' then
      select id into v_selected from public.whatsapp_channels x where x.unit_id=new.unit_id and (x.is_active=true or (x.is_active is null and x.status='connected' and not exists(select from public.whatsapp_channels active where active.unit_id=new.unit_id and active.is_active=true))) order by x.is_active desc nulls last,x.created_at,x.id limit 1;
      if new.channel_id is distinct from v_selected then raise exception 'automation_configuration_changed' using errcode='PT503'; end if;
      if new.channel_id is null then return new; end if;
    end if;
    if new.account_id is not null then perform 1 from public.whatsapp_template_accounts where id=new.account_id and organization_id=v_org for share; if not found then raise exception 'template_tenant_mismatch' using errcode='23514'; end if; end if;
    select * into v_binding from public.whatsapp_template_bindings where id=new.binding_id for share;
    if new.binding_id is not null and (v_binding.id is null or (v_binding.unit_id,v_binding.channel_id,v_binding.provider,v_binding.account_id,v_binding.generation) is distinct from (new.unit_id,new.channel_id,new.provider,new.account_id,new.binding_generation)) then raise exception 'template_binding_mismatch' using errcode='23514'; end if;
    select * into v_channel from public.whatsapp_channels where id=new.channel_id for share;
    if v_channel.id is null or (v_channel.unit_id,v_channel.provider) is distinct from (new.unit_id,new.provider) then raise exception 'template_channel_mismatch' using errcode='23514'; end if;
    if new.initial_credential_revision is not null and new.initial_credential_revision is distinct from v_channel.template_credential_revision then raise exception 'automation_revision_mismatch' using errcode='23514'; end if;
    new.initial_credential_revision:=v_channel.template_credential_revision;
    if new.pin_phase='preconfiguration' then
      if new.binding_id is null then
        if exists(select from public.whatsapp_template_bindings where channel_id=new.channel_id) then raise exception 'automation_configuration_changed' using errcode='PT503'; end if;
      elsif exists(select from public.whatsapp_remote_templates where account_id=new.account_id and logical_id=v_logical and version=1 and language='pt_BR') then raise exception 'automation_configuration_changed' using errcode='PT503'; end if;
      return new;
    end if;
    if new.remote_template_id is not null then
      select * into v_remote from public.whatsapp_remote_templates where id=new.remote_template_id for share;
      if not found or (v_remote.account_id,v_remote.version) is distinct from (new.account_id,new.template_version) then raise exception 'template_remote_mismatch' using errcode='23514'; end if;
    end if;
    if new.cost_authorization_id is not null then
      perform 1 from public.whatsapp_template_cost_authorizations where id=new.cost_authorization_id and account_id=new.account_id and binding_id=new.binding_id and binding_generation=new.binding_generation and category='MARKETING';
      if not found then raise exception 'template_cost_mismatch' using errcode='23514'; end if;
    end if;
  elsif tg_table_name='whatsapp_message_consent_events' then
    if tg_op='INSERT' then
      select coalesce(max(revision),0)+1 into new.revision from public.whatsapp_message_consent_events where unit_id=new.unit_id and customer_id=new.customer_id and purpose=new.purpose;
      new.created_at:=now();
    end if;
  elsif tg_table_name='whatsapp_message_preference_tokens' then
    if tg_op='UPDATE' and (new.id,new.unit_id,new.customer_id,new.purpose,new.token_hash,new.expires_at,new.created_at) is distinct from (old.id,old.unit_id,old.customer_id,old.purpose,old.token_hash,old.expires_at,old.created_at) then raise exception 'preference_token_immutable' using errcode='23514'; end if;
    if tg_op='UPDATE' and old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then raise exception 'preference_token_revocation_immutable' using errcode='23514'; end if;
  elsif tg_table_name='whatsapp_promotion_slots' then
    select * into v_job from public.whatsapp_automation_jobs where id=new.job_id;
    if not found or (tg_op='INSERT' and v_job.pin_phase<>'bound') or v_job.kind not in('waitlist_feedback','voucher_issued') or (v_job.unit_id,v_job.customer_id) is distinct from (new.unit_id,new.customer_id) then raise exception 'promotion_slot_mismatch' using errcode='23514'; end if;
    if tg_op='UPDATE' and (new.id,new.unit_id,new.customer_id,new.job_id,new.created_at,new.window_days) is distinct from (old.id,old.unit_id,old.customer_id,old.job_id,old.created_at,old.window_days) then raise exception 'promotion_slot_identity_immutable' using errcode='23514'; end if;
    if tg_op='UPDATE' and (new.claim_token is distinct from old.claim_token or new.window_until<old.window_until or (old.state='accepted' and new.state<>'accepted') or (old.state='uncertain' and new.state='reserved') or (old.accepted_at is not null and new.accepted_at is distinct from old.accepted_at)) then raise exception 'promotion_slot_evidence_immutable' using errcode='23514'; end if;
  elsif tg_table_name='whatsapp_automation_receipt_events' then
    select * into v_channel from public.whatsapp_channels where id=new.channel_id for share;
    if not found or (v_channel.unit_id,v_channel.provider) is distinct from (new.unit_id,new.provider) then raise exception 'template_channel_mismatch' using errcode='23514'; end if;
  end if;
  return new;
end $$;
revoke all on function public.guard_whatsapp_template_scope() from public,anon,authenticated,service_role;

-- Exact evidence guard from 20261004014032, with one narrow store adoption permit branch.
create or replace function public.guard_whatsapp_template_evidence()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_store_adoption boolean:=false;
begin
  if tg_table_name='whatsapp_automation_adoptions' then
    if tg_op='INSERT' and auth.role()='authenticated' and auth.uid() is not null and app_private.is_platform_admin(auth.uid()) then new.adopted_at:=now(); return new; end if;
    if tg_op='INSERT' and auth.role()='authenticated' and auth.uid() is not null then
      delete from app_private.whatsapp_v2_service_binding_permits permit
        where permit.tx_id=txid_current() and permit.unit_id=new.unit_id
          and permit.actor_id=auth.uid() and permit.consumed_at is not null
          and permit.expected_adopted_at is not distinct from new.adopted_at
          and exists(select 1 from public.whatsapp_template_bindings b
            where b.id=permit.binding_id and b.unit_id=new.unit_id
              and b.generation=permit.old_generation
              and b.channel_credential_revision=permit.old_credential_revision
              and b.adopted_at is null and b.dispatch_enabled is false)
        returning true into v_store_adoption;
      if v_store_adoption then new.adopted_at:=now(); return new; end if;
    end if;
    if tg_op='DELETE' and not exists(select from public.units where id=old.unit_id) then return old; end if;
    raise exception 'automation_adoption_immutable' using errcode='23514';
  end if;
  if tg_op='DELETE' then
    if tg_table_name='whatsapp_promotion_slots' and app_private.consume_whatsapp_slot_release(old.id) then return old; end if;
    if tg_table_name in('whatsapp_message_consent_events','whatsapp_message_preference_tokens','whatsapp_promotion_slots') then
      if not exists(select from public.customers where id=old.customer_id and deleted_at is null) or not exists(select from public.units where id=old.unit_id) then return old; end if;
    elsif tg_table_name='whatsapp_template_cost_authorizations' then
      if not exists(select from public.whatsapp_template_accounts where id=old.account_id) then return old; end if;
    end if;
    raise exception 'template_evidence_immutable' using errcode='23514';
  end if;
  if tg_table_name='whatsapp_message_consent_events' then
    -- FK-driven removal of an actor preserves the decision and its SQL revision.
    if old.actor_id is not null and new.actor_id is null and not exists(select from auth.users where id=old.actor_id) and (to_jsonb(new)-'actor_id')=(to_jsonb(old)-'actor_id') then return new; end if;
    raise exception 'template_evidence_immutable' using errcode='23514';
  elsif tg_table_name='whatsapp_template_cost_authorizations' then raise exception 'template_evidence_immutable' using errcode='23514';
  elsif tg_table_name in('whatsapp_template_events','whatsapp_automation_receipt_events') then
    if (to_jsonb(new)-array['processing_state','processed_at']) is distinct from (to_jsonb(old)-array['processing_state','processed_at']) then raise exception 'template_evidence_immutable' using errcode='23514'; end if;
  end if;
  return new;
end $$;
revoke all on function public.guard_whatsapp_template_evidence() from public,anon,authenticated,service_role;

commit;
