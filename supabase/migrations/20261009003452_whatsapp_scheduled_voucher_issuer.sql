-- Only a current producer INSERT winner may originate a voucher announcement.
-- Historical birthday/visit/cooldown selection remains the internal producer's
-- read-time decision; this transaction revalidates scope, rule, recipient and day.
begin;
create or replace function public.issue_scheduled_whatsapp_voucher(
  p_rule_id uuid, p_customer_id uuid, p_code text, p_expected_rule jsonb
) returns table (
  voucher_id uuid, unit_id uuid, rule_id uuid, customer_id uuid,
  code text, discount_percent integer, status text,
  issued_at timestamptz, created_at timestamptz, expires_at timestamptz, job_id uuid
) language plpgsql security definer set search_path='' as $$
declare
  c public.customers%rowtype;
  r public.voucher_rules%rowtype;
  v public.vouchers%rowtype;
  j public.whatsapp_automation_jobs%rowtype;
  v_org uuid; v_adopted timestamptz; v_selected date; v_final_day date;
  v_issued timestamptz; v_expiry timestamptz; v_deadline timestamptz; v_job_id uuid;
begin
  if p_rule_id is null or p_customer_id is null or p_code is null or btrim(p_code)=''
    or jsonb_typeof(p_expected_rule) is distinct from 'object'
    or not (p_expected_rule ?& array['unit_id','trigger_type','discount_percent','validity_days','visits_required','days_window','selected_brt_day'])
    or (p_expected_rule-array['unit_id','trigger_type','discount_percent','validity_days','visits_required','days_window','selected_brt_day'])<>'{}'::jsonb
    or jsonb_typeof(p_expected_rule->'unit_id') is distinct from 'string'
    or jsonb_typeof(p_expected_rule->'trigger_type') is distinct from 'string'
    or jsonb_typeof(p_expected_rule->'discount_percent') is distinct from 'number'
    or jsonb_typeof(p_expected_rule->'validity_days') is distinct from 'number'
    or jsonb_typeof(p_expected_rule->'visits_required') not in('number','null')
    or jsonb_typeof(p_expected_rule->'days_window') not in('number','null')
    or jsonb_typeof(p_expected_rule->'selected_brt_day') is distinct from 'string'
    or (p_expected_rule->>'selected_brt_day') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    then raise exception 'voucher_assertion_invalid' using errcode='22023'; end if;
  v_selected := (p_expected_rule->>'selected_brt_day')::date;
  if not isfinite(v_selected) or to_char(v_selected,'YYYY-MM-DD')<>p_expected_rule->>'selected_brt_day'
    then raise exception 'voucher_assertion_invalid' using errcode='22023'; end if;

  -- Same customer-first order as erasure/dispatch. No additional tenant-parent
  -- SHARE locks: those current reads are not a tenant-deletion serialization claim.
  select * into c from public.customers where id=p_customer_id for update;
  if not found then raise exception 'voucher_resource_refused' using errcode='42501'; end if;
  select * into r from public.voucher_rules where id=p_rule_id for share;
  if not found or not r.active or r.trigger_type not in('birthday','frequency')
    then raise exception 'voucher_resource_refused' using errcode='42501'; end if;
  select u.organization_id into v_org from public.units u join public.organizations o on o.id=u.organization_id where u.id=r.unit_id;
  if not found or c.organization_id is distinct from v_org or c.deleted_at is not null
    or c.phone is null or c.phone !~ '^[0-9]{10,11}$' or public.normalize_br_phone(c.phone) is distinct from c.phone
    then raise exception 'voucher_resource_refused' using errcode='42501'; end if;
  if (p_expected_rule-'selected_brt_day') is distinct from jsonb_build_object(
    'unit_id',r.unit_id,'trigger_type',r.trigger_type,'discount_percent',r.discount_percent,
    'validity_days',r.validity_days,'visits_required',r.visits_required,'days_window',r.days_window)
    then raise exception 'voucher_rule_changed' using errcode='22023'; end if;
  select a.adopted_at into v_adopted from public.whatsapp_automation_adoptions a where a.unit_id=r.unit_id;
  if not found or v_adopted is null or not isfinite(v_adopted)
    then raise exception 'voucher_adoption_required' using errcode='P0A01'; end if;

  -- One real millisecond instant AFTER the ordered waits. BRT is fixed -03,
  -- independent of session timezone/DST; duration TTL is exactly 604800000ms.
  v_issued := date_trunc('milliseconds', clock_timestamp());
  if v_selected is distinct from ((v_issued at time zone 'UTC')-interval '3 hours')::date
    then raise exception 'voucher_selection_day_changed' using errcode='22023'; end if;
  if v_issued<v_adopted then raise exception 'voucher_before_adoption' using errcode='P0A01'; end if;
  v_expiry := (((((v_issued at time zone 'UTC')-interval '3 hours')::date+r.validity_days)
    + time '23:59:59.999')+interval '3 hours') at time zone 'UTC';
  v_deadline := v_issued + interval '168 hours';
  -- The fresh, unpublished voucher is the sole exception to the existing-resource
  -- lock order. Never reread an old winner: code and natural-key collisions both
  -- mean zero new provenance. Only this INSERT's 23505 is a duplicate.
  begin
    insert into public.vouchers(id,unit_id,rule_id,customer_id,code,discount_percent,status,issued_at,created_at,expires_at)
    values(gen_random_uuid(),r.unit_id,r.id,c.id,p_code,r.discount_percent,'active',v_issued,v_issued,v_expiry)
    returning * into v;
  exception when unique_violation then
    return;
  end;
  v_job_id := public.enqueue_whatsapp_automation(jsonb_build_object(
    'unit_id',v.unit_id,'kind','voucher_issued','voucher_id',v.id,
    'source_event_key',v.id::text,'fact_at',v.created_at,'expires_at',v_deadline));
  -- Any enqueue failure (including 23505), missing row or changed identity aborts
  -- the whole call. No external send takes place inside this transaction.
  select * into j from public.whatsapp_automation_jobs where id=v_job_id;
  if not found or j.unit_id is distinct from v.unit_id or j.organization_id is distinct from v_org
    or j.kind is distinct from 'voucher_issued' or j.voucher_id is distinct from v.id
    or j.customer_id is distinct from v.customer_id or j.reservation_id is not null or j.waitlist_id is not null
    or j.source_event_key is distinct from v.id::text or j.fact_at is distinct from v.created_at
    or j.expires_at is distinct from v_deadline
    then raise exception 'voucher_atomic_provenance_unavailable' using errcode='PT503'; end if;

  -- No relation access after this final real clock. A physical commit or later
  -- HTTP attempt can still cross midnight; the dispatcher owns its final boundary.
  v_final_day := ((clock_timestamp() at time zone 'UTC')-interval '3 hours')::date;
  if v_selected is distinct from v_final_day then
    raise exception 'voucher_selection_day_changed' using errcode='22023';
  end if;
  return query values(v.id,v.unit_id,v.rule_id,v.customer_id,v.code,v.discount_percent,v.status,
    v.issued_at,v.created_at,v.expires_at,v_job_id);
end $$;
revoke all on function public.issue_scheduled_whatsapp_voucher(uuid,uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.issue_scheduled_whatsapp_voucher(uuid,uuid,text,jsonb) to service_role;
commit;
