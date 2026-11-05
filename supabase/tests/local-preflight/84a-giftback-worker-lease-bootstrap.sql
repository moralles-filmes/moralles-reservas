-- 84a: o mínimo que a 20261106120000 (lease do worker de giftback) referencia.
--
-- Roda como `postgres` num contêiner `supabase/postgres` novo (README §84),
-- que já traz `anon`, `authenticated` e `service_role`. Em produção o schema
-- `app_private` existe desde a 106; aqui nasce vazio, sem USAGE para os papéis
-- de API (estado de produção).
\set ON_ERROR_STOP on
create schema if not exists app_private;
revoke all on schema app_private from public, anon, authenticated;
