-- Service-only automation/catalog transactions. No producer, provider request or rollout.
begin;

-- Monotone task identity survives the future 90-day event purge. This is NOT
-- a snapshot epoch: GET publication still fences account generation + all epochs.
alter table public.whatsapp_template_accounts add column if not exists reconciliation_revision bigint not null default 0 check(reconciliation_revision>=0);

create table if not exists app_private.whatsapp_post_reset_permits (
  transaction_id bigint not null,
  table_name text not null check(table_name in('whatsapp_automation_jobs','whatsapp_template_jobs')),
  job_id uuid not null,
  fence uuid not null,
  attempt integer not null,
  marker timestamptz not null,
  primary key(transaction_id,table_name,job_id,fence,attempt)
);
alter table app_private.whatsapp_post_reset_permits enable row level security;
alter table app_private.whatsapp_post_reset_permits force row level security;
revoke all on table app_private.whatsapp_post_reset_permits from public,anon,authenticated,service_role;

create or replace function app_private.consume_whatsapp_post_reset(p_table text,p_id uuid,p_fence uuid,p_attempt integer,p_marker timestamptz)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_count integer;
begin
  delete from app_private.whatsapp_post_reset_permits where transaction_id=txid_current() and table_name=p_table and job_id=p_id and fence=p_fence and attempt=p_attempt and marker=p_marker;
  get diagnostics v_count=row_count;
  return v_count=1;
end $$;
revoke all on function app_private.consume_whatsapp_post_reset(text,uuid,uuid,integer,timestamptz) from public,anon,authenticated,service_role;

create index if not exists whatsapp_automation_retry_due_idx on public.whatsapp_automation_jobs(due_at,created_at) where state='retry_wait';

create or replace function public.enqueue_whatsapp_automation(p_intent jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare
  v_unit uuid; v_resource uuid; v_kind text; v_customer uuid; v_org uuid; v_resource_unit uuid;
  v_res uuid; v_wait uuid; v_voucher uuid; v_id uuid; v_logical text; v_fact timestamptz; v_expiry timestamptz;
  v_binding public.whatsapp_template_bindings%rowtype; v_template public.whatsapp_remote_templates%rowtype;
  v_channel uuid; v_invalid boolean:=false; v_adopted timestamptz; v_account uuid;
begin
  if jsonb_typeof(p_intent) is distinct from 'object' or (p_intent-array['unit_id','kind','reservation_id','waitlist_id','voucher_id','source_event_key','fact_at','expires_at','due_at','logical_id'])<>'{}'::jsonb then raise exception 'automation_intent_invalid' using errcode='22023'; end if;
  v_unit:=(p_intent->>'unit_id')::uuid; v_kind:=p_intent->>'kind';
  v_res:=(p_intent->>'reservation_id')::uuid; v_wait:=(p_intent->>'waitlist_id')::uuid; v_voucher:=(p_intent->>'voucher_id')::uuid;
  if num_nonnulls(v_res,v_wait,v_voucher)<>1 or v_kind is null or not ((v_kind in('confirmation','reminder_d1','survey_d1') and v_res is not null) or (v_kind in('waitlist_entered','waitlist_feedback') and v_wait is not null) or (v_kind='voucher_issued' and v_voucher is not null)) then raise exception 'automation_intent_invalid' using errcode='22023'; end if;
  select organization_id into v_org from public.units where id=v_unit;
  if v_res is not null then select unit_id,customer_id into v_resource_unit,v_customer from public.reservations where id=v_res;
  elsif v_voucher is not null then select unit_id,customer_id into v_resource_unit,v_customer from public.vouchers where id=v_voucher;
  else
    select w.unit_id,c.id,(w.customer_id is not null and c.id is null) into v_resource_unit,v_customer,v_invalid from public.waitlist w join public.units u on u.id=w.unit_id left join public.customers c on c.organization_id=u.organization_id and c.phone=public.normalize_br_phone(w.customer_phone) and (w.customer_id is null or c.id=w.customer_id) where w.id=v_wait;
  end if;
  if v_org is null or v_resource_unit is distinct from v_unit or coalesce(v_invalid,false) then raise exception 'automation_resource_refused' using errcode='42501'; end if;
  -- Stable resource mutex before parents/job. Source/channel/version are never identity.
  perform pg_advisory_xact_lock(hashtextextended(v_unit::text||':'||v_kind||':'||coalesce(v_res,v_wait,v_voucher)::text,0));
  select id into v_id from public.whatsapp_automation_jobs where unit_id=v_unit and kind=v_kind and (reservation_id=v_res or waitlist_id=v_wait or voucher_id=v_voucher);
  if found then return v_id; end if;
  if exists(select from public.notifications_sent where unit_id=v_unit and kind=v_kind and status in('sent','delivered','read') and ((v_res is not null and reservation_id=v_res) or (v_wait is not null and waitlist_id=v_wait))) then return null; end if;
  -- Legacy vouchers have no resource FK proof. Only current post-adoption
  -- issuance enters the ledger; no prior-notification/customer/day guess is safe.
  if v_customer is not null then
    perform 1 from public.customers where id=v_customer and organization_id=v_org and deleted_at is null for share;
    if not found then raise exception 'automation_resource_refused' using errcode='42501'; end if;
  end if;
  select adopted_at into v_adopted from public.whatsapp_automation_adoptions where unit_id=v_unit;
  select id into v_channel from public.whatsapp_channels c where c.unit_id=v_unit and (c.is_active=true or (c.is_active is null and c.status='connected' and not exists(select from public.whatsapp_channels a where a.unit_id=v_unit and a.is_active=true))) order by c.is_active desc nulls last,c.created_at asc,c.id limit 1;
  select * into v_binding from public.whatsapp_template_bindings where channel_id=v_channel;
  if not found or v_adopted is null or v_binding.adopted_at is null or not v_binding.dispatch_enabled or not exists(select from public.platform_flags where key='whatsapp_automation_dispatch' and value='true'::jsonb) then raise exception 'automation_dispatch_paused' using errcode='P0A01'; end if;
  v_account:=v_binding.account_id;
  if v_account is not null then perform 1 from public.whatsapp_template_accounts where id=v_account for share; end if;
  select * into v_binding from public.whatsapp_template_bindings where id=v_binding.id for share;
  if not found or v_binding.account_id is distinct from v_account then raise exception 'automation_binding_changed' using errcode='P0A04'; end if;
  v_logical:=case v_kind when 'confirmation' then coalesce(p_intent->>'logical_id','res_confirmacao_v1') when 'reminder_d1' then 'res_lembrete_dia_v1' when 'survey_d1' then 'res_pesquisa_reserva_v1' when 'waitlist_entered' then 'fila_entrada_v1' when 'waitlist_feedback' then 'fila_feedback_v1' when 'voucher_issued' then 'mkt_voucher_programado_v1' end;
  if v_kind='confirmation' and v_logical not in('res_confirmacao_v1','res_confirmacao_desconto_v1') then raise exception 'automation_intent_invalid' using errcode='22023'; end if;
  if v_binding.account_id is not null then
    select * into v_template from public.whatsapp_remote_templates where account_id=v_binding.account_id and logical_id=v_logical order by version desc limit 1 for share;
    if not found then raise exception 'automation_template_unavailable' using errcode='P0A02'; end if;
  end if;
  v_fact:=(p_intent->>'fact_at')::timestamptz; v_expiry:=(p_intent->>'expires_at')::timestamptz;
  if v_fact is null or v_expiry is null or not isfinite(v_fact) or not isfinite(v_expiry) or v_expiry<v_fact then raise exception 'automation_fact_invalid' using errcode='22023'; end if;
  insert into public.whatsapp_automation_jobs(unit_id,organization_id,kind,reservation_id,waitlist_id,voucher_id,customer_id,source_event_key,fact_at,expires_at,due_at,channel_id,provider,binding_id,binding_generation,transport,account_id,remote_template_id,template_version,sync_epoch)
  values(v_unit,v_org,v_kind,v_res,v_wait,v_voucher,v_customer,p_intent->>'source_event_key',v_fact,v_expiry,coalesce((p_intent->>'due_at')::timestamptz,clock_timestamp()),v_channel,v_binding.provider,v_binding.id,v_binding.generation,case when v_binding.account_id is null then 'text' else 'template' end,v_binding.account_id,v_template.id,v_template.version,v_template.sync_epoch) returning id into v_id;
  return v_id;
end $$;
revoke all on function public.enqueue_whatsapp_automation(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.enqueue_whatsapp_automation(jsonb) to service_role;

create or replace function public.claim_whatsapp_automation(p_job_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.whatsapp_automation_jobs%rowtype; v_now timestamptz;
begin
  select * into j from public.whatsapp_automation_jobs where id=p_job_id for update;
  if not found then return null; end if;
  v_now:=clock_timestamp();
  if j.state='posting' and j.claimed_until<=v_now then
    update public.whatsapp_automation_jobs set state='uncertain',error_code='post_lease_expired',reconcile_required=true where id=j.id and claim_token=j.claim_token;
    return null;
  end if;
  if j.posting_started_at is not null or j.due_at>v_now or j.attempts>=5 or not (j.state in('queued','retry_wait') or (j.state='claimed' and j.claimed_until<=v_now)) then return null; end if;
  if v_now>j.expires_at then update public.whatsapp_automation_jobs set state='expired',error_code='expired',finished_at=v_now where id=j.id; return null; end if;
  update public.whatsapp_automation_jobs set state='claimed',claim_token=gen_random_uuid(),claimed_until=v_now+interval '90 seconds',error_code=null where id=j.id returning * into j;
  return to_jsonb(j);
end $$;
revoke all on function public.claim_whatsapp_automation(uuid) from public,anon,authenticated,service_role;
grant execute on function public.claim_whatsapp_automation(uuid) to service_role;

create or replace function public.requeue_whatsapp_automation(p_job_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare j public.whatsapp_automation_jobs%rowtype; v_now timestamptz;
begin
  select * into j from public.whatsapp_automation_jobs where id=p_job_id for update;
  if not found then return false; end if;
  v_now:=clock_timestamp();
  if j.state not in('blocked','paused') or j.posting_started_at is not null or j.provider_message_id is not null or j.customer_erased_at is not null or j.expires_at<v_now or j.attempts>=5 then return false; end if;
  update public.whatsapp_automation_jobs set state='queued',claim_token=null,claimed_until=null,error_code=null where id=j.id and state in('blocked','paused') and posting_started_at is null and provider_message_id is null;
  return found;
end $$;
revoke all on function public.requeue_whatsapp_automation(uuid) from public,anon,authenticated,service_role;
grant execute on function public.requeue_whatsapp_automation(uuid) to service_role;

create or replace function public.select_due_whatsapp_automations(p_limit integer)
returns setof public.whatsapp_automation_jobs language sql security definer set search_path='' as $$
  select j.* from public.whatsapp_automation_jobs j where j.due_at<=clock_timestamp() and (j.state in('queued','retry_wait') or (j.state in('claimed','posting') and j.claimed_until<=clock_timestamp())) order by j.due_at,j.created_at,j.id limit greatest(0,least(coalesce(p_limit,20),20))
$$;
revoke all on function public.select_due_whatsapp_automations(integer) from public,anon,authenticated,service_role;
grant execute on function public.select_due_whatsapp_automations(integer) to service_role;

create or replace function public.prepare_whatsapp_automation_post(p_job_id uuid,p_fence uuid,p_generation bigint,p_consent_revision bigint,p_sync_epoch bigint)
returns boolean language plpgsql security definer set search_path='' as $$
declare
  j public.whatsapp_automation_jobs%rowtype; b public.whatsapp_template_bindings%rowtype;
  a public.whatsapp_template_accounts%rowtype; t public.whatsapp_remote_templates%rowtype;
  c public.customers%rowtype; ch public.whatsapp_channels%rowtype;
  v_now timestamptz; v_error text; v_current_customer uuid; v_resource_unit uuid; v_invalid boolean;
  v_revision bigint; v_decision text; v_selected uuid;
begin
  select * into j from public.whatsapp_automation_jobs where id=p_job_id;
  if not found then return false; end if;
  -- Unlocked identity read followed by the agreed parent order. No earlier lock
  -- is acquired after owning the job; claim/finish lock only the job.
  if j.customer_id is not null then select * into c from public.customers where id=j.customer_id for update; end if;
  if j.account_id is not null then select * into a from public.whatsapp_template_accounts where id=j.account_id for share; end if;
  select * into b from public.whatsapp_template_bindings where id=j.binding_id for share;
  select * into ch from public.whatsapp_channels where id=j.channel_id for share;
  if j.remote_template_id is not null then select * into t from public.whatsapp_remote_templates where id=j.remote_template_id for update; end if;
  select revision,decision into v_revision,v_decision from public.whatsapp_message_consent_events where unit_id=j.unit_id and customer_id=j.customer_id and purpose='operational' order by revision desc limit 1 for share;
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
  elsif j.kind in('waitlist_feedback','voucher_issued') then v_error:='promotional_protections_unavailable';
  elsif v_decision='opt_out' or p_consent_revision is distinct from v_revision then v_error:='consent_changed';
  elsif j.safe_log_body is null then v_error:='render_missing';
  elsif j.transport='template' and (a.id is null or a.organization_id<>j.organization_id or a.verified_at is null or b.verified_at is null or t.id is null or t.account_id<>j.account_id or t.version<>j.template_version or t.binding_generation<>a.binding_generation or t.sync_required or t.local_status<>'usable' or t.remote_status<>'APPROVED' or t.language<>'pt_BR' or t.remote_id is null or t.observed_hash is distinct from t.desired_hash or t.effective_category is distinct from t.requested_category or (t.requested_category='MARKETING' and t.quality='RED') or t.last_synced_at is null or t.last_synced_at<v_now-interval '60 seconds' or p_sync_epoch is distinct from t.sync_epoch) then v_error:='template_unavailable';
  elsif j.transport='text' and p_sync_epoch is not null then v_error:='template_unavailable';
  end if;
  if v_error is not null then
    update public.whatsapp_automation_jobs set state=case when v_error in('binding_changed','recipient_changed') then 'needs_review' when v_error='dispatch_paused' then 'paused' when v_error='expired' then 'expired' else 'blocked' end,error_code=v_error where id=j.id and claim_token=p_fence;
    return false;
  end if;
  update public.whatsapp_automation_jobs set state='posting',posting_started_at=v_now,claimed_until=v_now+interval '90 seconds',attempts=attempts+1,sync_epoch=case when transport='template' then t.sync_epoch else null end,consent_revision=v_revision,error_code=null where id=j.id and claim_token=p_fence and state='claimed';
  return found;
end $$;
revoke all on function public.prepare_whatsapp_automation_post(uuid,uuid,bigint,bigint,bigint) from public,anon,authenticated,service_role;
grant execute on function public.prepare_whatsapp_automation_post(uuid,uuid,bigint,bigint,bigint) to service_role;

create or replace function public.finish_whatsapp_automation(p_job_id uuid,p_fence uuid,p_result jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare j public.whatsapp_automation_jobs%rowtype; v_outcome text:=p_result->>'outcome'; v_reason text:=p_result->>'reason'; v_id text:=p_result->>'provider_message_id'; v_now timestamptz; v_wait integer;
begin
  if jsonb_typeof(p_result) is distinct from 'object' or (p_result-array['outcome','reason','provider_message_id','retry_after_seconds'])<>'{}'::jsonb or v_outcome is null or v_reason is null or not ((v_outcome='accepted' and v_reason='provider_accepted') or (v_outcome='uncertain' and v_reason in('response_invalid','post_ambiguous','post_lease_expired')) or (v_outcome='rejected' and v_reason in('documented_preproxy_429','provider_rejected','auth_rejected','template_rejected'))) then raise exception 'automation_result_invalid' using errcode='22023'; end if;
  if v_outcome='accepted' and (jsonb_typeof(p_result->'provider_message_id') is distinct from 'string' or v_id is null or char_length(v_id) not between 1 and 512 or v_id ~ '[[:cntrl:]]') then raise exception 'automation_result_invalid' using errcode='22023'; end if;
  if v_outcome<>'accepted' and v_id is not null then raise exception 'automation_result_invalid' using errcode='22023'; end if;
  select * into j from public.whatsapp_automation_jobs where id=p_job_id for update;
  if not found or j.claim_token is distinct from p_fence or j.posting_started_at is null then return false; end if;
  v_now:=clock_timestamp();
  if j.state in('accepted','reconciled') then return v_outcome='accepted' and j.provider_message_id=v_id; end if;
  if j.state not in('posting','uncertain') then return false; end if;
  if v_outcome='accepted' then
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
  return true;
end $$;
revoke all on function public.finish_whatsapp_automation(uuid,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.finish_whatsapp_automation(uuid,uuid,jsonb) to service_role;

create or replace function public.enqueue_whatsapp_template_job(p_binding_id uuid,p_operation text,p_target_key text,p_revision bigint)
returns uuid language plpgsql security definer set search_path='' as $$
declare b public.whatsapp_template_bindings%rowtype; v_id uuid; v_org uuid; v_account uuid;
begin
  select * into b from public.whatsapp_template_bindings where id=p_binding_id;
  if not found or b.account_id is null then raise exception 'template_binding_refused' using errcode='42501'; end if;
  v_account:=b.account_id;
  select organization_id into v_org from public.whatsapp_template_accounts where id=v_account for share;
  select * into b from public.whatsapp_template_bindings where id=p_binding_id for share;
  if not found or b.account_id is distinct from v_account then raise exception 'template_binding_refused' using errcode='42501'; end if;
  if p_operation='provision' and (b.submission_authorized_at is null or not exists(select from public.platform_flags where key='whatsapp_template_catalog' and value='true'::jsonb)) then raise exception 'template_submission_paused' using errcode='P0A03'; end if;
  insert into public.whatsapp_template_jobs(organization_id,account_id,binding_id,binding_generation,operation,target_key,revision)
  values(v_org,b.account_id,b.id,b.generation,p_operation,p_target_key,p_revision) on conflict(account_id,operation,target_key,revision) do nothing returning id into v_id;
  if v_id is null then select id into v_id from public.whatsapp_template_jobs where account_id=b.account_id and operation=p_operation and target_key=p_target_key and revision=p_revision; end if;
  return v_id;
end $$;
revoke all on function public.enqueue_whatsapp_template_job(uuid,text,text,bigint) from public,anon,authenticated,service_role;
grant execute on function public.enqueue_whatsapp_template_job(uuid,text,text,bigint) to service_role;

create or replace function public.claim_whatsapp_template_job(p_job_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.whatsapp_template_jobs%rowtype; v_now timestamptz;
begin
  select * into j from public.whatsapp_template_jobs where id=p_job_id for update;
  if not found then return null; end if;
  v_now:=clock_timestamp();
  if j.state='posting' and j.claimed_until<=v_now then update public.whatsapp_template_jobs set state='uncertain',provider_outcome='uncertain',error_code='post_lease_expired' where id=j.id and claim_token=j.claim_token; return null; end if;
  if j.posting_started_at is not null or j.due_at>v_now or j.attempts>=5 or not (j.state='queued' or (j.state='claimed' and j.claimed_until<=v_now)) then return null; end if;
  update public.whatsapp_template_jobs set state='claimed',claim_token=gen_random_uuid(),claimed_until=v_now+interval '90 seconds',error_code=null where id=j.id returning * into j;
  return to_jsonb(j);
end $$;
revoke all on function public.claim_whatsapp_template_job(uuid) from public,anon,authenticated,service_role;
grant execute on function public.claim_whatsapp_template_job(uuid) to service_role;

create or replace function public.prepare_whatsapp_template_provision(p_job_id uuid,p_fence uuid,p_generation bigint)
returns boolean language plpgsql security definer set search_path='' as $$
declare j public.whatsapp_template_jobs%rowtype; b public.whatsapp_template_bindings%rowtype; a public.whatsapp_template_accounts%rowtype; c public.whatsapp_channels%rowtype; v_now timestamptz;
begin
  select * into j from public.whatsapp_template_jobs where id=p_job_id;
  if not found then return false; end if;
  select * into a from public.whatsapp_template_accounts where id=j.account_id for share;
  select * into b from public.whatsapp_template_bindings where id=j.binding_id for share;
  select * into c from public.whatsapp_channels where id=b.channel_id for share;
  select * into j from public.whatsapp_template_jobs where id=p_job_id for update;
  v_now:=clock_timestamp();
  if j.state<>'claimed' or j.claim_token is distinct from p_fence or j.claimed_until<=v_now or j.posting_started_at is not null then return false; end if;
  if j.operation<>'provision' or b.id is null or a.id is null or (b.account_id,b.generation) is distinct from (j.account_id,j.binding_generation) or p_generation is distinct from b.generation or b.verified_at is null then
    update public.whatsapp_template_jobs set state='needs_review',error_code='binding_changed' where id=j.id and claim_token=p_fence; return false;
  end if;
  if b.submission_authorized_at is null or not exists(select from public.platform_flags where key='whatsapp_template_catalog' and value='true'::jsonb) or c.status<>'connected' or c.last_health_check_at is null or c.last_health_check_at<v_now-interval '5 minutes' then
    update public.whatsapp_template_jobs set state='paused',error_code='submission_paused' where id=j.id and claim_token=p_fence; return false;
  end if;
  update public.whatsapp_template_jobs set state='posting',posting_started_at=v_now,claimed_until=v_now+interval '90 seconds',attempts=attempts+1 where id=j.id and claim_token=p_fence;
  return true;
end $$;
revoke all on function public.prepare_whatsapp_template_provision(uuid,uuid,bigint) from public,anon,authenticated,service_role;
grant execute on function public.prepare_whatsapp_template_provision(uuid,uuid,bigint) to service_role;

create or replace function public.finish_whatsapp_template_job(p_job_id uuid,p_fence uuid,p_result jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare j public.whatsapp_template_jobs%rowtype; v_outcome text:=p_result->>'outcome'; v_reason text:=p_result->>'reason'; v_now timestamptz; v_provider text; v_wait integer;
begin
  if jsonb_typeof(p_result) is distinct from 'object' or (p_result-array['outcome','reason','retry_after_seconds'])<>'{}'::jsonb or v_outcome is null or v_reason is null or not ((v_outcome='accepted' and v_reason='provider_accepted') or (v_outcome='uncertain' and v_reason in('post_ambiguous','response_invalid','post_lease_expired')) or (v_outcome='rejected' and v_reason in('documented_preproxy_429','provider_rejected','auth_rejected','template_rejected'))) then raise exception 'template_result_invalid' using errcode='22023'; end if;
  -- No earlier locks after job. Provider read is informational, never FOR SHARE.
  select b.provider into v_provider from public.whatsapp_template_bindings b join public.whatsapp_template_jobs tj on tj.binding_id=b.id and tj.binding_generation=b.generation where tj.id=p_job_id;
  select * into j from public.whatsapp_template_jobs where id=p_job_id for update;
  if not found or j.claim_token is distinct from p_fence then return false; end if;
  v_now:=clock_timestamp();
  if j.operation in('sync','reconcile') and j.state='claimed' and j.claimed_until>v_now and v_outcome='accepted' then update public.whatsapp_template_jobs set state='done',finished_at=v_now,error_code=null where id=j.id and claim_token=p_fence; return true; end if;
  if j.state='accepted' then return v_outcome='accepted'; end if;
  if j.posting_started_at is null or j.state not in('posting','uncertain') then return false; end if;
  if v_outcome='accepted' then update public.whatsapp_template_jobs set state='accepted',provider_outcome='accepted',finished_at=v_now,error_code=null where id=j.id and claim_token=p_fence;
  elsif v_outcome='uncertain' then update public.whatsapp_template_jobs set state='uncertain',provider_outcome='uncertain',error_code=v_reason where id=j.id and claim_token=p_fence;
  elsif j.state='uncertain' then return false;
  elsif v_reason='documented_preproxy_429' and v_provider='datafy' and j.attempts<5 then
    v_wait:=coalesce((p_result->>'retry_after_seconds')::integer,0);
    if v_wait<0 or v_wait>86400 then raise exception 'template_result_invalid' using errcode='22023'; end if;
    insert into app_private.whatsapp_post_reset_permits values(txid_current(),'whatsapp_template_jobs',j.id,p_fence,j.attempts,j.posting_started_at);
    update public.whatsapp_template_jobs set state='queued',posting_started_at=null,provider_outcome='rejected',due_at=v_now+make_interval(secs=>greatest(60*power(4,j.attempts-1)::integer,v_wait)),error_code=v_reason where id=j.id and claim_token=p_fence;
  else update public.whatsapp_template_jobs set state='rejected',provider_outcome='rejected',finished_at=v_now,error_code=v_reason where id=j.id and claim_token=p_fence;
  end if;
  return true;
end $$;
revoke all on function public.finish_whatsapp_template_job(uuid,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.finish_whatsapp_template_job(uuid,uuid,jsonb) to service_role;

create or replace function public.begin_whatsapp_template_sync(p_account_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_generation bigint; v_epochs jsonb;
begin
  select binding_generation into v_generation from public.whatsapp_template_accounts where id=p_account_id for update;
  if not found then raise exception 'template_account_refused' using errcode='42501'; end if;
  perform 1 from public.whatsapp_remote_templates where account_id=p_account_id order by id for update;
  update public.whatsapp_remote_templates set sync_epoch=sync_epoch+1,sync_required=true where account_id=p_account_id;
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'epoch',sync_epoch) order by id),'[]'::jsonb) into v_epochs from public.whatsapp_remote_templates where account_id=p_account_id;
  return jsonb_build_object('account_generation',v_generation,'templates',v_epochs);
end $$;
revoke all on function public.begin_whatsapp_template_sync(uuid) from public,anon,authenticated,service_role;
grant execute on function public.begin_whatsapp_template_sync(uuid) to service_role;

create or replace function public.publish_whatsapp_template_sync(p_account_id uuid,p_account_generation bigint,p_epochs jsonb,p_snapshot jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare a public.whatsapp_template_accounts%rowtype; t public.whatsapp_remote_templates%rowtype; s jsonb; v_count integer; v_now timestamptz; v_quality text; v_usable boolean;
begin
  if jsonb_typeof(p_epochs) is distinct from 'array' or jsonb_typeof(p_snapshot) is distinct from 'array' or jsonb_array_length(p_epochs)>1000 or jsonb_array_length(p_snapshot)>1000 then raise exception 'template_snapshot_invalid' using errcode='22023'; end if;
  select * into a from public.whatsapp_template_accounts where id=p_account_id for update;
  if not found or a.binding_generation is distinct from p_account_generation then return false; end if;
  perform 1 from public.whatsapp_remote_templates where account_id=p_account_id order by id for update;
  select count(*) into v_count from public.whatsapp_remote_templates where account_id=p_account_id;
  -- Complete captured set, no omissions, duplicates or newly introduced rows.
  if jsonb_array_length(p_epochs)<>v_count or jsonb_array_length(p_snapshot)<>v_count or
    (select count(distinct x->>'id') from jsonb_array_elements(p_epochs) x)<>v_count or
    (select count(distinct x->>'id') from jsonb_array_elements(p_snapshot) x)<>v_count or
    exists(select from jsonb_array_elements(p_epochs) x left join public.whatsapp_remote_templates r on r.id=(x->>'id')::uuid and r.account_id=p_account_id where r.id is null or r.sync_epoch is distinct from (x->>'epoch')::bigint) or
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
  return true;
end $$;
revoke all on function public.publish_whatsapp_template_sync(uuid,bigint,jsonb,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.publish_whatsapp_template_sync(uuid,bigint,jsonb,jsonb) to service_role;

create or replace function public.record_whatsapp_template_events(p_account_id uuid,p_events jsonb)
returns integer language plpgsql security definer set search_path='' as $$
declare e jsonb; v_inserted integer; v_count integer:=0; v_org uuid; v_binding uuid; v_revision bigint; v_job uuid;
begin
  if jsonb_typeof(p_events) is distinct from 'array' or jsonb_array_length(p_events) not between 1 and 100 then raise exception 'template_events_invalid' using errcode='22023'; end if;
  select organization_id into v_org from public.whatsapp_template_accounts where id=p_account_id for update;
  if not found then raise exception 'template_account_refused' using errcode='42501'; end if;
  -- Account is exclusive: all prepare/sync operations take it before binding/template.
  select id into v_binding from public.whatsapp_template_bindings where account_id=p_account_id order by id limit 1 for share;
  if not found then raise exception 'template_binding_refused' using errcode='42501'; end if;
  perform 1 from public.whatsapp_remote_templates where account_id=p_account_id order by id for update;
  for e in select value from jsonb_array_elements(p_events) loop
    if jsonb_typeof(e) is distinct from 'object' or (e-array['field','remote_id','name','language','event_time','digest','remote_status','quality','effective_category'])<>'{}'::jsonb then raise exception 'template_events_invalid' using errcode='22023'; end if;
    insert into public.whatsapp_template_events(account_id,field,remote_id,name,language,event_time,digest,remote_status,quality,effective_category,processing_state,processed_at)
    values(p_account_id,e->>'field',e->>'remote_id',e->>'name',e->>'language',(e->>'event_time')::timestamptz,e->>'digest',e->>'remote_status',e->>'quality',e->>'effective_category','processed',clock_timestamp()) on conflict(account_id,digest) do nothing;
    get diagnostics v_inserted=row_count;
    if v_inserted=0 then continue; end if;
    v_count:=v_count+1;
    -- Any new event, including positive/unknown external identity, fences GET.
    -- Only restrictive facts may be applied here; no callback ever releases.
    update public.whatsapp_remote_templates set sync_epoch=sync_epoch+1,sync_required=true,
      remote_status=case when ((e->>'remote_id'=remote_id) or (e->>'name'=name and coalesce(e->>'language',language)=language)) and e->>'remote_status' in('REJECTED','PAUSED','DISABLED','DELETED','PENDING_DELETION') then e->>'remote_status' else remote_status end,
      quality=case when ((e->>'remote_id'=remote_id) or (e->>'name'=name and coalesce(e->>'language',language)=language)) and e->>'quality'='RED' then 'RED' else quality end,
      effective_category=case when ((e->>'remote_id'=remote_id) or (e->>'name'=name and coalesce(e->>'language',language)=language)) and e->>'effective_category' is not null and e->>'effective_category' is distinct from requested_category then e->>'effective_category' else effective_category end,
      local_status=case when ((e->>'remote_id'=remote_id) or (e->>'name'=name and coalesce(e->>'language',language)=language)) and ((e->>'quality'='RED' and requested_category='MARKETING') or e->>'remote_status'='PAUSED') then 'paused' when ((e->>'remote_id'=remote_id) or (e->>'name'=name and coalesce(e->>'language',language)=language)) and e->>'remote_status'='REJECTED' then 'rejected' when ((e->>'remote_id'=remote_id) or (e->>'name'=name and coalesce(e->>'language',language)=language)) and e->>'remote_status' in('DISABLED','DELETED','PENDING_DELETION') then 'disabled' else local_status end where account_id=p_account_id;
  end loop;
  if v_count>0 then
    update public.whatsapp_template_accounts set reconciliation_revision=reconciliation_revision+v_count where id=p_account_id returning reconciliation_revision into v_revision;
    v_job:=public.enqueue_whatsapp_template_job(v_binding,'sync','account',v_revision);
  end if;
  return v_count;
end $$;
revoke all on function public.record_whatsapp_template_events(uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.record_whatsapp_template_events(uuid,jsonb) to service_role;

-- Preserve every Task3 scope invariant; the only new exception consumes a transaction permit.
create or replace function public.guard_whatsapp_template_scope()
returns trigger language plpgsql security definer set search_path='' as $$
declare
  v_org uuid; v_customer_org uuid; v_deleted timestamptz;
  v_binding public.whatsapp_template_bindings%rowtype;
  v_channel public.whatsapp_channels%rowtype;
  v_remote public.whatsapp_remote_templates%rowtype;
  v_job public.whatsapp_automation_jobs%rowtype;
  v_resource_unit uuid; v_resource_customer uuid; v_resource_invalid boolean:=false; v_reset boolean:=false;
begin
  -- Existing intents are historical evidence: only INSERT checks mutable parents.
  -- State/fence reconciliation must survive a deleted/changed binding or customer.
  if tg_op='UPDATE' and tg_table_name='whatsapp_automation_jobs' then
    if (new.id,new.unit_id,new.organization_id,new.kind,new.reservation_id,new.waitlist_id,new.voucher_id,new.source_event_key,new.fact_at,new.expires_at,new.channel_id,new.provider,new.binding_id,new.binding_generation,new.transport,new.account_id,new.remote_template_id,new.template_version,new.notification_id) is distinct from (old.id,old.unit_id,old.organization_id,old.kind,old.reservation_id,old.waitlist_id,old.voucher_id,old.source_event_key,old.fact_at,old.expires_at,old.channel_id,old.provider,old.binding_id,old.binding_generation,old.transport,old.account_id,old.remote_template_id,old.template_version,old.notification_id) then raise exception 'automation_intent_immutable' using errcode='23514'; end if;
    if old.posting_started_at is not null and new.posting_started_at is distinct from old.posting_started_at then
      v_reset:=new.posting_started_at is null and new.state='retry_wait' and old.state='posting' and old.provider='datafy' and old.provider_message_id is null and new.provider_message_id is null and new.claim_token=old.claim_token and new.attempts=old.attempts and app_private.consume_whatsapp_post_reset(tg_table_name,old.id,old.claim_token,old.attempts,old.posting_started_at);
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
    if old.posting_started_at is not null and not v_reset and new.safe_log_body is distinct from old.safe_log_body then raise exception 'automation_render_immutable' using errcode='23514'; end if;
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
    if tg_op='UPDATE' and (new.id,new.unit_id,new.customer_id,new.job_id,new.created_at) is distinct from (old.id,old.unit_id,old.customer_id,old.job_id,old.created_at) then raise exception 'promotion_slot_identity_immutable' using errcode='23514'; end if;
  elsif tg_table_name='whatsapp_automation_receipt_events' then
    select * into v_channel from public.whatsapp_channels where id=new.channel_id for share;
    if not found or (v_channel.unit_id,v_channel.provider) is distinct from (new.unit_id,new.provider) then raise exception 'template_channel_mismatch' using errcode='23514'; end if;
  end if;
  return new;
end $$;
revoke all on function public.guard_whatsapp_template_scope() from public,anon,authenticated,service_role;


notify pgrst,'reload schema';
commit;
