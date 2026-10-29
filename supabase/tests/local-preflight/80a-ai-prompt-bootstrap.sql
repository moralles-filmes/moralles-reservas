-- 80a: base do pré-voo 80 (camada global do prompt + classe e guard de valor
-- em `settings`).
--
-- RODA DEPOIS DE: 00-bootstrap -> 01-audit -> 09a-advisor-bootstrap -> migration
-- 20260910120000_106 -> 75a-settings-write-acl-bootstrap -> migration
-- 20261019180000_settings_write_role_guard (a base do 75, com o role guard já
-- instalado). Este arquivo NÃO instala nada da migration nova: recusa rodar se
-- ela já foi aplicada, porque as tabelas teriam nascido sem os default
-- privileges abaixo e o P7 mediria outra coisa.
--
-- O que este arquivo acrescenta:
--   * default privileges que emulam o Supabase (ALL nas tabelas novas de
--     `public` e EXECUTE nas funções novas de `public` para anon,
--     authenticated e service_role, como no 22a/61a). Sem eles o `revoke` da
--     migration não teria o que tirar e o P7 ficaria cego;
--   * atores (UUIDs fixos `a0d78000-…`): platform_admin A e B sem membership;
--     U1 com owner, gerente e operador; U2 com gerente; um usuário sem papel;
--   * linhas iniciais de `settings` em U1 (strings válidas para o guard novo).
-- Re-executável enquanto a migration nova não tiver sido aplicada.

do $$
begin
  if to_regclass('public.ai_prompt_versions') is not null then
    raise exception '80a exige rodar ANTES da migration do prompt global: as tabelas ja existem e nasceram sem os default privileges. Recrie o banco.';
  end if;
  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.settings'::regclass
                    and tgname = 'settings_write_role_guard' and not tgisinternal) then
    raise exception '80a exige o 75a e a migration 20261019180000 (settings_write_role_guard ausente).';
  end if;
end $$;

-- ─── Default privileges do Supabase ──────────────────────────────────────────
alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant execute on functions to anon, authenticated, service_role;

-- ─── Atores ──────────────────────────────────────────────────────────────────
-- PA-A (…c1) e PA-B (…c2): platform_admin sem membership.
-- U1: owner (…a1), gerente (…a2), operador (…a3). U2: gerente (…b2).
-- SEM (…e1): autenticado sem papel nenhum.
insert into auth.users (id, email) values
  ('a0d78000-0000-4000-8000-0000000000c1', 'ai78-pa-a@example.test'),
  ('a0d78000-0000-4000-8000-0000000000c2', 'ai78-pa-b@example.test'),
  ('a0d78000-0000-4000-8000-0000000000a1', 'ai78-owner-u1@example.test'),
  ('a0d78000-0000-4000-8000-0000000000a2', 'ai78-gerente-u1@example.test'),
  ('a0d78000-0000-4000-8000-0000000000a3', 'ai78-operador-u1@example.test'),
  ('a0d78000-0000-4000-8000-0000000000b2', 'ai78-gerente-u2@example.test'),
  ('a0d78000-0000-4000-8000-0000000000e1', 'ai78-sem-papel@example.test')
on conflict (id) do nothing;

insert into organizations (id, name) values
  ('a0d78000-0000-4000-8000-00000000000a', 'ai78 org')
on conflict (id) do nothing;

insert into units (id, organization_id, name) values
  ('a0d78000-0000-4000-8000-0000000000aa', 'a0d78000-0000-4000-8000-00000000000a', 'ai78 U1'),
  ('a0d78000-0000-4000-8000-0000000000bb', 'a0d78000-0000-4000-8000-00000000000a', 'ai78 U2')
on conflict (id) do nothing;

insert into unit_members (user_id, unit_id, role) values
  ('a0d78000-0000-4000-8000-0000000000a1', 'a0d78000-0000-4000-8000-0000000000aa', 'owner'),
  ('a0d78000-0000-4000-8000-0000000000a2', 'a0d78000-0000-4000-8000-0000000000aa', 'gerente'),
  ('a0d78000-0000-4000-8000-0000000000a3', 'a0d78000-0000-4000-8000-0000000000aa', 'operador'),
  ('a0d78000-0000-4000-8000-0000000000b2', 'a0d78000-0000-4000-8000-0000000000bb', 'gerente')
on conflict (user_id, unit_id) do nothing;

insert into platform_admins (user_id) values
  ('a0d78000-0000-4000-8000-0000000000c1'),
  ('a0d78000-0000-4000-8000-0000000000c2')
on conflict (user_id) do nothing;

-- Linhas iniciais de U1. O 80 as recoloca nestes valores no começo de cada
-- execução (UPDATE sem linha não dispara trigger e mediria nada).
insert into public.settings (unit_id, key, value)
select 'a0d78000-0000-4000-8000-0000000000aa'::uuid, k, to_jsonb('ai78-inicial-' || k)
  from unnest(array['restaurant_menu', 'delivery_response', 'restaurant_extra_info',
                    'ai_system_prompt', 'ai_context_extra', 'agent_name']) as k
on conflict (unit_id, key) do nothing;
insert into public.settings (unit_id, key, value)
values ('a0d78000-0000-4000-8000-0000000000aa', 'agent_mode', '"reservations"')
on conflict (unit_id, key) do nothing;
