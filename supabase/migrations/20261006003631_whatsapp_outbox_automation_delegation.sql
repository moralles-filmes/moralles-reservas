-- Existing outbox delegates WhatsApp outcomes to the durable automation ledger.
-- Initial token is invocation authority, never delivery evidence or an expiring lease.
begin;
alter table public.notification_outbox add column if not exists automation_job_id uuid;
alter table public.notification_outbox add column if not exists automation_initial_token uuid;
-- A historical pin intentionally has no FK: job retention cannot restore legacy routing.
revoke all on table public.notification_outbox from public,anon,authenticated,service_role;
grant select,insert,update,delete on table public.notification_outbox to service_role;
alter table public.notification_outbox enable row level security;
alter table public.notification_outbox force row level security;
create index if not exists notification_outbox_delegated_recovery_idx
  on public.notification_outbox(updated_at,id)
  where kind='confirmation' and status='processing' and automation_job_id is not null;

do $$ begin
  if not exists(select 1 from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname='app_private' and t.typname='notification_outbox_mutation_action') then
    create type app_private.notification_outbox_mutation_action as enum
      ('initial_claim','delegate','poll','defer_dependency','finish_initial','recover_delegated');
  end if;
  if not exists(select 1 from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname='app_private' and t.typname='notification_outbox_transition_tuple') then
    create type app_private.notification_outbox_transition_tuple as (
      id uuid,reservation_id uuid,unit_id uuid,kind text,attempts integer,next_attempt_at timestamptz,
      status text,last_error text,created_at timestamptz,updated_at timestamptz,
      automation_job_id uuid,automation_initial_token uuid);
  end if;
  if not exists(select 1 from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname='app_private' and t.typname='notification_outbox_automation_projection') then
    create type app_private.notification_outbox_automation_projection as
      (outbox_status text,disposition text,reason text,last_error text,retry_seconds integer);
  end if;
end $$;
revoke all on type app_private.notification_outbox_mutation_action from public,anon,authenticated,service_role;
revoke all on type app_private.notification_outbox_transition_tuple from public,anon,authenticated,service_role;
revoke all on type app_private.notification_outbox_automation_projection from public,anon,authenticated,service_role;
create table if not exists app_private.notification_outbox_mutation_permits (
  transaction_id bigint not null,outbox_id uuid not null,
  action app_private.notification_outbox_mutation_action not null,
  old_row app_private.notification_outbox_transition_tuple not null,
  new_row app_private.notification_outbox_transition_tuple not null,
  primary key(transaction_id,outbox_id)
);
alter table app_private.notification_outbox_mutation_permits enable row level security;
alter table app_private.notification_outbox_mutation_permits force row level security;
revoke all on table app_private.notification_outbox_mutation_permits from public,anon,authenticated,service_role;

create or replace function app_private.consume_notification_outbox_mutation(
  p_id uuid,p_old app_private.notification_outbox_transition_tuple,p_new app_private.notification_outbox_transition_tuple)
returns app_private.notification_outbox_mutation_action language sql security definer set search_path='' as $$
  delete from app_private.notification_outbox_mutation_permits p
  where p.transaction_id=txid_current() and p.outbox_id=p_id
    and p.old_row is not distinct from p_old and p.new_row is not distinct from p_new
  returning p.action;
$$;
revoke all on function app_private.consume_notification_outbox_mutation(uuid,app_private.notification_outbox_transition_tuple,app_private.notification_outbox_transition_tuple) from public,anon,authenticated,service_role;

create or replace function app_private.map_notification_outbox_automation_state(p_state text)
returns app_private.notification_outbox_automation_projection language sql immutable set search_path='' as $$
  select case
    when p_state in ('queued','claimed','posting','retry_wait','blocked','paused','needs_review','uncertain')
      then row('pending','pending','automation_'||p_state,'automation_'||p_state,60)::app_private.notification_outbox_automation_projection
    when p_state in ('accepted','reconciled') then row('done','accepted','automation_'||p_state,null,null::integer)::app_private.notification_outbox_automation_projection
    when p_state='expired' then row('done','discarded','automation_expired','automation_expired',null::integer)::app_private.notification_outbox_automation_projection
    when p_state in ('rejected','failed') then row('dead',p_state,'automation_'||p_state,'automation_'||p_state,null::integer)::app_private.notification_outbox_automation_projection
    else row('pending','dependency','automation_dependency_unavailable','automation_dependency_unavailable',60)::app_private.notification_outbox_automation_projection
  end;
$$;
revoke all on function app_private.map_notification_outbox_automation_state(text) from public,anon,authenticated,service_role;

create or replace function public.guard_notification_outbox_insert_scope()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.automation_job_id is not null or new.automation_initial_token is not null
    or not exists(select 1 from public.reservations r where r.id=new.reservation_id and r.unit_id=new.unit_id) then
    raise exception 'outbox_insert_refused' using errcode='42501';
  end if;
  return new;
end $$;
revoke all on function public.guard_notification_outbox_insert_scope() from public,anon,authenticated,service_role;
drop trigger if exists notification_outbox_insert_scope on public.notification_outbox;
create trigger notification_outbox_insert_scope before insert on public.notification_outbox
for each row execute function public.guard_notification_outbox_insert_scope();

create or replace function public.guard_notification_outbox_automation()
returns trigger language plpgsql security definer set search_path='' as $$
declare
  v_old app_private.notification_outbox_transition_tuple;
  v_new app_private.notification_outbox_transition_tuple;
  v_action app_private.notification_outbox_mutation_action;
  v_managed boolean;
begin
  v_old := row(old.id,old.reservation_id,old.unit_id,old.kind,old.attempts,old.next_attempt_at,
    old.status,old.last_error,old.created_at,old.updated_at,old.automation_job_id,old.automation_initial_token);
  v_new := row(new.id,new.reservation_id,new.unit_id,new.kind,new.attempts,new.next_attempt_at,
    new.status,new.last_error,new.created_at,new.updated_at,new.automation_job_id,new.automation_initial_token);
  v_action := app_private.consume_notification_outbox_mutation(old.id,v_old,v_new);
  -- Marked rows, including recovery, reach no earlier business table at all.
  v_managed := old.automation_job_id is not null or old.automation_initial_token is not null
    or new.automation_job_id is not null or new.automation_initial_token is not null;
  if v_action is null and not v_managed then
    v_managed := (old.kind='confirmation' and (
      exists(select 1 from public.whatsapp_automation_adoptions a where a.unit_id=old.unit_id)
      or exists(select 1 from public.whatsapp_automation_jobs j where j.unit_id=old.unit_id and j.reservation_id=old.reservation_id and j.kind='confirmation')))
      or (new.kind='confirmation' and (
      exists(select 1 from public.whatsapp_automation_adoptions a where a.unit_id=new.unit_id)
      or exists(select 1 from public.whatsapp_automation_jobs j where j.unit_id=new.unit_id and j.reservation_id=new.reservation_id and j.kind='confirmation')));
  end if;
  if v_action is null and not v_managed then return new; end if;
  if old.kind<>'confirmation' or new.kind<>'confirmation'
    or row(old.id,old.reservation_id,old.unit_id,old.kind,old.attempts,old.created_at)
      is distinct from row(new.id,new.reservation_id,new.unit_id,new.kind,new.attempts,new.created_at)
    or (old.automation_job_id is not null and old.automation_job_id is distinct from new.automation_job_id)
    or (old.automation_initial_token is not null and old.automation_initial_token is distinct from new.automation_initial_token) then
    raise exception 'outbox_mutation_refused' using errcode='42501';
  end if;
  if v_action is null then
    if old.status='pending' and new.status='processing'
      and row(old.next_attempt_at,old.last_error,old.automation_job_id,old.automation_initial_token)
        is not distinct from row(new.next_attempt_at,new.last_error,new.automation_job_id,new.automation_initial_token) then
      new.updated_at := clock_timestamp(); -- SQL time after UPDATE acquired its row lock.
      return new;
    end if;
    raise exception 'outbox_permit_required' using errcode='42501';
  end if;
  if v_action='initial_claim' then
    if old.status='processing' and old.automation_initial_token is null and new.automation_initial_token is not null
      and row(old.status,old.next_attempt_at,old.last_error,old.automation_job_id)
        is not distinct from row(new.status,new.next_attempt_at,new.last_error,new.automation_job_id) then return new; end if;
  elsif v_action='delegate' then
    if old.automation_initial_token is not null and old.automation_job_id is null and new.automation_job_id is not null
      and row(old.status,old.next_attempt_at,old.last_error,old.automation_initial_token)
        is not distinct from row(new.status,new.next_attempt_at,new.last_error,new.automation_initial_token) then return new; end if;
  else
    if row(old.automation_job_id,old.automation_initial_token) is distinct from row(new.automation_job_id,new.automation_initial_token) then
      raise exception 'outbox_markers_immutable' using errcode='42501';
    end if;
    if v_action in ('poll','finish_initial') then
      if (new.status='pending' and new.next_attempt_at=new.updated_at+interval '60 seconds'
        and new.last_error in ('automation_queued','automation_claimed','automation_posting','automation_retry_wait',
          'automation_blocked','automation_paused','automation_needs_review','automation_uncertain','automation_dependency_unavailable',
          'automation_job_missing','automation_dependency_changed','automation_initial_unfinished'))
        or (new.status='done' and new.next_attempt_at=old.next_attempt_at
          and (new.last_error is null or new.last_error in ('automation_expired','automation_before_adoption','automation_legacy_accepted')))
        or (new.status='dead' and new.next_attempt_at=old.next_attempt_at and new.last_error in ('automation_rejected','automation_failed')) then return new; end if;
    elsif v_action='defer_dependency' then
      if old.status='processing' and new.status='pending' and new.next_attempt_at=new.updated_at+interval '60 seconds'
        and new.last_error='automation_dependency_unavailable' then return new; end if;
    elsif v_action='recover_delegated' then
      if old.status='processing' and old.automation_job_id is not null and old.updated_at<new.updated_at-interval '2 minutes'
        and new.status='pending' and new.next_attempt_at=new.updated_at+interval '60 seconds'
        and new.last_error='automation_recovery_due' then return new; end if;
    end if;
  end if;
  raise exception 'outbox_transition_refused' using errcode='42501';
end $$;
revoke all on function public.guard_notification_outbox_automation() from public,anon,authenticated,service_role;
drop trigger if exists notification_outbox_automation on public.notification_outbox;
create trigger notification_outbox_automation before update on public.notification_outbox
for each row execute function public.guard_notification_outbox_automation();

create or replace function public.claim_notification_outbox_initial(p_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare
  d public.notification_outbox%rowtype; o public.notification_outbox%rowtype; n public.notification_outbox%rowtype;
  j public.whatsapp_automation_jobs%rowtype;
  v_current uuid; v_count integer; v_now timestamptz; v_changed boolean := false;
begin
  select * into d from public.notification_outbox where id=p_id;
  if d.id is not null then
    if d.automation_job_id is not null then
      select * into j from public.whatsapp_automation_jobs where id=d.automation_job_id for share;
    else
      select * into j from public.whatsapp_automation_jobs where unit_id=d.unit_id and reservation_id=d.reservation_id and kind='confirmation' for share;
    end if;
  end if;
  select * into o from public.notification_outbox where id=p_id for update;
  if o.id is not null then
    v_changed := row(d.reservation_id,d.unit_id,d.kind,d.automation_job_id) is distinct from row(o.reservation_id,o.unit_id,o.kind,o.automation_job_id);
    if o.automation_job_id is null then
      select id into v_current from public.whatsapp_automation_jobs where unit_id=o.unit_id and reservation_id=o.reservation_id and kind='confirmation';
    else v_current := o.automation_job_id; end if;
    v_changed := v_changed or (v_current is distinct from j.id and not (o.automation_job_id is not null and j.id is null));
  end if;
  -- No lock on a job discovered after acquiring outbox. Retry on the next invocation.

  if not (o.id is not null and o.kind='confirmation' and exists(select 1 from public.reservations r where r.id=o.reservation_id and r.unit_id=o.unit_id)) or v_changed or o.status<>'processing' or o.automation_initial_token is not null
    or not (exists(select 1 from public.whatsapp_automation_adoptions a where a.unit_id=o.unit_id) or (j.id is not null and j.unit_id=o.unit_id and j.reservation_id=o.reservation_id and j.kind='confirmation')) then return null; end if;
  n:=o; n.automation_initial_token:=gen_random_uuid(); n.updated_at:=clock_timestamp();

  insert into app_private.notification_outbox_mutation_permits(transaction_id,outbox_id,action,old_row,new_row)
    values(txid_current(),o.id,'initial_claim',row(o.id,o.reservation_id,o.unit_id,o.kind,o.attempts,o.next_attempt_at,o.status,o.last_error,o.created_at,o.updated_at,o.automation_job_id,o.automation_initial_token)::app_private.notification_outbox_transition_tuple,row(n.id,n.reservation_id,n.unit_id,n.kind,n.attempts,n.next_attempt_at,n.status,n.last_error,n.created_at,n.updated_at,n.automation_job_id,n.automation_initial_token)::app_private.notification_outbox_transition_tuple);
  update public.notification_outbox set reservation_id=n.reservation_id,unit_id=n.unit_id,kind=n.kind,attempts=n.attempts,next_attempt_at=n.next_attempt_at,status=n.status,last_error=n.last_error,created_at=n.created_at,updated_at=n.updated_at,automation_job_id=n.automation_job_id,automation_initial_token=n.automation_initial_token
    where id=o.id;
  get diagnostics v_count=row_count;
  if v_count<>1 or exists(select 1 from app_private.notification_outbox_mutation_permits where transaction_id=txid_current() and outbox_id=o.id) then
    raise exception 'outbox_permit_not_consumed' using errcode='42501';
  end if;

  return n.automation_initial_token;
end $$;

create or replace function public.delegate_notification_outbox_automation(p_id uuid,p_job_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare
  d public.notification_outbox%rowtype; o public.notification_outbox%rowtype; n public.notification_outbox%rowtype;
  j public.whatsapp_automation_jobs%rowtype;
  v_current uuid; v_count integer; v_now timestamptz; v_changed boolean := false;
begin
  select * into j from public.whatsapp_automation_jobs where id=p_job_id for share;
  select * into o from public.notification_outbox where id=p_id for update;
  if not (o.id is not null and o.kind='confirmation' and exists(select 1 from public.reservations r where r.id=o.reservation_id and r.unit_id=o.unit_id)) or not (j.id is not null and j.unit_id=o.unit_id and j.reservation_id=o.reservation_id and j.kind='confirmation') or o.automation_initial_token is null then return false; end if;
  if o.automation_job_id is not null then return o.automation_job_id=p_job_id; end if;
  n:=o; n.automation_job_id:=j.id; n.updated_at:=clock_timestamp();

  insert into app_private.notification_outbox_mutation_permits(transaction_id,outbox_id,action,old_row,new_row)
    values(txid_current(),o.id,'delegate',row(o.id,o.reservation_id,o.unit_id,o.kind,o.attempts,o.next_attempt_at,o.status,o.last_error,o.created_at,o.updated_at,o.automation_job_id,o.automation_initial_token)::app_private.notification_outbox_transition_tuple,row(n.id,n.reservation_id,n.unit_id,n.kind,n.attempts,n.next_attempt_at,n.status,n.last_error,n.created_at,n.updated_at,n.automation_job_id,n.automation_initial_token)::app_private.notification_outbox_transition_tuple);
  update public.notification_outbox set reservation_id=n.reservation_id,unit_id=n.unit_id,kind=n.kind,attempts=n.attempts,next_attempt_at=n.next_attempt_at,status=n.status,last_error=n.last_error,created_at=n.created_at,updated_at=n.updated_at,automation_job_id=n.automation_job_id,automation_initial_token=n.automation_initial_token
    where id=o.id;
  get diagnostics v_count=row_count;
  if v_count<>1 or exists(select 1 from app_private.notification_outbox_mutation_permits where transaction_id=txid_current() and outbox_id=o.id) then
    raise exception 'outbox_permit_not_consumed' using errcode='42501';
  end if;

  return true;
end $$;

create or replace function public.poll_notification_outbox_automation(p_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  d public.notification_outbox%rowtype; o public.notification_outbox%rowtype; n public.notification_outbox%rowtype;
  j public.whatsapp_automation_jobs%rowtype;
  v_current uuid; v_count integer; v_now timestamptz; v_changed boolean := false;
  v_state text; v_reason text; v_projection app_private.notification_outbox_automation_projection;
begin
  select * into d from public.notification_outbox where id=p_id;
  if d.id is not null then
    if d.automation_job_id is not null then
      select * into j from public.whatsapp_automation_jobs where id=d.automation_job_id for share;
    else
      select * into j from public.whatsapp_automation_jobs where unit_id=d.unit_id and reservation_id=d.reservation_id and kind='confirmation' for share;
    end if;
  end if;
  select * into o from public.notification_outbox where id=p_id for update;
  if o.id is not null then
    v_changed := row(d.reservation_id,d.unit_id,d.kind,d.automation_job_id) is distinct from row(o.reservation_id,o.unit_id,o.kind,o.automation_job_id);
    if o.automation_job_id is null then
      select id into v_current from public.whatsapp_automation_jobs where unit_id=o.unit_id and reservation_id=o.reservation_id and kind='confirmation';
    else v_current := o.automation_job_id; end if;
    v_changed := v_changed or (v_current is distinct from j.id and not (o.automation_job_id is not null and j.id is null));
  end if;
  -- No lock on a job discovered after acquiring outbox. Retry on the next invocation.

  if not (o.id is not null and o.kind='confirmation' and exists(select 1 from public.reservations r where r.id=o.reservation_id and r.unit_id=o.unit_id))  then return jsonb_build_object('ledger_state',null,'outbox_status','pending','disposition','dependency','reason','automation_dependency_unavailable','retry_after_seconds',60); end if;
  if o.automation_initial_token is null then
    return jsonb_build_object('ledger_state',null,'outbox_status',case when o.status='processing' then 'processing' else 'pending' end,
      'disposition','dependency','reason','automation_initial_unclaimed','retry_after_seconds',60);
  end if;
  if v_changed then v_reason:='automation_dependency_changed';
  elsif o.automation_job_id is not null and j.id is null then v_reason:='automation_job_missing';
  elsif j.id is not null and not (j.id is not null and j.unit_id=o.unit_id and j.reservation_id=o.reservation_id and j.kind='confirmation') then v_reason:='automation_dependency_changed';
  elsif j.id is not null then
    v_projection:=app_private.map_notification_outbox_automation_state(j.state);
    if v_projection.disposition<>'dependency' then v_state:=j.state; end if;
  else
    -- Positive no-job proof is rederived. Failed/email receipts confer no acceptance.
    if exists(select 1 from public.whatsapp_automation_adoptions a where a.unit_id=o.unit_id and o.created_at<a.adopted_at) then
      v_reason:='automation_before_adoption';
    elsif exists(select 1 from public.notifications_sent s where s.unit_id=o.unit_id and s.reservation_id=o.reservation_id
      and s.kind='confirmation' and s.status in ('sent','delivered','read')) then v_reason:='automation_legacy_accepted';
    else v_reason:='automation_dependency_unavailable'; end if;
    if v_reason in ('automation_before_adoption','automation_legacy_accepted') then
      if o.status='done' and o.last_error=v_reason then
        v_projection:=row('done','suppressed',v_reason,v_reason,null::integer)::app_private.notification_outbox_automation_projection;
      else v_reason:='automation_initial_unfinished'; end if;
    end if;
  end if;
  if v_projection.outbox_status is null then
    v_projection:=row('pending','dependency',v_reason,v_reason,60)::app_private.notification_outbox_automation_projection;
  end if;
  if v_projection.outbox_status<>'pending' and o.status=v_projection.outbox_status and o.last_error is not distinct from v_projection.last_error then
    return jsonb_build_object('ledger_state',v_state,'outbox_status',v_projection.outbox_status,'disposition',v_projection.disposition,'reason',v_projection.reason,'retry_after_seconds',v_projection.retry_seconds);
  end if;
  v_now:=clock_timestamp(); n:=o; n.status:=v_projection.outbox_status;
  n.last_error:=v_projection.last_error; n.updated_at:=v_now;
  if v_projection.retry_seconds=60 then n.next_attempt_at:=v_now+interval '60 seconds'; end if;

  insert into app_private.notification_outbox_mutation_permits(transaction_id,outbox_id,action,old_row,new_row)
    values(txid_current(),o.id,'poll',row(o.id,o.reservation_id,o.unit_id,o.kind,o.attempts,o.next_attempt_at,o.status,o.last_error,o.created_at,o.updated_at,o.automation_job_id,o.automation_initial_token)::app_private.notification_outbox_transition_tuple,row(n.id,n.reservation_id,n.unit_id,n.kind,n.attempts,n.next_attempt_at,n.status,n.last_error,n.created_at,n.updated_at,n.automation_job_id,n.automation_initial_token)::app_private.notification_outbox_transition_tuple);
  update public.notification_outbox set reservation_id=n.reservation_id,unit_id=n.unit_id,kind=n.kind,attempts=n.attempts,next_attempt_at=n.next_attempt_at,status=n.status,last_error=n.last_error,created_at=n.created_at,updated_at=n.updated_at,automation_job_id=n.automation_job_id,automation_initial_token=n.automation_initial_token
    where id=o.id;
  get diagnostics v_count=row_count;
  if v_count<>1 or exists(select 1 from app_private.notification_outbox_mutation_permits where transaction_id=txid_current() and outbox_id=o.id) then
    raise exception 'outbox_permit_not_consumed' using errcode='42501';
  end if;

  return jsonb_build_object('ledger_state',v_state,'outbox_status',v_projection.outbox_status,'disposition',v_projection.disposition,'reason',v_projection.reason,'retry_after_seconds',v_projection.retry_seconds);
end $$;

create or replace function public.finish_notification_outbox_initial(p_id uuid,p_token uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare
  d public.notification_outbox%rowtype; o public.notification_outbox%rowtype; n public.notification_outbox%rowtype;
  j public.whatsapp_automation_jobs%rowtype;
  v_current uuid; v_count integer; v_now timestamptz; v_changed boolean := false;
  v_state text; v_reason text; v_projection app_private.notification_outbox_automation_projection;
begin
  select * into d from public.notification_outbox where id=p_id;
  if d.id is not null then
    if d.automation_job_id is not null then
      select * into j from public.whatsapp_automation_jobs where id=d.automation_job_id for share;
    else
      select * into j from public.whatsapp_automation_jobs where unit_id=d.unit_id and reservation_id=d.reservation_id and kind='confirmation' for share;
    end if;
  end if;
  select * into o from public.notification_outbox where id=p_id for update;
  if o.id is not null then
    v_changed := row(d.reservation_id,d.unit_id,d.kind,d.automation_job_id) is distinct from row(o.reservation_id,o.unit_id,o.kind,o.automation_job_id);
    if o.automation_job_id is null then
      select id into v_current from public.whatsapp_automation_jobs where unit_id=o.unit_id and reservation_id=o.reservation_id and kind='confirmation';
    else v_current := o.automation_job_id; end if;
    v_changed := v_changed or (v_current is distinct from j.id and not (o.automation_job_id is not null and j.id is null));
  end if;
  -- No lock on a job discovered after acquiring outbox. Retry on the next invocation.

  if not (o.id is not null and o.kind='confirmation' and exists(select 1 from public.reservations r where r.id=o.reservation_id and r.unit_id=o.unit_id)) or p_token is null or o.automation_initial_token is distinct from p_token then return false; end if;

  if v_changed then v_reason:='automation_dependency_changed';
  elsif o.automation_job_id is not null and j.id is null then v_reason:='automation_job_missing';
  elsif j.id is not null and not (j.id is not null and j.unit_id=o.unit_id and j.reservation_id=o.reservation_id and j.kind='confirmation') then v_reason:='automation_dependency_changed';
  elsif j.id is not null then
    v_projection:=app_private.map_notification_outbox_automation_state(j.state);
    if v_projection.disposition<>'dependency' then v_state:=j.state; end if;
  else
    -- Positive no-job proof is rederived. Failed/email receipts confer no acceptance.
    if exists(select 1 from public.whatsapp_automation_adoptions a where a.unit_id=o.unit_id and o.created_at<a.adopted_at) then
      v_reason:='automation_before_adoption';
    elsif exists(select 1 from public.notifications_sent s where s.unit_id=o.unit_id and s.reservation_id=o.reservation_id
      and s.kind='confirmation' and s.status in ('sent','delivered','read')) then v_reason:='automation_legacy_accepted';
    else v_reason:='automation_dependency_unavailable'; end if;
    if v_reason in ('automation_before_adoption','automation_legacy_accepted') then
      v_projection:=row('done','suppressed',v_reason,v_reason,null::integer)::app_private.notification_outbox_automation_projection;
    end if;
  end if;
  if v_projection.outbox_status is null then
    v_projection:=row('pending','dependency',v_reason,v_reason,60)::app_private.notification_outbox_automation_projection;
  end if;
  if v_projection.outbox_status<>'pending' and o.status=v_projection.outbox_status and o.last_error is not distinct from v_projection.last_error then
    return true;
  end if;
  v_now:=clock_timestamp(); n:=o; n.status:=v_projection.outbox_status;
  n.last_error:=v_projection.last_error; n.updated_at:=v_now;
  if v_projection.retry_seconds=60 then n.next_attempt_at:=v_now+interval '60 seconds'; end if;

  insert into app_private.notification_outbox_mutation_permits(transaction_id,outbox_id,action,old_row,new_row)
    values(txid_current(),o.id,'finish_initial',row(o.id,o.reservation_id,o.unit_id,o.kind,o.attempts,o.next_attempt_at,o.status,o.last_error,o.created_at,o.updated_at,o.automation_job_id,o.automation_initial_token)::app_private.notification_outbox_transition_tuple,row(n.id,n.reservation_id,n.unit_id,n.kind,n.attempts,n.next_attempt_at,n.status,n.last_error,n.created_at,n.updated_at,n.automation_job_id,n.automation_initial_token)::app_private.notification_outbox_transition_tuple);
  update public.notification_outbox set reservation_id=n.reservation_id,unit_id=n.unit_id,kind=n.kind,attempts=n.attempts,next_attempt_at=n.next_attempt_at,status=n.status,last_error=n.last_error,created_at=n.created_at,updated_at=n.updated_at,automation_job_id=n.automation_job_id,automation_initial_token=n.automation_initial_token
    where id=o.id;
  get diagnostics v_count=row_count;
  if v_count<>1 or exists(select 1 from app_private.notification_outbox_mutation_permits where transaction_id=txid_current() and outbox_id=o.id) then
    raise exception 'outbox_permit_not_consumed' using errcode='42501';
  end if;

  return true;
end $$;

create or replace function public.defer_notification_outbox_automation_dependency(p_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare
  d public.notification_outbox%rowtype; o public.notification_outbox%rowtype; n public.notification_outbox%rowtype;
  j public.whatsapp_automation_jobs%rowtype;
  v_current uuid; v_count integer; v_now timestamptz; v_changed boolean := false;
begin
  select * into o from public.notification_outbox where id=p_id for update;
  if not (o.id is not null and o.kind='confirmation' and exists(select 1 from public.reservations r where r.id=o.reservation_id and r.unit_id=o.unit_id)) or o.status<>'processing' then return false; end if;
  n:=o; n.status:='pending'; n.updated_at:=clock_timestamp(); n.next_attempt_at:=n.updated_at+interval '60 seconds';
  n.last_error:='automation_dependency_unavailable';

  insert into app_private.notification_outbox_mutation_permits(transaction_id,outbox_id,action,old_row,new_row)
    values(txid_current(),o.id,'defer_dependency',row(o.id,o.reservation_id,o.unit_id,o.kind,o.attempts,o.next_attempt_at,o.status,o.last_error,o.created_at,o.updated_at,o.automation_job_id,o.automation_initial_token)::app_private.notification_outbox_transition_tuple,row(n.id,n.reservation_id,n.unit_id,n.kind,n.attempts,n.next_attempt_at,n.status,n.last_error,n.created_at,n.updated_at,n.automation_job_id,n.automation_initial_token)::app_private.notification_outbox_transition_tuple);
  update public.notification_outbox set reservation_id=n.reservation_id,unit_id=n.unit_id,kind=n.kind,attempts=n.attempts,next_attempt_at=n.next_attempt_at,status=n.status,last_error=n.last_error,created_at=n.created_at,updated_at=n.updated_at,automation_job_id=n.automation_job_id,automation_initial_token=n.automation_initial_token
    where id=o.id;
  get diagnostics v_count=row_count;
  if v_count<>1 or exists(select 1 from app_private.notification_outbox_mutation_permits where transaction_id=txid_current() and outbox_id=o.id) then
    raise exception 'outbox_permit_not_consumed' using errcode='42501';
  end if;

  return true;
end $$;

create or replace function public.recover_delegated_notification_outbox(p_limit integer default 20)
returns setof uuid language plpgsql security definer set search_path='' as $$
declare
  o public.notification_outbox%rowtype; n public.notification_outbox%rowtype;
  v_count integer; v_limit integer:=greatest(0,least(coalesce(p_limit,20),20));
begin
  if v_limit=0 then return; end if;
  -- Outbox only: no parent/job discovery, locks, dispatcher or email ownership.
  for o in select * from public.notification_outbox where kind='confirmation' and status='processing'
    and automation_job_id is not null and updated_at<clock_timestamp()-interval '2 minutes'
    order by updated_at,id limit v_limit for update skip locked
  loop
    n:=o; n.status:='pending'; n.updated_at:=clock_timestamp(); n.next_attempt_at:=n.updated_at+interval '60 seconds';
    n.last_error:='automation_recovery_due';

  insert into app_private.notification_outbox_mutation_permits(transaction_id,outbox_id,action,old_row,new_row)
    values(txid_current(),o.id,'recover_delegated',row(o.id,o.reservation_id,o.unit_id,o.kind,o.attempts,o.next_attempt_at,o.status,o.last_error,o.created_at,o.updated_at,o.automation_job_id,o.automation_initial_token)::app_private.notification_outbox_transition_tuple,row(n.id,n.reservation_id,n.unit_id,n.kind,n.attempts,n.next_attempt_at,n.status,n.last_error,n.created_at,n.updated_at,n.automation_job_id,n.automation_initial_token)::app_private.notification_outbox_transition_tuple);
  update public.notification_outbox set reservation_id=n.reservation_id,unit_id=n.unit_id,kind=n.kind,attempts=n.attempts,next_attempt_at=n.next_attempt_at,status=n.status,last_error=n.last_error,created_at=n.created_at,updated_at=n.updated_at,automation_job_id=n.automation_job_id,automation_initial_token=n.automation_initial_token
    where id=o.id;
  get diagnostics v_count=row_count;
  if v_count<>1 or exists(select 1 from app_private.notification_outbox_mutation_permits where transaction_id=txid_current() and outbox_id=o.id) then
    raise exception 'outbox_permit_not_consumed' using errcode='42501';
  end if;

    return next o.id;
  end loop;
end $$;
revoke all on function public.claim_notification_outbox_initial(uuid) from public,anon,authenticated,service_role;
grant execute on function public.claim_notification_outbox_initial(uuid) to service_role;
revoke all on function public.delegate_notification_outbox_automation(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.delegate_notification_outbox_automation(uuid,uuid) to service_role;
revoke all on function public.poll_notification_outbox_automation(uuid) from public,anon,authenticated,service_role;
grant execute on function public.poll_notification_outbox_automation(uuid) to service_role;
revoke all on function public.defer_notification_outbox_automation_dependency(uuid) from public,anon,authenticated,service_role;
grant execute on function public.defer_notification_outbox_automation_dependency(uuid) to service_role;
revoke all on function public.finish_notification_outbox_initial(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.finish_notification_outbox_initial(uuid,uuid) to service_role;
revoke all on function public.recover_delegated_notification_outbox(integer) from public,anon,authenticated,service_role;
grant execute on function public.recover_delegated_notification_outbox(integer) to service_role;

create or replace function mark_outbox_done(p_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update notification_outbox
  set status = 'done', updated_at = now(), last_error = null
  where id = p_id and automation_job_id is null and automation_initial_token is null;
$$;

-- Helper: marca outbox como falhada — calcula next_attempt_at com backoff
-- (1m, 5m, 15m, 1h, 4h) e move pra 'dead' após 5 tentativas.
create or replace function mark_outbox_failed(p_id uuid, p_error text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  new_attempts integer;
  delays interval[] := array['1 minute', '5 minutes', '15 minutes', '1 hour', '4 hours']::interval[];
  next_delay interval;
begin
  update notification_outbox
  set attempts = attempts + 1,
      last_error = p_error,
      updated_at = now(),
      status = case when attempts + 1 >= 5 then 'dead' else 'pending' end,
      next_attempt_at = case
        when attempts + 1 >= 5 then next_attempt_at
        else now() + delays[least(attempts + 1, array_length(delays, 1))]
      end
  where id = p_id and automation_job_id is null and automation_initial_token is null
  returning attempts into new_attempts;
end;
$$;


commit;
