-- 79a: base do pré-voo 79 (módulo Instagram, Fase 1).
--
-- RODA DEPOIS DE: 00-bootstrap -> 01-audit -> 09a-advisor-bootstrap -> migration
-- 20260910120000_106 (a base do 68/75). Ela já traz `organizations`, `units`
-- (com `organization_id`), `unit_members` (com `role`), `platform_admins`,
-- `auth.uid()` lendo `request.jwt.claims` e os helpers `app_private.*` na forma
-- de produção. RODA ANTES das migrations do Instagram, e recusa rodar depois.
--
-- O que este arquivo acrescenta:
--   1. DEFAULT PRIVILEGES de tabela E de função emulando o Supabase (como o
--      61a): ALL nas tabelas novas de `public` e EXECUTE nas funções novas para
--      anon/authenticated/service_role. Sem eles o IG-1.5 fica CEGO: mediria só
--      o grant implícito a PUBLIC do `CREATE FUNCTION`, e uma migration sem os
--      `revoke` de tabela passaria verde.
--   2. Grant de tabela em tudo que já existe em `public`, como o Supabase dá em
--      produção (a policy de UPDATE de `instagram_settings` lê `unit_members`
--      como `authenticated`), e USAGE do schema `auth` para os papéis de API.
--   3. RLS de `unit_members` com as duas policies de produção (013, com os
--      helpers já em `app_private` depois da 106): o `exists` da policy de
--      UPDATE enxerga só o que o papel real enxerga.
--   4. Fixtures (UUIDs fixos `a0d79000-…`): org A com a unidade UA (owner,
--      gerente, operador), org B com a unidade UB (gerente), e um
--      platform_admin sem membership.
-- Re-executável (antes das migrations).

do $$
begin
  if to_regclass('public.unit_module_grants') is not null
     or to_regclass('public.instagram_settings') is not null then
    raise exception '79a exige rodar ANTES da migration 20261020120000_instagram_module_grants: as tabelas ja existem e nasceram sem os default privileges, o que cega o IG-1.5. Recrie o banco (dropdb ig79 / createdb ig79) e siga o README, secao 79.';
  end if;
  if to_regprocedure('app_private.is_unit_member(uuid,uuid)') is null
     or to_regprocedure('app_private.is_platform_admin(uuid)') is null
     or to_regclass('public.unit_members') is null then
    raise exception '79a exige 00 -> 01 -> 09a -> migration 106 aplicados antes.';
  end if;
end $$;

-- ─── 1. Default privileges do Supabase ───────────────────────────────────────
alter default privileges in schema public
  grant select, insert, update, delete on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant execute on functions to anon, authenticated, service_role;

-- ─── 2. Grants de tabela no que já existe ────────────────────────────────────
grant select, insert, update, delete on all tables in schema public to anon, authenticated, service_role;

-- USAGE do schema `auth` para os papéis de API, como no Supabase: o trigger de
-- carimbo de `instagram_settings` é SECURITY INVOKER e resolve `auth.uid()`
-- pelo nome com o papel de quem grava. Sem isto o UPDATE do gerente falharia
-- por ACL do harness (`permission denied for schema auth`), não pela migration.
grant usage on schema auth to anon, authenticated, service_role;

-- ─── 3. RLS de unit_members (forma da 013, helpers em app_private) ──────────
alter table public.unit_members enable row level security;

drop policy if exists "platform_admin_all_unit_members" on public.unit_members;
create policy "platform_admin_all_unit_members" on public.unit_members
  for all to authenticated
  using (app_private.is_platform_admin(auth.uid()))
  with check (app_private.is_platform_admin(auth.uid()));

drop policy if exists "unit_member_read_unit_members" on public.unit_members;
create policy "unit_member_read_unit_members" on public.unit_members
  for select to authenticated
  using (app_private.is_unit_member(auth.uid(), unit_id));

-- ─── 4. Fixtures ─────────────────────────────────────────────────────────────
-- UA (org A): owner …a1, gerente …a2, operador …a3. UB (org B): gerente …b2.
-- PA …c1: platform_admin sem nenhuma linha em unit_members.
insert into auth.users (id, email) values
  ('a0d79000-0000-4000-8000-0000000000a1', 'ig79-owner-a@example.test'),
  ('a0d79000-0000-4000-8000-0000000000a2', 'ig79-gerente-a@example.test'),
  ('a0d79000-0000-4000-8000-0000000000a3', 'ig79-operador-a@example.test'),
  ('a0d79000-0000-4000-8000-0000000000b2', 'ig79-gerente-b@example.test'),
  ('a0d79000-0000-4000-8000-0000000000c1', 'ig79-pa@example.test')
on conflict (id) do nothing;

insert into public.organizations (id, name) values
  ('a0d79000-0000-4000-8000-00000000000a', 'ig79 org A'),
  ('a0d79000-0000-4000-8000-00000000000b', 'ig79 org B')
on conflict (id) do nothing;

insert into public.units (id, organization_id, name) values
  ('a0d79000-0000-4000-8000-0000000000aa', 'a0d79000-0000-4000-8000-00000000000a', 'ig79 UA'),
  ('a0d79000-0000-4000-8000-0000000000bb', 'a0d79000-0000-4000-8000-00000000000b', 'ig79 UB')
on conflict (id) do nothing;

insert into public.unit_members (user_id, unit_id, role) values
  ('a0d79000-0000-4000-8000-0000000000a1', 'a0d79000-0000-4000-8000-0000000000aa', 'owner'),
  ('a0d79000-0000-4000-8000-0000000000a2', 'a0d79000-0000-4000-8000-0000000000aa', 'gerente'),
  ('a0d79000-0000-4000-8000-0000000000a3', 'a0d79000-0000-4000-8000-0000000000aa', 'operador'),
  ('a0d79000-0000-4000-8000-0000000000b2', 'a0d79000-0000-4000-8000-0000000000bb', 'gerente')
on conflict (user_id, unit_id) do nothing;

insert into public.platform_admins (user_id) values ('a0d79000-0000-4000-8000-0000000000c1')
on conflict (user_id) do nothing;
