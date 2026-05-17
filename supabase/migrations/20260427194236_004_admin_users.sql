-- Admin users table — tracks role (super_admin vs admin) for users in auth.users.
-- Writes only happen via the manage-admins Edge Function (service_role bypasses RLS).

create table admin_users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  role text not null default 'admin' check (role in ('admin', 'super_admin')),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);

create index admin_users_role_idx on admin_users (role);

alter table admin_users enable row level security;

-- Authenticated users can read the list (UI shows it; mutating actions are gated by role inside the Edge Function)
create policy "auth_select_admin_users" on admin_users
  for select to authenticated using (true);

-- Seed: mark the initial super admin if the auth account already exists
insert into admin_users (id, email, role)
select id, email, 'super_admin'
from auth.users
where email = 'morallesfilms@gmail.com'
on conflict (id) do update set role = 'super_admin';
