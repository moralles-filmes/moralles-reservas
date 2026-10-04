-- Additive catalog/dispatch storage. No producer, provider POST, cron or flag is enabled here.
begin;

create table if not exists public.whatsapp_template_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  waba_id text not null unique check(waba_id ~ '^[0-9]{1,64}$'),
  binding_generation bigint not null default 1 check(binding_generation>0),
  verified_at timestamptz not null,
  created_at timestamptz not null default now()
);
create table if not exists public.whatsapp_template_bindings (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references public.units(id) on delete cascade,
  channel_id uuid not null unique references public.whatsapp_channels(id) on delete cascade,
  account_id uuid references public.whatsapp_template_accounts(id) on delete no action deferrable initially deferred,
  provider text not null check(provider in('official','datafy','zapi','waha','uazapi')),
  generation bigint not null default 1 check(generation>0),
  verified_at timestamptz,
  adopted_at timestamptz,
  dispatch_enabled boolean not null default false,
  submission_authorized_at timestamptz,
  submission_authorized_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  check((provider in('official','datafy'))=(account_id is not null)),
  check(not dispatch_enabled or adopted_at is not null),
  check((submission_authorized_at is null)=(submission_authorized_by is null))
);
-- Unit-level history survives deletion/replacement of the selected channel/binding.
create table if not exists public.whatsapp_automation_adoptions (
  unit_id uuid primary key references public.units(id) on delete cascade,
  adopted_at timestamptz not null default now()
);
create table if not exists public.whatsapp_remote_templates (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.whatsapp_template_accounts(id) on delete cascade,
  logical_id text not null check(logical_id in('res_confirmacao_v1','res_confirmacao_desconto_v1','res_lembrete_dia_v1','res_pesquisa_reserva_v1','fila_entrada_v1','fila_feedback_v1','mkt_voucher_programado_v1')),
  version integer not null check(version>0),
  language text not null check(language='pt_BR'),
  remote_id text check(char_length(remote_id) between 1 and 512 and remote_id !~ '[[:cntrl:]]'),
  -- PostgreSQL bounds regex repetition at 255; validate the size separately.
  name text not null check(name ~ '^[a-z0-9_]+$' and char_length(name) between 1 and 512),
  desired_hash text not null check(desired_hash ~ '^[a-f0-9]{64}$'),
  observed_hash text check(observed_hash ~ '^[a-f0-9]{64}$'),
  requested_category text not null check(requested_category in('UTILITY','MARKETING')),
  effective_category text check(effective_category in('UTILITY','MARKETING','AUTHENTICATION','UNKNOWN')),
  remote_status text not null default 'UNKNOWN' check(remote_status in('UNKNOWN','PENDING','APPROVED','REJECTED','PAUSED','DISABLED','IN_APPEAL','PENDING_DELETION','DELETED','LIMIT_EXCEEDED')),
  quality text not null default 'UNKNOWN' check(quality in('UNKNOWN','GREEN','YELLOW','RED')),
  rejection_code text check(rejection_code ~ '^[A-Za-z0-9_]{1,64}$'),
  local_status text not null default 'queued' check(local_status in('awaiting_connection','queued','submitting','pending','usable','rejected','paused','disabled','conflict','sync_error','unsupported')),
  sync_required boolean not null default true,
  sync_epoch bigint not null default 0 check(sync_epoch>=0),
  binding_generation bigint not null check(binding_generation>0),
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  unique(account_id,logical_id,version,language),
  unique(account_id,name,language)
);
create table if not exists public.whatsapp_template_jobs (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.whatsapp_template_accounts(id) on delete cascade,
  binding_id uuid not null,
  binding_generation bigint not null check(binding_generation>0),
  operation text not null check(operation in('provision','sync','reconcile')),
  target_key text not null check(target_key ~ '^[a-z0-9_:.-]{1,160}$'),
  revision bigint not null default 1 check(revision>0),
  state text not null default 'queued' check(state in('queued','claimed','posting','accepted','rejected','uncertain','failed','done','paused','needs_review')),
  attempts integer not null default 0 check(attempts between 0 and 5),
  due_at timestamptz not null default now(),
  claim_token uuid,
  claimed_until timestamptz,
  posting_started_at timestamptz,
  provider_outcome text check(provider_outcome in('accepted','rejected','uncertain')),
  error_code text check(error_code ~ '^[a-z0-9_]{1,64}$'),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  unique(account_id,operation,target_key,revision),
  check((claim_token is null)=(claimed_until is null)),
  check(state not in('claimed','posting','uncertain') or claim_token is not null)
);
create table if not exists public.whatsapp_template_events (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.whatsapp_template_accounts(id) on delete cascade,
  field text not null check(field in('message_template_status_update','message_template_quality_update','template_category_update','message_template_components_update')),
  remote_id text check(char_length(remote_id) between 1 and 512 and remote_id !~ '[[:cntrl:]]'),
  name text check(name ~ '^[a-z0-9_]+$' and char_length(name) between 1 and 512),
  language text check(language='pt_BR'),
  event_time timestamptz not null,
  digest text not null check(digest ~ '^[a-f0-9]{64}$'),
  remote_status text check(remote_status in('UNKNOWN','PENDING','APPROVED','REJECTED','PAUSED','DISABLED','IN_APPEAL','PENDING_DELETION','DELETED','LIMIT_EXCEEDED')),
  quality text check(quality in('UNKNOWN','GREEN','YELLOW','RED')),
  effective_category text check(effective_category in('UTILITY','MARKETING','AUTHENTICATION','UNKNOWN')),
  processing_state text not null default 'pending' check(processing_state in('pending','processed','ignored')),
  processed_at timestamptz,
  received_at timestamptz not null default now(),
  unique(account_id,digest),
  check(remote_id is not null or name is not null)
);
create table if not exists public.whatsapp_template_cost_authorizations (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.whatsapp_template_accounts(id) on delete cascade,
  binding_id uuid not null,
  binding_generation bigint not null check(binding_generation>0),
  category text not null check(category='MARKETING'),
  valid_from timestamptz not null,
  valid_until timestamptz not null,
  actor_id uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  check(valid_until>valid_from)
);
create table if not exists public.whatsapp_automation_jobs (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references public.units(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  kind text not null check(kind in('confirmation','reminder_d1','survey_d1','waitlist_entered','waitlist_feedback','voucher_issued')),
  reservation_id uuid references public.reservations(id) on delete cascade,
  waitlist_id uuid references public.waitlist(id) on delete cascade,
  voucher_id uuid references public.vouchers(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  customer_erased_at timestamptz,
  source_event_key text not null check(char_length(source_event_key) between 1 and 160),
  fact_at timestamptz not null,
  -- Pinned technical IDs survive channel/binding deletion; INSERT guard validates parents.
  channel_id uuid not null,
  provider text not null check(provider in('official','datafy','zapi','waha','uazapi')),
  binding_id uuid not null,
  binding_generation bigint not null check(binding_generation>0),
  transport text not null check(transport in('text','template')),
  account_id uuid references public.whatsapp_template_accounts(id) on delete no action deferrable initially deferred,
  remote_template_id uuid references public.whatsapp_remote_templates(id) on delete no action deferrable initially deferred,
  template_version integer check(template_version>0),
  sync_epoch bigint check(sync_epoch>=0),
  notification_id uuid not null default gen_random_uuid() unique,
  safe_log_body text check(char_length(safe_log_body)<=4096 and safe_log_body !~ '/preferencias/mensagens/[A-Za-z0-9_-]{43}'),
  state text not null default 'queued' check(state in('queued','claimed','posting','accepted','blocked','expired','uncertain','retry_wait','needs_review','failed','reconciled','paused','rejected')),
  due_at timestamptz not null default now(),
  expires_at timestamptz not null,
  attempts integer not null default 0 check(attempts between 0 and 5),
  claim_token uuid,
  claimed_until timestamptz,
  posting_started_at timestamptz,
  provider_message_id text check(char_length(provider_message_id) between 1 and 512 and provider_message_id !~ '[[:cntrl:]]'),
  reconcile_required boolean not null default false,
  consent_revision bigint check(consent_revision>0),
  cost_authorization_id uuid references public.whatsapp_template_cost_authorizations(id) on delete no action deferrable initially deferred,
  error_code text check(error_code ~ '^[a-z0-9_]{1,64}$'),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  check(num_nonnulls(reservation_id,waitlist_id,voucher_id)=1),
  check(customer_id is not null or waitlist_id is not null or customer_erased_at is not null),
  check((kind in('confirmation','reminder_d1','survey_d1') and reservation_id is not null) or (kind in('waitlist_entered','waitlist_feedback') and waitlist_id is not null) or (kind='voucher_issued' and voucher_id is not null)),
  check((transport='template' and provider in('official','datafy') and account_id is not null and remote_template_id is not null and template_version is not null and sync_epoch is not null) or (transport='text' and provider in('zapi','waha','uazapi') and num_nonnulls(account_id,remote_template_id,template_version,sync_epoch)=0)),
  check((claim_token is null)=(claimed_until is null)),
  check(state not in('claimed','posting','uncertain') or claim_token is not null),
  -- Existing TTL=0 kinds expire exactly at their originating fact.
  constraint whatsapp_automation_jobs_expiry_check check(expires_at>=fact_at)
);
create table if not exists public.whatsapp_message_consent_events (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references public.units(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  purpose text not null check(purpose in('operational','promotional')),
  decision text not null check(decision in('opt_in','opt_out')),
  source_code text not null check(source_code ~ '^[a-z0-9_]{1,64}$'),
  evidence_reference text not null check(char_length(evidence_reference) between 1 and 512 and evidence_reference !~ '/preferencias/mensagens/[A-Za-z0-9_-]{43}'),
  actor_id uuid references auth.users(id) on delete set null,
  observed_at timestamptz not null,
  revision bigint not null default 1 check(revision>0),
  created_at timestamptz not null default now(),
  unique(unit_id,customer_id,purpose,revision)
);
create table if not exists public.whatsapp_message_preference_tokens (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references public.units(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  purpose text not null default 'promotional' check(purpose='promotional'),
  token_hash text not null unique check(token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check(expires_at>created_at and expires_at<=created_at+interval '90 days')
);
create table if not exists public.whatsapp_promotion_slots (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references public.units(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  job_id uuid not null unique references public.whatsapp_automation_jobs(id) on delete cascade,
  state text not null default 'reserved' check(state in('reserved','accepted','uncertain')),
  claim_token uuid not null,
  claimed_until timestamptz not null,
  accepted_at timestamptz,
  window_until timestamptz not null,
  created_at timestamptz not null default now(),
  check(window_until>created_at)
);
create table if not exists public.whatsapp_automation_receipt_events (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references public.units(id) on delete cascade,
  provider text not null check(provider in('official','datafy','zapi','waha','uazapi')),
  channel_id uuid not null,
  provider_message_id text not null check(char_length(provider_message_id) between 1 and 512 and provider_message_id !~ '[[:cntrl:]]'),
  status text not null check(status in('sent','delivered','read','failed')),
  provider_timestamp timestamptz not null,
  digest text not null check(digest ~ '^[a-f0-9]{64}$'),
  processing_state text not null default 'pending' check(processing_state in('pending','processed','ignored')),
  processed_at timestamptz,
  received_at timestamptz not null default now(),
  unique(unit_id,provider,channel_id,provider_message_id,digest)
);
create schema if not exists app_private;
create table if not exists app_private.whatsapp_template_maintenance_permits (
  id uuid primary key default gen_random_uuid(),
  transaction_id bigint not null,
  actor_id uuid not null,
  action text not null check(action in('INSERT','UPDATE','DELETE')),
  table_name text not null check(table_name in('reservation_message_templates','waitlist_message_templates','settings')),
  row_id uuid not null,
  unit_id uuid not null,
  event_key text not null,
  unique(transaction_id,actor_id,action,table_name,row_id)
);

create index if not exists whatsapp_template_accounts_org_idx on public.whatsapp_template_accounts(organization_id);
create index if not exists whatsapp_template_bindings_unit_idx on public.whatsapp_template_bindings(unit_id);
create index if not exists whatsapp_template_bindings_account_idx on public.whatsapp_template_bindings(account_id);
create index if not exists whatsapp_remote_templates_sync_idx on public.whatsapp_remote_templates(account_id,sync_required,last_synced_at);
create index if not exists whatsapp_template_jobs_due_idx on public.whatsapp_template_jobs(due_at,created_at) where state in('queued','claimed','posting','uncertain');
create index if not exists whatsapp_template_events_processing_idx on public.whatsapp_template_events(processing_state,received_at);
create index if not exists whatsapp_automation_jobs_due_idx on public.whatsapp_automation_jobs(due_at,created_at) where state in('queued','claimed','posting','uncertain');
create index if not exists whatsapp_automation_jobs_oldest_idx on public.whatsapp_automation_jobs(unit_id,created_at) where state in('queued','claimed','posting','uncertain','needs_review','paused');
create unique index if not exists whatsapp_automation_jobs_reservation_idx on public.whatsapp_automation_jobs(unit_id,kind,reservation_id) where reservation_id is not null;
create unique index if not exists whatsapp_automation_jobs_waitlist_idx on public.whatsapp_automation_jobs(unit_id,kind,waitlist_id) where waitlist_id is not null;
create unique index if not exists whatsapp_automation_jobs_voucher_idx on public.whatsapp_automation_jobs(unit_id,kind,voucher_id) where voucher_id is not null;
create unique index if not exists whatsapp_automation_jobs_receipt_idx on public.whatsapp_automation_jobs(unit_id,provider,channel_id,provider_message_id) where provider_message_id is not null;
create index if not exists whatsapp_message_consent_events_current_idx on public.whatsapp_message_consent_events(unit_id,customer_id,purpose,revision desc);
create index if not exists whatsapp_message_preference_tokens_customer_idx on public.whatsapp_message_preference_tokens(unit_id,customer_id);
create index if not exists whatsapp_promotion_slots_contact_idx on public.whatsapp_promotion_slots(unit_id,customer_id,window_until);
create index if not exists whatsapp_template_cost_authorizations_scope_idx on public.whatsapp_template_cost_authorizations(account_id,binding_id,binding_generation,category,valid_until);
create index if not exists whatsapp_automation_receipt_events_lookup_idx on public.whatsapp_automation_receipt_events(unit_id,provider,channel_id,provider_message_id,status,provider_timestamp);

-- Trigger functions run as the owner to check private parents. They expose no RPC.
create or replace function public.guard_whatsapp_template_scope()
returns trigger language plpgsql security definer set search_path='' as $$
declare
  v_org uuid; v_customer_org uuid; v_deleted timestamptz;
  v_binding public.whatsapp_template_bindings%rowtype;
  v_channel public.whatsapp_channels%rowtype;
  v_remote public.whatsapp_remote_templates%rowtype;
  v_job public.whatsapp_automation_jobs%rowtype;
  v_resource_unit uuid; v_resource_customer uuid; v_resource_invalid boolean:=false;
begin
  -- Existing intents are historical evidence: only INSERT checks mutable parents.
  -- State/fence reconciliation must survive a deleted/changed binding or customer.
  if tg_op='UPDATE' and tg_table_name='whatsapp_automation_jobs' then
    if (new.id,new.unit_id,new.organization_id,new.kind,new.reservation_id,new.waitlist_id,new.voucher_id,new.source_event_key,new.fact_at,new.expires_at,new.channel_id,new.provider,new.binding_id,new.binding_generation,new.transport,new.account_id,new.remote_template_id,new.template_version,new.notification_id) is distinct from (old.id,old.unit_id,old.organization_id,old.kind,old.reservation_id,old.waitlist_id,old.voucher_id,old.source_event_key,old.fact_at,old.expires_at,old.channel_id,old.provider,old.binding_id,old.binding_generation,old.transport,old.account_id,old.remote_template_id,old.template_version,old.notification_id) then raise exception 'automation_intent_immutable' using errcode='23514'; end if;
    if new.sync_epoch is distinct from old.sync_epoch then
      if old.posting_started_at is not null or new.sync_epoch<old.sync_epoch then raise exception 'automation_posted_epoch_immutable' using errcode='23514'; end if;
      -- The preparation RPC owns ordered locks; this trigger never locks an
      -- earlier parent while SQL UPDATE already owns the job row.
      perform 1 from public.whatsapp_remote_templates r join public.whatsapp_template_accounts a on a.id=r.account_id join public.whatsapp_template_bindings b on b.id=new.binding_id
        where r.id=new.remote_template_id and r.account_id=new.account_id and r.version=new.template_version and r.binding_generation=a.binding_generation
          and r.sync_epoch=new.sync_epoch and not r.sync_required and r.remote_status='APPROVED' and r.local_status='usable' and r.observed_hash=r.desired_hash
          and b.generation=new.binding_generation and (b.unit_id,b.channel_id,b.provider,b.account_id)=(new.unit_id,new.channel_id,new.provider,new.account_id);
      if not found then raise exception 'automation_epoch_snapshot_invalid' using errcode='23514'; end if;
    end if;
    if old.posting_started_at is not null and new.safe_log_body is distinct from old.safe_log_body then raise exception 'automation_render_immutable' using errcode='23514'; end if;
    if old.provider_message_id is not null and new.provider_message_id is distinct from old.provider_message_id then raise exception 'automation_provider_identity_immutable' using errcode='23514'; end if;
    if old.customer_id is not null and new.customer_id is null then
      select deleted_at into v_deleted from public.customers where id=old.customer_id for share;
      if found and v_deleted is null then raise exception 'customer_erasure_not_authorized' using errcode='23514'; end if;
      new.customer_erased_at:=now();
      if old.state not in('posting','uncertain','accepted','reconciled') then new.state:='blocked'; new.error_code:='customer_not_alive'; end if;
    elsif new.customer_id is distinct from old.customer_id or new.customer_erased_at is distinct from old.customer_erased_at then raise exception 'customer_erasure_immutable' using errcode='23514'; end if;
    return new;
  end if;
  if tg_op='UPDATE' and tg_table_name='whatsapp_template_jobs' then
    if (new.id,new.account_id,new.binding_id,new.binding_generation,new.operation,new.target_key,new.revision) is distinct from (old.id,old.account_id,old.binding_id,old.binding_generation,old.operation,old.target_key,old.revision) then raise exception 'template_job_identity_immutable' using errcode='23514'; end if;
    return new;
  end if;
  if tg_op='UPDATE' and tg_table_name='whatsapp_automation_receipt_events' then return new; end if;
  if tg_table_name='whatsapp_template_accounts' then
    if tg_op='UPDATE' and (new.id,new.organization_id,new.waba_id) is distinct from (old.id,old.organization_id,old.waba_id) then raise exception 'template_identity_immutable' using errcode='23514'; end if;
    if tg_op='UPDATE' and new.binding_generation<old.binding_generation then raise exception 'template_generation_regression' using errcode='23514'; end if;
    return new;
  end if;
  if tg_table_name in('whatsapp_message_consent_events','whatsapp_message_preference_tokens','whatsapp_promotion_slots','whatsapp_automation_jobs') then
    -- SQL serializes preference revisions, then all later locks follow customer first.
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
    select organization_id into v_org from public.units where id=new.unit_id;
    if new.account_id is not null then
      perform 1 from public.whatsapp_template_accounts where id=new.account_id and organization_id=v_org for share;
      if not found then raise exception 'template_tenant_mismatch' using errcode='23514'; end if;
    end if;
    select * into v_channel from public.whatsapp_channels where id=new.channel_id for share;
    if not found or v_channel.unit_id is distinct from new.unit_id or v_channel.provider is distinct from new.provider then raise exception 'template_channel_mismatch' using errcode='23514'; end if;
    if tg_op='UPDATE' then
      if (new.id,new.unit_id,new.channel_id) is distinct from (old.id,old.unit_id,old.channel_id) then raise exception 'template_binding_identity_immutable' using errcode='23514'; end if;
      if new.generation<old.generation or ((new.provider,new.account_id) is distinct from (old.provider,old.account_id) and new.generation<=old.generation) then raise exception 'template_generation_regression' using errcode='23514'; end if;
      if old.adopted_at is not null and new.adopted_at is distinct from old.adopted_at then raise exception 'template_adoption_immutable' using errcode='23514'; end if;
    end if;
    if (tg_op='INSERT' and (new.adopted_at is not null or new.dispatch_enabled or new.submission_authorized_at is not null)) or
       (tg_op='UPDATE' and ((old.adopted_at is null and new.adopted_at is not null) or (not old.dispatch_enabled and new.dispatch_enabled) or (new.submission_authorized_at is not null and (new.submission_authorized_at,new.submission_authorized_by) is distinct from (old.submission_authorized_at,old.submission_authorized_by)))) then
      if auth.role() is distinct from 'authenticated' or auth.uid() is null or not app_private.is_platform_admin(auth.uid()) then raise exception 'template_admin_required' using errcode='42501'; end if;
      if new.submission_authorized_at is not null then new.submission_authorized_by:=auth.uid(); new.submission_authorized_at:=now(); end if;
      if new.adopted_at is not null and (tg_op='INSERT' or old.adopted_at is null) then
        new.adopted_at:=now();
        insert into public.whatsapp_automation_adoptions(unit_id,adopted_at) values(new.unit_id,now()) on conflict(unit_id) do nothing;
      end if;
    end if;
  elsif tg_table_name='whatsapp_remote_templates' then
    if tg_op='UPDATE' and (new.id,new.account_id,new.logical_id,new.version,new.language,new.name,new.desired_hash,new.requested_category) is distinct from (old.id,old.account_id,old.logical_id,old.version,old.language,old.name,old.desired_hash,old.requested_category) then raise exception 'template_identity_immutable' using errcode='23514'; end if;
    if tg_op='UPDATE' and new.sync_epoch<old.sync_epoch then raise exception 'template_epoch_regression' using errcode='23514'; end if;
  elsif tg_table_name in('whatsapp_template_jobs','whatsapp_template_cost_authorizations') then
    perform 1 from public.whatsapp_template_accounts where id=new.account_id for share;
    select * into v_binding from public.whatsapp_template_bindings where id=new.binding_id for share;
    if not found or v_binding.account_id is distinct from new.account_id or (tg_op='INSERT' and v_binding.generation is distinct from new.binding_generation) then raise exception 'template_binding_mismatch' using errcode='23514'; end if;
    if tg_table_name='whatsapp_template_cost_authorizations' and tg_op='INSERT' then
      if auth.role() is distinct from 'authenticated' or auth.uid() is distinct from new.actor_id or not app_private.is_platform_admin(auth.uid()) then raise exception 'template_admin_required' using errcode='42501'; end if;
    end if;
  elsif tg_table_name='whatsapp_automation_jobs' then
    if new.organization_id is distinct from v_org then raise exception 'template_tenant_mismatch' using errcode='23514'; end if;
    if new.reservation_id is not null then select unit_id,customer_id into v_resource_unit,v_resource_customer from public.reservations where id=new.reservation_id;
    elsif new.waitlist_id is not null then
      -- Public waitlist entries may omit customer_id: resolve canonical phone
      -- inside the resource organization, preserving an existing compatible FK.
      select w.unit_id,c.id,(w.customer_id is not null and c.id is null) into v_resource_unit,v_resource_customer,v_resource_invalid from public.waitlist w
        join public.units u on u.id=w.unit_id
        left join public.customers c on c.organization_id=u.organization_id and c.phone=public.normalize_br_phone(w.customer_phone) and (w.customer_id is null or c.id=w.customer_id)
        where w.id=new.waitlist_id;
    elsif new.voucher_id is not null then select unit_id,customer_id into v_resource_unit,v_resource_customer from public.vouchers where id=new.voucher_id;
    end if;
    if v_resource_invalid or v_resource_unit is distinct from new.unit_id or v_resource_customer is distinct from new.customer_id then raise exception 'template_resource_mismatch' using errcode='23514'; end if;
    if tg_op='INSERT' and (new.customer_erased_at is not null or (new.customer_id is null and new.waitlist_id is null)) then raise exception 'template_resource_mismatch' using errcode='23514'; end if;
    if new.account_id is not null then perform 1 from public.whatsapp_template_accounts where id=new.account_id and organization_id=v_org for share; if not found then raise exception 'template_tenant_mismatch' using errcode='23514'; end if; end if;
    select * into v_binding from public.whatsapp_template_bindings where id=new.binding_id for share;
    if not found or (v_binding.unit_id,v_binding.channel_id,v_binding.provider,v_binding.account_id) is distinct from (new.unit_id,new.channel_id,new.provider,new.account_id) or (tg_op='INSERT' and v_binding.generation is distinct from new.binding_generation) then raise exception 'template_binding_mismatch' using errcode='23514'; end if;
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
    if not found or v_job.kind not in('waitlist_feedback','voucher_issued') or (v_job.unit_id,v_job.customer_id) is distinct from (new.unit_id,new.customer_id) then raise exception 'promotion_slot_mismatch' using errcode='23514'; end if;
    if tg_op='UPDATE' and (new.id,new.unit_id,new.customer_id,new.job_id,new.created_at) is distinct from (old.id,old.unit_id,old.customer_id,old.job_id,old.created_at) then raise exception 'promotion_slot_identity_immutable' using errcode='23514'; end if;
  elsif tg_table_name='whatsapp_automation_receipt_events' then
    select * into v_channel from public.whatsapp_channels where id=new.channel_id for share;
    if not found or (v_channel.unit_id,v_channel.provider) is distinct from (new.unit_id,new.provider) then raise exception 'template_channel_mismatch' using errcode='23514'; end if;
  end if;
  return new;
end $$;
revoke all on function public.guard_whatsapp_template_scope() from public,anon,authenticated,service_role;

create or replace function public.guard_whatsapp_template_evidence()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_table_name='whatsapp_automation_adoptions' then
    if tg_op='INSERT' and auth.role()='authenticated' and auth.uid() is not null and app_private.is_platform_admin(auth.uid()) then new.adopted_at:=now(); return new; end if;
    if tg_op='DELETE' and not exists(select from public.units where id=old.unit_id) then return old; end if;
    raise exception 'automation_adoption_immutable' using errcode='23514';
  end if;
  if tg_op='DELETE' then
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

do $$ declare t text; begin
  foreach t in array array['whatsapp_template_accounts','whatsapp_template_bindings','whatsapp_remote_templates','whatsapp_template_jobs','whatsapp_template_cost_authorizations','whatsapp_automation_jobs','whatsapp_message_consent_events','whatsapp_message_preference_tokens','whatsapp_promotion_slots','whatsapp_automation_receipt_events'] loop
    execute format('drop trigger if exists whatsapp_template_scope on public.%I',t);
    execute format('create trigger whatsapp_template_scope before insert or update on public.%I for each row execute function public.guard_whatsapp_template_scope()',t);
  end loop;
  foreach t in array array['whatsapp_message_consent_events','whatsapp_message_preference_tokens','whatsapp_promotion_slots','whatsapp_template_cost_authorizations'] loop
    execute format('drop trigger if exists whatsapp_template_evidence on public.%I',t);
    execute format('create trigger whatsapp_template_evidence before update or delete on public.%I for each row execute function public.guard_whatsapp_template_evidence()',t);
  end loop;
  foreach t in array array['whatsapp_template_events','whatsapp_automation_receipt_events'] loop
    execute format('drop trigger if exists whatsapp_template_evidence on public.%I',t);
    execute format('create trigger whatsapp_template_evidence before update on public.%I for each row execute function public.guard_whatsapp_template_evidence()',t);
  end loop;
end $$;
drop trigger if exists whatsapp_template_evidence on public.whatsapp_automation_adoptions;
create trigger whatsapp_template_evidence before insert or update or delete on public.whatsapp_automation_adoptions for each row execute function public.guard_whatsapp_template_evidence();

create or replace function public.guard_whatsapp_legacy_template_write()
returns trigger language plpgsql security definer set search_path='' as $$
declare
  v_old jsonb; v_new jsonb; v_scope jsonb; v_unit uuid; v_key text;
  v_actor uuid:=auth.uid(); v_admin boolean; v_official boolean;
  v_need_official boolean:=false; v_changed boolean; v_permit uuid; v_row uuid;
begin
  if tg_op<>'INSERT' then v_old:=to_jsonb(old); end if;
  if tg_op<>'DELETE' then v_new:=to_jsonb(new); end if;
  if tg_op='DELETE' and old.unit_id is not null and not exists(select from public.units where id=old.unit_id) then return old; end if;
  if tg_table_name='settings' and coalesce(v_old->>'key','')<>'giftback_message_template' and coalesce(v_new->>'key','')<>'giftback_message_template' then
    if tg_op='DELETE' then return old; end if; return new;
  end if;
  if tg_op='UPDATE' then
    if tg_table_name='settings' then
      v_changed:=(v_old->'id',v_old->'unit_id',v_old->'key',v_old->'value') is distinct from (v_new->'id',v_new->'unit_id',v_new->'key',v_new->'value');
    else
      v_changed:=(v_old->'id',v_old->'unit_id',v_old->'event',v_old->'body',v_old->'customized') is distinct from (v_new->'id',v_new->'unit_id',v_new->'event',v_new->'body',v_new->'customized');
    end if;
    if not v_changed then return new; end if;
  end if;
  -- BOTH scopes are checked: moving a protected row/key cannot evade the guard.
  if auth.role() is distinct from 'authenticated' or v_actor is null then raise exception 'template_configuration_role_required' using errcode='42501'; end if;
  v_admin:=app_private.is_platform_admin(v_actor);
  foreach v_scope in array array[v_old,v_new] loop
    if v_scope is null then continue; end if;
    v_unit:=(v_scope->>'unit_id')::uuid;
    v_key:=case when tg_table_name='settings' then v_scope->>'key' else v_scope->>'event' end;
    if tg_table_name='settings' and v_key<>'giftback_message_template' then continue; end if;
    if not v_admin and not exists(select from public.unit_members where user_id=v_actor and unit_id=v_unit and role in('owner','gerente')) then raise exception 'template_configuration_role_required' using errcode='42501'; end if;
    if tg_table_name='waitlist_message_templates' and v_key='table_ready' then continue; end if;
    select c.provider in('official','datafy') into v_official from public.whatsapp_channels c where c.unit_id=v_unit and (c.is_active=true or (c.is_active is null and c.status='connected' and not exists(select from public.whatsapp_channels a where a.unit_id=v_unit and a.is_active=true))) order by c.is_active desc nulls last,c.created_at asc,c.id limit 1;
    v_need_official:=v_need_official or coalesce(v_official,false);
  end loop;
  if v_need_official then
    if not v_admin then raise exception 'official_template_immutable' using errcode='42501'; end if;
    v_scope:=coalesce(v_old,v_new); v_row:=(v_scope->>'id')::uuid;
    delete from app_private.whatsapp_template_maintenance_permits
    where transaction_id=txid_current() and actor_id=v_actor and action=tg_op and table_name=tg_table_name and row_id=v_row
      and unit_id=(v_scope->>'unit_id')::uuid and event_key=case when tg_table_name='settings' then v_scope->>'key' else v_scope->>'event' end
    returning id into v_permit;
    if v_permit is null then
      raise exception 'official_template_immutable' using errcode='42501';
    end if;
    if tg_op='UPDATE' and ((v_old->>'id',v_old->>'unit_id',coalesce(v_old->>'event',v_old->>'key')) is distinct from (v_new->>'id',v_new->>'unit_id',coalesce(v_new->>'event',v_new->>'key'))) then raise exception 'official_template_immutable' using errcode='42501'; end if;
  end if;
  if tg_op='DELETE' then return old; end if; return new;
end $$;
revoke all on function public.guard_whatsapp_legacy_template_write() from public,anon,authenticated,service_role;

create or replace function public.maintain_whatsapp_legacy_template(
  p_table_name text,p_action text,p_row_id uuid,p_unit_id uuid,p_event text,p_body text,p_customized boolean,p_reason text
) returns uuid language plpgsql security definer set search_path='' as $$
declare v_actor uuid:=auth.uid(); v_id uuid; v_unit uuid; v_key text; v_old jsonb; v_new jsonb; v_count integer;
begin
  if auth.role() is distinct from 'authenticated' or v_actor is null or not app_private.is_platform_admin(v_actor) then raise exception 'template_admin_required' using errcode='42501'; end if;
  if p_table_name is null or p_action is null or p_table_name not in('reservation_message_templates','waitlist_message_templates','settings') or p_action not in('INSERT','UPDATE','DELETE') or p_reason is null or p_reason !~ '^[[:alnum:] _.,:-]{3,200}$' then raise exception 'template_maintenance_invalid' using errcode='22023'; end if;
  if p_action<>'DELETE' and (p_body is null or char_length(p_body)>4096 or p_customized is null) then raise exception 'template_maintenance_invalid' using errcode='22023'; end if;
  if p_action='INSERT' then
    v_id:=coalesce(p_row_id,gen_random_uuid()); v_unit:=p_unit_id; v_key:=p_event;
    perform 1 from public.units where id=v_unit for share;
    if not found then raise exception 'template_maintenance_invalid' using errcode='22023'; end if;
  else
    if p_row_id is null then raise exception 'template_maintenance_invalid' using errcode='22023'; end if;
    execute format('select to_jsonb(t) from public.%I t where id=$1 for update',p_table_name) into v_old using p_row_id;
    if v_old is null then raise exception 'template_maintenance_invalid' using errcode='22023'; end if;
    v_id:=p_row_id; v_unit:=(v_old->>'unit_id')::uuid; v_key:=coalesce(v_old->>'event',v_old->>'key');
  end if;
  if v_key is null or (p_table_name='settings' and v_key<>'giftback_message_template') or (p_table_name='reservation_message_templates' and v_key not in('reminder_d1','survey_d1')) or (p_table_name='waitlist_message_templates' and v_key not in('entered','feedback','table_ready')) then raise exception 'template_maintenance_invalid' using errcode='22023'; end if;
  insert into app_private.whatsapp_template_maintenance_permits(transaction_id,actor_id,action,table_name,row_id,unit_id,event_key) values(txid_current(),v_actor,p_action,p_table_name,v_id,v_unit,v_key);
  if p_action='DELETE' then
    execute format('delete from public.%I where id=$1',p_table_name) using v_id;
  elsif p_table_name='settings' then
    if p_action='INSERT' then insert into public.settings(id,unit_id,key,value) values(v_id,v_unit,v_key,to_jsonb(p_body));
    else update public.settings set value=to_jsonb(p_body) where id=v_id; end if;
  elsif p_action='INSERT' then
    execute format('insert into public.%I(id,unit_id,event,body,customized) values($1,$2,$3,$4,$5)',p_table_name) using v_id,v_unit,v_key,p_body,p_customized;
  else
    execute format('update public.%I set body=$2,customized=$3 where id=$1',p_table_name) using v_id,p_body,p_customized;
  end if;
  get diagnostics v_count=row_count;
  if v_count<>1 then raise exception 'template_maintenance_invalid' using errcode='22023'; end if;
  -- Nonofficial/no-op maintenance may not need the permit; it must never escape the RPC.
  delete from app_private.whatsapp_template_maintenance_permits where transaction_id=txid_current() and actor_id=v_actor and action=p_action and table_name=p_table_name and row_id=v_id;
  if p_action<>'DELETE' then execute format('select to_jsonb(t) from public.%I t where id=$1',p_table_name) into v_new using v_id; end if;
  insert into public.audit_log(table_name,record_id,action,old_values,new_values,actor_id,unit_id)
  values(p_table_name,v_id::text,p_action,
    case when v_old is null then null else jsonb_build_object('unit_id',v_unit,'event_key',v_key,'body_digest',md5(coalesce(v_old->>'body',v_old->>'value',''))) end,
    jsonb_build_object('unit_id',v_unit,'event_key',v_key,'reason',p_reason,'body_digest',case when v_new is null then null else md5(coalesce(v_new->>'body',v_new->>'value','')) end),v_actor,v_unit);
  return v_id;
end $$;
revoke all on function public.maintain_whatsapp_legacy_template(text,text,uuid,uuid,text,text,boolean,text) from public,anon,authenticated,service_role;
grant execute on function public.maintain_whatsapp_legacy_template(text,text,uuid,uuid,text,text,boolean,text) to authenticated;

drop trigger if exists whatsapp_legacy_template_write on public.reservation_message_templates;
create trigger whatsapp_legacy_template_write before insert or update or delete on public.reservation_message_templates for each row execute function public.guard_whatsapp_legacy_template_write();
drop trigger if exists whatsapp_legacy_template_write on public.waitlist_message_templates;
create trigger whatsapp_legacy_template_write before insert or update or delete on public.waitlist_message_templates for each row execute function public.guard_whatsapp_legacy_template_write();
drop trigger if exists whatsapp_legacy_template_write on public.settings;
create trigger whatsapp_legacy_template_write before insert or update or delete on public.settings for each row execute function public.guard_whatsapp_legacy_template_write();

-- Existing member policies remain; add the platform-admin counterpart for tables
-- whose original template migrations predate this requirement.
drop policy if exists whatsapp_template_platform_admin on public.reservation_message_templates;
create policy whatsapp_template_platform_admin on public.reservation_message_templates for all to authenticated using(app_private.is_platform_admin(auth.uid())) with check(app_private.is_platform_admin(auth.uid()));
drop policy if exists whatsapp_template_platform_admin on public.waitlist_message_templates;
create policy whatsapp_template_platform_admin on public.waitlist_message_templates for all to authenticated using(app_private.is_platform_admin(auth.uid())) with check(app_private.is_platform_admin(auth.uid()));

do $$ declare t text; begin
  foreach t in array array['whatsapp_template_accounts','whatsapp_template_bindings','whatsapp_remote_templates','whatsapp_template_jobs','whatsapp_template_events','whatsapp_automation_jobs','whatsapp_message_consent_events','whatsapp_message_preference_tokens','whatsapp_promotion_slots','whatsapp_template_cost_authorizations','whatsapp_automation_receipt_events'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('alter table public.%I force row level security',t);
    execute format('revoke all on table public.%I from public,anon,authenticated,service_role',t);
    execute format('grant select,insert,update,delete on table public.%I to service_role',t);
  end loop;
end $$;
alter table public.whatsapp_automation_adoptions enable row level security;
alter table public.whatsapp_automation_adoptions force row level security;
revoke all on table public.whatsapp_automation_adoptions from public,anon,authenticated,service_role;
grant select on table public.whatsapp_automation_adoptions to service_role;
alter table app_private.whatsapp_template_maintenance_permits enable row level security;
alter table app_private.whatsapp_template_maintenance_permits force row level security;
revoke all on table app_private.whatsapp_template_maintenance_permits from public,anon,authenticated,service_role;
-- All new IDs use UUID defaults; this migration creates no sequence.
notify pgrst,'reload schema';
commit;
