-- MAIN110: one shared authority algorithm; no persistent snapshot or PII.
begin;
create or replace function app_private.whatsapp_automation_post_core(p_job_id uuid,p_fence uuid,p_generation bigint,p_consent_revision bigint,p_sync_epoch bigint,p_confirm_only boolean,p_expected jsonb)
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
  v_revision bigint; v_decision text; v_selected uuid; v_days integer; v_flag jsonb; v_logical text;
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
        select * into ca from public.whatsapp_template_cost_authorizations x where x.account_id=j.account_id and x.binding_id=j.binding_id and x.binding_generation=j.binding_generation and x.category='MARKETING' and x.valid_from<=clock_timestamp() and x.valid_until>clock_timestamp() and exists(select from public.platform_admins where user_id=x.actor_id) order by x.valid_until desc,x.id limit 1 for share;
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
  v_logical:=case j.kind when 'confirmation' then case when (select applied_discount_percent>0 from public.reservations where id=j.reservation_id) then 'res_confirmacao_desconto_v1' else 'res_confirmacao_v1' end when 'reminder_d1' then 'res_lembrete_dia_v1' when 'survey_d1' then 'res_pesquisa_reserva_v1' when 'waitlist_entered' then 'fila_entrada_v1' when 'waitlist_feedback' then 'fila_feedback_v1' when 'voucher_issued' then 'mkt_voucher_programado_v1' end;
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
        if v_part is distinct from 'null'::jsonb or j.kind<>'waitlist_entered' then
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
    v_key:=case j.kind when 'confirmation' then null when 'voucher_issued' then 'giftback_whatsapp_enabled' else j.kind||'_enabled' end;
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
      if (e_res.id,e_res.unit_id,e_res.customer_id,e_res.status) is distinct from (j.reservation_id,j.unit_id,j.customer_id,'confirmed')
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
  elsif b.id is null or (b.unit_id,b.channel_id,b.provider,b.account_id,b.generation) is distinct from (j.unit_id,j.channel_id,j.provider,j.account_id,j.binding_generation) or b.channel_credential_revision is distinct from ch.template_credential_revision or p_generation is distinct from j.binding_generation or v_selected is distinct from j.channel_id then v_error:='binding_changed';
  elsif not b.dispatch_enabled or b.adopted_at is null or not v_adopted or v_flag is distinct from 'true'::jsonb then v_error:='dispatch_paused';
  elsif ch.id is null or ch.unit_id<>j.unit_id or ch.provider<>j.provider or ch.is_active=false or ch.status<>'connected' or ch.last_health_check_at is null or ch.last_health_check_at<v_now-interval '5 minutes' then v_error:='channel_unavailable';
  elsif v_now>j.expires_at then v_error:='expired';
  elsif j.kind in('waitlist_feedback','voucher_issued') and (j.customer_id is null or v_decision is distinct from 'opt_in' or v_revision is null or p_consent_revision is distinct from v_revision) then v_error:='consent_changed';
  elsif v_decision='opt_out' or p_consent_revision is distinct from v_revision or (p_confirm_only and j.consent_revision is distinct from v_revision) then v_error:='consent_changed';
  elsif j.kind in('waitlist_feedback','voucher_issued') and j.transport='template' and
    (ca.id is null or (ca.account_id,ca.binding_id,ca.binding_generation,ca.category) is distinct from (j.account_id,j.binding_id,j.binding_generation,'MARKETING') or ca.valid_from>v_now or ca.valid_until<=v_now or not v_actor_valid or t.requested_category is distinct from 'MARKETING' or (p_confirm_only and ca.id is distinct from j.cost_authorization_id)) then v_error:='cost_not_authorized';
  elsif j.kind in('waitlist_feedback','voucher_issued') and p_confirm_only and
    (s.id is null or (s.unit_id,s.customer_id,s.job_id,s.claim_token,s.state) is distinct from (j.unit_id,j.customer_id,j.id,p_fence,'reserved') or s.claimed_until<=v_now or s.claimed_until is distinct from j.claimed_until or s.window_until<=v_now or s.window_until is distinct from j.posting_started_at+make_interval(days=>s.window_days)) then v_error:='promotion_frequency';
  elsif j.kind in('waitlist_feedback','voucher_issued') and not p_confirm_only and s.id is not null and
    ((s.state in('accepted','uncertain') and s.window_until>v_now) or
     (s.state='reserved' and v_old_job_posted) or
     (s.state='reserved' and s.window_until>v_now and not v_old_job_exists) or
     (s.state='reserved' and s.job_id<>j.id and s.claimed_until>v_now and v_old_job_exists)) then v_error:='promotion_frequency';
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
  if p_confirm_only then
    if v_error is not null then return '{"allowed":false,"reason":"authority_changed"}'::jsonb; end if;
        if p_expected is not null then
      if j.reservation_id is not null and j.kind in('confirmation','reminder_d1') then
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
    update public.whatsapp_automation_jobs set state=case when v_error in('binding_changed','recipient_changed') then 'needs_review' when v_error='dispatch_paused' then 'paused' when v_error='expired' then 'expired' else 'blocked' end,error_code=v_error where id=j.id and claim_token=p_fence;
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

revoke all on function app_private.whatsapp_automation_post_core(uuid,uuid,bigint,bigint,bigint,boolean,jsonb) from public,anon,authenticated,service_role;

-- Preserve the existing private interface and both unchanged public five-arg wrappers.
create or replace function app_private.whatsapp_automation_post_core(p_job_id uuid,p_fence uuid,p_generation bigint,p_consent_revision bigint,p_sync_epoch bigint,p_confirm_only boolean)
returns boolean language sql volatile security definer set search_path='' as $$
  select (app_private.whatsapp_automation_post_core(p_job_id,p_fence,p_generation,p_consent_revision,p_sync_epoch,p_confirm_only,null)->>'allowed')::boolean
$$;
revoke all on function app_private.whatsapp_automation_post_core(uuid,uuid,bigint,bigint,bigint,boolean) from public,anon,authenticated,service_role;

create or replace function public.confirm_whatsapp_automation_resource_post(p_job_id uuid,p_fence uuid,p_generation bigint,p_consent_revision bigint,p_sync_epoch bigint,p_expected jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
begin
  if p_expected is null then return '{"allowed":false,"reason":"snapshot_invalid"}'::jsonb; end if;
  return app_private.whatsapp_automation_post_core(p_job_id,p_fence,p_generation,p_consent_revision,p_sync_epoch,true,p_expected);
end $$;
revoke all on function public.confirm_whatsapp_automation_resource_post(uuid,uuid,bigint,bigint,bigint,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.confirm_whatsapp_automation_resource_post(uuid,uuid,bigint,bigint,bigint,jsonb) to service_role;
commit;
