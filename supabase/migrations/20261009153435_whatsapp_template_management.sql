-- Genuine caller management. No provider call, flag activation, worker or producer.
begin;

create or replace function app_private.require_whatsapp_template_manager(p_unit_id uuid,p_admin_only boolean)
returns void language plpgsql stable security definer set search_path='' as $$
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or (p_unit_id is not null and not exists(select from public.units where id=p_unit_id))
    or not (app_private.is_platform_admin(auth.uid()) or (not p_admin_only and p_unit_id is not null
      and exists(select from public.unit_members where user_id=auth.uid() and unit_id=p_unit_id and role in('owner','gerente')))) then
    raise exception 'template_management_forbidden' using errcode='42501';
  end if;
end $$;
revoke all on function app_private.require_whatsapp_template_manager(uuid,boolean) from public,anon,authenticated,service_role;

create or replace function public.get_whatsapp_message_consent_state(p_unit_id uuid,p_customer_id uuid,p_purpose text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare e public.whatsapp_message_consent_events%rowtype;
begin
  perform app_private.require_whatsapp_template_manager(p_unit_id,false);
  if p_unit_id is null or not exists(select from public.customers c join public.units u on u.organization_id=c.organization_id
    where u.id=p_unit_id and c.id=p_customer_id and c.deleted_at is null) then
    raise exception 'template_management_forbidden' using errcode='42501';
  end if;
  if p_purpose is null or p_purpose not in('operational','promotional') then raise exception 'template_management_invalid' using errcode='22023'; end if;
  select * into e from public.whatsapp_message_consent_events where unit_id=p_unit_id and customer_id=p_customer_id and purpose=p_purpose order by revision desc limit 1;
  if not found then return jsonb_build_object('purpose',p_purpose,'status','unknown','revision',null); end if;
  if e.revision<1 or e.revision>9007199254740991 or e.decision not in('opt_in','opt_out') then raise exception 'template_management_dependency' using errcode='PT503'; end if;
  return jsonb_build_object('purpose',p_purpose,'status',e.decision,'revision',e.revision);
end $$;
revoke all on function public.get_whatsapp_message_consent_state(uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.get_whatsapp_message_consent_state(uuid,uuid,text) to authenticated;

create or replace function public.record_whatsapp_message_consent(p_unit_id uuid,p_customer_id uuid,p_purpose text,p_decision text,p_source_code text,p_observed_at timestamptz,p_evidence_reference text)
returns bigint language plpgsql security definer set search_path='' as $$
declare v_org uuid; v_revision bigint; v_now timestamptz;
begin
  perform app_private.require_whatsapp_template_manager(p_unit_id,false);
  select c.organization_id into v_org from public.customers c where c.id=p_customer_id and c.deleted_at is null for update;
  if not found or p_unit_id is null or not exists(select from public.units where id=p_unit_id and organization_id=v_org) then raise exception 'template_management_forbidden' using errcode='42501'; end if;
  v_now:=clock_timestamp();
  if p_purpose is null or p_purpose not in('operational','promotional') or p_decision is null or p_decision not in('opt_in','opt_out')
    or p_source_code is null or p_source_code not in('customer_message','signed_form','in_person')
    or p_observed_at is null or not isfinite(p_observed_at) or p_observed_at>v_now
    or p_evidence_reference is null or char_length(btrim(p_evidence_reference)) not between 1 and 512
    or p_evidence_reference ~ '[[:cntrl:]]' or p_evidence_reference like '%/preferencias/mensagens/%' then raise exception 'template_management_invalid' using errcode='22023'; end if;
  -- Existing trigger assigns the revision while retaining this customer lock.
  insert into public.whatsapp_message_consent_events(unit_id,customer_id,purpose,decision,source_code,evidence_reference,actor_id,observed_at)
  values(p_unit_id,p_customer_id,p_purpose,p_decision,p_source_code,btrim(p_evidence_reference),auth.uid(),p_observed_at) returning revision into v_revision;
  if v_revision>9007199254740991 then raise exception 'template_management_dependency' using errcode='PT503'; end if;
  insert into public.audit_log(table_name,record_id,action,new_values,actor_id,unit_id,organization_id)
  values('whatsapp_message_consent_events',p_customer_id::text,'INSERT',jsonb_build_object('purpose',p_purpose,'decision',p_decision,'revision',v_revision),auth.uid(),p_unit_id,v_org);
  return v_revision;
end $$;
revoke all on function public.record_whatsapp_message_consent(uuid,uuid,text,text,text,timestamptz,text) from public,anon,authenticated,service_role;
grant execute on function public.record_whatsapp_message_consent(uuid,uuid,text,text,text,timestamptz,text) to authenticated;

create or replace function public.configure_whatsapp_promotion_frequency(p_window_days integer)
returns integer language plpgsql security definer set search_path='' as $$
declare v_old integer;
begin
  perform app_private.require_whatsapp_template_manager(null,true);
  if p_window_days is null or p_window_days not between 1 and 30 then raise exception 'template_management_invalid' using errcode='22023'; end if;
  select window_days into v_old from app_private.whatsapp_promotion_policy where singleton for update;
  if not found then raise exception 'template_management_dependency' using errcode='PT503'; end if;
  update app_private.whatsapp_promotion_policy set window_days=p_window_days where singleton;
  insert into public.audit_log(table_name,record_id,action,old_values,new_values,actor_id)
  values('whatsapp_promotion_policy','singleton','UPDATE',jsonb_build_object('window_days',v_old),jsonb_build_object('window_days',p_window_days),auth.uid());
  return p_window_days;
end $$;
revoke all on function public.configure_whatsapp_promotion_frequency(integer) from public,anon,authenticated,service_role;
grant execute on function public.configure_whatsapp_promotion_frequency(integer) to authenticated;

create or replace function public.release_whatsapp_template_channel(p_channel_id uuid,p_scope text,p_enabled boolean,p_expected_credential_revision bigint,p_expected_binding_generation bigint)
returns boolean language plpgsql security definer set search_path='' as $$
declare b public.whatsapp_template_bindings%rowtype; c public.whatsapp_channels%rowtype;
  v_binding uuid; v_account uuid; v_unit uuid; v_org uuid; v_selected uuid; v_now timestamptz;
begin
  perform app_private.require_whatsapp_template_manager(null,true);
  if p_scope is null or p_scope not in('catalog','dispatch') or p_enabled is null or p_expected_credential_revision is null or p_expected_credential_revision<0 then raise exception 'template_management_invalid' using errcode='22023'; end if;
  select ch.unit_id,u.organization_id into v_unit,v_org from public.whatsapp_channels ch join public.units u on u.id=ch.unit_id where ch.id=p_channel_id;
  if not found then raise exception 'template_management_forbidden' using errcode='42501'; end if;
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
    if not p_enabled then return false; end if;
    if p_expected_binding_generation is not null or p_scope<>'dispatch' or c.provider not in('zapi','waha','uazapi') then return false; end if;
  elsif p_expected_binding_generation is null or b.generation is distinct from p_expected_binding_generation then raise exception 'template_configuration_changed' using errcode='PT409'; end if;
  if not p_enabled then
    -- No flags, health, secret or provider equality are authority to prevent stop.
    if (p_scope='dispatch' and not b.dispatch_enabled) or (p_scope='catalog' and b.submission_authorized_at is null and b.submission_authorized_by is null) then return true; end if;
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
revoke all on function public.release_whatsapp_template_channel(uuid,text,boolean,bigint,bigint) from public,anon,authenticated,service_role;
grant execute on function public.release_whatsapp_template_channel(uuid,text,boolean,bigint,bigint) to authenticated;

-- Shared ordered read lock: no grant to any caller. Parent identity is refreshed
-- after every wait; an observed replacement is never acquired in reverse order.
create or replace function app_private.lock_whatsapp_management_binding(p_channel_id uuid,p_generation bigint,p_admin_only boolean,p_sync boolean)
returns public.whatsapp_template_bindings language plpgsql security definer set search_path='' as $$
declare b public.whatsapp_template_bindings%rowtype; c public.whatsapp_channels%rowtype;
  v_id uuid; v_account uuid; v_org uuid; v_unit uuid; v_bindings uuid[]; v_channels uuid[];
begin
  select ch.unit_id,u.organization_id into v_unit,v_org from public.whatsapp_channels ch join public.units u on u.id=ch.unit_id where ch.id=p_channel_id;
  perform app_private.require_whatsapp_template_manager(v_unit,p_admin_only);
  if v_unit is null then raise exception 'template_management_forbidden' using errcode='42501'; end if;
  select id,account_id into v_id,v_account from public.whatsapp_template_bindings where channel_id=p_channel_id;
  if v_id is null or v_account is null then raise exception 'template_configuration_changed' using errcode='PT409'; end if;
  perform 1 from public.whatsapp_template_accounts where id=v_account and organization_id=v_org for update;
  if not found then raise exception 'template_management_forbidden' using errcode='42501'; end if;
  if p_sync then
    select array_agg(id order by id) into v_bindings from public.whatsapp_template_bindings where account_id=v_account;
    if v_bindings is null or not(v_id=any(v_bindings)) then raise exception 'template_configuration_changed' using errcode='PT409'; end if;
    perform 1 from public.whatsapp_template_bindings where id=any(v_bindings) order by id for share;
    if (select count(*) from public.whatsapp_template_bindings where id=any(v_bindings) and account_id=v_account) is distinct from cardinality(v_bindings)
      then raise exception 'template_configuration_changed' using errcode='PT409'; end if;
    select array_agg(distinct channel_id order by channel_id) into v_channels from public.whatsapp_template_bindings where id=any(v_bindings);
    perform 1 from public.whatsapp_channels where id=any(v_channels) order by id for share;
    if (select count(*) from public.whatsapp_channels where id=any(v_channels)) is distinct from cardinality(v_channels)
      then raise exception 'template_configuration_changed' using errcode='PT409'; end if;
  end if;
  select * into b from public.whatsapp_template_bindings where id=v_id for share;
  if not found or (b.account_id,b.unit_id,b.channel_id) is distinct from (v_account,v_unit,p_channel_id) then raise exception 'template_configuration_changed' using errcode='PT409'; end if;
  select * into c from public.whatsapp_channels where id=p_channel_id for share;
  if not found or (c.unit_id,c.provider,c.template_credential_revision) is distinct from (b.unit_id,b.provider,b.channel_credential_revision)
    or not exists(select from public.units where id=v_unit and organization_id=v_org)
    or p_generation is null or b.generation is distinct from p_generation or b.verified_at is null or b.provider<>'datafy' then raise exception 'template_configuration_changed' using errcode='PT409'; end if;
  perform app_private.require_whatsapp_template_manager(v_unit,p_admin_only);
  return b;
end $$;
revoke all on function app_private.lock_whatsapp_management_binding(uuid,bigint,boolean,boolean) from public,anon,authenticated,service_role;

create or replace function public.request_whatsapp_template_sync_for_channel(p_channel_id uuid,p_expected_binding_generation bigint)
returns uuid language plpgsql security definer set search_path='' as $$
declare b public.whatsapp_template_bindings%rowtype; v_flag jsonb;
begin
  b:=app_private.lock_whatsapp_management_binding(p_channel_id,p_expected_binding_generation,false,true);
  select value into v_flag from public.platform_flags where key='whatsapp_template_catalog';
  if found and jsonb_typeof(v_flag) is distinct from 'boolean' then raise exception 'template_management_dependency' using errcode='PT503'; end if;
  if v_flag is distinct from 'true'::jsonb then return null; end if;
  return public.request_whatsapp_template_sync(b.account_id);
end $$;
revoke all on function public.request_whatsapp_template_sync_for_channel(uuid,bigint) from public,anon,authenticated,service_role;
grant execute on function public.request_whatsapp_template_sync_for_channel(uuid,bigint) to authenticated;

create or replace function public.authorize_whatsapp_marketing_cost(p_channel_id uuid,p_expected_binding_generation bigint,p_category text,p_valid_from timestamptz,p_valid_until timestamptz)
returns uuid language plpgsql security definer set search_path='' as $$
declare b public.whatsapp_template_bindings%rowtype; v_id uuid;
begin
  perform app_private.require_whatsapp_template_manager(null,true);
  b:=app_private.lock_whatsapp_management_binding(p_channel_id,p_expected_binding_generation,true,false);
  if p_category is distinct from 'MARKETING' or p_valid_from is null or p_valid_until is null or not isfinite(p_valid_from) or not isfinite(p_valid_until)
    or p_valid_until<=p_valid_from or p_valid_until<=clock_timestamp() then raise exception 'template_management_invalid' using errcode='22023'; end if;
  insert into public.whatsapp_template_cost_authorizations(account_id,binding_id,binding_generation,category,valid_from,valid_until,actor_id)
  values(b.account_id,b.id,b.generation,p_category,p_valid_from,p_valid_until,auth.uid()) returning id into v_id;
  insert into public.audit_log(table_name,record_id,action,new_values,actor_id,unit_id)
  values('whatsapp_template_cost_authorizations',v_id::text,'INSERT',jsonb_build_object('category',p_category,'binding_generation',b.generation,'valid_from',p_valid_from,'valid_until',p_valid_until),auth.uid(),b.unit_id);
  return v_id;
end $$;
revoke all on function public.authorize_whatsapp_marketing_cost(uuid,bigint,text,timestamptz,timestamptz) from public,anon,authenticated,service_role;
grant execute on function public.authorize_whatsapp_marketing_cost(uuid,bigint,text,timestamptz,timestamptz) to authenticated;

create table if not exists app_private.whatsapp_automation_pin_revalidation_permits (
  transaction_id bigint not null,actor_id uuid not null,job_id uuid not null,
  old_pins app_private.whatsapp_automation_pin_tuple not null,new_pins app_private.whatsapp_automation_pin_tuple not null,
  primary key(transaction_id,job_id)
);
alter table app_private.whatsapp_automation_pin_revalidation_permits enable row level security;
alter table app_private.whatsapp_automation_pin_revalidation_permits force row level security;
revoke all on app_private.whatsapp_automation_pin_revalidation_permits from public,anon,authenticated,service_role;
create or replace function app_private.consume_whatsapp_automation_pin_revalidation(p_job_id uuid,p_old_pins app_private.whatsapp_automation_pin_tuple,p_new_pins app_private.whatsapp_automation_pin_tuple)
returns boolean language plpgsql security definer set search_path='' as $$
declare n integer; v_unit uuid;
begin
  select unit_id into v_unit from public.whatsapp_automation_jobs where id=p_job_id;
  if v_unit is null or auth.role() is distinct from 'authenticated' or auth.uid() is null then return false; end if;
  perform app_private.require_whatsapp_template_manager(v_unit,false);
  if p_old_pins.pin_phase is distinct from 'bound' or p_new_pins.pin_phase is distinct from 'bound'
    or p_old_pins.transport is distinct from p_new_pins.transport
    or p_old_pins.initial_credential_revision is distinct from p_new_pins.initial_credential_revision
    or p_old_pins.initial_catalog_key is distinct from p_new_pins.initial_catalog_key then return false; end if;
  delete from app_private.whatsapp_automation_pin_revalidation_permits where transaction_id=txid_current() and actor_id=auth.uid() and job_id=p_job_id
    and old_pins is not distinct from p_old_pins and new_pins is not distinct from p_new_pins;
  get diagnostics n=row_count; return n=1;
end $$;
revoke all on function app_private.consume_whatsapp_automation_pin_revalidation(uuid,app_private.whatsapp_automation_pin_tuple,app_private.whatsapp_automation_pin_tuple) from public,anon,authenticated,service_role;

create or replace function app_private.change_whatsapp_automation_pins(p_job_id uuid,p_expected_channel_id uuid,p_expected_binding_generation bigint,p_initialize boolean)
returns boolean language plpgsql security definer set search_path='' as $$
declare j public.whatsapp_automation_jobs%rowtype; initial_j public.whatsapp_automation_jobs%rowtype;
  b public.whatsapp_template_bindings%rowtype; ch public.whatsapp_channels%rowtype; t public.whatsapp_remote_templates%rowtype;
  old_t public.whatsapp_remote_templates%rowtype; s public.whatsapp_promotion_slots%rowtype;
  v_binding uuid; v_account uuid; v_channel uuid; v_template uuid; v_org uuid; v_unit uuid; v_customer uuid;
  v_invalid boolean; v_logical text; v_transport text; v_now timestamptz; n integer;
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
  v_logical:=case initial_j.kind when 'confirmation' then case when (select applied_discount_percent>0 from public.reservations where id=initial_j.reservation_id) then 'res_confirmacao_desconto_v1' else 'res_confirmacao_v1' end
    when 'reminder_d1' then 'res_lembrete_dia_v1' when 'survey_d1' then 'res_pesquisa_reserva_v1' when 'waitlist_entered' then 'fila_entrada_v1' when 'waitlist_feedback' then 'fila_feedback_v1' when 'voucher_issued' then 'mkt_voucher_programado_v1' end;
  if initial_j.initial_catalog_key is not null and initial_j.initial_catalog_key is distinct from v_logical then return false; end if;
  if v_transport='template' then select id into v_template from public.whatsapp_remote_templates where account_id=v_account and logical_id=v_logical and version=1 and language='pt_BR'; end if;
  perform 1 from public.whatsapp_remote_templates where id in(initial_j.remote_template_id,v_template) order by id for share;
  select * into t from public.whatsapp_remote_templates where id=v_template;
  select * into old_t from public.whatsapp_remote_templates where id=initial_j.remote_template_id;
  if v_transport='template' and (t.id is null or (t.account_id,t.logical_id,t.version,t.language) is distinct from (v_account,v_logical,1,'pt_BR')) then return false; end if;
  if initial_j.remote_template_id is not null and (old_t.id is null or old_t.logical_id is distinct from v_logical or old_t.version<>1) then return false; end if;
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
create or replace function public.initialize_whatsapp_automation_job(p_job_id uuid,p_expected_channel_id uuid,p_expected_binding_generation bigint)
returns boolean language plpgsql security definer set search_path='' as $$
begin return app_private.change_whatsapp_automation_pins(p_job_id,p_expected_channel_id,p_expected_binding_generation,true); end $$;
revoke all on function public.initialize_whatsapp_automation_job(uuid,uuid,bigint) from public,anon,authenticated,service_role;
grant execute on function public.initialize_whatsapp_automation_job(uuid,uuid,bigint) to authenticated;
create or replace function public.revalidate_whatsapp_automation_job(p_job_id uuid,p_expected_channel_id uuid,p_expected_binding_generation bigint)
returns boolean language plpgsql security definer set search_path='' as $$
begin return app_private.change_whatsapp_automation_pins(p_job_id,p_expected_channel_id,p_expected_binding_generation,false); end $$;
revoke all on function public.revalidate_whatsapp_automation_job(uuid,uuid,bigint) from public,anon,authenticated,service_role;
grant execute on function public.revalidate_whatsapp_automation_job(uuid,uuid,bigint) to authenticated;

do $$ begin
  if to_regtype('app_private.whatsapp_catalog_pin_tuple') is null then
    create type app_private.whatsapp_catalog_pin_tuple as (binding_id uuid,binding_generation bigint);
  end if;
end $$;
revoke all on type app_private.whatsapp_catalog_pin_tuple from public,anon,authenticated,service_role;
create table if not exists app_private.whatsapp_catalog_pin_revalidation_permits (
  transaction_id bigint not null,actor_id uuid not null,job_id uuid not null,
  old_pins app_private.whatsapp_catalog_pin_tuple not null,new_pins app_private.whatsapp_catalog_pin_tuple not null,
  primary key(transaction_id,job_id)
);
create table if not exists app_private.whatsapp_template_zero_post_evidence (
  id uuid primary key default gen_random_uuid(),job_id uuid not null references public.whatsapp_template_jobs(id) on delete cascade,
  account_id uuid not null,target_key text not null,target_template_id uuid not null,target_hash text not null,target_version integer not null check(target_version=1),job_revision bigint not null,
  binding_id uuid not null,binding_generation bigint not null,claim_token uuid not null,posting_started_at timestamptz not null,post_capture_id uuid not null,
  first_submission_attempted_at timestamptz not null,attempts_before_reset integer not null check(attempts_before_reset=1),attempts_after_reset integer not null check(attempts_after_reset=0),
  refused_at timestamptz not null,reason text not null check(reason in('final_service_suspended','final_channel_changed','final_gate_paused')),
  unique(job_id,claim_token)
);
create table if not exists app_private.whatsapp_template_revalidation_authorizations (
  id uuid primary key default gen_random_uuid(),evidence_id uuid not null unique references app_private.whatsapp_template_zero_post_evidence(id) on delete cascade,
  job_id uuid not null references public.whatsapp_template_jobs(id) on delete cascade,account_id uuid not null,target_template_id uuid not null,target_key text not null,target_hash text not null,job_revision bigint not null,
  binding_id uuid not null,binding_generation bigint not null,actor_id uuid not null,authorized_at timestamptz not null,
  consumed_at timestamptz,consumed_claim_token uuid,check((consumed_at is null)=(consumed_claim_token is null))
);
create unique index if not exists whatsapp_template_revalidation_one_pending_idx on app_private.whatsapp_template_revalidation_authorizations(job_id) where consumed_at is null;
create index if not exists whatsapp_template_zero_post_job_idx on app_private.whatsapp_template_zero_post_evidence(job_id,refused_at desc);
do $$ declare t text; begin
  foreach t in array array['whatsapp_catalog_pin_revalidation_permits','whatsapp_template_zero_post_evidence','whatsapp_template_revalidation_authorizations'] loop
    execute format('alter table app_private.%I enable row level security',t);
    execute format('alter table app_private.%I force row level security',t);
    execute format('revoke all on app_private.%I from public,anon,authenticated,service_role',t);
  end loop;
end $$;
create or replace function app_private.guard_whatsapp_catalog_revalidation_evidence()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='DELETE' then
    if not exists(select from public.whatsapp_template_jobs where id=old.job_id) then return old; end if;
  elsif tg_table_name='whatsapp_template_revalidation_authorizations' then
    if old.consumed_at is null and new.consumed_at is not null and new.consumed_claim_token is not null
      and (to_jsonb(new)-array['consumed_at','consumed_claim_token']) is not distinct from (to_jsonb(old)-array['consumed_at','consumed_claim_token']) then return new; end if;
  end if;
  raise exception 'template_revalidation_evidence_immutable' using errcode='23514';
end $$;
revoke all on function app_private.guard_whatsapp_catalog_revalidation_evidence() from public,anon,authenticated,service_role;
drop trigger if exists whatsapp_catalog_revalidation_evidence on app_private.whatsapp_template_zero_post_evidence;
create trigger whatsapp_catalog_revalidation_evidence before update or delete on app_private.whatsapp_template_zero_post_evidence for each row execute function app_private.guard_whatsapp_catalog_revalidation_evidence();
drop trigger if exists whatsapp_catalog_revalidation_evidence on app_private.whatsapp_template_revalidation_authorizations;
create trigger whatsapp_catalog_revalidation_evidence before update or delete on app_private.whatsapp_template_revalidation_authorizations for each row execute function app_private.guard_whatsapp_catalog_revalidation_evidence();

create or replace function app_private.consume_whatsapp_catalog_pin_revalidation(p_job_id uuid,p_old_pins app_private.whatsapp_catalog_pin_tuple,p_new_pins app_private.whatsapp_catalog_pin_tuple)
returns boolean language plpgsql security definer set search_path='' as $$
declare n integer;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null or not app_private.is_platform_admin(auth.uid()) then return false; end if;
  delete from app_private.whatsapp_catalog_pin_revalidation_permits where transaction_id=txid_current() and actor_id=auth.uid() and job_id=p_job_id
    and old_pins is not distinct from p_old_pins and new_pins is not distinct from p_new_pins;
  get diagnostics n=row_count; return n=1;
end $$;
revoke all on function app_private.consume_whatsapp_catalog_pin_revalidation(uuid,app_private.whatsapp_catalog_pin_tuple,app_private.whatsapp_catalog_pin_tuple) from public,anon,authenticated,service_role;

create or replace function public.revalidate_whatsapp_template_job(p_job_id uuid,p_expected_channel_id uuid,p_expected_binding_generation bigint)
returns boolean language plpgsql security definer set search_path='' as $$
declare j public.whatsapp_template_jobs%rowtype; prior public.whatsapp_template_jobs%rowtype;
  b public.whatsapp_template_bindings%rowtype; c public.whatsapp_channels%rowtype; t public.whatsapp_remote_templates%rowtype;
  e app_private.whatsapp_template_zero_post_evidence%rowtype; v_binding uuid; v_unit uuid; n integer;
begin
  perform app_private.require_whatsapp_template_manager(null,true);
  select * into prior from public.whatsapp_template_jobs where id=p_job_id;
  if not found then raise exception 'template_management_forbidden' using errcode='42501'; end if;
  select b0.id,b0.unit_id into v_binding,v_unit from public.whatsapp_template_bindings b0 join public.whatsapp_channels c0 on c0.id=b0.channel_id
    join public.units u on u.id=c0.unit_id where c0.id=p_expected_channel_id and b0.account_id=prior.account_id and u.organization_id=prior.organization_id and b0.unit_id=u.id;
  if not found then raise exception 'template_management_forbidden' using errcode='42501'; end if;
  perform 1 from public.whatsapp_template_accounts where id=prior.account_id and organization_id=prior.organization_id for share;
  if not found then raise exception 'template_management_forbidden' using errcode='42501'; end if;
  perform 1 from public.whatsapp_template_bindings where id in(prior.binding_id,v_binding) order by id for share;
  select * into b from public.whatsapp_template_bindings where id=v_binding;
  if b.account_id is distinct from prior.account_id or b.channel_id is distinct from p_expected_channel_id or b.unit_id is distinct from v_unit then raise exception 'template_configuration_changed' using errcode='PT409'; end if;
  select * into c from public.whatsapp_channels where id=p_expected_channel_id for share;
  select * into t from public.whatsapp_remote_templates where account_id=prior.account_id and logical_id=prior.target_key and version=1 and language='pt_BR' for share;
  select * into j from public.whatsapp_template_jobs where id=p_job_id for update;
  if not found or to_jsonb(j) is distinct from to_jsonb(prior) then raise exception 'template_configuration_changed' using errcode='PT409'; end if;
  if b.generation is distinct from p_expected_binding_generation or p_expected_binding_generation is null
    or (c.unit_id,c.provider,c.template_credential_revision) is distinct from (b.unit_id,b.provider,b.channel_credential_revision)
    or b.account_id is distinct from j.account_id or not exists(select from public.units where id=b.unit_id and organization_id=j.organization_id) then raise exception 'template_configuration_changed' using errcode='PT409'; end if;
  if c.provider<>'datafy' or c.status<>'connected' or c.last_health_check_at is null or c.last_health_check_at<clock_timestamp()-interval '5 minutes'
    or b.verified_at is null or b.submission_authorized_at is null or b.submission_authorized_by is null then return false; end if;
  if j.state not in('paused','needs_review') or j.operation<>'provision' or j.attempts<>0 or j.provider_outcome is not null
    or num_nonnulls(j.posting_started_at,j.post_capture_id,j.claim_token,j.claimed_until,j.finished_at)>0 or t.id is null
    or t.name<>t.logical_id or t.logical_id not in('res_confirmacao_v1','res_confirmacao_desconto_v1','res_lembrete_dia_v1','res_pesquisa_reserva_v1','fila_entrada_v1','fila_feedback_v1','mkt_voucher_programado_v1')
    or t.remote_id is not null or t.observed_hash is not null or t.remote_status<>'UNKNOWN' then return false; end if;
  select * into e from app_private.whatsapp_template_zero_post_evidence where job_id=j.id order by refused_at desc,id desc limit 1;
  if e.id is null or (e.account_id,e.target_key,e.target_template_id,e.target_hash,e.target_version,e.job_revision,e.first_submission_attempted_at,e.binding_id,e.binding_generation)
    is distinct from (j.account_id,j.target_key,t.id,t.desired_hash,1,j.revision,t.submission_attempted_at,j.binding_id,j.binding_generation)
    or exists(select from app_private.whatsapp_template_revalidation_authorizations where evidence_id=e.id or (job_id=j.id and consumed_at is null))
    or exists(select from public.whatsapp_template_jobs other where other.id<>j.id and other.account_id=j.account_id and other.target_key=j.target_key and other.operation='provision' and (other.posting_started_at is not null or other.provider_outcome is not null)) then return false; end if;
  insert into app_private.whatsapp_catalog_pin_revalidation_permits values(txid_current(),auth.uid(),j.id,row(j.binding_id,j.binding_generation)::app_private.whatsapp_catalog_pin_tuple,row(b.id,b.generation)::app_private.whatsapp_catalog_pin_tuple);
  update public.whatsapp_template_jobs set binding_id=b.id,binding_generation=b.generation,state='queued',error_code=null where id=j.id;
  get diagnostics n=row_count;
  if n<>1 or exists(select from app_private.whatsapp_catalog_pin_revalidation_permits where transaction_id=txid_current() and job_id=j.id) then raise exception 'template_management_permit_not_consumed'; end if;
  insert into app_private.whatsapp_template_revalidation_authorizations(evidence_id,job_id,account_id,target_template_id,target_key,target_hash,job_revision,binding_id,binding_generation,actor_id,authorized_at)
  values(e.id,j.id,j.account_id,t.id,j.target_key,t.desired_hash,j.revision,b.id,b.generation,auth.uid(),clock_timestamp());
  insert into public.audit_log(table_name,record_id,action,old_values,new_values,actor_id,unit_id,organization_id)
  values('whatsapp_template_jobs',j.id::text,'UPDATE',jsonb_build_object('binding_id',j.binding_id,'generation',j.binding_generation),jsonb_build_object('binding_id',b.id,'generation',b.generation,'reason','zero_post_correction'),auth.uid(),b.unit_id,j.organization_id);
  return true;
end $$;
revoke all on function public.revalidate_whatsapp_template_job(uuid,uuid,bigint) from public,anon,authenticated,service_role;
grant execute on function public.revalidate_whatsapp_template_job(uuid,uuid,bigint) to authenticated;

-- Preserve predecessor authority; exceptions consume exact private permits.
create or replace function public.guard_whatsapp_template_scope()
returns trigger language plpgsql security definer set search_path='' as $$
declare
  v_org uuid; v_customer_org uuid; v_deleted timestamptz;
  v_binding public.whatsapp_template_bindings%rowtype;
  v_channel public.whatsapp_channels%rowtype;
  v_remote public.whatsapp_remote_templates%rowtype;
  v_job public.whatsapp_automation_jobs%rowtype;
  v_resource_unit uuid; v_resource_customer uuid; v_resource_invalid boolean:=false; v_reset boolean:=false; v_erasure boolean:=false;
  v_initialize boolean:=false; v_revalidate boolean:=false; v_catalog_revalidate boolean:=false; v_exclusive_stop boolean:=false; v_logical text; v_selected uuid;
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
      if auth.role() is distinct from 'authenticated' or auth.uid() is null or not app_private.is_platform_admin(auth.uid()) then raise exception 'template_admin_required' using errcode='42501'; end if;
      if new.submission_authorized_at is not null and (tg_op='INSERT' or (new.submission_authorized_at,new.submission_authorized_by) is distinct from (old.submission_authorized_at,old.submission_authorized_by)) then new.submission_authorized_by:=auth.uid(); new.submission_authorized_at:=clock_timestamp(); end if;
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

-- The first submission marker remains sticky, including corrected local refusals.
create or replace function public.prepare_whatsapp_template_provision(p_job_id uuid,p_fence uuid,p_generation bigint)
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
  if v_authorization is not null then
    update app_private.whatsapp_template_revalidation_authorizations set consumed_at=v_now,consumed_claim_token=p_fence where id=v_authorization and consumed_at is null;
    if not found then raise exception 'template_management_authorization_consumed' using errcode='PT409'; end if;
  end if;
  update public.whatsapp_remote_templates set submission_attempted_at=coalesce(submission_attempted_at,v_now),local_status='submitting' where id=t.id;
  update public.whatsapp_template_jobs set state='posting',post_capture_id=a.sync_capture_id,posting_started_at=v_now,claimed_until=v_now+interval '90 seconds',attempts=attempts+1 where id=j.id and claim_token=p_fence;
  return true;
end $$;
revoke all on function public.prepare_whatsapp_template_provision(uuid,uuid,bigint) from public,anon,authenticated,service_role;
grant execute on function public.prepare_whatsapp_template_provision(uuid,uuid,bigint) to service_role;

create or replace function public.finish_whatsapp_template_job(p_job_id uuid,p_fence uuid,p_result jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare j public.whatsapp_template_jobs%rowtype; v_outcome text:=p_result->>'outcome'; v_reason text:=p_result->>'reason'; v_now timestamptz; v_provider text; v_wait integer; t public.whatsapp_remote_templates%rowtype;
begin
  if jsonb_typeof(p_result) is distinct from 'object' or (p_result-array['outcome','reason','retry_after_seconds'])<>'{}'::jsonb or v_outcome is null or v_reason is null or not ((v_outcome='local_preflight_refused' and v_reason in('final_service_suspended','final_channel_changed','final_gate_paused')) or (v_outcome='accepted' and v_reason='provider_accepted') or (v_outcome='uncertain' and v_reason in('post_ambiguous','response_invalid','post_lease_expired')) or (v_outcome='rejected' and v_reason in('documented_preproxy_429','provider_rejected','auth_rejected','template_rejected'))) then raise exception 'template_result_invalid' using errcode='22023'; end if;
  -- No earlier locks after job. Provider read is informational, never FOR SHARE.
  select b.provider into v_provider from public.whatsapp_template_bindings b join public.whatsapp_template_jobs tj on tj.binding_id=b.id and tj.binding_generation=b.generation where tj.id=p_job_id;
  select * into j from public.whatsapp_template_jobs where id=p_job_id for update;
  if not found or j.claim_token is distinct from p_fence then return false; end if;
  v_now:=clock_timestamp();
  if v_outcome='local_preflight_refused' then
    if (p_result-array['outcome','reason'])<>'{}'::jsonb or j.operation<>'provision' or j.state<>'posting' or j.posting_started_at is null or j.claimed_until<=v_now or j.attempts<1 or j.provider_outcome='accepted' then return false; end if;
    -- Template identity/hash/first marker are immutable; no earlier lock after job.
    select * into t from public.whatsapp_remote_templates where account_id=j.account_id and logical_id=j.target_key and version=1 and language='pt_BR';
    if j.attempts=1 and j.provider_outcome is null and j.post_capture_id is not null and t.id is not null and t.submission_attempted_at is not null then
      insert into app_private.whatsapp_template_zero_post_evidence(job_id,account_id,target_key,target_template_id,target_hash,target_version,job_revision,binding_id,binding_generation,claim_token,posting_started_at,post_capture_id,first_submission_attempted_at,attempts_before_reset,attempts_after_reset,refused_at,reason)
      values(j.id,j.account_id,j.target_key,t.id,t.desired_hash,t.version,j.revision,j.binding_id,j.binding_generation,p_fence,j.posting_started_at,j.post_capture_id,t.submission_attempted_at,1,0,v_now,v_reason);
    end if;
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

notify pgrst,'reload schema';
commit;
