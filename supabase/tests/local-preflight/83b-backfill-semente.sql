-- 83b: semente do backfill da 20261105130100 (ocupação multi-mesa).
--
-- Contêiner PRÓPRIO (as linhas ficam gravadas e mudariam as contagens do
-- 81/82/83): 81a + migrations da planta + 82a + 20261104120000 + 83a +
-- 20261105130000, depois este arquivo, depois a 20261105130100 e o 83c
-- (README §83, "Backfill"). Simula o que o db push encontra em produção:
-- reservas que já se sobrepõem por duração (o índice antigo só barrava o
-- mesmo horário), reserva com mesa de outra unidade, passado e passante
-- esquecido sentado há dias.
\set ON_ERROR_STOP on
begin;
insert into public.tables (id, number, capacity, unit_id, hall_id, min_capacity, max_capacity) values
  ('a0d81000-0000-4000-8000-000000000014', 14, 4, 'a0d81000-0000-4000-8000-0000000000aa', 'a0d81000-0000-4000-8000-000000000001', 1, 4);

-- Amanhã (BRT) em T13: 19:00 confirmada e 19:30 pendente se sobrepõem; a
-- primeira pedida (created_at menor) fica bloqueando e a outra vira
-- overlap_ok. 19:00 cancelada entra sem bloquear. Em T14, 20:00 sozinha.
insert into public.reservations (id, customer_id, table_id, date, time, party_size, status, reservation_code, unit_id, created_at) values
  ('a0d81000-0000-4000-8000-000000000801', 'a0d81000-0000-4000-8000-0000000000f1', 'a0d81000-0000-4000-8000-000000000013',
   (now() at time zone 'America/Sao_Paulo')::date + 1, '19:00', 2, 'confirmed', 'P83B-1', 'a0d81000-0000-4000-8000-0000000000aa', now() - interval '2 days'),
  ('a0d81000-0000-4000-8000-000000000802', 'a0d81000-0000-4000-8000-0000000000f1', 'a0d81000-0000-4000-8000-000000000013',
   (now() at time zone 'America/Sao_Paulo')::date + 1, '19:30', 2, 'pending', 'P83B-2', 'a0d81000-0000-4000-8000-0000000000aa', now() - interval '1 day'),
  ('a0d81000-0000-4000-8000-000000000803', 'a0d81000-0000-4000-8000-0000000000f1', 'a0d81000-0000-4000-8000-000000000013',
   (now() at time zone 'America/Sao_Paulo')::date + 1, '19:00', 2, 'cancelled', 'P83B-3', 'a0d81000-0000-4000-8000-0000000000aa', now()),
  ('a0d81000-0000-4000-8000-000000000804', 'a0d81000-0000-4000-8000-0000000000f1', 'a0d81000-0000-4000-8000-000000000014',
   (now() at time zone 'America/Sao_Paulo')::date + 1, '20:00', 2, 'confirmed', 'P83B-4', 'a0d81000-0000-4000-8000-0000000000aa', now()),
  -- Mesa de B numa reserva de A (antes do guard novo): fica de fora.
  ('a0d81000-0000-4000-8000-000000000805', 'a0d81000-0000-4000-8000-0000000000f1', 'a0d81000-0000-4000-8000-000000000031',
   (now() at time zone 'America/Sao_Paulo')::date + 1, '19:00', 2, 'confirmed', 'P83B-5', 'a0d81000-0000-4000-8000-0000000000aa', now()),
  -- Passado (antes de ontem): fica de fora.
  ('a0d81000-0000-4000-8000-000000000806', 'a0d81000-0000-4000-8000-0000000000f1', 'a0d81000-0000-4000-8000-000000000014',
   (now() at time zone 'America/Sao_Paulo')::date - 5, '19:00', 2, 'confirmed', 'P83B-6', 'a0d81000-0000-4000-8000-0000000000aa', now());

-- Passante esquecido sentado há 3 dias, sem liberar: fica de fora.
insert into public.walk_ins (id, unit_id, customer_name, party_size, status, table_id, seated_at) values
  ('a0d81000-0000-4000-8000-000000000901', 'a0d81000-0000-4000-8000-0000000000aa', 'Esquecido', 2, 'seated',
   'a0d81000-0000-4000-8000-000000000014', now() - interval '3 days');
commit;
