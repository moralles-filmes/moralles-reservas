-- Assinatura administrativa de canal Datafy já existente. Não reabre onboarding
-- terminal nem altera grant_id histórico. Banco antes de manage-channels.
-- Rollback: desabilitar novo provisionamento e voltar somente o app/bundle;
-- preservar e reconciliar claims vivos/incertos antes de retomar operações.
-- Manter colunas/RPCs para a reconciliação; não fazer DROP destrutivo.
alter table public.whatsapp_channels
  add column if not exists datafy_subscription_claim_id uuid,
  add column if not exists datafy_subscription_claim_expires_at timestamptz,
  add column if not exists datafy_subscription_claim_actor_id uuid,
  add column if not exists datafy_subscription_uncertain boolean not null default false;

do $$ begin
  if not exists (select 1 from pg_catalog.pg_constraint where conname = 'whatsapp_channels_datafy_operational_subscription_chk'
    and conrelid = 'public.whatsapp_channels'::regclass) then
    -- Bloqueia o eco com snapshot anterior ao cancel/pause na escrita final
    -- da ativação. Projeção NULL do legado manual continua permitida.
    alter table public.whatsapp_channels add constraint whatsapp_channels_datafy_operational_subscription_chk check (
      provider <> 'datafy' or is_active is distinct from true
      or (provider_subscription_canceled_at is null and provider_paused_at is null)
    );
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conname = 'whatsapp_channels_datafy_subscription_claim_chk'
    and conrelid = 'public.whatsapp_channels'::regclass) then
    alter table public.whatsapp_channels add constraint whatsapp_channels_datafy_subscription_claim_chk check (
      (datafy_subscription_claim_id is null) = (datafy_subscription_claim_expires_at is null)
      and (datafy_subscription_claim_id is null) = (datafy_subscription_claim_actor_id is null)
      and (datafy_subscription_claim_id is null or provider = 'datafy')
    );
  end if;
end $$;

create or replace function public.claim_datafy_existing_subscription(
  p_channel_id uuid, p_unit_id uuid, p_actor_id uuid, p_ttl_seconds integer default 120
)
returns table (claimed boolean, claim_id uuid, must_reconcile boolean, source text, onboarding_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  c public.whatsapp_channels%rowtype;
  o public.whatsapp_datafy_onboardings%rowtype;
  r record;
  v_claim uuid;
  v_ttl integer := greatest(30, least(coalesce(p_ttl_seconds, 120), 900));
  v_uncertain boolean;
begin
  -- Ator administrativo real, independente do JWT do cliente service-role.
  if p_actor_id is null or not exists(select 1 from public.platform_admins where user_id = p_actor_id) then
    raise exception 'datafy_subscription_forbidden' using errcode = '42501';
  end if;
  select * into c from public.whatsapp_channels where id = p_channel_id for update;
  if not found or c.unit_id is distinct from p_unit_id or c.provider <> 'datafy' or c.external_instance_id is null then
    raise exception 'datafy_subscription_forbidden' using errcode = '42501';
  end if;
  -- Uma cerca só para admin e self-service enquanto existir onboarding vivo.
  -- Busy nunca cai no lease alternativo do canal.
  select * into o from public.whatsapp_datafy_onboardings
    where unit_id = p_unit_id and reserved_channel_id = p_channel_id
      and state not in ('completed', 'abandoned') for update;
  if found then
    select * into r from public.claim_datafy_onboarding_step(o.id, p_unit_id, 'subscribe', p_actor_id, v_ttl);
    return query select r.claimed::boolean, r.claim_id::uuid, r.must_reconcile::boolean, 'onboarding'::text, o.id;
    return;
  end if;
  if c.datafy_subscription_claim_id is not null and c.datafy_subscription_claim_expires_at > pg_catalog.now() then
    return query select false, null::uuid, false, 'channel'::text, null::uuid;
    return;
  end if;
  v_uncertain := c.datafy_subscription_uncertain or c.datafy_subscription_claim_id is not null;
  v_claim := pg_catalog.gen_random_uuid();
  update public.whatsapp_channels set datafy_subscription_claim_id = v_claim,
    datafy_subscription_claim_expires_at = pg_catalog.now() + pg_catalog.make_interval(secs => v_ttl),
    datafy_subscription_claim_actor_id = p_actor_id, datafy_subscription_uncertain = v_uncertain
    where id = p_channel_id;
  return query select true, v_claim, v_uncertain, 'channel'::text, null::uuid;
end $$;
revoke all on function public.claim_datafy_existing_subscription(uuid,uuid,uuid,integer) from public, anon, authenticated;
grant execute on function public.claim_datafy_existing_subscription(uuid,uuid,uuid,integer) to service_role;

-- Não aceita source/onboarding_id do caller: esta RPC libera SOMENTE lease
-- do próprio canal. Fonte onboarding usa a RPC original, cercada por id/step.
create or replace function public.release_datafy_existing_subscription(
  p_channel_id uuid, p_unit_id uuid, p_claim_id uuid, p_outcome text, p_error_code text default null
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare c public.whatsapp_channels%rowtype;
begin
  if p_outcome is null or p_outcome not in ('succeeded', 'failed', 'uncertain', 'reconciled_absent', 'reconciled_present')
    or (p_error_code is not null and p_error_code !~ '^[A-Z0-9_]{1,64}$') then
    raise exception 'invalid_subscription_outcome' using errcode = '22023';
  end if;
  select * into c from public.whatsapp_channels where id = p_channel_id for update;
  if not found or c.unit_id is distinct from p_unit_id or c.provider <> 'datafy' then
    raise exception 'datafy_subscription_forbidden' using errcode = '42501';
  end if;
  if p_claim_id is null or c.datafy_subscription_claim_id is distinct from p_claim_id then
    raise exception 'stale_datafy_subscription_claim' using errcode = '40001';
  end if;
  update public.whatsapp_channels set
    datafy_subscription_uncertain = case when p_outcome = 'uncertain' then true
      when p_outcome = 'failed' then c.datafy_subscription_uncertain else false end,
    datafy_subscription_claim_id = null, datafy_subscription_claim_expires_at = null,
    datafy_subscription_claim_actor_id = null, last_error = p_error_code
    where id = p_channel_id;
  return true;
end $$;
revoke all on function public.release_datafy_existing_subscription(uuid,uuid,uuid,text,text) from public, anon, authenticated;
grant execute on function public.release_datafy_existing_subscription(uuid,uuid,uuid,text,text) to service_role;
