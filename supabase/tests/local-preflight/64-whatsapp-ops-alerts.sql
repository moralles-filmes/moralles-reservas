-- Disposable PostgreSQL only; run after the minimal fixture below and migration.
-- No Supabase, provider, PostgREST or remote-database claims.
begin;
insert into public.units(id) values ('bbbbbbbb-0064-0000-0000-000000000001'),('bbbbbbbb-0064-0000-0000-000000000002');
insert into public.whatsapp_inbound_events(unit_id,status,received_at,updated_at) values
('bbbbbbbb-0064-0000-0000-000000000001','dead', now()-interval '3 hours',now()-interval '1 hour'),
('bbbbbbbb-0064-0000-0000-000000000001','dead', now()-interval '3 hours',now()-interval '30 minutes'),
('bbbbbbbb-0064-0000-0000-000000000001','received', now()-interval '2 hours',now()),
('bbbbbbbb-0064-0000-0000-000000000002','processing', now()-interval '4 hours',now());
do $$ declare o jsonb; u jsonb; begin
  o:=public.observe_whatsapp_ops_alerts();
  if jsonb_array_length(o->'units')<>2 then raise exception 'unit coverage'; end if;
  o:=public.observe_whatsapp_ops_alerts('bbbbbbbb-0064-0000-0000-000000000001');
  u:=o->'units'->0;
  if (u->>'newDeadSince')::int<>2 or (u->>'deadWatermark')::timestamptz<>now()-interval '30 minutes'
    or (u->>'oldestNonTerminalAt')::timestamptz<>now()-interval '2 hours' then raise exception 'aggregate bounds'; end if;
  if (o->>'now')::timestamptz<>now() then raise exception 'SQL clock'; end if;
end $$;
insert into public.whatsapp_ops_alerts(unit_id,alert_type,last_watermark)
values('bbbbbbbb-0064-0000-0000-000000000001','inbound_dead_letter',now()-interval '1 hour');
do $$ declare o jsonb; begin
  o:=public.observe_whatsapp_ops_alerts('bbbbbbbb-0064-0000-0000-000000000001');
  if (o->'units'->0->>'newDeadSince')::int<>1 then raise exception 'strict watermark'; end if;
  if has_function_privilege('anon','public.observe_whatsapp_ops_alerts(uuid)','execute')
    or has_function_privilege('authenticated','public.observe_whatsapp_ops_alerts(uuid)','execute')
    or not has_function_privilege('service_role','public.observe_whatsapp_ops_alerts(uuid)','execute') then raise exception 'ACL'; end if;
  o:=public.observe_whatsapp_ops_alerts('bbbbbbbb-0064-0000-0000-000000000099');
  if (o->'units'->0->>'newDeadSince')::int<>0 then raise exception 'empty unit'; end if;
  raise notice 'OPS64: coverage, tenant filter, aggregate bounds, strict watermark, SQL clock, ACL passed';
end $$;
rollback;
