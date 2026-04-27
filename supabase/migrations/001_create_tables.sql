-- Enable UUID extension
create extension if not exists "pgcrypto";

-- Customers
create table if not exists customers (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  phone       text not null unique,
  email       text,
  created_at  timestamptz not null default now()
);

-- Tables (mesas do restaurante)
create table if not exists tables (
  id          uuid primary key default gen_random_uuid(),
  number      integer not null unique,
  capacity    integer not null,
  location    text not null default 'internal' check (location in ('internal', 'external')),
  active      boolean not null default true
);

-- Reservations
create table if not exists reservations (
  id                uuid primary key default gen_random_uuid(),
  customer_id       uuid not null references customers(id) on delete cascade,
  table_id          uuid references tables(id) on delete set null,
  date              date not null,
  time              time not null,
  party_size        integer not null check (party_size >= 1),
  status            text not null default 'pending'
                      check (status in ('pending', 'confirmed', 'cancelled', 'no_show')),
  notes             text,
  reservation_code  text not null unique,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- WhatsApp conversation history
create table if not exists conversations (
  id             uuid primary key default gen_random_uuid(),
  customer_id    uuid not null references customers(id) on delete cascade,
  reservation_id uuid references reservations(id) on delete set null,
  messages       jsonb not null default '[]',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Business hours
create table if not exists business_hours (
  id             uuid primary key default gen_random_uuid(),
  day_of_week    integer not null unique check (day_of_week between 0 and 6),
  open_time      time not null default '12:00',
  close_time     time not null default '22:00',
  max_party_size integer not null default 20,
  is_closed      boolean not null default false
);

-- Settings (key-value store for restaurant config and AI prompt)
create table if not exists settings (
  id    uuid primary key default gen_random_uuid(),
  key   text not null unique,
  value jsonb not null
);

-- Indexes
create index if not exists reservations_date_idx on reservations(date);
create index if not exists reservations_customer_idx on reservations(customer_id);
create index if not exists reservations_status_idx on reservations(status);
create index if not exists reservations_code_idx on reservations(reservation_code);
create index if not exists conversations_customer_idx on conversations(customer_id);
create index if not exists conversations_updated_idx on conversations(updated_at desc);

-- Seed default business hours (Sun=0 through Sat=6)
insert into business_hours (day_of_week, open_time, close_time, is_closed) values
  (0, '12:00', '16:00', false),  -- Domingo: almoço
  (1, '12:00', '15:00', false),  -- Segunda
  (2, '12:00', '22:00', false),  -- Terça
  (3, '12:00', '22:00', false),  -- Quarta
  (4, '12:00', '22:30', false),  -- Quinta
  (5, '12:00', '23:00', false),  -- Sexta
  (6, '12:00', '23:00', false)   -- Sábado
on conflict (day_of_week) do nothing;

-- Seed default settings
insert into settings (key, value) values
  ('restaurant_name', '"Moralles Restaurante"'),
  ('ai_system_prompt', '"Você é o assistente de reservas do restaurante. Seja cordial, eficiente e direto. Ajude clientes a fazer, consultar, alterar e cancelar reservas."')
on conflict (key) do nothing;
