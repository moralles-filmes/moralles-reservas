-- Fence duravel entre os oito envios programados legados e o despacho gerenciado.
-- Nenhuma flag, cron, provider ou canal e ativado por esta migration.
begin;

create table if not exists app_private.whatsapp_cutover_intents (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references public.units(id) on delete cascade,
  kind text not null check (kind in ('confirmation','reminder_d1','survey_d1','waitlist_entered','waitlist_feedback','voucher_issued','cancellation','waitlist_table_ready')),
  resource_type text not null check (resource_type in ('reservation','waitlist','voucher')),
  resource_id uuid not null,
  owner text not null check (owner in ('legacy','managed','historical')),
  state text not null check (state in ('claimed','ready','posting','accepted','uncertain','preproxy_refused','released_prepost')),
  fence uuid,
  managed_job_id uuid,
  channel_id uuid,
  provider text,
  credential_revision bigint,
  provider_message_id text check (provider_message_id is null or (char_length(provider_message_id) between 1 and 512 and provider_message_id !~ '[[:cntrl:]]')),
  origin text,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  claimed_at timestamptz,
  posting_at timestamptz,
  settled_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (unit_id,kind,resource_type,resource_id),
  check ((kind in ('confirmation','reminder_d1','survey_d1','cancellation') and resource_type='reservation')
      or (kind in ('waitlist_entered','waitlist_feedback','waitlist_table_ready') and resource_type='waitlist')
      or (kind='voucher_issued' and resource_type='voucher')),
  check (owner <> 'managed' or managed_job_id is not null),
  check (owner <> 'legacy' or managed_job_id is null)
);
create index if not exists whatsapp_cutover_intents_active_unit_idx on app_private.whatsapp_cutover_intents(unit_id,state)
  where state in ('claimed','posting','uncertain');

create table if not exists app_private.whatsapp_cutover_intent_events (
  id bigint generated always as identity primary key,
  intent_id uuid not null references app_private.whatsapp_cutover_intents(id) on delete cascade,
  unit_id uuid not null,
  old_state text,
  new_state text not null,
  origin text not null,
  actor_id uuid,
  at timestamptz not null default clock_timestamp()
);

create table if not exists app_private.whatsapp_cutover_adoption_permits (
  tx_id bigint not null,
  operation text not null check (operation in ('binding_enable','adoption_insert')),
  unit_id uuid not null,
  binding_id uuid not null,
  actor_id uuid not null,
  old_generation bigint not null,
  old_credential_revision bigint not null,
  old_adopted_at timestamptz,
  new_adopted_at timestamptz,
  expected_adoption_at timestamptz,
  old_dispatch_enabled boolean,
  new_dispatch_enabled boolean,
  primary key (tx_id,operation,unit_id,binding_id)
);
alter table app_private.whatsapp_cutover_adoption_permits add column if not exists expected_adoption_at timestamptz;

alter table app_private.whatsapp_cutover_intents enable row level security;
alter table app_private.whatsapp_cutover_intents force row level security;
alter table app_private.whatsapp_cutover_intent_events enable row level security;
alter table app_private.whatsapp_cutover_intent_events force row level security;
alter table app_private.whatsapp_cutover_adoption_permits enable row level security;
alter table app_private.whatsapp_cutover_adoption_permits force row level security;
revoke all on table app_private.whatsapp_cutover_intents,app_private.whatsapp_cutover_intent_events,
  app_private.whatsapp_cutover_adoption_permits from public,anon,authenticated,service_role;
revoke all on sequence app_private.whatsapp_cutover_intent_events_id_seq from public,anon,authenticated,service_role;

-- A unidade e derivada novamente do proprio recurso depois de esperar o mutex.
create or replace function app_private.whatsapp_cutover_lock_fact(p_kind text,p_resource_id uuid)
returns table(unit_id uuid,organization_id uuid,resource_type text)
language plpgsql security definer set search_path='' as $$
declare v_unit uuid; v_org uuid; v_type text; v_check_unit uuid; v_check_org uuid;
begin
  if p_resource_id is null or p_kind not in ('confirmation','reminder_d1','survey_d1','waitlist_entered','waitlist_feedback','voucher_issued','cancellation','waitlist_table_ready') then
    raise exception 'cutover_resource_refused' using errcode='42501';
  end if;
  v_type:=case when p_kind in ('confirmation','reminder_d1','survey_d1','cancellation') then 'reservation'
    when p_kind='voucher_issued' then 'voucher' else 'waitlist' end;
  if v_type='reservation' then
    select r.unit_id,u.organization_id into v_unit,v_org from public.reservations r join public.units u on u.id=r.unit_id where r.id=p_resource_id;
  elsif v_type='waitlist' then
    select w.unit_id,u.organization_id into v_unit,v_org from public.waitlist w join public.units u on u.id=w.unit_id where w.id=p_resource_id;
  else
    select v.unit_id,u.organization_id into v_unit,v_org from public.vouchers v
      join public.voucher_rules vr on vr.id=v.rule_id and vr.unit_id=v.unit_id
      join public.units u on u.id=v.unit_id
      where v.id=p_resource_id and vr.trigger_type in ('birthday','frequency');
  end if;
  if v_unit is null or v_org is null then raise exception 'cutover_resource_refused' using errcode='42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('whatsapp-cutover-unit:'||v_unit::text,0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_unit::text||':'||p_kind||':'||p_resource_id::text,0));
  if v_type='reservation' then
    select r.unit_id,u.organization_id into v_check_unit,v_check_org from public.reservations r join public.units u on u.id=r.unit_id where r.id=p_resource_id;
  elsif v_type='waitlist' then
    select w.unit_id,u.organization_id into v_check_unit,v_check_org from public.waitlist w join public.units u on u.id=w.unit_id where w.id=p_resource_id;
  else
    select v.unit_id,u.organization_id into v_check_unit,v_check_org from public.vouchers v
      join public.voucher_rules vr on vr.id=v.rule_id and vr.unit_id=v.unit_id
      join public.units u on u.id=v.unit_id
      where v.id=p_resource_id and vr.trigger_type in ('birthday','frequency');
  end if;
  if (v_check_unit,v_check_org) is distinct from (v_unit,v_org) then raise exception 'cutover_resource_changed' using errcode='42501'; end if;
  unit_id:=v_unit; organization_id:=v_org; resource_type:=v_type; return next;
end $$;
revoke all on function app_private.whatsapp_cutover_lock_fact(text,uuid) from public,anon,authenticated,service_role;

-- Finalizacao de uma tentativa ja cercada usa a chave imutavel do marcador.
-- Exclusao do recurso depois do POST nao pode apagar o aceite nem liberar replay.
create or replace function app_private.whatsapp_cutover_lock_existing(p_unit_id uuid,p_kind text,p_resource_id uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  if p_unit_id is null or p_kind is null or p_resource_id is null then
    raise exception 'cutover_intent_invalid' using errcode='22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('whatsapp-cutover-unit:'||p_unit_id::text,0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_unit_id::text||':'||p_kind||':'||p_resource_id::text,0));
end $$;
revoke all on function app_private.whatsapp_cutover_lock_existing(uuid,text,uuid) from public,anon,authenticated,service_role;

-- Usado apenas pelos wrappers SQL; nenhuma leitura de gate falha aberta.
create or replace function app_private.whatsapp_cutover_historical_state(p_unit uuid,p_kind text,p_type text,p_resource uuid)
returns text language plpgsql security definer set search_path='' as $$
declare v_result text; v_row record;
begin
  if p_type='voucher' then return null; end if;
  for v_row in select n.status,n.provider_message_id,n.whatsapp_provider,n.whatsapp_channel_id,n.failed_at,
        n.sent_at,n.delivered_at,n.read_at
      from public.notifications_sent n
      where n.unit_id=p_unit and n.kind=p_kind
        and ((p_type='reservation' and n.reservation_id=p_resource) or (p_type='waitlist' and n.waitlist_id=p_resource))
  loop
    -- sent_at tem DEFAULT inclusive em linhas failed; nao e prova de aceite.
    if v_row.status in ('sent','delivered','read') then return 'accepted'; end if;
    if v_row.provider_message_id is not null then
      -- A linha failed_at sozinha nao comprova callback: exigir evento server-owned com a tupla completa.
      if v_row.failed_at is not null and v_row.whatsapp_provider is not null and v_row.whatsapp_channel_id is not null
        and exists(select 1 from public.whatsapp_automation_receipt_events e
          where e.unit_id=p_unit and e.provider=v_row.whatsapp_provider and e.channel_id=v_row.whatsapp_channel_id
            and e.provider_message_id=v_row.provider_message_id and e.status='failed') then return 'accepted'; end if;
      v_result:='uncertain';
    elsif v_row.status='failed' then v_result:='uncertain'; end if;
  end loop;
  return v_result;
end $$;
revoke all on function app_private.whatsapp_cutover_historical_state(uuid,text,text,uuid) from public,anon,authenticated,service_role;

create or replace function app_private.whatsapp_cutover_has_active_legacy_uncertainty(p_unit_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare n record; v_today date:=(clock_timestamp() at time zone 'America/Sao_Paulo')::date;
  v_now_time time:=(clock_timestamp() at time zone 'America/Sao_Paulo')::time;
  v_active boolean;
begin
  for n in select x.kind,x.reservation_id,x.waitlist_id from public.notifications_sent x
    where x.unit_id=p_unit_id and x.status='failed'
      and x.kind in ('confirmation','reminder_d1','survey_d1','cancellation',
        'waitlist_entered','waitlist_feedback','waitlist_table_ready')
  loop
    v_active:=false;
    if n.reservation_id is not null and n.kind in ('confirmation','reminder_d1','survey_d1','cancellation') then
      select case n.kind
        when 'confirmation' then r.status='confirmed' and r.date>=v_today
        when 'reminder_d1' then r.status='confirmed' and r.date=v_today and r.time>v_now_time
        when 'survey_d1' then r.status='confirmed' and r.date=v_today-1 and r.satisfaction_rating is null
        when 'cancellation' then r.status='cancelled' and r.cancelled_at is not null
          and r.cancelled_at<=clock_timestamp() and r.cancelled_at>clock_timestamp()-interval '24 hours'
          and ((r.date+r.time) at time zone 'America/Sao_Paulo')>clock_timestamp()
      end into v_active from public.reservations r where r.id=n.reservation_id and r.unit_id=p_unit_id;
    elsif n.waitlist_id is not null and n.kind in ('waitlist_entered','waitlist_feedback','waitlist_table_ready') then
      select case n.kind
        when 'waitlist_entered' then w.status='waiting'
        when 'waitlist_feedback' then w.status='seated' and (w.seated_at at time zone 'America/Sao_Paulo')::date=v_today-1
        when 'waitlist_table_ready' then w.status in ('waiting','notified') and w.seated_at is null
      end into v_active from public.waitlist w where w.id=n.waitlist_id and w.unit_id=p_unit_id;
    end if;
    if v_active and app_private.whatsapp_cutover_historical_state(p_unit_id,n.kind,
        case when n.reservation_id is not null then 'reservation' else 'waitlist' end,
        coalesce(n.reservation_id,n.waitlist_id))='uncertain' then return true; end if;
  end loop;
  return false;
end $$;
revoke all on function app_private.whatsapp_cutover_has_active_legacy_uncertainty(uuid) from public,anon,authenticated,service_role;

create or replace function app_private.whatsapp_cutover_audit_intent()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='INSERT' or new.state is distinct from old.state or new.fence is distinct from old.fence then
    insert into app_private.whatsapp_cutover_intent_events(intent_id,unit_id,old_state,new_state,origin,actor_id)
    values(new.id,new.unit_id,case when tg_op='INSERT' then null else old.state end,new.state,coalesce(new.origin,'server'),auth.uid());
  end if;
  return new;
end $$;
revoke all on function app_private.whatsapp_cutover_audit_intent() from public,anon,authenticated,service_role;
drop trigger if exists whatsapp_cutover_audit_intent on app_private.whatsapp_cutover_intents;
create trigger whatsapp_cutover_audit_intent after insert or update on app_private.whatsapp_cutover_intents
  for each row execute function app_private.whatsapp_cutover_audit_intent();

create or replace function public.claim_whatsapp_legacy_automation_post(
  p_kind text,p_resource_id uuid,p_channel_id uuid,p_expected_credential_revision bigint,p_origin text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare f record; c public.whatsapp_channels%rowtype; v_selected uuid; m app_private.whatsapp_cutover_intents%rowtype;
  v_history text; v_fence uuid:=gen_random_uuid();
begin
  if p_kind is null or p_resource_id is null or p_origin is null or p_channel_id is null
    or p_expected_credential_revision is null or p_expected_credential_revision<0
    or not ((p_origin='send-confirmation' and p_kind='confirmation')
      or (p_origin='send-cancellation' and p_kind='cancellation')
      or (p_origin='send-whatsapp' and p_kind in ('reminder_d1','survey_d1','waitlist_entered','waitlist_feedback','voucher_issued','waitlist_table_ready')))
  then return '{"allowed":false,"reason":"intent_invalid"}'::jsonb; end if;
  select * into f from app_private.whatsapp_cutover_lock_fact(p_kind,p_resource_id);
  if not found then return '{"allowed":false,"reason":"resource_refused"}'::jsonb; end if;
  if exists(select 1 from public.whatsapp_automation_adoptions a where a.unit_id=f.unit_id) then
    return '{"allowed":false,"reason":"adoption_active"}'::jsonb; end if;
  select * into c from public.whatsapp_channels where id=p_channel_id and unit_id=f.unit_id for share;
  if not found or c.status<>'connected' or c.template_credential_revision is distinct from p_expected_credential_revision then
    return '{"allowed":false,"reason":"channel_changed"}'::jsonb; end if;
  select ch.id into v_selected from public.whatsapp_channels ch where ch.unit_id=f.unit_id
    and (ch.is_active=true or (ch.is_active is null and ch.status='connected'
      and not exists(select 1 from public.whatsapp_channels x where x.unit_id=f.unit_id and x.is_active=true)))
    order by ch.is_active desc nulls last,ch.created_at,ch.id limit 1;
  if v_selected is distinct from c.id then return '{"allowed":false,"reason":"channel_changed"}'::jsonb; end if;
  select * into m from app_private.whatsapp_cutover_intents
    where unit_id=f.unit_id and kind=p_kind and resource_type=f.resource_type and resource_id=p_resource_id for update;
  if found and m.state<>'released_prepost' then return '{"allowed":false,"reason":"intent_owned"}'::jsonb; end if;
  v_history:=app_private.whatsapp_cutover_historical_state(f.unit_id,p_kind,f.resource_type,p_resource_id);
  if v_history='accepted' then return '{"allowed":false,"reason":"history_accepted"}'::jsonb; end if;
  if v_history='uncertain' then return '{"allowed":false,"reason":"history_uncertain"}'::jsonb; end if;
  if exists(select 1 from public.whatsapp_automation_jobs j where j.unit_id=f.unit_id and j.kind=p_kind
    and ((f.resource_type='reservation' and j.reservation_id=p_resource_id)
      or (f.resource_type='waitlist' and j.waitlist_id=p_resource_id)
      or (f.resource_type='voucher' and j.voucher_id=p_resource_id))) then
    return '{"allowed":false,"reason":"intent_owned"}'::jsonb; end if;
  if m.id is null then
    insert into app_private.whatsapp_cutover_intents(unit_id,kind,resource_type,resource_id,owner,state,fence,
      channel_id,provider,credential_revision,origin,attempt_count,claimed_at)
    values(f.unit_id,p_kind,f.resource_type,p_resource_id,'legacy','claimed',v_fence,
      c.id,c.provider,p_expected_credential_revision,p_origin,1,clock_timestamp()) returning * into m;
  else
    update app_private.whatsapp_cutover_intents set state='claimed',fence=v_fence,channel_id=c.id,
      provider=c.provider,credential_revision=p_expected_credential_revision,origin=p_origin,
      attempt_count=attempt_count+1,claimed_at=clock_timestamp(),posting_at=null,settled_at=null,updated_at=clock_timestamp()
      where id=m.id and state='released_prepost' returning * into m;
  end if;
  return jsonb_build_object('allowed',true,'intent_id',m.id,'fence',v_fence);
exception when insufficient_privilege then return '{"allowed":false,"reason":"resource_refused"}'::jsonb;
end $$;
revoke all on function public.claim_whatsapp_legacy_automation_post(text,uuid,uuid,bigint,text) from public,anon,authenticated,service_role;
grant execute on function public.claim_whatsapp_legacy_automation_post(text,uuid,uuid,bigint,text) to service_role;

create or replace function public.confirm_whatsapp_legacy_automation_post(
  p_intent_id uuid,p_fence uuid,p_channel_id uuid,p_expected_credential_revision bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare m app_private.whatsapp_cutover_intents%rowtype; f record; c public.whatsapp_channels%rowtype; v_selected uuid;
begin
  if p_intent_id is null or p_fence is null or p_channel_id is null or p_expected_credential_revision is null then
    return '{"allowed":false,"reason":"intent_invalid"}'::jsonb; end if;
  select * into m from app_private.whatsapp_cutover_intents where id=p_intent_id;
  if not found then return '{"allowed":false,"reason":"intent_owned"}'::jsonb; end if;
  select * into f from app_private.whatsapp_cutover_lock_fact(m.kind,m.resource_id);
  if not found or f.unit_id is distinct from m.unit_id or f.resource_type is distinct from m.resource_type then
    return '{"allowed":false,"reason":"resource_refused"}'::jsonb; end if;
  select * into m from app_private.whatsapp_cutover_intents where id=p_intent_id for update;
  if not found or m.owner<>'legacy' or m.state<>'claimed' or m.fence is distinct from p_fence
    or m.channel_id is distinct from p_channel_id or m.credential_revision is distinct from p_expected_credential_revision then
    return '{"allowed":false,"reason":"intent_owned"}'::jsonb; end if;
  if exists(select 1 from public.whatsapp_automation_adoptions a where a.unit_id=m.unit_id) then
    return '{"allowed":false,"reason":"adoption_active"}'::jsonb; end if;
  select * into c from public.whatsapp_channels where id=m.channel_id and unit_id=m.unit_id for share;
  if not found or c.status<>'connected' or (c.provider,c.template_credential_revision) is distinct from (m.provider,m.credential_revision) then
    return '{"allowed":false,"reason":"channel_changed"}'::jsonb; end if;
  select ch.id into v_selected from public.whatsapp_channels ch where ch.unit_id=m.unit_id
    and (ch.is_active=true or (ch.is_active is null and ch.status='connected'
      and not exists(select 1 from public.whatsapp_channels x where x.unit_id=m.unit_id and x.is_active=true)))
    order by ch.is_active desc nulls last,ch.created_at,ch.id limit 1;
  if v_selected is distinct from c.id then return '{"allowed":false,"reason":"channel_changed"}'::jsonb; end if;
  update app_private.whatsapp_cutover_intents set state='posting',posting_at=clock_timestamp(),updated_at=clock_timestamp()
    where id=m.id and state='claimed' and fence=p_fence;
  if not found then return '{"allowed":false,"reason":"intent_owned"}'::jsonb; end if;
  return '{"allowed":true}'::jsonb;
exception when insufficient_privilege then return '{"allowed":false,"reason":"resource_refused"}'::jsonb;
end $$;
revoke all on function public.confirm_whatsapp_legacy_automation_post(uuid,uuid,uuid,bigint) from public,anon,authenticated,service_role;
grant execute on function public.confirm_whatsapp_legacy_automation_post(uuid,uuid,uuid,bigint) to service_role;

create or replace function public.finish_whatsapp_legacy_automation_post(
  p_intent_id uuid,p_fence uuid,p_outcome text,p_provider_message_id text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare m app_private.whatsapp_cutover_intents%rowtype; f record; v_state text;
begin
  if p_intent_id is null or p_fence is null or p_outcome is null or p_outcome not in ('accepted','uncertain')
    or (p_provider_message_id is not null and (char_length(p_provider_message_id) not between 1 and 512 or p_provider_message_id ~ '[[:cntrl:]]')) then
    return '{"recorded":false,"state":"uncertain","reason":"dependency_unavailable"}'::jsonb; end if;
  select * into m from app_private.whatsapp_cutover_intents where id=p_intent_id;
  if not found then return '{"recorded":false,"state":"uncertain","reason":"fence_changed"}'::jsonb; end if;
  perform app_private.whatsapp_cutover_lock_existing(m.unit_id,m.kind,m.resource_id);
  select * into m from app_private.whatsapp_cutover_intents where id=p_intent_id for update;
  if not found or m.owner<>'legacy' or m.fence is distinct from p_fence then
    return '{"recorded":false,"state":"uncertain","reason":"fence_changed"}'::jsonb; end if;
  if m.state='accepted' then
    if p_outcome='accepted' and m.provider_message_id is not distinct from p_provider_message_id then
      return '{"recorded":true,"state":"accepted"}'::jsonb; end if;
    return '{"recorded":false,"state":"uncertain","reason":"fence_changed"}'::jsonb;
  end if;
  if m.state not in ('posting','uncertain') or (m.state='uncertain' and p_outcome<>'accepted') then
    return '{"recorded":false,"state":"uncertain","reason":"fence_changed"}'::jsonb; end if;
  v_state:=case when p_outcome='accepted' and p_provider_message_id is not null then 'accepted' else 'uncertain' end;
  if m.provider_message_id is not null and m.provider_message_id is distinct from p_provider_message_id then
    return '{"recorded":false,"state":"uncertain","reason":"fence_changed"}'::jsonb; end if;
  update app_private.whatsapp_cutover_intents set state=v_state,provider_message_id=coalesce(provider_message_id,p_provider_message_id),
    settled_at=clock_timestamp(),updated_at=clock_timestamp() where id=m.id;
  return jsonb_build_object('recorded',true,'state',v_state);
exception when insufficient_privilege then return '{"recorded":false,"state":"uncertain","reason":"dependency_unavailable"}'::jsonb;
end $$;
revoke all on function public.finish_whatsapp_legacy_automation_post(uuid,uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.finish_whatsapp_legacy_automation_post(uuid,uuid,text,text) to service_role;

create or replace function public.release_whatsapp_legacy_automation_claim(
  p_intent_id uuid,p_fence uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare m app_private.whatsapp_cutover_intents%rowtype; f record;
begin
  if p_intent_id is null or p_fence is null or p_reason is null or p_reason not in ('preflight_refused','resource_changed','channel_changed','dependency_unavailable','confirmation_refused') then
    return '{"released":false,"reason":"dependency_unavailable"}'::jsonb; end if;
  select * into m from app_private.whatsapp_cutover_intents where id=p_intent_id;
  if not found then return '{"released":false,"reason":"fence_changed"}'::jsonb; end if;
  perform app_private.whatsapp_cutover_lock_existing(m.unit_id,m.kind,m.resource_id);
  select * into m from app_private.whatsapp_cutover_intents where id=p_intent_id for update;
  if not found or m.owner<>'legacy' or m.fence is distinct from p_fence then
    return '{"released":false,"reason":"fence_changed"}'::jsonb; end if;
  if m.state<>'claimed' then return '{"released":false,"reason":"already_posting"}'::jsonb; end if;
  update app_private.whatsapp_cutover_intents set state='released_prepost',fence=null,settled_at=clock_timestamp(),updated_at=clock_timestamp()
    where id=m.id and state='claimed' and fence=p_fence;
  return '{"released":true}'::jsonb;
exception when insufficient_privilege then return '{"released":false,"reason":"dependency_unavailable"}'::jsonb;
end $$;
revoke all on function public.release_whatsapp_legacy_automation_claim(uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.release_whatsapp_legacy_automation_claim(uuid,uuid,text) to service_role;

-- Corpo congelado de 20261017120000_whatsapp_templates_table_ready_cancellation.sql, linhas 105-169; acesso somente pelo wrapper guardado.
create or replace function app_private.whatsapp_automation_enqueue_inner(p_intent jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare
  v_unit uuid; v_kind text; v_customer uuid; v_org uuid; v_resource_unit uuid;
  v_res uuid; v_wait uuid; v_voucher uuid; v_id uuid; v_logical text; v_fact timestamptz; v_expiry timestamptz;
  b public.whatsapp_template_bindings%rowtype; t public.whatsapp_remote_templates%rowtype;
  ch public.whatsapp_channels%rowtype; v_channel uuid; v_selected uuid; v_invalid boolean:=false; v_account uuid;
  v_flag jsonb; v_phase text:='bound'; v_state text:='queued'; v_error text; v_transport text;
begin
  if jsonb_typeof(p_intent) is distinct from 'object' or (p_intent-array['unit_id','kind','reservation_id','waitlist_id','voucher_id','source_event_key','fact_at','expires_at','due_at','logical_id'])<>'{}'::jsonb then raise exception 'automation_intent_invalid' using errcode='22023'; end if;
  v_unit:=(p_intent->>'unit_id')::uuid; v_kind:=p_intent->>'kind';
  v_res:=(p_intent->>'reservation_id')::uuid; v_wait:=(p_intent->>'waitlist_id')::uuid; v_voucher:=(p_intent->>'voucher_id')::uuid;
  if num_nonnulls(v_res,v_wait,v_voucher)<>1 or v_kind is null or not ((v_kind in('confirmation','reminder_d1','survey_d1','cancellation') and v_res is not null) or (v_kind in('waitlist_entered','waitlist_feedback','waitlist_table_ready') and v_wait is not null) or (v_kind='voucher_issued' and v_voucher is not null)) then raise exception 'automation_intent_invalid' using errcode='22023'; end if;
  select organization_id into v_org from public.units where id=v_unit;
  if v_res is not null then select unit_id,customer_id into v_resource_unit,v_customer from public.reservations where id=v_res;
  elsif v_voucher is not null then select unit_id,customer_id into v_resource_unit,v_customer from public.vouchers where id=v_voucher;
  else
    select w.unit_id,c.id,(w.customer_id is not null and c.id is null) into v_resource_unit,v_customer,v_invalid from public.waitlist w join public.units u on u.id=w.unit_id left join public.customers c on c.organization_id=u.organization_id and c.phone=public.normalize_br_phone(w.customer_phone) and (w.customer_id is null or c.id=w.customer_id) where w.id=v_wait;
  end if;
  if v_org is null or v_resource_unit is distinct from v_unit or coalesce(v_invalid,false) then raise exception 'automation_resource_refused' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_unit::text||':'||v_kind||':'||coalesce(v_res,v_wait,v_voucher)::text,0));
  select id into v_id from public.whatsapp_automation_jobs where unit_id=v_unit and kind=v_kind and (reservation_id=v_res or waitlist_id=v_wait or voucher_id=v_voucher);
  if found then return v_id; end if;
  if exists(select from public.notifications_sent where unit_id=v_unit and kind=v_kind and status in('sent','delivered','read') and ((v_res is not null and reservation_id=v_res) or (v_wait is not null and waitlist_id=v_wait))) then return null; end if;
  if v_customer is not null then
    perform 1 from public.customers where id=v_customer and organization_id=v_org and deleted_at is null for share;
    if not found then raise exception 'automation_resource_refused' using errcode='42501'; end if;
  end if;
  v_fact:=(p_intent->>'fact_at')::timestamptz; v_expiry:=(p_intent->>'expires_at')::timestamptz;
  if v_fact is null or v_expiry is null or not isfinite(v_fact) or not isfinite(v_expiry) or v_expiry<v_fact or coalesce(p_intent->>'source_event_key','')='' then raise exception 'automation_fact_invalid' using errcode='22023'; end if;
  if not exists(select from public.whatsapp_automation_adoptions where unit_id=v_unit) then raise exception 'automation_adoption_required' using errcode='P0A01'; end if;
  select value into v_flag from public.platform_flags where key='whatsapp_automation_dispatch';
  if found and jsonb_typeof(v_flag) is distinct from 'boolean' then raise exception 'automation_dependency_unavailable' using errcode='PT503'; end if;
  v_logical:=case v_kind when 'confirmation' then case when (select applied_discount_percent>0 from public.reservations where id=v_res) then 'res_confirmacao_desconto_v1' else 'res_confirmacao_v1' end when 'reminder_d1' then 'res_lembrete_dia_v1' when 'survey_d1' then 'res_pesquisa_reserva_v1' when 'waitlist_entered' then 'fila_entrada_v1' when 'waitlist_feedback' then 'fila_feedback_v1' when 'voucher_issued' then 'mkt_voucher_programado_v1' when 'cancellation' then 'res_cancelada_v1' when 'waitlist_table_ready' then 'fila_mesa_pronta_v1' end;
  if p_intent ? 'logical_id' and p_intent->>'logical_id' is distinct from v_logical then raise exception 'automation_intent_invalid' using errcode='22023'; end if;
  select id into v_channel from public.whatsapp_channels c where c.unit_id=v_unit and (c.is_active=true or (c.is_active is null and c.status='connected' and not exists(select from public.whatsapp_channels a where a.unit_id=v_unit and a.is_active=true))) order by c.is_active desc nulls last,c.created_at,c.id limit 1;
  select * into b from public.whatsapp_template_bindings where channel_id=v_channel;
  v_account:=b.account_id;
  if v_account is not null then perform 1 from public.whatsapp_template_accounts where id=v_account and organization_id=v_org for share; if not found then raise exception 'automation_configuration_changed' using errcode='PT503'; end if; end if;
  if b.id is not null then
    select * into b from public.whatsapp_template_bindings where id=b.id for share;
    if not found or b.account_id is distinct from v_account or b.channel_id is distinct from v_channel then raise exception 'automation_configuration_changed' using errcode='PT503'; end if;
  end if;
  if v_channel is not null then
    select * into ch from public.whatsapp_channels where id=v_channel for share;
    if not found or ch.unit_id is distinct from v_unit or (b.id is not null and (b.provider,b.unit_id) is distinct from (ch.provider,v_unit)) then raise exception 'automation_configuration_changed' using errcode='PT503'; end if;
    v_transport:=case when ch.provider in('official','datafy') then 'template' when ch.provider in('zapi','waha','uazapi') then 'text' end;
    if v_transport is null then raise exception 'automation_dependency_unavailable' using errcode='PT503'; end if;
  end if;
  select id into v_selected from public.whatsapp_channels c where c.unit_id=v_unit and (c.is_active=true or (c.is_active is null and c.status='connected' and not exists(select from public.whatsapp_channels a where a.unit_id=v_unit and a.is_active=true))) order by c.is_active desc nulls last,c.created_at,c.id limit 1;
  if v_selected is distinct from v_channel then raise exception 'automation_configuration_changed' using errcode='PT503'; end if;
  if v_account is not null then select * into t from public.whatsapp_remote_templates where account_id=v_account and logical_id=v_logical and version=1 and language='pt_BR' for share; end if;
  if v_channel is null then v_phase:='preconfiguration'; v_state:='blocked'; v_error:='channel_unconfigured';
  elsif b.id is null then v_phase:='preconfiguration'; v_state:='blocked'; v_error:='binding_unconfigured';
  elsif v_transport='template' and t.id is null then v_phase:='preconfiguration'; v_state:='blocked'; v_error:='template_unconfigured';
  end if;
  if b.id is not null and b.channel_credential_revision is distinct from ch.template_credential_revision then v_state:='needs_review'; v_error:='binding_changed';
  elsif v_phase='bound' and (v_flag is distinct from 'true'::jsonb or not b.dispatch_enabled or b.adopted_at is null) then v_state:='paused'; v_error:='dispatch_paused';
  elsif v_phase='bound' and (ch.status<>'connected' or ch.last_health_check_at is null or ch.last_health_check_at<clock_timestamp()-interval '5 minutes') then v_state:='blocked'; v_error:='channel_unavailable';
  elsif v_phase='bound' and v_transport='template' and (b.verified_at is null or t.sync_required or t.local_status<>'usable' or t.remote_status<>'APPROVED' or t.last_synced_at is null or t.last_synced_at<clock_timestamp()-interval '60 seconds') then v_state:='blocked'; v_error:='template_unavailable';
  end if;
  insert into public.whatsapp_automation_jobs(unit_id,organization_id,kind,reservation_id,waitlist_id,voucher_id,customer_id,source_event_key,fact_at,expires_at,due_at,channel_id,provider,binding_id,binding_generation,transport,account_id,remote_template_id,template_version,sync_epoch,pin_phase,initial_credential_revision,initial_catalog_key,state,error_code)
  values(v_unit,v_org,v_kind,v_res,v_wait,v_voucher,v_customer,p_intent->>'source_event_key',v_fact,v_expiry,coalesce((p_intent->>'due_at')::timestamptz,clock_timestamp()),v_channel,ch.provider,b.id,b.generation,v_transport,v_account,t.id,t.version,t.sync_epoch,v_phase,ch.template_credential_revision,v_logical,v_state,v_error) returning id into v_id;
  return v_id;
end $$;
revoke all on function app_private.whatsapp_automation_enqueue_inner(jsonb) from public,anon,authenticated,service_role;


-- Corpo congelado de 20261017140000_waitlist_table_ready_server_fact.sql, linhas 39-344; acesso somente pelo wrapper guardado.
create or replace function app_private.whatsapp_automation_post_inner(p_job_id uuid,p_fence uuid,p_generation bigint,p_consent_revision bigint,p_sync_epoch bigint,p_confirm_only boolean,p_expected jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare
  j public.whatsapp_automation_jobs%rowtype; b public.whatsapp_template_bindings%rowtype; gb public.whatsapp_template_bindings%rowtype;
  a public.whatsapp_template_accounts%rowtype; t public.whatsapp_remote_templates%rowtype;
  c public.customers%rowtype; ch public.whatsapp_channels%rowtype; gc public.whatsapp_channels%rowtype;
  ca public.whatsapp_template_cost_authorizations%rowtype; s public.whatsapp_promotion_slots%rowtype;
  v_now timestamptz; v_error text; v_current_customer uuid; v_resource_unit uuid; v_invalid boolean;
  v_job_found boolean; v_flag_invalid boolean; v_unit_matches boolean; v_adopted boolean; v_actor_valid boolean;
  v_old_job_exists boolean; v_old_job_posted boolean; v_resource_changed boolean:=false;
  v_current jsonb; v_normalized jsonb; v_schema jsonb; v_part jsonb; v_field record; v_section text;
  v_res public.reservations%rowtype; v_wait public.waitlist%rowtype; v_voucher public.vouchers%rowtype;
  v_unit public.units%rowtype; v_rule public.voucher_rules%rowtype;
  e_res public.reservations%rowtype; e_wait public.waitlist%rowtype; e_voucher public.vouchers%rowtype;
  e_unit public.units%rowtype; e_customer public.customers%rowtype; e_rule public.voucher_rules%rowtype;
  v_setting jsonb; v_setting_present boolean; v_key text; v_timezone text;
  v_revision bigint; v_decision text; v_selected uuid; v_days integer; v_flag jsonb; v_logical text;
begin
  select * into j from public.whatsapp_automation_jobs where id=p_job_id;
  if not found or j.pin_phase<>'bound' or p_fence is null or p_confirm_only is null then return '{"allowed":false,"reason":"authority_changed"}'::jsonb; end if;
  if j.customer_id is not null then select * into c from public.customers where id=j.customer_id for update; end if;
  if j.account_id is not null then select * into a from public.whatsapp_template_accounts where id=j.account_id for share; end if;
  perform 1 from public.whatsapp_template_bindings where id in(j.binding_id,a.sync_binding_id) order by id for share;
  select * into b from public.whatsapp_template_bindings where id=j.binding_id;
  select * into gb from public.whatsapp_template_bindings where id=a.sync_binding_id;
  perform 1 from public.whatsapp_channels where id in(j.channel_id,gb.channel_id) order by id for share;
  select * into ch from public.whatsapp_channels where id=j.channel_id;
  select * into gc from public.whatsapp_channels where id=gb.channel_id;
  if j.remote_template_id is not null then select * into t from public.whatsapp_remote_templates where id=j.remote_template_id for share; end if;
  select revision,decision into v_revision,v_decision from public.whatsapp_message_consent_events where unit_id=j.unit_id and customer_id=j.customer_id and purpose=case when j.kind in('waitlist_feedback','voucher_issued') then 'promotional' else 'operational' end order by revision desc limit 1 for share;
  if j.kind in('waitlist_feedback','voucher_issued') then
    select * into s from public.whatsapp_promotion_slots where unit_id=j.unit_id and customer_id=j.customer_id for update;
    if j.transport='template' then
      if p_confirm_only then
        select * into ca from public.whatsapp_template_cost_authorizations where id=j.cost_authorization_id for share;
      else
        select * into ca from public.whatsapp_template_cost_authorizations x where x.account_id=j.account_id and x.binding_id=j.binding_id and x.binding_generation=j.binding_generation and x.category='MARKETING' and x.valid_from<=clock_timestamp() and x.valid_until>clock_timestamp() and exists(select from public.platform_admins where user_id=x.actor_id) order by x.valid_until desc,x.id limit 1 for share;
      end if;
    end if;
  end if;
  select * into j from public.whatsapp_automation_jobs where id=p_job_id for update;
  v_job_found:=found;
  -- Timeless negative only; success and every temporal check use the FINAL clock.
  if not v_job_found or j.pin_phase<>'bound' or j.claim_token is distinct from p_fence
    or j.provider_message_id is not null or j.reconcile_required or j.customer_erased_at is not null then
    return '{"allowed":false,"reason":"authority_changed"}'::jsonb;
  end if;
  if p_confirm_only then
    if j.state<>'posting' or j.posting_started_at is null or j.attempts not between 1 and 5 then return '{"allowed":false,"reason":"authority_changed"}'::jsonb; end if;
  elsif j.state<>'claimed' or j.posting_started_at is not null or j.attempts>=5 then return '{"allowed":false,"reason":"authority_changed"}'::jsonb;
  end if;
  select value into v_flag from public.platform_flags where key='whatsapp_automation_dispatch';
  v_flag_invalid:=found and jsonb_typeof(v_flag) is distinct from 'boolean';
  if j.reservation_id is not null then select unit_id,customer_id into v_resource_unit,v_current_customer from public.reservations where id=j.reservation_id;
  elsif j.voucher_id is not null then select unit_id,customer_id into v_resource_unit,v_current_customer from public.vouchers where id=j.voucher_id;
  else
    select w.unit_id,cu.id,(w.customer_id is not null and cu.id is null) into v_resource_unit,v_current_customer,v_invalid from public.waitlist w join public.units u on u.id=w.unit_id left join public.customers cu on cu.organization_id=u.organization_id and cu.phone=public.normalize_br_phone(w.customer_phone) and (w.customer_id is null or cu.id=w.customer_id) where w.id=j.waitlist_id;
  end if;
  v_logical:=case j.kind when 'confirmation' then case when (select applied_discount_percent>0 from public.reservations where id=j.reservation_id) then 'res_confirmacao_desconto_v1' else 'res_confirmacao_v1' end when 'reminder_d1' then 'res_lembrete_dia_v1' when 'survey_d1' then 'res_pesquisa_reserva_v1' when 'waitlist_entered' then 'fila_entrada_v1' when 'waitlist_feedback' then 'fila_feedback_v1' when 'voucher_issued' then 'mkt_voucher_programado_v1' when 'cancellation' then 'res_cancelada_v1' when 'waitlist_table_ready' then 'fila_mesa_pronta_v1' end;
  select id into v_selected from public.whatsapp_channels x where x.unit_id=j.unit_id and (x.is_active=true or (x.is_active is null and x.status='connected' and not exists(select from public.whatsapp_channels active where active.unit_id=j.unit_id and active.is_active=true))) order by x.is_active desc nulls last,x.created_at,x.id limit 1;
  select exists(select from public.units where id=j.unit_id and organization_id=j.organization_id) into v_unit_matches;
  select exists(select from public.whatsapp_automation_adoptions where unit_id=j.unit_id) into v_adopted;
  select exists(select from public.platform_admins where user_id=ca.actor_id) into v_actor_valid;
  select exists(select from public.whatsapp_automation_jobs old_job where old_job.id=s.job_id),
    exists(select from public.whatsapp_automation_jobs old_job where old_job.id=s.job_id and (old_job.posting_started_at is not null or old_job.state='uncertain'))
    into v_old_job_exists,v_old_job_posted;
  if j.kind in('waitlist_feedback','voucher_issued') and not p_confirm_only then
    select window_days into v_days from app_private.whatsapp_promotion_policy where singleton;
  end if;
  -- Snapshot reads execute after all ordered parent/job locks; no new row locks.
    if p_expected is not null then
    if not p_confirm_only or jsonb_typeof(p_expected) is distinct from 'object'
      or (p_expected-array['version','kind','resource','customer','unit','rule','setting'])<>'{}'::jsonb
      or not p_expected ?& array['version','kind','resource','customer','unit','rule','setting']
      or p_expected->'version' is distinct from '1'::jsonb
      or p_expected->'kind' is distinct from to_jsonb(j.kind) then
      return '{"allowed":false,"reason":"snapshot_invalid"}'::jsonb;
    end if;
    v_schema:=jsonb_build_object(
      'unit','{"id":"string","organization_id":"string","name":"string","slug":"string?","timezone":"string?"}'::jsonb,
      'customer','{"id":"string","organization_id":"string","name":"string?","phone":"string","do_not_contact":"boolean","deleted_at":"null"}'::jsonb,
      'rule','{"id":"string","unit_id":"string","trigger_type":"string"}'::jsonb,
      'setting','{"key":"string?","present":"boolean","value":"json"}'::jsonb,
      'resource',case when j.reservation_id is not null then
        '{"id":"string","unit_id":"string","customer_id":"string","date":"string","time":"string","status":"string","payment_status":"string?","source":"string","party_size":"number","reservation_code":"string","applied_discount_percent":"number?","satisfaction_rating":"number?"}'::jsonb
      when j.waitlist_id is not null then
        '{"id":"string","unit_id":"string","customer_id":"string?","customer_name":"string?","customer_phone":"string","party_size":"number","code":"number","status":"string","created_at":"string","seated_at":"string?"}'::jsonb
      else '{"id":"string","unit_id":"string","customer_id":"string","rule_id":"string","code":"string","discount_percent":"number","status":"string","issued_at":"string","created_at":"string","expires_at":"string"}'::jsonb end);
    foreach v_section in array array['unit','customer','rule','setting','resource'] loop
      v_part:=p_expected->v_section;
      if v_section='customer' and j.customer_id is null then
        if v_part is distinct from 'null'::jsonb or j.kind not in('waitlist_entered','waitlist_table_ready') then
          return '{"allowed":false,"reason":"snapshot_invalid"}'::jsonb; end if;
        continue;
      elsif v_section='rule' and j.voucher_id is null then
        if v_part is distinct from 'null'::jsonb then return '{"allowed":false,"reason":"snapshot_invalid"}'::jsonb; end if;
        continue;
      end if;
      if jsonb_typeof(v_part) is distinct from 'object' then return '{"allowed":false,"reason":"snapshot_invalid"}'::jsonb; end if;
      for v_field in select key,value #>> '{}' as field_type from jsonb_each(v_schema->v_section) loop
        if not v_part ? v_field.key or
          (v_field.field_type<>'json' and jsonb_typeof(v_part->v_field.key) is distinct from replace(v_field.field_type,'?','')
            and not (right(v_field.field_type,1)='?' and v_part->v_field.key='null'::jsonb)) then
          return '{"allowed":false,"reason":"snapshot_invalid"}'::jsonb;
        end if;
      end loop;
      if (v_part-array(select jsonb_object_keys(v_schema->v_section)))<>'{}'::jsonb then
        return '{"allowed":false,"reason":"snapshot_invalid"}'::jsonb;
      end if;
    end loop;
    -- This exception block contains input conversion ONLY. Relation/dependency
    -- failures outside it stay SQL errors and never become a known-zero reset.
    begin
      e_unit:=jsonb_populate_record(null::public.units,p_expected->'unit');
      if j.customer_id is not null then e_customer:=jsonb_populate_record(null::public.customers,p_expected->'customer'); end if;
      if j.reservation_id is not null then
        if (p_expected#>>'{resource,date}') !~ '^\d{4}-\d{2}-\d{2}$'
          or (p_expected#>>'{resource,time}') !~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\.[0-9]+)?)?$' then
          return '{"allowed":false,"reason":"snapshot_invalid"}'::jsonb; end if;
        e_res:=jsonb_populate_record(null::public.reservations,p_expected->'resource');
      elsif j.waitlist_id is not null then
        if (p_expected#>>'{resource,created_at}') !~ '(Z|[+-][0-9]{2}:[0-9]{2})$'
          or ((p_expected#>>'{resource,seated_at}') is not null and (p_expected#>>'{resource,seated_at}') !~ '(Z|[+-][0-9]{2}:[0-9]{2})$') then
          return '{"allowed":false,"reason":"snapshot_invalid"}'::jsonb; end if;
        e_wait:=jsonb_populate_record(null::public.waitlist,p_expected->'resource');
      else
        if (p_expected#>>'{resource,issued_at}') !~ '(Z|[+-][0-9]{2}:[0-9]{2})$'
          or (p_expected#>>'{resource,created_at}') !~ '(Z|[+-][0-9]{2}:[0-9]{2})$'
          or (p_expected#>>'{resource,expires_at}') !~ '(Z|[+-][0-9]{2}:[0-9]{2})$' then
          return '{"allowed":false,"reason":"snapshot_invalid"}'::jsonb; end if;
        e_voucher:=jsonb_populate_record(null::public.vouchers,p_expected->'resource');
        e_rule:=jsonb_populate_record(null::public.voucher_rules,p_expected->'rule');
      end if;
    exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow or numeric_value_out_of_range then
      return '{"allowed":false,"reason":"snapshot_invalid"}'::jsonb;
    end;
    v_key:=case j.kind when 'confirmation' then null when 'cancellation' then null when 'waitlist_table_ready' then null when 'voucher_issued' then 'giftback_whatsapp_enabled' else j.kind||'_enabled' end;
    if (e_unit.id,e_unit.organization_id) is distinct from (j.unit_id,j.organization_id)
      or (j.customer_id is not null and ((e_customer.id,e_customer.organization_id,e_customer.deleted_at,e_customer.do_not_contact)
        is distinct from (j.customer_id,j.organization_id,null::timestamptz,false)
        or not coalesce(public.normalize_br_phone(e_customer.phone) ~ '^[1-9][0-9]{9,10}$',false)))
      or (p_expected#>>'{setting,key}') is distinct from v_key
      or (p_expected#>>'{setting,present}')='false' and p_expected#>'{setting,value}' is distinct from 'null'::jsonb
      or v_key is null and (p_expected#>>'{setting,present}')<>'false'
      or p_expected#>'{setting,value}' in ('false'::jsonb,'"false"'::jsonb) then
      return '{"allowed":false,"reason":"snapshot_invalid"}'::jsonb;
    end if;
    -- Capture validity is stricter than the nullable fixture bridge; missing
    -- production-required facts never become eligible through JSON NULL.
    if j.reservation_id is not null then
      if (e_res.id,e_res.unit_id,e_res.customer_id,e_res.status) is distinct from (j.reservation_id,j.unit_id,j.customer_id,case when j.kind='cancellation' then 'cancelled' else 'confirmed' end)
        or e_res.date is null or not isfinite(e_res.date) or e_res.time is null or e_res.time>='24:00'::time
        or e_res.party_size is null or e_res.party_size not between 1 and 999999 or nullif(btrim(e_res.reservation_code),'') is null
        or e_res.source is null or e_res.source not in('web','whatsapp')
        or e_res.payment_status is not null and e_res.payment_status not in('not_required','pending_payment','paid','failed','refunded','expired')
        or j.kind='confirmation' and e_res.payment_status is not null and e_res.payment_status not in('not_required','paid')
        or e_res.applied_discount_percent is not null and e_res.applied_discount_percent not between 0 and 100
        or e_res.satisfaction_rating is not null and e_res.satisfaction_rating not between 1 and 5
        or j.kind='survey_d1' and (e_res.satisfaction_rating is not null or e_res.date is distinct from (j.fact_at at time zone 'America/Sao_Paulo')::date) then
        return '{"allowed":false,"reason":"snapshot_invalid"}'::jsonb;
      end if;
      select * into v_res from public.reservations where id=j.reservation_id;
      v_normalized:=jsonb_build_object('id',e_res.id,'unit_id',e_res.unit_id,'customer_id',e_res.customer_id,'date',e_res.date,'time',e_res.time,
        'status',e_res.status,'payment_status',e_res.payment_status,'source',e_res.source,'party_size',e_res.party_size,
        'reservation_code',e_res.reservation_code,'applied_discount_percent',e_res.applied_discount_percent,'satisfaction_rating',e_res.satisfaction_rating);
      v_current:=jsonb_build_object('id',v_res.id,'unit_id',v_res.unit_id,'customer_id',v_res.customer_id,'date',v_res.date,'time',v_res.time,
        'status',v_res.status,'payment_status',v_res.payment_status,'source',v_res.source,'party_size',v_res.party_size,
        'reservation_code',v_res.reservation_code,'applied_discount_percent',v_res.applied_discount_percent,'satisfaction_rating',v_res.satisfaction_rating);
    elsif j.waitlist_id is not null then
      if (e_wait.id,e_wait.unit_id) is distinct from (j.waitlist_id,j.unit_id)
        or e_wait.customer_id is not null and e_wait.customer_id is distinct from j.customer_id
        or e_wait.created_at is null or not isfinite(e_wait.created_at)
        or not coalesce(public.normalize_br_phone(e_wait.customer_phone) ~ '^[1-9][0-9]{9,10}$',false)
        or e_wait.party_size is null or e_wait.party_size not between 1 and 999999 or e_wait.code is null or e_wait.code<1
        or j.kind='waitlist_entered' and e_wait.status is distinct from 'waiting'
        or j.kind='waitlist_table_ready' and (e_wait.status is distinct from 'notified' or e_wait.seated_at is not null)
        or j.kind='waitlist_feedback' and (e_wait.status is distinct from 'seated' or e_wait.seated_at is null or not isfinite(e_wait.seated_at)
          or (e_wait.seated_at at time zone 'America/Sao_Paulo')::date is distinct from (j.fact_at at time zone 'America/Sao_Paulo')::date)
        or j.customer_id is not null and public.normalize_br_phone(e_wait.customer_phone) is distinct from public.normalize_br_phone(e_customer.phone) then
        return '{"allowed":false,"reason":"snapshot_invalid"}'::jsonb;
      end if;
      select * into v_wait from public.waitlist where id=j.waitlist_id;
      v_normalized:=jsonb_build_object('id',e_wait.id,'unit_id',e_wait.unit_id,'customer_id',e_wait.customer_id,'customer_name',e_wait.customer_name,
        'customer_phone',public.normalize_br_phone(e_wait.customer_phone),'party_size',e_wait.party_size,'code',e_wait.code,'status',e_wait.status,'created_at',e_wait.created_at,'seated_at',e_wait.seated_at);
      v_current:=jsonb_build_object('id',v_wait.id,'unit_id',v_wait.unit_id,'customer_id',v_wait.customer_id,'customer_name',v_wait.customer_name,
        'customer_phone',public.normalize_br_phone(v_wait.customer_phone),'party_size',v_wait.party_size,'code',v_wait.code,'status',v_wait.status,'created_at',v_wait.created_at,'seated_at',v_wait.seated_at);
    else
      if (e_voucher.id,e_voucher.unit_id,e_voucher.customer_id,e_voucher.status) is distinct from (j.voucher_id,j.unit_id,j.customer_id,'active')
        or e_voucher.rule_id is null or nullif(btrim(e_voucher.code),'') is null or e_voucher.discount_percent is null or e_voucher.discount_percent not between 1 and 100
        or e_voucher.issued_at is null or not isfinite(e_voucher.issued_at) or e_voucher.created_at is null or not isfinite(e_voucher.created_at)
        or e_voucher.expires_at is null or not isfinite(e_voucher.expires_at)
        or (e_rule.id,e_rule.unit_id) is distinct from (e_voucher.rule_id,j.unit_id) or e_rule.trigger_type is null or e_rule.trigger_type not in('birthday','frequency') then
        return '{"allowed":false,"reason":"snapshot_invalid"}'::jsonb;
      end if;
      select * into v_voucher from public.vouchers where id=j.voucher_id;
      -- Parent comes from the ACTUAL resource, never e_rule.id.
      select * into v_rule from public.voucher_rules where id=v_voucher.rule_id and unit_id=j.unit_id;
      v_normalized:=jsonb_build_object('id',e_voucher.id,'unit_id',e_voucher.unit_id,'customer_id',e_voucher.customer_id,'rule_id',e_voucher.rule_id,'code',e_voucher.code,
        'discount_percent',e_voucher.discount_percent,'status',e_voucher.status,'issued_at',e_voucher.issued_at,'created_at',e_voucher.created_at,'expires_at',e_voucher.expires_at,
        'rule',jsonb_build_object('id',e_rule.id,'unit_id',e_rule.unit_id,'trigger_type',e_rule.trigger_type));
      v_current:=jsonb_build_object('id',v_voucher.id,'unit_id',v_voucher.unit_id,'customer_id',v_voucher.customer_id,'rule_id',v_voucher.rule_id,'code',v_voucher.code,
        'discount_percent',v_voucher.discount_percent,'status',v_voucher.status,'issued_at',v_voucher.issued_at,'created_at',v_voucher.created_at,'expires_at',v_voucher.expires_at,
        'rule',jsonb_build_object('id',v_rule.id,'unit_id',v_rule.unit_id,'trigger_type',v_rule.trigger_type));
    end if;
    v_resource_changed:=v_current is distinct from v_normalized;
    select * into v_unit from public.units where id=j.unit_id;
    if (v_unit.id,v_unit.organization_id,v_unit.name,v_unit.slug,v_unit.timezone) is distinct from
      (e_unit.id,e_unit.organization_id,e_unit.name,e_unit.slug,e_unit.timezone)
      or (j.customer_id is not null and (c.id,c.organization_id,c.name,public.normalize_br_phone(c.phone),c.do_not_contact,c.deleted_at)
        is distinct from (e_customer.id,e_customer.organization_id,e_customer.name,public.normalize_br_phone(e_customer.phone),e_customer.do_not_contact,e_customer.deleted_at)) then
      v_resource_changed:=true;
    end if;
    select value into v_setting from public.settings where unit_id=j.unit_id and key=v_key;
    v_setting_present:=found;
    if v_setting_present is distinct from (p_expected#>>'{setting,present}')::boolean
      or coalesce(v_setting,'null'::jsonb) is distinct from p_expected#>'{setting,value}' then v_resource_changed:=true; end if;
    v_timezone:=coalesce(v_unit.timezone,'America/Sao_Paulo');
    -- IANA/default contract; invalid zone is a refusal, not an exception/log of captured input.
    if not exists(select from pg_catalog.pg_timezone_names where lower(name)=lower(coalesce(e_unit.timezone,'America/Sao_Paulo'))) then
      return '{"allowed":false,"reason":"snapshot_invalid"}'::jsonb;
    end if;
    if not exists(select from pg_catalog.pg_timezone_names where lower(name)=lower(v_timezone)) then
      v_resource_changed:=true;
      v_timezone:='America/Sao_Paulo';
    end if;
  end if;

  -- Every relation read/wait above precedes this final authority clock. VOLATILE
  -- keeps READ COMMITTED snapshots fresh per statement. SQL commit -> POST is
  -- still an external concurrency window, not a provider atomicity guarantee.
  v_now:=clock_timestamp();
  if not v_job_found or j.pin_phase<>'bound' or j.claim_token is distinct from p_fence or j.claimed_until is null or j.claimed_until<=v_now
    or j.provider_message_id is not null or j.reconcile_required or j.customer_erased_at is not null then return '{"allowed":false,"reason":"authority_changed"}'::jsonb; end if;
  if p_confirm_only then
    if j.state<>'posting' or j.posting_started_at is null or j.attempts not between 1 and 5 then return '{"allowed":false,"reason":"authority_changed"}'::jsonb; end if;
  elsif j.state<>'claimed' or j.posting_started_at is not null or j.attempts>=5 then return '{"allowed":false,"reason":"authority_changed"}'::jsonb;
  end if;

  if v_flag_invalid then raise exception 'automation_dependency_unavailable' using errcode='PT503'; end if;
  if v_resource_unit is distinct from j.unit_id or v_current_customer is distinct from j.customer_id or coalesce(v_invalid,false) or not v_unit_matches then v_error:='recipient_changed';
  elsif j.customer_id is not null and (c.id is null or c.deleted_at is not null or c.organization_id is distinct from j.organization_id) then v_error:='customer_not_alive';
  elsif c.do_not_contact then v_error:='do_not_contact';
  elsif j.kind='cancellation' and not exists(select 1 from public.reservations r where r.id=j.reservation_id and r.unit_id=j.unit_id and r.status='cancelled' and r.cancelled_at=j.fact_at) then v_error:='recipient_changed';
  elsif j.kind='waitlist_table_ready' and not exists(select 1 from public.waitlist w where w.id=j.waitlist_id and w.unit_id=j.unit_id and w.status='notified' and w.seated_at is null and w.notified_at=j.fact_at and w.notified_server_at=j.fact_at) then v_error:='recipient_changed';
  elsif b.id is null or (b.unit_id,b.channel_id,b.provider,b.account_id,b.generation) is distinct from (j.unit_id,j.channel_id,j.provider,j.account_id,j.binding_generation) or b.channel_credential_revision is distinct from ch.template_credential_revision or p_generation is distinct from j.binding_generation or v_selected is distinct from j.channel_id then v_error:='binding_changed';
  elsif not b.dispatch_enabled or b.adopted_at is null or not v_adopted or v_flag is distinct from 'true'::jsonb then v_error:='dispatch_paused';
  elsif ch.id is null or ch.unit_id<>j.unit_id or ch.provider<>j.provider or ch.is_active=false or ch.status<>'connected' or ch.last_health_check_at is null or ch.last_health_check_at<v_now-interval '5 minutes' then v_error:='channel_unavailable';
  elsif v_now>j.expires_at then v_error:='expired';
  elsif j.kind in('waitlist_feedback','voucher_issued') and (j.customer_id is null or v_decision is distinct from 'opt_in' or v_revision is null or p_consent_revision is distinct from v_revision) then v_error:='consent_changed';
  elsif v_decision='opt_out' or p_consent_revision is distinct from v_revision or (p_confirm_only and j.consent_revision is distinct from v_revision) then v_error:='consent_changed';
  elsif j.kind in('waitlist_feedback','voucher_issued') and j.transport='template' and
    (ca.id is null or (ca.account_id,ca.binding_id,ca.binding_generation,ca.category) is distinct from (j.account_id,j.binding_id,j.binding_generation,'MARKETING') or ca.valid_from>v_now or ca.valid_until<=v_now or not v_actor_valid or t.requested_category is distinct from 'MARKETING' or (p_confirm_only and ca.id is distinct from j.cost_authorization_id)) then v_error:='cost_not_authorized';
  elsif j.kind in('waitlist_feedback','voucher_issued') and p_confirm_only and
    (s.id is null or (s.unit_id,s.customer_id,s.job_id,s.claim_token,s.state) is distinct from (j.unit_id,j.customer_id,j.id,p_fence,'reserved') or s.claimed_until<=v_now or s.claimed_until is distinct from j.claimed_until or s.window_until<=v_now or s.window_until is distinct from j.posting_started_at+make_interval(days=>s.window_days)) then v_error:='promotion_frequency';
  elsif j.kind in('waitlist_feedback','voucher_issued') and not p_confirm_only and s.id is not null and
    ((s.state in('accepted','uncertain') and s.window_until>v_now) or
     (s.state='reserved' and v_old_job_posted) or
     (s.state='reserved' and s.window_until>v_now and not v_old_job_exists) or
     (s.state='reserved' and s.job_id<>j.id and s.claimed_until>v_now and v_old_job_exists)) then v_error:='promotion_frequency';
  elsif j.safe_log_body is null then v_error:='render_missing';
  elsif j.transport='template' and (a.id is null or a.organization_id<>j.organization_id or a.verified_at is null or b.verified_at is null or t.id is null
    or t.account_id<>j.account_id or t.version<>1 or j.template_version<>1 or t.logical_id<>v_logical or t.name<>v_logical or (j.initial_catalog_key is not null and j.initial_catalog_key<>v_logical)
    or t.binding_generation<>a.binding_generation or t.sync_required or t.local_status<>'usable' or t.remote_status<>'APPROVED' or t.language<>'pt_BR' or t.remote_id is null or t.observed_hash is distinct from t.desired_hash
    or t.requested_category is distinct from case when j.kind in('waitlist_feedback','voucher_issued') then 'MARKETING' else 'UTILITY' end
    or t.effective_category is distinct from t.requested_category or (t.requested_category='MARKETING' and t.quality='RED') or t.last_synced_at is null or t.last_synced_at<v_now-interval '60 seconds' or p_sync_epoch is distinct from t.sync_epoch or (p_confirm_only and j.sync_epoch is distinct from t.sync_epoch)
    or a.sync_capture_id is null or a.last_sync_published_at is null or a.last_sync_published_at<v_now-interval '60 seconds'
    or gb.id is null or gc.id is null or gb.account_id is distinct from a.id or gb.verified_at is null or gb.generation is distinct from a.sync_binding_generation
    or gb.channel_credential_revision is distinct from a.sync_credential_revision or gc.template_credential_revision is distinct from a.sync_credential_revision
    or (gb.unit_id,gb.provider) is distinct from (gc.unit_id,gc.provider) or gc.status<>'connected') then v_error:='template_unavailable';
  elsif j.transport='text' and (p_sync_epoch is not null or j.sync_epoch is not null) then v_error:='template_unavailable';
  end if;
  if p_confirm_only then
    if v_error is not null then return '{"allowed":false,"reason":"authority_changed"}'::jsonb; end if;
        if p_expected is not null then
      if j.reservation_id is not null and j.kind in('confirmation','reminder_d1','cancellation') then
        -- Match the renderer/loader's HH:MM start, not a seconds-rounded start.
        if v_res.date is null or v_res.time is null
          or v_now>((v_res.date+make_time(extract(hour from v_res.time)::integer,extract(minute from v_res.time)::integer,0)) at time zone 'America/Sao_Paulo')
          or (v_now at time zone v_timezone)>(v_res.date+make_time(extract(hour from v_res.time)::integer,extract(minute from v_res.time)::integer,0))
          or (j.kind='reminder_d1' and v_res.date is distinct from (v_now at time zone v_timezone)::date) then
          v_resource_changed:=true;
        end if;
      elsif j.voucher_id is not null and (v_voucher.expires_at is null or v_now>=v_voucher.expires_at) then
        v_resource_changed:=true;
      end if;
      if v_resource_changed then return '{"allowed":false,"reason":"resource_changed"}'::jsonb; end if;
    end if;

    return '{"allowed":true}'::jsonb;
  end if;
  if v_error is not null then
    update public.whatsapp_automation_jobs set state=case when v_error in('binding_changed','recipient_changed') then 'needs_review' when v_error='dispatch_paused' then 'paused' when v_error='expired' then 'expired' else 'blocked' end,error_code=v_error,finished_at=case when v_error='expired' then coalesce(finished_at,v_now) else finished_at end where id=j.id and claim_token=p_fence;
    return '{"allowed":false,"reason":"authority_changed"}'::jsonb;
  end if;
  if j.kind in('waitlist_feedback','voucher_issued') then
    if s.id is not null then
      insert into app_private.whatsapp_promotion_slot_release_permits values(txid_current(),s.id);
      delete from public.whatsapp_promotion_slots where id=s.id;
    end if;
    if v_days is null then raise exception 'promotion_policy_unavailable' using errcode='P0A16'; end if;
    insert into public.whatsapp_promotion_slots(unit_id,customer_id,job_id,claim_token,claimed_until,window_until,window_days)
      values(j.unit_id,j.customer_id,j.id,p_fence,v_now+interval '90 seconds',v_now+make_interval(days=>v_days),v_days);
  end if;
  update public.whatsapp_automation_jobs set state='posting',posting_started_at=v_now,claimed_until=v_now+interval '90 seconds',attempts=attempts+1,sync_epoch=case when transport='template' then t.sync_epoch else null end,consent_revision=v_revision,cost_authorization_id=ca.id,error_code=null where id=j.id and claim_token=p_fence and state='claimed';
  return jsonb_build_object('allowed',found);
end $$;
revoke all on function app_private.whatsapp_automation_post_inner(uuid,uuid,bigint,bigint,bigint,boolean,jsonb) from public,anon,authenticated,service_role;


-- Corpo congelado de 20261004014032_whatsapp_message_preferences.sql, linhas 222-271; acesso somente pelo wrapper guardado.
create or replace function app_private.finish_whatsapp_automation_inner(p_job_id uuid,p_fence uuid,p_result jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare j public.whatsapp_automation_jobs%rowtype; v_outcome text:=p_result->>'outcome'; v_reason text:=p_result->>'reason'; v_id text:=p_result->>'provider_message_id'; v_now timestamptz; v_wait integer; s public.whatsapp_promotion_slots%rowtype;
begin
  if jsonb_typeof(p_result) is distinct from 'object' or (p_result-array['outcome','reason','provider_message_id','retry_after_seconds'])<>'{}'::jsonb or v_outcome is null or v_reason is null or not ((v_outcome='accepted' and v_reason='provider_accepted') or (v_outcome='uncertain' and v_reason in('response_invalid','post_ambiguous','post_lease_expired')) or (v_outcome='rejected' and v_reason in('documented_preproxy_429','provider_rejected','auth_rejected','template_rejected')) or (v_outcome='local_preflight_refused' and v_reason in('final_service_suspended','final_channel_changed','final_consent_changed','final_resource_changed','final_gate_paused'))) then raise exception 'automation_result_invalid' using errcode='22023'; end if;
  if v_outcome='accepted' and (jsonb_typeof(p_result->'provider_message_id') is distinct from 'string' or v_id is null or char_length(v_id) not between 1 and 512 or v_id ~ '[[:cntrl:]]') then raise exception 'automation_result_invalid' using errcode='22023'; end if;
  if v_outcome<>'accepted' and v_id is not null then raise exception 'automation_result_invalid' using errcode='22023'; end if;
  if v_outcome='local_preflight_refused' and (p_result-array['outcome','reason'])<>'{}'::jsonb then raise exception 'automation_result_invalid' using errcode='22023'; end if;
  select * into j from public.whatsapp_automation_jobs where id=p_job_id;
  if not found then return false; end if;
  -- Historical evidence settles without live binding/account/template locks.
  if j.kind in('waitlist_feedback','voucher_issued') and j.customer_id is not null then
    perform 1 from public.customers where id=j.customer_id for update;
    select * into s from public.whatsapp_promotion_slots where unit_id=j.unit_id and customer_id=j.customer_id and job_id=j.id and claim_token=p_fence for update;
  end if;
  select * into j from public.whatsapp_automation_jobs where id=p_job_id for update;
  if not found or j.claim_token is distinct from p_fence or j.posting_started_at is null then return false; end if;
  v_now:=clock_timestamp();
  if j.state in('accepted','reconciled') then return v_outcome='accepted' and j.provider_message_id=v_id; end if;
  if j.state not in('posting','uncertain') then return false; end if;
  if v_outcome='local_preflight_refused' then
    if j.state<>'posting' or j.claimed_until<=v_now or j.provider_message_id is not null or j.attempts<1 then return false; end if;
    insert into app_private.whatsapp_post_reset_permits values(txid_current(),'whatsapp_automation_jobs',j.id,p_fence,j.attempts,j.posting_started_at);
    update public.whatsapp_automation_jobs set state=case when j.customer_erased_at is not null then 'blocked' when v_reason='final_gate_paused' then 'paused' when v_reason in('final_channel_changed','final_resource_changed') then 'needs_review' else 'blocked' end,
      posting_started_at=null,safe_log_body=null,claim_token=null,claimed_until=null,attempts=attempts-1,reconcile_required=false,error_code=case when j.customer_erased_at is not null then 'customer_not_alive' else v_reason end where id=j.id and claim_token=p_fence;
  elsif v_outcome='accepted' then
    update public.whatsapp_automation_jobs set state='accepted',provider_message_id=v_id,reconcile_required=true,error_code=null,finished_at=v_now where id=j.id and claim_token=p_fence;
  elsif v_outcome='uncertain' then
    update public.whatsapp_automation_jobs set state='uncertain',reconcile_required=true,error_code=v_reason where id=j.id and claim_token=p_fence;
  elsif j.state='uncertain' then return false;
  elsif v_reason='documented_preproxy_429' and j.provider='datafy' and j.provider_message_id is null and j.attempts<5 and v_now<=j.expires_at then
    v_wait:=coalesce((p_result->>'retry_after_seconds')::integer,0);
    if v_wait<0 or v_wait>86400 then raise exception 'automation_result_invalid' using errcode='22023'; end if;
    insert into app_private.whatsapp_post_reset_permits values(txid_current(),'whatsapp_automation_jobs',j.id,p_fence,j.attempts,j.posting_started_at);
    update public.whatsapp_automation_jobs set state='retry_wait',posting_started_at=null,safe_log_body=null,due_at=v_now+make_interval(secs=>greatest(60*power(4,j.attempts-1)::integer,v_wait)),error_code=v_reason where id=j.id and claim_token=p_fence;
  else
    update public.whatsapp_automation_jobs set state='rejected',error_code=v_reason,finished_at=v_now where id=j.id and claim_token=p_fence;
  end if;
  if s.id is not null then
    if v_outcome in('accepted','uncertain') then
      update public.whatsapp_promotion_slots set state=case when v_outcome='accepted' then 'accepted' else 'uncertain' end,
        accepted_at=case when v_outcome='accepted' then coalesce(accepted_at,v_now) else accepted_at end,
        window_until=greatest(window_until,v_now+make_interval(days=>s.window_days)) where id=s.id and claim_token=p_fence;
    else
      insert into app_private.whatsapp_promotion_slot_release_permits values(txid_current(),s.id);
      delete from public.whatsapp_promotion_slots where id=s.id;
    end if;
  end if;
  return true;
end $$;
revoke all on function app_private.finish_whatsapp_automation_inner(uuid,uuid,jsonb) from public,anon,authenticated,service_role;


-- Corpo congelado de 20261017150000_whatsapp_automation_failed_notification_adoption.sql, linhas 5-148; acesso somente pelo wrapper guardado.
create or replace function app_private.reconcile_whatsapp_automation_acceptance_inner(p_job_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  j public.whatsapp_automation_jobs%rowtype;
  c public.customers%rowtype;
  v_customer uuid;
  v_unit uuid;
  v_fence uuid;
  v_conversation uuid;
  v_notification uuid;
  v_legacy_notification uuid;
  v_count integer;
  v_history text;
begin
  -- Discovery is not authority: reread the job after every parent wait.
  select * into j from public.whatsapp_automation_jobs where id=p_job_id;
  if not found then
    return jsonb_build_object('state','not_accepted','reason','job_not_found');
  end if;
  v_customer:=j.customer_id; v_unit:=j.unit_id; v_fence:=j.claim_token;
  if v_customer is not null then
    select * into c from public.customers where id=v_customer for update;
    if j.kind in('waitlist_feedback','voucher_issued') then
      perform 1 from public.whatsapp_promotion_slots
        where unit_id=v_unit and customer_id=v_customer and job_id=p_job_id
          and claim_token=v_fence for update;
    end if;
  end if;
  select * into j from public.whatsapp_automation_jobs where id=p_job_id for update;
  if not found then
    return jsonb_build_object('state','not_accepted','reason','job_not_found');
  end if;
  if j.pin_phase is distinct from 'bound' or j.state not in('accepted','reconciled') then
    return jsonb_build_object('state','not_accepted','reason','acceptance_not_recorded');
  end if;
  -- A formerly complete projection can lose its channel FK later. Any new
  -- deferral must remain visible even when the job was locally reconciled.
  update public.whatsapp_automation_jobs set state='accepted',reconcile_required=true where id=j.id;
  if j.posting_started_at is null or j.claim_token is null or j.finished_at is null
    or j.provider_message_id is null or char_length(j.provider_message_id) not between 1 and 512
    or j.provider_message_id ~ '[[:cntrl:]]' then
    return jsonb_build_object('state','deferred','reason','acceptance_evidence_missing');
  end if;
  -- Do not acquire a different earlier parent after the job lock.
  if j.unit_id is distinct from v_unit or j.claim_token is distinct from v_fence
    or (j.customer_id is distinct from v_customer and j.customer_erased_at is null) then
    return jsonb_build_object('state','deferred','reason','acceptance_identity_changed');
  end if;
  if not exists(select from public.units where id=j.unit_id and organization_id=j.organization_id) then
    return jsonb_build_object('state','deferred','reason','customer_scope_invalid');
  end if;
  if j.customer_erased_at is not null then
    if j.customer_id is not null or j.safe_log_body is not null then
      return jsonb_build_object('state','deferred','reason','customer_scope_invalid');
    end if;
    v_history:='skipped_erased';
  elsif j.customer_id is null then
    -- Only an operational entry may never have had a known customer.
    if j.kind not in('waitlist_entered','waitlist_table_ready') then
      return jsonb_build_object('state','deferred','reason','customer_scope_invalid');
    end if;
    v_history:='skipped_no_customer';
  elsif c.id is distinct from j.customer_id or c.deleted_at is not null
    or c.organization_id is distinct from j.organization_id then
    return jsonb_build_object('state','deferred','reason','customer_scope_invalid');
  elsif j.safe_log_body is null or char_length(j.safe_log_body) not between 1 and 4096 then
    return jsonb_build_object('state','deferred','reason','acceptance_evidence_missing');
  else
    v_history:='recorded';
  end if;

  -- Historical channel identity is retained. Never substitute the active channel.
  if not exists(select from public.whatsapp_channels where id=j.channel_id and unit_id=j.unit_id) then
    return jsonb_build_object('state','deferred','reason','notification_channel_missing');
  end if;
  -- The pre-ledger sender may have left one failed row under the natural key.
  -- Adopt only that unaccepted projection; never erase delivered/read evidence.
  -- The job lock is already held, and the row lock serializes concurrent repairs.
  select n.id into v_legacy_notification from public.notifications_sent n
    where n.unit_id=j.unit_id and n.kind=j.kind
      and (j.reservation_id is not null or j.waitlist_id is not null)
      and n.reservation_id is not distinct from j.reservation_id
      and n.waitlist_id is not distinct from j.waitlist_id
    for update;
  if v_legacy_notification is not null and v_legacy_notification<>j.notification_id then
    update public.notifications_sent n set
      id=j.notification_id,status='sent',sent_at=j.finished_at,error=null,failed_at=null,
      whatsapp_provider=j.provider,whatsapp_channel_id=j.channel_id,
      provider_message_id=j.provider_message_id
      where n.id=v_legacy_notification and n.unit_id=j.unit_id and n.kind=j.kind
        and n.reservation_id is not distinct from j.reservation_id
        and n.waitlist_id is not distinct from j.waitlist_id
        and n.status='failed' and n.provider_message_id is null
        and n.delivered_at is null and n.read_at is null
        and not exists (select from public.notifications_sent other where other.id=j.notification_id)
      returning n.id into v_notification;
    if v_notification is distinct from j.notification_id then
      return jsonb_build_object('state','deferred','reason','notification_conflict');
    end if;
  else
    insert into public.notifications_sent(id,unit_id,reservation_id,waitlist_id,kind,status,sent_at,
      whatsapp_provider,whatsapp_channel_id,provider_message_id)
      values(j.notification_id,j.unit_id,j.reservation_id,j.waitlist_id,j.kind,'sent',j.finished_at,
        j.provider,j.channel_id,j.provider_message_id)
      on conflict do nothing;
  end if;
  -- Exact frozen UUID plus resource and all four correlation fields. A legacy
  -- row with prior acceptance evidence remains a visible conflict.
  update public.notifications_sent n set sent_at=n.sent_at
    where n.id=j.notification_id and n.unit_id=j.unit_id and n.kind=j.kind
      and n.reservation_id is not distinct from j.reservation_id
      and n.waitlist_id is not distinct from j.waitlist_id
      and n.whatsapp_provider=j.provider and n.whatsapp_channel_id=j.channel_id
      and n.provider_message_id=j.provider_message_id
    returning n.id into v_notification;
  get diagnostics v_count=row_count;
  if v_count<>1 or v_notification is distinct from j.notification_id then
    return jsonb_build_object('state','deferred','reason','notification_conflict');
  end if;

  if v_history='recorded' then
    -- Same unit/customer key as the historical get-or-create helper. Its latest
    -- conversation may change; append's own event dedupe is only per row.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(j.unit_id::text||':'||j.customer_id::text,0));
    if not exists(
      select from public.conversations conversation
        cross join lateral jsonb_array_elements(coalesce(conversation.messages,'[]'::jsonb)) item
      where conversation.unit_id=j.unit_id and conversation.customer_id=j.customer_id
        and item->>'event_id'='automation:'||j.id::text||':accepted'
    ) then
      v_conversation:=public.get_or_create_whatsapp_conversation(j.customer_id,j.unit_id,null,null);
      perform public.append_conversation_message(v_conversation,jsonb_build_object(
        'event_id','automation:'||j.id::text||':accepted','role','assistant','author','automation',
        'content',j.safe_log_body,'timestamp',j.finished_at,'kind',j.kind));
    end if;
  end if;
  -- An exception above rolls back notification/history together, while the
  -- acceptance committed by finish in its earlier transaction remains intact.
  update public.whatsapp_automation_jobs set state='reconciled',reconcile_required=false,error_code=null
    where id=j.id and state in('accepted','reconciled') and provider_message_id=j.provider_message_id;
  get diagnostics v_count=row_count;
  if v_count<>1 then raise exception 'acceptance_projection_changed' using errcode='P0A17'; end if;
  return jsonb_build_object('state','reconciled','history',v_history);
end $$;
revoke all on function app_private.reconcile_whatsapp_automation_acceptance_inner(uuid) from public,anon,authenticated,service_role;


-- Corpo congelado de 20261017203000_whatsapp_template_auto_provision_policy.sql, linhas 716-808; acesso somente pelo wrapper guardado.
create or replace function app_private.release_whatsapp_template_channel_inner(p_channel_id uuid,p_scope text,p_enabled boolean,p_expected_credential_revision bigint,p_expected_binding_generation bigint)
returns boolean language plpgsql security definer set search_path='' as $$
declare b public.whatsapp_template_bindings%rowtype; c public.whatsapp_channels%rowtype;
  v_binding uuid; v_account uuid; v_unit uuid; v_org uuid; v_selected uuid; v_now timestamptz;
  v_enrollment_id uuid;
begin
  perform app_private.require_whatsapp_template_manager(null,true);
  if p_scope is null or p_scope not in('catalog','dispatch') or p_enabled is null or p_expected_credential_revision is null or p_expected_credential_revision<0 then raise exception 'template_management_invalid' using errcode='22023'; end if;
  select ch.unit_id,u.organization_id into v_unit,v_org from public.whatsapp_channels ch join public.units u on u.id=ch.unit_id where ch.id=p_channel_id;
  if not found then raise exception 'template_management_forbidden' using errcode='42501'; end if;
  -- Match the auto-grant lock order (enrollment, then binding). A stop that wins
  -- this lock excludes the channel before WABA discovery can authorize it.
  if p_scope='catalog' and not p_enabled then
    select e.onboarding_id into v_enrollment_id
      from app_private.whatsapp_template_auto_enrollments e
      where e.channel_id=p_channel_id and e.unit_id=v_unit for update;
  end if;
  select id,account_id into v_binding,v_account from public.whatsapp_template_bindings where channel_id=p_channel_id;
  if v_account is not null then
    perform 1 from public.whatsapp_template_accounts where id=v_account and organization_id=v_org for share;
    if not found then raise exception 'template_management_forbidden' using errcode='42501'; end if;
  end if;
  if v_binding is not null then
    select * into b from public.whatsapp_template_bindings where id=v_binding for update;
    if not found or (b.account_id,b.channel_id,b.unit_id) is distinct from (v_account,p_channel_id,v_unit) then raise exception 'template_configuration_changed' using errcode='PT409'; end if;
  end if;
  select * into c from public.whatsapp_channels where id=p_channel_id for share;
  if not found or c.unit_id is distinct from v_unit or not exists(select from public.units where id=v_unit and organization_id=v_org) then raise exception 'template_management_forbidden' using errcode='42501'; end if;
  if c.template_credential_revision is distinct from p_expected_credential_revision then raise exception 'template_configuration_changed' using errcode='PT409'; end if;
  if v_binding is null then
    if exists(select from public.whatsapp_template_bindings where channel_id=p_channel_id) then raise exception 'template_configuration_changed' using errcode='PT409'; end if;
    if not p_enabled then
      if p_scope='catalog' and v_enrollment_id is not null then
        if p_expected_binding_generation is not null then raise exception 'template_configuration_changed' using errcode='PT409'; end if;
        update app_private.whatsapp_template_auto_enrollments
          set excluded_at=clock_timestamp(),excluded_by=auth.uid(),state='needs_review',
            reason_code='manual_review',next_attempt_at='infinity'::timestamptz,updated_at=clock_timestamp()
          where onboarding_id=v_enrollment_id and excluded_at is null;
        if found then
          insert into public.audit_log(table_name,record_id,action,new_values,actor_id,unit_id,organization_id)
          values('whatsapp_template_auto_enrollments',v_enrollment_id::text,'UPDATE',
            jsonb_build_object('scope','catalog','enabled',false,'before_binding',true),auth.uid(),v_unit,v_org);
        end if;
        return true;
      end if;
      return false;
    end if;
    if p_expected_binding_generation is not null or p_scope<>'dispatch' or c.provider not in('zapi','waha','uazapi') then return false; end if;
  elsif p_expected_binding_generation is null or b.generation is distinct from p_expected_binding_generation then raise exception 'template_configuration_changed' using errcode='PT409'; end if;
  if not p_enabled then
    -- No flags, health, secret or provider equality are authority to prevent stop.
    if p_scope='catalog' and b.submission_authorized_at is null and b.submission_authorized_by is null then
      update app_private.whatsapp_template_auto_enrollments set excluded_at=clock_timestamp(),excluded_by=auth.uid(),
        state='needs_review',reason_code='manual_review',updated_at=clock_timestamp()
        where channel_id=c.id and excluded_at is null;
      return true;
    end if;
    if p_scope='dispatch' and not b.dispatch_enabled then return true; end if;
    if p_scope='dispatch' then update public.whatsapp_template_bindings set dispatch_enabled=false where id=b.id;
    else update public.whatsapp_template_bindings set submission_authorized_at=null,submission_authorized_by=null where id=b.id; end if;
  else
    v_now:=clock_timestamp();
    if c.status<>'connected' or c.last_health_check_at is null or c.last_health_check_at<v_now-interval '5 minutes' then return false; end if;
    if p_scope='dispatch' then
      select id into v_selected from public.whatsapp_channels ch where ch.unit_id=v_unit and (ch.is_active=true or (ch.is_active is null and ch.status='connected' and not exists(select from public.whatsapp_channels x where x.unit_id=v_unit and x.is_active=true))) order by ch.is_active desc nulls last,ch.created_at,ch.id limit 1;
      if v_selected is distinct from c.id or c.provider not in('zapi','waha','uazapi','datafy') then return false; end if;
      -- Deliberate SQL twin of WEBHOOK_SIGNATURE_SCHEME channel_secret providers.
      if c.provider in('zapi','waha','uazapi') and (c.webhook_secret is null or btrim(c.webhook_secret)='') then return false; end if;
    elsif c.provider<>'datafy' then return false; end if;
    if b.id is null then
      begin
        insert into public.whatsapp_template_bindings(unit_id,channel_id,provider,account_id,channel_credential_revision,verified_at)
        values(v_unit,c.id,c.provider,null,c.template_credential_revision,v_now) returning * into b;
      exception when unique_violation then raise exception 'template_configuration_changed' using errcode='PT409'; end;
    else
      if (b.provider,b.channel_credential_revision) is distinct from (c.provider,c.template_credential_revision) then return false; end if;
      if c.provider in('zapi','waha','uazapi') and b.account_id is null and b.verified_at is null then
        update public.whatsapp_template_bindings set verified_at=v_now where id=b.id returning * into b;
      end if;
      if b.verified_at is null or (c.provider='datafy' and b.account_id is null) then return false; end if;
    end if;
    if p_scope='dispatch' then
      if b.dispatch_enabled then return true; end if;
      insert into app_private.whatsapp_cutover_adoption_permits
        (tx_id,operation,unit_id,binding_id,actor_id,old_generation,old_credential_revision,
         old_adopted_at,new_adopted_at,old_dispatch_enabled,new_dispatch_enabled)
      values(txid_current(),'binding_enable',v_unit,b.id,auth.uid(),b.generation,b.channel_credential_revision,
        b.adopted_at,coalesce(b.adopted_at,v_now),b.dispatch_enabled,true);
      if b.adopted_at is null then
        insert into app_private.whatsapp_cutover_adoption_permits
          (tx_id,operation,unit_id,binding_id,actor_id,old_generation,old_credential_revision,
           old_adopted_at,new_adopted_at,expected_adoption_at,old_dispatch_enabled,new_dispatch_enabled)
        values(txid_current(),'adoption_insert',v_unit,b.id,auth.uid(),b.generation,b.channel_credential_revision,
          b.adopted_at,coalesce(b.adopted_at,v_now),now(),b.dispatch_enabled,true);
      end if;
      update public.whatsapp_template_bindings set dispatch_enabled=true,adopted_at=coalesce(adopted_at,v_now) where id=b.id;
    else
      if b.submission_authorized_at is not null then return true; end if;
      update public.whatsapp_template_bindings set submission_authorized_at=v_now,submission_authorized_by=auth.uid() where id=b.id;
    end if;
  end if;
  insert into public.audit_log(table_name,record_id,action,new_values,actor_id,unit_id,organization_id)
  values('whatsapp_template_bindings',b.id::text,'UPDATE',jsonb_build_object('scope',p_scope,'enabled',p_enabled,'generation',b.generation),auth.uid(),v_unit,v_org);
  return true;
end $$;
revoke all on function app_private.release_whatsapp_template_channel_inner(uuid,text,boolean,bigint,bigint) from public,anon,authenticated,service_role;


-- Corpo congelado de 20261009003452_whatsapp_scheduled_voucher_issuer.sql, linhas 5-96; acesso somente pelo wrapper guardado.
create or replace function app_private.issue_scheduled_whatsapp_voucher_inner(
  p_rule_id uuid, p_customer_id uuid, p_code text, p_expected_rule jsonb
) returns table (
  voucher_id uuid, unit_id uuid, rule_id uuid, customer_id uuid,
  code text, discount_percent integer, status text,
  issued_at timestamptz, created_at timestamptz, expires_at timestamptz, job_id uuid
) language plpgsql security definer set search_path='' as $$
declare
  c public.customers%rowtype;
  r public.voucher_rules%rowtype;
  v public.vouchers%rowtype;
  j public.whatsapp_automation_jobs%rowtype;
  v_org uuid; v_adopted timestamptz; v_selected date; v_final_day date;
  v_issued timestamptz; v_expiry timestamptz; v_deadline timestamptz; v_job_id uuid;
begin
  if p_rule_id is null or p_customer_id is null or p_code is null or btrim(p_code)=''
    or jsonb_typeof(p_expected_rule) is distinct from 'object'
    or not (p_expected_rule ?& array['unit_id','trigger_type','discount_percent','validity_days','visits_required','days_window','selected_brt_day'])
    or (p_expected_rule-array['unit_id','trigger_type','discount_percent','validity_days','visits_required','days_window','selected_brt_day'])<>'{}'::jsonb
    or jsonb_typeof(p_expected_rule->'unit_id') is distinct from 'string'
    or jsonb_typeof(p_expected_rule->'trigger_type') is distinct from 'string'
    or jsonb_typeof(p_expected_rule->'discount_percent') is distinct from 'number'
    or jsonb_typeof(p_expected_rule->'validity_days') is distinct from 'number'
    or jsonb_typeof(p_expected_rule->'visits_required') not in('number','null')
    or jsonb_typeof(p_expected_rule->'days_window') not in('number','null')
    or jsonb_typeof(p_expected_rule->'selected_brt_day') is distinct from 'string'
    or (p_expected_rule->>'selected_brt_day') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    then raise exception 'voucher_assertion_invalid' using errcode='22023'; end if;
  v_selected := (p_expected_rule->>'selected_brt_day')::date;
  if not isfinite(v_selected) or to_char(v_selected,'YYYY-MM-DD')<>p_expected_rule->>'selected_brt_day'
    then raise exception 'voucher_assertion_invalid' using errcode='22023'; end if;

  -- Same customer-first order as erasure/dispatch. No additional tenant-parent
  -- SHARE locks: those current reads are not a tenant-deletion serialization claim.
  select * into c from public.customers where id=p_customer_id for update;
  if not found then raise exception 'voucher_resource_refused' using errcode='42501'; end if;
  select * into r from public.voucher_rules where id=p_rule_id for share;
  if not found or not r.active or r.trigger_type not in('birthday','frequency')
    then raise exception 'voucher_resource_refused' using errcode='42501'; end if;
  select u.organization_id into v_org from public.units u join public.organizations o on o.id=u.organization_id where u.id=r.unit_id;
  if not found or c.organization_id is distinct from v_org or c.deleted_at is not null
    or c.phone is null or c.phone !~ '^[0-9]{10,11}$' or public.normalize_br_phone(c.phone) is distinct from c.phone
    then raise exception 'voucher_resource_refused' using errcode='42501'; end if;
  if (p_expected_rule-'selected_brt_day') is distinct from jsonb_build_object(
    'unit_id',r.unit_id,'trigger_type',r.trigger_type,'discount_percent',r.discount_percent,
    'validity_days',r.validity_days,'visits_required',r.visits_required,'days_window',r.days_window)
    then raise exception 'voucher_rule_changed' using errcode='22023'; end if;
  select a.adopted_at into v_adopted from public.whatsapp_automation_adoptions a where a.unit_id=r.unit_id;
  if not found or v_adopted is null or not isfinite(v_adopted)
    then raise exception 'voucher_adoption_required' using errcode='P0A01'; end if;

  -- One real millisecond instant AFTER the ordered waits. BRT is fixed -03,
  -- independent of session timezone/DST; duration TTL is exactly 604800000ms.
  v_issued := date_trunc('milliseconds', clock_timestamp());
  if v_selected is distinct from ((v_issued at time zone 'UTC')-interval '3 hours')::date
    then raise exception 'voucher_selection_day_changed' using errcode='22023'; end if;
  if v_issued<v_adopted then raise exception 'voucher_before_adoption' using errcode='P0A01'; end if;
  v_expiry := (((((v_issued at time zone 'UTC')-interval '3 hours')::date+r.validity_days)
    + time '23:59:59.999')+interval '3 hours') at time zone 'UTC';
  v_deadline := v_issued + interval '168 hours';
  -- The fresh, unpublished voucher is the sole exception to the existing-resource
  -- lock order. Never reread an old winner: code and natural-key collisions both
  -- mean zero new provenance. Only this INSERT's 23505 is a duplicate.
  begin
    insert into public.vouchers(id,unit_id,rule_id,customer_id,code,discount_percent,status,issued_at,created_at,expires_at)
    values(gen_random_uuid(),r.unit_id,r.id,c.id,p_code,r.discount_percent,'active',v_issued,v_issued,v_expiry)
    returning * into v;
  exception when unique_violation then
    return;
  end;
  v_job_id := public.enqueue_whatsapp_automation(jsonb_build_object(
    'unit_id',v.unit_id,'kind','voucher_issued','voucher_id',v.id,
    'source_event_key',v.id::text,'fact_at',v.created_at,'expires_at',v_deadline));
  -- Any enqueue failure (including 23505), missing row or changed identity aborts
  -- the whole call. No external send takes place inside this transaction.
  select * into j from public.whatsapp_automation_jobs where id=v_job_id;
  if not found or j.unit_id is distinct from v.unit_id or j.organization_id is distinct from v_org
    or j.kind is distinct from 'voucher_issued' or j.voucher_id is distinct from v.id
    or j.customer_id is distinct from v.customer_id or j.reservation_id is not null or j.waitlist_id is not null
    or j.source_event_key is distinct from v.id::text or j.fact_at is distinct from v.created_at
    or j.expires_at is distinct from v_deadline
    then raise exception 'voucher_atomic_provenance_unavailable' using errcode='PT503'; end if;

  -- No relation access after this final real clock. A physical commit or later
  -- HTTP attempt can still cross midnight; the dispatcher owns its final boundary.
  v_final_day := ((clock_timestamp() at time zone 'UTC')-interval '3 hours')::date;
  if v_selected is distinct from v_final_day then
    raise exception 'voucher_selection_day_changed' using errcode='22023';
  end if;
  return query values(v.id,v.unit_id,v.rule_id,v.customer_id,v.code,v.discount_percent,v.status,
    v.issued_at,v.created_at,v.expires_at,v_job_id);
end $$;
revoke all on function app_private.issue_scheduled_whatsapp_voucher_inner(uuid,uuid,text,jsonb) from public,anon,authenticated,service_role;

-- Os triggers nao adquirem advisory/row lock de pais: apenas consomem uma prova
-- emitida no caminho administrativo apos o mutex da unidade.
create or replace function app_private.whatsapp_cutover_check_adoption_permit()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_ok integer; v_binding uuid;
begin
  if tg_table_name='whatsapp_template_bindings' then
    if tg_op='INSERT' then
      if new.dispatch_enabled or new.adopted_at is not null then
        raise exception 'cutover_adoption_permit_required' using errcode='42501'; end if;
      return new;
    end if;
    if (not old.dispatch_enabled and new.dispatch_enabled) or (old.adopted_at is null and new.adopted_at is not null) then
      delete from app_private.whatsapp_cutover_adoption_permits p
        where p.tx_id=txid_current() and p.operation='binding_enable' and p.unit_id=old.unit_id
          and p.binding_id=old.id and p.actor_id=auth.uid() and auth.role()='authenticated'
          and p.old_generation=old.generation and p.old_credential_revision=old.channel_credential_revision
          and p.old_adopted_at is not distinct from old.adopted_at
          and p.new_adopted_at is not distinct from new.adopted_at
          and p.old_dispatch_enabled is not distinct from old.dispatch_enabled
          and p.new_dispatch_enabled is not distinct from new.dispatch_enabled
          and (new.id,new.unit_id,new.channel_id,new.provider,new.account_id,new.generation,new.channel_credential_revision)
            is not distinct from (old.id,old.unit_id,old.channel_id,old.provider,old.account_id,old.generation,old.channel_credential_revision)
        returning 1 into v_ok;
      if v_ok is distinct from 1 then raise exception 'cutover_adoption_permit_required' using errcode='42501'; end if;
    end if;
    return new;
  end if;
  if tg_table_name='whatsapp_automation_adoptions' and tg_op='INSERT' then
    select p.binding_id into v_binding from app_private.whatsapp_cutover_adoption_permits p
      where p.tx_id=txid_current() and p.operation='adoption_insert' and p.unit_id=new.unit_id
        and p.actor_id=auth.uid() and auth.role()='authenticated'
        and p.old_adopted_at is null and p.old_dispatch_enabled is false and p.new_dispatch_enabled is true
        and p.expected_adoption_at is not distinct from new.adopted_at
        and exists(select 1 from public.whatsapp_template_bindings b
          where b.id=p.binding_id and b.unit_id=new.unit_id and b.dispatch_enabled is false
            and b.adopted_at is null and b.generation=p.old_generation
            and b.channel_credential_revision=p.old_credential_revision)
      order by p.binding_id limit 1;
    if v_binding is null then raise exception 'cutover_adoption_permit_required' using errcode='42501'; end if;
    delete from app_private.whatsapp_cutover_adoption_permits p
      where p.tx_id=txid_current() and p.operation='adoption_insert' and p.unit_id=new.unit_id
        and p.binding_id=v_binding and p.actor_id=auth.uid()
        and p.expected_adoption_at is not distinct from new.adopted_at returning 1 into v_ok;
    if v_ok is distinct from 1 then raise exception 'cutover_adoption_permit_required' using errcode='42501'; end if;
    return new;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
revoke all on function app_private.whatsapp_cutover_check_adoption_permit() from public,anon,authenticated,service_role;
drop trigger if exists whatsapp_cutover_binding_permit on public.whatsapp_template_bindings;
create trigger whatsapp_cutover_binding_permit before insert or update on public.whatsapp_template_bindings
  for each row execute function app_private.whatsapp_cutover_check_adoption_permit();
drop trigger if exists whatsapp_cutover_adoption_permit on public.whatsapp_automation_adoptions;
create trigger whatsapp_cutover_adoption_permit before insert on public.whatsapp_automation_adoptions
  for each row execute function app_private.whatsapp_cutover_check_adoption_permit();

create or replace function public.release_whatsapp_template_channel(
  p_channel_id uuid,p_scope text,p_enabled boolean,p_expected_credential_revision bigint,p_expected_binding_generation bigint)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_unit uuid;
begin
  perform app_private.require_whatsapp_template_manager(null,true);
  if p_scope='dispatch' and p_enabled is true then
    select ch.unit_id into v_unit from public.whatsapp_channels ch where ch.id=p_channel_id;
    if v_unit is null then raise exception 'template_management_forbidden' using errcode='42501'; end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('whatsapp-cutover-unit:'||v_unit::text,0));
    if not exists(select 1 from public.whatsapp_channels ch where ch.id=p_channel_id and ch.unit_id=v_unit) then
      raise exception 'template_management_forbidden' using errcode='42501'; end if;
    if exists(select 1 from app_private.whatsapp_cutover_intents i where i.unit_id=v_unit
      and i.state in ('claimed','posting','uncertain')) then return false; end if;
    if app_private.whatsapp_cutover_has_active_legacy_uncertainty(v_unit) then return false; end if;
    if exists(select 1 from public.whatsapp_automation_jobs j where j.unit_id=v_unit
      and j.state in ('claimed','posting','uncertain') and j.provider_message_id is null) then return false; end if;
  end if;
  return app_private.release_whatsapp_template_channel_inner(p_channel_id,p_scope,p_enabled,
    p_expected_credential_revision,p_expected_binding_generation);
end $$;
revoke all on function public.release_whatsapp_template_channel(uuid,text,boolean,bigint,bigint) from public,anon,authenticated,service_role;
grant execute on function public.release_whatsapp_template_channel(uuid,text,boolean,bigint,bigint) to authenticated;

create or replace function public.enqueue_whatsapp_automation(p_intent jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_kind text; v_resource uuid; v_unit uuid; v_type text; v_org uuid; v_job uuid;
  f record; m app_private.whatsapp_cutover_intents%rowtype; v_history text;
begin
  if pg_catalog.jsonb_typeof(p_intent) is distinct from 'object' then
    raise exception 'automation_intent_invalid' using errcode='22023'; end if;
  v_kind:=p_intent->>'kind';
  if v_kind is null or v_kind not in ('confirmation','reminder_d1','survey_d1','waitlist_entered',
      'waitlist_feedback','voucher_issued','cancellation','waitlist_table_ready')
    or pg_catalog.num_nonnulls(p_intent->>'reservation_id',p_intent->>'waitlist_id',p_intent->>'voucher_id')<>1 then
    raise exception 'automation_intent_invalid' using errcode='22023'; end if;
  v_resource:=coalesce((p_intent->>'reservation_id')::uuid,(p_intent->>'waitlist_id')::uuid,(p_intent->>'voucher_id')::uuid);
  select * into f from app_private.whatsapp_cutover_lock_fact(v_kind,v_resource);
  v_unit:=(p_intent->>'unit_id')::uuid; v_type:=f.resource_type; v_org:=f.organization_id;
  if v_unit is distinct from f.unit_id
    or (v_type='reservation') is distinct from ((p_intent->>'reservation_id') is not null)
    or (v_type='waitlist') is distinct from ((p_intent->>'waitlist_id') is not null)
    or (v_type='voucher') is distinct from ((p_intent->>'voucher_id') is not null) then
    raise exception 'automation_intent_invalid' using errcode='22023'; end if;
  select * into m from app_private.whatsapp_cutover_intents
    where unit_id=v_unit and kind=v_kind and resource_type=v_type and resource_id=v_resource for update;
  if found and m.owner in ('legacy','historical') and m.state<>'released_prepost' then return null; end if;
  if not found or m.state='released_prepost' then
    v_history:=app_private.whatsapp_cutover_historical_state(v_unit,v_kind,v_type,v_resource);
    if v_history is not null then return null; end if;
  end if;
  v_job:=app_private.whatsapp_automation_enqueue_inner(p_intent);
  if v_job is null then return null; end if;
  if m.id is null then
    insert into app_private.whatsapp_cutover_intents(unit_id,kind,resource_type,resource_id,owner,state,managed_job_id,origin)
    values(v_unit,v_kind,v_type,v_resource,'managed','ready',v_job,'managed-enqueue');
  elsif m.state='released_prepost' then
    update app_private.whatsapp_cutover_intents set owner='managed',state='ready',managed_job_id=v_job,
      fence=null,channel_id=null,provider=null,credential_revision=null,provider_message_id=null,
      origin='managed-enqueue',updated_at=clock_timestamp() where id=m.id and state='released_prepost';
  elsif m.owner<>'managed' or m.managed_job_id is distinct from v_job then
    raise exception 'cutover_intent_conflict' using errcode='P0A01';
  end if;
  return v_job;
end $$;
revoke all on function public.enqueue_whatsapp_automation(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.enqueue_whatsapp_automation(jsonb) to service_role;

create or replace function app_private.whatsapp_automation_post_core(
  p_job_id uuid,p_fence uuid,p_generation bigint,p_consent_revision bigint,p_sync_epoch bigint,
  p_confirm_only boolean,p_expected jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.whatsapp_automation_jobs%rowtype; f record; m app_private.whatsapp_cutover_intents%rowtype;
  v_resource uuid; v_kind text; v_result jsonb;
begin
  select * into j from public.whatsapp_automation_jobs where id=p_job_id;
  if not found then return '{"allowed":false,"reason":"authority_changed"}'::jsonb; end if;
  v_resource:=coalesce(j.reservation_id,j.waitlist_id,j.voucher_id); v_kind:=j.kind;
  select * into f from app_private.whatsapp_cutover_lock_fact(j.kind,v_resource);
  if f.unit_id is distinct from j.unit_id or f.organization_id is distinct from j.organization_id then
    return '{"allowed":false,"reason":"authority_changed"}'::jsonb; end if;
  select * into j from public.whatsapp_automation_jobs where id=p_job_id;
  if not found or coalesce(j.reservation_id,j.waitlist_id,j.voucher_id) is distinct from v_resource
    or j.unit_id is distinct from f.unit_id or j.kind is distinct from v_kind then
    return '{"allowed":false,"reason":"authority_changed"}'::jsonb; end if;
  select * into m from app_private.whatsapp_cutover_intents
    where unit_id=j.unit_id and kind=j.kind and resource_type=f.resource_type and resource_id=v_resource for update;
  if not found or m.owner<>'managed' or m.managed_job_id is distinct from j.id
    or m.state not in ('ready','preproxy_refused') then
    return '{"allowed":false,"reason":"authority_changed"}'::jsonb; end if;
  if app_private.whatsapp_cutover_historical_state(j.unit_id,j.kind,f.resource_type,v_resource) is not null then
    return '{"allowed":false,"reason":"authority_changed"}'::jsonb; end if;
  v_result:=app_private.whatsapp_automation_post_inner(p_job_id,p_fence,p_generation,p_consent_revision,
    p_sync_epoch,p_confirm_only,p_expected);
  if p_confirm_only is true and v_result->>'allowed'='true' then
    update app_private.whatsapp_cutover_intents set state='posting',fence=p_fence,
      channel_id=j.channel_id,provider=j.provider,credential_revision=j.initial_credential_revision,
      attempt_count=attempt_count+1,posting_at=clock_timestamp(),updated_at=clock_timestamp()
      where id=m.id and state in ('ready','preproxy_refused') and managed_job_id=j.id;
    if not found then raise exception 'cutover_intent_conflict' using errcode='P0A01'; end if;
  end if;
  return v_result;
end $$;
revoke all on function app_private.whatsapp_automation_post_core(uuid,uuid,bigint,bigint,bigint,boolean,jsonb)
  from public,anon,authenticated,service_role;

create or replace function public.finish_whatsapp_automation(p_job_id uuid,p_fence uuid,p_result jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare j public.whatsapp_automation_jobs%rowtype; m app_private.whatsapp_cutover_intents%rowtype;
  v_resource uuid; v_type text; v_ok boolean; v_outcome text:=p_result->>'outcome';
  v_reason text:=p_result->>'reason'; v_provider_id text:=p_result->>'provider_message_id';
begin
  select * into j from public.whatsapp_automation_jobs where id=p_job_id;
  if not found then return false; end if;
  v_resource:=coalesce(j.reservation_id,j.waitlist_id,j.voucher_id);
  v_type:=case when j.reservation_id is not null then 'reservation' when j.waitlist_id is not null then 'waitlist' else 'voucher' end;
  perform app_private.whatsapp_cutover_lock_existing(j.unit_id,j.kind,v_resource);
  select * into j from public.whatsapp_automation_jobs where id=p_job_id;
  if not found or coalesce(j.reservation_id,j.waitlist_id,j.voucher_id) is distinct from v_resource then return false; end if;
  select * into m from app_private.whatsapp_cutover_intents
    where unit_id=j.unit_id and kind=j.kind and resource_type=v_type and resource_id=v_resource for update;
  if not found or m.owner<>'managed' or m.managed_job_id is distinct from j.id then return false; end if;
  if v_outcome='local_preflight_refused' and m.state='posting' then return false; end if;
  if v_outcome='accepted' and (m.state not in ('posting','uncertain','accepted') or m.fence is distinct from p_fence
    or (m.provider_message_id is not null and m.provider_message_id is distinct from v_provider_id)) then return false; end if;
  if v_outcome<>'accepted' and m.state='accepted' then return false; end if;
  v_ok:=app_private.finish_whatsapp_automation_inner(p_job_id,p_fence,p_result);
  if not v_ok then return false; end if;
  if v_outcome='accepted' then
    update app_private.whatsapp_cutover_intents set state='accepted',provider_message_id=v_provider_id,
      settled_at=clock_timestamp(),updated_at=clock_timestamp() where id=m.id;
  elsif v_outcome='uncertain' or (v_outcome='rejected' and v_reason<>'documented_preproxy_429') then
    if m.state='posting' then
      update app_private.whatsapp_cutover_intents set state='uncertain',settled_at=clock_timestamp(),updated_at=clock_timestamp() where id=m.id;
    end if;
  elsif v_reason='documented_preproxy_429' then
    if m.state is distinct from 'posting' or j.provider<>'datafy' then raise exception 'cutover_intent_conflict' using errcode='P0A01'; end if;
    update app_private.whatsapp_cutover_intents set state='preproxy_refused',fence=null,
      settled_at=clock_timestamp(),updated_at=clock_timestamp() where id=m.id;
  end if;
  return true;
end $$;
revoke all on function public.finish_whatsapp_automation(uuid,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.finish_whatsapp_automation(uuid,uuid,jsonb) to service_role;

create or replace function public.reconcile_whatsapp_automation_acceptance(p_job_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.whatsapp_automation_jobs%rowtype; m app_private.whatsapp_cutover_intents%rowtype;
  v_resource uuid; v_type text; v_result jsonb;
begin
  select * into j from public.whatsapp_automation_jobs where id=p_job_id;
  if not found then return '{"state":"deferred","history":"none"}'::jsonb; end if;
  v_resource:=coalesce(j.reservation_id,j.waitlist_id,j.voucher_id);
  v_type:=case when j.reservation_id is not null then 'reservation' when j.waitlist_id is not null then 'waitlist' else 'voucher' end;
  perform app_private.whatsapp_cutover_lock_existing(j.unit_id,j.kind,v_resource);
  select * into j from public.whatsapp_automation_jobs where id=p_job_id;
  if not found or coalesce(j.reservation_id,j.waitlist_id,j.voucher_id) is distinct from v_resource then
    return '{"state":"deferred","history":"none"}'::jsonb; end if;
  select * into m from app_private.whatsapp_cutover_intents
    where unit_id=j.unit_id and kind=j.kind and resource_type=v_type and resource_id=v_resource for update;
  if not found or m.owner<>'managed' or m.managed_job_id is distinct from j.id then
    return '{"state":"deferred","history":"none"}'::jsonb; end if;
  v_result:=app_private.reconcile_whatsapp_automation_acceptance_inner(p_job_id);
  if j.provider_message_id is not null and j.state in ('accepted','reconciled') then
    if m.provider_message_id is not null and m.provider_message_id is distinct from j.provider_message_id then
      raise exception 'cutover_intent_conflict' using errcode='P0A01'; end if;
    update app_private.whatsapp_cutover_intents set state='accepted',provider_message_id=j.provider_message_id,
      settled_at=clock_timestamp(),updated_at=clock_timestamp() where id=m.id and state in ('posting','uncertain','accepted');
  end if;
  return v_result;
end $$;
revoke all on function public.reconcile_whatsapp_automation_acceptance(uuid) from public,anon,authenticated,service_role;
grant execute on function public.reconcile_whatsapp_automation_acceptance(uuid) to service_role;

create or replace function public.issue_scheduled_whatsapp_voucher(
  p_rule_id uuid,p_customer_id uuid,p_code text,p_expected_rule jsonb)
returns table(voucher_id uuid,unit_id uuid,rule_id uuid,customer_id uuid,code text,
  discount_percent integer,status text,issued_at timestamptz,created_at timestamptz,
  expires_at timestamptz,job_id uuid)
language plpgsql security definer set search_path='' as $$
declare v_unit uuid;
begin
  select r.unit_id into v_unit from public.voucher_rules r where r.id=p_rule_id and r.trigger_type in ('birthday','frequency');
  if v_unit is null then return; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('whatsapp-cutover-unit:'||v_unit::text,0));
  if not exists(select 1 from public.voucher_rules r where r.id=p_rule_id and r.unit_id=v_unit
    and r.trigger_type in ('birthday','frequency')) then return; end if;
  return query select * from app_private.issue_scheduled_whatsapp_voucher_inner(p_rule_id,p_customer_id,p_code,p_expected_rule);
end $$;
revoke all on function public.issue_scheduled_whatsapp_voucher(uuid,uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.issue_scheduled_whatsapp_voucher(uuid,uuid,text,jsonb) to service_role;

-- Apenas posse gerenciada ja existente: nenhum HTTP, job novo, notificação ou
-- tentativa legada e criado. A chave privada persiste apos a purga do job.
insert into app_private.whatsapp_cutover_intents
  (unit_id,kind,resource_type,resource_id,owner,state,fence,managed_job_id,
   channel_id,provider,credential_revision,provider_message_id,origin,attempt_count,
   claimed_at,posting_at,settled_at)
select j.unit_id,j.kind,
  case when j.reservation_id is not null then 'reservation' when j.waitlist_id is not null then 'waitlist' else 'voucher' end,
  coalesce(j.reservation_id,j.waitlist_id,j.voucher_id),'managed',
  case when j.provider_message_id is not null and j.state in ('accepted','reconciled') then 'accepted'
    when j.posting_started_at is not null and j.state='retry_wait' and j.error_code='documented_preproxy_429' then 'preproxy_refused'
    when j.posting_started_at is not null or j.state='uncertain' or j.provider_message_id is not null then 'uncertain'
    else 'ready' end,
  j.claim_token,j.id,j.channel_id,j.provider,j.initial_credential_revision,j.provider_message_id,
  'managed-backfill',j.attempts,j.created_at,j.posting_started_at,j.finished_at
from public.whatsapp_automation_jobs j
where j.kind in ('confirmation','reminder_d1','survey_d1','waitlist_entered','waitlist_feedback',
  'voucher_issued','cancellation','waitlist_table_ready')
  and pg_catalog.num_nonnulls(j.reservation_id,j.waitlist_id,j.voucher_id)=1
on conflict (unit_id,kind,resource_type,resource_id) do nothing;

notify pgrst,'reload schema';
commit;
