-- Minimal disposable PostgreSQL schema. Never run on Supabase/project database.
create role anon;
create role authenticated;
create role service_role bypassrls;
create table public.units(id uuid primary key);
create table public.whatsapp_inbound_events(unit_id uuid, status text, received_at timestamptz, updated_at timestamptz);
create table public.whatsapp_ops_alerts(unit_id uuid, alert_type text, last_sent_at timestamptz default now(), last_watermark timestamptz,
  unique(unit_id,alert_type));
grant usage on schema public to service_role;
grant select on public.whatsapp_inbound_events, public.whatsapp_ops_alerts to service_role;
