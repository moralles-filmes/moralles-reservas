-- Future Datafy connections are enrolled only while this global policy is ON.
-- The existing nine-row approved submission catalog remains the sole authority.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table if not exists app_private.whatsapp_template_auto_policy (
  id integer primary key check (id=1),
  enabled boolean not null default false,
  revision bigint not null default 0 check (revision>=0),
  catalog_digest text not null check (catalog_digest ~ '^[a-f0-9]{64}$'),
  actor_id uuid references auth.users(id) on delete restrict,
  updated_at timestamptz not null default clock_timestamp()
);
alter table app_private.whatsapp_template_auto_policy enable row level security;
alter table app_private.whatsapp_template_auto_policy force row level security;
revoke all on app_private.whatsapp_template_auto_policy from public,anon,authenticated,service_role;
insert into app_private.whatsapp_template_auto_policy(id,enabled,revision,catalog_digest)
values(1,false,0,'a0fb939e3b2023c8f7c49a7f6fe77049fb312f6d274cf67f23e15f3906298965')
on conflict(id) do nothing;

create table if not exists app_private.whatsapp_template_auto_policy_audit (
  revision bigint primary key,
  enabled boolean not null,
  catalog_digest text not null check (catalog_digest ~ '^[a-f0-9]{64}$'),
  actor_id uuid not null references auth.users(id) on delete restrict,
  changed_at timestamptz not null default clock_timestamp()
);
alter table app_private.whatsapp_template_auto_policy_audit enable row level security;
alter table app_private.whatsapp_template_auto_policy_audit force row level security;
revoke all on app_private.whatsapp_template_auto_policy_audit from public,anon,authenticated,service_role;

create table if not exists app_private.whatsapp_template_auto_enrollments (
  onboarding_id uuid primary key references public.whatsapp_datafy_onboardings(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  unit_id uuid not null references public.units(id) on delete cascade,
  channel_id uuid not null unique,
  policy_revision bigint not null check (policy_revision>0),
  catalog_digest text not null check (catalog_digest ~ '^[a-f0-9]{64}$'),
  state text not null default 'pending' check(state in('pending','discovering','ready','needs_review')),
  reason_code text check(reason_code in('connection_pending','health_stale','binding_pending',
    'provider_unavailable','policy_changed','manual_review')),
  attempt_count integer not null default 0 check(attempt_count between 0 and 20),
  next_attempt_at timestamptz not null default clock_timestamp(),
  binding_id uuid,
  binding_generation bigint,
  credential_revision bigint,
  excluded_at timestamptz,
  excluded_by uuid references auth.users(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check((binding_id is null)=(binding_generation is null)),
  check((excluded_at is null)=(excluded_by is null))
);
alter table app_private.whatsapp_template_auto_enrollments enable row level security;
alter table app_private.whatsapp_template_auto_enrollments force row level security;
create index if not exists whatsapp_template_auto_enrollments_due_idx
  on app_private.whatsapp_template_auto_enrollments(next_attempt_at,onboarding_id)
  where excluded_at is null and state in('pending','discovering','needs_review');
revoke all on app_private.whatsapp_template_auto_enrollments from public,anon,authenticated,service_role;

create table if not exists app_private.whatsapp_template_auto_permits (
  id uuid primary key default gen_random_uuid(),
  transaction_id bigint not null,
  binding_id uuid not null,
  onboarding_id uuid not null,
  actor_id uuid not null,
  policy_revision bigint not null,
  catalog_digest text not null,
  generation bigint not null,
  credential_revision bigint not null,
  consumed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  unique(transaction_id,binding_id)
);
alter table app_private.whatsapp_template_auto_permits enable row level security;
alter table app_private.whatsapp_template_auto_permits force row level security;
revoke all on app_private.whatsapp_template_auto_permits from public,anon,authenticated,service_role;

create table if not exists app_private.whatsapp_template_post_confirmations (
  job_id uuid primary key,
  claim_token uuid not null,
  binding_generation bigint not null,
  payload_hash text not null check(payload_hash ~ '^[a-f0-9]{64}$'),
  grant_id uuid not null,
  confirmed_at timestamptz not null default clock_timestamp()
);
alter table app_private.whatsapp_template_post_confirmations enable row level security;
alter table app_private.whatsapp_template_post_confirmations force row level security;
revoke all on app_private.whatsapp_template_post_confirmations from public,anon,authenticated,service_role;

create or replace function public.get_whatsapp_template_auto_policy()
returns jsonb language plpgsql security definer set search_path='' as $$
declare p app_private.whatsapp_template_auto_policy%rowtype;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or not app_private.is_platform_admin(auth.uid()) then
    raise exception 'template_policy_forbidden' using errcode='42501';
  end if;
  select * into p from app_private.whatsapp_template_auto_policy where id=1;
  if not found then raise exception 'template_policy_unavailable' using errcode='PT503'; end if;
  return jsonb_build_object('enabled',p.enabled,'revision',p.revision,
    'catalog_digest',p.catalog_digest,'updated_at',p.updated_at);
end $$;

revoke all on function public.get_whatsapp_template_auto_policy() from public,anon,authenticated,service_role;
grant execute on function public.get_whatsapp_template_auto_policy() to authenticated;

create or replace function public.configure_whatsapp_template_auto_policy(p_enabled boolean,p_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p app_private.whatsapp_template_auto_policy%rowtype; v_digest text;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or not app_private.is_platform_admin(auth.uid()) then
    raise exception 'template_policy_forbidden' using errcode='42501';
  end if;
  if p_enabled is null or p_expected_revision is null then
    raise exception 'template_policy_invalid' using errcode='22023';
  end if;
  select * into p from app_private.whatsapp_template_auto_policy where id=1 for update;
  if not found then raise exception 'template_policy_unavailable' using errcode='PT503'; end if;
  if p.revision is distinct from p_expected_revision then
    raise exception 'template_policy_changed' using errcode='PT409';
  end if;
  if p.enabled is distinct from p_enabled then
    v_digest:=p.catalog_digest;
    if p_enabled then
      v_digest:=app_private.whatsapp_template_approved_catalog_digest();
      if v_digest is null or v_digest is distinct from 'a0fb939e3b2023c8f7c49a7f6fe77049fb312f6d274cf67f23e15f3906298965'
        or not exists(select from public.platform_flags where key='whatsapp_template_catalog' and value='true'::jsonb) then
        raise exception 'template_policy_catalog_unavailable' using errcode='PT503';
      end if;
    end if;
    update app_private.whatsapp_template_auto_policy set enabled=p_enabled,revision=p.revision+1,
      catalog_digest=v_digest,actor_id=auth.uid(),updated_at=clock_timestamp() where id=1 returning * into p;
    insert into app_private.whatsapp_template_auto_policy_audit(revision,enabled,catalog_digest,actor_id)
      values(p.revision,p.enabled,p.catalog_digest,p.actor_id);
  end if;
  return jsonb_build_object('enabled',p.enabled,'revision',p.revision,
    'catalog_digest',p.catalog_digest,'updated_at',p.updated_at);
end $$;
revoke all on function public.configure_whatsapp_template_auto_policy(boolean,bigint) from public,anon,authenticated,service_role;
grant execute on function public.configure_whatsapp_template_auto_policy(boolean,bigint) to authenticated;

-- Template preparation may probe an inactive Datafy channel. The provider GET
-- happens outside SQL, so fence its health write against credential rotation
-- under the same channel row lock. The revision trigger covers every credential
-- and provider mutation; no access token is passed to this RPC or its logs.
create or replace function public.record_whatsapp_template_heartbeat(
  p_unit_id uuid,p_channel_id uuid,p_expected_revision bigint,p_expected_phone_number_id text
) returns boolean language plpgsql security definer set search_path='' as $$
declare c public.whatsapp_channels%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'template_heartbeat_forbidden' using errcode='42501';
  end if;
  if p_unit_id is null or p_channel_id is null or p_expected_revision is null
    or p_expected_phone_number_id is null or p_expected_phone_number_id !~ '^[0-9]{1,64}$' then
    return false;
  end if;
  select * into c from public.whatsapp_channels where id=p_channel_id for update;
  if not found or c.unit_id is distinct from p_unit_id or c.provider<>'datafy'
    or c.template_credential_revision is distinct from p_expected_revision
    or c.credentials->>'phone_number_id' is distinct from p_expected_phone_number_id then
    return false;
  end if;
  perform 1 from public.record_whatsapp_channel_status(
    p_unit_id,p_channel_id,'connected',null,null,null,null,null);
  return true;
end $$;
revoke all on function public.record_whatsapp_template_heartbeat(uuid,uuid,bigint,text)
  from public,anon,authenticated,service_role;
grant execute on function public.record_whatsapp_template_heartbeat(uuid,uuid,bigint,text) to service_role;

create or replace function app_private.enroll_new_datafy_template_onboarding()
returns trigger language plpgsql security definer set search_path='' as $$
declare p app_private.whatsapp_template_auto_policy%rowtype;
begin
  select * into p from app_private.whatsapp_template_auto_policy where id=1 for share;
  if p.enabled and p.actor_id is not null and p.catalog_digest=app_private.whatsapp_template_approved_catalog_digest() then
    insert into app_private.whatsapp_template_auto_enrollments
      (onboarding_id,organization_id,unit_id,channel_id,policy_revision,catalog_digest)
    values(new.id,new.organization_id,new.unit_id,new.reserved_channel_id,p.revision,p.catalog_digest);
  end if;
  return new;
end $$;
revoke all on function app_private.enroll_new_datafy_template_onboarding() from public,anon,authenticated,service_role;
drop trigger if exists enroll_new_datafy_template_onboarding on public.whatsapp_datafy_onboardings;
create trigger enroll_new_datafy_template_onboarding after insert on public.whatsapp_datafy_onboardings
  for each row execute function app_private.enroll_new_datafy_template_onboarding();

create or replace function public.get_whatsapp_template_preparation(p_unit_id uuid,p_channel_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p app_private.whatsapp_template_auto_policy%rowtype;
  e app_private.whatsapp_template_auto_enrollments%rowtype;
  v_ready_valid boolean:=true;
begin
  if p_unit_id is null or p_channel_id is null then return null; end if;
  select * into e from app_private.whatsapp_template_auto_enrollments
    where channel_id=p_channel_id and unit_id=p_unit_id;
  if not exists(select from public.whatsapp_channels c
      where c.id=p_channel_id and c.unit_id=p_unit_id and c.provider='datafy')
    and (e.onboarding_id is null or not exists(select from public.whatsapp_datafy_onboardings o
      where o.id=e.onboarding_id and o.unit_id=p_unit_id and o.reserved_channel_id=p_channel_id)) then
    return null;
  end if;
  select * into p from app_private.whatsapp_template_auto_policy where id=1;
  if not found then return null; end if;
  if e.state='ready' then
    select exists(
      select from public.whatsapp_template_bindings b
      join public.whatsapp_channels c on c.id=b.channel_id
      join app_private.whatsapp_template_submission_grants g on g.binding_id=b.id and g.revoked_at is null
      where b.id=e.binding_id and b.channel_id=e.channel_id and b.unit_id=e.unit_id
        and b.generation=e.binding_generation and b.channel_credential_revision=e.credential_revision
        and c.template_credential_revision=e.credential_revision
        and g.origin='auto' and g.policy_revision=e.policy_revision and g.catalog_digest=e.catalog_digest
        and (g.channel_id,g.unit_id,g.account_id,g.binding_generation,g.credential_revision)
          =(b.channel_id,b.unit_id,b.account_id,b.generation,b.channel_credential_revision)
    ) into v_ready_valid;
  end if;
  return jsonb_build_object(
    'enrollment',case when e.excluded_at is not null then 'excluded'
      when e.onboarding_id is null or e.policy_revision<>p.revision or e.catalog_digest<>p.catalog_digest then 'legacy'
      when not p.enabled then 'disabled' else 'eligible' end,
    'onboarding_id',e.onboarding_id,'organization_id',e.organization_id,
    'onboarding_state',(select o.state from public.whatsapp_datafy_onboardings o where o.id=e.onboarding_id),
    'state',case when e.state='ready' and not v_ready_valid then 'needs_review' else e.state end,
    'reason_code',case when e.state='ready' and not v_ready_valid then 'manual_review' else e.reason_code end,
    'updated_at',e.updated_at,'next_attempt_at',e.next_attempt_at,
    'policy_revision',e.policy_revision,
    'binding_id',e.binding_id);
end $$;
revoke all on function public.get_whatsapp_template_preparation(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_whatsapp_template_preparation(uuid,uuid) to service_role;

create or replace function public.claim_due_whatsapp_template_preparations(p_limit integer)
returns table(onboarding_id uuid,channel_id uuid,unit_id uuid,organization_id uuid,credential_revision bigint)
language plpgsql security definer set search_path='' as $$
declare p app_private.whatsapp_template_auto_policy%rowtype;
begin
  if p_limit is null or p_limit<1 or p_limit>20 then
    raise exception 'template_auto_limit_invalid' using errcode='22023';
  end if;
  select * into p from app_private.whatsapp_template_auto_policy where id=1 for share;
  if not found or not p.enabled or p.catalog_digest is distinct from app_private.whatsapp_template_approved_catalog_digest()
    or not exists(select from public.platform_flags where key='whatsapp_template_catalog' and value='true'::jsonb) then
    return;
  end if;
  return query
  with due as (
    select e.onboarding_id from app_private.whatsapp_template_auto_enrollments e
    join public.whatsapp_datafy_onboardings o on o.id=e.onboarding_id
    join public.whatsapp_channels c on c.id=e.channel_id
    where e.policy_revision=p.revision and e.catalog_digest=p.catalog_digest and e.excluded_at is null
      and e.state in('pending','discovering','ready') and e.next_attempt_at<=clock_timestamp()
      and o.state='completed' and o.reserved_channel_id=e.channel_id
      and (o.organization_id,o.unit_id)=(e.organization_id,e.unit_id)
      and c.unit_id=e.unit_id and c.provider='datafy'
      and (c.status='connected' or (c.is_active is distinct from true and c.status in('provider_error','disconnected')))
      and (e.state<>'ready' or (c.is_active is distinct from true
        and (e.reason_code is not null or c.status<>'connected' or c.last_health_check_at is null
          or c.last_health_check_at<=clock_timestamp()-interval '3 minutes')
        and c.template_credential_revision=e.credential_revision
        and exists(select from public.whatsapp_template_bindings b
          join app_private.whatsapp_template_submission_grants g
            on g.binding_id=b.id and g.revoked_at is null
          where b.id=e.binding_id and b.channel_id=e.channel_id and b.unit_id=e.unit_id
            and b.generation=e.binding_generation and b.channel_credential_revision=e.credential_revision
            and g.origin='auto' and g.policy_revision=e.policy_revision and g.catalog_digest=e.catalog_digest)))
    order by e.next_attempt_at,e.onboarding_id
    limit p_limit for update of e skip locked
  ), changed as (
    update app_private.whatsapp_template_auto_enrollments e
      set state=case when e.state='ready' then 'ready'
        when e.attempt_count>=20 then 'needs_review' else 'discovering' end,
      reason_code=case when e.state='ready' then e.reason_code
        when e.attempt_count>=20 then 'manual_review' else null end,
      attempt_count=case when e.state='ready' then e.attempt_count else least(20,e.attempt_count+1) end,
      next_attempt_at=case when e.state<>'ready' and e.attempt_count>=20 then 'infinity'::timestamptz
        else clock_timestamp()+interval '2 minutes' end,
      updated_at=clock_timestamp()
    from due where e.onboarding_id=due.onboarding_id
    returning e.onboarding_id,e.channel_id,e.unit_id,e.organization_id,e.state
  )
  select changed.onboarding_id,changed.channel_id,changed.unit_id,changed.organization_id,c.template_credential_revision
    from changed join public.whatsapp_channels c on c.id=changed.channel_id
    where changed.state in('discovering','ready');
end $$;
revoke all on function public.claim_due_whatsapp_template_preparations(integer) from public,anon,authenticated,service_role;
grant execute on function public.claim_due_whatsapp_template_preparations(integer) to service_role;

create or replace function public.mark_whatsapp_template_preparation(
  p_onboarding_id uuid,p_channel_id uuid,p_state text,p_reason_code text)
returns boolean language plpgsql security definer set search_path='' as $$
declare p app_private.whatsapp_template_auto_policy%rowtype;
  e app_private.whatsapp_template_auto_enrollments%rowtype;
  v_delay integer;
begin
  if p_state is null or p_state not in('pending','discovering','ready','needs_review')
    or (p_reason_code is not null and p_reason_code not in('connection_pending','health_stale',
      'binding_pending','provider_unavailable','policy_changed','manual_review')) then
    raise exception 'template_auto_status_invalid' using errcode='22023';
  end if;
  select * into p from app_private.whatsapp_template_auto_policy where id=1 for share;
  if not found or not p.enabled or p.catalog_digest is distinct from app_private.whatsapp_template_approved_catalog_digest() then return false; end if;
  select * into e from app_private.whatsapp_template_auto_enrollments
    where onboarding_id=p_onboarding_id and channel_id=p_channel_id for update;
  if not found or e.excluded_at is not null or (e.policy_revision,e.catalog_digest) is distinct from (p.revision,p.catalog_digest)
    or not exists(select from public.whatsapp_datafy_onboardings o where o.id=e.onboarding_id
      and (o.organization_id,o.unit_id,o.reserved_channel_id)=(e.organization_id,e.unit_id,e.channel_id)) then
    return false;
  end if;
  if (e.state='needs_review' and p_state<>'needs_review')
    or (e.state='ready' and p_state not in('ready','needs_review')) then
    return false;
  end if;
  if p_state='ready' and not exists(
    select from public.whatsapp_template_bindings b
    join public.whatsapp_channels c on c.id=b.channel_id
    join app_private.whatsapp_template_submission_grants g on g.binding_id=b.id and g.revoked_at is null
    where b.id=e.binding_id and b.channel_id=e.channel_id and b.unit_id=e.unit_id
      and b.generation=e.binding_generation and b.channel_credential_revision=e.credential_revision
      and c.template_credential_revision=e.credential_revision
      and g.origin='auto' and g.policy_revision=e.policy_revision and g.catalog_digest=e.catalog_digest
      and (g.channel_id,g.unit_id,g.account_id,g.binding_generation,g.credential_revision)
        =(b.channel_id,b.unit_id,b.account_id,b.generation,b.channel_credential_revision)) then
    return false;
  end if;
  v_delay:=least(3600,30*(2^least(e.attempt_count,7))::integer);
  update app_private.whatsapp_template_auto_enrollments set state=p_state,reason_code=p_reason_code,
    next_attempt_at=case when p_state='pending' then clock_timestamp()+make_interval(secs=>v_delay)
      when p_state='discovering' then clock_timestamp()+interval '2 minutes'
      when p_state='ready' and p_reason_code is not null then clock_timestamp()+interval '2 minutes'
      when p_state='ready' then clock_timestamp()+interval '3 minutes'
      else 'infinity'::timestamptz end,
    updated_at=clock_timestamp() where onboarding_id=e.onboarding_id;
  return true;
end $$;
revoke all on function public.mark_whatsapp_template_preparation(uuid,uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.mark_whatsapp_template_preparation(uuid,uuid,text,text) to service_role;

-- The grant ledger records one immutable policy revision for auto origin.
alter table app_private.whatsapp_template_submission_grants
  add column if not exists policy_revision bigint;
alter table app_private.whatsapp_template_submission_grants
  drop constraint if exists whatsapp_template_submission_grants_origin_check;
alter table app_private.whatsapp_template_submission_grants
  add constraint whatsapp_template_submission_grants_origin_check
  check((origin='manual' and policy_revision is null) or (origin='auto' and policy_revision>0));

create or replace function app_private.consume_whatsapp_template_auto_permit(
  p_binding_id uuid,p_generation bigint,p_credential_revision bigint,p_actor_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_id uuid;
begin
  update app_private.whatsapp_template_auto_permits set consumed_at=clock_timestamp()
    where transaction_id=txid_current() and binding_id=p_binding_id and generation=p_generation
      and credential_revision=p_credential_revision and actor_id=p_actor_id and consumed_at is null
    returning id into v_id;
  return v_id is not null;
end $$;
revoke all on function app_private.consume_whatsapp_template_auto_permit(uuid,bigint,bigint,uuid) from public,anon,authenticated,service_role;

create or replace function public.authorize_whatsapp_template_auto_channel(
  p_onboarding_id uuid,p_binding_id uuid,p_generation bigint,p_credential_revision bigint)
returns boolean language plpgsql security definer set search_path='' as $$
declare p app_private.whatsapp_template_auto_policy%rowtype;
  e app_private.whatsapp_template_auto_enrollments%rowtype;
  o public.whatsapp_datafy_onboardings%rowtype;
  a public.whatsapp_template_accounts%rowtype;
  b public.whatsapp_template_bindings%rowtype;
  c public.whatsapp_channels%rowtype;
  v_permit uuid;
begin
  if p_onboarding_id is null or p_binding_id is null or p_generation is null or p_credential_revision is null then return false; end if;
  select * into p from app_private.whatsapp_template_auto_policy where id=1 for share;
  if not found or not p.enabled or p.actor_id is null or p.catalog_digest is distinct from app_private.whatsapp_template_approved_catalog_digest()
    or not exists(select from public.platform_flags where key='whatsapp_template_catalog' and value='true'::jsonb) then return false; end if;
  select * into e from app_private.whatsapp_template_auto_enrollments where onboarding_id=p_onboarding_id for update;
  if not found or e.excluded_at is not null or e.state not in('pending','discovering','ready')
    or (e.policy_revision,e.catalog_digest) is distinct from (p.revision,p.catalog_digest) then return false; end if;
  select * into o from public.whatsapp_datafy_onboardings where id=e.onboarding_id for share;
  if not found or o.state<>'completed' or (o.organization_id,o.unit_id,o.reserved_channel_id)
    is distinct from (e.organization_id,e.unit_id,e.channel_id) then return false; end if;
  select * into b from public.whatsapp_template_bindings where id=p_binding_id;
  if not found or b.account_id is null then return false; end if;
  select * into a from public.whatsapp_template_accounts where id=b.account_id for share;
  select * into b from public.whatsapp_template_bindings where id=p_binding_id for update;
  select * into c from public.whatsapp_channels where id=b.channel_id for share;
  if a.id is null or a.id is distinct from b.account_id or c.id is null
    or a.organization_id is distinct from e.organization_id
    or a.waba_id !~ '^[0-9]{1,64}$' or a.verified_at is null
    or (b.channel_id,b.unit_id,b.provider,b.generation,b.channel_credential_revision)
      is distinct from (e.channel_id,e.unit_id,'datafy',p_generation,p_credential_revision)
    or b.verified_at is null or c.unit_id is distinct from e.unit_id or c.provider<>'datafy'
    or c.template_credential_revision is distinct from p_credential_revision
    or c.credentials->>'phone_number_id' is null or c.credentials->>'phone_number_id' !~ '^[0-9]{1,64}$'
    or c.status<>'connected' or c.last_health_check_at is null
    or c.last_health_check_at<clock_timestamp()-interval '5 minutes'
    or not exists(select from public.units u where u.id=e.unit_id and u.organization_id=e.organization_id) then return false; end if;
  if b.submission_authorized_at is not null then
    return exists(select from app_private.whatsapp_template_submission_grants g
      where g.binding_id=b.id and g.revoked_at is null and g.origin='auto'
        and g.policy_revision=p.revision and g.catalog_digest=p.catalog_digest
        and (g.channel_id,g.unit_id,g.account_id,g.binding_generation,g.credential_revision,g.actor_id)
          =(b.channel_id,b.unit_id,b.account_id,b.generation,b.channel_credential_revision,p.actor_id));
  end if;
  if e.state='ready' then return false; end if;
  if exists(select from app_private.whatsapp_template_submission_grants g where g.binding_id=b.id and g.revoked_at is null) then return false; end if;
  insert into app_private.whatsapp_template_auto_permits
    (transaction_id,binding_id,onboarding_id,actor_id,policy_revision,catalog_digest,generation,credential_revision)
    values(txid_current(),b.id,e.onboarding_id,p.actor_id,p.revision,p.catalog_digest,b.generation,b.channel_credential_revision)
    returning id into v_permit;
  update public.whatsapp_template_bindings set submission_authorized_at=clock_timestamp(),submission_authorized_by=p.actor_id
    where id=b.id and submission_authorized_at is null;
  if not found then raise exception 'template_auto_binding_changed' using errcode='PT409'; end if;
  update app_private.whatsapp_template_auto_enrollments set binding_id=b.id,binding_generation=b.generation,
    credential_revision=b.channel_credential_revision,updated_at=clock_timestamp() where onboarding_id=e.onboarding_id;
  delete from app_private.whatsapp_template_auto_permits where id=v_permit and consumed_at is not null;
  if not found then raise exception 'template_auto_permit_not_consumed' using errcode='PT409'; end if;
  return true;
end $$;
revoke all on function public.authorize_whatsapp_template_auto_channel(uuid,uuid,bigint,bigint) from public,anon,authenticated,service_role;
grant execute on function public.authorize_whatsapp_template_auto_channel(uuid,uuid,bigint,bigint) to service_role;

create or replace function app_private.capture_whatsapp_template_manual_grant()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_digest text; v_permit app_private.whatsapp_template_auto_permits%rowtype;
begin
  if old.submission_authorized_at is null and new.submission_authorized_at is not null then
    v_digest:=app_private.whatsapp_template_approved_catalog_digest();
    if v_digest is null or new.provider<>'datafy' or new.account_id is null then
      raise exception 'template_submission_grant_denied' using errcode='42501';
    end if;
    if auth.role()='authenticated' and auth.uid() is not null and app_private.is_platform_admin(auth.uid())
      and new.submission_authorized_by=auth.uid() then
      insert into app_private.whatsapp_template_submission_grants
        (binding_id,channel_id,unit_id,account_id,binding_generation,credential_revision,catalog_digest,origin,actor_id,granted_at)
      values(new.id,new.channel_id,new.unit_id,new.account_id,new.generation,new.channel_credential_revision,
        v_digest,'manual',auth.uid(),new.submission_authorized_at);
    elsif auth.role()='service_role' then
      select * into v_permit from app_private.whatsapp_template_auto_permits
        where transaction_id=txid_current() and binding_id=new.id and consumed_at is not null;
      if not found or (v_permit.actor_id,v_permit.generation,v_permit.credential_revision,v_permit.catalog_digest)
        is distinct from (new.submission_authorized_by,new.generation,new.channel_credential_revision,v_digest)
        or not exists(select from app_private.whatsapp_template_auto_enrollments e
          where e.onboarding_id=v_permit.onboarding_id and e.channel_id=new.channel_id and e.unit_id=new.unit_id
            and e.policy_revision=v_permit.policy_revision and e.excluded_at is null) then
        raise exception 'template_submission_grant_denied' using errcode='42501';
      end if;
      insert into app_private.whatsapp_template_submission_grants
        (binding_id,channel_id,unit_id,account_id,binding_generation,credential_revision,catalog_digest,origin,actor_id,policy_revision,granted_at)
      values(new.id,new.channel_id,new.unit_id,new.account_id,new.generation,new.channel_credential_revision,
        v_digest,'auto',v_permit.actor_id,v_permit.policy_revision,new.submission_authorized_at);
    else
      raise exception 'template_submission_grant_denied' using errcode='42501';
    end if;
  elsif old.submission_authorized_at is not null and new.submission_authorized_at is null then
    update app_private.whatsapp_template_submission_grants set revoked_at=clock_timestamp()
      where binding_id=old.id and revoked_at is null;
    if auth.role()='authenticated' and auth.uid() is not null and app_private.is_platform_admin(auth.uid()) then
      update app_private.whatsapp_template_auto_enrollments set excluded_at=clock_timestamp(),excluded_by=auth.uid(),
        state='needs_review',reason_code='manual_review',updated_at=clock_timestamp()
        where channel_id=old.channel_id and excluded_at is null;
    end if;
  end if;
  return new;
end $$;
revoke all on function app_private.capture_whatsapp_template_manual_grant() from public,anon,authenticated,service_role;

-- Existing scope guard with one-use typed auto permit only in catalog transition.
create or replace function public.guard_whatsapp_template_scope()
returns trigger language plpgsql security definer set search_path='' as $$
declare
  v_org uuid; v_customer_org uuid; v_deleted timestamptz;
  v_binding public.whatsapp_template_bindings%rowtype;
  v_channel public.whatsapp_channels%rowtype;
  v_remote public.whatsapp_remote_templates%rowtype;
  v_job public.whatsapp_automation_jobs%rowtype;
  v_resource_unit uuid; v_resource_customer uuid; v_resource_invalid boolean:=false; v_reset boolean:=false; v_erasure boolean:=false;
  v_initialize boolean:=false; v_revalidate boolean:=false; v_catalog_revalidate boolean:=false; v_exclusive_stop boolean:=false; v_auto_submission boolean:=false; v_logical text; v_selected uuid;
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
      if not v_auto_submission and (auth.role() is distinct from 'authenticated' or auth.uid() is null or not app_private.is_platform_admin(auth.uid())) then
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

-- A manual catalog stop also excludes an enrolled channel with no active grant.
create or replace function public.release_whatsapp_template_channel(p_channel_id uuid,p_scope text,p_enabled boolean,p_expected_credential_revision bigint,p_expected_binding_generation bigint)
returns boolean language plpgsql security definer set search_path='' as $$
declare b public.whatsapp_template_bindings%rowtype; c public.whatsapp_channels%rowtype;
  v_binding uuid; v_account uuid; v_unit uuid; v_org uuid; v_selected uuid; v_now timestamptz;
  v_enrollment_id uuid;
begin
  perform app_private.require_whatsapp_template_manager(null,true);
  if p_scope is null or p_scope not in('catalog','dispatch') or p_enabled is null or p_expected_credential_revision is null or p_expected_credential_revision<0 then raise exception 'template_management_invalid' using errcode='22023'; end if;
  select ch.unit_id,u.organization_id into v_unit,v_org from public.whatsapp_channels ch join public.units u on u.id=ch.unit_id where ch.id=p_channel_id;
  if not found then raise exception 'template_management_forbidden' using errcode='42501'; end if;
  -- Match the auto-grant lock order (enrollment, then binding). A stop that wins
  -- this lock excludes the channel before WABA discovery can authorize it.
  if p_scope='catalog' and not p_enabled then
    select e.onboarding_id into v_enrollment_id
      from app_private.whatsapp_template_auto_enrollments e
      where e.channel_id=p_channel_id and e.unit_id=v_unit for update;
  end if;
  select id,account_id into v_binding,v_account from public.whatsapp_template_bindings where channel_id=p_channel_id;
  if v_account is not null then
    perform 1 from public.whatsapp_template_accounts where id=v_account and organization_id=v_org for share;
    if not found then raise exception 'template_management_forbidden' using errcode='42501'; end if;
  end if;
  if v_binding is not null then
    select * into b from public.whatsapp_template_bindings where id=v_binding for update;
    if not found or (b.account_id,b.channel_id,b.unit_id) is distinct from (v_account,p_channel_id,v_unit) then raise exception 'template_configuration_changed' using errcode='PT409'; end if;
  end if;
  select * into c from public.whatsapp_channels where id=p_channel_id for share;
  if not found or c.unit_id is distinct from v_unit or not exists(select from public.units where id=v_unit and organization_id=v_org) then raise exception 'template_management_forbidden' using errcode='42501'; end if;
  if c.template_credential_revision is distinct from p_expected_credential_revision then raise exception 'template_configuration_changed' using errcode='PT409'; end if;
  if v_binding is null then
    if exists(select from public.whatsapp_template_bindings where channel_id=p_channel_id) then raise exception 'template_configuration_changed' using errcode='PT409'; end if;
    if not p_enabled then
      if p_scope='catalog' and v_enrollment_id is not null then
        if p_expected_binding_generation is not null then raise exception 'template_configuration_changed' using errcode='PT409'; end if;
        update app_private.whatsapp_template_auto_enrollments
          set excluded_at=clock_timestamp(),excluded_by=auth.uid(),state='needs_review',
            reason_code='manual_review',next_attempt_at='infinity'::timestamptz,updated_at=clock_timestamp()
          where onboarding_id=v_enrollment_id and excluded_at is null;
        if found then
          insert into public.audit_log(table_name,record_id,action,new_values,actor_id,unit_id,organization_id)
          values('whatsapp_template_auto_enrollments',v_enrollment_id::text,'UPDATE',
            jsonb_build_object('scope','catalog','enabled',false,'before_binding',true),auth.uid(),v_unit,v_org);
        end if;
        return true;
      end if;
      return false;
    end if;
    if p_expected_binding_generation is not null or p_scope<>'dispatch' or c.provider not in('zapi','waha','uazapi') then return false; end if;
  elsif p_expected_binding_generation is null or b.generation is distinct from p_expected_binding_generation then raise exception 'template_configuration_changed' using errcode='PT409'; end if;
  if not p_enabled then
    -- No flags, health, secret or provider equality are authority to prevent stop.
    if p_scope='catalog' and b.submission_authorized_at is null and b.submission_authorized_by is null then
      update app_private.whatsapp_template_auto_enrollments set excluded_at=clock_timestamp(),excluded_by=auth.uid(),
        state='needs_review',reason_code='manual_review',updated_at=clock_timestamp()
        where channel_id=c.id and excluded_at is null;
      return true;
    end if;
    if p_scope='dispatch' and not b.dispatch_enabled then return true; end if;
    if p_scope='dispatch' then update public.whatsapp_template_bindings set dispatch_enabled=false where id=b.id;
    else update public.whatsapp_template_bindings set submission_authorized_at=null,submission_authorized_by=null where id=b.id; end if;
  else
    v_now:=clock_timestamp();
    if c.status<>'connected' or c.last_health_check_at is null or c.last_health_check_at<v_now-interval '5 minutes' then return false; end if;
    if p_scope='dispatch' then
      select id into v_selected from public.whatsapp_channels ch where ch.unit_id=v_unit and (ch.is_active=true or (ch.is_active is null and ch.status='connected' and not exists(select from public.whatsapp_channels x where x.unit_id=v_unit and x.is_active=true))) order by ch.is_active desc nulls last,ch.created_at,ch.id limit 1;
      if v_selected is distinct from c.id or c.provider not in('zapi','waha','uazapi','datafy') then return false; end if;
      -- Deliberate SQL twin of WEBHOOK_SIGNATURE_SCHEME channel_secret providers.
      if c.provider in('zapi','waha','uazapi') and (c.webhook_secret is null or btrim(c.webhook_secret)='') then return false; end if;
    elsif c.provider<>'datafy' then return false; end if;
    if b.id is null then
      begin
        insert into public.whatsapp_template_bindings(unit_id,channel_id,provider,account_id,channel_credential_revision,verified_at)
        values(v_unit,c.id,c.provider,null,c.template_credential_revision,v_now) returning * into b;
      exception when unique_violation then raise exception 'template_configuration_changed' using errcode='PT409'; end;
    else
      if (b.provider,b.channel_credential_revision) is distinct from (c.provider,c.template_credential_revision) then return false; end if;
      if c.provider in('zapi','waha','uazapi') and b.account_id is null and b.verified_at is null then
        update public.whatsapp_template_bindings set verified_at=v_now where id=b.id returning * into b;
      end if;
      if b.verified_at is null or (c.provider='datafy' and b.account_id is null) then return false; end if;
    end if;
    if p_scope='dispatch' then
      if b.dispatch_enabled then return true; end if;
      update public.whatsapp_template_bindings set dispatch_enabled=true,adopted_at=coalesce(adopted_at,v_now) where id=b.id;
    else
      if b.submission_authorized_at is not null then return true; end if;
      update public.whatsapp_template_bindings set submission_authorized_at=v_now,submission_authorized_by=auth.uid() where id=b.id;
    end if;
  end if;
  insert into public.audit_log(table_name,record_id,action,new_values,actor_id,unit_id,organization_id)
  values('whatsapp_template_bindings',b.id::text,'UPDATE',jsonb_build_object('scope',p_scope,'enabled',p_enabled,'generation',b.generation),auth.uid(),v_unit,v_org);
  return true;
end $$;

-- Manual grants remain independent of the global policy; auto grants require its exact revision.
create or replace function app_private.whatsapp_template_submission_gate(
  p_job_id uuid,p_fence uuid,p_generation bigint,p_payload_hash text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_digest text;
begin
  if p_payload_hash is null or p_payload_hash !~ '^[a-f0-9]{64}$' then return false; end if;
  v_digest := app_private.whatsapp_template_approved_catalog_digest();
  if v_digest is null then return false; end if;
  return exists (
    select 1 from public.whatsapp_template_jobs j
    join public.whatsapp_remote_templates t on t.account_id=j.account_id
      and t.logical_id=j.target_key and t.version=1 and t.language='pt_BR'
    join app_private.whatsapp_template_approved_submissions ap on ap.logical_id=t.logical_id
      and (ap.version,ap.language,ap.requested_category,ap.desired_hash,ap.payload_hash)
      = (t.version,t.language,t.requested_category,t.desired_hash,p_payload_hash)
    join public.whatsapp_template_bindings b on b.id=j.binding_id
    join public.whatsapp_channels c on c.id=b.channel_id
    join public.whatsapp_template_accounts a on a.id=j.account_id
    join public.units u on u.id=b.unit_id
    join app_private.whatsapp_template_submission_grants g on g.binding_id=b.id and g.revoked_at is null
    left join app_private.whatsapp_template_auto_policy p on p.id=1
    where j.id=p_job_id and j.operation='provision' and j.claim_token=p_fence
      and j.binding_generation=p_generation and b.generation=p_generation
      and b.submission_authorized_at is not null and b.submission_authorized_by=g.actor_id
      and b.verified_at is not null and b.provider='datafy' and c.provider='datafy' and c.status='connected'
      and c.last_health_check_at >= clock_timestamp()-interval '5 minutes'
      and (b.channel_id,b.unit_id,b.account_id,b.channel_credential_revision)
        = (g.channel_id,g.unit_id,g.account_id,g.credential_revision)
      and b.channel_credential_revision=c.template_credential_revision
      and (b.account_id,b.generation)=(j.account_id,g.binding_generation)
      and (u.organization_id,a.organization_id)=(a.organization_id,j.organization_id)
      and g.catalog_digest=v_digest
      and ((g.origin='manual' and g.policy_revision is null)
        or (g.origin='auto' and p.enabled and p.revision=g.policy_revision
          and p.catalog_digest=g.catalog_digest and p.actor_id=g.actor_id
          and exists(select from app_private.whatsapp_template_auto_enrollments e
            join public.whatsapp_datafy_onboardings o on o.id=e.onboarding_id
            where e.binding_id=b.id and e.channel_id=b.channel_id and e.unit_id=b.unit_id
              and e.organization_id=a.organization_id and e.binding_generation=b.generation
              and e.credential_revision=b.channel_credential_revision
              and e.excluded_at is null and e.policy_revision=p.revision and e.catalog_digest=p.catalog_digest
              and o.state='completed' and (o.organization_id,o.unit_id,o.reserved_channel_id)
                =(e.organization_id,e.unit_id,e.channel_id))))
      and t.name=t.logical_id and t.binding_generation=a.binding_generation
      and j.claimed_until>clock_timestamp()
      and exists(select from public.platform_flags where key='whatsapp_template_catalog' and value='true'::jsonb)
  );
end $$;
revoke all on function app_private.whatsapp_template_submission_gate(uuid,uuid,bigint,text) from public,anon,authenticated,service_role;

-- A confirmed job is never prepared for a second POST, even after a local finish error.
create or replace function public.prepare_whatsapp_template_provision(p_job_id uuid,p_fence uuid,p_generation bigint,p_payload_hash text)
returns boolean language plpgsql security definer set search_path='' as $$
declare j public.whatsapp_template_jobs%rowtype; b public.whatsapp_template_bindings%rowtype; a public.whatsapp_template_accounts%rowtype;
  c public.whatsapp_channels%rowtype; t public.whatsapp_remote_templates%rowtype; v_now timestamptz; v_authorization uuid;
begin
  select * into j from public.whatsapp_template_jobs where id=p_job_id;
  if not found then return false; end if;
  select * into a from public.whatsapp_template_accounts where id=j.account_id for share;
  select * into b from public.whatsapp_template_bindings where id=j.binding_id for share;
  select * into c from public.whatsapp_channels where id=b.channel_id for share;
  select * into t from public.whatsapp_remote_templates where account_id=a.id and logical_id=j.target_key and version=1 and language='pt_BR' for update;
  select * into j from public.whatsapp_template_jobs where id=p_job_id for update;
  v_now:=clock_timestamp();
  if j.state<>'claimed' or j.claim_token is distinct from p_fence or j.claimed_until<=v_now or j.posting_started_at is not null
    or exists(select from app_private.whatsapp_template_post_confirmations where job_id=j.id) then return false; end if;
  if j.operation<>'provision' or b.id is null or a.id is null or c.id is null or t.id is null or t.name<>t.logical_id
    or (b.account_id,b.generation) is distinct from (j.account_id,j.binding_generation) or p_generation is distinct from b.generation
    or b.verified_at is null or b.channel_credential_revision is distinct from c.template_credential_revision
    or (c.unit_id,c.provider) is distinct from (b.unit_id,b.provider) then
    update public.whatsapp_template_jobs set state='needs_review',error_code='binding_changed' where id=j.id; return false;
  end if;
  if j.target_key not in('res_confirmacao_v1','res_confirmacao_desconto_v1','res_lembrete_dia_v1','res_pesquisa_reserva_v1','fila_entrada_v1','fila_feedback_v1','mkt_voucher_programado_v1','fila_mesa_pronta_v1','res_cancelada_v1') then return false; end if;
  if a.sync_capture_id is null or a.last_sync_published_at is null or exists(select from public.whatsapp_remote_templates where account_id=a.id and sync_required) then return false; end if;
  if t.sync_required or t.binding_generation<>a.binding_generation or t.last_synced_at is null or t.last_synced_at<v_now-interval '60 seconds' then return false; end if;
  if t.remote_id is not null and t.observed_hash=t.desired_hash and t.effective_category=t.requested_category then
    update public.whatsapp_template_jobs set state='done',error_code='existing_template',finished_at=v_now where id=j.id;
    return false;
  end if;
  -- Durable evidence can authorize only this same job/target and one later prepare.
  select ra.id into v_authorization from app_private.whatsapp_template_revalidation_authorizations ra
    join app_private.whatsapp_template_zero_post_evidence e on e.id=ra.evidence_id
    where ra.job_id=j.id and ra.consumed_at is null and j.attempts=0 and j.provider_outcome is null
      and (ra.account_id,ra.target_template_id,ra.target_key,ra.target_hash,ra.job_revision,ra.binding_id,ra.binding_generation)
        is not distinct from (j.account_id,t.id,j.target_key,t.desired_hash,j.revision,j.binding_id,j.binding_generation)
      and (e.job_id,e.account_id,e.target_template_id,e.target_key,e.target_hash,e.job_revision,e.first_submission_attempted_at)
        is not distinct from (j.id,j.account_id,t.id,j.target_key,t.desired_hash,j.revision,t.submission_attempted_at);
  if t.remote_id is not null or t.remote_status<>'UNKNOWN' or t.observed_hash is not null
    or (t.submission_attempted_at is not null and v_authorization is null and not(j.attempts>0 and j.provider_outcome='rejected' and j.error_code='documented_preproxy_429'))
    or exists(select from public.whatsapp_template_jobs other where other.account_id=j.account_id and other.operation='provision'
      and other.target_key=j.target_key and other.id<>j.id and (other.posting_started_at is not null or other.provider_outcome is not null)) then
    update public.whatsapp_template_jobs set state='needs_review',error_code='submission_history_protected' where id=j.id; return false;
  end if;
  if b.submission_authorized_at is null or b.provider<>'datafy' or not exists(select from public.platform_flags where key='whatsapp_template_catalog' and value='true'::jsonb)
    or c.status<>'connected' or c.last_health_check_at is null or c.last_health_check_at<v_now-interval '5 minutes' then
    update public.whatsapp_template_jobs set state='paused',error_code='submission_paused' where id=j.id; return false;
  end if;
  if not app_private.whatsapp_template_submission_gate(p_job_id,p_fence,p_generation,p_payload_hash) then return false; end if;
  if v_authorization is not null then
    update app_private.whatsapp_template_revalidation_authorizations set consumed_at=v_now,consumed_claim_token=p_fence where id=v_authorization and consumed_at is null;
    if not found then raise exception 'template_management_authorization_consumed' using errcode='PT409'; end if;
  end if;
  update public.whatsapp_remote_templates set submission_attempted_at=coalesce(submission_attempted_at,v_now),local_status='submitting' where id=t.id;
  update public.whatsapp_template_jobs set state='posting',post_capture_id=a.sync_capture_id,posting_started_at=v_now,claimed_until=v_now+interval '90 seconds',attempts=attempts+1 where id=j.id and claim_token=p_fence;
  return true;
end $$;
revoke all on function public.prepare_whatsapp_template_provision(uuid,uuid,bigint,text) from public,anon,authenticated,service_role;
grant execute on function public.prepare_whatsapp_template_provision(uuid,uuid,bigint,text) to service_role;

-- A single committed confirmation is the irrevocable intent for exactly one job.
create or replace function public.confirm_whatsapp_template_post(p_job_id uuid,p_fence uuid,p_generation bigint,p_payload_hash text)
returns boolean language plpgsql security definer set search_path='' as $$
declare j public.whatsapp_template_jobs%rowtype; a public.whatsapp_template_accounts%rowtype;
  b public.whatsapp_template_bindings%rowtype; c public.whatsapp_channels%rowtype;
  gb public.whatsapp_template_bindings%rowtype; gc public.whatsapp_channels%rowtype;
  t public.whatsapp_remote_templates%rowtype; v_now timestamptz; v_grant uuid; v_confirmed uuid;
begin
  -- This lock serializes a confirmation against global policy revocation.
  perform 1 from app_private.whatsapp_template_auto_policy where id=1 for share;
  if not found then return false; end if;
  select * into j from public.whatsapp_template_jobs where id=p_job_id;
  if not found then return false; end if;
  select * into a from public.whatsapp_template_accounts where id=j.account_id for share;
  -- All bindings before all channels, stable UUID ordering for a shared WABA.
  perform 1 from public.whatsapp_template_bindings where id in(j.binding_id,a.sync_binding_id) order by id for share;
  select * into b from public.whatsapp_template_bindings where id=j.binding_id;
  select * into gb from public.whatsapp_template_bindings where id=a.sync_binding_id;
  perform 1 from public.whatsapp_channels where id in(b.channel_id,gb.channel_id) order by id for share;
  select * into c from public.whatsapp_channels where id=b.channel_id;
  select * into gc from public.whatsapp_channels where id=gb.channel_id;
  perform 1 from public.whatsapp_remote_templates where account_id=a.id order by id for share;
  select * into t from public.whatsapp_remote_templates where account_id=a.id and logical_id=j.target_key and version=1 and language='pt_BR';
  select * into j from public.whatsapp_template_jobs where id=p_job_id for share;
  v_now:=clock_timestamp();
  if j.state<>'posting' or j.claim_token is distinct from p_fence or j.claimed_until<=v_now or j.posting_started_at is null
    or j.post_capture_id is null or j.post_capture_id is distinct from a.sync_capture_id or j.operation<>'provision' or j.attempts<1
    or b.id is null or c.id is null or gb.id is null or gc.id is null or t.id is null or a.last_sync_published_at is null then return false; end if;
  if (b.account_id,b.generation) is distinct from (j.account_id,j.binding_generation) or p_generation is distinct from b.generation
    or b.verified_at is null or b.submission_authorized_at is null or b.provider<>'datafy'
    or b.channel_credential_revision is distinct from c.template_credential_revision or (b.unit_id,b.provider) is distinct from (c.unit_id,c.provider)
    or c.status<>'connected' or c.last_health_check_at is null or c.last_health_check_at<v_now-interval '5 minutes' then return false; end if;
  if gb.account_id is distinct from a.id or gb.verified_at is null or gb.generation is distinct from a.sync_binding_generation
    or gb.channel_credential_revision is distinct from a.sync_credential_revision or gc.template_credential_revision is distinct from a.sync_credential_revision
    or (gb.unit_id,gb.provider) is distinct from (gc.unit_id,gc.provider) or gc.status<>'connected' then return false; end if;
  if t.name<>t.logical_id or t.logical_id not in('res_confirmacao_v1','res_confirmacao_desconto_v1','res_lembrete_dia_v1','res_pesquisa_reserva_v1','fila_entrada_v1','fila_feedback_v1','mkt_voucher_programado_v1','fila_mesa_pronta_v1','res_cancelada_v1')
    or t.binding_generation<>a.binding_generation or t.last_synced_at is null or t.last_synced_at<v_now-interval '60 seconds'
    or t.remote_id is not null or t.remote_status<>'UNKNOWN' or t.observed_hash is not null or t.submission_attempted_at is null
    or exists(select from public.whatsapp_remote_templates where account_id=a.id and sync_required)
    or not exists(select from public.platform_flags where key='whatsapp_template_catalog' and value='true'::jsonb) then return false; end if;
  if not app_private.whatsapp_template_submission_gate(p_job_id,p_fence,p_generation,p_payload_hash) then return false; end if;
  select g.id into v_grant from app_private.whatsapp_template_submission_grants g
    where g.binding_id=b.id and g.revoked_at is null and g.catalog_digest=app_private.whatsapp_template_approved_catalog_digest();
  if v_grant is null then return false; end if;
  insert into app_private.whatsapp_template_post_confirmations
    (job_id,claim_token,binding_generation,payload_hash,grant_id)
    values(j.id,p_fence,p_generation,p_payload_hash,v_grant)
    on conflict(job_id) do nothing returning job_id into v_confirmed;
  return v_confirmed is not null;
end $$;
revoke all on function public.confirm_whatsapp_template_post(uuid,uuid,bigint,text) from public,anon,authenticated,service_role;
grant execute on function public.confirm_whatsapp_template_post(uuid,uuid,bigint,text) to service_role;

create or replace function public.check_whatsapp_template_submission(
  p_job_id uuid,p_fence uuid,p_generation bigint,p_payload_hash text)
returns boolean language sql security definer set search_path='' as $$
  select exists(
    select 1 from app_private.whatsapp_template_post_confirmations c
    join public.whatsapp_template_jobs j on j.id=c.job_id
    where c.job_id=p_job_id and c.claim_token=p_fence
      and c.binding_generation=p_generation and c.payload_hash=p_payload_hash
      and j.state='posting' and j.claim_token=p_fence and j.claimed_until>clock_timestamp()
      and app_private.whatsapp_template_submission_gate(p_job_id,p_fence,p_generation,p_payload_hash)
  )
$$;
revoke all on function public.check_whatsapp_template_submission(uuid,uuid,bigint,text) from public,anon,authenticated,service_role;
grant execute on function public.check_whatsapp_template_submission(uuid,uuid,bigint,text) to service_role;

notify pgrst, 'reload schema';
commit;
