-- Separate dispatch-version authority. Installation does not enable a flag,
-- release a binding, send a message or submit a model.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

alter table public.whatsapp_automation_jobs
  add column if not exists initial_template_version integer not null default 1,
  add column if not exists initial_selection_source text not null default 'legacy',
  add column if not exists initial_selection_revision bigint not null default 0,
  add column if not exists initial_enrollment_id uuid,
  add column if not exists initial_catalog_digest text;
alter table public.whatsapp_automation_jobs
  drop constraint if exists whatsapp_automation_initial_version_check;
alter table public.whatsapp_automation_jobs
  add constraint whatsapp_automation_initial_version_check check (
    initial_template_version in (1,2) and
    initial_selection_source in ('legacy','admin','auto') and
    initial_selection_revision>=0 and
    (initial_catalog_digest is null or initial_catalog_digest ~ '^[a-f0-9]{64}$') and
    (initial_catalog_key is null or
      (initial_template_version=1 and initial_catalog_key like '%\_v1' escape '\') or
      (initial_template_version=2 and initial_catalog_key like '%\_v2' escape '\')) and
    (initial_selection_source='legacy' and initial_template_version=1 and
      initial_selection_revision=0 and initial_enrollment_id is null
      or initial_selection_source='admin' and initial_selection_revision>0 and
        initial_enrollment_id is null and initial_catalog_digest is not null
      or initial_selection_source='auto' and initial_template_version=2 and
        initial_selection_revision>0 and initial_enrollment_id is not null and
        initial_catalog_digest is not null)
  );

alter table public.whatsapp_template_cost_authorizations
  add column if not exists version integer not null default 1;
alter table public.whatsapp_template_cost_authorizations
  drop constraint if exists whatsapp_template_cost_authorizations_version_check;
alter table public.whatsapp_template_cost_authorizations
  add constraint whatsapp_template_cost_authorizations_version_check check(version in (1,2));
create index if not exists whatsapp_template_cost_auth_version_idx
  on public.whatsapp_template_cost_authorizations
  (account_id,binding_id,binding_generation,version,valid_until);

create table if not exists app_private.whatsapp_automation_version_selections (
  binding_id uuid not null,
  kind text not null check(kind in('confirmation','reminder_d1','survey_d1',
    'waitlist_entered','waitlist_feedback','voucher_issued','cancellation','waitlist_table_ready')),
  version integer not null check(version in(1,2)),
  revision bigint not null check(revision>0),
  actor_id uuid not null references auth.users(id) on delete restrict,
  unit_id uuid not null references public.units(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  account_id uuid not null references public.whatsapp_template_accounts(id) on delete cascade,
  channel_id uuid not null,
  binding_generation bigint not null check(binding_generation>0),
  credential_revision bigint not null check(credential_revision>=0),
  catalog_digest text not null check(catalog_digest ~ '^[a-f0-9]{64}$'),
  selected_at timestamptz not null default clock_timestamp(),
  primary key(binding_id,kind)
);
create index if not exists whatsapp_automation_version_selections_unit_idx
  on app_private.whatsapp_automation_version_selections(unit_id,binding_id);
alter table app_private.whatsapp_automation_version_selections enable row level security;
alter table app_private.whatsapp_automation_version_selections force row level security;
revoke all on app_private.whatsapp_automation_version_selections
  from public,anon,authenticated,service_role;

create table if not exists app_private.whatsapp_automation_version_selection_events (
  id bigint generated always as identity primary key,
  binding_id uuid not null,
  kind text not null,
  old_version integer,
  new_version integer not null check(new_version in(1,2)),
  revision bigint not null,
  actor_id uuid not null,
  unit_id uuid not null,
  selected_at timestamptz not null default clock_timestamp()
);
alter table app_private.whatsapp_automation_version_selection_events enable row level security;
alter table app_private.whatsapp_automation_version_selection_events force row level security;
revoke all on app_private.whatsapp_automation_version_selection_events
  from public,anon,authenticated,service_role;
revoke all on sequence app_private.whatsapp_automation_version_selection_events_id_seq
  from public,anon,authenticated,service_role;

-- The existing five-argument RPC remains version 1 by its INSERT default.
create or replace function public.authorize_whatsapp_marketing_cost(
  p_channel_id uuid,p_expected_binding_generation bigint,p_category text,
  p_valid_from timestamptz,p_valid_until timestamptz,p_version integer)
returns uuid language plpgsql security definer set search_path='' as $$
declare b public.whatsapp_template_bindings%rowtype; v_id uuid;
begin
  perform app_private.require_whatsapp_template_manager(null,true);
  if p_version is distinct from 2 or p_category is distinct from 'MARKETING'
    or p_valid_from is null or p_valid_until is null
    or not isfinite(p_valid_from) or not isfinite(p_valid_until)
    or p_valid_until<=p_valid_from or p_valid_until<=clock_timestamp() then
    raise exception 'template_management_invalid' using errcode='22023'; end if;
  b:=app_private.lock_whatsapp_management_binding(
    p_channel_id,p_expected_binding_generation,true,false);
  if b.provider is distinct from 'datafy' then
    raise exception 'template_management_invalid' using errcode='22023'; end if;
  insert into public.whatsapp_template_cost_authorizations
    (account_id,binding_id,binding_generation,category,valid_from,valid_until,actor_id,version)
    values(b.account_id,b.id,b.generation,'MARKETING',p_valid_from,p_valid_until,auth.uid(),2)
    returning id into v_id;
  insert into public.audit_log(table_name,record_id,action,new_values,actor_id,unit_id)
    values('whatsapp_template_cost_authorizations',v_id::text,'INSERT',
      jsonb_build_object('category','MARKETING','version',2,'binding_generation',b.generation,
        'valid_from',p_valid_from,'valid_until',p_valid_until),auth.uid(),b.unit_id);
  return v_id;
end $$;
revoke all on function public.authorize_whatsapp_marketing_cost(
  uuid,bigint,text,timestamptz,timestamptz,integer) from public,anon,authenticated,service_role;
grant execute on function public.authorize_whatsapp_marketing_cost(
  uuid,bigint,text,timestamptz,timestamptz,integer) to authenticated;

-- This is a factual model/grant gate, not authority to dispatch or charge.
create or replace function app_private.whatsapp_automation_v2_readiness(
  p_binding_id uuid,p_kind text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare
  b public.whatsapp_template_bindings%rowtype;
  c public.whatsapp_channels%rowtype;
  a public.whatsapp_template_accounts%rowtype;
  g app_private.whatsapp_template_v2_grants%rowtype;
  e app_private.whatsapp_template_v2_enrollments%rowtype;
  cohort app_private.whatsapp_template_account_cohorts%rowtype;
  policy app_private.whatsapp_template_v2_policy%rowtype;
  t public.whatsapp_remote_templates%rowtype;
  ap app_private.whatsapp_template_approved_submissions%rowtype;
  v_base text; v_name text; v_names text[]; v_variants jsonb:='[]'::jsonb;
  v_reason text:='ready'; v_variant_reason text; v_base_reason text;
  v_variant_ready boolean; v_digest text;
begin
  if p_kind is null or p_kind not in('confirmation','reminder_d1','survey_d1',
    'waitlist_entered','waitlist_feedback','voucher_issued','cancellation','waitlist_table_ready') then
    return jsonb_build_object('ready',false,'reason_code','dependency_unavailable','variants','[]'::jsonb);
  end if;
  v_base:=case p_kind when 'confirmation' then 'res_confirmacao'
    when 'reminder_d1' then 'res_lembrete_dia'
    when 'survey_d1' then 'res_pesquisa_reserva'
    when 'waitlist_entered' then 'fila_entrada'
    when 'waitlist_feedback' then 'fila_feedback'
    when 'voucher_issued' then 'mkt_voucher_programado'
    when 'cancellation' then 'res_cancelada'
    when 'waitlist_table_ready' then 'fila_mesa_pronta' end;
  v_names:=case when p_kind='confirmation' then
    array['res_confirmacao_v2','res_confirmacao_desconto_v2'] else array[v_base||'_v2'] end;
  v_digest:=app_private.whatsapp_template_approved_catalog_digest(2);
  select * into b from public.whatsapp_template_bindings where id=p_binding_id;
  if b.id is not null then
    select * into a from public.whatsapp_template_accounts where id=b.account_id;
    select * into c from public.whatsapp_channels where id=b.channel_id;
    select * into g from app_private.whatsapp_template_v2_grants
      where binding_id=b.id and revoked_at is null;
    select * into e from app_private.whatsapp_template_v2_enrollments
      where onboarding_id=g.onboarding_id;
    select * into cohort from app_private.whatsapp_template_account_cohorts
      where account_id=b.account_id;
    select * into policy from app_private.whatsapp_template_v2_policy where id=1;
  end if;
  if b.id is null or a.id is null or c.id is null
    or (b.provider,b.unit_id,b.account_id,b.channel_credential_revision)
      is distinct from ('datafy',c.unit_id,a.id,c.template_credential_revision)
    or not exists(select 1 from public.units u
      where u.id=b.unit_id and u.organization_id=a.organization_id)
    or b.verified_at is null or a.verified_at is null then
    v_reason:='binding_changed';
  elsif c.status<>'connected' or c.is_active is distinct from true
    or c.last_health_check_at is null or c.last_health_check_at<clock_timestamp()-interval '5 minutes' then
    v_reason:='channel_unavailable';
  elsif v_digest is null or g.id is null or e.onboarding_id is null or cohort.account_id is null
    or g.revoked_at is not null or e.excluded_at is not null
    or (g.organization_id,g.unit_id,g.channel_id,g.account_id,g.binding_generation,
      g.credential_revision,g.catalog_digest,g.policy_revision,g.origin)
      is distinct from (a.organization_id,b.unit_id,b.channel_id,a.id,b.generation,
        b.channel_credential_revision,v_digest,cohort.policy_revision,cohort.origin)
    or (e.organization_id,e.unit_id,e.channel_id,e.binding_id,e.binding_generation,
      e.credential_revision,e.catalog_digest,e.policy_revision,e.origin,e.state)
      is distinct from (a.organization_id,b.unit_id,b.channel_id,b.id,b.generation,
        b.channel_credential_revision,v_digest,cohort.policy_revision,cohort.origin,'ready')
    or not exists(select 1 from public.whatsapp_datafy_onboardings o
      where o.id=e.onboarding_id and o.state='completed'
        and (o.organization_id,o.unit_id,o.reserved_channel_id)
          =(a.organization_id,b.unit_id,b.channel_id)) then
    v_reason:='grant_unavailable';
  elsif cohort.origin='auto' and (not coalesce(policy.enabled,false)
      or (policy.revision,policy.catalog_digest,policy.actor_id)
        is distinct from (cohort.policy_revision,v_digest,cohort.actor_id)) then
    v_reason:='policy_paused';
  elsif cohort.origin='manual' and cohort.policy_revision<>0 then
    v_reason:='grant_unavailable';
  elsif a.sync_capture_id is null or a.last_sync_published_at is null
    or a.last_sync_published_at<clock_timestamp()-interval '60 seconds'
    or not exists(select 1 from public.whatsapp_template_bindings sb
      join public.whatsapp_channels sc on sc.id=sb.channel_id
      join public.units su on su.id=sb.unit_id
      where sb.id=a.sync_binding_id and sb.account_id=a.id
        and sb.verified_at is not null and sb.generation=a.sync_binding_generation
        and sb.channel_credential_revision=a.sync_credential_revision
        and sc.template_credential_revision=a.sync_credential_revision
        and sc.status='connected' and sc.provider='datafy'
        and sc.unit_id=sb.unit_id and su.organization_id=a.organization_id) then
    v_reason:='sync_stale';
  end if;
  v_base_reason:=v_reason;
  foreach v_name in array v_names loop
    select * into ap from app_private.whatsapp_template_approved_submissions
      where logical_id=v_name and version=2 and language='pt_BR';
    select * into t from public.whatsapp_remote_templates
      where account_id=a.id and logical_id=v_name and version=2 and language='pt_BR';
    v_variant_ready:=coalesce(v_base_reason='ready' and ap.logical_id is not null and t.id is not null
      and (t.account_id,t.logical_id,t.version,t.language,t.name,t.requested_category,t.desired_hash)
        is not distinct from (a.id,v_name,2,'pt_BR',v_name,ap.requested_category,ap.desired_hash)
      and t.observed_hash is not distinct from ap.desired_hash
      and t.effective_category is not distinct from ap.requested_category
      and t.remote_id is not null and t.remote_status='APPROVED'
      and t.local_status='usable' and not t.sync_required
      and t.last_synced_at>=clock_timestamp()-interval '60 seconds'
      and t.binding_generation=a.binding_generation and t.quality<>'RED',false);
    v_variants:=v_variants||jsonb_build_array(jsonb_build_object(
      'logical_id',v_name,'status',coalesce(t.remote_status,'UNKNOWN'),'ready',v_variant_ready));
    if v_base_reason='ready' and not v_variant_ready then
      v_variant_reason:=case when t.id is null or t.remote_status in('UNKNOWN','PENDING','IN_APPEAL')
          then 'meta_pending'
        when t.remote_status in('REJECTED','PAUSED','DISABLED','PENDING_DELETION','DELETED','LIMIT_EXCEEDED')
          then 'meta_rejected'
        when t.quality='RED' then 'quality_blocked'
        when t.last_synced_at is null or t.last_synced_at<clock_timestamp()-interval '60 seconds'
          or t.sync_required then 'sync_stale'
        else 'catalog_drift' end;
      if v_reason='ready' or (case v_variant_reason
          when 'meta_rejected' then 5 when 'quality_blocked' then 4
          when 'sync_stale' then 3 when 'meta_pending' then 2 else 1 end)
        > (case v_reason
          when 'meta_rejected' then 5 when 'quality_blocked' then 4
          when 'sync_stale' then 3 when 'meta_pending' then 2 else 1 end) then
        v_reason:=v_variant_reason;
      end if;
    end if;
  end loop;
  if v_reason='ready' and p_kind in('waitlist_feedback','voucher_issued')
    and not exists(select 1 from public.whatsapp_template_cost_authorizations ca
      where ca.account_id=a.id and ca.binding_id=b.id and ca.binding_generation=b.generation
        and ca.category='MARKETING' and ca.version=2
        and ca.valid_from<=clock_timestamp() and ca.valid_until>clock_timestamp()
        and exists(select 1 from public.platform_admins pa where pa.user_id=ca.actor_id)) then
    v_reason:='cost_not_authorized';
  end if;
  return jsonb_build_object('ready',v_reason='ready','reason_code',v_reason,'variants',v_variants);
end $$;
revoke all on function app_private.whatsapp_automation_v2_readiness(uuid,text)
  from public,anon,authenticated,service_role;

create or replace function public.get_whatsapp_automation_version_selections(p_binding_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare b public.whatsapp_template_bindings%rowtype;
  c public.whatsapp_channels%rowtype;
  s app_private.whatsapp_automation_version_selections%rowtype;
  k text; v_entries jsonb:='[]'::jsonb; v_ready jsonb; v_resolved jsonb;
  v_version integer; v_source text;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or not app_private.is_platform_admin(auth.uid()) then
    raise exception 'template_management_forbidden' using errcode='42501'; end if;
  select * into b from public.whatsapp_template_bindings where id=p_binding_id;
  if not found then raise exception 'template_management_forbidden' using errcode='42501'; end if;
  select * into c from public.whatsapp_channels where id=b.channel_id;
  if c.id is null or (c.unit_id,c.provider,c.template_credential_revision)
    is distinct from (b.unit_id,b.provider,b.channel_credential_revision) then
    raise exception 'template_management_forbidden' using errcode='42501'; end if;
  foreach k in array array['confirmation','reminder_d1','survey_d1','waitlist_entered',
    'waitlist_feedback','voucher_issued','cancellation','waitlist_table_ready'] loop
    select * into s from app_private.whatsapp_automation_version_selections
      where binding_id=b.id and kind=k;
    v_version:=null; v_source:=null;
    begin
      v_resolved:=app_private.resolve_whatsapp_automation_version(b.unit_id,b.channel_id,k);
      v_version:=(v_resolved->>'version')::integer;
      v_source:=v_resolved->>'source';
    exception when sqlstate 'P0A03' then
      v_version:=null; v_source:=null;
    end;
    v_ready:=app_private.whatsapp_automation_v2_readiness(b.id,k);
    v_entries:=v_entries||jsonb_build_array(jsonb_build_object('kind',k,
      'selected_version',v_version,'selection_source',v_source,
      'revision',coalesce(s.revision,0),'v2_ready',v_ready->'ready',
      'v2_reason_code',v_ready->>'reason_code','variants',v_ready->'variants'));
  end loop;
  return jsonb_build_object('binding_id',b.id,'channel_id',b.channel_id,
    'generation',b.generation,'credential_revision',b.channel_credential_revision,
    'entries',v_entries);
end $$;
revoke all on function public.get_whatsapp_automation_version_selections(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.get_whatsapp_automation_version_selections(uuid)
  to authenticated;

create or replace function public.set_whatsapp_automation_version_selection(
  p_binding_id uuid,p_kind text,p_version integer,p_expected_revision bigint,
  p_expected_generation bigint,p_expected_credential_revision bigint)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare b public.whatsapp_template_bindings%rowtype;
  c public.whatsapp_channels%rowtype; a public.whatsapp_template_accounts%rowtype;
  s app_private.whatsapp_automation_version_selections%rowtype;
  v_unit uuid; v_org uuid; v_ready jsonb; v_digest text; v_revision bigint;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or not app_private.is_platform_admin(auth.uid()) then
    raise exception 'template_management_forbidden' using errcode='42501'; end if;
  if p_kind is null or p_kind not in('confirmation','reminder_d1','survey_d1',
      'waitlist_entered','waitlist_feedback','voucher_issued','cancellation','waitlist_table_ready')
    or p_version is null or p_version not in(1,2) or p_expected_revision is null or p_expected_revision<0
    or p_expected_generation is null or p_expected_credential_revision is null then
    return jsonb_build_object('state','refused','version',null,'revision',0); end if;
  select unit_id into v_unit from public.whatsapp_template_bindings where id=p_binding_id;
  if v_unit is null then
    return jsonb_build_object('state','refused','version',null,'revision',0); end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'whatsapp-cutover-unit:'||v_unit::text,0));
  select organization_id into v_org from public.units where id=v_unit for share;
  select * into a from public.whatsapp_template_accounts
    where id=(select account_id from public.whatsapp_template_bindings where id=p_binding_id) for share;
  select * into b from public.whatsapp_template_bindings where id=p_binding_id for update;
  select * into c from public.whatsapp_channels where id=b.channel_id for share;
  if v_org is null or a.id is null or b.id is null or c.id is null
    or (a.organization_id,b.unit_id,b.account_id,b.provider,c.unit_id,c.provider)
      is distinct from (v_org,v_unit,a.id,'datafy',v_unit,'datafy') then
    return jsonb_build_object('state','refused','version',null,'revision',0); end if;
  select * into s from app_private.whatsapp_automation_version_selections
    where binding_id=b.id and kind=p_kind for update;
  v_revision:=coalesce(s.revision,0);
  if (b.generation,b.channel_credential_revision,c.template_credential_revision,v_revision)
    is distinct from (p_expected_generation,p_expected_credential_revision,
      p_expected_credential_revision,p_expected_revision) then
    return jsonb_build_object('state','stale','version',s.version,'revision',v_revision); end if;
  if c.status<>'connected' or c.is_active is distinct from true or b.verified_at is null then
    return jsonb_build_object('state','not_ready','version',s.version,'revision',v_revision); end if;
  if p_version=2 then
    v_ready:=app_private.whatsapp_automation_v2_readiness(b.id,p_kind);
    if v_ready->>'ready' is distinct from 'true' then
      return jsonb_build_object('state','not_ready','version',s.version,'revision',v_revision); end if;
  end if;
  v_digest:=app_private.whatsapp_template_approved_catalog_digest(p_version);
  if v_digest is null then
    return jsonb_build_object('state','not_ready','version',s.version,'revision',v_revision); end if;
  insert into app_private.whatsapp_automation_version_selections
    (binding_id,kind,version,revision,actor_id,unit_id,organization_id,account_id,
      channel_id,binding_generation,credential_revision,catalog_digest)
    values(b.id,p_kind,p_version,v_revision+1,auth.uid(),b.unit_id,v_org,a.id,
      b.channel_id,b.generation,b.channel_credential_revision,v_digest)
    on conflict(binding_id,kind) do update set
      version=excluded.version,revision=excluded.revision,actor_id=excluded.actor_id,
      unit_id=excluded.unit_id,organization_id=excluded.organization_id,
      account_id=excluded.account_id,channel_id=excluded.channel_id,
      binding_generation=excluded.binding_generation,
      credential_revision=excluded.credential_revision,catalog_digest=excluded.catalog_digest,
      selected_at=clock_timestamp();
  insert into app_private.whatsapp_automation_version_selection_events
    (binding_id,kind,old_version,new_version,revision,actor_id,unit_id)
    values(b.id,p_kind,s.version,p_version,v_revision+1,auth.uid(),b.unit_id);
  return jsonb_build_object('state','selected','version',p_version,'revision',v_revision+1);
end $$;
revoke all on function public.set_whatsapp_automation_version_selection(
  uuid,text,integer,bigint,bigint,bigint) from public,anon,authenticated,service_role;
grant execute on function public.set_whatsapp_automation_version_selection(
  uuid,text,integer,bigint,bigint,bigint) to authenticated;

-- A one-use transaction permit connects the fenced public enqueue to the
-- final BEFORE INSERT trigger, after the existing scope trigger has run.
create table if not exists app_private.whatsapp_automation_version_insert_permits (
  tx_id bigint not null,
  unit_id uuid not null,
  kind text not null,
  resource_id uuid not null,
  version integer not null check(version in(1,2)),
  source text not null check(source in('legacy','admin','auto')),
  revision bigint not null,
  enrollment_id uuid,
  digest text,
  selected_channel_id uuid,
  selected_binding_id uuid,
  primary key(tx_id,unit_id,kind,resource_id)
);
alter table app_private.whatsapp_automation_version_insert_permits enable row level security;
alter table app_private.whatsapp_automation_version_insert_permits force row level security;
revoke all on app_private.whatsapp_automation_version_insert_permits
  from public,anon,authenticated,service_role;

create or replace function app_private.resolve_whatsapp_automation_version(
  p_unit_id uuid,p_channel_id uuid,p_kind text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare b public.whatsapp_template_bindings%rowtype;
  c public.whatsapp_channels%rowtype;
  a public.whatsapp_template_accounts%rowtype;
  s app_private.whatsapp_automation_version_selections%rowtype;
  e app_private.whatsapp_template_v2_enrollments%rowtype;
  p app_private.whatsapp_template_v2_policy%rowtype;
  cohort app_private.whatsapp_template_account_cohorts%rowtype;
  v_count integer; v_org uuid; v_digest text;
begin
  if p_unit_id is null or p_kind is null or p_kind not in(
    'confirmation','reminder_d1','survey_d1','waitlist_entered',
    'waitlist_feedback','voucher_issued','cancellation','waitlist_table_ready') then
    raise exception 'automation_version_unavailable' using errcode='P0A03'; end if;
  select organization_id into v_org from public.units where id=p_unit_id;
  if v_org is null then raise exception 'automation_version_unavailable' using errcode='P0A03'; end if;
  if p_channel_id is not null then
    select * into c from public.whatsapp_channels where id=p_channel_id;
    if c.id is null or c.unit_id is distinct from p_unit_id then
      raise exception 'automation_version_unavailable' using errcode='P0A03'; end if;
    select * into b from public.whatsapp_template_bindings where channel_id=c.id;
    if b.id is not null then
      select * into a from public.whatsapp_template_accounts where id=b.account_id;
      if (b.unit_id,b.channel_id,b.provider,b.account_id)
        is distinct from (p_unit_id,c.id,c.provider,a.id)
        or (a.id is not null and a.organization_id is distinct from v_org) then
        raise exception 'automation_version_unavailable' using errcode='P0A03'; end if;
      select * into s from app_private.whatsapp_automation_version_selections
        where binding_id=b.id and kind=p_kind;
      if s.binding_id is not null then
        if (s.unit_id,s.organization_id,s.account_id,s.channel_id,
            s.binding_generation,s.credential_revision)
          is distinct from (p_unit_id,v_org,a.id,c.id,b.generation,c.template_credential_revision)
          or b.channel_credential_revision is distinct from c.template_credential_revision
          or s.catalog_digest is distinct from
            app_private.whatsapp_template_approved_catalog_digest(s.version) then
          raise exception 'automation_version_unavailable' using errcode='P0A03'; end if;
        return jsonb_build_object('version',s.version,'source','admin','revision',s.revision,
          'enrollment_id',null,'digest',s.catalog_digest,'channel_id',c.id,'binding_id',b.id);
      end if;
    end if;
  end if;
  -- No first-match selection: zero or one exact auto enrollment for this unit.
  select count(*) into v_count from app_private.whatsapp_template_v2_enrollments x
    where x.unit_id=p_unit_id and x.origin='auto' and x.excluded_at is null;
  if v_count>1 then raise exception 'automation_version_unavailable' using errcode='P0A03'; end if;
  if v_count=1 then
    select * into e from app_private.whatsapp_template_v2_enrollments x
      where x.unit_id=p_unit_id and x.origin='auto' and x.excluded_at is null;
    select * into p from app_private.whatsapp_template_v2_policy where id=1;
    v_digest:=app_private.whatsapp_template_approved_catalog_digest(2);
    if p_channel_id is not null and p_channel_id is distinct from e.channel_id
      or not coalesce(p.enabled,false) or e.policy_revision is distinct from p.revision
      or e.catalog_digest is distinct from v_digest or p.catalog_digest is distinct from v_digest
      or not exists(select 1 from public.whatsapp_datafy_onboardings o
        where o.id=e.onboarding_id and (o.organization_id,o.unit_id,o.reserved_channel_id)
          =(v_org,p_unit_id,e.channel_id)) then
      raise exception 'automation_version_unavailable' using errcode='P0A03'; end if;
    if b.id is not null and b.account_id is not null then
      select * into cohort from app_private.whatsapp_template_account_cohorts
        where account_id=b.account_id;
      if cohort.account_id is null or cohort.origin<>'auto'
        or cohort.policy_revision is distinct from e.policy_revision
        or cohort.catalog_digest is distinct from v_digest then
        raise exception 'automation_version_unavailable' using errcode='P0A03'; end if;
    end if;
    return jsonb_build_object('version',2,'source','auto','revision',e.policy_revision,
      'enrollment_id',e.onboarding_id,'digest',v_digest,'channel_id',e.channel_id,
      'binding_id',b.id);
  end if;
  -- Excluded/stale automatic onboarding is not an invitation to downgrade.
  if exists(select 1 from app_private.whatsapp_template_v2_enrollments x
      where x.unit_id=p_unit_id and x.origin='auto')
    or exists(select 1 from public.whatsapp_datafy_onboardings o
      join app_private.whatsapp_template_v2_policy pol on pol.id=1
      where o.unit_id=p_unit_id and o.created_at>=pol.enabled_at and pol.enabled_at is not null
        and (p_channel_id is null or o.reserved_channel_id=p_channel_id)) then
    raise exception 'automation_version_unavailable' using errcode='P0A03'; end if;
  if p_channel_id is null then
    -- Only a unit with established managed adoption before the v2 policy may
    -- retain the old preconfiguration behaviour without a selected channel.
    if not exists(select 1 from public.whatsapp_automation_adoptions x
      where x.unit_id=p_unit_id) then
      raise exception 'automation_version_unavailable' using errcode='P0A03'; end if;
  elsif c.provider in('official','datafy') and
    (a.id is null or not exists(select 1 from public.whatsapp_remote_templates t
      where t.account_id=a.id and t.version=1)
      and not exists(select 1 from app_private.whatsapp_template_submission_grants g
        where g.binding_id=b.id and g.account_id=a.id)) then
    raise exception 'automation_version_unavailable' using errcode='P0A03';
  end if;
  return jsonb_build_object('version',1,'source','legacy','revision',0,
    'enrollment_id',null,'digest',app_private.whatsapp_template_approved_catalog_digest(1),
    'channel_id',p_channel_id,'binding_id',b.id);
end $$;
revoke all on function app_private.resolve_whatsapp_automation_version(uuid,uuid,text)
  from public,anon,authenticated,service_role;

-- The existing scope trigger runs first. This trigger consumes the precise
-- enqueue permit and fixes the versioned identity on the final NEW row.
create or replace function app_private.guard_whatsapp_automation_version()
returns trigger language plpgsql security definer set search_path='' as $$
declare p app_private.whatsapp_automation_version_insert_permits%rowtype;
  v_resource uuid; v_logical text; v_base text; t public.whatsapp_remote_templates%rowtype;
  ca public.whatsapp_template_cost_authorizations%rowtype;
begin
  if tg_op='UPDATE' then
    if (new.initial_template_version,new.initial_selection_source,new.initial_selection_revision,
        new.initial_enrollment_id,new.initial_catalog_digest)
      is distinct from (old.initial_template_version,old.initial_selection_source,
        old.initial_selection_revision,old.initial_enrollment_id,old.initial_catalog_digest) then
      raise exception 'automation_version_immutable' using errcode='23514'; end if;
    -- A historical v1 job may predate initial_catalog_key. State and receipt
    -- updates must not revalidate its unchanged remote pin as a new choice.
    if new.remote_template_id is distinct from old.remote_template_id
      and new.remote_template_id is not null and exists(select 1 from public.whatsapp_remote_templates x
        where x.id=new.remote_template_id and (x.version,x.logical_id)
          is distinct from (old.initial_template_version,
            coalesce(old.initial_catalog_key,new.initial_catalog_key))) then
      raise exception 'automation_version_remote_mismatch' using errcode='23514'; end if;
    if new.cost_authorization_id is not null then
      select * into ca from public.whatsapp_template_cost_authorizations where id=new.cost_authorization_id;
      if ca.id is null or ca.version is distinct from old.initial_template_version then
        raise exception 'automation_version_cost_mismatch' using errcode='23514'; end if;
    end if;
    return new;
  end if;
  v_resource:=coalesce(new.reservation_id,new.waitlist_id,new.voucher_id);
  delete from app_private.whatsapp_automation_version_insert_permits x
    where x.tx_id=txid_current() and x.unit_id=new.unit_id and x.kind=new.kind
      and x.resource_id=v_resource
    returning * into p;
  if p.tx_id is null or p.version not in(1,2)
    or p.selected_channel_id is distinct from new.channel_id
    or p.selected_binding_id is distinct from new.binding_id then
    raise exception 'automation_version_permit_refused' using errcode='23514'; end if;
  v_base:=case new.kind when 'confirmation' then
      case when (select r.applied_discount_percent>0 from public.reservations r
        where r.id=new.reservation_id) then 'res_confirmacao_desconto' else 'res_confirmacao' end
    when 'reminder_d1' then 'res_lembrete_dia'
    when 'survey_d1' then 'res_pesquisa_reserva'
    when 'waitlist_entered' then 'fila_entrada'
    when 'waitlist_feedback' then 'fila_feedback'
    when 'voucher_issued' then 'mkt_voucher_programado'
    when 'cancellation' then 'res_cancelada'
    when 'waitlist_table_ready' then 'fila_mesa_pronta' end;
  if v_base is null then raise exception 'automation_version_permit_refused' using errcode='23514'; end if;
  v_logical:=v_base||'_v'||p.version::text;
  new.initial_template_version:=p.version;
  new.initial_selection_source:=p.source;
  new.initial_selection_revision:=p.revision;
  new.initial_enrollment_id:=p.enrollment_id;
  new.initial_catalog_digest:=case when p.source='legacy' then null else p.digest end;
  new.initial_catalog_key:=v_logical;
  if p.version=2 then
    if new.provider is not null and new.provider is distinct from 'datafy' then
      raise exception 'automation_version_permit_refused' using errcode='23514'; end if;
    if new.account_id is not null then
      select * into t from public.whatsapp_remote_templates x
        where x.account_id=new.account_id and x.logical_id=v_logical
          and x.version=2 and x.language='pt_BR';
      if t.id is null then
        new.remote_template_id:=null; new.template_version:=null; new.sync_epoch:=null;
        new.pin_phase:='preconfiguration'; new.state:='blocked';
        new.error_code:='template_unconfigured';
      else
        new.remote_template_id:=t.id; new.template_version:=2; new.sync_epoch:=t.sync_epoch;
        if new.pin_phase='bound' and
          (app_private.whatsapp_automation_v2_readiness(new.binding_id,new.kind)->>'ready')
            is distinct from 'true' then
          new.state:='blocked'; new.error_code:='template_unavailable';
        end if;
      end if;
    end if;
  elsif new.remote_template_id is not null then
    perform 1 from public.whatsapp_remote_templates x where x.id=new.remote_template_id
      and x.logical_id=v_logical and x.version=1;
    if not found then raise exception 'automation_version_remote_mismatch' using errcode='23514'; end if;
  end if;
  return new;
end $$;
revoke all on function app_private.guard_whatsapp_automation_version()
  from public,anon,authenticated,service_role;
drop trigger if exists zz_whatsapp_automation_version_guard on public.whatsapp_automation_jobs;
create trigger zz_whatsapp_automation_version_guard before insert or update
  on public.whatsapp_automation_jobs for each row
  execute function app_private.guard_whatsapp_automation_version();

-- Factual v1 readiness shares the model/health/cost standard, without
-- inheriting any v2 grant or policy. It never authorizes an actual fact.
create or replace function app_private.whatsapp_automation_v1_readiness(
  p_binding_id uuid,p_kind text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare b public.whatsapp_template_bindings%rowtype;
  c public.whatsapp_channels%rowtype; a public.whatsapp_template_accounts%rowtype;
  t public.whatsapp_remote_templates%rowtype;
  ap app_private.whatsapp_template_approved_submissions%rowtype;
  v_base text; v_name text; v_names text[]; v_reason text:='ready';
  v_variant_ready boolean; v_variant_reason text; v_base_reason text;
begin
  v_base:=case p_kind when 'confirmation' then 'res_confirmacao'
    when 'reminder_d1' then 'res_lembrete_dia'
    when 'survey_d1' then 'res_pesquisa_reserva'
    when 'waitlist_entered' then 'fila_entrada'
    when 'waitlist_feedback' then 'fila_feedback'
    when 'voucher_issued' then 'mkt_voucher_programado'
    when 'cancellation' then 'res_cancelada'
    when 'waitlist_table_ready' then 'fila_mesa_pronta' end;
  if v_base is null then
    return jsonb_build_object('ready',false,'reason_code','dependency_unavailable'); end if;
  v_names:=case when p_kind='confirmation' then
    array['res_confirmacao_v1','res_confirmacao_desconto_v1'] else array[v_base||'_v1'] end;
  select * into b from public.whatsapp_template_bindings where id=p_binding_id;
  select * into c from public.whatsapp_channels where id=b.channel_id;
  select * into a from public.whatsapp_template_accounts where id=b.account_id;
  if b.id is null or c.id is null or a.id is null
    or (b.provider,b.unit_id,b.account_id,b.channel_credential_revision)
      is distinct from ('datafy',c.unit_id,a.id,c.template_credential_revision)
    or not exists(select 1 from public.units u where u.id=b.unit_id
      and u.organization_id=a.organization_id)
    or b.verified_at is null or a.verified_at is null then
    v_reason:='binding_changed';
  elsif c.status<>'connected' or c.is_active is distinct from true
    or c.last_health_check_at is null
    or c.last_health_check_at<clock_timestamp()-interval '5 minutes' then
    v_reason:='channel_unavailable';
  elsif a.sync_capture_id is null or a.last_sync_published_at is null
    or a.last_sync_published_at<clock_timestamp()-interval '60 seconds'
    or not exists(select 1 from public.whatsapp_template_bindings sb
      join public.whatsapp_channels sc on sc.id=sb.channel_id
      join public.units su on su.id=sb.unit_id
      where sb.id=a.sync_binding_id and sb.account_id=a.id
        and sb.verified_at is not null and sb.generation=a.sync_binding_generation
        and sb.channel_credential_revision=a.sync_credential_revision
        and sc.template_credential_revision=a.sync_credential_revision
        and sc.status='connected' and sc.provider='datafy'
        and sc.unit_id=sb.unit_id and su.organization_id=a.organization_id) then
    v_reason:='sync_stale';
  end if;
  v_base_reason:=v_reason;
  foreach v_name in array v_names loop
    select * into ap from app_private.whatsapp_template_approved_submissions
      where logical_id=v_name and version=1 and language='pt_BR';
    select * into t from public.whatsapp_remote_templates
      where account_id=a.id and logical_id=v_name and version=1 and language='pt_BR';
    v_variant_ready:=coalesce(v_base_reason='ready' and ap.logical_id is not null and t.id is not null
      and (t.account_id,t.logical_id,t.version,t.language,t.name,t.requested_category,t.desired_hash)
        is not distinct from (a.id,v_name,1,'pt_BR',v_name,ap.requested_category,ap.desired_hash)
      and t.observed_hash is not distinct from ap.desired_hash
      and t.effective_category is not distinct from ap.requested_category
      and t.remote_id is not null and t.remote_status='APPROVED'
      and t.local_status='usable' and not t.sync_required
      and t.last_synced_at>=clock_timestamp()-interval '60 seconds'
      and t.binding_generation=a.binding_generation
      and (t.requested_category<>'MARKETING' or t.quality<>'RED'),false);
    if v_base_reason='ready' and not v_variant_ready then
      v_variant_reason:=case when t.id is null or t.remote_status in('UNKNOWN','PENDING','IN_APPEAL')
          then 'meta_pending'
        when t.remote_status in('REJECTED','PAUSED','DISABLED','PENDING_DELETION','DELETED','LIMIT_EXCEEDED')
          then 'meta_rejected'
        when t.requested_category='MARKETING' and t.quality='RED' then 'quality_blocked'
        when t.last_synced_at is null
          or t.last_synced_at<clock_timestamp()-interval '60 seconds'
          or t.sync_required then 'sync_stale'
        else 'catalog_drift' end;
      if v_reason='ready' or (case v_variant_reason
          when 'meta_rejected' then 5 when 'quality_blocked' then 4
          when 'sync_stale' then 3 when 'meta_pending' then 2 else 1 end)
        > (case v_reason
          when 'meta_rejected' then 5 when 'quality_blocked' then 4
          when 'sync_stale' then 3 when 'meta_pending' then 2 else 1 end) then
        v_reason:=v_variant_reason;
      end if;
    end if;
  end loop;
  if v_reason='ready' and p_kind in('waitlist_feedback','voucher_issued')
    and not exists(select 1 from public.whatsapp_template_cost_authorizations ca
      where ca.account_id=a.id and ca.binding_id=b.id and ca.binding_generation=b.generation
        and ca.category='MARKETING' and ca.version=1
        and ca.valid_from<=clock_timestamp() and ca.valid_until>clock_timestamp()
        and exists(select 1 from public.platform_admins pa where pa.user_id=ca.actor_id)) then
    v_reason:='cost_not_authorized';
  end if;
  return jsonb_build_object('ready',v_reason='ready','reason_code',v_reason);
end $$;
revoke all on function app_private.whatsapp_automation_v1_readiness(uuid,text)
  from public,anon,authenticated,service_role;

-- Store projection is purpose-scoped and omits grants, cost, actor and pins.
create or replace function public.get_whatsapp_automation_dispatch_status(p_binding_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare b public.whatsapp_template_bindings%rowtype; k text; v_resolved jsonb;
  v_readiness jsonb; v_flag jsonb; v_version integer; v_logical text;
  v_state text; v_reason text; v_entries jsonb:='[]'::jsonb;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null then
    raise exception 'template_management_forbidden' using errcode='42501'; end if;
  select * into b from public.whatsapp_template_bindings where id=p_binding_id;
  if b.id is null or not (app_private.is_platform_admin(auth.uid())
    or exists(select 1 from public.unit_members m where m.unit_id=b.unit_id
      and m.user_id=auth.uid())) then
    raise exception 'template_management_forbidden' using errcode='42501'; end if;
  select value into v_flag from public.platform_flags where key='whatsapp_automation_dispatch';
  foreach k in array array['confirmation','reminder_d1','survey_d1','waitlist_entered',
    'waitlist_feedback','voucher_issued','cancellation','waitlist_table_ready'] loop
    v_version:=null; v_reason:='dependency_unavailable'; v_state:='review';
    begin
      v_resolved:=app_private.resolve_whatsapp_automation_version(b.unit_id,b.channel_id,k);
      v_version:=(v_resolved->>'version')::integer;
      v_logical:=case k when 'confirmation' then 'res_confirmacao'
        when 'reminder_d1' then 'res_lembrete_dia'
        when 'survey_d1' then 'res_pesquisa_reserva'
        when 'waitlist_entered' then 'fila_entrada'
        when 'waitlist_feedback' then 'fila_feedback'
        when 'voucher_issued' then 'mkt_voucher_programado'
        when 'cancellation' then 'res_cancelada'
        when 'waitlist_table_ready' then 'fila_mesa_pronta' end||'_v'||v_version::text;
      if v_version=2 then
        v_readiness:=app_private.whatsapp_automation_v2_readiness(b.id,k);
        v_reason:=v_readiness->>'reason_code';
        v_state:=case when v_reason='ready' then 'ready'
          when v_reason='meta_pending' then 'pending_meta'
          when v_reason='meta_rejected' then 'rejected'
          else 'review' end;
      else
        v_readiness:=app_private.whatsapp_automation_v1_readiness(b.id,k);
        v_reason:=v_readiness->>'reason_code';
        v_state:=case when v_reason='ready' then 'ready'
          when v_reason='meta_pending' then 'pending_meta'
          when v_reason='meta_rejected' then 'rejected'
          else 'review' end;
      end if;
      if v_state='ready' and (v_flag is distinct from 'true'::jsonb
        or b.dispatch_enabled is distinct from true or b.adopted_at is null
        or not exists(select 1 from public.whatsapp_automation_adoptions adoption
          where adoption.unit_id=b.unit_id)) then
        v_reason:='dispatch_paused'; v_state:='awaiting_dispatch'; end if;
    exception when sqlstate 'P0A03' then
      v_version:=null; v_logical:=null; v_reason:='dependency_unavailable'; v_state:='review';
    end;
    v_entries:=v_entries||jsonb_build_array(jsonb_build_object('kind',k,
      'template_version',v_version,'logical_id',v_logical,
      'readiness',v_state,'reason_code',v_reason));
  end loop;
  return jsonb_build_object('channel_id',b.channel_id,'generation',b.generation,
    'credential_revision',b.channel_credential_revision,'entries',v_entries);
end $$;
revoke all on function public.get_whatsapp_automation_dispatch_status(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.get_whatsapp_automation_dispatch_status(uuid) to authenticated;




-- Explicit version-aware enqueue inner; the public cutover fence remains unchanged.
create or replace function app_private.whatsapp_automation_enqueue_inner(p_intent jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare
  v_unit uuid; v_kind text; v_customer uuid; v_org uuid; v_resource_unit uuid;
  v_res uuid; v_wait uuid; v_voucher uuid; v_id uuid; v_logical text; v_fact timestamptz; v_expiry timestamptz;
  b public.whatsapp_template_bindings%rowtype; t public.whatsapp_remote_templates%rowtype;
  ch public.whatsapp_channels%rowtype; v_channel uuid; v_selected uuid; v_invalid boolean:=false; v_account uuid;
  v_flag jsonb; v_phase text:='bound'; v_state text:='queued'; v_error text; v_transport text; v_selection jsonb; v_version integer;
begin
  if jsonb_typeof(p_intent) is distinct from 'object' or (p_intent-array['unit_id','kind','reservation_id','waitlist_id','voucher_id','source_event_key','fact_at','expires_at','due_at','logical_id'])<>'{}'::jsonb then raise exception 'automation_intent_invalid' using errcode='22023'; end if;
  v_unit:=(p_intent->>'unit_id')::uuid; v_kind:=p_intent->>'kind';
  v_res:=(p_intent->>'reservation_id')::uuid; v_wait:=(p_intent->>'waitlist_id')::uuid; v_voucher:=(p_intent->>'voucher_id')::uuid;
  if num_nonnulls(v_res,v_wait,v_voucher)<>1 or v_kind is null or not ((v_kind in('confirmation','reminder_d1','survey_d1','cancellation') and v_res is not null) or (v_kind in('waitlist_entered','waitlist_feedback','waitlist_table_ready') and v_wait is not null) or (v_kind='voucher_issued' and v_voucher is not null)) then raise exception 'automation_intent_invalid' using errcode='22023'; end if;
  select organization_id into v_org from public.units where id=v_unit;
  if v_res is not null then select unit_id,customer_id into v_resource_unit,v_customer from public.reservations where id=v_res;
  elsif v_voucher is not null then select unit_id,customer_id into v_resource_unit,v_customer from public.vouchers where id=v_voucher;
  else
    select w.unit_id,c.id,(w.customer_id is not null and c.id is null) into v_resource_unit,v_customer,v_invalid from public.waitlist w join public.units u on u.id=w.unit_id left join public.customers c on c.organization_id=u.organization_id and c.phone=public.normalize_br_phone(w.customer_phone) and (w.customer_id is null or c.id=w.customer_id) where w.id=v_wait;
  end if;
  if v_org is null or v_resource_unit is distinct from v_unit or coalesce(v_invalid,false) then raise exception 'automation_resource_refused' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_unit::text||':'||v_kind||':'||coalesce(v_res,v_wait,v_voucher)::text,0));
  select id into v_id from public.whatsapp_automation_jobs where unit_id=v_unit and kind=v_kind and (reservation_id=v_res or waitlist_id=v_wait or voucher_id=v_voucher);
  if found then return v_id; end if;
  if exists(select from public.notifications_sent where unit_id=v_unit and kind=v_kind and status in('sent','delivered','read') and ((v_res is not null and reservation_id=v_res) or (v_wait is not null and waitlist_id=v_wait))) then return null; end if;
  if v_customer is not null then
    perform 1 from public.customers where id=v_customer and organization_id=v_org and deleted_at is null for share;
    if not found then raise exception 'automation_resource_refused' using errcode='42501'; end if;
  end if;
  v_fact:=(p_intent->>'fact_at')::timestamptz; v_expiry:=(p_intent->>'expires_at')::timestamptz;
  if v_fact is null or v_expiry is null or not isfinite(v_fact) or not isfinite(v_expiry) or v_expiry<v_fact or coalesce(p_intent->>'source_event_key','')='' then raise exception 'automation_fact_invalid' using errcode='22023'; end if;
  -- The public cutover wrapper can claim the fact after this inner returns.
  -- Require durable managed adoption even for an auto-v2 preconfiguration.
  select value into v_flag from public.platform_flags where key='whatsapp_automation_dispatch';
  if found and jsonb_typeof(v_flag) is distinct from 'boolean' then raise exception 'automation_dependency_unavailable' using errcode='PT503'; end if;
  v_logical:=case v_kind when 'confirmation' then case when (select applied_discount_percent>0 from public.reservations where id=v_res) then 'res_confirmacao_desconto_v1' else 'res_confirmacao_v1' end when 'reminder_d1' then 'res_lembrete_dia_v1' when 'survey_d1' then 'res_pesquisa_reserva_v1' when 'waitlist_entered' then 'fila_entrada_v1' when 'waitlist_feedback' then 'fila_feedback_v1' when 'voucher_issued' then 'mkt_voucher_programado_v1' when 'cancellation' then 'res_cancelada_v1' when 'waitlist_table_ready' then 'fila_mesa_pronta_v1' end;
  if p_intent ? 'logical_id' and replace(p_intent->>'logical_id','_v2','_v1') is distinct from v_logical then raise exception 'automation_intent_invalid' using errcode='22023'; end if;
  select id into v_channel from public.whatsapp_channels c where c.unit_id=v_unit and (c.is_active=true or (c.is_active is null and c.status='connected' and not exists(select from public.whatsapp_channels a where a.unit_id=v_unit and a.is_active=true))) order by c.is_active desc nulls last,c.created_at,c.id limit 1;
  select * into b from public.whatsapp_template_bindings where channel_id=v_channel;
  v_account:=b.account_id;
  if v_account is not null then perform 1 from public.whatsapp_template_accounts where id=v_account and organization_id=v_org for share; if not found then raise exception 'automation_configuration_changed' using errcode='PT503'; end if; end if;
  if b.id is not null then
    select * into b from public.whatsapp_template_bindings where id=b.id for share;
    if not found or b.account_id is distinct from v_account or b.channel_id is distinct from v_channel then raise exception 'automation_configuration_changed' using errcode='PT503'; end if;
  end if;
  if v_channel is not null then
    select * into ch from public.whatsapp_channels where id=v_channel for share;
    if not found or ch.unit_id is distinct from v_unit or (b.id is not null and (b.provider,b.unit_id) is distinct from (ch.provider,v_unit)) then raise exception 'automation_configuration_changed' using errcode='PT503'; end if;
    v_transport:=case when ch.provider in('official','datafy') then 'template' when ch.provider in('zapi','waha','uazapi') then 'text' end;
    if v_transport is null then raise exception 'automation_dependency_unavailable' using errcode='PT503'; end if;
  end if;
  select id into v_selected from public.whatsapp_channels c where c.unit_id=v_unit and (c.is_active=true or (c.is_active is null and c.status='connected' and not exists(select from public.whatsapp_channels a where a.unit_id=v_unit and a.is_active=true))) order by c.is_active desc nulls last,c.created_at,c.id limit 1;
  if v_selected is distinct from v_channel then raise exception 'automation_configuration_changed' using errcode='PT503'; end if;
  v_selection:=app_private.resolve_whatsapp_automation_version(v_unit,v_channel,v_kind);
  v_version:=(v_selection->>'version')::integer;
  if v_version not in(1,2) or (v_channel is not null
      and (v_selection->>'channel_id')::uuid is distinct from v_channel)
    or (v_selection->>'binding_id')::uuid is distinct from b.id then
    raise exception 'automation_version_unavailable' using errcode='P0A03'; end if;
  if not exists(select 1 from public.whatsapp_automation_adoptions where unit_id=v_unit) then
    raise exception 'automation_adoption_required' using errcode='P0A01'; end if;
  v_logical:=replace(v_logical,'_v1','_v'||v_version::text);
  if v_account is not null then select * into t from public.whatsapp_remote_templates where account_id=v_account and logical_id=v_logical and version=v_version and language='pt_BR' for share; end if;
  if v_channel is null then v_phase:='preconfiguration'; v_state:='blocked'; v_error:='channel_unconfigured';
  elsif b.id is null then v_phase:='preconfiguration'; v_state:='blocked'; v_error:='binding_unconfigured';
  elsif v_transport='template' and t.id is null then v_phase:='preconfiguration'; v_state:='blocked'; v_error:='template_unconfigured';
  end if;
  if b.id is not null and b.channel_credential_revision is distinct from ch.template_credential_revision then v_state:='needs_review'; v_error:='binding_changed';
  elsif v_phase='bound' and (v_flag is distinct from 'true'::jsonb or not b.dispatch_enabled or b.adopted_at is null) then v_state:='paused'; v_error:='dispatch_paused';
  elsif v_phase='bound' and (ch.status<>'connected' or ch.last_health_check_at is null or ch.last_health_check_at<clock_timestamp()-interval '5 minutes') then v_state:='blocked'; v_error:='channel_unavailable';
  elsif v_phase='bound' and v_transport='template' and (b.verified_at is null or t.sync_required or t.local_status<>'usable' or t.remote_status<>'APPROVED' or t.last_synced_at is null or t.last_synced_at<clock_timestamp()-interval '60 seconds') then v_state:='blocked'; v_error:='template_unavailable';
  end if;
  insert into app_private.whatsapp_automation_version_insert_permits
    (tx_id,unit_id,kind,resource_id,version,source,revision,enrollment_id,digest,
      selected_channel_id,selected_binding_id)
    values(txid_current(),v_unit,v_kind,coalesce(v_res,v_wait,v_voucher),v_version,
      v_selection->>'source',(v_selection->>'revision')::bigint,
      (v_selection->>'enrollment_id')::uuid,v_selection->>'digest',v_channel,b.id);
  insert into public.whatsapp_automation_jobs(unit_id,organization_id,kind,reservation_id,waitlist_id,voucher_id,customer_id,source_event_key,fact_at,expires_at,due_at,channel_id,provider,binding_id,binding_generation,transport,account_id,remote_template_id,template_version,sync_epoch,pin_phase,initial_credential_revision,initial_catalog_key,state,error_code)
  values(v_unit,v_org,v_kind,v_res,v_wait,v_voucher,v_customer,p_intent->>'source_event_key',v_fact,v_expiry,coalesce((p_intent->>'due_at')::timestamptz,clock_timestamp()),v_channel,ch.provider,b.id,b.generation,v_transport,v_account,t.id,t.version,t.sync_epoch,v_phase,ch.template_credential_revision,v_logical,v_state,v_error) returning id into v_id;
  if exists(select 1 from app_private.whatsapp_automation_version_insert_permits x
    where x.tx_id=txid_current() and x.unit_id=v_unit and x.kind=v_kind
      and x.resource_id=coalesce(v_res,v_wait,v_voucher)) then
    raise exception 'automation_version_permit_not_consumed' using errcode='23514'; end if;
  return v_id;
end $$;

revoke all on function app_private.whatsapp_automation_enqueue_inner(jsonb) from public,anon,authenticated,service_role;


-- Explicit version-aware final POST inner; public cutover core remains the fence.
create or replace function app_private.whatsapp_automation_post_inner(p_job_id uuid,p_fence uuid,p_generation bigint,p_consent_revision bigint,p_sync_epoch bigint,p_confirm_only boolean,p_expected jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare
  j public.whatsapp_automation_jobs%rowtype; b public.whatsapp_template_bindings%rowtype; gb public.whatsapp_template_bindings%rowtype;
  a public.whatsapp_template_accounts%rowtype; t public.whatsapp_remote_templates%rowtype;
  c public.customers%rowtype; ch public.whatsapp_channels%rowtype; gc public.whatsapp_channels%rowtype;
  ca public.whatsapp_template_cost_authorizations%rowtype; s public.whatsapp_promotion_slots%rowtype;
  v_now timestamptz; v_error text; v_current_customer uuid; v_resource_unit uuid; v_invalid boolean;
  v_job_found boolean; v_flag_invalid boolean; v_unit_matches boolean; v_adopted boolean; v_actor_valid boolean;
  v_old_job_exists boolean; v_old_job_posted boolean; v_resource_changed boolean:=false;
  v_current jsonb; v_normalized jsonb; v_schema jsonb; v_part jsonb; v_field record; v_section text;
  v_res public.reservations%rowtype; v_wait public.waitlist%rowtype; v_voucher public.vouchers%rowtype;
  v_unit public.units%rowtype; v_rule public.voucher_rules%rowtype;
  e_res public.reservations%rowtype; e_wait public.waitlist%rowtype; e_voucher public.vouchers%rowtype;
  e_unit public.units%rowtype; e_customer public.customers%rowtype; e_rule public.voucher_rules%rowtype;
  v_setting jsonb; v_setting_present boolean; v_key text; v_timezone text;
  v_revision bigint; v_decision text; v_selected uuid; v_days integer; v_flag jsonb; v_logical text; v_selection jsonb; v_ready jsonb; v_v2_authorized boolean:=false;
begin
  select * into j from public.whatsapp_automation_jobs where id=p_job_id;
  if not found or j.pin_phase<>'bound' or p_fence is null or p_confirm_only is null then return '{"allowed":false,"reason":"authority_changed"}'::jsonb; end if;
  if j.customer_id is not null then select * into c from public.customers where id=j.customer_id for update; end if;
  if j.account_id is not null then select * into a from public.whatsapp_template_accounts where id=j.account_id for share; end if;
  perform 1 from public.whatsapp_template_bindings where id in(j.binding_id,a.sync_binding_id) order by id for share;
  select * into b from public.whatsapp_template_bindings where id=j.binding_id;
  select * into gb from public.whatsapp_template_bindings where id=a.sync_binding_id;
  perform 1 from public.whatsapp_channels where id in(j.channel_id,gb.channel_id) order by id for share;
  select * into ch from public.whatsapp_channels where id=j.channel_id;
  select * into gc from public.whatsapp_channels where id=gb.channel_id;
  if j.remote_template_id is not null then select * into t from public.whatsapp_remote_templates where id=j.remote_template_id for share; end if;
  select revision,decision into v_revision,v_decision from public.whatsapp_message_consent_events where unit_id=j.unit_id and customer_id=j.customer_id and purpose=case when j.kind in('waitlist_feedback','voucher_issued') then 'promotional' else 'operational' end order by revision desc limit 1 for share;
  if j.kind in('waitlist_feedback','voucher_issued') then
    select * into s from public.whatsapp_promotion_slots where unit_id=j.unit_id and customer_id=j.customer_id for update;
    if j.transport='template' then
      if p_confirm_only then
        select * into ca from public.whatsapp_template_cost_authorizations where id=j.cost_authorization_id for share;
      else
        select * into ca from public.whatsapp_template_cost_authorizations x where x.account_id=j.account_id and x.binding_id=j.binding_id and x.binding_generation=j.binding_generation and x.category='MARKETING' and x.version=j.initial_template_version and x.valid_from<=clock_timestamp() and x.valid_until>clock_timestamp() and exists(select from public.platform_admins where user_id=x.actor_id) order by x.valid_until desc,x.id limit 1 for share;
      end if;
    end if;
  end if;
  select * into j from public.whatsapp_automation_jobs where id=p_job_id for update;
  v_job_found:=found;
  -- Timeless negative only; success and every temporal check use the FINAL clock.
  if not v_job_found or j.pin_phase<>'bound' or j.claim_token is distinct from p_fence
    or j.provider_message_id is not null or j.reconcile_required or j.customer_erased_at is not null then
    return '{"allowed":false,"reason":"authority_changed"}'::jsonb;
  end if;
  if p_confirm_only then
    if j.state<>'posting' or j.posting_started_at is null or j.attempts not between 1 and 5 then return '{"allowed":false,"reason":"authority_changed"}'::jsonb; end if;
  elsif j.state<>'claimed' or j.posting_started_at is not null or j.attempts>=5 then return '{"allowed":false,"reason":"authority_changed"}'::jsonb;
  end if;
  select value into v_flag from public.platform_flags where key='whatsapp_automation_dispatch';
  v_flag_invalid:=found and jsonb_typeof(v_flag) is distinct from 'boolean';
  if j.reservation_id is not null then select unit_id,customer_id into v_resource_unit,v_current_customer from public.reservations where id=j.reservation_id;
  elsif j.voucher_id is not null then select unit_id,customer_id into v_resource_unit,v_current_customer from public.vouchers where id=j.voucher_id;
  else
    select w.unit_id,cu.id,(w.customer_id is not null and cu.id is null) into v_resource_unit,v_current_customer,v_invalid from public.waitlist w join public.units u on u.id=w.unit_id left join public.customers cu on cu.organization_id=u.organization_id and cu.phone=public.normalize_br_phone(w.customer_phone) and (w.customer_id is null or cu.id=w.customer_id) where w.id=j.waitlist_id;
  end if;
  v_logical:=case j.kind when 'confirmation' then case when (select applied_discount_percent>0 from public.reservations where id=j.reservation_id) then 'res_confirmacao_desconto' else 'res_confirmacao' end when 'reminder_d1' then 'res_lembrete_dia' when 'survey_d1' then 'res_pesquisa_reserva' when 'waitlist_entered' then 'fila_entrada' when 'waitlist_feedback' then 'fila_feedback' when 'voucher_issued' then 'mkt_voucher_programado' when 'cancellation' then 'res_cancelada' when 'waitlist_table_ready' then 'fila_mesa_pronta' end||'_v'||j.initial_template_version::text;
  select id into v_selected from public.whatsapp_channels x where x.unit_id=j.unit_id and (x.is_active=true or (x.is_active is null and x.status='connected' and not exists(select from public.whatsapp_channels active where active.unit_id=j.unit_id and active.is_active=true))) order by x.is_active desc nulls last,x.created_at,x.id limit 1;
  select exists(select from public.units where id=j.unit_id and organization_id=j.organization_id) into v_unit_matches;
  select exists(select from public.whatsapp_automation_adoptions where unit_id=j.unit_id) into v_adopted;
  select exists(select from public.platform_admins where user_id=ca.actor_id) into v_actor_valid;
  select exists(select from public.whatsapp_automation_jobs old_job where old_job.id=s.job_id),
    exists(select from public.whatsapp_automation_jobs old_job where old_job.id=s.job_id and (old_job.posting_started_at is not null or old_job.state='uncertain'))
    into v_old_job_exists,v_old_job_posted;
  if j.kind in('waitlist_feedback','voucher_issued') and not p_confirm_only then
    select window_days into v_days from app_private.whatsapp_promotion_policy where singleton;
  end if;
  if j.initial_template_version=2 then
    begin
      v_selection:=app_private.resolve_whatsapp_automation_version(j.unit_id,j.channel_id,j.kind);
    exception when sqlstate 'P0A03' then
      v_selection:=null;
    end;
    v_ready:=app_private.whatsapp_automation_v2_readiness(j.binding_id,j.kind);
    v_v2_authorized:=coalesce(
      (v_selection->>'version')::integer=2
      and v_selection->>'source'=j.initial_selection_source
      and (v_selection->>'revision')::bigint=j.initial_selection_revision
      and (v_selection->>'enrollment_id')::uuid is not distinct from j.initial_enrollment_id
      and v_selection->>'digest' is not distinct from j.initial_catalog_digest
      and v_selection->>'binding_id'=j.binding_id::text
      and v_ready->>'ready'='true',false);
  end if;
  -- Snapshot reads execute after all ordered parent/job locks; no new row locks.
    if p_expected is not null then
    if not p_confirm_only or jsonb_typeof(p_expected) is distinct from 'object'
      or (p_expected-array['version','kind','resource','customer','unit','rule','setting'])<>'{}'::jsonb
      or not p_expected ?& array['version','kind','resource','customer','unit','rule','setting']
      or p_expected->'version' is distinct from '1'::jsonb
      or p_expected->'kind' is distinct from to_jsonb(j.kind) then
      return '{"allowed":false,"reason":"snapshot_invalid"}'::jsonb;
    end if;
    v_schema:=jsonb_build_object(
      'unit','{"id":"string","organization_id":"string","name":"string","slug":"string?","timezone":"string?"}'::jsonb,
      'customer','{"id":"string","organization_id":"string","name":"string?","phone":"string","do_not_contact":"boolean","deleted_at":"null"}'::jsonb,
      'rule','{"id":"string","unit_id":"string","trigger_type":"string"}'::jsonb,
      'setting','{"key":"string?","present":"boolean","value":"json"}'::jsonb,
      'resource',case when j.reservation_id is not null then
        '{"id":"string","unit_id":"string","customer_id":"string","date":"string","time":"string","status":"string","payment_status":"string?","source":"string","party_size":"number","reservation_code":"string","applied_discount_percent":"number?","satisfaction_rating":"number?"}'::jsonb
      when j.waitlist_id is not null then
        '{"id":"string","unit_id":"string","customer_id":"string?","customer_name":"string?","customer_phone":"string","party_size":"number","code":"number","status":"string","created_at":"string","seated_at":"string?"}'::jsonb
      else '{"id":"string","unit_id":"string","customer_id":"string","rule_id":"string","code":"string","discount_percent":"number","status":"string","issued_at":"string","created_at":"string","expires_at":"string"}'::jsonb end);
    foreach v_section in array array['unit','customer','rule','setting','resource'] loop
      v_part:=p_expected->v_section;
      if v_section='customer' and j.customer_id is null then
        if v_part is distinct from 'null'::jsonb or j.kind not in('waitlist_entered','waitlist_table_ready') then
          return '{"allowed":false,"reason":"snapshot_invalid"}'::jsonb; end if;
        continue;
      elsif v_section='rule' and j.voucher_id is null then
        if v_part is distinct from 'null'::jsonb then return '{"allowed":false,"reason":"snapshot_invalid"}'::jsonb; end if;
        continue;
      end if;
      if jsonb_typeof(v_part) is distinct from 'object' then return '{"allowed":false,"reason":"snapshot_invalid"}'::jsonb; end if;
      for v_field in select key,value #>> '{}' as field_type from jsonb_each(v_schema->v_section) loop
        if not v_part ? v_field.key or
          (v_field.field_type<>'json' and jsonb_typeof(v_part->v_field.key) is distinct from replace(v_field.field_type,'?','')
            and not (right(v_field.field_type,1)='?' and v_part->v_field.key='null'::jsonb)) then
          return '{"allowed":false,"reason":"snapshot_invalid"}'::jsonb;
        end if;
      end loop;
      if (v_part-array(select jsonb_object_keys(v_schema->v_section)))<>'{}'::jsonb then
        return '{"allowed":false,"reason":"snapshot_invalid"}'::jsonb;
      end if;
    end loop;
    -- This exception block contains input conversion ONLY. Relation/dependency
    -- failures outside it stay SQL errors and never become a known-zero reset.
    begin
      e_unit:=jsonb_populate_record(null::public.units,p_expected->'unit');
      if j.customer_id is not null then e_customer:=jsonb_populate_record(null::public.customers,p_expected->'customer'); end if;
      if j.reservation_id is not null then
        if (p_expected#>>'{resource,date}') !~ '^\d{4}-\d{2}-\d{2}$'
          or (p_expected#>>'{resource,time}') !~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\.[0-9]+)?)?$' then
          return '{"allowed":false,"reason":"snapshot_invalid"}'::jsonb; end if;
        e_res:=jsonb_populate_record(null::public.reservations,p_expected->'resource');
      elsif j.waitlist_id is not null then
        if (p_expected#>>'{resource,created_at}') !~ '(Z|[+-][0-9]{2}:[0-9]{2})$'
          or ((p_expected#>>'{resource,seated_at}') is not null and (p_expected#>>'{resource,seated_at}') !~ '(Z|[+-][0-9]{2}:[0-9]{2})$') then
          return '{"allowed":false,"reason":"snapshot_invalid"}'::jsonb; end if;
        e_wait:=jsonb_populate_record(null::public.waitlist,p_expected->'resource');
      else
        if (p_expected#>>'{resource,issued_at}') !~ '(Z|[+-][0-9]{2}:[0-9]{2})$'
          or (p_expected#>>'{resource,created_at}') !~ '(Z|[+-][0-9]{2}:[0-9]{2})$'
          or (p_expected#>>'{resource,expires_at}') !~ '(Z|[+-][0-9]{2}:[0-9]{2})$' then
          return '{"allowed":false,"reason":"snapshot_invalid"}'::jsonb; end if;
        e_voucher:=jsonb_populate_record(null::public.vouchers,p_expected->'resource');
        e_rule:=jsonb_populate_record(null::public.voucher_rules,p_expected->'rule');
      end if;
    exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow or numeric_value_out_of_range then
      return '{"allowed":false,"reason":"snapshot_invalid"}'::jsonb;
    end;
    v_key:=case j.kind when 'confirmation' then null when 'cancellation' then null when 'waitlist_table_ready' then null when 'voucher_issued' then 'giftback_whatsapp_enabled' else j.kind||'_enabled' end;
    if (e_unit.id,e_unit.organization_id) is distinct from (j.unit_id,j.organization_id)
      or (j.customer_id is not null and ((e_customer.id,e_customer.organization_id,e_customer.deleted_at,e_customer.do_not_contact)
        is distinct from (j.customer_id,j.organization_id,null::timestamptz,false)
        or not coalesce(public.normalize_br_phone(e_customer.phone) ~ '^[1-9][0-9]{9,10}$',false)))
      or (p_expected#>>'{setting,key}') is distinct from v_key
      or (p_expected#>>'{setting,present}')='false' and p_expected#>'{setting,value}' is distinct from 'null'::jsonb
      or v_key is null and (p_expected#>>'{setting,present}')<>'false'
      or p_expected#>'{setting,value}' in ('false'::jsonb,'"false"'::jsonb) then
      return '{"allowed":false,"reason":"snapshot_invalid"}'::jsonb;
    end if;
    -- Capture validity is stricter than the nullable fixture bridge; missing
    -- production-required facts never become eligible through JSON NULL.
    if j.reservation_id is not null then
      if (e_res.id,e_res.unit_id,e_res.customer_id,e_res.status) is distinct from (j.reservation_id,j.unit_id,j.customer_id,case when j.kind='cancellation' then 'cancelled' else 'confirmed' end)
        or e_res.date is null or not isfinite(e_res.date) or e_res.time is null or e_res.time>='24:00'::time
        or e_res.party_size is null or e_res.party_size not between 1 and 999999 or nullif(btrim(e_res.reservation_code),'') is null
        or e_res.source is null or e_res.source not in('web','whatsapp')
        or e_res.payment_status is not null and e_res.payment_status not in('not_required','pending_payment','paid','failed','refunded','expired')
        or j.kind='confirmation' and e_res.payment_status is not null and e_res.payment_status not in('not_required','paid')
        or e_res.applied_discount_percent is not null and e_res.applied_discount_percent not between 0 and 100
        or e_res.satisfaction_rating is not null and e_res.satisfaction_rating not between 1 and 5
        or j.kind='survey_d1' and (e_res.satisfaction_rating is not null or e_res.date is distinct from (j.fact_at at time zone 'America/Sao_Paulo')::date) then
        return '{"allowed":false,"reason":"snapshot_invalid"}'::jsonb;
      end if;
      select * into v_res from public.reservations where id=j.reservation_id;
      v_normalized:=jsonb_build_object('id',e_res.id,'unit_id',e_res.unit_id,'customer_id',e_res.customer_id,'date',e_res.date,'time',e_res.time,
        'status',e_res.status,'payment_status',e_res.payment_status,'source',e_res.source,'party_size',e_res.party_size,
        'reservation_code',e_res.reservation_code,'applied_discount_percent',e_res.applied_discount_percent,'satisfaction_rating',e_res.satisfaction_rating);
      v_current:=jsonb_build_object('id',v_res.id,'unit_id',v_res.unit_id,'customer_id',v_res.customer_id,'date',v_res.date,'time',v_res.time,
        'status',v_res.status,'payment_status',v_res.payment_status,'source',v_res.source,'party_size',v_res.party_size,
        'reservation_code',v_res.reservation_code,'applied_discount_percent',v_res.applied_discount_percent,'satisfaction_rating',v_res.satisfaction_rating);
    elsif j.waitlist_id is not null then
      if (e_wait.id,e_wait.unit_id) is distinct from (j.waitlist_id,j.unit_id)
        or e_wait.customer_id is not null and e_wait.customer_id is distinct from j.customer_id
        or e_wait.created_at is null or not isfinite(e_wait.created_at)
        or not coalesce(public.normalize_br_phone(e_wait.customer_phone) ~ '^[1-9][0-9]{9,10}$',false)
        or e_wait.party_size is null or e_wait.party_size not between 1 and 999999 or e_wait.code is null or e_wait.code<1
        or j.kind='waitlist_entered' and e_wait.status is distinct from 'waiting'
        or j.kind='waitlist_table_ready' and (e_wait.status is distinct from 'notified' or e_wait.seated_at is not null)
        or j.kind='waitlist_feedback' and (e_wait.status is distinct from 'seated' or e_wait.seated_at is null or not isfinite(e_wait.seated_at)
          or (e_wait.seated_at at time zone 'America/Sao_Paulo')::date is distinct from (j.fact_at at time zone 'America/Sao_Paulo')::date)
        or j.customer_id is not null and public.normalize_br_phone(e_wait.customer_phone) is distinct from public.normalize_br_phone(e_customer.phone) then
        return '{"allowed":false,"reason":"snapshot_invalid"}'::jsonb;
      end if;
      select * into v_wait from public.waitlist where id=j.waitlist_id;
      v_normalized:=jsonb_build_object('id',e_wait.id,'unit_id',e_wait.unit_id,'customer_id',e_wait.customer_id,'customer_name',e_wait.customer_name,
        'customer_phone',public.normalize_br_phone(e_wait.customer_phone),'party_size',e_wait.party_size,'code',e_wait.code,'status',e_wait.status,'created_at',e_wait.created_at,'seated_at',e_wait.seated_at);
      v_current:=jsonb_build_object('id',v_wait.id,'unit_id',v_wait.unit_id,'customer_id',v_wait.customer_id,'customer_name',v_wait.customer_name,
        'customer_phone',public.normalize_br_phone(v_wait.customer_phone),'party_size',v_wait.party_size,'code',v_wait.code,'status',v_wait.status,'created_at',v_wait.created_at,'seated_at',v_wait.seated_at);
    else
      if (e_voucher.id,e_voucher.unit_id,e_voucher.customer_id,e_voucher.status) is distinct from (j.voucher_id,j.unit_id,j.customer_id,'active')
        or e_voucher.rule_id is null or nullif(btrim(e_voucher.code),'') is null or e_voucher.discount_percent is null or e_voucher.discount_percent not between 1 and 100
        or e_voucher.issued_at is null or not isfinite(e_voucher.issued_at) or e_voucher.created_at is null or not isfinite(e_voucher.created_at)
        or e_voucher.expires_at is null or not isfinite(e_voucher.expires_at)
        or (e_rule.id,e_rule.unit_id) is distinct from (e_voucher.rule_id,j.unit_id) or e_rule.trigger_type is null or e_rule.trigger_type not in('birthday','frequency') then
        return '{"allowed":false,"reason":"snapshot_invalid"}'::jsonb;
      end if;
      select * into v_voucher from public.vouchers where id=j.voucher_id;
      -- Parent comes from the ACTUAL resource, never e_rule.id.
      select * into v_rule from public.voucher_rules where id=v_voucher.rule_id and unit_id=j.unit_id;
      v_normalized:=jsonb_build_object('id',e_voucher.id,'unit_id',e_voucher.unit_id,'customer_id',e_voucher.customer_id,'rule_id',e_voucher.rule_id,'code',e_voucher.code,
        'discount_percent',e_voucher.discount_percent,'status',e_voucher.status,'issued_at',e_voucher.issued_at,'created_at',e_voucher.created_at,'expires_at',e_voucher.expires_at,
        'rule',jsonb_build_object('id',e_rule.id,'unit_id',e_rule.unit_id,'trigger_type',e_rule.trigger_type));
      v_current:=jsonb_build_object('id',v_voucher.id,'unit_id',v_voucher.unit_id,'customer_id',v_voucher.customer_id,'rule_id',v_voucher.rule_id,'code',v_voucher.code,
        'discount_percent',v_voucher.discount_percent,'status',v_voucher.status,'issued_at',v_voucher.issued_at,'created_at',v_voucher.created_at,'expires_at',v_voucher.expires_at,
        'rule',jsonb_build_object('id',v_rule.id,'unit_id',v_rule.unit_id,'trigger_type',v_rule.trigger_type));
    end if;
    v_resource_changed:=v_current is distinct from v_normalized;
    select * into v_unit from public.units where id=j.unit_id;
    if (v_unit.id,v_unit.organization_id,v_unit.name,v_unit.slug,v_unit.timezone) is distinct from
      (e_unit.id,e_unit.organization_id,e_unit.name,e_unit.slug,e_unit.timezone)
      or (j.customer_id is not null and (c.id,c.organization_id,c.name,public.normalize_br_phone(c.phone),c.do_not_contact,c.deleted_at)
        is distinct from (e_customer.id,e_customer.organization_id,e_customer.name,public.normalize_br_phone(e_customer.phone),e_customer.do_not_contact,e_customer.deleted_at)) then
      v_resource_changed:=true;
    end if;
    select value into v_setting from public.settings where unit_id=j.unit_id and key=v_key;
    v_setting_present:=found;
    if v_setting_present is distinct from (p_expected#>>'{setting,present}')::boolean
      or coalesce(v_setting,'null'::jsonb) is distinct from p_expected#>'{setting,value}' then v_resource_changed:=true; end if;
    v_timezone:=coalesce(v_unit.timezone,'America/Sao_Paulo');
    -- IANA/default contract; invalid zone is a refusal, not an exception/log of captured input.
    if not exists(select from pg_catalog.pg_timezone_names where lower(name)=lower(coalesce(e_unit.timezone,'America/Sao_Paulo'))) then
      return '{"allowed":false,"reason":"snapshot_invalid"}'::jsonb;
    end if;
    if not exists(select from pg_catalog.pg_timezone_names where lower(name)=lower(v_timezone)) then
      v_resource_changed:=true;
      v_timezone:='America/Sao_Paulo';
    end if;
  end if;

  -- Every relation read/wait above precedes this final authority clock. VOLATILE
  -- keeps READ COMMITTED snapshots fresh per statement. SQL commit -> POST is
  -- still an external concurrency window, not a provider atomicity guarantee.
  v_now:=clock_timestamp();
  if not v_job_found or j.pin_phase<>'bound' or j.claim_token is distinct from p_fence or j.claimed_until is null or j.claimed_until<=v_now
    or j.provider_message_id is not null or j.reconcile_required or j.customer_erased_at is not null then return '{"allowed":false,"reason":"authority_changed"}'::jsonb; end if;
  if p_confirm_only then
    if j.state<>'posting' or j.posting_started_at is null or j.attempts not between 1 and 5 then return '{"allowed":false,"reason":"authority_changed"}'::jsonb; end if;
  elsif j.state<>'claimed' or j.posting_started_at is not null or j.attempts>=5 then return '{"allowed":false,"reason":"authority_changed"}'::jsonb;
  end if;

  if v_flag_invalid then raise exception 'automation_dependency_unavailable' using errcode='PT503'; end if;
  if v_resource_unit is distinct from j.unit_id or v_current_customer is distinct from j.customer_id or coalesce(v_invalid,false) or not v_unit_matches then v_error:='recipient_changed';
  elsif j.customer_id is not null and (c.id is null or c.deleted_at is not null or c.organization_id is distinct from j.organization_id) then v_error:='customer_not_alive';
  elsif c.do_not_contact then v_error:='do_not_contact';
  elsif j.kind='cancellation' and not exists(select 1 from public.reservations r where r.id=j.reservation_id and r.unit_id=j.unit_id and r.status='cancelled' and r.cancelled_at=j.fact_at) then v_error:='recipient_changed';
  elsif j.kind='waitlist_table_ready' and not exists(select 1 from public.waitlist w where w.id=j.waitlist_id and w.unit_id=j.unit_id and w.status='notified' and w.seated_at is null and w.notified_at=j.fact_at and w.notified_server_at=j.fact_at) then v_error:='recipient_changed';
  elsif b.id is null or (b.unit_id,b.channel_id,b.provider,b.account_id,b.generation) is distinct from (j.unit_id,j.channel_id,j.provider,j.account_id,j.binding_generation) or b.channel_credential_revision is distinct from ch.template_credential_revision or p_generation is distinct from j.binding_generation or v_selected is distinct from j.channel_id then v_error:='binding_changed';
  elsif not b.dispatch_enabled or b.adopted_at is null or not v_adopted or v_flag is distinct from 'true'::jsonb then v_error:='dispatch_paused';
  elsif ch.id is null or ch.unit_id<>j.unit_id or ch.provider<>j.provider or ch.is_active=false or ch.status<>'connected' or ch.last_health_check_at is null or ch.last_health_check_at<v_now-interval '5 minutes' then v_error:='channel_unavailable';
  elsif v_now>j.expires_at then v_error:='expired';
  elsif j.kind in('waitlist_feedback','voucher_issued') and (j.customer_id is null or v_decision is distinct from 'opt_in' or v_revision is null or p_consent_revision is distinct from v_revision) then v_error:='consent_changed';
  elsif v_decision='opt_out' or p_consent_revision is distinct from v_revision or (p_confirm_only and j.consent_revision is distinct from v_revision) then v_error:='consent_changed';
  elsif j.kind in('waitlist_feedback','voucher_issued') and j.transport='template' and
    (ca.id is null or (ca.account_id,ca.binding_id,ca.binding_generation,ca.category,ca.version) is distinct from (j.account_id,j.binding_id,j.binding_generation,'MARKETING',j.initial_template_version) or ca.valid_from>v_now or ca.valid_until<=v_now or not v_actor_valid or t.requested_category is distinct from 'MARKETING' or (p_confirm_only and ca.id is distinct from j.cost_authorization_id)) then v_error:='cost_not_authorized';
  elsif j.kind in('waitlist_feedback','voucher_issued') and p_confirm_only and
    (s.id is null or (s.unit_id,s.customer_id,s.job_id,s.claim_token,s.state) is distinct from (j.unit_id,j.customer_id,j.id,p_fence,'reserved') or s.claimed_until<=v_now or s.claimed_until is distinct from j.claimed_until or s.window_until<=v_now or s.window_until is distinct from j.posting_started_at+make_interval(days=>s.window_days)) then v_error:='promotion_frequency';
  elsif j.kind in('waitlist_feedback','voucher_issued') and not p_confirm_only and s.id is not null and
    ((s.state in('accepted','uncertain') and s.window_until>v_now) or
     (s.state='reserved' and v_old_job_posted) or
     (s.state='reserved' and s.window_until>v_now and not v_old_job_exists) or
     (s.state='reserved' and s.job_id<>j.id and s.claimed_until>v_now and v_old_job_exists)) then v_error:='promotion_frequency';
  elsif j.initial_template_version=2 and not v_v2_authorized then v_error:='template_unavailable';
  elsif j.safe_log_body is null then v_error:='render_missing';
  elsif j.transport='template' and (a.id is null or a.organization_id<>j.organization_id or a.verified_at is null or b.verified_at is null or t.id is null
    or t.account_id<>j.account_id or t.version is distinct from j.initial_template_version or j.template_version is distinct from j.initial_template_version or t.logical_id<>v_logical or t.name<>v_logical or (j.initial_catalog_key is not null and j.initial_catalog_key<>v_logical)
    or t.binding_generation<>a.binding_generation or t.sync_required or t.local_status<>'usable' or t.remote_status<>'APPROVED' or t.language<>'pt_BR' or t.remote_id is null or t.observed_hash is distinct from t.desired_hash
    or t.requested_category is distinct from case when j.kind in('waitlist_feedback','voucher_issued') then 'MARKETING' else 'UTILITY' end
    or t.effective_category is distinct from t.requested_category
    or ((j.initial_template_version=2 or t.requested_category='MARKETING') and t.quality='RED')
    or t.last_synced_at is null or t.last_synced_at<v_now-interval '60 seconds' or p_sync_epoch is distinct from t.sync_epoch or (p_confirm_only and j.sync_epoch is distinct from t.sync_epoch)
    or a.sync_capture_id is null or a.last_sync_published_at is null or a.last_sync_published_at<v_now-interval '60 seconds'
    or gb.id is null or gc.id is null or gb.account_id is distinct from a.id or gb.verified_at is null or gb.generation is distinct from a.sync_binding_generation
    or gb.channel_credential_revision is distinct from a.sync_credential_revision or gc.template_credential_revision is distinct from a.sync_credential_revision
    or (gb.unit_id,gb.provider) is distinct from (gc.unit_id,gc.provider) or gc.status<>'connected') then v_error:='template_unavailable';
  elsif j.transport='text' and (p_sync_epoch is not null or j.sync_epoch is not null) then v_error:='template_unavailable';
  end if;
  if p_confirm_only then
    if v_error is not null then return '{"allowed":false,"reason":"authority_changed"}'::jsonb; end if;
        if p_expected is not null then
      if j.reservation_id is not null and j.kind in('confirmation','reminder_d1','cancellation') then
        -- Match the renderer/loader's HH:MM start, not a seconds-rounded start.
        if v_res.date is null or v_res.time is null
          or v_now>((v_res.date+make_time(extract(hour from v_res.time)::integer,extract(minute from v_res.time)::integer,0)) at time zone 'America/Sao_Paulo')
          or (v_now at time zone v_timezone)>(v_res.date+make_time(extract(hour from v_res.time)::integer,extract(minute from v_res.time)::integer,0))
          or (j.kind='reminder_d1' and v_res.date is distinct from (v_now at time zone v_timezone)::date) then
          v_resource_changed:=true;
        end if;
      elsif j.voucher_id is not null and (v_voucher.expires_at is null or v_now>=v_voucher.expires_at) then
        v_resource_changed:=true;
      end if;
      if v_resource_changed then return '{"allowed":false,"reason":"resource_changed"}'::jsonb; end if;
    end if;

    return '{"allowed":true}'::jsonb;
  end if;
  if v_error is not null then
    update public.whatsapp_automation_jobs set state=case when v_error in('binding_changed','recipient_changed') then 'needs_review' when v_error='dispatch_paused' then 'paused' when v_error='expired' then 'expired' else 'blocked' end,error_code=v_error,finished_at=case when v_error='expired' then coalesce(finished_at,v_now) else finished_at end where id=j.id and claim_token=p_fence;
    return '{"allowed":false,"reason":"authority_changed"}'::jsonb;
  end if;
  if j.kind in('waitlist_feedback','voucher_issued') then
    if s.id is not null then
      insert into app_private.whatsapp_promotion_slot_release_permits values(txid_current(),s.id);
      delete from public.whatsapp_promotion_slots where id=s.id;
    end if;
    if v_days is null then raise exception 'promotion_policy_unavailable' using errcode='P0A16'; end if;
    insert into public.whatsapp_promotion_slots(unit_id,customer_id,job_id,claim_token,claimed_until,window_until,window_days)
      values(j.unit_id,j.customer_id,j.id,p_fence,v_now+interval '90 seconds',v_now+make_interval(days=>v_days),v_days);
  end if;
  update public.whatsapp_automation_jobs set state='posting',posting_started_at=v_now,claimed_until=v_now+interval '90 seconds',attempts=attempts+1,sync_epoch=case when transport='template' then t.sync_epoch else null end,consent_revision=v_revision,cost_authorization_id=ca.id,error_code=null where id=j.id and claim_token=p_fence and state='claimed';
  return jsonb_build_object('allowed',found);
end $$;

revoke all on function app_private.whatsapp_automation_post_inner(uuid,uuid,bigint,bigint,bigint,boolean,jsonb) from public,anon,authenticated,service_role;


-- Pin initialization/revalidation preserves the first selected version and key.
create or replace function app_private.change_whatsapp_automation_pins(p_job_id uuid,p_expected_channel_id uuid,p_expected_binding_generation bigint,p_initialize boolean)
returns boolean language plpgsql security definer set search_path='' as $$
declare j public.whatsapp_automation_jobs%rowtype; initial_j public.whatsapp_automation_jobs%rowtype;
  b public.whatsapp_template_bindings%rowtype; ch public.whatsapp_channels%rowtype; t public.whatsapp_remote_templates%rowtype;
  old_t public.whatsapp_remote_templates%rowtype; s public.whatsapp_promotion_slots%rowtype;
  v_binding uuid; v_account uuid; v_channel uuid; v_template uuid; v_org uuid; v_unit uuid; v_customer uuid;
  v_invalid boolean; v_logical text; v_transport text; v_now timestamptz; n integer; v_selection jsonb; v_ready jsonb;
  before_pins app_private.whatsapp_automation_pin_tuple; after_pins app_private.whatsapp_automation_pin_tuple;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null then raise exception 'template_management_forbidden' using errcode='42501'; end if;
  select * into initial_j from public.whatsapp_automation_jobs where id=p_job_id;
  perform app_private.require_whatsapp_template_manager(initial_j.unit_id,p_initialize);
  if initial_j.id is null then raise exception 'template_management_forbidden' using errcode='42501'; end if;
  select organization_id into v_org from public.units where id=initial_j.unit_id;
  if v_org is distinct from initial_j.organization_id then raise exception 'template_management_forbidden' using errcode='42501'; end if;
  if initial_j.customer_id is not null then
    perform 1 from public.customers where id=initial_j.customer_id and organization_id=v_org and deleted_at is null for update;
    if not found then raise exception 'template_management_forbidden' using errcode='42501'; end if;
  end if;
  select id into v_channel from public.whatsapp_channels c where c.unit_id=initial_j.unit_id and (c.is_active=true or (c.is_active is null and c.status='connected' and not exists(select from public.whatsapp_channels x where x.unit_id=c.unit_id and x.is_active=true))) order by c.is_active desc nulls last,c.created_at,c.id limit 1;
  if v_channel is null or v_channel is distinct from p_expected_channel_id then raise exception 'template_configuration_changed' using errcode='PT409'; end if;
  select id,account_id into v_binding,v_account from public.whatsapp_template_bindings where channel_id=v_channel;
  if v_binding is null then return false; end if;
  -- Every old/new parent is discovered before locks and ordered by class/UUID.
  perform 1 from public.whatsapp_template_accounts where id in(initial_j.account_id,v_account) order by id for share;
  if v_account is not null and not exists(select from public.whatsapp_template_accounts where id=v_account and organization_id=v_org) then raise exception 'template_management_forbidden' using errcode='42501'; end if;
  if initial_j.account_id is not null and not exists(select from public.whatsapp_template_accounts where id=initial_j.account_id and organization_id=v_org) then return false; end if;
  perform 1 from public.whatsapp_template_bindings where id in(initial_j.binding_id,v_binding) order by id for share;
  if initial_j.binding_id is not null and not exists(select from public.whatsapp_template_bindings where id=initial_j.binding_id and unit_id=initial_j.unit_id) then return false; end if;
  select * into b from public.whatsapp_template_bindings where id=v_binding;
  if (b.account_id,b.channel_id,b.unit_id) is distinct from (v_account,v_channel,initial_j.unit_id) then raise exception 'template_configuration_changed' using errcode='PT409'; end if;
  perform 1 from public.whatsapp_channels where id in(initial_j.channel_id,v_channel) order by id for share;
  if initial_j.channel_id is not null and not exists(select from public.whatsapp_channels where id=initial_j.channel_id and unit_id=initial_j.unit_id) then return false; end if;
  select * into ch from public.whatsapp_channels where id=v_channel;
  if ch.id is null or (ch.unit_id,ch.provider,ch.template_credential_revision) is distinct from (b.unit_id,b.provider,b.channel_credential_revision)
    or p_expected_binding_generation is null or b.generation is distinct from p_expected_binding_generation then raise exception 'template_configuration_changed' using errcode='PT409'; end if;
  v_transport:=case when ch.provider='datafy' then 'template' when ch.provider in('zapi','waha','uazapi') then 'text' end;
  if v_transport is null or b.verified_at is null or not b.dispatch_enabled or b.adopted_at is null then return false; end if;
  if initial_j.reservation_id is not null then
    select unit_id,customer_id into v_unit,v_customer from public.reservations where id=initial_j.reservation_id;
  elsif initial_j.voucher_id is not null then
    select unit_id,customer_id into v_unit,v_customer from public.vouchers where id=initial_j.voucher_id;
  else
    select w.unit_id,c.id,(w.customer_id is not null and c.id is null) into v_unit,v_customer,v_invalid from public.waitlist w join public.units u on u.id=w.unit_id
      left join public.customers c on c.organization_id=u.organization_id and c.phone=public.normalize_br_phone(w.customer_phone) and (w.customer_id is null or c.id=w.customer_id) where w.id=initial_j.waitlist_id;
  end if;
  if v_invalid or (v_unit,v_customer) is distinct from (initial_j.unit_id,initial_j.customer_id) then raise exception 'template_management_forbidden' using errcode='42501'; end if;
  v_logical:=case initial_j.kind when 'confirmation' then case when (select applied_discount_percent>0 from public.reservations where id=initial_j.reservation_id) then 'res_confirmacao_desconto' else 'res_confirmacao' end
    when 'reminder_d1' then 'res_lembrete_dia' when 'survey_d1' then 'res_pesquisa_reserva' when 'waitlist_entered' then 'fila_entrada' when 'waitlist_feedback' then 'fila_feedback' when 'voucher_issued' then 'mkt_voucher_programado' when 'cancellation' then 'res_cancelada' when 'waitlist_table_ready' then 'fila_mesa_pronta' end||'_v'||initial_j.initial_template_version::text;
  if initial_j.initial_catalog_key is not null and initial_j.initial_catalog_key is distinct from v_logical then return false; end if;
  if initial_j.initial_template_version=2 then
    begin
      v_selection:=app_private.resolve_whatsapp_automation_version(initial_j.unit_id,v_channel,initial_j.kind);
    exception when sqlstate 'P0A03' then
      return false;
    end;
    v_ready:=app_private.whatsapp_automation_v2_readiness(b.id,initial_j.kind);
    if (v_selection->>'version')::integer is distinct from 2
      or v_selection->>'source' is distinct from initial_j.initial_selection_source
      or (v_selection->>'revision')::bigint is distinct from initial_j.initial_selection_revision
      or (v_selection->>'enrollment_id')::uuid is distinct from initial_j.initial_enrollment_id
      or v_selection->>'digest' is distinct from initial_j.initial_catalog_digest
      or v_selection->>'binding_id' is distinct from b.id::text
      or v_ready->>'ready' is distinct from 'true' then
      return false; end if;
  end if;
  if v_transport='template' then select id into v_template from public.whatsapp_remote_templates where account_id=v_account and logical_id=v_logical and version=initial_j.initial_template_version and language='pt_BR'; end if;
  perform 1 from public.whatsapp_remote_templates where id in(initial_j.remote_template_id,v_template) order by id for share;
  select * into t from public.whatsapp_remote_templates where id=v_template;
  select * into old_t from public.whatsapp_remote_templates where id=initial_j.remote_template_id;
  if v_transport='template' and (t.id is null or (t.account_id,t.logical_id,t.version,t.language) is distinct from (v_account,v_logical,initial_j.initial_template_version,'pt_BR')) then return false; end if;
  if initial_j.remote_template_id is not null and (old_t.id is null or old_t.logical_id is distinct from v_logical or old_t.version<>initial_j.initial_template_version) then return false; end if;
  perform 1 from public.whatsapp_message_consent_events where unit_id=initial_j.unit_id and customer_id=initial_j.customer_id order by id for share;
  select * into s from public.whatsapp_promotion_slots where unit_id=initial_j.unit_id and customer_id=initial_j.customer_id for update;
  if initial_j.cost_authorization_id is not null then perform 1 from public.whatsapp_template_cost_authorizations where id=initial_j.cost_authorization_id for share; end if;
  select * into j from public.whatsapp_automation_jobs where id=p_job_id for update;
  v_now:=clock_timestamp();
  if not found or to_jsonb(j) is distinct from to_jsonb(initial_j) then raise exception 'template_configuration_changed' using errcode='PT409'; end if;
  if not exists(select from public.units where id=j.unit_id and organization_id=v_org) then raise exception 'template_management_forbidden' using errcode='42501'; end if;
  -- Repeat resource identity without acquiring an earlier lock after job.
  if j.reservation_id is not null then select unit_id,customer_id into v_unit,v_customer from public.reservations where id=j.reservation_id;
  elsif j.voucher_id is not null then select unit_id,customer_id into v_unit,v_customer from public.vouchers where id=j.voucher_id;
  else select w.unit_id,c.id,(w.customer_id is not null and c.id is null) into v_unit,v_customer,v_invalid from public.waitlist w join public.units u on u.id=w.unit_id
    left join public.customers c on c.organization_id=u.organization_id and c.phone=public.normalize_br_phone(w.customer_phone) and (w.customer_id is null or c.id=w.customer_id) where w.id=j.waitlist_id; end if;
  if v_invalid or (v_unit,v_customer) is distinct from (j.unit_id,j.customer_id) then raise exception 'template_management_forbidden' using errcode='42501'; end if;
  if v_channel is distinct from (select id from public.whatsapp_channels c where c.unit_id=j.unit_id and (c.is_active=true or (c.is_active is null and c.status='connected' and not exists(select from public.whatsapp_channels x where x.unit_id=c.unit_id and x.is_active=true))) order by c.is_active desc nulls last,c.created_at,c.id limit 1) then raise exception 'template_configuration_changed' using errcode='PT409'; end if;
  if j.customer_erased_at is not null or j.posting_started_at is not null or j.provider_message_id is not null or j.reconcile_required
    or j.expires_at<v_now or j.finished_at is not null or j.attempts>=5 or (j.claimed_until is not null and j.claimed_until>v_now) then return false; end if;
  if ch.status<>'connected' or ch.last_health_check_at is null or ch.last_health_check_at<v_now-interval '5 minutes'
    or (ch.provider in('zapi','waha','uazapi') and (ch.webhook_secret is null or btrim(ch.webhook_secret)='')) then return false; end if;
  before_pins:=row(j.pin_phase,j.channel_id,j.provider,j.binding_id,j.binding_generation,j.transport,j.account_id,j.remote_template_id,j.template_version,j.sync_epoch,j.initial_credential_revision,j.initial_catalog_key)::app_private.whatsapp_automation_pin_tuple;
  after_pins:=row('bound',ch.id,ch.provider,b.id,b.generation,v_transport,b.account_id,t.id,t.version,t.sync_epoch,
    case when p_initialize then coalesce(j.initial_credential_revision,ch.template_credential_revision) else j.initial_credential_revision end,
    j.initial_catalog_key)::app_private.whatsapp_automation_pin_tuple;
  if p_initialize then
    if j.pin_phase<>'preconfiguration' or j.state not in('blocked','paused','needs_review') or j.attempts<>0 then return false; end if;
    -- Known historical values are immutable, even when the current setup changed.
    if (j.channel_id is not null and j.channel_id is distinct from ch.id) or (j.provider is not null and j.provider is distinct from ch.provider)
      or (j.binding_id is not null and j.binding_id is distinct from b.id) or (j.binding_generation is not null and j.binding_generation is distinct from b.generation)
      or (j.transport is not null and j.transport is distinct from v_transport) or (j.account_id is not null and j.account_id is distinct from b.account_id)
      or (j.initial_credential_revision is not null and j.initial_credential_revision is distinct from ch.template_credential_revision) then return false; end if;
    insert into app_private.whatsapp_automation_pin_initialization_permits values(txid_current(),auth.uid(),j.id,before_pins,after_pins);
  else
    if j.pin_phase<>'bound' or j.state not in('blocked','needs_review') or j.transport is distinct from v_transport
      or j.error_code is null or j.error_code not in('reservation_pending','payment_incompatible','reservation_not_confirmed','reservation_changed','reservation_past','reservation_wrong_day','survey_already_answered','waitlist_not_waiting','waitlist_not_seated','waitlist_wrong_day','waitlist_changed','voucher_not_active','voucher_expired','voucher_changed','recipient_changed','do_not_contact','invalid_timezone','service_suspended','channel_unavailable','channel_changed','binding_changed','consent_changed','cost_not_authorized','template_unavailable','template_sync_failed','render_invalid','render_missing','promotion_frequency','dependency_unavailable','final_service_suspended','final_channel_changed','final_consent_changed','final_resource_changed','final_gate_paused') then return false; end if;
    insert into app_private.whatsapp_automation_pin_revalidation_permits values(txid_current(),auth.uid(),j.id,before_pins,after_pins);
  end if;
  if s.id is not null and s.job_id=j.id then
    if s.state<>'reserved' or s.claim_token is distinct from j.claim_token then
      raise exception 'template_management_not_eligible' using errcode='PT409';
    end if;
    insert into app_private.whatsapp_promotion_slot_release_permits values(txid_current(),s.id);
    delete from public.whatsapp_promotion_slots where id=s.id;
  end if;
  update public.whatsapp_automation_jobs set pin_phase='bound',channel_id=ch.id,provider=ch.provider,binding_id=b.id,binding_generation=b.generation,
    transport=v_transport,account_id=b.account_id,remote_template_id=t.id,template_version=t.version,sync_epoch=t.sync_epoch,
    initial_credential_revision=after_pins.initial_credential_revision,state='queued',error_code=null,claim_token=null,claimed_until=null,safe_log_body=null,consent_revision=null,cost_authorization_id=null
    where id=j.id;
  get diagnostics n=row_count;
  if n<>1 or exists(select from app_private.whatsapp_automation_pin_initialization_permits where transaction_id=txid_current() and job_id=j.id)
    or exists(select from app_private.whatsapp_automation_pin_revalidation_permits where transaction_id=txid_current() and job_id=j.id) then raise exception 'template_management_permit_not_consumed'; end if;
  insert into public.audit_log(table_name,record_id,action,old_values,new_values,actor_id,unit_id,organization_id)
  values('whatsapp_automation_jobs',j.id::text,'UPDATE',to_jsonb(before_pins),jsonb_build_object('pins',to_jsonb(after_pins),'reason',case when p_initialize then 'initialize' else 'revalidate' end),auth.uid(),j.unit_id,j.organization_id);
  return true;
end $$;

revoke all on function app_private.change_whatsapp_automation_pins(uuid,uuid,bigint,boolean) from public,anon,authenticated,service_role;

commit;
