-- Safe aggregate observation only; no payload/credentials leave the inbox.
create or replace function public.observe_whatsapp_ops_alerts(p_unit_id uuid default null)
returns jsonb language sql stable security invoker set search_path = public
as $$
  with units_seen as (
    select distinct unit_id from public.whatsapp_inbound_events where p_unit_id is null or unit_id = p_unit_id
    union select p_unit_id where p_unit_id is not null
  ), observations as (
    select u.unit_id,
      (select jsonb_object_agg(a.alert_type, a.last_sent_at) from public.whatsapp_ops_alerts a where a.unit_id = u.unit_id) as last_sent,
      count(*) filter (where e.status = 'dead' and e.updated_at > coalesce(d.last_watermark, '-infinity'::timestamptz)) as new_dead,
      max(e.updated_at) filter (where e.status = 'dead' and e.updated_at > coalesce(d.last_watermark, '-infinity'::timestamptz)) as watermark,
      min(e.received_at) filter (where e.status in ('received','processing')) as oldest
    from units_seen u
    left join public.whatsapp_inbound_events e on e.unit_id = u.unit_id
    left join public.whatsapp_ops_alerts d on d.unit_id = u.unit_id and d.alert_type = 'inbound_dead_letter'
    group by u.unit_id
  ) select jsonb_build_object('now', now(), 'units', coalesce(jsonb_agg(jsonb_build_object(
    'unitId', unit_id, 'channelId', null, 'newDeadSince', new_dead,
    'deadWatermark', watermark, 'oldestNonTerminalAt', oldest, 'lastSent', coalesce(last_sent, '{}'::jsonb)
  )), '[]'::jsonb)) from observations;
$$;
revoke all on function public.observe_whatsapp_ops_alerts(uuid) from public, anon, authenticated;
grant execute on function public.observe_whatsapp_ops_alerts(uuid) to service_role;
