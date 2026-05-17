-- 015: Handoff humano em conversations + novas chaves de settings para escopo do agente
--
-- Adiciona controle de status por conversa:
--   ai_active (padrão) — IA responde normalmente
--   awaiting_human — IA pediu transferência; aguardando operador assumir
--   human_active — operador assumiu; IA silenciada
--   resolved — conversa encerrada

alter table conversations
  add column status text not null default 'ai_active'
    check (status in ('ai_active', 'awaiting_human', 'human_active', 'resolved')),
  add column handoff_reason text,
  add column handoff_at timestamptz,
  add column assigned_to uuid references auth.users(id) on delete set null,
  add column last_message_at timestamptz default now();

-- Índice parcial para queries frequentes (excluindo resolved já arquivados)
create index conversations_unit_status_idx
  on conversations(unit_id, status)
  where status <> 'resolved';

-- Backfill: conversas existentes já estavam em modo IA
update conversations set last_message_at = updated_at where last_message_at is null;

-- Novas chaves de settings aceitas (key-value, sem alteração de schema):
--   agent_mode         → 'reservations' | 'reservations_faq'
--   restaurant_menu    → URL ou texto do cardápio
--   delivery_response  → mensagem padrão sobre delivery/take-away
--   restaurant_extra_info → estacionamento, contatos extras, regras da casa
--
-- (Não há alter table necessário — settings já é key/value genérico.)
