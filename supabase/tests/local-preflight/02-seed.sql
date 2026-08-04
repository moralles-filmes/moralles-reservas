-- Dados mínimos, com ids fixos para os casos poderem se referir a eles.
-- Duas organizações: a segunda existe só para o caso NOTE-D.3 (tenant cruzado).

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'admin1@teste.local'),
  ('22222222-2222-2222-2222-222222222222', 'admin2@teste.local')
on conflict do nothing;

insert into organizations (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Org A'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'Org B')
on conflict do nothing;

insert into units (id, organization_id, name) values
  ('bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'Unidade A1')
on conflict do nothing;

-- Instância COM notes: é a que o backfill da 096 tem de capturar.
insert into whatsapp_instances
  (id, organization_id, unit_id, provider, provider_instance_ref, lifecycle_state,
   notes, created_by, created_at)
values
  ('cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-000000000001', 'zapi', 'REF-A1', 'ACTIVE',
   'observacao original da instancia A1', '11111111-1111-1111-1111-111111111111',
   '2026-07-01 10:00:00-03')
on conflict do nothing;

-- Instância SEM notes: o backfill NÃO pode criar linha para ela.
insert into whatsapp_instances
  (id, organization_id, provider, lifecycle_state, notes, created_by)
values
  ('cccccccc-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001',
   'zapi', 'ACTIVE', null, '11111111-1111-1111-1111-111111111111')
on conflict do nothing;

-- Instância só com espaços em notes: btrim(notes) <> '' tem de excluí-la.
insert into whatsapp_instances
  (id, organization_id, provider, lifecycle_state, notes, created_by)
values
  ('cccccccc-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001',
   'zapi', 'ACTIVE', '   ', '11111111-1111-1111-1111-111111111111')
on conflict do nothing;

-- Segunda instância viva da MESMA organização: alvo do caso NOTE-C.6.
insert into whatsapp_instances
  (id, organization_id, provider, lifecycle_state, created_by)
values
  ('cccccccc-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000001',
   'zapi', 'ACTIVE', '11111111-1111-1111-1111-111111111111')
on conflict do nothing;

-- Instância descartável: será APAGADA no caso NOTE-B.
insert into whatsapp_instances
  (id, organization_id, provider, lifecycle_state, created_by)
values
  ('cccccccc-0000-0000-0000-000000000009', 'aaaaaaaa-0000-0000-0000-000000000001',
   'zapi', 'ACTIVE', '11111111-1111-1111-1111-111111111111')
on conflict do nothing;
