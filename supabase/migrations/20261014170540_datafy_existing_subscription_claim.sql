-- Assinatura administrativa de canal Datafy já existente. Não reabre onboarding
-- terminal nem altera grant_id histórico. Banco antes de manage-channels.
-- Rollback: desabilitar novo provisionamento e voltar somente o app/bundle;
-- preservar e reconciliar claims vivos/incertos antes de retomar operações.
-- Manter colunas/RPCs para a reconciliação; não fazer DROP destrutivo.
-- O runner pode executar cada statement separadamente: manter DDL, backfill
-- e instalação dos triggers na mesma transação preserva os locks até o fim.
begin;

alter table public.whatsapp_channels add column if not exists datafy_subscription_required boolean not null default false;
-- Proveniência persistente: nem apagar o histórico nem um UPDATE administrativo
-- transforma um canal self-service em legado manual com assinatura desconhecida.
update public.whatsapp_channels c set datafy_subscription_required=true
where c.provider='datafy' and not c.datafy_subscription_required
  and exists(select from public.whatsapp_datafy_onboardings o where o.reserved_channel_id=c.id);
create or replace function public.guard_datafy_subscription_origin()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op='UPDATE' and old.datafy_subscription_required and not new.datafy_subscription_required then
    raise exception 'datafy_subscription_origin_immutable' using errcode='23514';
  end if;
  if tg_op='INSERT' and new.provider='datafy' and exists(select from public.whatsapp_datafy_onboardings where reserved_channel_id=new.id) then
    new.datafy_subscription_required:=true;
  end if;
  return new;
end $$;
revoke all on function public.guard_datafy_subscription_origin() from public,anon,authenticated,service_role;
drop trigger if exists guard_datafy_subscription_origin on public.whatsapp_channels;
create trigger guard_datafy_subscription_origin before insert or update on public.whatsapp_channels
  for each row execute function public.guard_datafy_subscription_origin();
do $$ begin
  if not exists(select from pg_catalog.pg_constraint where conname='whatsapp_channels_datafy_self_service_subscription_chk'
    and conrelid='public.whatsapp_channels'::regclass) then
    alter table public.whatsapp_channels add constraint whatsapp_channels_datafy_self_service_subscription_chk check (
      provider<>'datafy' or not datafy_subscription_required
      or (is_active is distinct from true and activation_requested_at is null)
      or (provider_subscribed_at is not null and provider_subscription_canceled_at is null and provider_paused_at is null));
  end if;
end $$;

-- Uma única autoridade WABA→organização para canal e conta de templates.
-- A reserva sobrevive a apagar/revincular canais; não é licença de template.
-- FK restritiva deliberada: transferência/offboarding exige procedimento
-- administrativo explícito; apagar a organização nunca libera WABA por cascata.
create table if not exists public.whatsapp_waba_owners (
  waba_id text primary key check (btrim(waba_id,E' \t\r\n')=waba_id and waba_id<>''),
  organization_id uuid not null references public.organizations(id),
  created_at timestamptz not null default pg_catalog.now()
);
create index if not exists whatsapp_waba_owners_organization_id_idx
  on public.whatsapp_waba_owners(organization_id);
alter table public.whatsapp_waba_owners enable row level security;
alter table public.whatsapp_waba_owners force row level security;
revoke all on table public.whatsapp_waba_owners from public,anon,authenticated,service_role;

create or replace function public.reserve_whatsapp_waba_owner(p_waba_id text,p_organization_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_waba text:=nullif(btrim(p_waba_id,E' \t\r\n'),''); v_org uuid;
begin
  if v_waba is null or p_organization_id is null then raise exception 'invalid_waba_owner' using errcode='22023'; end if;
  -- ON CONFLICT aguarda o insert concorrente, inclusive de template account.
  -- Nenhum lock em conta/canal é tomado aqui (evita inversão dos pais).
  insert into public.whatsapp_waba_owners(waba_id,organization_id) values(v_waba,p_organization_id) on conflict(waba_id) do nothing;
  select organization_id into v_org from public.whatsapp_waba_owners where waba_id=v_waba;
  if v_org is distinct from p_organization_id then raise exception 'waba_organization_conflict' using errcode='PT409'; end if;
end $$;
revoke all on function public.reserve_whatsapp_waba_owner(text,uuid) from public,anon,authenticated,service_role;

create or replace function public.guard_whatsapp_waba_owner()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_waba text; v_org uuid;
begin
  if tg_table_name='whatsapp_channels' then
    if new.provider not in ('datafy','official') then return new; end if;
    v_waba:=nullif(btrim(new.credentials->>'business_account_id',E' \t\r\n'),'');
    if v_waba is null then return new; end if;
    select organization_id into v_org from public.units where id=new.unit_id;
  else
    v_waba:=new.waba_id; v_org:=new.organization_id;
  end if;
  perform public.reserve_whatsapp_waba_owner(v_waba,v_org);
  return new;
end $$;
revoke all on function public.guard_whatsapp_waba_owner() from public,anon,authenticated,service_role;
-- Backfill fail-closed: conflito prévio exige reconciliação, não vencedor casual.
-- Preflight (somente leitura, executar no gate de rollout ANTES do db push):
-- with owners as (
--   select waba_id,organization_id from public.whatsapp_template_accounts
--   union select nullif(btrim(c.credentials->>'business_account_id',E' \t\r\n'),''),u.organization_id
--     from public.whatsapp_channels c join public.units u on u.id=c.unit_id where c.provider in ('datafy','official')
-- ) select waba_id from owners where waba_id is not null group by waba_id having count(distinct organization_id)>1;
lock table public.whatsapp_template_accounts in share row exclusive mode;
do $$ declare r record; begin
  for r in select a.waba_id,a.organization_id from public.whatsapp_template_accounts a
    union select nullif(btrim(c.credentials->>'business_account_id',E' \t\r\n'),''),u.organization_id
      from public.whatsapp_channels c join public.units u on u.id=c.unit_id where c.provider in ('datafy','official')
  loop
    if r.waba_id is not null then perform public.reserve_whatsapp_waba_owner(r.waba_id,r.organization_id); end if;
  end loop;
end $$;
drop trigger if exists guard_whatsapp_channel_waba_owner on public.whatsapp_channels;
create trigger guard_whatsapp_channel_waba_owner before insert or update of provider,credentials,unit_id on public.whatsapp_channels
  for each row execute function public.guard_whatsapp_waba_owner();
drop trigger if exists guard_whatsapp_template_waba_owner on public.whatsapp_template_accounts;
create trigger guard_whatsapp_template_waba_owner before insert or update of waba_id,organization_id on public.whatsapp_template_accounts
  for each row execute function public.guard_whatsapp_waba_owner();

-- Chamadores transacionais tomam unit → canais ordenados antes de decidir.
-- Mesmo provider é permitido; false nunca faz parte do fallback legado.
create or replace function public.assert_datafy_first_configuration(p_unit_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_provider text;
begin
  perform 1 from public.units where id=p_unit_id for update;
  perform 1 from public.whatsapp_channels where unit_id=p_unit_id order by id for update;
  select provider into v_provider from public.whatsapp_channels where unit_id=p_unit_id
    and (is_active is true or (is_active is null and status='connected'))
    order by (is_active is true) desc,created_at asc nulls last,id limit 1;
  if v_provider is not null and v_provider<>'datafy' then
    raise exception 'datafy_migration_not_supported' using errcode='23514';
  end if;
end $$;
revoke all on function public.assert_datafy_first_configuration(uuid) from public,anon,authenticated,service_role;

alter table public.whatsapp_channels
  add column if not exists datafy_subscription_claim_id uuid,
  add column if not exists datafy_subscription_claim_expires_at timestamptz,
  add column if not exists datafy_subscription_claim_actor_id uuid,
  add column if not exists datafy_subscription_uncertain boolean not null default false,
  add column if not exists datafy_subscription_operation text,
  add column if not exists datafy_subscription_uncertain_operation text;

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

-- O self-service também respeita o lease de uma ação administrativa. Ambos
-- serializam no onboarding quando ele existe; a leitura não trava canal depois
-- de onboarding (ordem inversa criaria deadlock com o claim administrativo).
create or replace function public.claim_datafy_onboarding_step(
  p_onboarding_id uuid, p_unit_id uuid, p_step text, p_actor_id uuid, p_ttl_seconds integer default 120
)
returns table (claimed boolean, claim_id uuid, must_reconcile boolean, state text)
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.whatsapp_datafy_onboardings%rowtype;
  v_ttl integer := greatest(30, least(coalesce(p_ttl_seconds,120),900));
  v_claim uuid; v_uncertain text[]; v_must_reconcile boolean;
begin
  if p_step is null or p_step not in ('create_channel','create_webhook','subscribe') then
    raise exception 'invalid_onboarding_step' using errcode='22023';
  end if;
  select * into v_row from public.whatsapp_datafy_onboardings where id=p_onboarding_id for update;
  if not found then raise exception 'onboarding_not_found' using errcode='P0002'; end if;
  if v_row.unit_id is distinct from p_unit_id then raise exception 'onboarding_unit_mismatch' using errcode='42501'; end if;
  if v_row.state in ('completed','abandoned') then raise exception 'onboarding_closed' using errcode='23514'; end if;
  if exists(select 1 from public.whatsapp_channels c where c.id=v_row.reserved_channel_id
    and (c.datafy_subscription_claim_id is not null or c.datafy_subscription_uncertain)) then
    return query select false,null::uuid,false,v_row.state; return;
  end if;
  if v_row.claim_id is not null
     -- <ttl>
     and v_row.claim_expires_at > pg_catalog.now()
     -- </ttl>
  then return query select false,null::uuid,false,v_row.state; return; end if;
  v_uncertain:=v_row.uncertain_steps;
  -- <takeover-incerto>
  if v_row.claim_id is not null and not(v_row.claim_step=any(v_uncertain)) then
    v_uncertain:=pg_catalog.array_append(v_uncertain,v_row.claim_step);
  end if;
  -- </takeover-incerto>
  v_must_reconcile:=v_row.claim_id is not null or p_step=any(v_uncertain);
  v_claim:=pg_catalog.gen_random_uuid();
  update public.whatsapp_datafy_onboardings set claim_id=v_claim,claim_step=p_step,
    claim_started_at=pg_catalog.now(),claim_expires_at=pg_catalog.now()+pg_catalog.make_interval(secs=>v_ttl),
    claim_actor_id=p_actor_id,uncertain_steps=v_uncertain where id=p_onboarding_id;
  return query select true,v_claim,v_must_reconcile,v_row.state;
end $$;
revoke all on function public.claim_datafy_onboarding_step(uuid,uuid,text,uuid,integer) from public,anon,authenticated;
grant execute on function public.claim_datafy_onboarding_step(uuid,uuid,text,uuid,integer) to service_role;

create or replace function public.claim_datafy_channel_operation(
  p_channel_id uuid, p_unit_id uuid, p_actor_id uuid, p_operation text, p_ttl_seconds integer default 120
)
returns table (claimed boolean, claim_id uuid, must_reconcile boolean, source text, onboarding_id uuid,
  reconcile_operation text, external_instance_id text, template_credential_revision bigint)
language plpgsql security definer set search_path = '' as $$
declare
  c public.whatsapp_channels%rowtype;
  o public.whatsapp_datafy_onboardings%rowtype;
  r record;
  v_claim uuid;
  v_ttl integer := greatest(30, least(coalesce(p_ttl_seconds, 120), 900));
  v_uncertain boolean; v_prior text; v_onboarding_found boolean;
begin
  if p_operation is null or p_operation not in ('subscribe','cancel','pause','resume','relink','configure_webhook') then
    raise exception 'invalid_datafy_operation' using errcode='22023';
  end if;
  -- Ator administrativo real, independente do JWT do cliente service-role.
  if p_actor_id is null or not exists(select 1 from public.platform_admins where user_id = p_actor_id) then
    raise exception 'datafy_subscription_forbidden' using errcode = '42501';
  end if;
  select * into c from public.whatsapp_channels where id = p_channel_id for update;
  if not found or c.unit_id is distinct from p_unit_id or c.provider <> 'datafy'
    or (c.external_instance_id is null and p_operation<>'relink') then
    raise exception 'datafy_subscription_forbidden' using errcode = '42501';
  end if;
  -- Terminal não prova ausência de POST: inclui claim e incerteza históricos.
  select * into o from public.whatsapp_datafy_onboardings
    where unit_id = p_unit_id and reserved_channel_id = p_channel_id
    for update;
  v_onboarding_found:=found;
  if v_onboarding_found and o.claim_id is not null and o.claim_expires_at>pg_catalog.now() then
    return query select false,null::uuid,false,'onboarding'::text,o.id,null::text,c.external_instance_id,c.template_credential_revision; return;
  end if;
  if c.datafy_subscription_claim_id is not null and c.datafy_subscription_claim_expires_at>pg_catalog.now() then
    return query select false,null::uuid,false,'channel'::text,null::uuid,null::text,c.external_instance_id,c.template_credential_revision; return;
  end if;
  if v_onboarding_found and o.state in ('completed','abandoned')
    and (o.claim_id is not null or cardinality(o.uncertain_steps)>0) then
    if p_operation<>'subscribe' or o.datafy_channel_id is distinct from c.external_instance_id
      or (o.claim_id is not null and o.claim_step<>'subscribe')
      or not(o.uncertain_steps <@ array['subscribe']::text[]) then
      raise exception 'datafy_onboarding_reconciliation_required' using errcode='23514';
    end if;
    -- Admin continua a MESMA cerca terminal; self-service continua recusado.
    v_claim:=pg_catalog.gen_random_uuid();
    update public.whatsapp_datafy_onboardings set claim_id=v_claim,claim_step='subscribe',claim_started_at=pg_catalog.now(),
      claim_expires_at=pg_catalog.now()+pg_catalog.make_interval(secs=>v_ttl),claim_actor_id=p_actor_id,
      uncertain_steps=array['subscribe']::text[] where id=o.id;
    return query select true,v_claim,true,'onboarding'::text,o.id,'subscribe'::text,c.external_instance_id,c.template_credential_revision; return;
  end if;
  if v_onboarding_found and o.state not in ('completed','abandoned') and p_operation='relink' then
    raise exception 'datafy_onboarding_in_progress' using errcode='23514';
  end if;
  if v_onboarding_found and (o.claim_id is not null or cardinality(o.uncertain_steps)>0) and p_operation<>'subscribe' then
    raise exception 'datafy_onboarding_reconciliation_required' using errcode='23514';
  end if;
  v_uncertain:=c.datafy_subscription_uncertain or c.datafy_subscription_claim_id is not null;
  v_prior:=case when v_uncertain then coalesce(c.datafy_subscription_uncertain_operation,c.datafy_subscription_operation,'subscribe') end;
  if not v_uncertain and v_onboarding_found and o.state not in ('completed','abandoned') and p_operation='subscribe' then
    select * into r from public.claim_datafy_onboarding_step(o.id, p_unit_id, 'subscribe', p_actor_id, v_ttl);
    return query select r.claimed::boolean,r.claim_id::uuid,r.must_reconcile::boolean,'onboarding'::text,o.id,
      case when r.must_reconcile then 'subscribe'::text end,c.external_instance_id,c.template_credential_revision;
    return;
  end if;
  v_claim := pg_catalog.gen_random_uuid();
  update public.whatsapp_channels set datafy_subscription_claim_id = v_claim,
    datafy_subscription_claim_expires_at = pg_catalog.now() + pg_catalog.make_interval(secs => v_ttl),
    datafy_subscription_claim_actor_id=p_actor_id,datafy_subscription_uncertain=v_uncertain,
    datafy_subscription_operation=p_operation,datafy_subscription_uncertain_operation=v_prior
    where id = p_channel_id;
  return query select true,v_claim,v_uncertain,'channel'::text,null::uuid,v_prior,c.external_instance_id,c.template_credential_revision;
end $$;
revoke all on function public.claim_datafy_channel_operation(uuid,uuid,uuid,text,integer) from public,anon,authenticated;
grant execute on function public.claim_datafy_channel_operation(uuid,uuid,uuid,text,integer) to service_role;

-- Compatibilidade: assinatura pública anterior, mesmo retorno e mesma cerca.
create or replace function public.claim_datafy_existing_subscription(
  p_channel_id uuid,p_unit_id uuid,p_actor_id uuid,p_ttl_seconds integer default 120
) returns table(claimed boolean,claim_id uuid,must_reconcile boolean,source text,onboarding_id uuid)
language sql security definer set search_path = '' as $$
  select r.claimed,r.claim_id,r.must_reconcile,r.source,r.onboarding_id
    from public.claim_datafy_channel_operation(p_channel_id,p_unit_id,p_actor_id,'subscribe',p_ttl_seconds) r;
$$;
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
    datafy_subscription_uncertain_operation=case when p_outcome='uncertain' then coalesce(c.datafy_subscription_uncertain_operation,c.datafy_subscription_operation,'subscribe')
      when p_outcome='failed' then c.datafy_subscription_uncertain_operation else null end,
    datafy_subscription_claim_id = null, datafy_subscription_claim_expires_at = null,
    datafy_subscription_claim_actor_id=null,datafy_subscription_operation=null,last_error=p_error_code
    where id = p_channel_id;
  return true;
end $$;
revoke all on function public.release_datafy_existing_subscription(uuid,uuid,uuid,text,text) from public, anon, authenticated;
grant execute on function public.release_datafy_existing_subscription(uuid,uuid,uuid,text,text) to service_role;

create or replace function public.guard_datafy_channel_identity()
returns trigger language plpgsql security definer set search_path = '' as $$
declare o public.whatsapp_datafy_onboardings%rowtype; v_own_relink boolean;
begin
  if old.provider<>'datafy' or (new.provider,new.external_instance_id,new.credentials,new.webhook_secret)
    is not distinct from (old.provider,old.external_instance_id,old.credentials,old.webhook_secret) then return new; end if;
  select * into o from public.whatsapp_datafy_onboardings where reserved_channel_id=old.id for update;
  if found and (o.claim_id is not null or cardinality(o.uncertain_steps)>0) then
    raise exception 'datafy_identity_reconciliation_required' using errcode='23514';
  end if;
  -- O writer de relink limpa a sua cerca e troca identidade em UMA transação;
  -- UPDATE genérico conserva o lease e é recusado. Erro restaura tudo.
  v_own_relink:=old.datafy_subscription_claim_id is not null and old.datafy_subscription_operation is not distinct from 'relink'
    and not old.datafy_subscription_uncertain and new.datafy_subscription_claim_id is null
    and new.datafy_subscription_claim_expires_at is null and new.datafy_subscription_claim_actor_id is null;
  if old.datafy_subscription_uncertain or (old.datafy_subscription_claim_id is not null and not v_own_relink) then
    raise exception 'datafy_identity_reconciliation_required' using errcode='23514';
  end if;
  return new;
end $$;
revoke all on function public.guard_datafy_channel_identity() from public,anon,authenticated,service_role;
drop trigger if exists guard_datafy_channel_identity on public.whatsapp_channels;
create trigger guard_datafy_channel_identity before update on public.whatsapp_channels
  for each row execute function public.guard_datafy_channel_identity();

create or replace function public.apply_datafy_channel_relink(
  p_channel_id uuid,p_unit_id uuid,p_actor_id uuid,p_claim_id uuid,p_expected_external_id text,
  p_expected_revision bigint,p_external_id text,p_channel_token text,p_webhook_secret text
) returns table(id uuid,external_instance_id text,template_credential_revision bigint)
language plpgsql security definer set search_path = '' as $$
declare c public.whatsapp_channels%rowtype;
begin
  select * into c from public.whatsapp_channels where whatsapp_channels.id=p_channel_id for update;
  if not found or c.unit_id is distinct from p_unit_id or c.provider<>'datafy'
    or not exists(select 1 from public.platform_admins where user_id=p_actor_id) then
    raise exception 'datafy_relink_forbidden' using errcode='42501';
  end if;
  if p_claim_id is null or c.datafy_subscription_claim_id is distinct from p_claim_id
    or c.datafy_subscription_operation is distinct from 'relink' or c.datafy_subscription_claim_actor_id is distinct from p_actor_id
    or c.datafy_subscription_claim_expires_at<=pg_catalog.now() or c.datafy_subscription_uncertain
    or c.external_instance_id is distinct from p_expected_external_id or c.template_credential_revision is distinct from p_expected_revision then
    raise exception 'stale_datafy_relink_claim' using errcode='40001';
  end if;
  if p_external_id is null or p_external_id !~ '^[A-Za-z0-9_-]{1,128}$' or p_channel_token is null
    or btrim(p_channel_token)='' or p_webhook_secret is null or btrim(p_webhook_secret)='' then
    raise exception 'invalid_datafy_relink' using errcode='22023';
  end if;
  return query update public.whatsapp_channels ch set external_instance_id=p_external_id,
    credentials=jsonb_set(ch.credentials,'{access_token}',to_jsonb(p_channel_token)),webhook_secret=p_webhook_secret,
    is_active=false,manual_echo_verified_at=null,manual_echo_verification_source=null,
    activation_requested_at=null,activation_requested_by=null,
    provider_subscribed_at=null,provider_subscription_canceled_at=null,provider_paused_at=null,
    datafy_subscription_claim_id=null,datafy_subscription_claim_expires_at=null,datafy_subscription_claim_actor_id=null,
    datafy_subscription_operation=null,datafy_subscription_uncertain_operation=null
    where ch.id=p_channel_id returning ch.id,ch.external_instance_id,ch.template_credential_revision;
end $$;
revoke all on function public.apply_datafy_channel_relink(uuid,uuid,uuid,uuid,text,bigint,text,text,text) from public,anon,authenticated;
grant execute on function public.apply_datafy_channel_relink(uuid,uuid,uuid,uuid,text,bigint,text,text,text) to service_role;

-- Fato remoto do próprio lease/pin, também quando o grant foi revogado.
-- Cerca no writer, não só no finisher: dono antigo não apaga cancel/pause que
-- um sucessor gravou na MESMA geração depois de assumir a assinatura.
create or replace function public.record_datafy_channel_state(
  p_channel_id uuid,p_unit_id uuid,p_actor_id uuid,p_claim_id uuid,p_onboarding_id uuid,
  p_external_id text,p_revision bigint,p_subscribed boolean,p_paused boolean
) returns boolean language plpgsql security definer set search_path = '' as $$
declare c public.whatsapp_channels%rowtype; o public.whatsapp_datafy_onboardings%rowtype;
begin
  if p_subscribed is null or p_paused is null or p_actor_id is null then raise exception 'invalid_datafy_state' using errcode='22023'; end if;
  perform 1 from public.units where id=p_unit_id for update;
  perform 1 from public.whatsapp_channels where unit_id=p_unit_id order by id for update;
  select * into c from public.whatsapp_channels where id=p_channel_id;
  if not found or c.unit_id is distinct from p_unit_id or c.provider<>'datafy' then
    raise exception 'datafy_projection_forbidden' using errcode='42501';
  end if;
  if p_claim_id is null or c.external_instance_id is distinct from p_external_id or c.template_credential_revision is distinct from p_revision then
    raise exception 'stale_datafy_projection_claim' using errcode='40001';
  end if;
  if p_onboarding_id is not null then
    select * into o from public.whatsapp_datafy_onboardings where id=p_onboarding_id for update;
    if not found or o.unit_id is distinct from p_unit_id or o.reserved_channel_id is distinct from p_channel_id
      or o.datafy_channel_id is distinct from p_external_id or o.claim_id is distinct from p_claim_id or o.claim_step is distinct from 'subscribe'
      or o.claim_actor_id is distinct from p_actor_id then
      raise exception 'stale_datafy_projection_claim' using errcode='40001';
    end if;
  elsif c.datafy_subscription_claim_id is distinct from p_claim_id or c.datafy_subscription_claim_actor_id is distinct from p_actor_id then
    raise exception 'stale_datafy_projection_claim' using errcode='40001';
  end if;
  update public.whatsapp_channels set
    provider_subscribed_at=case when p_subscribed then coalesce(c.provider_subscribed_at,pg_catalog.now()) end,
    provider_subscription_canceled_at=case when not p_subscribed then coalesce(c.provider_subscription_canceled_at,pg_catalog.now()) end,
    provider_paused_at=case when p_paused then coalesce(c.provider_paused_at,pg_catalog.now()) end,
    is_active=case when not p_subscribed or p_paused then false else c.is_active end,
    activation_requested_at=case when not p_subscribed or p_paused then null else c.activation_requested_at end,
    activation_requested_by=case when not p_subscribed or p_paused then null else c.activation_requested_by end
    where id=p_channel_id;
  return true;
end $$;
revoke all on function public.record_datafy_channel_state(uuid,uuid,uuid,uuid,uuid,text,bigint,boolean,boolean) from public,anon,authenticated;
grant execute on function public.record_datafy_channel_state(uuid,uuid,uuid,uuid,uuid,text,bigint,boolean,boolean) to service_role;

-- A leitura de pin seguida de UPDATE/RPCs separados permitiria relink entre
-- consumo e ativação. Mesma ordem de locks da autoridade de cutover: unit →
-- channels ordenados → onboarding → grant. Falha faz rollback de todo finisher.
create or replace function public.finalize_datafy_channel_subscription(
  p_channel_id uuid,p_unit_id uuid,p_actor_id uuid,p_claim_id uuid,p_onboarding_id uuid,
  p_grant_id uuid,p_external_id text,p_revision bigint,p_request_id text
) returns text language plpgsql security definer set search_path = '' as $$
declare c public.whatsapp_channels%rowtype; o public.whatsapp_datafy_onboardings%rowtype;
  g public.whatsapp_official_connection_grants%rowtype;
begin
  perform 1 from public.units where id=p_unit_id for update;
  perform 1 from public.whatsapp_channels where unit_id=p_unit_id order by id for update;
  select * into c from public.whatsapp_channels where id=p_channel_id;
  if not found or c.unit_id is distinct from p_unit_id or c.provider<>'datafy' then
    raise exception 'datafy_finalize_forbidden' using errcode='42501';
  end if;
  if p_claim_id is null or c.external_instance_id is distinct from p_external_id or c.template_credential_revision is distinct from p_revision then
    raise exception 'stale_datafy_finalize_claim' using errcode='40001';
  end if;
  if p_onboarding_id is not null then
    select * into o from public.whatsapp_datafy_onboardings where id=p_onboarding_id for update;
    if not found or o.unit_id is distinct from p_unit_id or o.reserved_channel_id is distinct from p_channel_id
      or o.datafy_channel_id is distinct from p_external_id or o.claim_id is distinct from p_claim_id
      or o.claim_step is distinct from 'subscribe' or o.claim_actor_id is distinct from p_actor_id then
      raise exception 'stale_datafy_finalize_claim' using errcode='40001';
    end if;
  elsif c.datafy_subscription_claim_id is distinct from p_claim_id or c.datafy_subscription_claim_actor_id is distinct from p_actor_id
    or c.datafy_subscription_operation is null or c.datafy_subscription_operation not in ('subscribe','configure_webhook') then
    raise exception 'stale_datafy_finalize_claim' using errcode='40001';
  end if;
  if c.provider_subscribed_at is null then return 'subscription_not_confirmed'; end if;
  if p_grant_id is null then
    -- Somente o link administrativo de canal JÁ assinado dispensa nova liberação;
    -- um claim de subscribe nunca ganha esse caminho sem custo autorizado.
    if p_onboarding_id is not null or c.datafy_subscription_operation is distinct from 'configure_webhook'
      or not exists(select 1 from public.platform_admins where user_id=p_actor_id) then
      raise exception 'datafy_finalize_grant_required' using errcode='42501';
    end if;
  else
    select * into g from public.whatsapp_official_connection_grants where id=p_grant_id for update;
    if not found or g.unit_id is distinct from p_unit_id then raise exception 'datafy_finalize_forbidden' using errcode='42501'; end if;
    if g.revoked_at is not null or (g.consumed_channel_id is not null and g.consumed_channel_id<>p_channel_id) then
      return 'grant_revoked';
    end if;
    if g.consumed_at is null then
      update public.whatsapp_official_connection_grants set consumed_channel_id=p_channel_id,consumed_at=pg_catalog.now() where id=g.id;
    end if;
  end if;
  if c.provider_subscription_canceled_at is null and c.provider_paused_at is null and c.is_active is distinct from true then
    perform public.assert_datafy_first_configuration(p_unit_id);
    if c.activation_requested_at is null then
      perform public.request_whatsapp_channel_activation(p_unit_id,p_channel_id,p_actor_id,p_request_id);
    end if;
    if c.manual_echo_verified_at is not null and c.status='connected' then
      perform public.activate_whatsapp_channel(p_unit_id,p_channel_id,p_actor_id,p_request_id);
    end if;
  end if;
  if p_onboarding_id is not null and o.state not in ('completed','abandoned') then
    update public.whatsapp_datafy_onboardings set state='completed',completed_at=pg_catalog.now(),channel_token=null,webhook_secret=null where id=o.id;
  end if;
  return 'finalized';
end $$;
revoke all on function public.finalize_datafy_channel_subscription(uuid,uuid,uuid,uuid,uuid,uuid,text,bigint,text) from public,anon,authenticated;
grant execute on function public.finalize_datafy_channel_subscription(uuid,uuid,uuid,uuid,uuid,uuid,text,bigint,text) to service_role;

-- Última autorização antes do HTTP: não renova lease nem resolve incerteza.
-- 25s = timeout máximo HTTP (20s) + margem; clock_timestamp inclui awaits de
-- locks desta transação. Não é promessa de exactly-once com o provider.
create or replace function public.authorize_datafy_mutation(
  p_unit_id uuid,p_channel_id uuid,p_actor_id uuid,p_claim_id uuid,p_onboarding_id uuid,
  p_operation text,p_external_id text,p_revision bigint,p_grant_id uuid
) returns boolean language plpgsql security definer set search_path = '' as $$
declare c public.whatsapp_channels%rowtype; o public.whatsapp_datafy_onboardings%rowtype;
  g public.whatsapp_official_connection_grants%rowtype; v_expiry timestamptz;
begin
  if p_operation is null or p_operation not in ('create_channel','create_webhook','subscribe','cancel','pause','resume','configure_webhook')
    or p_actor_id is null or p_claim_id is null then return false; end if;
  perform 1 from public.units where id=p_unit_id for update;
  perform 1 from public.whatsapp_channels where unit_id=p_unit_id order by id for update;
  if p_onboarding_id is not null then
    select * into o from public.whatsapp_datafy_onboardings where id=p_onboarding_id for update;
    if not found or o.unit_id is distinct from p_unit_id or o.reserved_channel_id is distinct from p_channel_id
      or o.claim_id is distinct from p_claim_id or o.claim_actor_id is distinct from p_actor_id
      or o.claim_step is distinct from p_operation or cardinality(o.uncertain_steps)>0
      or o.state in ('completed','abandoned') or o.datafy_channel_id is distinct from p_external_id then return false; end if;
    v_expiry:=o.claim_expires_at;
    if p_operation='create_channel' and (o.state<>'open' or o.datafy_channel_id is not null) then return false; end if;
    if p_operation='create_webhook' and (o.state<>'channel_created' or o.datafy_channel_id is null) then return false; end if;
    if not exists(select from public.platform_admins where user_id=p_actor_id)
      and not exists(select from public.unit_members where unit_id=p_unit_id and user_id=p_actor_id and role in ('owner','gerente')) then return false; end if;
  end if;
  if p_operation not in ('create_channel','create_webhook') then
    select * into c from public.whatsapp_channels where id=p_channel_id;
    if not found or c.unit_id is distinct from p_unit_id or c.provider<>'datafy'
      or c.external_instance_id is distinct from p_external_id or c.template_credential_revision is distinct from p_revision then return false; end if;
    if p_onboarding_id is null then
      if not exists(select from public.platform_admins where user_id=p_actor_id)
        or c.datafy_subscription_claim_id is distinct from p_claim_id
        or c.datafy_subscription_claim_actor_id is distinct from p_actor_id
        or c.datafy_subscription_operation is distinct from p_operation or c.datafy_subscription_uncertain then return false; end if;
      v_expiry:=c.datafy_subscription_claim_expires_at;
    end if;
  elsif p_onboarding_id is null then return false;
  end if;
  if p_operation in ('create_channel','subscribe') then
    perform public.assert_datafy_first_configuration(p_unit_id);
    select * into g from public.whatsapp_official_connection_grants where id=p_grant_id for update;
    if not found or g.unit_id is distinct from p_unit_id or g.revoked_at is not null or g.consumed_at is not null then return false; end if;
    if p_onboarding_id is not null and not exists(select from public.platform_admins where user_id=p_actor_id)
      and o.grant_id is distinct from g.id then return false; end if;
  end if;
  return coalesce(v_expiry >= pg_catalog.clock_timestamp()+interval '25 seconds',false);
end $$;
revoke all on function public.authorize_datafy_mutation(uuid,uuid,uuid,uuid,uuid,text,text,bigint,uuid) from public,anon,authenticated;
grant execute on function public.authorize_datafy_mutation(uuid,uuid,uuid,uuid,uuid,text,text,bigint,uuid) to service_role;

-- Corpo de cutover preservado, com guarda Datafy sob o lock da unidade.
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

  -- Guarda Datafy antes de desativar o canal anterior, inclusive no eco.
  if v_target.provider='datafy' then
    perform public.assert_datafy_first_configuration(p_unit_id);
    if v_target.datafy_subscription_required and (v_target.provider_subscribed_at is null
      or v_target.provider_subscription_canceled_at is not null or v_target.provider_paused_at is not null) then
      raise exception 'datafy_subscription_not_confirmed' using errcode='23514';
    end if;
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
revoke all on function public.request_whatsapp_channel_activation(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.request_whatsapp_channel_activation(uuid,uuid,uuid,text) to service_role;

-- Corpo de cutover preservado, com guarda Datafy sob o lock da unidade.
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

  -- Guarda Datafy antes de desativar o canal anterior, inclusive no eco.
  if v_target.provider='datafy' then
    perform public.assert_datafy_first_configuration(p_unit_id);
    if v_target.datafy_subscription_required and (v_target.provider_subscribed_at is null
      or v_target.provider_subscription_canceled_at is not null or v_target.provider_paused_at is not null) then
      raise exception 'datafy_subscription_not_confirmed' using errcode='23514';
    end if;
  end if;

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
revoke all on function public.activate_whatsapp_channel(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.activate_whatsapp_channel(uuid,uuid,uuid,text) to service_role;

commit;
