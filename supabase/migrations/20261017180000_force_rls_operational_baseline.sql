-- FORCE RLS baseline for five existing operational tables. Policies and ACL
-- remain unchanged. Apply only via supabase db push after the Fase 5 gates.
begin;
set local lock_timeout = '5s';

alter table public.reservations force row level security;
alter table public.waitlist force row level security;
alter table public.conversations force row level security;
alter table public.notifications_sent force row level security;
alter table public.rate_limit_events force row level security;

commit;
