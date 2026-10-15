-- Somente banco descartável: dependências mínimas e corpos de produção verbatim.
create table if not exists public.platform_admins (user_id uuid primary key);
alter table public.whatsapp_channels
  add column if not exists external_instance_id text,
  add column if not exists is_active boolean,
  add column if not exists template_credential_revision bigint not null default 0,
  add column if not exists provisioning_claim_id uuid,
  add column if not exists instance_token_secret_id uuid,
  add column if not exists manual_echo_verified_at timestamptz,
  add column if not exists manual_echo_verification_source text,
  add column if not exists activation_requested_at timestamptz,
  add column if not exists activation_requested_by uuid,
  add column if not exists connected_at timestamptz;
create schema if not exists app_private;
create table if not exists app_private.whatsapp_template_revision_permits(
  transaction_id bigint not null, channel_id uuid not null, claim_id uuid not null, revision bigint not null,
  primary key(transaction_id,channel_id)
);
create table if not exists public.whatsapp_channel_lifecycle_events(
  id uuid primary key default gen_random_uuid(), organization_id uuid, unit_id uuid,
  channel_ref uuid, related_channel_ref uuid, event_type text, provider text, previous_provider text,
  from_status text, to_status text, request_id text, actor_id uuid
);
-- Corpo verbatim da migration de produção; schema externo mínimo acima.
create or replace function public.guard_whatsapp_template_credential_revision()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_permitted boolean:=false;
begin
  if tg_op='INSERT' then
    if new.template_credential_revision<>0 then raise exception 'template_revision_invalid' using errcode='23514'; end if;
    return new;
  end if;
  -- No parent/account/binding/job locks or writes while owning a channel row.
  if new.template_credential_revision is distinct from old.template_credential_revision then
    delete from app_private.whatsapp_template_revision_permits where transaction_id=txid_current() and channel_id=old.id
      and claim_id=old.provisioning_claim_id and revision=old.template_credential_revision and new.template_credential_revision=old.template_credential_revision+1 returning true into v_permitted;
    if not coalesce(v_permitted,false) then raise exception 'template_revision_invalid' using errcode='23514'; end if;
  end if;
  if (new.provider,new.credentials,new.webhook_secret,new.instance_token_secret_id) is distinct from
    (old.provider,old.credentials,old.webhook_secret,old.instance_token_secret_id) then
    new.template_credential_revision:=old.template_credential_revision+1;
  end if;
  return new;
end $$;
revoke all on function public.guard_whatsapp_template_credential_revision() from public,anon,authenticated,service_role;
drop trigger if exists whatsapp_template_credential_revision on public.whatsapp_channels;
create trigger whatsapp_template_credential_revision before insert or update on public.whatsapp_channels for each row execute function public.guard_whatsapp_template_credential_revision();


-- Corpo verbatim da migration de produção; schema externo mínimo acima.
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


-- Corpo verbatim da migration de produção; schema externo mínimo acima.
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

revoke all on function public.request_whatsapp_channel_activation(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.request_whatsapp_channel_activation(uuid,uuid,uuid,text) to service_role;
revoke all on function public.activate_whatsapp_channel(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.activate_whatsapp_channel(uuid,uuid,uuid,text) to service_role;
