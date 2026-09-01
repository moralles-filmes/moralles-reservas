-- Connection callbacks are provider-agnostic in webhook-whatsapp. Keep the
-- privileged projection writer provider-agnostic too, while deriving provider
-- and tenant only from the locked channel row.
create or replace function public.record_whatsapp_channel_status(
  p_unit_id uuid,
  p_channel_id uuid,
  p_status text,
  p_display_phone text default null,
  p_error_code text default null,
  p_actor_id uuid default null,
  p_request_id text default null,
  p_event_type text default null
)
returns table (
  channel_id uuid,
  unit_id uuid,
  provider text,
  status text,
  is_active boolean,
  display_phone text,
  connected_at timestamptz,
  last_health_check_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_channel record;
  v_org_id uuid;
begin
  if p_status is null or p_status not in (
    'waiting_qr', 'connecting', 'connected', 'disconnected',
    'reconnecting', 'suspended', 'provider_error', 'error'
  ) then
    raise exception 'invalid_channel_status' using errcode = '22023';
  end if;
  if p_display_phone is not null and p_display_phone !~ '^[0-9]{10,15}$' then
    raise exception 'invalid_display_phone' using errcode = '22023';
  end if;
  if p_error_code is not null and p_error_code !~ '^[A-Z0-9_]{1,64}$' then
    raise exception 'invalid_error_code' using errcode = '22023';
  end if;
  if p_request_id is not null and
     (length(p_request_id) not between 1 and 128 or p_request_id !~ '^[A-Za-z0-9._:-]+$') then
    raise exception 'invalid_request_id' using errcode = '22023';
  end if;
  if p_event_type is not null and p_event_type not in ('disconnect', 'restart', 'status_changed') then
    raise exception 'invalid_status_event_type' using errcode = '22023';
  end if;

  select c.* into v_channel
  from public.whatsapp_channels c
  where c.id = p_channel_id
    and c.unit_id = p_unit_id
  for update;

  if not found then
    raise exception 'channel_unit_mismatch' using errcode = 'check_violation';
  end if;

  select u.organization_id into v_org_id
  from public.units u where u.id = p_unit_id;
  if v_org_id is null then
    raise exception 'channel_unit_not_found' using errcode = 'check_violation';
  end if;

  update public.whatsapp_channels c
  set status = p_status,
      display_phone = coalesce(p_display_phone, c.display_phone),
      connected_at = case
        when p_status = 'connected' then coalesce(c.connected_at, now())
        else c.connected_at
      end,
      last_health_check_at = now(),
      last_error = case
        when p_status in ('provider_error', 'error') then p_error_code
        else null
      end
  where c.id = p_channel_id;

  if v_channel.status is distinct from p_status
     or v_channel.display_phone is distinct from coalesce(p_display_phone, v_channel.display_phone)
     or p_event_type in ('disconnect', 'restart') then
    insert into public.whatsapp_channel_lifecycle_events (
      organization_id, unit_id, channel_ref, event_type, provider,
      from_status, to_status, error_code, request_id, actor_id
    ) values (
      v_org_id, p_unit_id, p_channel_id,
      case
        when p_status in ('provider_error', 'error') then 'error'
        else coalesce(p_event_type, 'status_changed')
      end,
      v_channel.provider, v_channel.status, p_status,
      p_error_code, p_request_id, p_actor_id
    );
  end if;

  return query
  select c.id, c.unit_id, c.provider, c.status, c.is_active,
         c.display_phone, c.connected_at, c.last_health_check_at
  from public.whatsapp_channels c
  where c.id = p_channel_id;
end;
$$;

revoke all on function public.record_whatsapp_channel_status(uuid, uuid, text, text, text, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.record_whatsapp_channel_status(uuid, uuid, text, text, text, uuid, text, text)
  to service_role;
