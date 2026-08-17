-- Fixtures anteriores à migration multi-provider para provar o backfill
-- conservador de whatsapp_channels.is_active.

insert into organizations (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Org A'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'Org B'),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'Org C')
on conflict do nothing;

insert into units (id, organization_id, name) values
  ('bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'Unidade A1'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000002', 'Unidade B1'),
  ('bbbbbbbb-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000003', 'Unidade C1')
on conflict do nothing;

-- A: um único canal (inequívoco mesmo desconectado).
insert into whatsapp_channels (id, unit_id, provider, status, display_phone) values
  ('dddddddd-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', 'zapi', 'disconnected', '551100000001')
on conflict do nothing;

-- B: dois canais, mas só um connected (inequívoco).
insert into whatsapp_channels (id, unit_id, provider, status, display_phone) values
  ('dddddddd-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000002', 'zapi', 'connected', '551100000002'),
  ('dddddddd-0000-0000-0000-000000000003', 'bbbbbbbb-0000-0000-0000-000000000002', 'waha', 'disconnected', '551100000003')
on conflict do nothing;

-- C: dois connected; a migration não pode escolher silenciosamente.
insert into whatsapp_channels (id, unit_id, provider, status, display_phone) values
  ('dddddddd-0000-0000-0000-000000000004', 'bbbbbbbb-0000-0000-0000-000000000003', 'zapi', 'connected', '551100000004'),
  ('dddddddd-0000-0000-0000-000000000005', 'bbbbbbbb-0000-0000-0000-000000000003', 'waha', 'connected', '551100000005')
on conflict do nothing;
