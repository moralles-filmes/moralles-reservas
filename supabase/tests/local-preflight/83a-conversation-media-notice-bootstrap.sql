-- 83a: base do pré-voo 83 (aviso de mídia na rajada).
--
-- Contêiner EXCLUSIVO `public.ecr.aws/supabase/postgres:17.11.0.004`,
-- `--network none`, banco `postgres` recém-criado. Roda como `postgres` (README §83).
-- Projeta só o mínimo de `public.conversations` que as RPCs tocam
-- (id, messages jsonb, ai_lock_until, last_message_at, updated_at), no formato
-- de produção, mais os default privileges do Supabase (EXECUTE em funções novas
-- de `public` para anon/authenticated/service_role), para o `revoke` da migration
-- ter o que tirar e o caso 8312 medir ACL de verdade.
-- Recusa rodar se a migration já foi aplicada. Não reaplicar.
\set ON_ERROR_STOP on

do $$
begin
  if to_regprocedure('public.record_conversation_media(uuid,jsonb,boolean,integer,integer)') is not null then
    raise exception '83a exige rodar ANTES da migration 20261105120000: recrie o banco.';
  end if;
end $$;

alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant execute on functions to anon, authenticated, service_role;

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  messages jsonb not null default '[]'::jsonb,
  ai_lock_until timestamptz,
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.conversations enable row level security;
