-- Same ledger prerequisites; no dispatcher, producer or public initializer.
begin;
alter table public.whatsapp_automation_jobs
  add column if not exists pin_phase text not null default 'bound',
  add column if not exists initial_credential_revision bigint,
  add column if not exists initial_catalog_key text;
alter table public.whatsapp_automation_jobs
  alter column channel_id drop not null, alter column provider drop not null,
  alter column binding_id drop not null, alter column binding_generation drop not null,
  alter column transport drop not null;

-- Locate the historical compound transport check by relation, columns and
-- expression; never depend on PostgreSQL's unnamed-constraint numbering.
do $$ declare names text[]; begin
  if not exists(select from pg_constraint where conrelid='public.whatsapp_automation_jobs'::regclass and conname='whatsapp_automation_pin_tuple_check') then
    select array_agg(c.conname) into names from pg_constraint c
    where c.conrelid='public.whatsapp_automation_jobs'::regclass and c.contype='c'
      and (select attnum from pg_attribute where attrelid=c.conrelid and attname='transport')=any(c.conkey)
      and (select attnum from pg_attribute where attrelid=c.conrelid and attname='remote_template_id')=any(c.conkey)
      and pg_get_constraintdef(c.oid) like '%num_nonnulls%';
    if coalesce(cardinality(names),0)<>1 then raise exception 'automation_transport_constraint_ambiguous'; end if;
    execute format('alter table public.whatsapp_automation_jobs drop constraint %I',names[1]);
  end if;
end $$;
alter table public.whatsapp_automation_jobs drop constraint if exists whatsapp_automation_pin_tuple_check;
alter table public.whatsapp_automation_jobs add constraint whatsapp_automation_pin_tuple_check check ((
  (initial_credential_revision is null or initial_credential_revision>=0)
  and (initial_catalog_key is null or initial_catalog_key in('res_confirmacao_v1','res_confirmacao_desconto_v1','res_lembrete_dia_v1','res_pesquisa_reserva_v1','fila_entrada_v1','fila_feedback_v1','mkt_voucher_programado_v1'))
  and (
    (pin_phase='bound' and channel_id is not null and provider is not null and binding_id is not null and binding_generation is not null and binding_generation>0 and transport is not null and (
      (transport='template' and provider in('official','datafy') and account_id is not null and remote_template_id is not null and template_version is not null and sync_epoch is not null)
      or (transport='text' and provider in('zapi','waha','uazapi') and num_nonnulls(account_id,remote_template_id,template_version,sync_epoch)=0)))
    or (pin_phase='preconfiguration' and initial_catalog_key is not null and remote_template_id is null and template_version is null and sync_epoch is null and (
      (num_nonnulls(channel_id,provider,transport,binding_id,binding_generation,account_id,initial_credential_revision)=0)
      or (channel_id is not null and provider is not null and transport is not null and initial_credential_revision is not null and binding_id is null and binding_generation is null and account_id is null and (
        (provider in('official','datafy') and transport='template') or (provider in('zapi','waha','uazapi') and transport='text')))
      or (channel_id is not null and provider in('official','datafy') and transport='template' and binding_id is not null and binding_generation is not null and binding_generation>0 and account_id is not null and initial_credential_revision is not null))))
) is true);
alter table public.whatsapp_automation_jobs drop constraint if exists whatsapp_automation_preconfiguration_check;
alter table public.whatsapp_automation_jobs add constraint whatsapp_automation_preconfiguration_check check ((pin_phase<>'preconfiguration' or (
  state in('blocked','paused','needs_review','expired') and attempts=0
  and num_nonnulls(claim_token,claimed_until,posting_started_at,provider_message_id,safe_log_body,consent_revision,cost_authorization_id,sync_epoch)=0
  and reconcile_required=false)) is true);

do $$ begin
  if to_regtype('app_private.whatsapp_automation_pin_tuple') is null then
    create type app_private.whatsapp_automation_pin_tuple as (
      pin_phase text,channel_id uuid,provider text,binding_id uuid,binding_generation bigint,transport text,
      account_id uuid,remote_template_id uuid,template_version integer,sync_epoch bigint,
      initial_credential_revision bigint,initial_catalog_key text);
  end if;
end $$;
revoke all on type app_private.whatsapp_automation_pin_tuple from public,anon,authenticated,service_role;
create table if not exists app_private.whatsapp_automation_pin_initialization_permits (
  transaction_id bigint not null,actor_id uuid not null,job_id uuid not null,
  old_pins app_private.whatsapp_automation_pin_tuple not null,
  new_pins app_private.whatsapp_automation_pin_tuple not null,
  primary key(transaction_id,job_id));
alter table app_private.whatsapp_automation_pin_initialization_permits enable row level security;
alter table app_private.whatsapp_automation_pin_initialization_permits force row level security;
revoke all on table app_private.whatsapp_automation_pin_initialization_permits from public,anon,authenticated,service_role;
create or replace function app_private.consume_whatsapp_automation_pin_initialization(
  p_job_id uuid,p_old_pins app_private.whatsapp_automation_pin_tuple,p_new_pins app_private.whatsapp_automation_pin_tuple)
returns boolean language plpgsql security definer set search_path='' as $$
declare n integer; begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null or not app_private.is_platform_admin(auth.uid())
    or p_old_pins.pin_phase is distinct from 'preconfiguration' or p_new_pins.pin_phase is distinct from 'bound' then return false; end if;
  delete from app_private.whatsapp_automation_pin_initialization_permits
  where transaction_id=txid_current() and actor_id=auth.uid() and job_id=p_job_id
    and old_pins is not distinct from p_old_pins and new_pins is not distinct from p_new_pins;
  get diagnostics n=row_count;
  return n=1;
end $$;
revoke all on function app_private.consume_whatsapp_automation_pin_initialization(uuid,app_private.whatsapp_automation_pin_tuple,app_private.whatsapp_automation_pin_tuple) from public,anon,authenticated,service_role;

create or replace function public.enqueue_whatsapp_automation(p_intent jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare
  v_unit uuid; v_kind text; v_customer uuid; v_org uuid; v_resource_unit uuid;
  v_res uuid; v_wait uuid; v_voucher uuid; v_id uuid; v_logical text; v_fact timestamptz; v_expiry timestamptz;
  b public.whatsapp_template_bindings%rowtype; t public.whatsapp_remote_templates%rowtype;
  ch public.whatsapp_channels%rowtype; v_channel uuid; v_selected uuid; v_invalid boolean:=false; v_account uuid;
  v_flag jsonb; v_phase text:='bound'; v_state text:='queued'; v_error text; v_transport text;
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
  if not exists(select from public.whatsapp_automation_adoptions where unit_id=v_unit) then raise exception 'automation_adoption_required' using errcode='P0A01'; end if;
  select value into v_flag from public.platform_flags where key='whatsapp_automation_dispatch';
  if found and jsonb_typeof(v_flag) is distinct from 'boolean' then raise exception 'automation_dependency_unavailable' using errcode='PT503'; end if;
  v_logical:=case v_kind when 'confirmation' then case when (select applied_discount_percent>0 from public.reservations where id=v_res) then 'res_confirmacao_desconto_v1' else 'res_confirmacao_v1' end when 'reminder_d1' then 'res_lembrete_dia_v1' when 'survey_d1' then 'res_pesquisa_reserva_v1' when 'waitlist_entered' then 'fila_entrada_v1' when 'waitlist_feedback' then 'fila_feedback_v1' when 'voucher_issued' then 'mkt_voucher_programado_v1' end;
  if p_intent ? 'logical_id' and p_intent->>'logical_id' is distinct from v_logical then raise exception 'automation_intent_invalid' using errcode='22023'; end if;
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
  if v_account is not null then select * into t from public.whatsapp_remote_templates where account_id=v_account and logical_id=v_logical and version=1 and language='pt_BR' for share; end if;
  if v_channel is null then v_phase:='preconfiguration'; v_state:='blocked'; v_error:='channel_unconfigured';
  elsif b.id is null then v_phase:='preconfiguration'; v_state:='blocked'; v_error:='binding_unconfigured';
  elsif v_transport='template' and t.id is null then v_phase:='preconfiguration'; v_state:='blocked'; v_error:='template_unconfigured';
  end if;
  if b.id is not null and b.channel_credential_revision is distinct from ch.template_credential_revision then v_state:='needs_review'; v_error:='binding_changed';
  elsif v_phase='bound' and (v_flag is distinct from 'true'::jsonb or not b.dispatch_enabled or b.adopted_at is null) then v_state:='paused'; v_error:='dispatch_paused';
  elsif v_phase='bound' and (ch.status<>'connected' or ch.last_health_check_at is null or ch.last_health_check_at<clock_timestamp()-interval '5 minutes') then v_state:='blocked'; v_error:='channel_unavailable';
  elsif v_phase='bound' and v_transport='template' and (b.verified_at is null or t.sync_required or t.local_status<>'usable' or t.remote_status<>'APPROVED' or t.last_synced_at is null or t.last_synced_at<clock_timestamp()-interval '60 seconds') then v_state:='blocked'; v_error:='template_unavailable';
  end if;
  insert into public.whatsapp_automation_jobs(unit_id,organization_id,kind,reservation_id,waitlist_id,voucher_id,customer_id,source_event_key,fact_at,expires_at,due_at,channel_id,provider,binding_id,binding_generation,transport,account_id,remote_template_id,template_version,sync_epoch,pin_phase,initial_credential_revision,initial_catalog_key,state,error_code)
  values(v_unit,v_org,v_kind,v_res,v_wait,v_voucher,v_customer,p_intent->>'source_event_key',v_fact,v_expiry,coalesce((p_intent->>'due_at')::timestamptz,clock_timestamp()),v_channel,ch.provider,b.id,b.generation,v_transport,v_account,t.id,t.version,t.sync_epoch,v_phase,ch.template_credential_revision,v_logical,v_state,v_error) returning id into v_id;
  return v_id;
end $$;
revoke all on function public.enqueue_whatsapp_automation(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.enqueue_whatsapp_automation(jsonb) to service_role;

create or replace function public.claim_whatsapp_automation(p_job_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.whatsapp_automation_jobs%rowtype; v_now timestamptz;
begin
  select * into j from public.whatsapp_automation_jobs where id=p_job_id for update;
  if not found or j.pin_phase<>'bound' then return null; end if;
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
  if not found or j.pin_phase<>'bound' then return false; end if;
  v_now:=clock_timestamp();
  if j.state not in('blocked','paused') or j.posting_started_at is not null or j.provider_message_id is not null or j.customer_erased_at is not null or j.expires_at<v_now or j.attempts>=5 then return false; end if;
  update public.whatsapp_automation_jobs set state='queued',claim_token=null,claimed_until=null,error_code=null where id=j.id and state in('blocked','paused') and posting_started_at is null and provider_message_id is null;
  return found;
end $$;
revoke all on function public.requeue_whatsapp_automation(uuid) from public,anon,authenticated,service_role;
grant execute on function public.requeue_whatsapp_automation(uuid) to service_role;

create or replace function public.select_due_whatsapp_automations(p_limit integer)
returns setof public.whatsapp_automation_jobs language sql security definer set search_path='' as $$
  select j.* from public.whatsapp_automation_jobs j where j.pin_phase='bound' and j.due_at<=clock_timestamp() and (j.state in('queued','retry_wait') or (j.state in('claimed','posting') and j.claimed_until<=clock_timestamp())) order by j.due_at,j.created_at,j.id limit greatest(0,least(coalesce(p_limit,20),20))
$$;
revoke all on function public.select_due_whatsapp_automations(integer) from public,anon,authenticated,service_role;
grant execute on function public.select_due_whatsapp_automations(integer) to service_role;

create or replace function public.block_whatsapp_automation_preflight(p_job_id uuid,p_fence uuid,p_reason text)
returns boolean language plpgsql security definer set search_path='' as $$
declare j public.whatsapp_automation_jobs%rowtype; v_now timestamptz; v_reason text; begin
  if p_reason is null or p_reason not in('reservation_pending','payment_incompatible','reservation_not_confirmed','reservation_changed','reservation_past','reservation_wrong_day','survey_already_answered','waitlist_not_waiting','waitlist_not_seated','waitlist_wrong_day','waitlist_changed','voucher_not_active','voucher_expired','voucher_changed','customer_not_alive','recipient_changed','do_not_contact','invalid_timezone','service_suspended','channel_unavailable','channel_changed','binding_changed','dispatch_paused','consent_changed','cost_not_authorized','template_unavailable','template_sync_failed','render_invalid','dependency_unavailable','expired') then raise exception 'automation_preflight_reason_invalid' using errcode='22023'; end if;
  select * into j from public.whatsapp_automation_jobs where id=p_job_id for update;
  v_now:=clock_timestamp();
  if not found or j.pin_phase<>'bound' or j.state<>'claimed' or p_fence is null or j.claim_token is distinct from p_fence or j.claimed_until is null or j.claimed_until<=v_now or j.posting_started_at is not null or j.provider_message_id is not null or j.customer_erased_at is not null then return false; end if;
  v_reason:=case when v_now>j.expires_at then 'expired' else p_reason end;
  update public.whatsapp_automation_jobs set
    state=case when v_reason='expired' then 'expired' when v_reason='dispatch_paused' then 'paused' when v_reason in('reservation_changed','waitlist_changed','voucher_changed','recipient_changed','channel_changed','binding_changed') then 'needs_review' else 'blocked' end,
    error_code=v_reason,claim_token=null,claimed_until=null,safe_log_body=null
  where id=j.id;
  return true;
end $$;
revoke all on function public.block_whatsapp_automation_preflight(uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.block_whatsapp_automation_preflight(uuid,uuid,text) to service_role;

-- Both wrappers share parent locks and eligibility; mode is never caller authority.
-- initial_credential_revision is historical. Task13 may explicitly revalidate a
-- bound identity; only effective binding generation/current verified revision fence POST.
create or replace function app_private.whatsapp_automation_post_core(p_job_id uuid,p_fence uuid,p_generation bigint,p_consent_revision bigint,p_sync_epoch bigint,p_confirm_only boolean)
returns boolean language plpgsql security definer set search_path='' as $$
declare
  j public.whatsapp_automation_jobs%rowtype; b public.whatsapp_template_bindings%rowtype; gb public.whatsapp_template_bindings%rowtype;
  a public.whatsapp_template_accounts%rowtype; t public.whatsapp_remote_templates%rowtype;
  c public.customers%rowtype; ch public.whatsapp_channels%rowtype; gc public.whatsapp_channels%rowtype;
  ca public.whatsapp_template_cost_authorizations%rowtype; s public.whatsapp_promotion_slots%rowtype;
  v_now timestamptz; v_error text; v_current_customer uuid; v_resource_unit uuid; v_invalid boolean;
  v_revision bigint; v_decision text; v_selected uuid; v_days integer; v_flag jsonb; v_logical text;
begin
  select * into j from public.whatsapp_automation_jobs where id=p_job_id;
  if not found or j.pin_phase<>'bound' or p_fence is null or p_confirm_only is null then return false; end if;
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
        select * into ca from public.whatsapp_template_cost_authorizations x where x.account_id=j.account_id and x.binding_id=j.binding_id and x.binding_generation=j.binding_generation and x.category='MARKETING' and x.valid_from<=clock_timestamp() and x.valid_until>clock_timestamp() and exists(select from public.platform_admins where user_id=x.actor_id) order by x.valid_until desc,x.id limit 1 for share;
      end if;
    end if;
  end if;
  select * into j from public.whatsapp_automation_jobs where id=p_job_id for update;
  v_now:=clock_timestamp();
  if not found or j.pin_phase<>'bound' or j.claim_token is distinct from p_fence or j.claimed_until is null or j.claimed_until<=v_now
    or j.provider_message_id is not null or j.reconcile_required or j.customer_erased_at is not null then return false; end if;
  if p_confirm_only then
    if j.state<>'posting' or j.posting_started_at is null or j.attempts not between 1 and 5 then return false; end if;
  elsif j.state<>'claimed' or j.posting_started_at is not null or j.attempts>=5 then return false;
  end if;
  select value into v_flag from public.platform_flags where key='whatsapp_automation_dispatch';
  if found and jsonb_typeof(v_flag) is distinct from 'boolean' then raise exception 'automation_dependency_unavailable' using errcode='PT503'; end if;
  if j.reservation_id is not null then select unit_id,customer_id into v_resource_unit,v_current_customer from public.reservations where id=j.reservation_id;
  elsif j.voucher_id is not null then select unit_id,customer_id into v_resource_unit,v_current_customer from public.vouchers where id=j.voucher_id;
  else
    select w.unit_id,cu.id,(w.customer_id is not null and cu.id is null) into v_resource_unit,v_current_customer,v_invalid from public.waitlist w join public.units u on u.id=w.unit_id left join public.customers cu on cu.organization_id=u.organization_id and cu.phone=public.normalize_br_phone(w.customer_phone) and (w.customer_id is null or cu.id=w.customer_id) where w.id=j.waitlist_id;
  end if;
  v_logical:=case j.kind when 'confirmation' then case when (select applied_discount_percent>0 from public.reservations where id=j.reservation_id) then 'res_confirmacao_desconto_v1' else 'res_confirmacao_v1' end when 'reminder_d1' then 'res_lembrete_dia_v1' when 'survey_d1' then 'res_pesquisa_reserva_v1' when 'waitlist_entered' then 'fila_entrada_v1' when 'waitlist_feedback' then 'fila_feedback_v1' when 'voucher_issued' then 'mkt_voucher_programado_v1' end;
  select id into v_selected from public.whatsapp_channels x where x.unit_id=j.unit_id and (x.is_active=true or (x.is_active is null and x.status='connected' and not exists(select from public.whatsapp_channels active where active.unit_id=j.unit_id and active.is_active=true))) order by x.is_active desc nulls last,x.created_at,x.id limit 1;
  if v_resource_unit is distinct from j.unit_id or v_current_customer is distinct from j.customer_id or coalesce(v_invalid,false) or not exists(select from public.units where id=j.unit_id and organization_id=j.organization_id) then v_error:='recipient_changed';
  elsif j.customer_id is not null and (c.id is null or c.deleted_at is not null or c.organization_id is distinct from j.organization_id) then v_error:='customer_not_alive';
  elsif c.do_not_contact then v_error:='do_not_contact';
  elsif b.id is null or (b.unit_id,b.channel_id,b.provider,b.account_id,b.generation) is distinct from (j.unit_id,j.channel_id,j.provider,j.account_id,j.binding_generation) or b.channel_credential_revision is distinct from ch.template_credential_revision or p_generation is distinct from j.binding_generation or v_selected is distinct from j.channel_id then v_error:='binding_changed';
  elsif not b.dispatch_enabled or b.adopted_at is null or not exists(select from public.whatsapp_automation_adoptions where unit_id=j.unit_id) or v_flag is distinct from 'true'::jsonb then v_error:='dispatch_paused';
  elsif ch.id is null or ch.unit_id<>j.unit_id or ch.provider<>j.provider or ch.is_active=false or ch.status<>'connected' or ch.last_health_check_at is null or ch.last_health_check_at<v_now-interval '5 minutes' then v_error:='channel_unavailable';
  elsif v_now>j.expires_at then v_error:='expired';
  elsif j.kind in('waitlist_feedback','voucher_issued') and (j.customer_id is null or v_decision is distinct from 'opt_in' or v_revision is null or p_consent_revision is distinct from v_revision) then v_error:='consent_changed';
  elsif v_decision='opt_out' or p_consent_revision is distinct from v_revision or (p_confirm_only and j.consent_revision is distinct from v_revision) then v_error:='consent_changed';
  elsif j.kind in('waitlist_feedback','voucher_issued') and j.transport='template' and
    (ca.id is null or (ca.account_id,ca.binding_id,ca.binding_generation,ca.category) is distinct from (j.account_id,j.binding_id,j.binding_generation,'MARKETING') or ca.valid_from>v_now or ca.valid_until<=v_now or not exists(select from public.platform_admins where user_id=ca.actor_id) or t.requested_category is distinct from 'MARKETING' or (p_confirm_only and ca.id is distinct from j.cost_authorization_id)) then v_error:='cost_not_authorized';
  elsif j.kind in('waitlist_feedback','voucher_issued') and p_confirm_only and
    (s.id is null or (s.unit_id,s.customer_id,s.job_id,s.claim_token,s.state) is distinct from (j.unit_id,j.customer_id,j.id,p_fence,'reserved') or s.claimed_until<=v_now or s.claimed_until is distinct from j.claimed_until or s.window_until<=v_now or s.window_until is distinct from j.posting_started_at+make_interval(days=>s.window_days)) then v_error:='promotion_frequency';
  elsif j.kind in('waitlist_feedback','voucher_issued') and not p_confirm_only and s.id is not null and
    ((s.state in('accepted','uncertain') and s.window_until>v_now) or
     (s.state='reserved' and exists(select from public.whatsapp_automation_jobs old_job where old_job.id=s.job_id and (old_job.posting_started_at is not null or old_job.state='uncertain'))) or
     (s.state='reserved' and s.window_until>v_now and not exists(select from public.whatsapp_automation_jobs old_job where old_job.id=s.job_id)) or
     (s.state='reserved' and s.job_id<>j.id and s.claimed_until>v_now and exists(select from public.whatsapp_automation_jobs old_job where old_job.id=s.job_id))) then v_error:='promotion_frequency';
  elsif j.safe_log_body is null then v_error:='render_missing';
  elsif j.transport='template' and (a.id is null or a.organization_id<>j.organization_id or a.verified_at is null or b.verified_at is null or t.id is null
    or t.account_id<>j.account_id or t.version<>1 or j.template_version<>1 or t.logical_id<>v_logical or t.name<>v_logical or (j.initial_catalog_key is not null and j.initial_catalog_key<>v_logical)
    or t.binding_generation<>a.binding_generation or t.sync_required or t.local_status<>'usable' or t.remote_status<>'APPROVED' or t.language<>'pt_BR' or t.remote_id is null or t.observed_hash is distinct from t.desired_hash
    or t.requested_category is distinct from case when j.kind in('waitlist_feedback','voucher_issued') then 'MARKETING' else 'UTILITY' end
    or t.effective_category is distinct from t.requested_category or (t.requested_category='MARKETING' and t.quality='RED') or t.last_synced_at is null or t.last_synced_at<v_now-interval '60 seconds' or p_sync_epoch is distinct from t.sync_epoch or (p_confirm_only and j.sync_epoch is distinct from t.sync_epoch)
    or a.sync_capture_id is null or a.last_sync_published_at is null or a.last_sync_published_at<v_now-interval '60 seconds'
    or gb.id is null or gc.id is null or gb.account_id is distinct from a.id or gb.verified_at is null or gb.generation is distinct from a.sync_binding_generation
    or gb.channel_credential_revision is distinct from a.sync_credential_revision or gc.template_credential_revision is distinct from a.sync_credential_revision
    or (gb.unit_id,gb.provider) is distinct from (gc.unit_id,gc.provider) or gc.status<>'connected') then v_error:='template_unavailable';
  elsif j.transport='text' and (p_sync_epoch is not null or j.sync_epoch is not null) then v_error:='template_unavailable';
  end if;
  if p_confirm_only then return v_error is null; end if;
  if v_error is not null then
    update public.whatsapp_automation_jobs set state=case when v_error in('binding_changed','recipient_changed') then 'needs_review' when v_error='dispatch_paused' then 'paused' when v_error='expired' then 'expired' else 'blocked' end,error_code=v_error where id=j.id and claim_token=p_fence;
    return false;
  end if;
  if j.kind in('waitlist_feedback','voucher_issued') then
    if s.id is not null then
      insert into app_private.whatsapp_promotion_slot_release_permits values(txid_current(),s.id);
      delete from public.whatsapp_promotion_slots where id=s.id;
    end if;
    select window_days into v_days from app_private.whatsapp_promotion_policy where singleton;
    if v_days is null then raise exception 'promotion_policy_unavailable' using errcode='P0A16'; end if;
    insert into public.whatsapp_promotion_slots(unit_id,customer_id,job_id,claim_token,claimed_until,window_until,window_days)
      values(j.unit_id,j.customer_id,j.id,p_fence,v_now+interval '90 seconds',v_now+make_interval(days=>v_days),v_days);
  end if;
  update public.whatsapp_automation_jobs set state='posting',posting_started_at=v_now,claimed_until=v_now+interval '90 seconds',attempts=attempts+1,sync_epoch=case when transport='template' then t.sync_epoch else null end,consent_revision=v_revision,cost_authorization_id=ca.id,error_code=null where id=j.id and claim_token=p_fence and state='claimed';
  return found;
end $$;
revoke all on function app_private.whatsapp_automation_post_core(uuid,uuid,bigint,bigint,bigint,boolean) from public,anon,authenticated,service_role;
create or replace function public.prepare_whatsapp_automation_post(p_job_id uuid,p_fence uuid,p_generation bigint,p_consent_revision bigint,p_sync_epoch bigint)
returns boolean language sql security definer set search_path='' as $$
  select app_private.whatsapp_automation_post_core(p_job_id,p_fence,p_generation,p_consent_revision,p_sync_epoch,false)
$$;
revoke all on function public.prepare_whatsapp_automation_post(uuid,uuid,bigint,bigint,bigint) from public,anon,authenticated,service_role;
grant execute on function public.prepare_whatsapp_automation_post(uuid,uuid,bigint,bigint,bigint) to service_role;
create or replace function public.confirm_whatsapp_automation_post(p_job_id uuid,p_fence uuid,p_generation bigint,p_consent_revision bigint,p_sync_epoch bigint)
returns boolean language sql security definer set search_path='' as $$
  select app_private.whatsapp_automation_post_core(p_job_id,p_fence,p_generation,p_consent_revision,p_sync_epoch,true)
$$;
revoke all on function public.confirm_whatsapp_automation_post(uuid,uuid,bigint,bigint,bigint) from public,anon,authenticated,service_role;
grant execute on function public.confirm_whatsapp_automation_post(uuid,uuid,bigint,bigint,bigint) to service_role;

create or replace function public.guard_whatsapp_template_scope()
returns trigger language plpgsql security definer set search_path='' as $$
declare
  v_org uuid; v_customer_org uuid; v_deleted timestamptz;
  v_binding public.whatsapp_template_bindings%rowtype;
  v_channel public.whatsapp_channels%rowtype;
  v_remote public.whatsapp_remote_templates%rowtype;
  v_job public.whatsapp_automation_jobs%rowtype;
  v_resource_unit uuid; v_resource_customer uuid; v_resource_invalid boolean:=false; v_reset boolean:=false; v_erasure boolean:=false;
  v_initialize boolean:=false; v_logical text; v_selected uuid;
  old_pins app_private.whatsapp_automation_pin_tuple; new_pins app_private.whatsapp_automation_pin_tuple;
begin
  -- UPDATE already owns the job: never acquire earlier parent locks here.
  if tg_op='UPDATE' and tg_table_name='whatsapp_automation_jobs' then
    old_pins:=row(old.pin_phase,old.channel_id,old.provider,old.binding_id,old.binding_generation,old.transport,old.account_id,old.remote_template_id,old.template_version,old.sync_epoch,old.initial_credential_revision,old.initial_catalog_key)::app_private.whatsapp_automation_pin_tuple;
    new_pins:=row(new.pin_phase,new.channel_id,new.provider,new.binding_id,new.binding_generation,new.transport,new.account_id,new.remote_template_id,new.template_version,new.sync_epoch,new.initial_credential_revision,new.initial_catalog_key)::app_private.whatsapp_automation_pin_tuple;
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
    elsif (new.pin_phase,new.channel_id,new.provider,new.binding_id,new.binding_generation,new.transport,new.account_id,new.remote_template_id,new.template_version,new.initial_credential_revision,new.initial_catalog_key)
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
    if not v_initialize and new.sync_epoch is distinct from old.sync_epoch then
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
      select w.unit_id,c.id,(w.customer_id is not null and c.id is null) into v_resource_unit,v_resource_customer,v_resource_invalid from public.waitlist w
        join public.units u on u.id=w.unit_id left join public.customers c on c.organization_id=u.organization_id and c.phone=public.normalize_br_phone(w.customer_phone) and (w.customer_id is null or c.id=w.customer_id) where w.id=new.waitlist_id;
    elsif new.voucher_id is not null then select unit_id,customer_id into v_resource_unit,v_resource_customer from public.vouchers where id=new.voucher_id;
    end if;
    if v_resource_invalid or v_resource_unit is distinct from new.unit_id or v_resource_customer is distinct from new.customer_id then raise exception 'template_resource_mismatch' using errcode='23514'; end if;
    if tg_op='INSERT' and (new.customer_erased_at is not null or (new.customer_id is null and new.waitlist_id is null)) then raise exception 'template_resource_mismatch' using errcode='23514'; end if;
    v_logical:=case new.kind when 'confirmation' then case when (select applied_discount_percent>0 from public.reservations where id=new.reservation_id) then 'res_confirmacao_desconto_v1' else 'res_confirmacao_v1' end when 'reminder_d1' then 'res_lembrete_dia_v1' when 'survey_d1' then 'res_pesquisa_reserva_v1' when 'waitlist_entered' then 'fila_entrada_v1' when 'waitlist_feedback' then 'fila_feedback_v1' when 'voucher_issued' then 'mkt_voucher_programado_v1' end;
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
commit;
