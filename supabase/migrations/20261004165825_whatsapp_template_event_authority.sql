-- Fence the authority captured by the webhook in the event transaction.
begin;

-- Internal shared writer. Callers must already own account then exact binding locks.
create or replace function app_private.record_whatsapp_template_events_core(p_account_id uuid,p_binding_id uuid,p_events jsonb)
returns integer language plpgsql security definer set search_path='' as $$
declare e jsonb; v_inserted integer; v_count integer:=0; v_revision bigint; v_job uuid;
begin
  if jsonb_typeof(p_events) is distinct from 'array' or jsonb_array_length(p_events) not between 1 and 100 then raise exception 'template_events_invalid' using errcode='22023'; end if;
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
    v_job:=public.enqueue_whatsapp_template_job(p_binding_id,'sync','account',v_revision);
  end if;
  return v_count;
end $$;
revoke all on function app_private.record_whatsapp_template_events_core(uuid,uuid,jsonb) from public,anon,authenticated,service_role;

-- Compatibility wrapper: same validation, ordered first binding and ACL as before.
create or replace function public.record_whatsapp_template_events(p_account_id uuid,p_events jsonb)
returns integer language plpgsql security definer set search_path='' as $$
declare v_org uuid; v_binding uuid;
begin
  if jsonb_typeof(p_events) is distinct from 'array' or jsonb_array_length(p_events) not between 1 and 100 then raise exception 'template_events_invalid' using errcode='22023'; end if;
  select organization_id into v_org from public.whatsapp_template_accounts where id=p_account_id for update;
  if not found then raise exception 'template_account_refused' using errcode='42501'; end if;
  -- Account is exclusive: all prepare/sync operations take it before binding/template.
  select id into v_binding from public.whatsapp_template_bindings where account_id=p_account_id order by id limit 1 for share;
  if not found then raise exception 'template_binding_refused' using errcode='42501'; end if;
  return app_private.record_whatsapp_template_events_core(p_account_id,v_binding,p_events);
end $$;
revoke all on function public.record_whatsapp_template_events(uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.record_whatsapp_template_events(uuid,jsonb) to service_role;

create or replace function public.record_whatsapp_template_events_fenced(p_capture jsonb,p_events jsonb)
returns integer language plpgsql security definer set search_path='' as $$
declare a public.whatsapp_template_accounts%rowtype; b public.whatsapp_template_bindings%rowtype;
  c public.whatsapp_channels%rowtype; v_account uuid; v_binding uuid; v_verified timestamptz; k text;
begin
  -- Assertions of backend capture only; no body-selected tenant or authority.
  -- PT503 is a terminal HTTP refusal; 40001 would trigger PostgREST transaction retries.
  if jsonb_typeof(p_capture) is distinct from 'object' or
    (p_capture-array['accountId','wabaId','organizationId','unitOrganizationId','channelId','unitId','provider','phoneNumberId','verifiedAt','credentialRevision','bindingCredentialRevision','bindingId','bindingGeneration','accountGeneration'])<>'{}'::jsonb then
    raise exception 'template_authority_changed' using errcode='PT503';
  end if;
  foreach k in array array['accountId','wabaId','organizationId','unitOrganizationId','channelId','unitId','provider','phoneNumberId','verifiedAt','bindingId'] loop
    if jsonb_typeof(p_capture->k) is distinct from 'string' or length(p_capture->>k) not between 1 and 512 then
      raise exception 'template_authority_changed' using errcode='PT503';
    end if;
  end loop;
  foreach k in array array['credentialRevision','bindingCredentialRevision','bindingGeneration','accountGeneration'] loop
    if jsonb_typeof(p_capture->k) is distinct from 'number' or (p_capture->>k)!~'^[0-9]+$' then
      raise exception 'template_authority_changed' using errcode='PT503';
    end if;
  end loop;
  begin
    v_account:=(p_capture->>'accountId')::uuid; v_binding:=(p_capture->>'bindingId')::uuid;
    v_verified:=(p_capture->>'verifiedAt')::timestamptz;
  exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
    raise exception 'template_authority_changed' using errcode='PT503';
  end;
  -- No writes before all assertions. The channel SHARE lock fences rotation until commit.
  select * into a from public.whatsapp_template_accounts where id=v_account for update;
  select * into b from public.whatsapp_template_bindings where id=v_binding for share;
  select * into c from public.whatsapp_channels where id=b.channel_id for share;
  if a.id is null or b.id is null or c.id is null or a.verified_at is null or b.verified_at is null
    or a.id is distinct from b.account_id or b.channel_id is distinct from c.id
    or (b.unit_id,b.provider) is distinct from (c.unit_id,c.provider)
    or a.waba_id is distinct from p_capture->>'wabaId'
    or a.organization_id::text is distinct from p_capture->>'organizationId'
    or a.organization_id::text is distinct from p_capture->>'unitOrganizationId'
    or not exists(select from public.units u where u.id=c.unit_id and u.organization_id=a.organization_id)
    or c.id::text is distinct from p_capture->>'channelId' or c.unit_id::text is distinct from p_capture->>'unitId'
    or c.provider is distinct from p_capture->>'provider'
    or c.credentials->>'phone_number_id' is distinct from p_capture->>'phoneNumberId'
    or b.verified_at is distinct from v_verified
    or b.generation::text is distinct from p_capture->>'bindingGeneration'
    or a.binding_generation::text is distinct from p_capture->>'accountGeneration'
    or c.template_credential_revision::text is distinct from p_capture->>'credentialRevision'
    or b.channel_credential_revision::text is distinct from p_capture->>'bindingCredentialRevision'
    or b.channel_credential_revision is distinct from c.template_credential_revision then
    raise exception 'template_authority_changed' using errcode='PT503';
  end if;
  return app_private.record_whatsapp_template_events_core(a.id,b.id,p_events);
end $$;
revoke all on function public.record_whatsapp_template_events_fenced(jsonb,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.record_whatsapp_template_events_fenced(jsonb,jsonb) to service_role;
commit;
