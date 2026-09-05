-- Cutover só pode tornar ativo um canal cujo contrato de conversa foi
-- comprovado: providers manuais por callback real; lifecycle gerenciado pela
-- configuração remota confirmada. Canais ativos legados não são desligados.
alter table public.whatsapp_channels
  add column if not exists manual_echo_verified_at timestamptz,
  add column if not exists manual_echo_verification_source text;

-- NULL existe apenas para compatibilidade com canais anteriores ao registry.
-- Todo writer novo que omitir a projeção nasce fail-closed.
alter table public.whatsapp_channels
  alter column is_active set default false;

alter table public.whatsapp_channels
  drop constraint if exists whatsapp_channels_manual_echo_verification_source_check,
  add constraint whatsapp_channels_manual_echo_verification_source_check
    check (manual_echo_verification_source is null or manual_echo_verification_source in (
      'provider_callback', 'managed_configuration'
    ));

create or replace function public.enforce_whatsapp_conversation_parity_on_activation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.is_active is true
     and (tg_op = 'INSERT' or old.is_active is distinct from true)
     and new.manual_echo_verified_at is null then
    raise exception 'whatsapp_conversation_parity_unverified' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_whatsapp_conversation_parity_on_activation() from public, anon, authenticated;

drop trigger if exists enforce_whatsapp_conversation_parity_on_activation on public.whatsapp_channels;
create trigger enforce_whatsapp_conversation_parity_on_activation
  before insert or update of is_active on public.whatsapp_channels
  for each row execute function public.enforce_whatsapp_conversation_parity_on_activation();

comment on column public.whatsapp_channels.manual_echo_verified_at is
  'Prova fail-closed de que o canal entrega ecos manuais necessários à paridade da timeline.';

-- Mantém a timeline da conversa fiel ao horário original dos providers sem
-- permitir que uma reentrega atrasada faça `last_message_at` andar para trás.
create or replace function public.append_conversation_message(
  p_conversation_id uuid,
  p_message jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_message_at timestamptz;
  v_event_id text;
begin
  if p_message is null or jsonb_typeof(p_message) <> 'object' then
    raise exception 'p_message must be a JSONB object';
  end if;
  if (p_message->>'role') is null or (p_message->>'content') is null or (p_message->>'timestamp') is null then
    raise exception 'p_message must have role, content, timestamp';
  end if;
  if p_message ? 'author'
     and p_message->>'author' not in ('customer', 'ai', 'automation', 'human') then
    raise exception 'invalid conversation message author';
  end if;

  v_message_at := (p_message->>'timestamp')::timestamptz;
  v_event_id := nullif(btrim(p_message->>'event_id'), '');
  if v_event_id is not null and length(v_event_id) > 1024 then
    raise exception 'invalid conversation event_id';
  end if;

  update public.conversations
  set
    messages = case
      when v_event_id is not null and exists (
        select 1 from jsonb_array_elements(coalesce(messages, '[]'::jsonb)) item
        where item->>'event_id' = v_event_id
      ) then coalesce(messages, '[]'::jsonb)
      else coalesce(messages, '[]'::jsonb) || jsonb_build_array(p_message)
    end,
    last_message_at = case
      when last_message_at is null then v_message_at
      else greatest(last_message_at, v_message_at)
    end,
    updated_at = now()
  where id = p_conversation_id;

  if not found then
    raise exception 'conversation_not_found';
  end if;
end;
$$;

revoke all on function public.append_conversation_message(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.append_conversation_message(uuid, jsonb) to service_role;

comment on function public.append_conversation_message(uuid, jsonb) is
  'Append atômico em conversations.messages com last_message_at monotônico. service_role only.';

-- Append + handoff formam uma única decisão: nunca registrar que o evento foi
-- processado deixando a mensagem humana sem silenciar a IA (ou o inverso).
create or replace function public.record_whatsapp_human_message(
  p_conversation_id uuid,
  p_unit_id uuid,
  p_message jsonb,
  p_handoff_reason text default 'atendente respondeu pelo WhatsApp da loja'
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_message_at timestamptz;
  v_event_id text;
begin
  if p_message is null or jsonb_typeof(p_message) <> 'object' then
    raise exception 'p_message must be a JSONB object';
  end if;
  if p_message->>'role' <> 'human'
     or p_message->>'author' <> 'human'
     or nullif(btrim(p_message->>'content'), '') is null
     or (p_message->>'timestamp') is null then
    raise exception 'p_message must be a human message with content and timestamp';
  end if;

  v_message_at := (p_message->>'timestamp')::timestamptz;
  v_event_id := nullif(btrim(p_message->>'event_id'), '');
  if v_event_id is not null and length(v_event_id) > 1024 then
    raise exception 'invalid conversation event_id';
  end if;

  update public.conversations
  set
    messages = case
      when v_event_id is not null and exists (
        select 1 from jsonb_array_elements(coalesce(messages, '[]'::jsonb)) item
        where item->>'event_id' = v_event_id
      ) then coalesce(messages, '[]'::jsonb)
      else coalesce(messages, '[]'::jsonb) || jsonb_build_array(p_message)
    end,
    last_message_at = case
      when last_message_at is null then v_message_at
      else greatest(last_message_at, v_message_at)
    end,
    status = 'human_active',
    handoff_at = now(),
    handoff_reason = coalesce(nullif(btrim(p_handoff_reason), ''), 'atendente respondeu pelo WhatsApp da loja'),
    last_silenced_reply_at = now(),
    ai_lock_token = null,
    ai_lock_until = null,
    updated_at = now()
  where id = p_conversation_id
    and unit_id = p_unit_id;

  if not found then
    raise exception 'conversation_not_found';
  end if;
end;
$$;

revoke all on function public.record_whatsapp_human_message(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.record_whatsapp_human_message(uuid, uuid, jsonb, text) to service_role;

comment on function public.record_whatsapp_human_message(uuid, uuid, jsonb, text) is
  'Registra eco humano do WhatsApp e silencia a IA atomicamente. service_role only.';

-- Se a escrita humana falhar depois do claim, a reentrega precisa poder
-- reivindicar o evento novamente. A cerca UUID impede apagar trabalho alheio.
create or replace function public.release_processed_whatsapp_message_claim(
  p_provider text,
  p_message_id text,
  p_claim_id uuid
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  delete from public.processed_messages
  where provider = p_provider
    and message_id = p_message_id
    and processing_claim_id = p_claim_id
    and completed_at is null;
  get diagnostics v_deleted = row_count;
  return v_deleted = 1;
end;
$$;

revoke all on function public.release_processed_whatsapp_message_claim(text, text, uuid) from public, anon, authenticated;
grant execute on function public.release_processed_whatsapp_message_claim(text, text, uuid) to service_role;

comment on function public.release_processed_whatsapp_message_claim(text, text, uuid) is
  'Libera apenas um claim incompleto e cercado por UUID para permitir reentrega segura. service_role only.';

-- Serializa lookup-or-create sem depender de um índice novo que poderia falhar
-- sobre duplicatas históricas. O advisory lock vive só nesta transação/RPC.
create or replace function public.get_or_create_whatsapp_conversation(
  p_customer_id uuid,
  p_unit_id uuid,
  p_contact_name text default null,
  p_chat_lid text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not exists (
    select 1
    from public.customers c
    join public.units u on u.organization_id = c.organization_id
    where c.id = p_customer_id and u.id = p_unit_id
  ) then
    raise exception 'conversation_tenant_mismatch';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_unit_id::text || ':' || p_customer_id::text, 0));

  select id into v_id
  from public.conversations
  where customer_id = p_customer_id and unit_id = p_unit_id
  order by updated_at desc, id
  limit 1;

  if v_id is null then
    insert into public.conversations (customer_id, unit_id, messages, contact_name, wa_chat_lid)
    values (p_customer_id, p_unit_id, '[]'::jsonb, p_contact_name, p_chat_lid)
    returning id into v_id;
  else
    update public.conversations
    set contact_name = coalesce(nullif(p_contact_name, ''), contact_name),
        wa_chat_lid = coalesce(nullif(p_chat_lid, ''), wa_chat_lid),
        updated_at = now()
    where id = v_id;
  end if;

  return v_id;
end;
$$;

revoke all on function public.get_or_create_whatsapp_conversation(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.get_or_create_whatsapp_conversation(uuid, uuid, text, text)
  to service_role;

comment on function public.get_or_create_whatsapp_conversation(uuid, uuid, text, text) is
  'Lookup-or-create unit/customer serializado e tenant-safe para webhooks concorrentes.';
