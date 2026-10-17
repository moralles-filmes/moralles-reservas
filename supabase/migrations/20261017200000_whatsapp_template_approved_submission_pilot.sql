-- Pilot authority for exactly nine version-1 pt_BR Datafy submissions.
-- SQL first: the 3-argument worker RPCs fail closed until the new bundle uses
-- the complete submission payload digest (including BODY examples).
begin;

create table if not exists app_private.whatsapp_template_approved_submissions (
  logical_id text primary key,
  version integer not null check (version = 1),
  language text not null check (language = 'pt_BR'),
  requested_category text not null check (requested_category in ('UTILITY','MARKETING')),
  desired_hash text not null check (desired_hash ~ '^[a-f0-9]{64}$'),
  payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
  check (logical_id in ('res_confirmacao_v1','res_confirmacao_desconto_v1','res_lembrete_dia_v1',
    'res_pesquisa_reserva_v1','fila_entrada_v1','fila_feedback_v1',
    'mkt_voucher_programado_v1','fila_mesa_pronta_v1','res_cancelada_v1'))
);
alter table app_private.whatsapp_template_approved_submissions enable row level security;
alter table app_private.whatsapp_template_approved_submissions force row level security;
revoke all on app_private.whatsapp_template_approved_submissions from public,anon,authenticated,service_role;

insert into app_private.whatsapp_template_approved_submissions
  (logical_id,version,language,requested_category,desired_hash,payload_hash) values
  ('res_confirmacao_v1',1,'pt_BR','UTILITY','ce487eeff4d968250f3f9e66c4cc68ff2ae5bbef7dc5fc2589c63089240893c1','4ab2cdd4711c9b95b122a23a773088bfa8b6d3d15a6eac04cb234d4f8d0ac114'),
  ('res_confirmacao_desconto_v1',1,'pt_BR','UTILITY','4571b791b859902329adb2ed9aee72f3e45d003737568907526393256baa39c9','db166a6c02d93b32ba6225500f4076a7ce993ef2aac51270be17c8a35e35fe51'),
  ('res_lembrete_dia_v1',1,'pt_BR','UTILITY','4f3f8e853b328e5efbbb5a2b3983680220c4644b15e3f4172711d2d923775919','f753eda0f0f789dabb22065e57f63b4a5b496ffb4d08896371dccbf5d0ab04f5'),
  ('res_pesquisa_reserva_v1',1,'pt_BR','UTILITY','aab204d9e5200060c1bfb3b385c0a943ebc206da36c7e871aa68ff0b91f6b061','7d7ea08443d00dd8dd82fb068135a4be01b38ce9c0e6c6e90ce7442a82f7b23e'),
  ('fila_entrada_v1',1,'pt_BR','UTILITY','8c298762880198f33842870ba00e59f58d7d4f7c2c0bbb668eab51bebd323480','e188762e1ebe706f368818551fd1ace6050ee70b121e8fe7dc3b467861fc9ede'),
  ('fila_feedback_v1',1,'pt_BR','MARKETING','4bd8011296f643153ebb437d94c9566f8ddfabeada5e01ad51c4e9da27fa3327','ab3a590ccfc26c67fc4a9f81ad03223ecb18b5711336cc034119d15cba7ad595'),
  ('mkt_voucher_programado_v1',1,'pt_BR','MARKETING','d6ed1378ac4fa2e0351c58b8275b795df4db9e44b89e2ec4bc39f1189f7e9a1e','1034ad9fabb5aaab601ba9a76f96813d01780f3bdd80e6292da924e91030432b'),
  ('fila_mesa_pronta_v1',1,'pt_BR','UTILITY','7da8b7d292bc5bcd30aacb919182c718442a3f5f395345a0fd40cd2219385248','7c3f9f1c5a53e7fce8ddea7256b6e66586c91d875029fb748968d3d773c4553c'),
  ('res_cancelada_v1',1,'pt_BR','UTILITY','3257992fc6d1db5f882d08587146bf3807c04e4bd73369429bf871b3f2621cbb','a264981df2b0e55e6bd4a33d7b58bc3fe590d3170521e06fcd49c2fb8ebf4b84')
on conflict (logical_id) do nothing;

create or replace function app_private.whatsapp_template_approved_catalog_digest()
returns text language sql stable security definer set search_path = '' as $$
  select case when count(*) = 9 then pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(string_agg(
    logical_id || ':' || version::text || ':' || language || ':' || requested_category || ':' || desired_hash || ':' || payload_hash,
    E'\n' order by logical_id), 'UTF8')), 'hex') else null end
  from app_private.whatsapp_template_approved_submissions
$$;
revoke all on function app_private.whatsapp_template_approved_catalog_digest() from public,anon,authenticated,service_role;

do $$ begin
  if app_private.whatsapp_template_approved_catalog_digest() is distinct from 'a0fb939e3b2023c8f7c49a7f6fe77049fb312f6d274cf67f23e15f3906298965' then
    raise exception 'template_approved_catalog_incomplete' using errcode='23514';
  end if;
end $$;

create table if not exists app_private.whatsapp_template_submission_grants (
  id uuid primary key default gen_random_uuid(),
  binding_id uuid not null,
  channel_id uuid not null,
  unit_id uuid not null,
  account_id uuid not null,
  binding_generation bigint not null,
  credential_revision bigint not null,
  catalog_digest text not null check (catalog_digest ~ '^[a-f0-9]{64}$'),
  origin text not null check (origin = 'manual'),
  actor_id uuid not null,
  granted_at timestamptz not null default clock_timestamp(),
  revoked_at timestamptz,
  check (revoked_at is null or revoked_at >= granted_at)
);
alter table app_private.whatsapp_template_submission_grants enable row level security;
alter table app_private.whatsapp_template_submission_grants force row level security;
create unique index if not exists whatsapp_template_submission_grants_one_active_idx
  on app_private.whatsapp_template_submission_grants(binding_id) where revoked_at is null;
create index if not exists whatsapp_template_submission_grants_binding_idx
  on app_private.whatsapp_template_submission_grants(binding_id,granted_at desc);
revoke all on app_private.whatsapp_template_submission_grants from public,anon,authenticated,service_role;

create or replace function app_private.capture_whatsapp_template_manual_grant()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_digest text;
begin
  if old.submission_authorized_at is null and new.submission_authorized_at is not null then
    v_digest := app_private.whatsapp_template_approved_catalog_digest();
    if v_digest is null or new.provider <> 'datafy' or new.account_id is null
      or new.submission_authorized_by is distinct from auth.uid()
      or auth.role() is distinct from 'authenticated'
      or not app_private.is_platform_admin(auth.uid()) then
      raise exception 'template_submission_grant_denied' using errcode='42501';
    end if;
    insert into app_private.whatsapp_template_submission_grants
      (binding_id,channel_id,unit_id,account_id,binding_generation,credential_revision,catalog_digest,origin,actor_id,granted_at)
    values (new.id,new.channel_id,new.unit_id,new.account_id,new.generation,new.channel_credential_revision,
      v_digest,'manual',auth.uid(),new.submission_authorized_at);
  elsif old.submission_authorized_at is not null and new.submission_authorized_at is null then
    update app_private.whatsapp_template_submission_grants
      set revoked_at=clock_timestamp() where binding_id=old.id and revoked_at is null;
  end if;
  return new;
end $$;
revoke all on function app_private.capture_whatsapp_template_manual_grant() from public,anon,authenticated,service_role;
drop trigger if exists capture_whatsapp_template_manual_grant on public.whatsapp_template_bindings;
create trigger capture_whatsapp_template_manual_grant after update of submission_authorized_at on public.whatsapp_template_bindings
  for each row execute function app_private.capture_whatsapp_template_manual_grant();

-- Existing grants predate the complete-payload authority. They cannot submit
-- until an admin revokes and grants again through release_channel.

create or replace function app_private.whatsapp_template_submission_gate(
  p_job_id uuid,p_fence uuid,p_generation bigint,p_payload_hash text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_digest text;
begin
  if p_payload_hash is null or p_payload_hash !~ '^[a-f0-9]{64}$' then return false; end if;
  v_digest := app_private.whatsapp_template_approved_catalog_digest();
  if v_digest is null then return false; end if;
  return exists (
    select 1 from public.whatsapp_template_jobs j
    join public.whatsapp_remote_templates t on t.account_id=j.account_id
      and t.logical_id=j.target_key and t.version=1 and t.language='pt_BR'
    join app_private.whatsapp_template_approved_submissions ap on ap.logical_id=t.logical_id
      and (ap.version,ap.language,ap.requested_category,ap.desired_hash,ap.payload_hash)
      = (t.version,t.language,t.requested_category,t.desired_hash,p_payload_hash)
    join public.whatsapp_template_bindings b on b.id=j.binding_id
    join public.whatsapp_channels c on c.id=b.channel_id
    join public.whatsapp_template_accounts a on a.id=j.account_id
    join public.units u on u.id=b.unit_id
    join app_private.whatsapp_template_submission_grants g on g.binding_id=b.id and g.revoked_at is null
    where j.id=p_job_id and j.operation='provision' and j.claim_token=p_fence
      and j.binding_generation=p_generation and b.generation=p_generation
      and b.submission_authorized_at is not null and b.submission_authorized_by=g.actor_id
      and b.verified_at is not null and b.provider='datafy' and c.provider='datafy' and c.status='connected'
      and c.last_health_check_at >= clock_timestamp()-interval '5 minutes'
      and (b.channel_id,b.unit_id,b.account_id,b.channel_credential_revision)
        = (g.channel_id,g.unit_id,g.account_id,g.credential_revision)
      and b.channel_credential_revision=c.template_credential_revision
      and (b.account_id,b.generation)=(j.account_id,g.binding_generation)
      and (u.organization_id,a.organization_id)=(a.organization_id,j.organization_id)
      and g.catalog_digest=v_digest and g.origin='manual'
      and t.name=t.logical_id and t.binding_generation=a.binding_generation
      and j.claimed_until>clock_timestamp()
      and exists(select from public.platform_flags where key='whatsapp_template_catalog' and value='true'::jsonb)
  );
end $$;
revoke all on function app_private.whatsapp_template_submission_gate(uuid,uuid,bigint,text) from public,anon,authenticated,service_role;

-- The legacy bundles lack a complete-payload proof. During SQL-before-EF
-- rollout they must not submit anything, including a model with old hash.
create or replace function public.prepare_whatsapp_template_provision(p_job_id uuid,p_fence uuid,p_generation bigint)
returns boolean language sql security definer set search_path = '' as $$ select false $$;
create or replace function public.confirm_whatsapp_template_post(p_job_id uuid,p_fence uuid,p_generation bigint)
returns boolean language sql security definer set search_path = '' as $$ select false $$;
revoke all on function public.prepare_whatsapp_template_provision(uuid,uuid,bigint) from public,anon,authenticated,service_role;
grant execute on function public.prepare_whatsapp_template_provision(uuid,uuid,bigint) to service_role;
revoke all on function public.confirm_whatsapp_template_post(uuid,uuid,bigint) from public,anon,authenticated,service_role;
grant execute on function public.confirm_whatsapp_template_post(uuid,uuid,bigint) to service_role;

-- Four-argument variants and final pre-POST RPC are appended below.

-- Current worker variants use the complete-payload digest, including examples.
create or replace function public.prepare_whatsapp_template_provision(p_job_id uuid,p_fence uuid,p_generation bigint,p_payload_hash text)
returns boolean language plpgsql security definer set search_path='' as $$
declare j public.whatsapp_template_jobs%rowtype; b public.whatsapp_template_bindings%rowtype; a public.whatsapp_template_accounts%rowtype;
  c public.whatsapp_channels%rowtype; t public.whatsapp_remote_templates%rowtype; v_now timestamptz; v_authorization uuid;
begin
  select * into j from public.whatsapp_template_jobs where id=p_job_id;
  if not found then return false; end if;
  select * into a from public.whatsapp_template_accounts where id=j.account_id for share;
  select * into b from public.whatsapp_template_bindings where id=j.binding_id for share;
  select * into c from public.whatsapp_channels where id=b.channel_id for share;
  select * into t from public.whatsapp_remote_templates where account_id=a.id and logical_id=j.target_key and version=1 and language='pt_BR' for update;
  select * into j from public.whatsapp_template_jobs where id=p_job_id for update;
  v_now:=clock_timestamp();
  if j.state<>'claimed' or j.claim_token is distinct from p_fence or j.claimed_until<=v_now or j.posting_started_at is not null then return false; end if;
  if j.operation<>'provision' or b.id is null or a.id is null or c.id is null or t.id is null or t.name<>t.logical_id
    or (b.account_id,b.generation) is distinct from (j.account_id,j.binding_generation) or p_generation is distinct from b.generation
    or b.verified_at is null or b.channel_credential_revision is distinct from c.template_credential_revision
    or (c.unit_id,c.provider) is distinct from (b.unit_id,b.provider) then
    update public.whatsapp_template_jobs set state='needs_review',error_code='binding_changed' where id=j.id; return false;
  end if;
  if j.target_key not in('res_confirmacao_v1','res_confirmacao_desconto_v1','res_lembrete_dia_v1','res_pesquisa_reserva_v1','fila_entrada_v1','fila_feedback_v1','mkt_voucher_programado_v1','fila_mesa_pronta_v1','res_cancelada_v1') then return false; end if;
  if a.sync_capture_id is null or a.last_sync_published_at is null or exists(select from public.whatsapp_remote_templates where account_id=a.id and sync_required) then return false; end if;
  if t.sync_required or t.binding_generation<>a.binding_generation or t.last_synced_at is null or t.last_synced_at<v_now-interval '60 seconds' then return false; end if;
  if t.remote_id is not null and t.observed_hash=t.desired_hash and t.effective_category=t.requested_category then
    update public.whatsapp_template_jobs set state='done',error_code='existing_template',finished_at=v_now where id=j.id;
    return false;
  end if;
  -- Durable evidence can authorize only this same job/target and one later prepare.
  select ra.id into v_authorization from app_private.whatsapp_template_revalidation_authorizations ra
    join app_private.whatsapp_template_zero_post_evidence e on e.id=ra.evidence_id
    where ra.job_id=j.id and ra.consumed_at is null and j.attempts=0 and j.provider_outcome is null
      and (ra.account_id,ra.target_template_id,ra.target_key,ra.target_hash,ra.job_revision,ra.binding_id,ra.binding_generation)
        is not distinct from (j.account_id,t.id,j.target_key,t.desired_hash,j.revision,j.binding_id,j.binding_generation)
      and (e.job_id,e.account_id,e.target_template_id,e.target_key,e.target_hash,e.job_revision,e.first_submission_attempted_at)
        is not distinct from (j.id,j.account_id,t.id,j.target_key,t.desired_hash,j.revision,t.submission_attempted_at);
  if t.remote_id is not null or t.remote_status<>'UNKNOWN' or t.observed_hash is not null
    or (t.submission_attempted_at is not null and v_authorization is null and not(j.attempts>0 and j.provider_outcome='rejected' and j.error_code='documented_preproxy_429'))
    or exists(select from public.whatsapp_template_jobs other where other.account_id=j.account_id and other.operation='provision'
      and other.target_key=j.target_key and other.id<>j.id and (other.posting_started_at is not null or other.provider_outcome is not null)) then
    update public.whatsapp_template_jobs set state='needs_review',error_code='submission_history_protected' where id=j.id; return false;
  end if;
  if b.submission_authorized_at is null or b.provider<>'datafy' or not exists(select from public.platform_flags where key='whatsapp_template_catalog' and value='true'::jsonb)
    or c.status<>'connected' or c.last_health_check_at is null or c.last_health_check_at<v_now-interval '5 minutes' then
    update public.whatsapp_template_jobs set state='paused',error_code='submission_paused' where id=j.id; return false;
  end if;
  if not app_private.whatsapp_template_submission_gate(p_job_id,p_fence,p_generation,p_payload_hash) then return false; end if;
  if v_authorization is not null then
    update app_private.whatsapp_template_revalidation_authorizations set consumed_at=v_now,consumed_claim_token=p_fence where id=v_authorization and consumed_at is null;
    if not found then raise exception 'template_management_authorization_consumed' using errcode='PT409'; end if;
  end if;
  update public.whatsapp_remote_templates set submission_attempted_at=coalesce(submission_attempted_at,v_now),local_status='submitting' where id=t.id;
  update public.whatsapp_template_jobs set state='posting',post_capture_id=a.sync_capture_id,posting_started_at=v_now,claimed_until=v_now+interval '90 seconds',attempts=attempts+1 where id=j.id and claim_token=p_fence;
  return true;
end $$;
revoke all on function public.prepare_whatsapp_template_provision(uuid,uuid,bigint,text) from public,anon,authenticated,service_role;
grant execute on function public.prepare_whatsapp_template_provision(uuid,uuid,bigint,text) to service_role;
create or replace function public.confirm_whatsapp_template_post(p_job_id uuid,p_fence uuid,p_generation bigint,p_payload_hash text)
returns boolean language plpgsql security definer set search_path='' as $$
declare j public.whatsapp_template_jobs%rowtype; a public.whatsapp_template_accounts%rowtype;
  b public.whatsapp_template_bindings%rowtype; c public.whatsapp_channels%rowtype;
  gb public.whatsapp_template_bindings%rowtype; gc public.whatsapp_channels%rowtype;
  t public.whatsapp_remote_templates%rowtype; v_now timestamptz;
begin
  select * into j from public.whatsapp_template_jobs where id=p_job_id;
  if not found then return false; end if;
  select * into a from public.whatsapp_template_accounts where id=j.account_id for share;
  -- All bindings before all channels, stable UUID ordering for a shared WABA.
  perform 1 from public.whatsapp_template_bindings where id in(j.binding_id,a.sync_binding_id) order by id for share;
  select * into b from public.whatsapp_template_bindings where id=j.binding_id;
  select * into gb from public.whatsapp_template_bindings where id=a.sync_binding_id;
  perform 1 from public.whatsapp_channels where id in(b.channel_id,gb.channel_id) order by id for share;
  select * into c from public.whatsapp_channels where id=b.channel_id;
  select * into gc from public.whatsapp_channels where id=gb.channel_id;
  perform 1 from public.whatsapp_remote_templates where account_id=a.id order by id for share;
  select * into t from public.whatsapp_remote_templates where account_id=a.id and logical_id=j.target_key and version=1 and language='pt_BR';
  select * into j from public.whatsapp_template_jobs where id=p_job_id for share;
  v_now:=clock_timestamp();
  if j.state<>'posting' or j.claim_token is distinct from p_fence or j.claimed_until<=v_now or j.posting_started_at is null
    or j.post_capture_id is null or j.post_capture_id is distinct from a.sync_capture_id or j.operation<>'provision' or j.attempts<1
    or b.id is null or c.id is null or gb.id is null or gc.id is null or t.id is null or a.last_sync_published_at is null then return false; end if;
  if (b.account_id,b.generation) is distinct from (j.account_id,j.binding_generation) or p_generation is distinct from b.generation
    or b.verified_at is null or b.submission_authorized_at is null or b.provider<>'datafy'
    or b.channel_credential_revision is distinct from c.template_credential_revision or (b.unit_id,b.provider) is distinct from (c.unit_id,c.provider)
    or c.status<>'connected' or c.last_health_check_at is null or c.last_health_check_at<v_now-interval '5 minutes' then return false; end if;
  if gb.account_id is distinct from a.id or gb.verified_at is null or gb.generation is distinct from a.sync_binding_generation
    or gb.channel_credential_revision is distinct from a.sync_credential_revision or gc.template_credential_revision is distinct from a.sync_credential_revision
    or (gb.unit_id,gb.provider) is distinct from (gc.unit_id,gc.provider) or gc.status<>'connected' then return false; end if;
  if t.name<>t.logical_id or t.logical_id not in('res_confirmacao_v1','res_confirmacao_desconto_v1','res_lembrete_dia_v1','res_pesquisa_reserva_v1','fila_entrada_v1','fila_feedback_v1','mkt_voucher_programado_v1','fila_mesa_pronta_v1','res_cancelada_v1')
    or t.binding_generation<>a.binding_generation or t.last_synced_at is null or t.last_synced_at<v_now-interval '60 seconds'
    or t.remote_id is not null or t.remote_status<>'UNKNOWN' or t.observed_hash is not null or t.submission_attempted_at is null
    or exists(select from public.whatsapp_remote_templates where account_id=a.id and sync_required)
    or not exists(select from public.platform_flags where key='whatsapp_template_catalog' and value='true'::jsonb) then return false; end if;
  if not app_private.whatsapp_template_submission_gate(p_job_id,p_fence,p_generation,p_payload_hash) then return false; end if;
  return true;
end $$;
revoke all on function public.confirm_whatsapp_template_post(uuid,uuid,bigint,text) from public,anon,authenticated,service_role;
grant execute on function public.confirm_whatsapp_template_post(uuid,uuid,bigint,text) to service_role;

create or replace function public.check_whatsapp_template_submission(p_job_id uuid,p_fence uuid,p_generation bigint,p_payload_hash text)
returns boolean language sql security definer set search_path = '' as $$
  select public.confirm_whatsapp_template_post(p_job_id,p_fence,p_generation,p_payload_hash)
$$;
revoke all on function public.check_whatsapp_template_submission(uuid,uuid,bigint,text) from public,anon,authenticated,service_role;
grant execute on function public.check_whatsapp_template_submission(uuid,uuid,bigint,text) to service_role;

notify pgrst, 'reload schema';
commit;
