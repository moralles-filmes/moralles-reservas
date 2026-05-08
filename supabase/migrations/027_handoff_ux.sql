-- UX de handoff humano: evita conversas presas em human_active/awaiting_human
-- sem ninguém da equipe responder.
--
-- O webhook agora:
-- 1. Avisa o cliente (UMA vez a cada 6h) que a mensagem chegou e alguém
--    da equipe vai responder — usa `last_silenced_reply_at` pra throttle.
-- 2. Auto-resolve a conversa (volta pra ai_active) após 12h sem resposta
--    humana, com mensagem "Voltei a te atender".

alter table conversations
  add column if not exists last_silenced_reply_at timestamptz;
