-- Migration 049: Push_name do WhatsApp espelhado em conversations.contact_name.
--
-- Os providers (Z-API, WAHA, Meta Cloud) já mandam o nome de perfil do
-- contato no payload de inbound, mas hoje os parsers de webhook descartam
-- esse campo. Esta migration adiciona a coluna que o webhook vai popular
-- a cada mensagem recebida. Serve como fallback de UI quando o cliente
-- ainda não tem nome cadastrado canônico em customers.name.
--
-- Sem backfill: a coluna é preenchida incrementalmente conforme novas
-- mensagens chegam. Conversas antigas continuam null até receber novo
-- inbound.

alter table public.conversations
  add column if not exists contact_name text;

comment on column public.conversations.contact_name is
  'Último push_name (nome de perfil) visto no provider WhatsApp. Atualizado a cada inbound. Fonte autoritativa para exibição é customers.name; este campo é usado como fallback de UI.';
