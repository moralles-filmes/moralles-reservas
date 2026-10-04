-- Public capability is mediated by the Edge Function; every RPC here is internal.
begin;
create table if not exists app_private.whatsapp_preference_rate_buckets (
  bucket_hash text primary key check(bucket_hash ~ '^[a-f0-9]{64}$'),
  hits integer not null check(hits>0),
  expires_at timestamptz not null
);
alter table app_private.whatsapp_preference_rate_buckets enable row level security;
alter table app_private.whatsapp_preference_rate_buckets force row level security;
revoke all on app_private.whatsapp_preference_rate_buckets from public,anon,authenticated,service_role;
create table if not exists app_private.whatsapp_promotion_slot_release_permits (
  transaction_id bigint not null, slot_id uuid not null, primary key(transaction_id,slot_id)
);
alter table app_private.whatsapp_promotion_slot_release_permits enable row level security;
alter table app_private.whatsapp_promotion_slot_release_permits force row level security;
revoke all on app_private.whatsapp_promotion_slot_release_permits from public,anon,authenticated,service_role;

create or replace function app_private.consume_whatsapp_slot_release(p_slot_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare n integer;
begin
  delete from app_private.whatsapp_promotion_slot_release_permits where transaction_id=txid_current() and slot_id=p_slot_id;
  get diagnostics n=row_count; return n=1;
end$$;
revoke all on function app_private.consume_whatsapp_slot_release(uuid) from public,anon,authenticated,service_role;

create or replace function public.check_whatsapp_preference_rate(p_bucket_hash text,p_limit integer default 30,p_window_seconds integer default 60)
returns boolean language plpgsql security definer set search_path='' as $$
declare n integer; v_now timestamptz:=clock_timestamp();
begin
  if p_bucket_hash is null or p_bucket_hash !~ '^[a-f0-9]{64}$' or p_limit is null or p_limit not between 1 and 100 or p_window_seconds is null or p_window_seconds not between 10 and 300 then raise exception 'preference_rate_invalid' using errcode='22023'; end if;
  delete from app_private.whatsapp_preference_rate_buckets where expires_at<v_now-interval '5 minutes';
  insert into app_private.whatsapp_preference_rate_buckets(bucket_hash,hits,expires_at) values(p_bucket_hash,1,v_now+make_interval(secs=>p_window_seconds))
  on conflict(bucket_hash) do update set hits=case when app_private.whatsapp_preference_rate_buckets.expires_at<=v_now then 1 else least(app_private.whatsapp_preference_rate_buckets.hits+1,p_limit+1) end,
    expires_at=case when app_private.whatsapp_preference_rate_buckets.expires_at<=v_now then v_now+make_interval(secs=>p_window_seconds) else app_private.whatsapp_preference_rate_buckets.expires_at end
  returning hits into n;
  return n<=p_limit;
end$$;
revoke all on function public.check_whatsapp_preference_rate(text,integer,integer) from public,anon,authenticated,service_role;
grant execute on function public.check_whatsapp_preference_rate(text,integer,integer) to service_role;

create or replace function public.get_whatsapp_promotion_preference(p_job_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('decision',coalesce(e.decision,'unknown'),'revision',e.revision)
  from public.whatsapp_automation_jobs j join public.customers c on c.id=j.customer_id and c.deleted_at is null
  left join lateral(select decision,revision from public.whatsapp_message_consent_events where unit_id=j.unit_id and customer_id=j.customer_id and purpose='promotional' order by revision desc limit 1)e on true
  where j.id=p_job_id and j.kind in('waitlist_feedback','voucher_issued') and j.customer_erased_at is null
$$;
revoke all on function public.get_whatsapp_promotion_preference(uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_whatsapp_promotion_preference(uuid) to service_role;

create or replace function public.issue_whatsapp_preference_token(p_job_id uuid,p_token_hash text)
returns boolean language plpgsql security definer set search_path='' as $$
declare j public.whatsapp_automation_jobs%rowtype; c public.customers%rowtype; v_now timestamptz;
begin
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' then raise exception 'preference_token_invalid' using errcode='22023'; end if;
  select * into j from public.whatsapp_automation_jobs where id=p_job_id;
  if not found or j.kind not in('waitlist_feedback','voucher_issued') or j.customer_id is null then return false; end if;
  select * into c from public.customers where id=j.customer_id for update;
  select * into j from public.whatsapp_automation_jobs where id=p_job_id for share;
  v_now:=clock_timestamp();
  if c.id is null or c.deleted_at is not null or c.do_not_contact or j.customer_id is distinct from c.id or j.organization_id is distinct from c.organization_id or j.customer_erased_at is not null or j.posting_started_at is not null or j.provider_message_id is not null or j.state not in('queued','claimed','retry_wait') or j.expires_at<v_now then return false; end if;
  if not exists(select from public.whatsapp_message_consent_events where id=(select id from public.whatsapp_message_consent_events where unit_id=j.unit_id and customer_id=c.id and purpose='promotional' order by revision desc limit 1) and decision='opt_in') then return false; end if;
  insert into public.whatsapp_message_preference_tokens(unit_id,customer_id,token_hash,created_at,expires_at) values(j.unit_id,c.id,p_token_hash,v_now,v_now+interval '90 days') on conflict(token_hash) do nothing;
  return exists(select from public.whatsapp_message_preference_tokens where token_hash=p_token_hash and unit_id=j.unit_id and customer_id=c.id and revoked_at is null and expires_at>v_now);
end$$;
revoke all on function public.issue_whatsapp_preference_token(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.issue_whatsapp_preference_token(uuid,text) to service_role;

create or replace function public.lookup_whatsapp_preference_token(p_token_hash text)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('valid',true,'unitLabel',u.name,'choice',coalesce(e.decision,'unknown'))
  from public.whatsapp_message_preference_tokens t join public.customers c on c.id=t.customer_id and c.deleted_at is null
  join public.units u on u.id=t.unit_id and u.organization_id=c.organization_id
  left join lateral(select decision from public.whatsapp_message_consent_events where unit_id=t.unit_id and customer_id=t.customer_id and purpose='promotional' order by revision desc limit 1)e on true
  where t.token_hash=p_token_hash and t.revoked_at is null and t.expires_at>clock_timestamp()
$$;
revoke all on function public.lookup_whatsapp_preference_token(text) from public,anon,authenticated,service_role;
grant execute on function public.lookup_whatsapp_preference_token(text) to service_role;

create or replace function public.revoke_whatsapp_promotion(p_token_hash text)
returns boolean language plpgsql security definer set search_path='' as $$
declare t public.whatsapp_message_preference_tokens%rowtype; v_customer uuid; v_decision text;
begin
  select customer_id into v_customer from public.whatsapp_message_preference_tokens where token_hash=p_token_hash;
  if not found then return false; end if;
  perform 1 from public.customers where id=v_customer and deleted_at is null for update;
  if not found then return false; end if;
  select * into t from public.whatsapp_message_preference_tokens where token_hash=p_token_hash and customer_id=v_customer for update;
  if not found or t.revoked_at is not null or t.expires_at<=clock_timestamp() then return false; end if;
  if not exists(select from public.units u join public.customers c on c.organization_id=u.organization_id where u.id=t.unit_id and c.id=t.customer_id and c.deleted_at is null) then return false; end if;
  select decision into v_decision from public.whatsapp_message_consent_events where unit_id=t.unit_id and customer_id=t.customer_id and purpose='promotional' order by revision desc limit 1;
  if v_decision is distinct from 'opt_out' then
    insert into public.whatsapp_message_consent_events(unit_id,customer_id,purpose,decision,source_code,evidence_reference,observed_at)
    values(t.unit_id,t.customer_id,'promotional','opt_out','preference_link','preference_link_confirmed',clock_timestamp());
  end if;
  return true;
end$$;
revoke all on function public.revoke_whatsapp_promotion(text) from public,anon,authenticated,service_role;
grant execute on function public.revoke_whatsapp_promotion(text) to service_role;

create or replace function public.invalidate_whatsapp_preference_token(p_token_hash text)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_customer uuid;
begin
  select customer_id into v_customer from public.whatsapp_message_preference_tokens where token_hash=p_token_hash;
  if not found then return false; end if;
  perform 1 from public.customers where id=v_customer for update;
  update public.whatsapp_message_preference_tokens set revoked_at=clock_timestamp() where token_hash=p_token_hash and revoked_at is null;
  return found;
end$$;
revoke all on function public.invalidate_whatsapp_preference_token(text) from public,anon,authenticated,service_role;
grant execute on function public.invalidate_whatsapp_preference_token(text) to service_role;

create or replace function public.erase_whatsapp_customer_preferences()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if old.deleted_at is null and new.deleted_at is not null then
    delete from public.whatsapp_message_preference_tokens where customer_id=new.id;
    delete from public.whatsapp_message_consent_events where customer_id=new.id;
    delete from public.whatsapp_promotion_slots where customer_id=new.id;
    update public.whatsapp_automation_jobs set customer_id=null,safe_log_body=null where customer_id=new.id;
  end if;
  return new;
end$$;
revoke all on function public.erase_whatsapp_customer_preferences() from public,anon,authenticated,service_role;
drop trigger if exists customers_erase_whatsapp_preferences on public.customers;
create trigger customers_erase_whatsapp_preferences after update of deleted_at on public.customers for each row execute function public.erase_whatsapp_customer_preferences();


-- Policy writer belongs to authenticated platform-admin management (Task13).
create table if not exists app_private.whatsapp_promotion_policy (
  singleton boolean primary key default true check(singleton),
  window_days integer not null default 7 check(window_days between 1 and 30)
);
alter table app_private.whatsapp_promotion_policy enable row level security;
alter table app_private.whatsapp_promotion_policy force row level security;
revoke all on app_private.whatsapp_promotion_policy from public,anon,authenticated,service_role;
insert into app_private.whatsapp_promotion_policy(singleton,window_days) values(true,7) on conflict do nothing;
alter table public.whatsapp_promotion_slots add column if not exists window_days integer not null default 7 check(window_days between 1 and 30);
create unique index if not exists whatsapp_promotion_slots_unit_customer_idx on public.whatsapp_promotion_slots(unit_id,customer_id);

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
  elsif b.id is null or (b.unit_id,b.channel_id,b.provider,b.account_id,b.generation) is distinct from (j.unit_id,j.channel_id,j.provider,j.account_id,j.binding_generation) or p_generation is distinct from j.binding_generation or v_selected is distinct from j.channel_id then v_error:='binding_changed';
  elsif not b.dispatch_enabled or b.adopted_at is null or not exists(select from public.whatsapp_automation_adoptions where unit_id=j.unit_id) or not exists(select from public.platform_flags where key='whatsapp_automation_dispatch' and value='true'::jsonb) then v_error:='dispatch_paused';
  elsif ch.id is null or ch.unit_id<>j.unit_id or ch.provider<>j.provider or ch.is_active=false or ch.status<>'connected' or ch.last_health_check_at is null or ch.last_health_check_at<v_now-interval '5 minutes' then v_error:='channel_unavailable';
  elsif v_now>j.expires_at then v_error:='expired';
  elsif j.kind in('waitlist_feedback','voucher_issued') and (j.customer_id is null or v_decision is distinct from 'opt_in' or v_revision is null or p_consent_revision is distinct from v_revision) then v_error:='consent_changed';
  elsif j.kind in('waitlist_feedback','voucher_issued') and j.transport='template' and (v_cost is null or v_cost_from>v_now or v_cost_until<=v_now or t.requested_category is distinct from 'MARKETING') then v_error:='cost_not_authorized';
  elsif j.kind in('waitlist_feedback','voucher_issued') and s.id is not null and
    ((s.state in('accepted','uncertain') and s.window_until>v_now) or
     (s.state='reserved' and exists(select from public.whatsapp_automation_jobs old_job where old_job.id=s.job_id and (old_job.posting_started_at is not null or old_job.state='uncertain'))) or
     (s.state='reserved' and s.job_id<>j.id and s.claimed_until>v_now)) then v_error:='promotion_frequency';
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

create or replace function public.finish_whatsapp_automation(p_job_id uuid,p_fence uuid,p_result jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare j public.whatsapp_automation_jobs%rowtype; v_outcome text:=p_result->>'outcome'; v_reason text:=p_result->>'reason'; v_id text:=p_result->>'provider_message_id'; v_now timestamptz; v_wait integer; s public.whatsapp_promotion_slots%rowtype;
begin
  if jsonb_typeof(p_result) is distinct from 'object' or (p_result-array['outcome','reason','provider_message_id','retry_after_seconds'])<>'{}'::jsonb or v_outcome is null or v_reason is null or not ((v_outcome='accepted' and v_reason='provider_accepted') or (v_outcome='uncertain' and v_reason in('response_invalid','post_ambiguous','post_lease_expired')) or (v_outcome='rejected' and v_reason in('documented_preproxy_429','provider_rejected','auth_rejected','template_rejected')) or (v_outcome='local_preflight_refused' and v_reason in('final_service_suspended','final_channel_changed','final_consent_changed','final_resource_changed','final_gate_paused'))) then raise exception 'automation_result_invalid' using errcode='22023'; end if;
  if v_outcome='accepted' and (jsonb_typeof(p_result->'provider_message_id') is distinct from 'string' or v_id is null or char_length(v_id) not between 1 and 512 or v_id ~ '[[:cntrl:]]') then raise exception 'automation_result_invalid' using errcode='22023'; end if;
  if v_outcome<>'accepted' and v_id is not null then raise exception 'automation_result_invalid' using errcode='22023'; end if;
  if v_outcome='local_preflight_refused' and (p_result-array['outcome','reason'])<>'{}'::jsonb then raise exception 'automation_result_invalid' using errcode='22023'; end if;
  select * into j from public.whatsapp_automation_jobs where id=p_job_id;
  if not found then return false; end if;
  -- Historical evidence settles without live binding/account/template locks.
  if j.kind in('waitlist_feedback','voucher_issued') and j.customer_id is not null then
    perform 1 from public.customers where id=j.customer_id for update;
    select * into s from public.whatsapp_promotion_slots where unit_id=j.unit_id and customer_id=j.customer_id and job_id=j.id and claim_token=p_fence for update;
  end if;
  select * into j from public.whatsapp_automation_jobs where id=p_job_id for update;
  if not found or j.claim_token is distinct from p_fence or j.posting_started_at is null then return false; end if;
  v_now:=clock_timestamp();
  if j.state in('accepted','reconciled') then return v_outcome='accepted' and j.provider_message_id=v_id; end if;
  if j.state not in('posting','uncertain') then return false; end if;
  if v_outcome='local_preflight_refused' then
    if j.state<>'posting' or j.claimed_until<=v_now or j.provider_message_id is not null or j.attempts<1 or j.customer_erased_at is not null then return false; end if;
    insert into app_private.whatsapp_post_reset_permits values(txid_current(),'whatsapp_automation_jobs',j.id,p_fence,j.attempts,j.posting_started_at);
    update public.whatsapp_automation_jobs set state=case when v_reason='final_gate_paused' then 'paused' when v_reason in('final_channel_changed','final_resource_changed') then 'needs_review' else 'blocked' end,
      posting_started_at=null,safe_log_body=null,claim_token=null,claimed_until=null,attempts=attempts-1,reconcile_required=false,error_code=v_reason where id=j.id and claim_token=p_fence;
  elsif v_outcome='accepted' then
    update public.whatsapp_automation_jobs set state='accepted',provider_message_id=v_id,reconcile_required=true,error_code=null,finished_at=v_now where id=j.id and claim_token=p_fence;
  elsif v_outcome='uncertain' then
    update public.whatsapp_automation_jobs set state='uncertain',reconcile_required=true,error_code=v_reason where id=j.id and claim_token=p_fence;
  elsif j.state='uncertain' then return false;
  elsif v_reason='documented_preproxy_429' and j.provider='datafy' and j.provider_message_id is null and j.attempts<5 and v_now<=j.expires_at then
    v_wait:=coalesce((p_result->>'retry_after_seconds')::integer,0);
    if v_wait<0 or v_wait>86400 then raise exception 'automation_result_invalid' using errcode='22023'; end if;
    insert into app_private.whatsapp_post_reset_permits values(txid_current(),'whatsapp_automation_jobs',j.id,p_fence,j.attempts,j.posting_started_at);
    update public.whatsapp_automation_jobs set state='retry_wait',posting_started_at=null,safe_log_body=null,due_at=v_now+make_interval(secs=>greatest(60*power(4,j.attempts-1)::integer,v_wait)),error_code=v_reason where id=j.id and claim_token=p_fence;
  else
    update public.whatsapp_automation_jobs set state='rejected',error_code=v_reason,finished_at=v_now where id=j.id and claim_token=p_fence;
  end if;
  if s.id is not null then
    if v_outcome in('accepted','uncertain') then
      update public.whatsapp_promotion_slots set state=case when v_outcome='accepted' then 'accepted' else 'uncertain' end,
        accepted_at=case when v_outcome='accepted' then coalesce(accepted_at,v_now) else accepted_at end,
        window_until=greatest(window_until,v_now+make_interval(days=>s.window_days)) where id=s.id and claim_token=p_fence;
    else
      insert into app_private.whatsapp_promotion_slot_release_permits values(txid_current(),s.id);
      delete from public.whatsapp_promotion_slots where id=s.id;
    end if;
  end if;
  return true;
end $$;
revoke all on function public.finish_whatsapp_automation(uuid,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.finish_whatsapp_automation(uuid,uuid,jsonb) to service_role;

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
        (old.claimed_until>clock_timestamp() and new.state in('blocked','paused','needs_review') and new.error_code in('final_service_suspended','final_channel_changed','final_consent_changed','final_resource_changed','final_gate_paused') and new.claim_token is null and new.claimed_until is null and new.attempts=old.attempts-1)
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
      v_reset:=new.posting_started_at is null and new.state='queued' and old.state='posting' and old.provider_outcome is distinct from 'accepted' and new.provider_outcome='rejected' and new.claim_token=old.claim_token and new.attempts=old.attempts and app_private.consume_whatsapp_post_reset(tg_table_name,old.id,old.claim_token,old.attempts,old.posting_started_at);
      if not coalesce(v_reset,false) then raise exception 'template_post_marker_immutable' using errcode='23514'; end if;
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

create or replace function public.guard_whatsapp_template_evidence()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_table_name='whatsapp_automation_adoptions' then
    if tg_op='INSERT' and auth.role()='authenticated' and auth.uid() is not null and app_private.is_platform_admin(auth.uid()) then new.adopted_at:=now(); return new; end if;
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
