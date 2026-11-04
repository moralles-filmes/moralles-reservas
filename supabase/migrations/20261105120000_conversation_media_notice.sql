-- Aviso de mídia na rajada: decisão e reivindicação atômicas, sob lock da conversa.
--
-- Corrige "texto + mídia na mesma rajada perde a resposta da IA". Duas RPCs
-- service_role-only. A mídia é reconhecida só por `media_kind` (nunca pelo texto
-- do placeholder) e a decisão do aviso (deferred | notice_now | suppressed)
-- é tomada sob `select ... for update` da conversa, junto da gravação.
-- Campos novos no elemento de conversations.messages: media_kind, media_notice
-- (none | deferred | claimed). Sem DDL de tabela; nada é ativado por esta migration.
--
-- ROLLBACK (manual; nenhuma coluna ou dado novo além dos campos JSON acima;
-- reverta as EFs antes, pois elas chamam estas RPCs):
--   drop function if exists public.claim_conversation_media_notices(uuid, timestamptz);
--   drop function if exists public.record_conversation_media(uuid, jsonb, boolean, integer, integer);
--   drop function if exists app_private.safe_timestamptz(text);

create schema if not exists app_private;

-- Cast tolerante: chegada ilegivel (legado `""`, `abc`, epoca numerica, `2026-13-45`)
-- vira NULL = "nao recente", e nunca derruba a decisao do aviso. So as RPCs
-- DEFINER abaixo a chamam (o dono executa; ninguem mais precisa de EXECUTE).
create or replace function app_private.safe_timestamptz(p_value text)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_value is null or p_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' then
    return null;
  end if;
  return p_value::timestamptz;
exception when others then
  return null;
end;
$$;

revoke all on function app_private.safe_timestamptz(text)
  from public, anon, authenticated, service_role;

create or replace function public.record_conversation_media(
  p_conversation_id uuid,
  p_message jsonb,
  p_notice_allowed boolean,
  p_burst_seconds integer,
  p_debounce_grace_seconds integer
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_message_at timestamptz;
  v_event_id text;
  v_kind text;
  v_messages jsonb;
  v_lock timestamptz;
  v_now timestamptz;
  v_last_reply integer;
  v_newest_unanswered timestamptz;
  v_variant boolean;
  v_decision text;
  v_notice text;
begin
  if p_message is null or pg_catalog.jsonb_typeof(p_message) <> 'object' then
    raise exception 'p_message must be a JSONB object';
  end if;
  if (p_message->>'role') is null or (p_message->>'content') is null or (p_message->>'timestamp') is null then
    raise exception 'p_message must have role, content, timestamp';
  end if;
  if p_message ? 'author'
     and p_message->>'author' not in ('customer', 'ai', 'automation', 'human') then
    raise exception 'invalid conversation message author';
  end if;
  if p_message->>'role' <> 'user' then
    raise exception 'record_conversation_media requires role user';
  end if;
  v_kind := nullif(pg_catalog.btrim(p_message->>'media_kind'), '');
  if pg_catalog.jsonb_typeof(p_message->'media_kind') is distinct from 'string'
     or v_kind is null or pg_catalog.length(v_kind) > 32 then
    raise exception 'invalid media_kind';
  end if;
  if p_burst_seconds is null or p_burst_seconds < 0
     or p_debounce_grace_seconds is null or p_debounce_grace_seconds < 0 then
    raise exception 'invalid media notice window';
  end if;

  v_message_at := (p_message->>'timestamp')::timestamptz;
  v_event_id := nullif(pg_catalog.btrim(p_message->>'event_id'), '');
  if v_event_id is not null and pg_catalog.length(v_event_id) > 1024 then
    raise exception 'invalid conversation event_id';
  end if;

  select coalesce(c.messages, '[]'::jsonb), c.ai_lock_until
    into v_messages, v_lock
    from public.conversations c
   where c.id = p_conversation_id
     for update;
  if not found then
    raise exception 'conversation_not_found';
  end if;

  if v_event_id is not null and exists (
    select 1 from pg_catalog.jsonb_array_elements(v_messages) item
     where item->>'event_id' = v_event_id
  ) then
    return pg_catalog.jsonb_build_object('decision', 'duplicate', 'variant', false);
  end if;

  v_now := pg_catalog.clock_timestamp();

  -- Posição da última resposta (assistant/human); 0 quando não há.
  select coalesce(max(t.ord), 0)::integer into v_last_reply
    from pg_catalog.jsonb_array_elements(v_messages) with ordinality as t(item, ord)
   where t.item->>'role' in ('assistant', 'human');

  -- Texto sem resposta = role user, sem media_kind, conteúdo não vazio, depois da última resposta.
  -- A chegada cai para `timestamp` em mensagem legada sem `received_at`.
  select max(app_private.safe_timestamptz(coalesce(t.item->>'received_at', t.item->>'timestamp')))
    into v_newest_unanswered
    from pg_catalog.jsonb_array_elements(v_messages) with ordinality as t(item, ord)
   where t.ord > v_last_reply
     and t.item->>'role' = 'user'
     and nullif(t.item->>'media_kind', '') is null
     and nullif(pg_catalog.btrim(t.item->>'content'), '') is not null;

  select exists (
    select 1
      from pg_catalog.jsonb_array_elements(v_messages) as t(item)
     where t.item->>'role' = 'user'
       and nullif(t.item->>'media_kind', '') is null
       and app_private.safe_timestamptz(coalesce(t.item->>'received_at', t.item->>'timestamp'))
           >= v_now - pg_catalog.make_interval(secs => p_burst_seconds)
  ) into v_variant;

  if not coalesce(p_notice_allowed, false) then
    v_decision := 'suppressed';
    v_notice := 'none';
  elsif v_newest_unanswered is not null
        and v_newest_unanswered >= v_now - pg_catalog.make_interval(secs => p_burst_seconds)
        and ((v_lock is not null and v_lock > v_now)
             or v_newest_unanswered >= v_now - pg_catalog.make_interval(secs => p_debounce_grace_seconds)) then
    v_decision := 'deferred';
    v_notice := 'deferred';
  else
    v_decision := 'notice_now';
    v_notice := 'claimed';
  end if;

  update public.conversations
     set messages = v_messages || pg_catalog.jsonb_build_array(
           p_message || pg_catalog.jsonb_build_object('media_notice', v_notice)),
         last_message_at = case
           when last_message_at is null then v_message_at
           else greatest(last_message_at, v_message_at)
         end,
         updated_at = pg_catalog.now()
   where id = p_conversation_id;

  return pg_catalog.jsonb_build_object('decision', v_decision, 'variant', v_variant);
end;
$$;

create or replace function public.claim_conversation_media_notices(
  p_conversation_id uuid,
  p_since timestamptz
) returns text[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_messages jsonb;
  v_out jsonb := '[]'::jsonb;
  v_kinds text[] := '{}';
  v_item jsonb;
  v_changed boolean := false;
begin
  if p_since is null then
    raise exception 'p_since is required';
  end if;

  select coalesce(c.messages, '[]'::jsonb) into v_messages
    from public.conversations c
   where c.id = p_conversation_id
     for update;
  if not found then
    return '{}';
  end if;

  for v_item in
    select t.item
      from pg_catalog.jsonb_array_elements(v_messages) with ordinality as t(item, ord)
     order by t.ord
  loop
    if v_item->>'media_notice' = 'deferred'
       and app_private.safe_timestamptz(coalesce(v_item->>'received_at', v_item->>'timestamp')) >= p_since then
      v_kinds := v_kinds || (v_item->>'media_kind');
      v_item := v_item || pg_catalog.jsonb_build_object('media_notice', 'claimed');
      v_changed := true;
    end if;
    v_out := v_out || pg_catalog.jsonb_build_array(v_item);
  end loop;

  if v_changed then
    update public.conversations
       set messages = v_out, updated_at = pg_catalog.now()
     where id = p_conversation_id;
  end if;
  return v_kinds;
end;
$$;

revoke execute on function public.record_conversation_media(uuid, jsonb, boolean, integer, integer)
  from public, anon, authenticated;
revoke execute on function public.claim_conversation_media_notices(uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.record_conversation_media(uuid, jsonb, boolean, integer, integer)
  to service_role;
grant execute on function public.claim_conversation_media_notices(uuid, timestamptz)
  to service_role;

comment on function public.record_conversation_media(uuid, jsonb, boolean, integer, integer) is
  'Grava mensagem de mídia do cliente e decide o aviso (deferred|notice_now|suppressed|duplicate) sob lock da conversa. service_role only.';
comment on function public.claim_conversation_media_notices(uuid, timestamptz) is
  'Reivindica (deferred -> claimed) os avisos de mídia adiados desde p_since e devolve os media_kind. service_role only.';
