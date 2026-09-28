-- Fase D (migration 115): o mínimo que a 115 referencia e o 00 não tem.
--
-- SEQUÊNCIA (banco PRÓPRIO `fased115`, ver a seção da 115 no README):
--   00-bootstrap.sql -> 00a-whatsapp-legacy-seed.sql -> 22a (este) -> 115 -> 22 -> 23
--
-- 1. DEFAULT PRIVILEGES — emula o Supabase, que concede ALL nas tabelas novas de
--    `public` a anon/authenticated/service_role. Tem de vir ANTES da 115: é o
--    que faz a tabela nascer com os grants de produção. MEDIDO sem ele: o
--    TP-1b fica vermelho (o `service_role` não tem INSERT na tabela nova) e o
--    TP-10 fica CEGO — verde mesmo com a 115 sem o `revoke` de tabela, porque
--    não haveria grant para revogar. Com o `revoke`, `authenticated` não tem
--    mais o DELETE na tabela: o C-115-4 aceita as duas formas do defeito
--    (zero linhas em silêncio OU 42501). O UPDATE em `customers` do TP-9 vem
--    também do grant do item 4.
-- 2. `customers` fiel MÍNIMO (id, organization_id, name, phone, deleted_at), com
--    RLS e uma policy PERMISSIVA de fixture para `authenticated`: representa "um
--    membro fazendo soft delete pelo PostgREST". Não é a policy de produção.
-- 3. Três clientes: dois da org A (o TP-9 prova "só os dele") e um da org B.
-- 4. Grants de TABELA em tudo que já existe em `public`, como o Supabase dá em
--    produção (ver o comentário no fim do arquivo).

do $$
begin
  if to_regclass('public.whatsapp_ad_touchpoints') is not null then
    raise exception '22a exige rodar ANTES da migration 115: a tabela ja existe e nasceu sem os default privileges, o que muda o que o TP-1b e o TP-10 medem. Recrie o banco.';
  end if;
  if not exists (select 1 from units where id = 'bbbbbbbb-0000-0000-0000-000000000001')
     or not exists (select 1 from whatsapp_channels where id = 'dddddddd-0000-0000-0000-000000000002') then
    raise exception '22a exige 00-bootstrap.sql e 00a-whatsapp-legacy-seed.sql aplicados.';
  end if;
end $$;

alter default privileges in schema public
  grant select, insert, update, delete on tables to anon, authenticated, service_role;

create table if not exists public.customers (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  name            text not null,
  phone           text not null,
  deleted_at      timestamptz
);

alter table public.customers enable row level security;
drop policy if exists customers_fixture_authenticated_all on public.customers;
create policy customers_fixture_authenticated_all on public.customers
  for all to authenticated using (true) with check (true);

insert into public.customers (id, organization_id, name, phone) values
  ('cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'Cliente A1', '11911110001'),
  ('cccccccc-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'Cliente A2', '11911110002'),
  ('cccccccc-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000002', 'Cliente B1', '11911110003')
on conflict (id) do nothing;

-- Grants de TABELA como o Supabase dá em produção, para TODAS as tabelas de
-- `public` que já existem (as do 00 nasceram antes dos default privileges).
-- Sem isto o service_role não lê `units`/`whatsapp_channels` localmente, e o
-- TP-1b — o único caso que grava como o papel de produção — falharia por
-- ACL do harness, não por defeito da 115.
grant select, insert, update, delete on all tables in schema public to anon, authenticated, service_role;
