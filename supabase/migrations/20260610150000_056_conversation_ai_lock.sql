-- Conversation-level atomic TTL lock para serializar o agente IA por conversa.
--
-- Bug: dois inbounds WhatsApp em rajada = duas invocações independentes da Edge
-- Function webhook-whatsapp (sem fila). O debounce otimista (comparação de
-- timestamp) falha em 2 casos — empate de milissegundo; janelas não-sobrepostas
-- — e deixa ambas seguirem. Duas chamadas concorrentes ao LLM na mesma conversa
-- saturam o provider (503/timeout) → ambas caem em agent_error → ambas mandam o
-- handoff ("instabilidade") DUPLICADO.
--
-- Fix: lock TTL por linha (NÃO advisory). pg_try_advisory_lock é session-scoped
-- e não sobrevive ao pooling transaction-mode do PgBouncer num hold de vários
-- segundos atravessando várias chamadas HTTP (o release pode rodar em outro
-- backend). UPDATE condicional na própria linha é atômico por statement,
-- durável, e o TTL auto-expira se a função crashar segurando o lock (mirror de
-- STUCK_PROCESSING_TIMEOUT_MS = 90s). Idempotente.

begin;

-- Colunas idempotentes (nullable; NULL = destravado, sem backfill). NÃO entram
-- no LIST_COLUMNS do frontend (useConversations seleciona colunas explícitas).
alter table public.conversations
  add column if not exists ai_lock_token text,
  add column if not exists ai_lock_until timestamptz;

comment on column public.conversations.ai_lock_until is
  'TTL do lock do agente IA (webhook-whatsapp). Enquanto > now() com token setado, só o holder roda o agente. Auto-expira em crash.';

-- Reivindica a conversa pro agente IA. Atômico: o UPDATE condicional é o próprio
-- primitivo de atomicidade (sem SELECT-then-UPDATE). Zero linhas casadas (lock
-- válido de outro token) → RETURNING dá NULL → retorna false.
create or replace function public.try_claim_conversation_for_ai(
  p_conv uuid,
  p_token text,
  p_ttl_seconds int
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed boolean;
begin
  update public.conversations
     set ai_lock_token = p_token,
         ai_lock_until = now() + make_interval(secs => p_ttl_seconds)
   where id = p_conv
     and (ai_lock_until is null or ai_lock_until < now())
  returning true into v_claimed;

  return coalesce(v_claimed, false);
end;
$$;

-- Libera o lock SÓ se o token bater — não rouba lock de um holder novo cujo TTL
-- já expirou e foi re-reivindicado por outra invocação.
create or replace function public.release_conversation_ai_claim(
  p_conv uuid,
  p_token text
) returns void
language sql
security definer
set search_path = public
as $$
  update public.conversations
     set ai_lock_token = null,
         ai_lock_until = null
   where id = p_conv
     and ai_lock_token = p_token;
$$;

revoke all on function public.try_claim_conversation_for_ai(uuid, text, int) from public, anon, authenticated;
revoke all on function public.release_conversation_ai_claim(uuid, text) from public, anon, authenticated;
grant execute on function public.try_claim_conversation_for_ai(uuid, text, int) to service_role;
grant execute on function public.release_conversation_ai_claim(uuid, text) to service_role;

commit;
