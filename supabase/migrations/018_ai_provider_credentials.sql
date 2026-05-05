-- Migration 015: Credenciais de IA por unidade (BYOK).
-- Cada unidade pode cadastrar a própria chave de API do provedor de IA
-- (Claude, OpenAI, Gemini, Grok, DeepSeek). Substitui o fluxo atual de
-- `supabase secrets set` (que vira fallback global).
--
-- Padrão: api_key armazenada em texto, RLS sem policies → leitura só pelo
-- service_role da Edge Function `manage-ai-providers`. Mesmo nível de
-- proteção que `whatsapp_channels.credentials`. FORCE RLS garante que nem
-- mesmo o owner da tabela bypassa as policies.

begin;

create table if not exists ai_provider_credentials (
  id          uuid primary key default gen_random_uuid(),
  unit_id     uuid not null references units(id) on delete cascade,
  provider    text not null
                check (provider in ('claude', 'openai', 'gemini', 'grok', 'deepseek')),
  api_key     text not null,                              -- nunca devolvido ao cliente
  last4       text not null,                              -- exibido na UI como mascaramento
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (unit_id, provider)
);

create index if not exists ai_provider_credentials_unit_idx
  on ai_provider_credentials(unit_id);

alter table ai_provider_credentials enable row level security;
alter table ai_provider_credentials force row level security;

-- Sem policies: nenhum role autenticado lê/escreve direto.
-- Toda interação passa pela Edge Function `manage-ai-providers` (service_role).
-- O webhook lê via service_role na resolução da chave por unit/provider.

commit;
