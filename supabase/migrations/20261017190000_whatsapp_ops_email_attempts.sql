-- Durable, bounded operational email attempts. This file is intentionally
-- transactional when applied raw by the local preflight harness.
begin;

create table if not exists public.whatsapp_ops_email_attempts (
  id uuid primary key default gen_random_uuid(),
  -- Keep the project cap and unresolved attempts even if a unit is removed.
  -- Unit removal requires a separately reviewed retention/cleanup decision.
  unit_id uuid references public.units(id) on delete restrict,
  alert_type text not null check (alert_type in (
    'inbound_dead_letter', 'inbound_backlog_stalled',
    'datafy_subscription_failed', 'synthetic_test'
  )),
  channel_id uuid,
  count integer,
  oldest_age_seconds integer,
  generated_at timestamptz not null,
  created_at timestamptz not null default now(),
  status text not null default 'reserved'
    check (status in ('reserved', 'accepted', 'uncertain', 'rejected')),
  provider_id text,
  reconciliation_evidence_id uuid unique,
  reconciled_at timestamptz,
  payload_digest text not null
    check (payload_digest ~ '^[0-9a-f]{64}$'),
  template_version text not null
    check (template_version = 'ops-email-v1'),
  config_hmac text not null
    check (config_hmac ~ '^[0-9a-f]{64}$'),
  constraint whatsapp_ops_email_attempts_shape_check check (
    (alert_type = 'synthetic_test' and unit_id is null and channel_id is null
      and count is null and oldest_age_seconds is null)
    or (alert_type = 'inbound_dead_letter' and unit_id is not null
      and count is not null and count >= 0 and oldest_age_seconds is null)
    or (alert_type = 'inbound_backlog_stalled' and unit_id is not null
      and count is null and oldest_age_seconds is not null
      and oldest_age_seconds >= 0)
    or (alert_type = 'datafy_subscription_failed' and unit_id is not null
      and count is null and oldest_age_seconds is null)
  ),
  constraint whatsapp_ops_email_attempts_provider_check check (
    (status = 'accepted' and provider_id is not null
      and provider_id ~ '^[A-Za-z0-9_-]{1,200}$')
    or (status <> 'accepted' and provider_id is null)
  ),
  constraint whatsapp_ops_email_attempts_reconciliation_check check (
    (status = 'rejected' and reconciliation_evidence_id is not null
      and reconciled_at is not null and reconciled_at >= created_at)
    or (status <> 'rejected' and reconciliation_evidence_id is null
      and reconciled_at is null)
  )
);

comment on table public.whatsapp_ops_email_attempts is
  'Internal Resend attempt budget and immutable delivery envelope. No recipient, message body, phone or secret. Rejected attempts require an opaque evidence UUID from manual reconciliation. FORCE RLS without policies; service_role cannot delete.';

create index if not exists whatsapp_ops_email_attempts_global_window_idx
  on public.whatsapp_ops_email_attempts (created_at desc);
create index if not exists whatsapp_ops_email_attempts_unit_window_idx
  on public.whatsapp_ops_email_attempts (unit_id, alert_type, created_at desc)
  where unit_id is not null;
create index if not exists whatsapp_ops_email_attempts_test_window_idx
  on public.whatsapp_ops_email_attempts (created_at desc)
  where alert_type = 'synthetic_test';
create index if not exists whatsapp_ops_email_attempts_unresolved_idx
  on public.whatsapp_ops_email_attempts (unit_id, alert_type)
  where status in ('reserved', 'uncertain');

alter table public.whatsapp_ops_email_attempts enable row level security;
alter table public.whatsapp_ops_email_attempts force row level security;
revoke all on table public.whatsapp_ops_email_attempts
  from public, anon, authenticated, service_role;
grant select, insert on table public.whatsapp_ops_email_attempts to service_role;
grant update (status, provider_id) on table public.whatsapp_ops_email_attempts
  to service_role;

-- A direct service-role UPDATE cannot alter the signed envelope or change a
-- terminal result. The trigger also enforces the resource binding on INSERT.
create or replace function public.whatsapp_ops_email_attempt_guard()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := pg_catalog.clock_timestamp();
    if new.status <> 'reserved' or new.provider_id is not null
      or new.reconciliation_evidence_id is not null
      or new.reconciled_at is not null then
      raise exception 'ops_email_attempt_invalid' using errcode = '22023';
    end if;
    if new.unit_id is not null then
      perform 1 from public.units u where u.id = new.unit_id for key share;
      if not found then
        raise exception 'ops_email_resource_unavailable' using errcode = '42501';
      end if;
    end if;
    if new.channel_id is not null then
      perform 1 from public.whatsapp_channels c
       where c.id = new.channel_id and c.unit_id = new.unit_id
       for key share;
      if not found then
        raise exception 'ops_email_resource_unavailable' using errcode = '42501';
      end if;
    end if;
    if not pg_catalog.isfinite(new.generated_at)
      or new.generated_at > new.created_at + interval '5 minutes' then
      raise exception 'ops_email_attempt_invalid' using errcode = '22023';
    end if;
    return new;
  end if;

  if row(new.id, new.unit_id, new.alert_type, new.channel_id, new.count,
      new.oldest_age_seconds, new.generated_at, new.created_at,
      new.payload_digest, new.template_version, new.config_hmac)
    is distinct from
    row(old.id, old.unit_id, old.alert_type, old.channel_id, old.count,
      old.oldest_age_seconds, old.generated_at, old.created_at,
      old.payload_digest, old.template_version, old.config_hmac) then
    raise exception 'ops_email_attempt_immutable' using errcode = '42501';
  end if;
  if new.status = old.status and new.provider_id is not distinct from old.provider_id
    and new.reconciliation_evidence_id is not distinct from old.reconciliation_evidence_id
    and new.reconciled_at is not distinct from old.reconciled_at then
    return new;
  end if;
  if old.status = 'reserved' and new.status in ('accepted', 'uncertain')
    or old.status = 'uncertain' and new.status = 'accepted' then
    if new.reconciliation_evidence_id is distinct from old.reconciliation_evidence_id
      or new.reconciled_at is distinct from old.reconciled_at then
      raise exception 'ops_email_attempt_immutable' using errcode = '42501';
    end if;
    if new.status = 'accepted' and (new.provider_id is null
      or new.provider_id !~ '^[A-Za-z0-9_-]{1,200}$') then
      raise exception 'ops_email_attempt_invalid' using errcode = '22023';
    end if;
    if new.status <> 'accepted' and new.provider_id is not null then
      raise exception 'ops_email_attempt_invalid' using errcode = '22023';
    end if;
    return new;
  end if;
  if old.status in ('reserved', 'uncertain') and new.status = 'rejected'
    and current_user = 'postgres'
    and new.provider_id is null
    and old.reconciliation_evidence_id is null
    and old.reconciled_at is null
    and new.reconciliation_evidence_id is not null
    and new.reconciled_at is not null
    and pg_catalog.current_setting('app.ops_email_reconciliation', true)
      = new.reconciliation_evidence_id::text then
    return new;
  end if;
  raise exception 'ops_email_attempt_transition_invalid' using errcode = '42501';
end;
$$;
revoke all on function public.whatsapp_ops_email_attempt_guard()
  from public, anon, authenticated, service_role;
drop trigger if exists whatsapp_ops_email_attempt_guard_trg
  on public.whatsapp_ops_email_attempts;
create trigger whatsapp_ops_email_attempt_guard_trg
  before insert or update on public.whatsapp_ops_email_attempts
  for each row execute function public.whatsapp_ops_email_attempt_guard();

-- Fixed order: a project-wide transactional lock, then the unit/type lock.
-- Global serialization makes count + insert exact across concurrent EFs.
-- Advisory-hash collisions only over-serialize; they do not relax a cap.
create or replace function public.reserve_whatsapp_ops_email_attempt(
  p_unit_id uuid, p_alert_type text, p_channel_id uuid,
  p_count integer, p_oldest_age_seconds integer, p_generated_at timestamptz,
  p_payload_digest text, p_template_version text, p_config_hmac text
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_now timestamptz;
  v_existing public.whatsapp_ops_email_attempts%rowtype;
  v_attempt public.whatsapp_ops_email_attempts%rowtype;
  v_window interval;
  v_total integer;
begin
  if p_alert_type is null or p_alert_type not in (
      'inbound_dead_letter', 'inbound_backlog_stalled',
      'datafy_subscription_failed', 'synthetic_test'
    )
    or p_generated_at is null or not pg_catalog.isfinite(p_generated_at)
    or p_payload_digest is null or p_payload_digest !~ '^[0-9a-f]{64}$'
    or p_config_hmac is null or p_config_hmac !~ '^[0-9a-f]{64}$'
    or p_template_version is distinct from 'ops-email-v1'
    or not (
      (p_alert_type = 'synthetic_test' and p_unit_id is null
        and p_channel_id is null and p_count is null
        and p_oldest_age_seconds is null)
      or (p_alert_type = 'inbound_dead_letter' and p_unit_id is not null
        and p_count is not null and p_count >= 0
        and p_oldest_age_seconds is null)
      or (p_alert_type = 'inbound_backlog_stalled' and p_unit_id is not null
        and p_count is null and p_oldest_age_seconds is not null
        and p_oldest_age_seconds >= 0)
      or (p_alert_type = 'datafy_subscription_failed' and p_unit_id is not null
        and p_count is null and p_oldest_age_seconds is null)
    ) then
    raise exception 'ops_email_attempt_invalid' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('whatsapp_ops_email:project', 0));
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'whatsapp_ops_email:' || coalesce(p_unit_id::text, 'test') || ':' || p_alert_type,
      0));
  v_now := pg_catalog.clock_timestamp();
  if p_generated_at > v_now + interval '5 minutes' then
    raise exception 'ops_email_attempt_invalid' using errcode = '22023';
  end if;

  if p_unit_id is not null then
    perform 1 from public.units u where u.id = p_unit_id for key share;
    if not found then
      raise exception 'ops_email_resource_unavailable' using errcode = '42501';
    end if;
  end if;
  if p_channel_id is not null then
    perform 1 from public.whatsapp_channels c
     where c.id = p_channel_id and c.unit_id = p_unit_id for key share;
    if not found then
      raise exception 'ops_email_resource_unavailable' using errcode = '42501';
    end if;
  end if;

  -- A lost response may hide a Resend acceptance. Elapsed time alone never
  -- authorizes another paid request; an owner must reconcile the attempt.
  perform 1 from public.whatsapp_ops_email_attempts a
   where a.alert_type = p_alert_type
     and a.unit_id is not distinct from p_unit_id
     and a.status in ('reserved', 'uncertain')
   limit 1;
  if found then
    return pg_catalog.jsonb_build_object('decision', 'blocked', 'reason', 'unresolved');
  end if;

  v_window := case when p_alert_type = 'synthetic_test'
    then interval '24 hours' else interval '30 minutes' end;
  select * into v_existing from public.whatsapp_ops_email_attempts a
   where a.alert_type = p_alert_type
     and a.unit_id is not distinct from p_unit_id
     and a.created_at >= v_now - v_window
   order by a.created_at desc, a.id desc limit 1;
  if found then
    if v_existing.status = 'accepted'
      and v_existing.payload_digest = p_payload_digest
      and v_existing.config_hmac = p_config_hmac
      and v_existing.template_version = p_template_version then
      return pg_catalog.jsonb_build_object(
        'decision', 'replay', 'attempt_id', v_existing.id,
        'created_at', v_existing.created_at);
    end if;
    return pg_catalog.jsonb_build_object('decision', 'blocked', 'reason', 'window');
  end if;

  select count(*) into v_total from public.whatsapp_ops_email_attempts a
   where a.created_at >= v_now - interval '24 hours';
  if v_total >= 50 then
    return pg_catalog.jsonb_build_object('decision', 'blocked', 'reason', 'capacity');
  end if;

  insert into public.whatsapp_ops_email_attempts (
    unit_id, alert_type, channel_id, count, oldest_age_seconds,
    generated_at, payload_digest, template_version, config_hmac
  ) values (
    p_unit_id, p_alert_type, p_channel_id, p_count, p_oldest_age_seconds,
    p_generated_at, p_payload_digest, p_template_version, p_config_hmac
  ) returning * into v_attempt;
  return pg_catalog.jsonb_build_object(
    'decision', 'reserved', 'attempt_id', v_attempt.id,
    'created_at', v_attempt.created_at);
end;
$$;
revoke all on function public.reserve_whatsapp_ops_email_attempt(
  uuid,text,uuid,integer,integer,timestamptz,text,text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.reserve_whatsapp_ops_email_attempt(
  uuid,text,uuid,integer,integer,timestamptz,text,text,text)
  to service_role;

create or replace function public.complete_whatsapp_ops_email_attempt(
  p_attempt_id uuid, p_status text, p_provider_id text
)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare
  v_updated uuid;
begin
  if p_attempt_id is null or p_status is null
    or p_status not in ('accepted', 'uncertain')
    or (p_status = 'accepted' and (p_provider_id is null
      or p_provider_id !~ '^[A-Za-z0-9_-]{1,200}$'))
    or (p_status = 'uncertain' and p_provider_id is not null) then
    raise exception 'ops_email_completion_invalid' using errcode = '22023';
  end if;
  update public.whatsapp_ops_email_attempts a
     set status = p_status, provider_id = p_provider_id
   where a.id = p_attempt_id
     and (a.status = 'reserved'
       or (a.status = 'uncertain' and p_status = 'accepted')
       or (a.status = 'accepted' and p_status = 'accepted'
         and a.provider_id = p_provider_id))
   returning a.id into v_updated;
  return v_updated is not null;
end;
$$;
revoke all on function public.complete_whatsapp_ops_email_attempt(uuid,text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.complete_whatsapp_ops_email_attempt(uuid,text,text)
  to service_role;

-- Explicit manual release after an operator verifies in Resend that the
-- attempt was not accepted. The evidence UUID points to a separately stored
-- incident record; no recipient, body or free-text evidence is stored here.
-- app_private is not exposed by PostgREST and EXECUTE stays with postgres.
create or replace function app_private.reconcile_whatsapp_ops_email_attempt(
  p_attempt_id uuid, p_evidence_id uuid
)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare
  v_updated uuid;
begin
  if current_user <> 'postgres' then
    raise exception 'ops_email_reconciliation_denied' using errcode = '42501';
  end if;
  if p_attempt_id is null or p_evidence_id is null then
    raise exception 'ops_email_reconciliation_invalid' using errcode = '22023';
  end if;
  perform pg_catalog.set_config('app.ops_email_reconciliation', p_evidence_id::text, true);
  update public.whatsapp_ops_email_attempts a
     set status = 'rejected',
         reconciliation_evidence_id = p_evidence_id,
         reconciled_at = pg_catalog.clock_timestamp()
   where a.id = p_attempt_id and a.status in ('reserved', 'uncertain')
   returning a.id into v_updated;
  return v_updated is not null;
end;
$$;
revoke all on function app_private.reconcile_whatsapp_ops_email_attempt(uuid,uuid)
  from public, anon, authenticated, service_role;

-- Readiness verifies both RPCs, write ACL and remaining project budget
-- without making a reservation. It is advisory: concurrent callers can spend
-- the last slot after this read, so the reserve RPC remains authoritative.
create or replace function public.check_whatsapp_ops_email_reservation_ready()
returns jsonb language plpgsql volatile security invoker set search_path = '' as $$
declare
  v_reserve_oid regprocedure;
  v_complete_oid regprocedure;
  v_total bigint;
begin
  v_reserve_oid := pg_catalog.to_regprocedure(
    'public.reserve_whatsapp_ops_email_attempt(uuid,text,uuid,integer,integer,timestamp with time zone,text,text,text)');
  v_complete_oid := pg_catalog.to_regprocedure(
    'public.complete_whatsapp_ops_email_attempt(uuid,text,text)');
  if v_reserve_oid is null
    or v_complete_oid is null
    or not pg_catalog.has_function_privilege(current_user, v_reserve_oid, 'EXECUTE')
    or not pg_catalog.has_function_privilege(current_user, v_complete_oid, 'EXECUTE')
    or not pg_catalog.has_table_privilege(
      current_user, 'public.whatsapp_ops_email_attempts'::regclass, 'SELECT')
    or not pg_catalog.has_table_privilege(
      current_user, 'public.whatsapp_ops_email_attempts'::regclass, 'INSERT')
    or not pg_catalog.has_column_privilege(
      current_user, 'public.whatsapp_ops_email_attempts'::regclass, 'status', 'UPDATE')
    or not pg_catalog.has_column_privilege(
      current_user, 'public.whatsapp_ops_email_attempts'::regclass, 'provider_id', 'UPDATE') then
    return pg_catalog.jsonb_build_object('ready', false, 'remaining', 0);
  end if;
  select count(*) into v_total from public.whatsapp_ops_email_attempts a
   where a.created_at >= pg_catalog.clock_timestamp() - interval '24 hours';
  return pg_catalog.jsonb_build_object(
    'ready', v_total < 50,
    'remaining', greatest(0::bigint, 50 - v_total));
exception
  when undefined_table or undefined_function or insufficient_privilege then
    return pg_catalog.jsonb_build_object('ready', false, 'remaining', 0);
end;
$$;
revoke all on function public.check_whatsapp_ops_email_reservation_ready()
  from public, anon, authenticated, service_role;
grant execute on function public.check_whatsapp_ops_email_reservation_ready()
  to service_role;

commit;
