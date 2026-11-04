-- 83a: complemento do 81a/82a para o pré-voo 83 (escolha de mesa).
--
-- Roda como `postgres` DEPOIS do 81a, das migrations 20261030120000/120100,
-- do 82a e da 20261104120000, no mesmo contêiner (README §83). Só acrescenta
-- tabelas que o 81a/82a não projetam; fixtures que mudam contagens do 81/82
-- (como a mesa T14) nascem dentro da transação desfeita do 83.
-- Não reaplicar: cria tudo uma vez.
\set ON_ERROR_STOP on
begin;

-- ─── settings (Task 2: duração da reserva) ───────────────────────────────────
-- Forma das migrations 001 + 013 (unit_id not null, FK, único por unidade).
-- Fora da projeção: RLS, policies e o settings_write_role_guard; as funções
-- da ocupação são DEFINER e só leem a chave reservation_duration_minutes.
create table public.settings (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null,
  key text not null,
  value jsonb not null,
  constraint settings_unit_id_fk foreign key (unit_id) references public.units(id) on delete cascade,
  constraint settings_unit_key_unique unique (unit_id, key));
-- A: 90 min como número (forma da 016). B fica sem a chave (padrão 90).
insert into public.settings (unit_id, key, value) values
  ('a0d81000-0000-4000-8000-0000000000aa', 'reservation_duration_minutes', '90'::jsonb);

-- ─── table_blocks (Task 2: bloqueio por mesa) ────────────────────────────────
-- O 82a projetou só o vínculo (unit_id, hall_id). Produção (migrations 007 e
-- 032): table_id nullable com FK em cascata, blocked_from/blocked_to
-- NOT NULL com CHECK. Aqui ficam nullable sem o CHECK para o 82 seguir
-- inserindo só o vínculo; a RPC compara com `<`/`>` e null nunca bloqueia.
alter table public.table_blocks
  add column table_id uuid references public.tables(id) on delete cascade,
  add column blocked_from timestamptz,
  add column blocked_to timestamptz,
  add column title text,
  add column reason text;

-- ─── whatsapp_channels (Task 3: canal do link de escolha) ────────────────────
-- Forma da 013 reduzida ao que a seat_choice_links e o guard dela leem (id e
-- unit_id NOT NULL com FK em cascata). Fora da projeção: provider, status,
-- credenciais, RLS e grants (o guard é DEFINER). Os canais de A e B nascem
-- dentro da transação desfeita do 83.
create table public.whatsapp_channels (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references public.units(id) on delete cascade,
  display_phone text);

-- ─── Instagram (E2: reserva do contato com mesas juntas, migration 20261105120400) ─
-- Só o que create_instagram_contact_reservation lê e grava (forma das 20261103*):
-- contato (organização, unidade, cliente ligado, anonimização), ledger e o
-- soft delete do cliente. Fora da projeção: RLS, grants, contador de trocas e
-- as demais colunas. O contato de A nasce dentro da transação desfeita do 83.
alter table public.customers add column if not exists deleted_at timestamptz;
-- Colunas da linha que a RPC grava e o 81a não projeta (nulas: não mudam o 81/82).
alter table public.reservations
  add column if not exists payment_status text,
  add column if not exists payment_amount_cents integer,
  add column if not exists payment_expires_at timestamptz,
  add column if not exists applied_discount_percent integer,
  add column if not exists source text;
create table public.instagram_contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  unit_id uuid not null references public.units(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  anonymized_at timestamptz);
create table public.instagram_contact_reservations (
  reservation_id uuid primary key references public.reservations(id) on delete cascade,
  instagram_contact_id uuid not null references public.instagram_contacts(id) on delete cascade,
  unit_id uuid not null references public.units(id) on delete cascade);

commit;
