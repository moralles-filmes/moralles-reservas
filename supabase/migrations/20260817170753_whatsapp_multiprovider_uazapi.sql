-- WhatsApp multi-provider: adiciona UazAPI sem alterar/remover o contrato Z-API.
--
-- Ordem segura de rollout:
--   1. esta migration aditiva;
--   2. Edge Functions compatíveis com is_active NULL e provider uazapi;
--   3. frontend.
--
-- Segredos UazAPI NÃO entram em whatsapp_channels.credentials. O token da
-- instância é armazenado pelo Vault e só pode ser lido/escrito por RPCs
-- SECURITY DEFINER concedidas exclusivamente a service_role.

begin;

-- ============================================================================
-- 1. Provider default da organização (preferência, não provisionamento)
-- ============================================================================

alter table public.organizations
  add column if not exists default_whatsapp_provider text not null default 'zapi';

update public.organizations
set default_whatsapp_provider = 'zapi'
where default_whatsapp_provider is null;

alter table public.organizations
  drop constraint if exists organizations_default_whatsapp_provider_check;

alter table public.organizations
  add constraint organizations_default_whatsapp_provider_check
  check (default_whatsapp_provider in ('zapi', 'uazapi', 'waha', 'official'));

comment on column public.organizations.default_whatsapp_provider is
  'Preferencia para novas configuracoes WhatsApp. Nao provisiona nem autoriza envio; default legado e zapi.';

-- A migration 086 revogou SELECT de tabela do anon e concedeu só colunas
-- públicas. Reafirmar aqui que a coluna administrativa nova não é pública.
revoke select (default_whatsapp_provider) on public.organizations from anon;

-- ============================================================================
-- 2. whatsapp_channels continua sendo o único binding por provider
-- ============================================================================

alter table public.whatsapp_channels
  add column if not exists is_active boolean,
  add column if not exists instance_token_secret_id uuid references vault.secrets(id) on delete set null,
  add column if not exists external_instance_id text,
  add column if not exists connected_at timestamptz,
  add column if not exists last_health_check_at timestamptz,
  add column if not exists provisioning_started_at timestamptz,
  add column if not exists provisioning_claim_id uuid,
  add column if not exists provisioning_create_attempted_at timestamptz,
  add column if not exists activation_requested_at timestamptz,
  add column if not exists activation_requested_by uuid references auth.users(id) on delete set null;

alter table public.whatsapp_channels
  drop constraint if exists whatsapp_channels_provider_check,
  drop constraint if exists whatsapp_channels_status_check,
  drop constraint if exists whatsapp_channels_uazapi_credentials_empty_check,
  drop constraint if exists whatsapp_channels_provisioning_claim_pair_check;

alter table public.whatsapp_channels
  add constraint whatsapp_channels_provider_check
    check (provider in ('zapi', 'uazapi', 'waha', 'official')),
  add constraint whatsapp_channels_status_check
    check (status in (
      'not_configured', 'provisioning', 'waiting_qr', 'connecting',
      'connected', 'disconnected', 'reconnecting', 'suspended',
      'provider_error', 'switching_provider', 'error'
    )),
  add constraint whatsapp_channels_uazapi_credentials_empty_check
    check (provider <> 'uazapi' or credentials = '{}'::jsonb),
  add constraint whatsapp_channels_provisioning_claim_pair_check
    check ((provisioning_started_at is null) = (provisioning_claim_id is null));

comment on column public.whatsapp_channels.is_active is
  'NULL preserva selecao legada; TRUE e o canal explicito da unidade; FALSE e configuracao preservada/inativa.';
comment on column public.whatsapp_channels.instance_token_secret_id is
  'UUID do token UazAPI cifrado no Vault. Nunca devolver ao frontend nem copiar para credentials/logs.';
comment on column public.whatsapp_channels.provisioning_claim_id is
  'Fence token de claim idempotente. Impede worker atrasado de liberar claim mais novo.';
comment on column public.whatsapp_channels.activation_requested_at is
  'Intencao duravel de cutover. Claim/status nao a apagam; activate a consome somente com alvo connected.';

-- Backfill conservador: escolhe somente uma linha única total OU a única linha
-- connected. Unidades ambíguas continuam inteiramente NULL e mantêm o fallback
-- legado até decisão administrativa explícita.
with channel_stats as (
  select
    unit_id,
    count(*) as total_count,
    count(*) filter (where status = 'connected') as connected_count,
    (array_agg(id order by id) filter (where status = 'connected'))[1] as connected_id,
    (array_agg(id order by id))[1] as only_id,
    bool_and(is_active is null) as entirely_legacy
  from public.whatsapp_channels
  group by unit_id
), candidates as (
  select
    unit_id,
    case
      when total_count = 1 then only_id
      when connected_count = 1 then connected_id
      else null
    end as channel_id
  from channel_stats
  where entirely_legacy
)
update public.whatsapp_channels c
set is_active = true
from candidates x
where x.channel_id is not null
  and c.id = x.channel_id
  and c.unit_id = x.unit_id
  and c.is_active is null;

create unique index if not exists whatsapp_channels_one_active_per_unit_idx
  on public.whatsapp_channels (unit_id)
  where is_active is true;

create unique index if not exists whatsapp_channels_one_uazapi_per_unit_idx
  on public.whatsapp_channels (unit_id)
  where provider = 'uazapi';

create unique index if not exists whatsapp_channels_provider_external_instance_idx
  on public.whatsapp_channels (provider, external_instance_id)
  where external_instance_id is not null;

create unique index if not exists whatsapp_channels_vault_secret_idx
  on public.whatsapp_channels (instance_token_secret_id)
  where instance_token_secret_id is not null;

create unique index if not exists whatsapp_channels_one_pending_activation_per_unit_idx
  on public.whatsapp_channels (unit_id)
  where activation_requested_at is not null;

alter table public.whatsapp_channels enable row level security;
alter table public.whatsapp_channels force row level security;
revoke all on table public.whatsapp_channels from anon, authenticated;
grant select, insert, update, delete on table public.whatsapp_channels to service_role;

-- ============================================================================
-- 3. Inventário de custo aceita UazAPI, mas continua sem credenciais
-- ============================================================================

alter table public.whatsapp_instances
  drop constraint if exists whatsapp_instances_provider_check;

alter table public.whatsapp_instances
  add constraint whatsapp_instances_provider_check
  check (provider in ('zapi', 'uazapi', 'waha', 'official'));

-- ============================================================================
-- 4. Dedupe passa de global para (provider, message_id)
-- ============================================================================

alter table public.processed_messages
  add column if not exists provider text not null default 'zapi',
  add column if not exists processing_claim_id uuid;

update public.processed_messages
set provider = 'zapi'
where provider is null;

alter table public.processed_messages
  drop constraint if exists processed_messages_provider_check,
  drop constraint if exists processed_messages_pkey;

alter table public.processed_messages
  add constraint processed_messages_provider_check
    check (provider in ('zapi', 'uazapi', 'waha', 'official')),
  add constraint processed_messages_pkey primary key (provider, message_id);

alter table public.processed_messages enable row level security;
alter table public.processed_messages force row level security;
revoke all on table public.processed_messages from anon, authenticated;
grant select, insert, update, delete on table public.processed_messages to service_role;

comment on column public.processed_messages.provider is
  'Parte da identidade idempotente do inbound. Linhas anteriores a UazAPI foram preservadas como zapi.';
comment on column public.processed_messages.processing_claim_id is
  'Fence da invocacao que possui o processamento. Takeover e conclusao exigem o mesmo UUID.';

alter table public.notifications_sent
  add column if not exists whatsapp_provider text,
  add column if not exists whatsapp_channel_id uuid references public.whatsapp_channels(id) on delete set null;

alter table public.notifications_sent
  drop constraint if exists notifications_sent_whatsapp_provider_check;
alter table public.notifications_sent
  add constraint notifications_sent_whatsapp_provider_check
  check (whatsapp_provider is null or whatsapp_provider in ('zapi', 'uazapi', 'waha', 'official'));

create index if not exists notifications_sent_delivery_route_idx
  on public.notifications_sent (unit_id, whatsapp_provider, whatsapp_channel_id, provider_message_id)
  where provider_message_id is not null;

comment on column public.notifications_sent.whatsapp_provider is
  'Provider que aceitou o envio; participa da correlacao segura do callback de delivery.';
comment on column public.notifications_sent.whatsapp_channel_id is
  'Canal que aceitou o envio; callback de canal preservado nao pode atualizar a rota ativa.';

-- ============================================================================
-- 5. Ledger sanitizado e append-only do lifecycle
-- ============================================================================

create table if not exists public.whatsapp_channel_lifecycle_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  unit_id uuid,
  channel_ref uuid,
  related_channel_ref uuid,
  event_type text not null check (event_type in (
    'provider_selected', 'provider_changed', 'provisioning_claimed',
    'provisioning_released', 'token_stored', 'qr_requested', 'connect',
    'disconnect', 'restart', 'activation_requested', 'activated',
    'status_changed', 'error'
  )),
  provider text not null check (provider in ('zapi', 'uazapi', 'waha', 'official')),
  previous_provider text check (
    previous_provider is null or previous_provider in ('zapi', 'uazapi', 'waha', 'official')
  ),
  from_status text,
  to_status text,
  error_code text check (
    error_code is null or error_code ~ '^[A-Z0-9_]{1,64}$'
  ),
  request_id text check (
    request_id is null or (length(request_id) between 1 and 128 and request_id ~ '^[A-Za-z0-9._:-]+$')
  ),
  actor_id uuid,
  created_at timestamptz not null default now()
);

comment on table public.whatsapp_channel_lifecycle_events is
  'Ledger append-only e sanitizado do lifecycle WhatsApp. Sem JSONB livre, credentials, tokens, QR ou mensagens.';
comment on column public.whatsapp_channel_lifecycle_events.channel_ref is
  'Identidade historica; deliberadamente sem FK para sobreviver a remocao da configuracao.';

create index if not exists whatsapp_channel_lifecycle_events_org_idx
  on public.whatsapp_channel_lifecycle_events (organization_id, created_at desc);
create index if not exists whatsapp_channel_lifecycle_events_unit_idx
  on public.whatsapp_channel_lifecycle_events (unit_id, created_at desc)
  where unit_id is not null;
create index if not exists whatsapp_channel_lifecycle_events_channel_idx
  on public.whatsapp_channel_lifecycle_events (channel_ref, created_at desc)
  where channel_ref is not null;

create or replace function public.whatsapp_channel_lifecycle_append_only_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'whatsapp_channel_lifecycle_events e append-only'
    using errcode = 'check_violation';
end;
$$;

-- Claim/takeover do inbound em uma única transação. Só 23505 representa uma
-- entrega já conhecida; falha de banco propaga 5xx ao provider para retry.
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
  if p_provider not in ('zapi', 'uazapi', 'waha', 'official') then
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

create or replace function public.complete_processed_whatsapp_message(
  p_provider text,
  p_message_id text,
  p_claim_id uuid,
  p_outcome text,
  p_error text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated integer;
begin
  if p_claim_id is null then
    raise exception 'processed_message_claim_required' using errcode = '22023';
  end if;
  update public.processed_messages pm
  set completed_at = now(), outcome = left(p_outcome, 128), error = left(p_error, 1000)
  where pm.provider = p_provider
    and pm.message_id = p_message_id
    and pm.processing_claim_id = p_claim_id
    and pm.completed_at is null;
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

revoke all on function public.whatsapp_channel_lifecycle_append_only_guard()
  from public, anon, authenticated, service_role;

drop trigger if exists whatsapp_channel_lifecycle_append_only
  on public.whatsapp_channel_lifecycle_events;
create trigger whatsapp_channel_lifecycle_append_only
  before update or delete on public.whatsapp_channel_lifecycle_events
  for each row execute function public.whatsapp_channel_lifecycle_append_only_guard();

alter table public.whatsapp_channel_lifecycle_events enable row level security;
alter table public.whatsapp_channel_lifecycle_events force row level security;

drop policy if exists platform_admin_read_whatsapp_channel_lifecycle_events
  on public.whatsapp_channel_lifecycle_events;
create policy platform_admin_read_whatsapp_channel_lifecycle_events
  on public.whatsapp_channel_lifecycle_events
  for select to authenticated
  using ((select public.is_platform_admin((select auth.uid()))));

revoke all on table public.whatsapp_channel_lifecycle_events
  from public, anon, authenticated, service_role;
grant select on table public.whatsapp_channel_lifecycle_events
  to authenticated, service_role;

-- ============================================================================
-- 6. Escolha organizacional atômica + auditoria
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
  if p_provider is null or p_provider not in ('zapi', 'uazapi', 'waha', 'official') then
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

-- ============================================================================
-- 7. Vault: store/read do token UazAPI, somente service_role
-- ============================================================================

create or replace function public.store_whatsapp_channel_instance_token(
  p_channel_id uuid,
  p_claim_id uuid,
  p_token text,
  p_actor_id uuid default null,
  p_request_id text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_channel record;
  v_secret_id uuid;
  v_secret_name text;
  v_org_id uuid;
begin
  if p_token is null or length(btrim(p_token)) < 8 or length(p_token) > 4096 then
    raise exception 'invalid_channel_token' using errcode = '22023';
  end if;
  if p_request_id is not null and
     (length(p_request_id) not between 1 and 128 or p_request_id !~ '^[A-Za-z0-9._:-]+$') then
    raise exception 'invalid_request_id' using errcode = '22023';
  end if;

  select c.id, c.unit_id, c.provider, c.instance_token_secret_id,
         c.provisioning_claim_id
  into v_channel
  from public.whatsapp_channels c
  where c.id = p_channel_id
  for update;

  if not found then
    raise exception 'channel_not_found' using errcode = 'P0002';
  end if;
  if v_channel.provider <> 'uazapi' then
    raise exception 'channel_provider_not_uazapi' using errcode = '22023';
  end if;
  if p_claim_id is null or v_channel.provisioning_claim_id is distinct from p_claim_id then
    raise exception 'stale_provisioning_claim' using errcode = '40001';
  end if;

  select u.organization_id into v_org_id
  from public.units u where u.id = v_channel.unit_id;
  if v_org_id is null then
    raise exception 'channel_unit_not_found' using errcode = 'check_violation';
  end if;

  v_secret_name := 'whatsapp-channel-' || p_channel_id::text || '-uazapi-token';
  v_secret_id := v_channel.instance_token_secret_id;

  if v_secret_id is null then
    select s.id into v_secret_id
    from vault.secrets s
    where s.name = v_secret_name
    limit 1;
  end if;

  if v_secret_id is not null and exists (
    select 1 from vault.secrets s where s.id = v_secret_id
  ) then
    perform vault.update_secret(
      v_secret_id,
      p_token,
      v_secret_name,
      'UazAPI instance token for internal channel UUID'
    );
  else
    select vault.create_secret(
      p_token,
      v_secret_name,
      'UazAPI instance token for internal channel UUID'
    ) into v_secret_id;
  end if;

  update public.whatsapp_channels c
  set instance_token_secret_id = v_secret_id
  where c.id = p_channel_id;

  insert into public.whatsapp_channel_lifecycle_events (
    organization_id, unit_id, channel_ref, event_type, provider,
    from_status, to_status, request_id, actor_id
  ) values (
    v_org_id, v_channel.unit_id, p_channel_id, 'token_stored', 'uazapi',
    null, null, p_request_id, p_actor_id
  );

  return v_secret_id;
end;
$$;

create or replace function public.get_whatsapp_channel_instance_token(p_channel_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token text;
begin
  select ds.decrypted_secret
  into v_token
  from public.whatsapp_channels c
  join vault.decrypted_secrets ds on ds.id = c.instance_token_secret_id
  where c.id = p_channel_id
    and c.provider = 'uazapi';

  if v_token is null then
    raise exception 'channel_token_not_found' using errcode = 'P0002';
  end if;

  return v_token;
end;
$$;

-- ============================================================================
-- 8. Claim/release idempotente com fence token
-- ============================================================================

create or replace function public.claim_whatsapp_channel_provisioning(
  p_channel_id uuid,
  p_actor_id uuid,
  p_stale_after_seconds integer default 120,
  p_request_id text default null
)
returns table (
  claimed boolean,
  claim_id uuid,
  channel_id uuid,
  unit_id uuid,
  provider text,
  status text,
  external_instance_id text,
  instance_token_secret_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_channel record;
  v_claim_id uuid;
  v_org_id uuid;
  v_ttl integer;
begin
  v_ttl := greatest(30, least(coalesce(p_stale_after_seconds, 120), 900));
  if p_request_id is not null and
     (length(p_request_id) not between 1 and 128 or p_request_id !~ '^[A-Za-z0-9._:-]+$') then
    raise exception 'invalid_request_id' using errcode = '22023';
  end if;

  select c.* into v_channel
  from public.whatsapp_channels c
  where c.id = p_channel_id
  for update;

  if not found then
    raise exception 'channel_not_found' using errcode = 'P0002';
  end if;
  if v_channel.provider <> 'uazapi' then
    raise exception 'channel_provider_not_uazapi' using errcode = '22023';
  end if;

  select u.organization_id into v_org_id
  from public.units u where u.id = v_channel.unit_id;
  if v_org_id is null then
    raise exception 'channel_unit_not_found' using errcode = 'check_violation';
  end if;

  if v_channel.provisioning_claim_id is not null
     and v_channel.provisioning_started_at > now() - make_interval(secs => v_ttl) then
    return query select
      false, v_channel.provisioning_claim_id, v_channel.id, v_channel.unit_id,
      v_channel.provider, v_channel.status, v_channel.external_instance_id,
      v_channel.instance_token_secret_id;
    return;
  end if;

  if v_channel.status = 'connected' then
    return query select
      false, null::uuid, v_channel.id, v_channel.unit_id, v_channel.provider,
      v_channel.status, v_channel.external_instance_id,
      v_channel.instance_token_secret_id;
    return;
  end if;

  v_claim_id := gen_random_uuid();
  update public.whatsapp_channels c
  set status = 'provisioning',
      provisioning_started_at = now(),
      provisioning_claim_id = v_claim_id,
      last_error = null
  where c.id = p_channel_id;

  insert into public.whatsapp_channel_lifecycle_events (
    organization_id, unit_id, channel_ref, event_type, provider,
    from_status, to_status, request_id, actor_id
  ) values (
    v_org_id, v_channel.unit_id, p_channel_id, 'provisioning_claimed', 'uazapi',
    v_channel.status, 'provisioning', p_request_id, p_actor_id
  );

  return query select
    true, v_claim_id, v_channel.id, v_channel.unit_id, v_channel.provider,
    'provisioning'::text, v_channel.external_instance_id,
    v_channel.instance_token_secret_id;
end;
$$;

create or replace function public.release_whatsapp_channel_provisioning(
  p_channel_id uuid,
  p_claim_id uuid,
  p_status text,
  p_external_instance_id text default null,
  p_display_phone text default null,
  p_error_code text default null,
  p_actor_id uuid default null,
  p_request_id text default null
)
returns table (
  channel_id uuid,
  unit_id uuid,
  provider text,
  status text,
  is_active boolean,
  external_instance_id text,
  display_phone text,
  connected_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_channel record;
  v_org_id uuid;
begin
  if p_status is null or p_status not in (
    'waiting_qr', 'connecting', 'connected', 'disconnected',
    'reconnecting', 'suspended', 'provider_error', 'error'
  ) then
    raise exception 'invalid_release_status' using errcode = '22023';
  end if;
  if p_error_code is not null and p_error_code !~ '^[A-Z0-9_]{1,64}$' then
    raise exception 'invalid_error_code' using errcode = '22023';
  end if;
  if p_display_phone is not null and p_display_phone !~ '^[0-9]{10,15}$' then
    raise exception 'invalid_display_phone' using errcode = '22023';
  end if;
  if p_request_id is not null and
     (length(p_request_id) not between 1 and 128 or p_request_id !~ '^[A-Za-z0-9._:-]+$') then
    raise exception 'invalid_request_id' using errcode = '22023';
  end if;

  select c.* into v_channel
  from public.whatsapp_channels c
  where c.id = p_channel_id
  for update;

  if not found then
    raise exception 'channel_not_found' using errcode = 'P0002';
  end if;
  if v_channel.provider <> 'uazapi' then
    raise exception 'channel_provider_not_uazapi' using errcode = '22023';
  end if;
  if p_claim_id is null or v_channel.provisioning_claim_id is distinct from p_claim_id then
    raise exception 'stale_provisioning_claim' using errcode = '40001';
  end if;
  if v_channel.external_instance_id is not null
     and p_external_instance_id is not null
     and v_channel.external_instance_id <> p_external_instance_id then
    raise exception 'external_instance_id_mismatch' using errcode = 'check_violation';
  end if;

  select u.organization_id into v_org_id
  from public.units u where u.id = v_channel.unit_id;
  if v_org_id is null then
    raise exception 'channel_unit_not_found' using errcode = 'check_violation';
  end if;

  update public.whatsapp_channels c
  set status = p_status,
      external_instance_id = coalesce(c.external_instance_id, p_external_instance_id),
      display_phone = coalesce(p_display_phone, c.display_phone),
      connected_at = case
        when p_status = 'connected' then coalesce(c.connected_at, now())
        else c.connected_at
      end,
      last_health_check_at = now(),
      last_error = case
        when p_status in ('provider_error', 'error') then p_error_code
        else null
      end,
      provisioning_started_at = null,
      provisioning_claim_id = null,
      provisioning_create_attempted_at = null
  where c.id = p_channel_id;

  insert into public.whatsapp_channel_lifecycle_events (
    organization_id, unit_id, channel_ref, event_type, provider,
    from_status, to_status, error_code, request_id, actor_id
  ) values (
    v_org_id, v_channel.unit_id, p_channel_id,
    case
      when p_status = 'connected' then 'connect'
      when p_status = 'waiting_qr' then 'qr_requested'
      when p_status in ('provider_error', 'error') then 'error'
      else 'provisioning_released'
    end,
    'uazapi', v_channel.status, p_status, p_error_code, p_request_id, p_actor_id
  );

  return query
  select c.id, c.unit_id, c.provider, c.status, c.is_active,
         c.external_instance_id, c.display_phone, c.connected_at
  from public.whatsapp_channels c
  where c.id = p_channel_id;
end;
$$;

-- ============================================================================
-- 9. Status polling não interfere no claim nem na intenção de cutover
-- ============================================================================

create or replace function public.record_whatsapp_channel_status(
  p_unit_id uuid,
  p_channel_id uuid,
  p_status text,
  p_display_phone text default null,
  p_error_code text default null,
  p_actor_id uuid default null,
  p_request_id text default null,
  p_event_type text default null
)
returns table (
  channel_id uuid,
  unit_id uuid,
  provider text,
  status text,
  is_active boolean,
  display_phone text,
  connected_at timestamptz,
  last_health_check_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_channel record;
  v_org_id uuid;
begin
  if p_status is null or p_status not in (
    'waiting_qr', 'connecting', 'connected', 'disconnected',
    'reconnecting', 'suspended', 'provider_error', 'error'
  ) then
    raise exception 'invalid_channel_status' using errcode = '22023';
  end if;
  if p_display_phone is not null and p_display_phone !~ '^[0-9]{10,15}$' then
    raise exception 'invalid_display_phone' using errcode = '22023';
  end if;
  if p_error_code is not null and p_error_code !~ '^[A-Z0-9_]{1,64}$' then
    raise exception 'invalid_error_code' using errcode = '22023';
  end if;
  if p_request_id is not null and
     (length(p_request_id) not between 1 and 128 or p_request_id !~ '^[A-Za-z0-9._:-]+$') then
    raise exception 'invalid_request_id' using errcode = '22023';
  end if;
  if p_event_type is not null and p_event_type not in ('disconnect', 'restart', 'status_changed') then
    raise exception 'invalid_status_event_type' using errcode = '22023';
  end if;

  select c.* into v_channel
  from public.whatsapp_channels c
  where c.id = p_channel_id
    and c.unit_id = p_unit_id
  for update;

  if not found then
    raise exception 'channel_unit_mismatch' using errcode = 'check_violation';
  end if;
  if v_channel.provider <> 'uazapi' then
    raise exception 'channel_provider_not_uazapi' using errcode = '22023';
  end if;

  select u.organization_id into v_org_id
  from public.units u where u.id = p_unit_id;
  if v_org_id is null then
    raise exception 'channel_unit_not_found' using errcode = 'check_violation';
  end if;

  update public.whatsapp_channels c
  set status = p_status,
      display_phone = coalesce(p_display_phone, c.display_phone),
      connected_at = case
        when p_status = 'connected' then coalesce(c.connected_at, now())
        else c.connected_at
      end,
      last_health_check_at = now(),
      last_error = case
        when p_status in ('provider_error', 'error') then p_error_code
        else null
      end
  where c.id = p_channel_id;

  if v_channel.status is distinct from p_status
     or v_channel.display_phone is distinct from coalesce(p_display_phone, v_channel.display_phone)
     or p_event_type in ('disconnect', 'restart') then
    insert into public.whatsapp_channel_lifecycle_events (
      organization_id, unit_id, channel_ref, event_type, provider,
      from_status, to_status, error_code, request_id, actor_id
    ) values (
      v_org_id, p_unit_id, p_channel_id,
      case
        when p_status in ('provider_error', 'error') then 'error'
        else coalesce(p_event_type, 'status_changed')
      end,
      'uazapi', v_channel.status, p_status, p_error_code, p_request_id, p_actor_id
    );
  end if;

  return query
  select c.id, c.unit_id, c.provider, c.status, c.is_active,
         c.display_phone, c.connected_at, c.last_health_check_at
  from public.whatsapp_channels c
  where c.id = p_channel_id;
end;
$$;

-- ============================================================================
-- 10. Intenção durável e cutover atômico
-- ============================================================================

create or replace function public.request_whatsapp_channel_activation(
  p_unit_id uuid,
  p_channel_id uuid,
  p_actor_id uuid,
  p_request_id text default null
)
returns table (
  channel_id uuid,
  unit_id uuid,
  activation_requested_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target record;
  v_org_id uuid;
  v_requested_at timestamptz;
begin
  if p_request_id is not null and
     (length(p_request_id) not between 1 and 128 or p_request_id !~ '^[A-Za-z0-9._:-]+$') then
    raise exception 'invalid_request_id' using errcode = '22023';
  end if;

  perform 1
  from public.units u
  where u.id = p_unit_id
  for update;
  if not found then
    raise exception 'channel_unit_not_found' using errcode = 'P0002';
  end if;

  perform 1
  from public.whatsapp_channels c
  where c.unit_id = p_unit_id
  order by c.id
  for update;

  select c.* into v_target
  from public.whatsapp_channels c
  where c.id = p_channel_id
    and c.unit_id = p_unit_id
  for update;

  if not found then
    raise exception 'channel_unit_mismatch' using errcode = 'check_violation';
  end if;
  if v_target.is_active is true then
    raise exception 'channel_already_active' using errcode = 'check_violation';
  end if;

  select u.organization_id into v_org_id
  from public.units u where u.id = p_unit_id;
  if v_org_id is null then
    raise exception 'channel_unit_not_found' using errcode = 'check_violation';
  end if;

  -- Uma unidade só pode preparar um alvo por vez. O canal anterior e suas
  -- credenciais permanecem intactos e ativos até activate.
  update public.whatsapp_channels c
  set activation_requested_at = null,
      activation_requested_by = null
  where c.unit_id = p_unit_id
    and c.id <> p_channel_id
    and c.activation_requested_at is not null;

  v_requested_at := now();
  update public.whatsapp_channels c
  set activation_requested_at = v_requested_at,
      activation_requested_by = p_actor_id
  where c.id = p_channel_id;

  insert into public.whatsapp_channel_lifecycle_events (
    organization_id, unit_id, channel_ref, event_type, provider,
    from_status, to_status, request_id, actor_id
  ) values (
    v_org_id, p_unit_id, p_channel_id, 'activation_requested',
    v_target.provider, v_target.status, v_target.status, p_request_id, p_actor_id
  );

  return query select p_channel_id, p_unit_id, v_requested_at;
end;
$$;

create or replace function public.activate_whatsapp_channel(
  p_unit_id uuid,
  p_channel_id uuid,
  p_actor_id uuid,
  p_request_id text default null
)
returns table (
  activated_channel_id uuid,
  previous_channel_id uuid,
  unit_id uuid,
  provider text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target record;
  v_previous_id uuid;
  v_previous_provider text;
  v_org_id uuid;
begin
  if p_request_id is not null and
     (length(p_request_id) not between 1 and 128 or p_request_id !~ '^[A-Za-z0-9._:-]+$') then
    raise exception 'invalid_request_id' using errcode = '22023';
  end if;

  -- O lock da unidade serializa cutovers de alvos diferentes sem deadlock.
  perform 1
  from public.units u
  where u.id = p_unit_id
  for update;
  if not found then
    raise exception 'channel_unit_not_found' using errcode = 'P0002';
  end if;

  select c.* into v_target
  from public.whatsapp_channels c
  where c.id = p_channel_id
  for update;

  if not found then
    raise exception 'channel_not_found' using errcode = 'P0002';
  end if;
  if v_target.status <> 'connected' then
    raise exception 'target_channel_not_connected' using errcode = 'check_violation';
  end if;
  if v_target.provisioning_claim_id is not null then
    raise exception 'target_channel_still_claimed' using errcode = 'check_violation';
  end if;
  if p_unit_id is null or v_target.unit_id <> p_unit_id then
    raise exception 'channel_unit_mismatch' using errcode = 'check_violation';
  end if;

  -- Serializa qualquer cutover concorrente da mesma unidade.
  perform 1
  from public.whatsapp_channels c
  where c.unit_id = v_target.unit_id
  order by c.id
  for update;

  if exists (
    select 1 from public.whatsapp_channels c
    where c.unit_id = v_target.unit_id
      and c.id <> v_target.id
      and c.is_active is true
  ) and v_target.activation_requested_at is null then
    raise exception 'activation_not_requested' using errcode = 'check_violation';
  end if;

  select c.id, c.provider into v_previous_id, v_previous_provider
  from public.whatsapp_channels c
  where c.unit_id = v_target.unit_id
    and c.id <> v_target.id
    and c.is_active is true
  order by c.updated_at desc, c.id
  limit 1;

  -- Em unidade ainda legada, o canal connected mais recente é somente a
  -- referência de auditoria; a autoridade muda para explícita neste cutover.
  if v_previous_id is null then
    select c.id, c.provider into v_previous_id, v_previous_provider
    from public.whatsapp_channels c
    where c.unit_id = v_target.unit_id
      and c.id <> v_target.id
      and c.status = 'connected'
    order by c.last_event_at desc nulls last, c.updated_at desc, c.id
    limit 1;
  end if;

  select u.organization_id into v_org_id
  from public.units u where u.id = v_target.unit_id;
  if v_org_id is null then
    raise exception 'channel_unit_not_found' using errcode = 'check_violation';
  end if;

  update public.whatsapp_channels c
  set is_active = false
  where c.unit_id = v_target.unit_id
    and c.id <> v_target.id
    and c.is_active is distinct from false;

  update public.whatsapp_channels c
  set is_active = true,
      connected_at = coalesce(c.connected_at, now()),
      activation_requested_at = null,
      activation_requested_by = null
  where c.id = v_target.id;

  insert into public.whatsapp_channel_lifecycle_events (
    organization_id, unit_id, channel_ref, related_channel_ref,
    event_type, provider, previous_provider, from_status, to_status,
    request_id, actor_id
  ) values (
    v_org_id, v_target.unit_id, v_target.id, v_previous_id,
    'activated', v_target.provider, v_previous_provider,
    v_target.status, 'connected', p_request_id, p_actor_id
  );

  return query select v_target.id, v_previous_id, v_target.unit_id, v_target.provider;
end;
$$;

-- ============================================================================
-- 11. ACL explícita das RPCs privilegiadas
-- ============================================================================

revoke all on function public.set_organization_default_whatsapp_provider(uuid, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.set_organization_default_whatsapp_provider(uuid, text, uuid, text)
  to service_role;

revoke all on function public.store_whatsapp_channel_instance_token(uuid, uuid, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.store_whatsapp_channel_instance_token(uuid, uuid, text, uuid, text)
  to service_role;

revoke all on function public.get_whatsapp_channel_instance_token(uuid)
  from public, anon, authenticated;
grant execute on function public.get_whatsapp_channel_instance_token(uuid)
  to service_role;

revoke all on function public.claim_whatsapp_channel_provisioning(uuid, uuid, integer, text)
  from public, anon, authenticated;
grant execute on function public.claim_whatsapp_channel_provisioning(uuid, uuid, integer, text)
  to service_role;

revoke all on function public.release_whatsapp_channel_provisioning(uuid, uuid, text, text, text, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.release_whatsapp_channel_provisioning(uuid, uuid, text, text, text, text, uuid, text)
  to service_role;

revoke all on function public.record_whatsapp_channel_status(uuid, uuid, text, text, text, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.record_whatsapp_channel_status(uuid, uuid, text, text, text, uuid, text, text)
  to service_role;

revoke all on function public.request_whatsapp_channel_activation(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.request_whatsapp_channel_activation(uuid, uuid, uuid, text)
  to service_role;

revoke all on function public.activate_whatsapp_channel(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.activate_whatsapp_channel(uuid, uuid, uuid, text)
  to service_role;

revoke all on function public.claim_processed_whatsapp_message(text, text, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.claim_processed_whatsapp_message(text, text, uuid, integer)
  to service_role;

revoke all on function public.complete_processed_whatsapp_message(text, text, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.complete_processed_whatsapp_message(text, text, uuid, text, text)
  to service_role;

commit;

-- Pós-db-push autorizado: rodar scripts/audit-function-acl.ts e confirmar que
-- as dez RPCs acima têm somente service_role em proacl. O preflight local
-- cobre CHECK/PK/backfill/claim fence/cutover; ele não prova RLS/PostgREST.
