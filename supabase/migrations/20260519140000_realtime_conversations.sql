-- 20260519140000_realtime_conversations.sql
-- Garante que `conversations` esteja na publication `supabase_realtime`,
-- pra que o frontend de /g/:unitSlug/conversas receba postgres_changes em
-- tempo real (chegada de mensagem WhatsApp, handoff, etc) sem exigir F5.
--
-- As subscriptions já existem em:
--   - src/hooks/useConversations.ts (lista de conversas)
--   - src/hooks/useAwaitingHumanCount.ts (badge sidebar)
--   - src/pages/gestao/Conversas.tsx (conversa aberta)
--
-- Sem a tabela na publication, o Postgres não emite os eventos e o
-- frontend só atualiza no remount/F5.
--
-- RLS de `conversations` (escopada por unit_member) continua valendo no
-- canal Realtime: cada cliente só recebe linhas que sua sessão pode ler.
-- O subscribe ainda filtra `unit_id=eq.<unitId>` defensivamente.
--
-- Idempotente: usa DO block que ignora erro "table already in publication"
-- (SQLSTATE 42710). Seguro pra rodar várias vezes.

do $$
begin
  begin
    alter publication supabase_realtime add table conversations;
  exception
    when duplicate_object then null;
  end;
end $$;
