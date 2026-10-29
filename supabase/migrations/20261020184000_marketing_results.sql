-- Read-only aggregates of existing programs. Nothing in this RPC writes to a send path.
begin;
create or replace function public.get_marketing_results(p_unit_id uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_start timestamptz;
  v_end timestamptz;
  v_retention_start date := (now() at time zone 'America/Sao_Paulo')::date - 89;
  v_giftback jsonb;
  v_managed jsonb := '[]'::jsonb;
  v_legacy bigint;
  v_unknown boolean;
begin
  if auth.role() is distinct from 'authenticated' or v_actor is null or p_unit_id is null
     or not (app_private.is_platform_admin(v_actor) or exists (
       select 1 from public.unit_members m where m.user_id = v_actor and m.unit_id = p_unit_id
         and m.role in ('owner', 'gerente')
     )) or not exists (select 1 from public.units u where u.id = p_unit_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to > p_from + 365 then
    raise exception 'invalid marketing period' using errcode = '22023';
  end if;
  v_start := (p_from::text || 'T00:00:00-03:00')::timestamptz;
  v_end := ((p_to + 1)::text || 'T00:00:00-03:00')::timestamptz;

  -- trigger_type is mutable and vouchers have no immutable origin snapshot.
  -- Never remap historical issuance to the rule's current trigger category.
  with grouped as (
    select v.rule_id, r.name as rule_name,
      count(*) filter (where v.issued_at >= v_start and v.issued_at < v_end) as issued,
      count(*) filter (where v.issued_at >= v_start and v.issued_at < v_end
        and v.used_at is not null) as redeemed_cohort,
      count(*) filter (where v.used_at >= v_start and v.used_at < v_end) as redeemed_in_period
    from public.vouchers v
    left join public.voucher_rules r on r.id = v.rule_id and r.unit_id = v.unit_id
    where v.unit_id = p_unit_id and ((v.issued_at >= v_start and v.issued_at < v_end)
      or (v.used_at >= v_start and v.used_at < v_end))
    group by v.rule_id, r.name
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'program', 'giftback_rule', 'rule_id', g.rule_id, 'rule_name', g.rule_name,
    'issued', g.issued, 'redeemed_cohort', g.redeemed_cohort,
    'redeemed_in_period', g.redeemed_in_period
  ) order by g.rule_name nulls last, g.rule_id), '[]'::jsonb) into v_giftback from grouped g;

  select exists(select 1 from public.vouchers v where v.unit_id = p_unit_id and v.rule_id is null
    and ((v.issued_at >= v_start and v.issued_at < v_end)
      or (v.used_at >= v_start and v.used_at < v_end))) into v_unknown;

  -- Only a complete period inside the retained job/receipt window is measurable.
  if p_from >= v_retention_start then
    with observed as (
      select j.id, j.state, j.kind,
        case when j.provider in ('official', 'datafy') and j.transport = 'template' then 'official'
          when j.provider in ('zapi', 'waha', 'uazapi') and j.transport = 'text' then 'text'
          else 'unbound' end as channel_kind,
        case when j.kind = 'waitlist_feedback' then 'waitlist_feedback'
          else 'giftback_rule' end as program,
        v.rule_id, r.name as rule_name,
        (j.state in ('accepted', 'reconciled') or n.status in ('sent', 'delivered', 'read')
          or exists(select 1 from public.whatsapp_automation_receipt_events e
            where e.unit_id = j.unit_id and e.provider = j.provider and e.channel_id = j.channel_id
              and e.provider_message_id = j.provider_message_id and e.processing_state = 'processed'
              and e.status in ('sent', 'delivered', 'read', 'failed'))) as accepted,
        exists(select 1 from public.whatsapp_automation_receipt_events e
          where e.unit_id = j.unit_id and e.provider = j.provider and e.channel_id = j.channel_id
            and e.provider_message_id = j.provider_message_id and e.processing_state = 'processed'
            and e.status in ('delivered', 'read')) as delivered,
        exists(select 1 from public.whatsapp_automation_receipt_events e
          where e.unit_id = j.unit_id and e.provider = j.provider and e.channel_id = j.channel_id
            and e.provider_message_id = j.provider_message_id and e.processing_state = 'processed'
            and e.status = 'read') as read_receipt
      from public.whatsapp_automation_jobs j
      left join public.vouchers v on v.id = j.voucher_id and v.unit_id = j.unit_id
      left join public.voucher_rules r on r.id = v.rule_id and r.unit_id = j.unit_id
      left join public.notifications_sent n on n.id = j.notification_id and n.unit_id = j.unit_id
      where j.unit_id = p_unit_id and j.kind in ('voucher_issued', 'waitlist_feedback')
        and j.fact_at >= v_start and j.fact_at < v_end
    ), grouped as (
      select channel_kind, program, rule_id, rule_name, count(*) as intentions,
        count(*) filter (where accepted) as accepted,
        count(*) filter (where delivered) as delivered,
        count(*) filter (where read_receipt) as read_count,
        count(*) filter (where state = 'uncertain') as uncertain,
        count(*) filter (where state in ('queued', 'claimed', 'posting', 'retry_wait', 'paused', 'needs_review')) as pending,
        count(*) filter (where state in ('failed', 'rejected', 'blocked', 'expired')) as failed
      from observed group by channel_kind, program, rule_id, rule_name
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'channel_kind', g.channel_kind, 'program', g.program, 'rule_id', g.rule_id, 'rule_name', g.rule_name,
      'intentions', g.intentions,
      'accepted', g.accepted, 'delivered', g.delivered, 'read', g.read_count,
      'uncertain', g.uncertain, 'pending', g.pending, 'failed', g.failed
    ) order by g.channel_kind, g.program, g.rule_id), '[]'::jsonb) into v_managed from grouped g;
  end if;

  -- notifications_sent also holds managed confirmations: exclude their pinned IDs.
  if p_from >= v_retention_start then
    select count(*) into v_legacy from public.notifications_sent n
      where n.unit_id = p_unit_id and n.kind = 'waitlist_feedback'
        and (n.status in ('sent', 'delivered', 'read') or
          (n.status = 'failed' and n.failed_at is not null and n.provider_message_id is not null and
            exists(select 1 from public.whatsapp_automation_receipt_events e
              where e.unit_id = n.unit_id and e.provider = n.whatsapp_provider
                and e.channel_id = n.whatsapp_channel_id and e.provider_message_id = n.provider_message_id
                and e.status = 'failed')))
        and n.sent_at >= v_start and n.sent_at < v_end
        and not exists (select 1 from public.whatsapp_automation_jobs j
          where j.unit_id = n.unit_id and j.notification_id = n.id);
  end if;

  return jsonb_build_object('from', p_from, 'to', p_to,
    'retention_start', v_retention_start, 'managed_available', p_from >= v_retention_start,
    'legacy_available', p_from >= v_retention_start,
    'giftback', v_giftback, 'managed', v_managed,
    'legacy', jsonb_build_object('waitlist_feedback_sent', v_legacy),
    'unknown_giftback_source', v_unknown);
end;
$$;
revoke all on function public.get_marketing_results(uuid,date,date)
  from public, anon, authenticated, service_role;
grant execute on function public.get_marketing_results(uuid,date,date) to authenticated;
commit;
