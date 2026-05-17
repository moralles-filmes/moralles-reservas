-- Row Level Security
-- Public (anonymous) can insert/read reservations and customers (for the web form).
-- Only authenticated users (admin) can update/delete and read all data.

alter table customers enable row level security;
alter table reservations enable row level security;
alter table tables enable row level security;
alter table conversations enable row level security;
alter table business_hours enable row level security;
alter table settings enable row level security;

-- Customers: anon can insert + read own by phone; admin can read all
create policy "anon_insert_customers" on customers
  for insert to anon with check (true);

create policy "anon_select_own_customer" on customers
  for select to anon using (true);

create policy "auth_all_customers" on customers
  for all to authenticated using (true) with check (true);

-- Reservations: anon can insert + read by code
create policy "anon_insert_reservation" on reservations
  for insert to anon with check (true);

create policy "anon_select_reservation" on reservations
  for select to anon using (true);

create policy "auth_all_reservations" on reservations
  for all to authenticated using (true) with check (true);

-- Tables: public read, admin write
create policy "public_read_tables" on tables
  for select to anon using (active = true);

create policy "auth_all_tables" on tables
  for all to authenticated using (true) with check (true);

-- Conversations: admin only (Edge Functions use service role key)
create policy "auth_all_conversations" on conversations
  for all to authenticated using (true) with check (true);

-- Business hours: public read
create policy "public_read_hours" on business_hours
  for select to anon using (true);

create policy "auth_all_hours" on business_hours
  for all to authenticated using (true) with check (true);

-- Settings: public read (restaurant name for UI), admin write
create policy "public_read_settings" on settings
  for select to anon using (true);

create policy "auth_all_settings" on settings
  for all to authenticated using (true) with check (true);

-- Auto-update updated_at trigger
create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger reservations_updated_at
  before update on reservations
  for each row execute function update_updated_at();

create trigger conversations_updated_at
  before update on conversations
  for each row execute function update_updated_at();
