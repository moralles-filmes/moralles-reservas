-- Adopt one failed pre-ledger notification after a pinned automation POST is accepted.
begin;
set local lock_timeout='5s';

create or replace function public.reconcile_whatsapp_automation_acceptance(p_job_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  j public.whatsapp_automation_jobs%rowtype;
  c public.customers%rowtype;
  v_customer uuid;
  v_unit uuid;
  v_fence uuid;
  v_conversation uuid;
  v_notification uuid;
  v_legacy_notification uuid;
  v_count integer;
  v_history text;
begin
  -- Discovery is not authority: reread the job after every parent wait.
  select * into j from public.whatsapp_automation_jobs where id=p_job_id;
  if not found then
    return jsonb_build_object('state','not_accepted','reason','job_not_found');
  end if;
  v_customer:=j.customer_id; v_unit:=j.unit_id; v_fence:=j.claim_token;
  if v_customer is not null then
    select * into c from public.customers where id=v_customer for update;
    if j.kind in('waitlist_feedback','voucher_issued') then
      perform 1 from public.whatsapp_promotion_slots
        where unit_id=v_unit and customer_id=v_customer and job_id=p_job_id
          and claim_token=v_fence for update;
    end if;
  end if;
  select * into j from public.whatsapp_automation_jobs where id=p_job_id for update;
  if not found then
    return jsonb_build_object('state','not_accepted','reason','job_not_found');
  end if;
  if j.pin_phase is distinct from 'bound' or j.state not in('accepted','reconciled') then
    return jsonb_build_object('state','not_accepted','reason','acceptance_not_recorded');
  end if;
  -- A formerly complete projection can lose its channel FK later. Any new
  -- deferral must remain visible even when the job was locally reconciled.
  update public.whatsapp_automation_jobs set state='accepted',reconcile_required=true where id=j.id;
  if j.posting_started_at is null or j.claim_token is null or j.finished_at is null
    or j.provider_message_id is null or char_length(j.provider_message_id) not between 1 and 512
    or j.provider_message_id ~ '[[:cntrl:]]' then
    return jsonb_build_object('state','deferred','reason','acceptance_evidence_missing');
  end if;
  -- Do not acquire a different earlier parent after the job lock.
  if j.unit_id is distinct from v_unit or j.claim_token is distinct from v_fence
    or (j.customer_id is distinct from v_customer and j.customer_erased_at is null) then
    return jsonb_build_object('state','deferred','reason','acceptance_identity_changed');
  end if;
  if not exists(select from public.units where id=j.unit_id and organization_id=j.organization_id) then
    return jsonb_build_object('state','deferred','reason','customer_scope_invalid');
  end if;
  if j.customer_erased_at is not null then
    if j.customer_id is not null or j.safe_log_body is not null then
      return jsonb_build_object('state','deferred','reason','customer_scope_invalid');
    end if;
    v_history:='skipped_erased';
  elsif j.customer_id is null then
    -- Only an operational entry may never have had a known customer.
    if j.kind not in('waitlist_entered','waitlist_table_ready') then
      return jsonb_build_object('state','deferred','reason','customer_scope_invalid');
    end if;
    v_history:='skipped_no_customer';
  elsif c.id is distinct from j.customer_id or c.deleted_at is not null
    or c.organization_id is distinct from j.organization_id then
    return jsonb_build_object('state','deferred','reason','customer_scope_invalid');
  elsif j.safe_log_body is null or char_length(j.safe_log_body) not between 1 and 4096 then
    return jsonb_build_object('state','deferred','reason','acceptance_evidence_missing');
  else
    v_history:='recorded';
  end if;

  -- Historical channel identity is retained. Never substitute the active channel.
  if not exists(select from public.whatsapp_channels where id=j.channel_id and unit_id=j.unit_id) then
    return jsonb_build_object('state','deferred','reason','notification_channel_missing');
  end if;
  -- The pre-ledger sender may have left one failed row under the natural key.
  -- Adopt only that unaccepted projection; never erase delivered/read evidence.
  -- The job lock is already held, and the row lock serializes concurrent repairs.
  select n.id into v_legacy_notification from public.notifications_sent n
    where n.unit_id=j.unit_id and n.kind=j.kind
      and (j.reservation_id is not null or j.waitlist_id is not null)
      and n.reservation_id is not distinct from j.reservation_id
      and n.waitlist_id is not distinct from j.waitlist_id
    for update;
  if v_legacy_notification is not null and v_legacy_notification<>j.notification_id then
    update public.notifications_sent n set
      id=j.notification_id,status='sent',sent_at=j.finished_at,error=null,failed_at=null,
      whatsapp_provider=j.provider,whatsapp_channel_id=j.channel_id,
      provider_message_id=j.provider_message_id
      where n.id=v_legacy_notification and n.unit_id=j.unit_id and n.kind=j.kind
        and n.reservation_id is not distinct from j.reservation_id
        and n.waitlist_id is not distinct from j.waitlist_id
        and n.status='failed' and n.provider_message_id is null
        and n.delivered_at is null and n.read_at is null
        and not exists (select from public.notifications_sent other where other.id=j.notification_id)
      returning n.id into v_notification;
    if v_notification is distinct from j.notification_id then
      return jsonb_build_object('state','deferred','reason','notification_conflict');
    end if;
  else
    insert into public.notifications_sent(id,unit_id,reservation_id,waitlist_id,kind,status,sent_at,
      whatsapp_provider,whatsapp_channel_id,provider_message_id)
      values(j.notification_id,j.unit_id,j.reservation_id,j.waitlist_id,j.kind,'sent',j.finished_at,
        j.provider,j.channel_id,j.provider_message_id)
      on conflict do nothing;
  end if;
  -- Exact frozen UUID plus resource and all four correlation fields. A legacy
  -- row with prior acceptance evidence remains a visible conflict.
  update public.notifications_sent n set sent_at=n.sent_at
    where n.id=j.notification_id and n.unit_id=j.unit_id and n.kind=j.kind
      and n.reservation_id is not distinct from j.reservation_id
      and n.waitlist_id is not distinct from j.waitlist_id
      and n.whatsapp_provider=j.provider and n.whatsapp_channel_id=j.channel_id
      and n.provider_message_id=j.provider_message_id
    returning n.id into v_notification;
  get diagnostics v_count=row_count;
  if v_count<>1 or v_notification is distinct from j.notification_id then
    return jsonb_build_object('state','deferred','reason','notification_conflict');
  end if;

  if v_history='recorded' then
    -- Same unit/customer key as the historical get-or-create helper. Its latest
    -- conversation may change; append's own event dedupe is only per row.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(j.unit_id::text||':'||j.customer_id::text,0));
    if not exists(
      select from public.conversations conversation
        cross join lateral jsonb_array_elements(coalesce(conversation.messages,'[]'::jsonb)) item
      where conversation.unit_id=j.unit_id and conversation.customer_id=j.customer_id
        and item->>'event_id'='automation:'||j.id::text||':accepted'
    ) then
      v_conversation:=public.get_or_create_whatsapp_conversation(j.customer_id,j.unit_id,null,null);
      perform public.append_conversation_message(v_conversation,jsonb_build_object(
        'event_id','automation:'||j.id::text||':accepted','role','assistant','author','automation',
        'content',j.safe_log_body,'timestamp',j.finished_at,'kind',j.kind));
    end if;
  end if;
  -- An exception above rolls back notification/history together, while the
  -- acceptance committed by finish in its earlier transaction remains intact.
  update public.whatsapp_automation_jobs set state='reconciled',reconcile_required=false,error_code=null
    where id=j.id and state in('accepted','reconciled') and provider_message_id=j.provider_message_id;
  get diagnostics v_count=row_count;
  if v_count<>1 then raise exception 'acceptance_projection_changed' using errcode='P0A17'; end if;
  return jsonb_build_object('state','reconciled','history',v_history);
end $$;
revoke all on function public.reconcile_whatsapp_automation_acceptance(uuid) from public,anon,authenticated,service_role;
grant execute on function public.reconcile_whatsapp_automation_acceptance(uuid) to service_role;

commit;
