-- Technical preparation only: flags and every binding authorization stay OFF.
begin;
alter table public.whatsapp_channels add column if not exists template_credential_revision bigint not null default 0 check(template_credential_revision>=0);
alter table public.whatsapp_template_bindings add column if not exists channel_credential_revision bigint not null default 0 check(channel_credential_revision>=0);
alter table public.whatsapp_template_accounts add column if not exists last_sync_requested_at timestamptz;
alter table public.whatsapp_template_accounts add column if not exists last_sync_published_at timestamptz;
alter table public.whatsapp_template_accounts add column if not exists sync_capture_id uuid;
alter table public.whatsapp_template_accounts add column if not exists sync_binding_id uuid;
alter table public.whatsapp_template_accounts add column if not exists sync_binding_generation bigint;
alter table public.whatsapp_template_accounts add column if not exists sync_credential_revision bigint;
alter table public.whatsapp_remote_templates add column if not exists submission_attempted_at timestamptz;
alter table public.whatsapp_template_jobs add column if not exists post_capture_id uuid;

create table if not exists app_private.whatsapp_template_revision_permits(
  transaction_id bigint not null, channel_id uuid not null, claim_id uuid not null, revision bigint not null,
  primary key(transaction_id,channel_id)
);
alter table app_private.whatsapp_template_revision_permits enable row level security;
alter table app_private.whatsapp_template_revision_permits force row level security;
revoke all on app_private.whatsapp_template_revision_permits from public,anon,authenticated,service_role;

create or replace function public.guard_whatsapp_template_credential_revision()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_permitted boolean:=false;
begin
  if tg_op='INSERT' then
    if new.template_credential_revision<>0 then raise exception 'template_revision_invalid' using errcode='23514'; end if;
    return new;
  end if;
  -- No parent/account/binding/job locks or writes while owning a channel row.
  if new.template_credential_revision is distinct from old.template_credential_revision then
    delete from app_private.whatsapp_template_revision_permits where transaction_id=txid_current() and channel_id=old.id
      and claim_id=old.provisioning_claim_id and revision=old.template_credential_revision and new.template_credential_revision=old.template_credential_revision+1 returning true into v_permitted;
    if not coalesce(v_permitted,false) then raise exception 'template_revision_invalid' using errcode='23514'; end if;
  end if;
  if (new.provider,new.credentials,new.webhook_secret,new.instance_token_secret_id) is distinct from
    (old.provider,old.credentials,old.webhook_secret,old.instance_token_secret_id) then
    new.template_credential_revision:=old.template_credential_revision+1;
  end if;
  return new;
end $$;
revoke all on function public.guard_whatsapp_template_credential_revision() from public,anon,authenticated,service_role;
drop trigger if exists whatsapp_template_credential_revision on public.whatsapp_channels;
create trigger whatsapp_template_credential_revision before insert or update on public.whatsapp_channels for each row execute function public.guard_whatsapp_template_credential_revision();

create or replace function public.guard_whatsapp_template_submission_history()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if old.submission_attempted_at is not null and new.submission_attempted_at is distinct from old.submission_attempted_at then
    raise exception 'template_submission_history_immutable' using errcode='23514';
  end if;
  return new;
end $$;
revoke all on function public.guard_whatsapp_template_submission_history() from public,anon,authenticated,service_role;
drop trigger if exists whatsapp_template_submission_history on public.whatsapp_remote_templates;
create trigger whatsapp_template_submission_history before update on public.whatsapp_remote_templates for each row execute function public.guard_whatsapp_template_submission_history();

create or replace function public.reconcile_whatsapp_template_credentials(p_channel_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare b public.whatsapp_template_bindings%rowtype; c public.whatsapp_channels%rowtype; v_account uuid;
begin
  select * into b from public.whatsapp_template_bindings where channel_id=p_channel_id;
  if not found then return false; end if;
  v_account:=b.account_id;
  if v_account is not null then perform 1 from public.whatsapp_template_accounts where id=v_account for update; end if;
  select * into b from public.whatsapp_template_bindings where channel_id=p_channel_id for update;
  if not found or b.account_id is distinct from v_account then return false; end if;
  select * into c from public.whatsapp_channels where id=p_channel_id for share;
  if not found or b.channel_credential_revision=c.template_credential_revision then return false; end if;
  -- Pins on historical jobs and sticky adoption are deliberately retained.
  update public.whatsapp_template_bindings set generation=generation+1,channel_credential_revision=c.template_credential_revision,
    verified_at=null,dispatch_enabled=false,submission_authorized_at=null,submission_authorized_by=null where id=b.id;
  if v_account is not null then
    update public.whatsapp_template_accounts set binding_generation=binding_generation+1,last_sync_requested_at=null,last_sync_published_at=null where id=v_account;
    update public.whatsapp_remote_templates set sync_epoch=sync_epoch+1,sync_required=true,local_status='awaiting_connection' where account_id=v_account;
  end if;
  update public.whatsapp_template_jobs set state='needs_review',error_code='binding_changed' where binding_id=b.id and posting_started_at is null and state in('queued','claimed','paused');
  update public.whatsapp_automation_jobs set state='needs_review',error_code='binding_changed' where binding_id=b.id and posting_started_at is null and state in('queued','blocked','claimed','retry_wait','paused');
  return true;
end $$;
revoke all on function public.reconcile_whatsapp_template_credentials(uuid) from public,anon,authenticated,service_role;
grant execute on function public.reconcile_whatsapp_template_credentials(uuid) to service_role;

create or replace function public.bind_whatsapp_template_account(p_channel_id uuid,p_unit_id uuid,p_provider text,p_credential_revision bigint,p_phone_number_id text,p_waba_id text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.whatsapp_channels%rowtype; b public.whatsapp_template_bindings%rowtype; a public.whatsapp_template_accounts%rowtype; v_org uuid;
begin
  if p_provider<>'datafy' or p_waba_id is null or p_waba_id !~ '^[0-9]{1,64}$' then raise exception 'template_binding_refused' using errcode='42501'; end if;
  select u.organization_id into v_org from public.whatsapp_channels ch join public.units u on u.id=ch.unit_id where ch.id=p_channel_id and ch.unit_id=p_unit_id;
  if not found then raise exception 'template_binding_refused' using errcode='42501'; end if;
  insert into public.whatsapp_template_accounts(organization_id,waba_id,verified_at) values(v_org,p_waba_id,clock_timestamp()) on conflict(waba_id) do nothing;
  select * into a from public.whatsapp_template_accounts where waba_id=p_waba_id for update;
  if a.organization_id is distinct from v_org then raise exception 'template_binding_refused' using errcode='42501'; end if;
  select * into b from public.whatsapp_template_bindings where channel_id=p_channel_id for update;
  if found and b.account_id is distinct from a.id then raise exception 'template_binding_refused' using errcode='42501'; end if;
  select * into c from public.whatsapp_channels where id=p_channel_id for share;
  if c.id is null or (c.unit_id,c.provider,c.template_credential_revision) is distinct from (p_unit_id,p_provider,p_credential_revision)
    or c.credentials->>'phone_number_id' is distinct from p_phone_number_id or p_phone_number_id is null
    or c.status<>'connected' or not exists(select from public.units where id=c.unit_id and organization_id=v_org) then
    raise exception 'template_binding_refused' using errcode='42501';
  end if;
  if b.id is not null and b.channel_credential_revision<>c.template_credential_revision then
    -- Caller must first reconcile in a separate ordered transaction.
    raise exception 'template_binding_changed' using errcode='40001';
  end if;
  insert into public.whatsapp_template_bindings(unit_id,channel_id,account_id,provider,verified_at,channel_credential_revision)
    values(c.unit_id,c.id,a.id,c.provider,clock_timestamp(),c.template_credential_revision)
    on conflict(channel_id) do update set verified_at=excluded.verified_at
      where whatsapp_template_bindings.account_id=excluded.account_id and whatsapp_template_bindings.channel_credential_revision=excluded.channel_credential_revision
    returning * into b;
  if not found then raise exception 'template_binding_refused' using errcode='42501'; end if;
  update public.whatsapp_template_accounts set verified_at=clock_timestamp() where id=a.id;
  return jsonb_build_object('accountId',a.id,'generation',b.generation);
end $$;
revoke all on function public.bind_whatsapp_template_account(uuid,uuid,text,bigint,text,text) from public,anon,authenticated,service_role;
grant execute on function public.bind_whatsapp_template_account(uuid,uuid,text,bigint,text,text) to service_role;
create or replace function public.prepare_whatsapp_automation_post(p_job_id uuid,p_fence uuid,p_generation bigint,p_consent_revision bigint,p_sync_epoch bigint)
returns boolean language plpgsql security definer set search_path='' as $$
declare
  j public.whatsapp_automation_jobs%rowtype; b public.whatsapp_template_bindings%rowtype;
  a public.whatsapp_template_accounts%rowtype; t public.whatsapp_remote_templates%rowtype;
  c public.customers%rowtype; ch public.whatsapp_channels%rowtype;
  v_now timestamptz; v_error text; v_current_customer uuid; v_resource_unit uuid; v_invalid boolean;
  v_revision bigint; v_decision text; v_selected uuid; v_cost uuid; v_cost_from timestamptz; v_cost_until timestamptz; v_days integer; s public.whatsapp_promotion_slots%rowtype;
begin
  select * into j from public.whatsapp_automation_jobs where id=p_job_id;
  if not found then return false; end if;
  -- Unlocked identity read followed by the agreed parent order. No earlier lock
  -- is acquired after owning the job; claim/requeue remain job-only.
  if j.customer_id is not null then select * into c from public.customers where id=j.customer_id for update; end if;
  if j.account_id is not null then select * into a from public.whatsapp_template_accounts where id=j.account_id for share; end if;
  select * into b from public.whatsapp_template_bindings where id=j.binding_id for share;
  select * into ch from public.whatsapp_channels where id=j.channel_id for share;
  if j.remote_template_id is not null then select * into t from public.whatsapp_remote_templates where id=j.remote_template_id for update; end if;
  select revision,decision into v_revision,v_decision from public.whatsapp_message_consent_events where unit_id=j.unit_id and customer_id=j.customer_id and purpose=case when j.kind in('waitlist_feedback','voucher_issued') then 'promotional' else 'operational' end order by revision desc limit 1 for share;
  if j.kind in('waitlist_feedback','voucher_issued') then
    select * into s from public.whatsapp_promotion_slots where unit_id=j.unit_id and customer_id=j.customer_id for update;
    if j.transport='template' then
      select ca.id,ca.valid_from,ca.valid_until into v_cost,v_cost_from,v_cost_until from public.whatsapp_template_cost_authorizations ca where ca.account_id=j.account_id and ca.binding_id=j.binding_id and ca.binding_generation=j.binding_generation and ca.category='MARKETING' and ca.valid_from<=clock_timestamp() and ca.valid_until>clock_timestamp() and exists(select from public.platform_admins where user_id=ca.actor_id) order by ca.valid_until desc,ca.id limit 1 for share;
    end if;
  end if;
  select * into j from public.whatsapp_automation_jobs where id=p_job_id for update;
  v_now:=clock_timestamp();
  if j.claim_token is distinct from p_fence or j.state<>'claimed' or j.claimed_until<=v_now or j.posting_started_at is not null then return false; end if;
  if j.reservation_id is not null then select unit_id,customer_id into v_resource_unit,v_current_customer from public.reservations where id=j.reservation_id;
  elsif j.voucher_id is not null then select unit_id,customer_id into v_resource_unit,v_current_customer from public.vouchers where id=j.voucher_id;
  else
    select w.unit_id,cu.id,(w.customer_id is not null and cu.id is null) into v_resource_unit,v_current_customer,v_invalid from public.waitlist w join public.units u on u.id=w.unit_id left join public.customers cu on cu.organization_id=u.organization_id and cu.phone=public.normalize_br_phone(w.customer_phone) and (w.customer_id is null or cu.id=w.customer_id) where w.id=j.waitlist_id;
  end if;
  select id into v_selected from public.whatsapp_channels x where x.unit_id=j.unit_id and (x.is_active=true or (x.is_active is null and x.status='connected' and not exists(select from public.whatsapp_channels active where active.unit_id=j.unit_id and active.is_active=true))) order by x.is_active desc nulls last,x.created_at asc,x.id limit 1;
  if v_resource_unit is distinct from j.unit_id or v_current_customer is distinct from j.customer_id or coalesce(v_invalid,false) then v_error:='recipient_changed';
  elsif j.customer_erased_at is not null or (j.customer_id is not null and (c.id is null or c.deleted_at is not null or c.organization_id is distinct from j.organization_id)) then v_error:='customer_not_alive';
  elsif c.do_not_contact then v_error:='do_not_contact';
  elsif b.id is null or (b.unit_id,b.channel_id,b.provider,b.account_id,b.generation) is distinct from (j.unit_id,j.channel_id,j.provider,j.account_id,j.binding_generation) or b.channel_credential_revision is distinct from ch.template_credential_revision or p_generation is distinct from j.binding_generation or v_selected is distinct from j.channel_id then v_error:='binding_changed';
  elsif not b.dispatch_enabled or b.adopted_at is null or not exists(select from public.whatsapp_automation_adoptions where unit_id=j.unit_id) or not exists(select from public.platform_flags where key='whatsapp_automation_dispatch' and value='true'::jsonb) then v_error:='dispatch_paused';
  elsif ch.id is null or ch.unit_id<>j.unit_id or ch.provider<>j.provider or ch.is_active=false or ch.status<>'connected' or ch.last_health_check_at is null or ch.last_health_check_at<v_now-interval '5 minutes' then v_error:='channel_unavailable';
  elsif v_now>j.expires_at then v_error:='expired';
  elsif j.kind in('waitlist_feedback','voucher_issued') and (j.customer_id is null or v_decision is distinct from 'opt_in' or v_revision is null or p_consent_revision is distinct from v_revision) then v_error:='consent_changed';
  elsif j.kind in('waitlist_feedback','voucher_issued') and j.transport='template' and (v_cost is null or v_cost_from>v_now or v_cost_until<=v_now or t.requested_category is distinct from 'MARKETING') then v_error:='cost_not_authorized';
  elsif j.kind in('waitlist_feedback','voucher_issued') and s.id is not null and
    ((s.state in('accepted','uncertain') and s.window_until>v_now) or
     (s.state='reserved' and exists(select from public.whatsapp_automation_jobs old_job where old_job.id=s.job_id and (old_job.posting_started_at is not null or old_job.state='uncertain'))) or
     (s.state='reserved' and s.window_until>v_now and not exists(select from public.whatsapp_automation_jobs old_job where old_job.id=s.job_id)) or
     (s.state='reserved' and s.job_id<>j.id and s.claimed_until>v_now and exists(select from public.whatsapp_automation_jobs old_job where old_job.id=s.job_id))) then v_error:='promotion_frequency';
  elsif v_decision='opt_out' or p_consent_revision is distinct from v_revision then v_error:='consent_changed';
  elsif j.safe_log_body is null then v_error:='render_missing';
  elsif j.transport='template' and (a.id is null or a.organization_id<>j.organization_id or a.verified_at is null or b.verified_at is null or t.id is null or t.account_id<>j.account_id or t.version<>j.template_version or t.binding_generation<>a.binding_generation or t.sync_required or t.local_status<>'usable' or t.remote_status<>'APPROVED' or t.language<>'pt_BR' or t.remote_id is null or t.observed_hash is distinct from t.desired_hash or t.effective_category is distinct from t.requested_category or (t.requested_category='MARKETING' and t.quality='RED') or t.last_synced_at is null or t.last_synced_at<v_now-interval '60 seconds' or p_sync_epoch is distinct from t.sync_epoch) then v_error:='template_unavailable';
  elsif j.transport='text' and p_sync_epoch is not null then v_error:='template_unavailable';
  end if;
  if v_error is not null then
    update public.whatsapp_automation_jobs set state=case when v_error in('binding_changed','recipient_changed') then 'needs_review' when v_error='dispatch_paused' then 'paused' when v_error='expired' then 'expired' else 'blocked' end,error_code=v_error where id=j.id and claim_token=p_fence;
    return false;
  end if;
  if j.kind in('waitlist_feedback','voucher_issued') then
    -- Customer mutex plus slot locks serialize every promotion for this contact.
    -- A protected reserved row never relies on an expired lease for reclamation.
    if s.id is not null then
      insert into app_private.whatsapp_promotion_slot_release_permits values(txid_current(),s.id);
      delete from public.whatsapp_promotion_slots where id=s.id;
    end if;
    select window_days into v_days from app_private.whatsapp_promotion_policy where singleton;
    if v_days is null then raise exception 'promotion_policy_unavailable' using errcode='P0A16'; end if;
    insert into public.whatsapp_promotion_slots(unit_id,customer_id,job_id,claim_token,claimed_until,window_until,window_days)
      values(j.unit_id,j.customer_id,j.id,p_fence,v_now+interval '90 seconds',v_now+make_interval(days=>v_days),v_days);
  end if;
  update public.whatsapp_automation_jobs set state='posting',posting_started_at=v_now,claimed_until=v_now+interval '90 seconds',attempts=attempts+1,sync_epoch=case when transport='template' then t.sync_epoch else null end,consent_revision=v_revision,cost_authorization_id=v_cost,error_code=null where id=j.id and claim_token=p_fence and state='claimed';
  return found;
end $$;
revoke all on function public.prepare_whatsapp_automation_post(uuid,uuid,bigint,bigint,bigint) from public,anon,authenticated,service_role;
grant execute on function public.prepare_whatsapp_automation_post(uuid,uuid,bigint,bigint,bigint) to service_role;
create or replace function public.store_whatsapp_channel_instance_token(
  p_channel_id uuid,
  p_claim_id uuid,
  p_token text,
  p_actor_id uuid default null,
  p_request_id text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_channel record;
  v_secret_id uuid;
  v_secret_name text;
  v_org_id uuid;
begin
  if p_token is null or length(btrim(p_token)) < 8 or length(p_token) > 4096 then
    raise exception 'invalid_channel_token' using errcode = '22023';
  end if;
  if p_request_id is not null and
     (length(p_request_id) not between 1 and 128 or p_request_id !~ '^[A-Za-z0-9._:-]+$') then
    raise exception 'invalid_request_id' using errcode = '22023';
  end if;

  select c.id, c.unit_id, c.provider, c.instance_token_secret_id,
         c.provisioning_claim_id
  into v_channel
  from public.whatsapp_channels c
  where c.id = p_channel_id
  for update;

  if not found then
    raise exception 'channel_not_found' using errcode = 'P0002';
  end if;
  if v_channel.provider <> 'uazapi' then
    raise exception 'channel_provider_not_uazapi' using errcode = '22023';
  end if;
  if p_claim_id is null or v_channel.provisioning_claim_id is distinct from p_claim_id then
    raise exception 'stale_provisioning_claim' using errcode = '40001';
  end if;

  select u.organization_id into v_org_id
  from public.units u where u.id = v_channel.unit_id;
  if v_org_id is null then
    raise exception 'channel_unit_not_found' using errcode = 'check_violation';
  end if;

  v_secret_name := 'whatsapp-channel-' || p_channel_id::text || '-uazapi-token';
  v_secret_id := v_channel.instance_token_secret_id;

  if v_secret_id is null then
    select s.id into v_secret_id
    from vault.secrets s
    where s.name = v_secret_name
    limit 1;
  end if;

  if v_secret_id is not null and exists (
    select 1 from vault.secrets s where s.id = v_secret_id
  ) then
    -- Advance before replacing an existing secret, even with the same Vault pointer.
    insert into app_private.whatsapp_template_revision_permits(transaction_id,channel_id,claim_id,revision)
      select txid_current(),id,provisioning_claim_id,template_credential_revision from public.whatsapp_channels where id=p_channel_id;
    update public.whatsapp_channels set template_credential_revision=template_credential_revision+1 where id=p_channel_id;
    perform vault.update_secret(
      v_secret_id,
      p_token,
      v_secret_name,
      'UazAPI instance token for internal channel UUID'
    );
  else
    select vault.create_secret(
      p_token,
      v_secret_name,
      'UazAPI instance token for internal channel UUID'
    ) into v_secret_id;
  end if;

  update public.whatsapp_channels c
  set instance_token_secret_id = v_secret_id
  where c.id = p_channel_id;

  insert into public.whatsapp_channel_lifecycle_events (
    organization_id, unit_id, channel_ref, event_type, provider,
    from_status, to_status, request_id, actor_id
  ) values (
    v_org_id, v_channel.unit_id, p_channel_id, 'token_stored', 'uazapi',
    null, null, p_request_id, p_actor_id
  );

  return v_secret_id;
end;
$$;
revoke all on function public.store_whatsapp_channel_instance_token(uuid,uuid,text,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.store_whatsapp_channel_instance_token(uuid,uuid,text,uuid,text) to service_role;

create or replace function public.request_whatsapp_template_sync(p_account_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare a public.whatsapp_template_accounts%rowtype; b public.whatsapp_template_bindings%rowtype; v_id uuid; v_revision bigint;
begin
  select * into a from public.whatsapp_template_accounts where id=p_account_id for update;
  if not found then raise exception 'template_account_refused' using errcode='42501'; end if;
  select b0.* into b from public.whatsapp_template_bindings b0 join public.whatsapp_channels c on c.id=b0.channel_id
    where b0.account_id=a.id and b0.verified_at is not null and b0.channel_credential_revision=c.template_credential_revision
    and b0.provider='datafy' and c.status='connected' order by b0.id limit 1 for share of b0,c;
  if not found then return null; end if;
  select id into v_id from public.whatsapp_template_jobs where account_id=a.id and operation='sync'
    and revision=a.reconciliation_revision and binding_id=b.id and binding_generation=b.generation
    and (state='queued' or (state='claimed' and claimed_until>clock_timestamp())) order by created_at,id limit 1;
  if v_id is not null then return v_id; end if;
  update public.whatsapp_template_accounts set reconciliation_revision=reconciliation_revision+1,last_sync_requested_at=clock_timestamp()
    where id=a.id returning reconciliation_revision into v_revision;
  return public.enqueue_whatsapp_template_job(b.id,'sync','account',v_revision);
end $$;
revoke all on function public.request_whatsapp_template_sync(uuid) from public,anon,authenticated,service_role;
grant execute on function public.request_whatsapp_template_sync(uuid) to service_role;

create or replace function public.select_due_whatsapp_template_accounts(p_limit integer default 20)
returns setof public.whatsapp_template_accounts language sql security definer set search_path='' as $$
  select a.* from public.whatsapp_template_accounts a
  where (a.last_sync_requested_at is null or a.last_sync_requested_at<=clock_timestamp()-interval '5 minutes'
    or exists(select from public.whatsapp_template_jobs j where j.account_id=a.id and j.due_at<=clock_timestamp()
      and (j.state='queued' or (j.state in('claimed','posting') and j.claimed_until<=clock_timestamp()))))
  and exists(select from public.whatsapp_template_bindings b join public.whatsapp_channels c on c.id=b.channel_id
    where b.account_id=a.id and b.verified_at is not null and b.channel_credential_revision=c.template_credential_revision and b.provider='datafy' and c.status='connected')
  and (exists(select from public.whatsapp_remote_templates t where t.account_id=a.id)
    or exists(select from public.platform_flags where key='whatsapp_template_catalog' and value='true'::jsonb))
  order by a.last_sync_requested_at nulls first,a.id limit least(greatest(coalesce(p_limit,20),1),20)
$$;
revoke all on function public.select_due_whatsapp_template_accounts(integer) from public,anon,authenticated,service_role;
grant execute on function public.select_due_whatsapp_template_accounts(integer) to service_role;

create or replace function public.complete_whatsapp_template_sync_job(p_job_id uuid,p_fence uuid,p_success boolean,p_reason text)
returns boolean language plpgsql security definer set search_path='' as $$
declare j public.whatsapp_template_jobs%rowtype; a public.whatsapp_template_accounts%rowtype; b public.whatsapp_template_bindings%rowtype; gb public.whatsapp_template_bindings%rowtype; c public.whatsapp_channels%rowtype; gc public.whatsapp_channels%rowtype; v_old_id uuid;
begin
  if p_success is null or p_reason not in('template_synced','template_get_failed','template_snapshot_stale','template_binding_unavailable') then raise exception 'template_sync_result_invalid' using errcode='22023'; end if;
  select * into j from public.whatsapp_template_jobs where id=p_job_id;
  if not found then return false; end if;
  select * into a from public.whatsapp_template_accounts where id=j.account_id for update;
  perform 1 from public.whatsapp_template_bindings where id in(j.binding_id,a.sync_binding_id) order by id for share;
  select * into b from public.whatsapp_template_bindings where id=j.binding_id;
  select * into gb from public.whatsapp_template_bindings where id=a.sync_binding_id;
  perform 1 from public.whatsapp_channels where id in(b.channel_id,gb.channel_id) order by id for share;
  select * into c from public.whatsapp_channels where id=b.channel_id;
  select * into gc from public.whatsapp_channels where id=gb.channel_id;
  perform 1 from public.whatsapp_remote_templates where account_id=a.id order by id for update;
  select * into j from public.whatsapp_template_jobs where id=p_job_id for update;
  if j.operation not in('sync','reconcile') or j.state<>'claimed' or j.claim_token is distinct from p_fence or j.claimed_until<=clock_timestamp() then return false; end if;
  if p_success and (p_reason<>'template_synced' or a.last_sync_published_at is null or a.last_sync_published_at<j.claimed_until-interval '90 seconds'
    or b.generation is distinct from j.binding_generation or b.verified_at is null or c.id is null
    or b.channel_credential_revision is distinct from c.template_credential_revision
    or gb.id is null or gc.id is null or gb.verified_at is null or gb.generation is distinct from a.sync_binding_generation
    or gb.channel_credential_revision is distinct from a.sync_credential_revision or gc.template_credential_revision is distinct from a.sync_credential_revision
    or a.reconciliation_revision<>j.revision
    or exists(select from public.whatsapp_remote_templates t where t.account_id=a.id and (t.sync_required or t.binding_generation<>a.binding_generation))) then return false; end if;
  if not p_success then
    update public.whatsapp_remote_templates set sync_required=true,sync_epoch=sync_epoch+1 where account_id=a.id;
  end if;
  update public.whatsapp_template_jobs set state=case when p_success then 'done' else 'failed' end,
    error_code=case when p_success then null else p_reason end,finished_at=clock_timestamp() where id=j.id and claim_token=p_fence;
  if p_success then
    -- Current publication retires abandoned older syncs, never live claims or POST evidence.
    for v_old_id in select id from public.whatsapp_template_jobs
      where account_id=a.id and operation='sync' and state in('queued','claimed')
        and revision<j.revision and posting_started_at is null order by id for update
    loop
      -- Refresh SQL time after each row lock; the historical fence remains unchanged.
      update public.whatsapp_template_jobs set state='done',finished_at=clock_timestamp(),error_code=null
        where id=v_old_id and (state='queued' or (state='claimed' and claimed_until<=clock_timestamp()));
    end loop;
  end if;
  return true;
end $$;
revoke all on function public.complete_whatsapp_template_sync_job(uuid,uuid,boolean,text) from public,anon,authenticated,service_role;
grant execute on function public.complete_whatsapp_template_sync_job(uuid,uuid,boolean,text) to service_role;

create or replace function public.prepare_whatsapp_template_provision(p_job_id uuid,p_fence uuid,p_generation bigint)
returns boolean language plpgsql security definer set search_path='' as $$
declare j public.whatsapp_template_jobs%rowtype; b public.whatsapp_template_bindings%rowtype; a public.whatsapp_template_accounts%rowtype;
  c public.whatsapp_channels%rowtype; t public.whatsapp_remote_templates%rowtype; v_now timestamptz;
begin
  select * into j from public.whatsapp_template_jobs where id=p_job_id;
  if not found then return false; end if;
  select * into a from public.whatsapp_template_accounts where id=j.account_id for share;
  select * into b from public.whatsapp_template_bindings where id=j.binding_id for share;
  select * into c from public.whatsapp_channels where id=b.channel_id for share;
  select * into t from public.whatsapp_remote_templates where account_id=a.id and logical_id=j.target_key and version=1 and language='pt_BR' for update;
  select * into j from public.whatsapp_template_jobs where id=p_job_id for update;
  v_now:=clock_timestamp();
  if j.state<>'claimed' or j.claim_token is distinct from p_fence or j.claimed_until<=v_now or j.posting_started_at is not null then return false; end if;
  if j.operation<>'provision' or b.id is null or a.id is null or c.id is null or t.id is null or t.name<>t.logical_id
    or (b.account_id,b.generation) is distinct from (j.account_id,j.binding_generation) or p_generation is distinct from b.generation
    or b.verified_at is null or b.channel_credential_revision is distinct from c.template_credential_revision
    or (c.unit_id,c.provider) is distinct from (b.unit_id,b.provider) then
    update public.whatsapp_template_jobs set state='needs_review',error_code='binding_changed' where id=j.id; return false;
  end if;
  if j.target_key not in('res_confirmacao_v1','res_confirmacao_desconto_v1','res_lembrete_dia_v1','res_pesquisa_reserva_v1','fila_entrada_v1','fila_feedback_v1','mkt_voucher_programado_v1') then return false; end if;
  if a.sync_capture_id is null or a.last_sync_published_at is null or exists(select from public.whatsapp_remote_templates where account_id=a.id and sync_required) then return false; end if;
  if t.sync_required or t.binding_generation<>a.binding_generation or t.last_synced_at is null or t.last_synced_at<v_now-interval '60 seconds' then return false; end if;
  if t.remote_id is not null and t.observed_hash=t.desired_hash and t.effective_category=t.requested_category then
    update public.whatsapp_template_jobs set state='done',error_code='existing_template',finished_at=v_now where id=j.id;
    return false;
  end if;
  if t.remote_id is not null or t.remote_status<>'UNKNOWN' or t.observed_hash is not null
    or (t.submission_attempted_at is not null and not(j.attempts>0 and j.provider_outcome='rejected' and j.error_code='documented_preproxy_429'))
    or exists(select from public.whatsapp_template_jobs other where other.account_id=j.account_id and other.operation='provision'
      and other.target_key=j.target_key and other.id<>j.id and (other.posting_started_at is not null or other.provider_outcome is not null)) then
    update public.whatsapp_template_jobs set state='needs_review',error_code='submission_history_protected' where id=j.id; return false;
  end if;
  if b.submission_authorized_at is null or b.provider<>'datafy' or not exists(select from public.platform_flags where key='whatsapp_template_catalog' and value='true'::jsonb)
    or c.status<>'connected' or c.last_health_check_at is null or c.last_health_check_at<v_now-interval '5 minutes' then
    update public.whatsapp_template_jobs set state='paused',error_code='submission_paused' where id=j.id; return false;
  end if;
  update public.whatsapp_remote_templates set submission_attempted_at=coalesce(submission_attempted_at,v_now),local_status='submitting' where id=t.id;
  update public.whatsapp_template_jobs set state='posting',post_capture_id=a.sync_capture_id,posting_started_at=v_now,claimed_until=v_now+interval '90 seconds',attempts=attempts+1 where id=j.id and claim_token=p_fence;
  return true;
end $$;
revoke all on function public.prepare_whatsapp_template_provision(uuid,uuid,bigint) from public,anon,authenticated,service_role;
grant execute on function public.prepare_whatsapp_template_provision(uuid,uuid,bigint) to service_role;
-- Final read-only SQL fence after asynchronous service/channel checks. The
-- start function remains claimed-only, so two starts cannot both authorize POST.
create or replace function public.confirm_whatsapp_template_post(p_job_id uuid,p_fence uuid,p_generation bigint)
returns boolean language plpgsql security definer set search_path='' as $$
declare j public.whatsapp_template_jobs%rowtype; a public.whatsapp_template_accounts%rowtype;
  b public.whatsapp_template_bindings%rowtype; c public.whatsapp_channels%rowtype;
  gb public.whatsapp_template_bindings%rowtype; gc public.whatsapp_channels%rowtype;
  t public.whatsapp_remote_templates%rowtype; v_now timestamptz;
begin
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
  if t.name<>t.logical_id or t.logical_id not in('res_confirmacao_v1','res_confirmacao_desconto_v1','res_lembrete_dia_v1','res_pesquisa_reserva_v1','fila_entrada_v1','fila_feedback_v1','mkt_voucher_programado_v1')
    or t.binding_generation<>a.binding_generation or t.last_synced_at is null or t.last_synced_at<v_now-interval '60 seconds'
    or t.remote_id is not null or t.remote_status<>'UNKNOWN' or t.observed_hash is not null or t.submission_attempted_at is null
    or exists(select from public.whatsapp_remote_templates where account_id=a.id and sync_required)
    or not exists(select from public.platform_flags where key='whatsapp_template_catalog' and value='true'::jsonb) then return false; end if;
  return true;
end $$;
revoke all on function public.confirm_whatsapp_template_post(uuid,uuid,bigint) from public,anon,authenticated,service_role;
grant execute on function public.confirm_whatsapp_template_post(uuid,uuid,bigint) to service_role;
create or replace function public.publish_whatsapp_template_sync(p_account_id uuid,p_account_generation bigint,p_epochs jsonb,p_snapshot jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare a public.whatsapp_template_accounts%rowtype; t public.whatsapp_remote_templates%rowtype; s jsonb; v_count integer; v_now timestamptz; v_quality text; v_usable boolean; b public.whatsapp_template_bindings%rowtype; c public.whatsapp_channels%rowtype; v_epochs jsonb;
begin
  v_epochs:=p_epochs->'templates';
  if jsonb_typeof(p_epochs) is distinct from 'object' or jsonb_typeof(v_epochs) is distinct from 'array' then return false; end if;
  if (p_epochs-array['account_generation','capture_id','binding_id','binding_generation','credential_revision','templates'])<>'{}'::jsonb then return false; end if;
  if jsonb_typeof(p_snapshot) is distinct from 'array' or jsonb_array_length(v_epochs)>1000 or jsonb_array_length(p_snapshot)>1000 then raise exception 'template_snapshot_invalid' using errcode='22023'; end if;
  select * into a from public.whatsapp_template_accounts where id=p_account_id for update;
  if not found or a.binding_generation is distinct from p_account_generation then return false; end if;
  if a.sync_capture_id is null or p_epochs->>'capture_id' is distinct from a.sync_capture_id::text or p_epochs->>'binding_id' is distinct from a.sync_binding_id::text
    or p_epochs->>'binding_generation' is distinct from a.sync_binding_generation::text or p_epochs->>'credential_revision' is distinct from a.sync_credential_revision::text then return false; end if;
  select * into b from public.whatsapp_template_bindings where id=a.sync_binding_id for share;
  select * into c from public.whatsapp_channels where id=b.channel_id for share;
  if b.id is null or b.account_id is distinct from a.id or b.generation is distinct from a.sync_binding_generation or b.verified_at is null
    or b.channel_credential_revision is distinct from a.sync_credential_revision or c.template_credential_revision is distinct from a.sync_credential_revision
    or (c.unit_id,c.provider) is distinct from (b.unit_id,b.provider) then return false; end if;
  perform 1 from public.whatsapp_remote_templates where account_id=p_account_id order by id for update;
  select count(*) into v_count from public.whatsapp_remote_templates where account_id=p_account_id;
  -- Complete captured set, no omissions, duplicates or newly introduced rows.
  if jsonb_array_length(v_epochs)<>v_count or jsonb_array_length(p_snapshot)<>v_count or
    (select count(distinct x->>'id') from jsonb_array_elements(v_epochs) x)<>v_count or
    (select count(distinct x->>'id') from jsonb_array_elements(p_snapshot) x)<>v_count or
    exists(select from jsonb_array_elements(v_epochs) x left join public.whatsapp_remote_templates r on r.id=(x->>'id')::uuid and r.account_id=p_account_id where r.id is null or r.sync_epoch is distinct from (x->>'epoch')::bigint) or
    exists(select from jsonb_array_elements(p_snapshot) x left join public.whatsapp_remote_templates r on r.id=(x->>'id')::uuid and r.account_id=p_account_id where r.id is null) then return false;
  end if;
  v_now:=clock_timestamp();
  for t in select * from public.whatsapp_remote_templates where account_id=p_account_id order by id loop
    select x into s from jsonb_array_elements(p_snapshot) x where x->>'id'=t.id::text;
    if jsonb_typeof(s) is distinct from 'object' or (s-array['id','remote_id','name','language','observed_hash','effective_category','remote_status','quality','rejection_code'])<>'{}'::jsonb or s->>'name' is distinct from t.name or s->>'language' is distinct from t.language or s->>'remote_status' is null then raise exception 'template_snapshot_invalid' using errcode='22023'; end if;
    v_quality:=coalesce(s->>'quality',t.quality);
    v_usable:=(s->>'remote_status'='APPROVED' and s->>'observed_hash'=t.desired_hash and s->>'effective_category'=t.requested_category and s->>'remote_id' is not null and (t.requested_category<>'MARKETING' or v_quality<>'RED'));
    update public.whatsapp_remote_templates set remote_id=coalesce(s->>'remote_id',remote_id),observed_hash=s->>'observed_hash',effective_category=s->>'effective_category',remote_status=s->>'remote_status',quality=v_quality,rejection_code=s->>'rejection_code',binding_generation=a.binding_generation,last_synced_at=v_now,sync_required=false,
      local_status=case when coalesce(v_usable,false) then 'usable' when s->>'remote_status'='REJECTED' then 'rejected' when s->>'remote_status'='PAUSED' or (v_quality='RED' and requested_category='MARKETING') then 'paused' when s->>'remote_status' in('DISABLED','DELETED','PENDING_DELETION') then 'disabled' when s->>'observed_hash' is not null and (s->>'observed_hash'<>desired_hash or s->>'effective_category' is distinct from requested_category) then 'conflict' else 'pending' end where id=t.id;
  end loop;
  update public.whatsapp_template_accounts set last_sync_published_at=v_now where id=a.id;
  return true;
end $$;
revoke all on function public.publish_whatsapp_template_sync(uuid,bigint,jsonb,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.publish_whatsapp_template_sync(uuid,bigint,jsonb,jsonb) to service_role;
create or replace function public.claim_whatsapp_template_job(p_job_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.whatsapp_template_jobs%rowtype; v_now timestamptz; v_account uuid;
begin
  select account_id into v_account from public.whatsapp_template_jobs where id=p_job_id;
  if not found then return null; end if;
  perform 1 from public.whatsapp_template_accounts where id=v_account for update;
  if exists(select from public.whatsapp_template_jobs where account_id=v_account and id<>p_job_id and state in('claimed','posting') and claimed_until>clock_timestamp()) then return null; end if;
  select * into j from public.whatsapp_template_jobs where id=p_job_id for update;
  if not found then return null; end if;
  v_now:=clock_timestamp();
  if j.state='posting' and j.claimed_until<=v_now then update public.whatsapp_template_jobs set state='uncertain',provider_outcome='uncertain',error_code='post_lease_expired' where id=j.id and claim_token=j.claim_token; return null; end if;
  if j.posting_started_at is not null or j.due_at>v_now or j.attempts>=5 or not (j.state='queued' or (j.state='claimed' and j.claimed_until<=v_now)) then return null; end if;
  update public.whatsapp_template_jobs set state='claimed',claim_token=gen_random_uuid(),claimed_until=v_now+interval '90 seconds',error_code=case when error_code='documented_preproxy_429' then error_code else null end where id=j.id returning * into j;
  return to_jsonb(j);
end $$;
revoke all on function public.claim_whatsapp_template_job(uuid) from public,anon,authenticated,service_role;
grant execute on function public.claim_whatsapp_template_job(uuid) to service_role;

create or replace function public.begin_whatsapp_template_sync(p_account_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.whatsapp_template_accounts%rowtype; b public.whatsapp_template_bindings%rowtype; v_epochs jsonb; v_capture uuid:=gen_random_uuid();
begin
  select * into a from public.whatsapp_template_accounts where id=p_account_id for update;
  if not found then raise exception 'template_account_refused' using errcode='42501'; end if;
  select b0.* into b from public.whatsapp_template_bindings b0 join public.whatsapp_channels c on c.id=b0.channel_id
    where b0.account_id=a.id and b0.verified_at is not null and b0.provider='datafy' and c.status='connected'
    and b0.channel_credential_revision=c.template_credential_revision order by b0.id limit 1 for share of b0,c;
  if not found then raise exception 'template_binding_refused' using errcode='42501'; end if;
  update public.whatsapp_template_accounts set sync_capture_id=v_capture,sync_binding_id=b.id,sync_binding_generation=b.generation,
    sync_credential_revision=b.channel_credential_revision,last_sync_published_at=null where id=a.id;
  perform 1 from public.whatsapp_remote_templates where account_id=a.id order by id for update;
  update public.whatsapp_remote_templates set sync_epoch=sync_epoch+1,sync_required=true where account_id=a.id;
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'epoch',sync_epoch) order by id),'[]'::jsonb) into v_epochs from public.whatsapp_remote_templates where account_id=a.id;
  return jsonb_build_object('account_generation',a.binding_generation,'capture_id',v_capture,'binding_id',b.id,
    'binding_generation',b.generation,'credential_revision',b.channel_credential_revision,'templates',v_epochs);
end $$;
revoke all on function public.begin_whatsapp_template_sync(uuid) from public,anon,authenticated,service_role;
grant execute on function public.begin_whatsapp_template_sync(uuid) to service_role;
create or replace function public.finish_whatsapp_template_job(p_job_id uuid,p_fence uuid,p_result jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare j public.whatsapp_template_jobs%rowtype; v_outcome text:=p_result->>'outcome'; v_reason text:=p_result->>'reason'; v_now timestamptz; v_provider text; v_wait integer;
begin
  if jsonb_typeof(p_result) is distinct from 'object' or (p_result-array['outcome','reason','retry_after_seconds'])<>'{}'::jsonb or v_outcome is null or v_reason is null or not ((v_outcome='local_preflight_refused' and v_reason in('final_service_suspended','final_channel_changed','final_gate_paused')) or (v_outcome='accepted' and v_reason='provider_accepted') or (v_outcome='uncertain' and v_reason in('post_ambiguous','response_invalid','post_lease_expired')) or (v_outcome='rejected' and v_reason in('documented_preproxy_429','provider_rejected','auth_rejected','template_rejected'))) then raise exception 'template_result_invalid' using errcode='22023'; end if;
  -- No earlier locks after job. Provider read is informational, never FOR SHARE.
  select b.provider into v_provider from public.whatsapp_template_bindings b join public.whatsapp_template_jobs tj on tj.binding_id=b.id and tj.binding_generation=b.generation where tj.id=p_job_id;
  select * into j from public.whatsapp_template_jobs where id=p_job_id for update;
  if not found or j.claim_token is distinct from p_fence then return false; end if;
  v_now:=clock_timestamp();
  if v_outcome='local_preflight_refused' then
    if (p_result-array['outcome','reason'])<>'{}'::jsonb or j.operation<>'provision' or j.state<>'posting' or j.posting_started_at is null or j.claimed_until<=v_now or j.attempts<1 or j.provider_outcome='accepted' then return false; end if;
    insert into app_private.whatsapp_post_reset_permits values(txid_current(),'whatsapp_template_jobs',j.id,p_fence,j.attempts,j.posting_started_at);
    update public.whatsapp_template_jobs set state=case when v_reason='final_channel_changed' then 'needs_review' else 'paused' end,
      posting_started_at=null,post_capture_id=null,claim_token=null,claimed_until=null,attempts=attempts-1,provider_outcome=null,error_code=v_reason where id=j.id and claim_token=p_fence;
    return true;
  end if;
  if j.state='accepted' then return v_outcome='accepted'; end if;
  if j.posting_started_at is null or j.state not in('posting','uncertain') then return false; end if;
  if v_outcome='accepted' then update public.whatsapp_template_jobs set state='accepted',provider_outcome='accepted',finished_at=v_now,error_code=null where id=j.id and claim_token=p_fence;
  elsif v_outcome='uncertain' then update public.whatsapp_template_jobs set state='uncertain',provider_outcome='uncertain',error_code=v_reason where id=j.id and claim_token=p_fence;
  elsif j.state='uncertain' then return false;
  elsif v_reason='documented_preproxy_429' and v_provider='datafy' and j.attempts<5 then
    v_wait:=coalesce((p_result->>'retry_after_seconds')::integer,0);
    if v_wait<0 or v_wait>86400 then raise exception 'template_result_invalid' using errcode='22023'; end if;
    insert into app_private.whatsapp_post_reset_permits values(txid_current(),'whatsapp_template_jobs',j.id,p_fence,j.attempts,j.posting_started_at);
    update public.whatsapp_template_jobs set state='queued',posting_started_at=null,post_capture_id=null,provider_outcome='rejected',due_at=v_now+make_interval(secs=>greatest(60*power(4,j.attempts-1)::integer,v_wait)),error_code=v_reason where id=j.id and claim_token=p_fence;
  else update public.whatsapp_template_jobs set state='rejected',provider_outcome='rejected',finished_at=v_now,error_code=v_reason where id=j.id and claim_token=p_fence;
  end if;
  return true;
end $$;
revoke all on function public.finish_whatsapp_template_job(uuid,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.finish_whatsapp_template_job(uuid,uuid,jsonb) to service_role;
create or replace function public.guard_whatsapp_template_scope()
returns trigger language plpgsql security definer set search_path='' as $$
declare
  v_org uuid; v_customer_org uuid; v_deleted timestamptz;
  v_binding public.whatsapp_template_bindings%rowtype;
  v_channel public.whatsapp_channels%rowtype;
  v_remote public.whatsapp_remote_templates%rowtype;
  v_job public.whatsapp_automation_jobs%rowtype;
  v_resource_unit uuid; v_resource_customer uuid; v_resource_invalid boolean:=false; v_reset boolean:=false; v_erasure boolean:=false;
begin
  -- Existing intents are historical evidence: only INSERT checks mutable parents.
  -- State/fence reconciliation must survive a deleted/changed binding or customer.
  if tg_op='UPDATE' and tg_table_name='whatsapp_automation_jobs' then
    if (new.id,new.unit_id,new.organization_id,new.kind,new.reservation_id,new.waitlist_id,new.voucher_id,new.source_event_key,new.fact_at,new.expires_at,new.channel_id,new.provider,new.binding_id,new.binding_generation,new.transport,new.account_id,new.remote_template_id,new.template_version,new.notification_id) is distinct from (old.id,old.unit_id,old.organization_id,old.kind,old.reservation_id,old.waitlist_id,old.voucher_id,old.source_event_key,old.fact_at,old.expires_at,old.channel_id,old.provider,old.binding_id,old.binding_generation,old.transport,old.account_id,old.remote_template_id,old.template_version,old.notification_id) then raise exception 'automation_intent_immutable' using errcode='23514'; end if;
    if old.customer_id is not null and new.customer_id is null then
      -- UPDATE already owns the job. Ordered erasure owns customer first;
      -- this guard verifies its actual state without acquiring an earlier lock.
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
    if old.posting_started_at is not null and not v_reset and not v_erasure and new.safe_log_body is distinct from old.safe_log_body then raise exception 'automation_render_immutable' using errcode='23514'; end if;
    if old.provider_message_id is not null and new.provider_message_id is distinct from old.provider_message_id then raise exception 'automation_provider_identity_immutable' using errcode='23514'; end if;
    return new;
  end if;
  if tg_op='UPDATE' and tg_table_name='whatsapp_template_jobs' then
    if (new.id,new.organization_id,new.account_id,new.binding_id,new.binding_generation,new.operation,new.target_key,new.revision) is distinct from (old.id,old.organization_id,old.account_id,old.binding_id,old.binding_generation,old.operation,old.target_key,old.revision) then raise exception 'template_job_identity_immutable' using errcode='23514'; end if;
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
    if tg_op='UPDATE' and (new.id,new.unit_id,new.customer_id,new.job_id,new.created_at,new.window_days) is distinct from (old.id,old.unit_id,old.customer_id,old.job_id,old.created_at,old.window_days) then raise exception 'promotion_slot_identity_immutable' using errcode='23514'; end if;
    if tg_op='UPDATE' and (new.claim_token is distinct from old.claim_token or new.window_until<old.window_until or (old.state='accepted' and new.state<>'accepted') or (old.state='uncertain' and new.state='reserved') or (old.accepted_at is not null and new.accepted_at is distinct from old.accepted_at)) then raise exception 'promotion_slot_evidence_immutable' using errcode='23514'; end if;
  elsif tg_table_name='whatsapp_automation_receipt_events' then
    select * into v_channel from public.whatsapp_channels where id=new.channel_id for share;
    if not found or (v_channel.unit_id,v_channel.provider) is distinct from (new.unit_id,new.provider) then raise exception 'template_channel_mismatch' using errcode='23514'; end if;
  end if;
  return new;
end $$;
revoke all on function public.guard_whatsapp_template_scope() from public,anon,authenticated,service_role;

create or replace function public.whatsapp_template_pipeline_health()
returns jsonb language sql security definer set search_path='' as $$
  select jsonb_build_object('failed',(select count(*) from public.whatsapp_template_jobs where state='failed'),
    'uncertain',(select count(*) from public.whatsapp_template_jobs where state='uncertain'),
    'oldest_id',(select id from public.whatsapp_template_jobs where state in('queued','claimed','posting','uncertain','paused','needs_review') order by created_at,id limit 1),
    'oldest_age_seconds',coalesce((select greatest(0,extract(epoch from clock_timestamp()-min(created_at))) from public.whatsapp_template_jobs where state in('queued','claimed','posting','uncertain','paused','needs_review')),0))
$$;
revoke all on function public.whatsapp_template_pipeline_health() from public,anon,authenticated,service_role;
grant execute on function public.whatsapp_template_pipeline_health() to service_role;

create or replace function public.purge_whatsapp_template_workers()
returns integer language plpgsql security definer set search_path='' as $$
declare v_events integer; v_jobs integer;
begin
  delete from public.whatsapp_template_events where id in(select id from public.whatsapp_template_events
    where processing_state in('processed','ignored') and received_at<clock_timestamp()-interval '90 days' order by received_at limit 500);
  get diagnostics v_events=row_count;
  delete from public.whatsapp_template_jobs where id in(select id from public.whatsapp_template_jobs
    where state in('accepted','rejected','failed','done') and finished_at<clock_timestamp()-interval '90 days' order by finished_at limit 500);
  get diagnostics v_jobs=row_count;
  return v_events+v_jobs;
end $$;
revoke all on function public.purge_whatsapp_template_workers() from public,anon,authenticated,service_role;
grant execute on function public.purge_whatsapp_template_workers() to service_role;

create or replace function public.trigger_whatsapp_template_workers()
returns void language plpgsql security definer set search_path='' as $$
declare v_key text; v_url text;
begin
  select decrypted_secret into v_key from vault.decrypted_secrets where name='internal_api_key' limit 1;
  select decrypted_secret into v_url from vault.decrypted_secrets where name='project_url' limit 1;
  if nullif(v_key,'') is null or nullif(v_url,'') is null then return; end if;
  perform net.http_post(url:=v_url||'/functions/v1/process-whatsapp-templates',
    headers:=jsonb_build_object('Content-Type','application/json','x-internal-key',v_key),body:='{}'::jsonb,timeout_milliseconds:=60000);
end $$;
revoke all on function public.trigger_whatsapp_template_workers() from public,anon,authenticated,service_role;

insert into public.platform_flags(key,value) values('whatsapp_template_catalog','false'::jsonb),('whatsapp_automation_dispatch','false'::jsonb) on conflict(key) do nothing;
do $$ begin
  perform cron.unschedule(jobid) from cron.job where jobname='whatsapp-template-workers';
  perform cron.schedule('whatsapp-template-workers','*/5 * * * *','select public.trigger_whatsapp_template_workers();');
end $$;
notify pgrst,'reload schema';
commit;
