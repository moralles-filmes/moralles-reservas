-- 110 — Datafy como provider de WhatsApp (proxy oficial da Meta Cloud API).
--
-- O nome do provider é restringido em OITO lugares: sete CHECKs de tabela e
-- dois corpos de função (um deles tem duas expressões). Liberar só os CHECKs
-- deixa o primeiro inbound Datafy estourando DENTRO de
-- claim_processed_whatsapp_message, que é a RPC de idempotência por onde passa
-- todo inbound — e erro de banco ali nunca é tratado como duplicata, então o
-- inbound se perde ou duas IAs rodam concorrentes.
--
-- ALTER ... CHECK não alcança corpo de função: as duas são reescritas aqui por
-- create or replace, com a assinatura idêntica (mudar o tipo de retorno daria 42P13).
--
-- record_whatsapp_channel_status NÃO entra: foi redefinida em
-- 20260901225539_generalize_whatsapp_channel_status.sql e a versão viva já não
-- guarda provider.
--
-- Idempotente: drop-if-exists + add nas constraints, create or replace nas funções.

-- ============================================================================
-- 1-7. Sete CHECKs de tabela
-- ============================================================================

alter table public.organizations
  drop constraint if exists organizations_default_whatsapp_provider_check;
alter table public.organizations
  add constraint organizations_default_whatsapp_provider_check
  check (default_whatsapp_provider in ('zapi', 'uazapi', 'waha', 'official', 'datafy'));

alter table public.whatsapp_channels
  drop constraint if exists whatsapp_channels_provider_check;
alter table public.whatsapp_channels
  add constraint whatsapp_channels_provider_check
  check (provider in ('zapi', 'uazapi', 'waha', 'official', 'datafy'));

alter table public.whatsapp_instances
  drop constraint if exists whatsapp_instances_provider_check;
alter table public.whatsapp_instances
  add constraint whatsapp_instances_provider_check
  check (provider in ('zapi', 'uazapi', 'waha', 'official', 'datafy'));

alter table public.processed_messages
  drop constraint if exists processed_messages_provider_check;
alter table public.processed_messages
  add constraint processed_messages_provider_check
  check (provider in ('zapi', 'uazapi', 'waha', 'official', 'datafy'));

alter table public.notifications_sent
  drop constraint if exists notifications_sent_whatsapp_provider_check;
alter table public.notifications_sent
  add constraint notifications_sent_whatsapp_provider_check
  check (whatsapp_provider is null
         or whatsapp_provider in ('zapi', 'uazapi', 'waha', 'official', 'datafy'));

alter table public.whatsapp_channel_lifecycle_events
  drop constraint if exists whatsapp_channel_lifecycle_events_provider_check;
alter table public.whatsapp_channel_lifecycle_events
  add constraint whatsapp_channel_lifecycle_events_provider_check
  check (provider in ('zapi', 'uazapi', 'waha', 'official', 'datafy'));

alter table public.whatsapp_channel_lifecycle_events
  drop constraint if exists whatsapp_channel_lifecycle_events_previous_provider_check;
alter table public.whatsapp_channel_lifecycle_events
  add constraint whatsapp_channel_lifecycle_events_previous_provider_check
  check (previous_provider is null
         or previous_provider in ('zapi', 'uazapi', 'waha', 'official', 'datafy'));

comment on constraint whatsapp_channels_provider_check on public.whatsapp_channels is
  'Providers suportados. datafy é proxy da Meta Cloud API: mesmos payloads do provider official, transporte e assinatura próprios.';

-- ============================================================================
-- 8a. claim_processed_whatsapp_message — RPC de idempotência do inbound.
--
-- Corpo copiado verbatim de 20260817170753_whatsapp_multiprovider_uazapi.sql
-- (linhas 261-327). Única mudança: a lista de providers na guarda (linha 281
-- original) ganha o provider novo.
-- ============================================================================

create or replace function public.claim_processed_whatsapp_message(
  p_provider text,
  p_message_id text,
  p_unit_id uuid,
  p_stale_after_seconds integer default 90
)
returns table (
  claimed boolean,
  claim_id uuid,
  previous_outcome text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing record;
  v_claim_id uuid := gen_random_uuid();
  v_stale integer := greatest(30, least(coalesce(p_stale_after_seconds, 90), 900));
begin
  if p_provider not in ('zapi', 'uazapi', 'waha', 'official', 'datafy') then
    raise exception 'invalid_whatsapp_provider' using errcode = '22023';
  end if;
  if p_message_id is null or length(btrim(p_message_id)) not between 1 and 512 then
    raise exception 'invalid_message_id' using errcode = '22023';
  end if;

  insert into public.processed_messages (
    provider, message_id, unit_id, started_at, completed_at, outcome, error,
    processing_claim_id
  ) values (
    p_provider, p_message_id, p_unit_id, now(), null, null, null, v_claim_id
  )
  on conflict (provider, message_id) do nothing;

  if found then
    return query select true, v_claim_id, null::text;
    return;
  end if;

  select pm.* into v_existing
  from public.processed_messages pm
  where pm.provider = p_provider and pm.message_id = p_message_id
  for update;

  if not found then
    raise exception 'processed_message_claim_race' using errcode = '40001';
  end if;

  if v_existing.completed_at is not null
     or v_existing.started_at > now() - make_interval(secs => v_stale) then
    return query select false, v_existing.processing_claim_id, v_existing.outcome;
    return;
  end if;

  update public.processed_messages pm
  set unit_id = p_unit_id,
      started_at = now(),
      completed_at = null,
      outcome = null,
      error = null,
      processing_claim_id = v_claim_id
  where pm.provider = p_provider and pm.message_id = p_message_id;

  return query select true, v_claim_id, v_existing.outcome;
end;
$$;

-- ACL reafirmada explicitamente — create or replace preserva a ACL existente,
-- mas o guardrail acl-estatico lê as migrations, não o banco.
revoke all on function public.claim_processed_whatsapp_message(text, text, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.claim_processed_whatsapp_message(text, text, uuid, integer)
  to service_role;

-- ============================================================================
-- 8b. set_organization_default_whatsapp_provider — escolha organizacional.
--
-- Corpo copiado verbatim de 20260817170753_whatsapp_multiprovider_uazapi.sql
-- (linhas 386-436). Única mudança: a lista de providers na guarda (linha 404
-- original) ganha o provider novo.
-- ============================================================================

create or replace function public.set_organization_default_whatsapp_provider(
  p_organization_id uuid,
  p_provider text,
  p_actor_id uuid default null,
  p_request_id text default null
)
returns table (
  organization_id uuid,
  previous_provider text,
  current_provider text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_previous text;
begin
  if p_provider is null or p_provider not in ('zapi', 'uazapi', 'waha', 'official', 'datafy') then
    raise exception 'invalid_whatsapp_provider' using errcode = '22023';
  end if;
  if p_request_id is not null and
     (length(p_request_id) not between 1 and 128 or p_request_id !~ '^[A-Za-z0-9._:-]+$') then
    raise exception 'invalid_request_id' using errcode = '22023';
  end if;

  select o.default_whatsapp_provider
  into v_previous
  from public.organizations o
  where o.id = p_organization_id
  for update;

  if not found then
    raise exception 'organization_not_found' using errcode = 'P0002';
  end if;

  update public.organizations o
  set default_whatsapp_provider = p_provider
  where o.id = p_organization_id;

  insert into public.whatsapp_channel_lifecycle_events (
    organization_id, event_type, provider, previous_provider, request_id, actor_id
  ) values (
    p_organization_id,
    case when v_previous = p_provider then 'provider_selected' else 'provider_changed' end,
    p_provider, v_previous, p_request_id, p_actor_id
  );

  return query select p_organization_id, v_previous, p_provider;
end;
$$;

-- ACL reafirmada explicitamente — create or replace preserva a ACL existente,
-- mas o guardrail acl-estatico lê as migrations, não o banco.
revoke all on function public.set_organization_default_whatsapp_provider(uuid, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.set_organization_default_whatsapp_provider(uuid, text, uuid, text)
  to service_role;
