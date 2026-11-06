-- Disposable PostgreSQL only (supabase/postgres:17.11.0.004, --network none).
-- Mínimo que a migration 20261107140000 referencia: app_private, units e
-- whatsapp_channels com a FK on delete cascade de produção, FORCE RLS sem policy
-- e o grant de tabela do service_role (único papel que escreve no canal).
-- Recusa rodar depois da migration.
do $$
begin
  if to_regprocedure('app_private.guard_whatsapp_channel_unit()') is not null then
    raise exception '86a: migration 20261107140000 já aplicada; use contêiner novo';
  end if;
end $$;

create schema if not exists app_private;

create table public.organizations(id uuid primary key);
create table public.units(
  id uuid primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade
);
create table public.whatsapp_channels(
  id uuid primary key,
  unit_id uuid not null references public.units(id) on delete cascade,
  provider text not null check (provider in ('zapi','uazapi','official','datafy')),
  status text not null default 'disconnected',
  is_active boolean not null default false,
  display_phone text,
  updated_at timestamptz not null default now()
);
alter table public.whatsapp_channels enable row level security;
alter table public.whatsapp_channels force row level security;
grant select, insert, update, delete on public.whatsapp_channels to service_role;
grant select on public.units to service_role;

insert into public.organizations values ('a0d86000-0000-4000-8000-00000000000a');
insert into public.units values
  ('a0d86000-0000-4000-8000-0000000000a1','a0d86000-0000-4000-8000-00000000000a'),
  ('a0d86000-0000-4000-8000-0000000000a2','a0d86000-0000-4000-8000-00000000000a'),
  ('a0d86000-0000-4000-8000-0000000000a3','a0d86000-0000-4000-8000-00000000000a');
insert into public.whatsapp_channels(id, unit_id, provider) values
  ('a0d86000-0000-4000-8000-0000000000c1','a0d86000-0000-4000-8000-0000000000a1','zapi'),
  ('a0d86000-0000-4000-8000-0000000000c2','a0d86000-0000-4000-8000-0000000000a1','uazapi'),
  ('a0d86000-0000-4000-8000-0000000000c3','a0d86000-0000-4000-8000-0000000000a1','official'),
  ('a0d86000-0000-4000-8000-0000000000c4','a0d86000-0000-4000-8000-0000000000a1','datafy'),
  ('a0d86000-0000-4000-8000-0000000000c5','a0d86000-0000-4000-8000-0000000000a3','zapi');
