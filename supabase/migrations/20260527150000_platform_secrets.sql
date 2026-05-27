-- Tabela para secrets da plataforma (Stripe, futuras integrações).
--
-- Padrão idêntico a whatsapp_channels / ai_provider_credentials:
-- FORCE RLS sem policies → acesso EXCLUSIVO via Edge Function com service_role.
-- Frontend NUNCA lê o valor — só last4 + metadata via manage-platform-secrets.
--
-- Diferença das *_credentials (que são per-unit): esta tabela é global da
-- plataforma. Cada secret tem key única (ex: 'stripe_secret_key').

begin;

create table if not exists platform_secrets (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique,
  value       text not null,
  last4       text not null,
  description text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table platform_secrets enable row level security;
alter table platform_secrets force row level security;

comment on table platform_secrets is
  'Secrets globais da plataforma (Stripe, etc). FORCE RLS sem policies — só service_role acessa via Edge Function. Frontend só vê last4.';

commit;
