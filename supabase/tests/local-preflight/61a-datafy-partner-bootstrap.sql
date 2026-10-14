-- Datafy parceiro (migration 20261014120000): o mínimo que o `61` exercita e o
-- `00` não tem.
--
-- SEQUÊNCIA (banco PRÓPRIO `datafy61`, ver a seção no README):
--   00-bootstrap.sql -> 00a-whatsapp-legacy-seed.sql -> 61a (este) -> migration -> 61
--
-- 1. DEFAULT PRIVILEGES — emula o Supabase, que concede ALL nas tabelas e
--    funções novas de `public` a anon/authenticated/service_role. Tem de vir
--    ANTES da migration: é o que faz as tabelas e as RPCs nascerem com os
--    grants de produção. Sem ele o C9 fica CEGO — verde mesmo com a migration
--    sem os `revoke`, porque não haveria grant explícito para revogar (só o
--    implícito a PUBLIC do `CREATE FUNCTION`). Mesma razão do `22a`.
-- 2. Grants de TABELA em tudo que já existe em `public`, como o Supabase dá em
--    produção. Sem isto o `service_role` não lê `units` localmente, e o C11 —
--    o único caso que grava como o papel de produção, passando pelo guard
--    SECURITY INVOKER — falharia por ACL do harness, não por defeito da
--    migration.
-- 3. O CHECK de `whatsapp_channels.provider` na forma da migration 110, que
--    libera `datafy`. O `00` traz a lista anterior a ela (`zapi`, `waha`,
--    `official`), e o C8 precisa de canal `datafy`. Trazer a 110 inteira
--    exigiria a 087 e a multi-provider (ela reescreve CHECKs de
--    `whatsapp_instances`, `processed_messages`, lifecycle events): sequência
--    mais longa sem veredito novo. Copiado da 110, não inventado.

do $$
begin
  if to_regclass('public.whatsapp_official_connection_grants') is not null then
    raise exception '61a exige rodar ANTES da migration 20261014120000: as tabelas ja existem e nasceram sem os default privileges, o que muda o que o C9 e o C11 medem. Recrie o banco.';
  end if;
  if not exists (select 1 from units where id = 'bbbbbbbb-0000-0000-0000-000000000003')
     or not exists (select 1 from whatsapp_channels where id = 'dddddddd-0000-0000-0000-000000000001') then
    raise exception '61a exige 00-bootstrap.sql e 00a-whatsapp-legacy-seed.sql aplicados.';
  end if;
end $$;

alter default privileges in schema public
  grant select, insert, update, delete on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant execute on functions to anon, authenticated, service_role;

grant select, insert, update, delete on all tables in schema public to anon, authenticated, service_role;

-- Forma da 110 (20260922170000_110_datafy_provider.sql), só para esta tabela.
alter table public.whatsapp_channels
  drop constraint if exists whatsapp_channels_provider_check;
alter table public.whatsapp_channels
  add constraint whatsapp_channels_provider_check
  check (provider in ('zapi', 'uazapi', 'waha', 'official', 'datafy'));
