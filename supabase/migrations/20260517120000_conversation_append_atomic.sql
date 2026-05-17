-- Atomic append to conversations.messages.
--
-- Substitui o padrão "SELECT messages → push → UPDATE messages" usado em 3
-- writers (webhook-whatsapp, send-manual-message, _shared/conversation-log.ts)
-- que perde mensagens em concorrência (inbound + worker, ou 2 inbounds rápidos).
--
-- O UPDATE usa o operador || de jsonb, que é avaliado atomicamente dentro da
-- linha: dois UPDATES concorrentes serializam via row lock e ambas as mensagens
-- são preservadas (o segundo lê o estado JÁ COM a primeira mensagem appendada).

create or replace function public.append_conversation_message(
  p_conversation_id uuid,
  p_message jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_message is null or jsonb_typeof(p_message) <> 'object' then
    raise exception 'p_message must be a JSONB object';
  end if;
  if (p_message->>'role') is null or (p_message->>'content') is null or (p_message->>'timestamp') is null then
    raise exception 'p_message must have role, content, timestamp';
  end if;

  update public.conversations
  set
    messages = coalesce(messages, '[]'::jsonb) || jsonb_build_array(p_message),
    last_message_at = coalesce((p_message->>'timestamp')::timestamptz, now()),
    updated_at = now()
  where id = p_conversation_id;
end;
$$;

revoke all on function public.append_conversation_message(uuid, jsonb) from public;
grant execute on function public.append_conversation_message(uuid, jsonb) to service_role;

comment on function public.append_conversation_message(uuid, jsonb) is
  'Atomic append to conversations.messages. Use instead of SELECT+push+UPDATE. service_role only — Edge Functions consume via RPC.';
