-- Fase 2 (Datafy migração loja em produção): catálogo oficial passa de 7 para 9
-- modelos e o ledger de automação aceita os kinds `cancellation` e
-- `waitlist_table_ready`.
--
-- O que muda:
--   * CHECKs (localizados por relação, colunas e expressão, nunca pelo nome
--     gerado; re-execução deixa exatamente um de cada):
--       - whatsapp_remote_templates.logical_id: + fila_mesa_pronta_v1, res_cancelada_v1;
--       - whatsapp_automation_jobs.kind: + cancellation, waitlist_table_ready;
--       - kind<->recurso: cancellation exige reservation_id, waitlist_table_ready exige waitlist_id;
--       - whatsapp_automation_pin_tuple_check: initial_catalog_key com os 9 ids.
--   * Funções (corpo copiado da ÚLTIMA definição, só os trechos citados mudam):
--       - enqueue_whatsapp_automation: kind<->recurso e CASE kind->template;
--       - app_private.whatsapp_automation_post_core: CASE; snapshot de reserva
--         espera 'cancelled' só para cancellation (sem checagem de pagamento);
--         reservation_past também para cancellation; mesa pronta exige fila
--         waiting/notified sem seated_at; cliente nulo aceito para
--         waitlist_table_ready como para waitlist_entered; chave de setting
--         nula nos dois kinds; categoria UTILITY (ramo não promocional, inalterado);
--       - app_private.change_whatsapp_automation_pins, guard_whatsapp_template_scope: CASE;
--       - confirm_whatsapp_template_post, revalidate_whatsapp_template_job,
--         prepare_whatsapp_template_provision: lista de ids;
--       - reconcile_whatsapp_automation_acceptance: cliente nulo também para waitlist_table_ready;
--       - block_whatsapp_automation_preflight e get_whatsapp_automation_delivery_state:
--         motivo novo reservation_not_cancelled (sem ele o preflight TS do
--         cancelamento estouraria 22023 e o painel mostraria unknown_reason).
--     Ramos promocionais (waitlist_feedback/voucher_issued), a lista de motivos
--     corrigíveis de change_whatsapp_automation_pins, maintain_whatsapp_legacy_template
--     e notifications_sent_kind_check NÃO mudam.
--
-- ACL: todas as funções são `create or replace` com assinatura idêntica, o que
-- preserva o objeto e sua ACL (só drop+create reabre EXECUTE a PUBLIC). Os
-- revoke/grant da assinatura completa são repetidos mesmo assim, idênticos aos
-- da migration de origem de cada corpo.
--
-- Rollback: forward-only. Reverter exige migration nova que restaure os corpos
-- anteriores e estreite os CHECKs, o que falha se já houver linha com os ids ou
-- kinds novos (apagar/realocar essas linhas antes).
--
-- Ordem de deploy: `supabase db push` desta migration ANTES de qualquer Edge
-- Function que semeie o catálogo de 9 modelos ou enfileire os kinds novos.
-- Semear um id novo contra o CHECK antigo de logical_id falha a semeadura da
-- conta inteira.
--
-- BEGIN/COMMIT explícitos: os CHECKs e os corpos precisam entrar juntos.

begin;
-- ACCESS EXCLUSIVE nos CHECKs: falhar rápido em vez de enfileirar o worker atrás do DDL; repetir o push.
set local lock_timeout='5s';

-- Historical unnamed CHECKs are located by relation, sorted column set and expression.
-- Each DO block requires exactly ONE matching CHECK (the historical unnamed
-- one on first run, the named replacement on re-run), drops it and the named
-- replacement is added right after, so re-running leaves exactly one.
do $$ declare names text[]; begin
  select array_agg(c.conname::text order by c.conname) into names from pg_constraint c
  where c.conrelid='public.whatsapp_remote_templates'::regclass and c.contype='c'
    and (select array_agg(a.attname::text order by a.attname::text) from pg_attribute a where a.attrelid=c.conrelid and a.attnum=any(c.conkey))=array['logical_id']
    and pg_get_constraintdef(c.oid) like '%res_confirmacao_v1%';
  if coalesce(cardinality(names),0)<>1 then raise exception 'template_logical_id_constraint_ambiguous'; end if;
  execute format('alter table public.whatsapp_remote_templates drop constraint %I',names[1]);
end $$;
alter table public.whatsapp_remote_templates add constraint whatsapp_remote_templates_logical_id_check
  check(logical_id in('res_confirmacao_v1','res_confirmacao_desconto_v1','res_lembrete_dia_v1','res_pesquisa_reserva_v1','fila_entrada_v1','fila_feedback_v1','mkt_voucher_programado_v1','fila_mesa_pronta_v1','res_cancelada_v1'));

do $$ declare names text[]; begin
  select array_agg(c.conname::text order by c.conname) into names from pg_constraint c
  where c.conrelid='public.whatsapp_automation_jobs'::regclass and c.contype='c'
    and (select array_agg(a.attname::text order by a.attname::text) from pg_attribute a where a.attrelid=c.conrelid and a.attnum=any(c.conkey))=array['kind']
    and pg_get_constraintdef(c.oid) like '%voucher_issued%';
  if coalesce(cardinality(names),0)<>1 then raise exception 'automation_kind_constraint_ambiguous'; end if;
  execute format('alter table public.whatsapp_automation_jobs drop constraint %I',names[1]);
end $$;
alter table public.whatsapp_automation_jobs add constraint whatsapp_automation_jobs_kind_check
  check(kind in('confirmation','reminder_d1','survey_d1','waitlist_entered','waitlist_feedback','voucher_issued','cancellation','waitlist_table_ready'));

do $$ declare names text[]; begin
  select array_agg(c.conname::text order by c.conname) into names from pg_constraint c
  where c.conrelid='public.whatsapp_automation_jobs'::regclass and c.contype='c'
    and (select array_agg(a.attname::text order by a.attname::text) from pg_attribute a where a.attrelid=c.conrelid and a.attnum=any(c.conkey))=array['kind','reservation_id','voucher_id','waitlist_id']
    and pg_get_constraintdef(c.oid) like '%voucher_issued%';
  if coalesce(cardinality(names),0)<>1 then raise exception 'automation_kind_resource_constraint_ambiguous'; end if;
  execute format('alter table public.whatsapp_automation_jobs drop constraint %I',names[1]);
end $$;
alter table public.whatsapp_automation_jobs add constraint whatsapp_automation_jobs_kind_resource_check
  check((kind in('confirmation','reminder_d1','survey_d1','cancellation') and reservation_id is not null) or (kind in('waitlist_entered','waitlist_feedback','waitlist_table_ready') and waitlist_id is not null) or (kind='voucher_issued' and voucher_id is not null));

-- Named since 20261004184738; recreated with the same body and the 9 ids.
alter table public.whatsapp_automation_jobs drop constraint if exists whatsapp_automation_pin_tuple_check;
alter table public.whatsapp_automation_jobs add constraint whatsapp_automation_pin_tuple_check check ((
  (initial_credential_revision is null or initial_credential_revision>=0)
  and (initial_catalog_key is null or initial_catalog_key in('res_confirmacao_v1','res_confirmacao_desconto_v1','res_lembrete_dia_v1','res_pesquisa_reserva_v1','fila_entrada_v1','fila_feedback_v1','mkt_voucher_programado_v1','fila_mesa_pronta_v1','res_cancelada_v1'))
  and (
    (pin_phase='bound' and channel_id is not null and provider is not null and binding_id is not null and binding_generation is not null and binding_generation>0 and transport is not null and (
      (transport='template' and provider in('official','datafy') and account_id is not null and remote_template_id is not null and template_version is not null and sync_epoch is not null)
      or (transport='text' and provider in('zapi','waha','uazapi') and num_nonnulls(account_id,remote_template_id,template_version,sync_epoch)=0)))
    or (pin_phase='preconfiguration' and initial_catalog_key is not null and remote_template_id is null and template_version is null and sync_epoch is null and (
      (num_nonnulls(channel_id,provider,transport,binding_id,binding_generation,account_id,initial_credential_revision)=0)
      or (channel_id is not null and provider is not null and transport is not null and initial_credential_revision is not null and binding_id is null and binding_generation is null and account_id is null and (
        (provider in('official','datafy') and transport='template') or (provider in('zapi','waha','uazapi') and transport='text')))
      or (channel_id is not null and provider in('official','datafy') and transport='template' and binding_id is not null and binding_generation is not null and binding_generation>0 and account_id is not null and initial_credential_revision is not null))))
) is true);

-- enqueue_whatsapp_automation: latest definition 20261004184738:76.
create or replace function public.enqueue_whatsapp_automation(p_intent jsonb)
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
revoke all on function public.enqueue_whatsapp_automation(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.enqueue_whatsapp_automation(jsonb) to service_role;

-- block_whatsapp_automation_preflight: latest definition 20261009135808:287.
create or replace function public.block_whatsapp_automation_preflight(p_job_id uuid,p_fence uuid,p_reason text)
returns boolean language plpgsql security definer set search_path='' as $$
declare j public.whatsapp_automation_jobs%rowtype; v_now timestamptz; v_reason text; begin
  if p_reason is null or p_reason not in('reservation_pending','payment_incompatible','reservation_not_confirmed','reservation_not_cancelled','reservation_changed','reservation_past','reservation_wrong_day','survey_already_answered','waitlist_not_waiting','waitlist_not_seated','waitlist_wrong_day','waitlist_changed','voucher_not_active','voucher_expired','voucher_changed','customer_not_alive','recipient_changed','do_not_contact','invalid_timezone','service_suspended','channel_unavailable','channel_changed','binding_changed','dispatch_paused','consent_changed','cost_not_authorized','template_unavailable','template_sync_failed','render_invalid','dependency_unavailable','expired') then raise exception 'automation_preflight_reason_invalid' using errcode='22023'; end if;
  select * into j from public.whatsapp_automation_jobs where id=p_job_id for update;
  v_now:=clock_timestamp();
  if not found or j.pin_phase<>'bound' or j.state<>'claimed' or p_fence is null or j.claim_token is distinct from p_fence or j.claimed_until is null or j.claimed_until<=v_now or j.posting_started_at is not null or j.provider_message_id is not null or j.customer_erased_at is not null then return false; end if;
  v_reason:=case when v_now>j.expires_at then 'expired' else p_reason end;
  update public.whatsapp_automation_jobs set
    state=case when v_reason='expired' then 'expired' when v_reason='dispatch_paused' then 'paused' when v_reason in('reservation_changed','waitlist_changed','voucher_changed','recipient_changed','channel_changed','binding_changed') then 'needs_review' else 'blocked' end,
    error_code=v_reason,claim_token=null,claimed_until=null,safe_log_body=null,
    finished_at=case when v_reason='expired' then coalesce(finished_at,v_now) else finished_at end
  where id=j.id;
  return true;
end $$;
revoke all on function public.block_whatsapp_automation_preflight(uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.block_whatsapp_automation_preflight(uuid,uuid,text) to service_role;

-- get_whatsapp_automation_delivery_state: latest definition 20261009135808:230.
create or replace function public.get_whatsapp_automation_delivery_state(p_unit_id uuid,p_limit integer,p_offset integer)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_limit integer; v_offset integer; v_result jsonb; v_invalid boolean;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null or p_unit_id is null
    or not exists(select from public.units where id=p_unit_id)
    or not (app_private.is_unit_member(auth.uid(),p_unit_id) or app_private.is_platform_admin(auth.uid())) then
    raise exception 'automation_delivery_forbidden' using errcode='42501';
  end if;
  v_limit:=greatest(1,least(coalesce(p_limit,50),100)); v_offset:=greatest(0,coalesce(p_offset,0));
  with base as materialized (
    select j.*,exists(select from public.whatsapp_automation_receipt_events e where e.processing_state='pending'
      and (e.unit_id,e.provider,e.channel_id,e.provider_message_id)=(j.unit_id,j.provider,j.channel_id,j.provider_message_id)) as has_pending_receipt
    from public.whatsapp_automation_jobs j where j.unit_id=p_unit_id
  ), classified as materialized (
    select b.*,not coalesce((not b.reconcile_required and not b.has_pending_receipt and (
      (b.state='expired' and b.posting_started_at is null and b.provider_message_id is null)
      or (b.state='rejected' and b.provider_message_id is null)
      or (b.state='reconciled' and b.pin_phase='bound' and b.posting_started_at is not null and b.provider_message_id is not null
        and b.claim_token is not null and b.finished_at is not null and isfinite(b.finished_at)))),false) as outstanding
    from base b
  ), states as (
    select unnest(array['queued','claimed','posting','accepted','blocked','expired','uncertain','retry_wait','needs_review','failed','reconciled','paused','rejected']) as state
  ), state_counts as (
    select s.state,(select count(*) from classified c where c.state=s.state) as n from states s
  ), totals as (
    select count(*) as total,count(*) filter(where outstanding) as outstanding,min(created_at) filter(where outstanding) as oldest,
      coalesce(bool_or(created_at is null or expires_at is null or not isfinite(created_at) or not isfinite(expires_at)),false) as invalid from classified
  ), page as materialized (
    select * from classified order by outstanding desc,created_at desc,id desc offset v_offset limit v_limit+1
  ), shown as (select * from page order by outstanding desc,created_at desc,id desc limit v_limit)
  select jsonb_build_object('version',1,'generated_at',statement_timestamp(),
      'counts',(select jsonb_object_agg(state,n) from state_counts)||jsonb_build_object('total',t.total,'outstanding',t.outstanding),
      'oldest_nonterminal_at',t.oldest,'has_more',(select count(*)>v_limit from page),
      'rows',coalesce((select jsonb_agg(jsonb_build_object(
        'job_id',s.id,'kind',s.kind,'state',s.state,'pin_phase',s.pin_phase,
        'reason',case when s.error_code is null then null when s.error_code=any(array[
          'channel_unconfigured','binding_unconfigured','template_unconfigured','reservation_pending','payment_incompatible','reservation_not_confirmed','reservation_not_cancelled',
          'reservation_changed','reservation_past','reservation_wrong_day','survey_already_answered','waitlist_not_waiting','waitlist_not_seated',
          'waitlist_wrong_day','waitlist_changed','voucher_not_active','voucher_expired','voucher_changed','customer_not_alive','recipient_changed',
          'do_not_contact','invalid_timezone','service_suspended','channel_unavailable','channel_changed','binding_changed','dispatch_paused',
          'consent_changed','cost_not_authorized','template_unavailable','template_sync_failed','render_invalid','render_missing','promotion_frequency',
          'dependency_unavailable','expired','final_service_suspended','final_channel_changed','final_consent_changed','final_resource_changed',
          'final_gate_paused','post_lease_expired','post_ambiguous','response_invalid','documented_preproxy_429','provider_rejected','auth_rejected','template_rejected'
        ]) then s.error_code else 'unknown_reason' end,
        'created_at',s.created_at,'expires_at',s.expires_at,'finished_at',case when isfinite(s.finished_at) then s.finished_at else null end,
        'reconcile_required',s.reconcile_required,'has_pending_receipt',s.has_pending_receipt,'outstanding',s.outstanding,
        'reservation_id',s.reservation_id,'waitlist_id',s.waitlist_id,'voucher_id',s.voucher_id
      ) order by s.outstanding desc,s.created_at desc,s.id desc) from shown s),'[]'::jsonb)),
      t.invalid or t.total>9007199254740991 or t.outstanding>9007199254740991 into v_result,v_invalid from totals t;
  if v_invalid then raise exception 'automation_delivery_dependency_unavailable' using errcode='P0A17'; end if;
  return v_result;
end $$;
revoke all on function public.get_whatsapp_automation_delivery_state(uuid,integer,integer) from public,anon,authenticated,service_role;
grant execute on function public.get_whatsapp_automation_delivery_state(uuid,integer,integer) to authenticated;

-- app_private.whatsapp_automation_post_core: latest definition 20261009135808:306.
create or replace function app_private.whatsapp_automation_post_core(p_job_id uuid,p_fence uuid,p_generation bigint,p_consent_revision bigint,p_sync_epoch bigint,p_confirm_only boolean,p_expected jsonb)
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
        or j.kind='waitlist_table_ready' and (e_wait.status is distinct from 'waiting' and e_wait.status is distinct from 'notified' or e_wait.seated_at is not null)
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
revoke all on function app_private.whatsapp_automation_post_core(uuid,uuid,bigint,bigint,bigint,boolean,jsonb) from public,anon,authenticated,service_role;

-- reconcile_whatsapp_automation_acceptance: latest definition 20261005145913:4.
create or replace function public.reconcile_whatsapp_automation_acceptance(p_job_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  j public.whatsapp_automation_jobs%rowtype;
  c public.customers%rowtype;
  v_customer uuid;
  v_unit uuid;
  v_fence uuid;
  v_conversation uuid;
  v_notification uuid;
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
  insert into public.notifications_sent(id,unit_id,reservation_id,waitlist_id,kind,status,sent_at,
    whatsapp_provider,whatsapp_channel_id,provider_message_id)
    values(j.notification_id,j.unit_id,j.reservation_id,j.waitlist_id,j.kind,'sent',j.finished_at,
      j.provider,j.channel_id,j.provider_message_id)
    on conflict do nothing;
  -- Exact frozen UUID plus resource and all four correlation fields. This also
  -- refuses a legacy natural-key conflict without overwriting or deleting it.
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
revoke all on function public.reconcile_whatsapp_automation_acceptance(uuid) from public,anon,authenticated,service_role;
grant execute on function public.reconcile_whatsapp_automation_acceptance(uuid) to service_role;

-- confirm_whatsapp_template_post: latest definition 20261004025039:415.
create or replace function public.confirm_whatsapp_template_post(p_job_id uuid,p_fence uuid,p_generation bigint)
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
  return true;
end $$;
revoke all on function public.confirm_whatsapp_template_post(uuid,uuid,bigint) from public,anon,authenticated,service_role;
grant execute on function public.confirm_whatsapp_template_post(uuid,uuid,bigint) to service_role;

-- app_private.change_whatsapp_automation_pins: latest definition 20261009153435:232.
create or replace function app_private.change_whatsapp_automation_pins(p_job_id uuid,p_expected_channel_id uuid,p_expected_binding_generation bigint,p_initialize boolean)
returns boolean language plpgsql security definer set search_path='' as $$
declare j public.whatsapp_automation_jobs%rowtype; initial_j public.whatsapp_automation_jobs%rowtype;
  b public.whatsapp_template_bindings%rowtype; ch public.whatsapp_channels%rowtype; t public.whatsapp_remote_templates%rowtype;
  old_t public.whatsapp_remote_templates%rowtype; s public.whatsapp_promotion_slots%rowtype;
  v_binding uuid; v_account uuid; v_channel uuid; v_template uuid; v_org uuid; v_unit uuid; v_customer uuid;
  v_invalid boolean; v_logical text; v_transport text; v_now timestamptz; n integer;
  before_pins app_private.whatsapp_automation_pin_tuple; after_pins app_private.whatsapp_automation_pin_tuple;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null then raise exception 'template_management_forbidden' using errcode='42501'; end if;
  select * into initial_j from public.whatsapp_automation_jobs where id=p_job_id;
  perform app_private.require_whatsapp_template_manager(initial_j.unit_id,p_initialize);
  if initial_j.id is null then raise exception 'template_management_forbidden' using errcode='42501'; end if;
  select organization_id into v_org from public.units where id=initial_j.unit_id;
  if v_org is distinct from initial_j.organization_id then raise exception 'template_management_forbidden' using errcode='42501'; end if;
  if initial_j.customer_id is not null then
    perform 1 from public.customers where id=initial_j.customer_id and organization_id=v_org and deleted_at is null for update;
    if not found then raise exception 'template_management_forbidden' using errcode='42501'; end if;
  end if;
  select id into v_channel from public.whatsapp_channels c where c.unit_id=initial_j.unit_id and (c.is_active=true or (c.is_active is null and c.status='connected' and not exists(select from public.whatsapp_channels x where x.unit_id=c.unit_id and x.is_active=true))) order by c.is_active desc nulls last,c.created_at,c.id limit 1;
  if v_channel is null or v_channel is distinct from p_expected_channel_id then raise exception 'template_configuration_changed' using errcode='PT409'; end if;
  select id,account_id into v_binding,v_account from public.whatsapp_template_bindings where channel_id=v_channel;
  if v_binding is null then return false; end if;
  -- Every old/new parent is discovered before locks and ordered by class/UUID.
  perform 1 from public.whatsapp_template_accounts where id in(initial_j.account_id,v_account) order by id for share;
  if v_account is not null and not exists(select from public.whatsapp_template_accounts where id=v_account and organization_id=v_org) then raise exception 'template_management_forbidden' using errcode='42501'; end if;
  if initial_j.account_id is not null and not exists(select from public.whatsapp_template_accounts where id=initial_j.account_id and organization_id=v_org) then return false; end if;
  perform 1 from public.whatsapp_template_bindings where id in(initial_j.binding_id,v_binding) order by id for share;
  if initial_j.binding_id is not null and not exists(select from public.whatsapp_template_bindings where id=initial_j.binding_id and unit_id=initial_j.unit_id) then return false; end if;
  select * into b from public.whatsapp_template_bindings where id=v_binding;
  if (b.account_id,b.channel_id,b.unit_id) is distinct from (v_account,v_channel,initial_j.unit_id) then raise exception 'template_configuration_changed' using errcode='PT409'; end if;
  perform 1 from public.whatsapp_channels where id in(initial_j.channel_id,v_channel) order by id for share;
  if initial_j.channel_id is not null and not exists(select from public.whatsapp_channels where id=initial_j.channel_id and unit_id=initial_j.unit_id) then return false; end if;
  select * into ch from public.whatsapp_channels where id=v_channel;
  if ch.id is null or (ch.unit_id,ch.provider,ch.template_credential_revision) is distinct from (b.unit_id,b.provider,b.channel_credential_revision)
    or p_expected_binding_generation is null or b.generation is distinct from p_expected_binding_generation then raise exception 'template_configuration_changed' using errcode='PT409'; end if;
  v_transport:=case when ch.provider='datafy' then 'template' when ch.provider in('zapi','waha','uazapi') then 'text' end;
  if v_transport is null or b.verified_at is null or not b.dispatch_enabled or b.adopted_at is null then return false; end if;
  if initial_j.reservation_id is not null then
    select unit_id,customer_id into v_unit,v_customer from public.reservations where id=initial_j.reservation_id;
  elsif initial_j.voucher_id is not null then
    select unit_id,customer_id into v_unit,v_customer from public.vouchers where id=initial_j.voucher_id;
  else
    select w.unit_id,c.id,(w.customer_id is not null and c.id is null) into v_unit,v_customer,v_invalid from public.waitlist w join public.units u on u.id=w.unit_id
      left join public.customers c on c.organization_id=u.organization_id and c.phone=public.normalize_br_phone(w.customer_phone) and (w.customer_id is null or c.id=w.customer_id) where w.id=initial_j.waitlist_id;
  end if;
  if v_invalid or (v_unit,v_customer) is distinct from (initial_j.unit_id,initial_j.customer_id) then raise exception 'template_management_forbidden' using errcode='42501'; end if;
  v_logical:=case initial_j.kind when 'confirmation' then case when (select applied_discount_percent>0 from public.reservations where id=initial_j.reservation_id) then 'res_confirmacao_desconto_v1' else 'res_confirmacao_v1' end
    when 'reminder_d1' then 'res_lembrete_dia_v1' when 'survey_d1' then 'res_pesquisa_reserva_v1' when 'waitlist_entered' then 'fila_entrada_v1' when 'waitlist_feedback' then 'fila_feedback_v1' when 'voucher_issued' then 'mkt_voucher_programado_v1' when 'cancellation' then 'res_cancelada_v1' when 'waitlist_table_ready' then 'fila_mesa_pronta_v1' end;
  if initial_j.initial_catalog_key is not null and initial_j.initial_catalog_key is distinct from v_logical then return false; end if;
  if v_transport='template' then select id into v_template from public.whatsapp_remote_templates where account_id=v_account and logical_id=v_logical and version=1 and language='pt_BR'; end if;
  perform 1 from public.whatsapp_remote_templates where id in(initial_j.remote_template_id,v_template) order by id for share;
  select * into t from public.whatsapp_remote_templates where id=v_template;
  select * into old_t from public.whatsapp_remote_templates where id=initial_j.remote_template_id;
  if v_transport='template' and (t.id is null or (t.account_id,t.logical_id,t.version,t.language) is distinct from (v_account,v_logical,1,'pt_BR')) then return false; end if;
  if initial_j.remote_template_id is not null and (old_t.id is null or old_t.logical_id is distinct from v_logical or old_t.version<>1) then return false; end if;
  perform 1 from public.whatsapp_message_consent_events where unit_id=initial_j.unit_id and customer_id=initial_j.customer_id order by id for share;
  select * into s from public.whatsapp_promotion_slots where unit_id=initial_j.unit_id and customer_id=initial_j.customer_id for update;
  if initial_j.cost_authorization_id is not null then perform 1 from public.whatsapp_template_cost_authorizations where id=initial_j.cost_authorization_id for share; end if;
  select * into j from public.whatsapp_automation_jobs where id=p_job_id for update;
  v_now:=clock_timestamp();
  if not found or to_jsonb(j) is distinct from to_jsonb(initial_j) then raise exception 'template_configuration_changed' using errcode='PT409'; end if;
  if not exists(select from public.units where id=j.unit_id and organization_id=v_org) then raise exception 'template_management_forbidden' using errcode='42501'; end if;
  -- Repeat resource identity without acquiring an earlier lock after job.
  if j.reservation_id is not null then select unit_id,customer_id into v_unit,v_customer from public.reservations where id=j.reservation_id;
  elsif j.voucher_id is not null then select unit_id,customer_id into v_unit,v_customer from public.vouchers where id=j.voucher_id;
  else select w.unit_id,c.id,(w.customer_id is not null and c.id is null) into v_unit,v_customer,v_invalid from public.waitlist w join public.units u on u.id=w.unit_id
    left join public.customers c on c.organization_id=u.organization_id and c.phone=public.normalize_br_phone(w.customer_phone) and (w.customer_id is null or c.id=w.customer_id) where w.id=j.waitlist_id; end if;
  if v_invalid or (v_unit,v_customer) is distinct from (j.unit_id,j.customer_id) then raise exception 'template_management_forbidden' using errcode='42501'; end if;
  if v_channel is distinct from (select id from public.whatsapp_channels c where c.unit_id=j.unit_id and (c.is_active=true or (c.is_active is null and c.status='connected' and not exists(select from public.whatsapp_channels x where x.unit_id=c.unit_id and x.is_active=true))) order by c.is_active desc nulls last,c.created_at,c.id limit 1) then raise exception 'template_configuration_changed' using errcode='PT409'; end if;
  if j.customer_erased_at is not null or j.posting_started_at is not null or j.provider_message_id is not null or j.reconcile_required
    or j.expires_at<v_now or j.finished_at is not null or j.attempts>=5 or (j.claimed_until is not null and j.claimed_until>v_now) then return false; end if;
  if ch.status<>'connected' or ch.last_health_check_at is null or ch.last_health_check_at<v_now-interval '5 minutes'
    or (ch.provider in('zapi','waha','uazapi') and (ch.webhook_secret is null or btrim(ch.webhook_secret)='')) then return false; end if;
  before_pins:=row(j.pin_phase,j.channel_id,j.provider,j.binding_id,j.binding_generation,j.transport,j.account_id,j.remote_template_id,j.template_version,j.sync_epoch,j.initial_credential_revision,j.initial_catalog_key)::app_private.whatsapp_automation_pin_tuple;
  after_pins:=row('bound',ch.id,ch.provider,b.id,b.generation,v_transport,b.account_id,t.id,t.version,t.sync_epoch,
    case when p_initialize then coalesce(j.initial_credential_revision,ch.template_credential_revision) else j.initial_credential_revision end,
    j.initial_catalog_key)::app_private.whatsapp_automation_pin_tuple;
  if p_initialize then
    if j.pin_phase<>'preconfiguration' or j.state not in('blocked','paused','needs_review') or j.attempts<>0 then return false; end if;
    -- Known historical values are immutable, even when the current setup changed.
    if (j.channel_id is not null and j.channel_id is distinct from ch.id) or (j.provider is not null and j.provider is distinct from ch.provider)
      or (j.binding_id is not null and j.binding_id is distinct from b.id) or (j.binding_generation is not null and j.binding_generation is distinct from b.generation)
      or (j.transport is not null and j.transport is distinct from v_transport) or (j.account_id is not null and j.account_id is distinct from b.account_id)
      or (j.initial_credential_revision is not null and j.initial_credential_revision is distinct from ch.template_credential_revision) then return false; end if;
    insert into app_private.whatsapp_automation_pin_initialization_permits values(txid_current(),auth.uid(),j.id,before_pins,after_pins);
  else
    if j.pin_phase<>'bound' or j.state not in('blocked','needs_review') or j.transport is distinct from v_transport
      or j.error_code is null or j.error_code not in('reservation_pending','payment_incompatible','reservation_not_confirmed','reservation_changed','reservation_past','reservation_wrong_day','survey_already_answered','waitlist_not_waiting','waitlist_not_seated','waitlist_wrong_day','waitlist_changed','voucher_not_active','voucher_expired','voucher_changed','recipient_changed','do_not_contact','invalid_timezone','service_suspended','channel_unavailable','channel_changed','binding_changed','consent_changed','cost_not_authorized','template_unavailable','template_sync_failed','render_invalid','render_missing','promotion_frequency','dependency_unavailable','final_service_suspended','final_channel_changed','final_consent_changed','final_resource_changed','final_gate_paused') then return false; end if;
    insert into app_private.whatsapp_automation_pin_revalidation_permits values(txid_current(),auth.uid(),j.id,before_pins,after_pins);
  end if;
  if s.id is not null and s.job_id=j.id then
    if s.state<>'reserved' or s.claim_token is distinct from j.claim_token then
      raise exception 'template_management_not_eligible' using errcode='PT409';
    end if;
    insert into app_private.whatsapp_promotion_slot_release_permits values(txid_current(),s.id);
    delete from public.whatsapp_promotion_slots where id=s.id;
  end if;
  update public.whatsapp_automation_jobs set pin_phase='bound',channel_id=ch.id,provider=ch.provider,binding_id=b.id,binding_generation=b.generation,
    transport=v_transport,account_id=b.account_id,remote_template_id=t.id,template_version=t.version,sync_epoch=t.sync_epoch,
    initial_credential_revision=after_pins.initial_credential_revision,state='queued',error_code=null,claim_token=null,claimed_until=null,safe_log_body=null,consent_revision=null,cost_authorization_id=null
    where id=j.id;
  get diagnostics n=row_count;
  if n<>1 or exists(select from app_private.whatsapp_automation_pin_initialization_permits where transaction_id=txid_current() and job_id=j.id)
    or exists(select from app_private.whatsapp_automation_pin_revalidation_permits where transaction_id=txid_current() and job_id=j.id) then raise exception 'template_management_permit_not_consumed'; end if;
  insert into public.audit_log(table_name,record_id,action,old_values,new_values,actor_id,unit_id,organization_id)
  values('whatsapp_automation_jobs',j.id::text,'UPDATE',to_jsonb(before_pins),jsonb_build_object('pins',to_jsonb(after_pins),'reason',case when p_initialize then 'initialize' else 'revalidate' end),auth.uid(),j.unit_id,j.organization_id);
  return true;
end $$;
revoke all on function app_private.change_whatsapp_automation_pins(uuid,uuid,bigint,boolean) from public,anon,authenticated,service_role;

-- revalidate_whatsapp_template_job: latest definition 20261009153435:415.
create or replace function public.revalidate_whatsapp_template_job(p_job_id uuid,p_expected_channel_id uuid,p_expected_binding_generation bigint)
returns boolean language plpgsql security definer set search_path='' as $$
declare j public.whatsapp_template_jobs%rowtype; prior public.whatsapp_template_jobs%rowtype;
  b public.whatsapp_template_bindings%rowtype; c public.whatsapp_channels%rowtype; t public.whatsapp_remote_templates%rowtype;
  e app_private.whatsapp_template_zero_post_evidence%rowtype; v_binding uuid; v_unit uuid; n integer;
begin
  perform app_private.require_whatsapp_template_manager(null,true);
  select * into prior from public.whatsapp_template_jobs where id=p_job_id;
  if not found then raise exception 'template_management_forbidden' using errcode='42501'; end if;
  select b0.id,b0.unit_id into v_binding,v_unit from public.whatsapp_template_bindings b0 join public.whatsapp_channels c0 on c0.id=b0.channel_id
    join public.units u on u.id=c0.unit_id where c0.id=p_expected_channel_id and b0.account_id=prior.account_id and u.organization_id=prior.organization_id and b0.unit_id=u.id;
  if not found then raise exception 'template_management_forbidden' using errcode='42501'; end if;
  perform 1 from public.whatsapp_template_accounts where id=prior.account_id and organization_id=prior.organization_id for share;
  if not found then raise exception 'template_management_forbidden' using errcode='42501'; end if;
  perform 1 from public.whatsapp_template_bindings where id in(prior.binding_id,v_binding) order by id for share;
  select * into b from public.whatsapp_template_bindings where id=v_binding;
  if b.account_id is distinct from prior.account_id or b.channel_id is distinct from p_expected_channel_id or b.unit_id is distinct from v_unit then raise exception 'template_configuration_changed' using errcode='PT409'; end if;
  select * into c from public.whatsapp_channels where id=p_expected_channel_id for share;
  select * into t from public.whatsapp_remote_templates where account_id=prior.account_id and logical_id=prior.target_key and version=1 and language='pt_BR' for share;
  select * into j from public.whatsapp_template_jobs where id=p_job_id for update;
  if not found or to_jsonb(j) is distinct from to_jsonb(prior) then raise exception 'template_configuration_changed' using errcode='PT409'; end if;
  if b.generation is distinct from p_expected_binding_generation or p_expected_binding_generation is null
    or (c.unit_id,c.provider,c.template_credential_revision) is distinct from (b.unit_id,b.provider,b.channel_credential_revision)
    or b.account_id is distinct from j.account_id or not exists(select from public.units where id=b.unit_id and organization_id=j.organization_id) then raise exception 'template_configuration_changed' using errcode='PT409'; end if;
  if c.provider<>'datafy' or c.status<>'connected' or c.last_health_check_at is null or c.last_health_check_at<clock_timestamp()-interval '5 minutes'
    or b.verified_at is null or b.submission_authorized_at is null or b.submission_authorized_by is null then return false; end if;
  if j.state not in('paused','needs_review') or j.operation<>'provision' or j.attempts<>0 or j.provider_outcome is not null
    or num_nonnulls(j.posting_started_at,j.post_capture_id,j.claim_token,j.claimed_until,j.finished_at)>0 or t.id is null
    or t.name<>t.logical_id or t.logical_id not in('res_confirmacao_v1','res_confirmacao_desconto_v1','res_lembrete_dia_v1','res_pesquisa_reserva_v1','fila_entrada_v1','fila_feedback_v1','mkt_voucher_programado_v1','fila_mesa_pronta_v1','res_cancelada_v1')
    or t.remote_id is not null or t.observed_hash is not null or t.remote_status<>'UNKNOWN' then return false; end if;
  select * into e from app_private.whatsapp_template_zero_post_evidence where job_id=j.id order by refused_at desc,id desc limit 1;
  if e.id is null or (e.account_id,e.target_key,e.target_template_id,e.target_hash,e.target_version,e.job_revision,e.first_submission_attempted_at,e.binding_id,e.binding_generation)
    is distinct from (j.account_id,j.target_key,t.id,t.desired_hash,1,j.revision,t.submission_attempted_at,j.binding_id,j.binding_generation)
    or exists(select from app_private.whatsapp_template_revalidation_authorizations where evidence_id=e.id or (job_id=j.id and consumed_at is null))
    or exists(select from public.whatsapp_template_jobs other where other.id<>j.id and other.account_id=j.account_id and other.target_key=j.target_key and other.operation='provision' and (other.posting_started_at is not null or other.provider_outcome is not null)) then return false; end if;
  insert into app_private.whatsapp_catalog_pin_revalidation_permits values(txid_current(),auth.uid(),j.id,row(j.binding_id,j.binding_generation)::app_private.whatsapp_catalog_pin_tuple,row(b.id,b.generation)::app_private.whatsapp_catalog_pin_tuple);
  update public.whatsapp_template_jobs set binding_id=b.id,binding_generation=b.generation,state='queued',error_code=null where id=j.id;
  get diagnostics n=row_count;
  if n<>1 or exists(select from app_private.whatsapp_catalog_pin_revalidation_permits where transaction_id=txid_current() and job_id=j.id) then raise exception 'template_management_permit_not_consumed'; end if;
  insert into app_private.whatsapp_template_revalidation_authorizations(evidence_id,job_id,account_id,target_template_id,target_key,target_hash,job_revision,binding_id,binding_generation,actor_id,authorized_at)
  values(e.id,j.id,j.account_id,t.id,j.target_key,t.desired_hash,j.revision,b.id,b.generation,auth.uid(),clock_timestamp());
  insert into public.audit_log(table_name,record_id,action,old_values,new_values,actor_id,unit_id,organization_id)
  values('whatsapp_template_jobs',j.id::text,'UPDATE',jsonb_build_object('binding_id',j.binding_id,'generation',j.binding_generation),jsonb_build_object('binding_id',b.id,'generation',b.generation,'reason','zero_post_correction'),auth.uid(),b.unit_id,j.organization_id);
  return true;
end $$;
revoke all on function public.revalidate_whatsapp_template_job(uuid,uuid,bigint) from public,anon,authenticated,service_role;
grant execute on function public.revalidate_whatsapp_template_job(uuid,uuid,bigint) to authenticated;

-- guard_whatsapp_template_scope: latest definition 20261009153435:464.
create or replace function public.guard_whatsapp_template_scope()
returns trigger language plpgsql security definer set search_path='' as $$
declare
  v_org uuid; v_customer_org uuid; v_deleted timestamptz;
  v_binding public.whatsapp_template_bindings%rowtype;
  v_channel public.whatsapp_channels%rowtype;
  v_remote public.whatsapp_remote_templates%rowtype;
  v_job public.whatsapp_automation_jobs%rowtype;
  v_resource_unit uuid; v_resource_customer uuid; v_resource_invalid boolean:=false; v_reset boolean:=false; v_erasure boolean:=false;
  v_initialize boolean:=false; v_revalidate boolean:=false; v_catalog_revalidate boolean:=false; v_exclusive_stop boolean:=false; v_logical text; v_selected uuid;
  old_pins app_private.whatsapp_automation_pin_tuple; new_pins app_private.whatsapp_automation_pin_tuple;
begin
  -- UPDATE already owns the job: never acquire earlier parent locks here.
  if tg_op='UPDATE' and tg_table_name='whatsapp_automation_jobs' then
    old_pins:=row(old.pin_phase,old.channel_id,old.provider,old.binding_id,old.binding_generation,old.transport,old.account_id,old.remote_template_id,old.template_version,old.sync_epoch,old.initial_credential_revision,old.initial_catalog_key)::app_private.whatsapp_automation_pin_tuple;
    new_pins:=row(new.pin_phase,new.channel_id,new.provider,new.binding_id,new.binding_generation,new.transport,new.account_id,new.remote_template_id,new.template_version,new.sync_epoch,new.initial_credential_revision,new.initial_catalog_key)::app_private.whatsapp_automation_pin_tuple;
    if old.pin_phase='bound' and exists(select from app_private.whatsapp_automation_pin_revalidation_permits where transaction_id=txid_current() and job_id=old.id) then
      if old.state not in('blocked','needs_review') or new.state<>'queued' or old.expires_at<clock_timestamp()
        or old.customer_erased_at is not null or old.reconcile_required or old.finished_at is not null
        or old.posting_started_at is not null or old.provider_message_id is not null or (old.claimed_until is not null and old.claimed_until>clock_timestamp())
        or num_nonnulls(new.claim_token,new.claimed_until,new.safe_log_body,new.consent_revision,new.cost_authorization_id,new.error_code)>0
        or (to_jsonb(new)-array['channel_id','provider','binding_id','binding_generation','account_id','remote_template_id','template_version','sync_epoch','state','error_code','claim_token','claimed_until','safe_log_body','consent_revision','cost_authorization_id'])
          is distinct from (to_jsonb(old)-array['channel_id','provider','binding_id','binding_generation','account_id','remote_template_id','template_version','sync_epoch','state','error_code','claim_token','claimed_until','safe_log_body','consent_revision','cost_authorization_id'])
        or not app_private.consume_whatsapp_automation_pin_revalidation(old.id,old_pins,new_pins) then raise exception 'automation_pin_revalidation_refused' using errcode='23514'; end if;
      v_revalidate:=true;
    end if;
    if new.pin_phase is distinct from old.pin_phase then
      if old.pin_phase<>'preconfiguration' or new.pin_phase<>'bound'
        or old.state not in('blocked','paused','needs_review') or new.state not in('queued','blocked','paused','needs_review')
        or old.customer_erased_at is not null or new.customer_id is distinct from old.customer_id or new.customer_erased_at is not null
        or old.expires_at<clock_timestamp() or new.attempts<>0 or old.attempts<>0 or new.due_at is distinct from old.due_at
        or num_nonnulls(old.claim_token,old.claimed_until,old.posting_started_at,old.provider_message_id,new.claim_token,new.claimed_until,new.posting_started_at,new.provider_message_id,new.safe_log_body,new.consent_revision,new.cost_authorization_id)>0
        or new.reconcile_required
        or (old.channel_id is not null and new.channel_id is distinct from old.channel_id)
        or (old.provider is not null and new.provider is distinct from old.provider)
        or (old.binding_id is not null and new.binding_id is distinct from old.binding_id)
        or (old.binding_generation is not null and new.binding_generation is distinct from old.binding_generation)
        or (old.transport is not null and new.transport is distinct from old.transport)
        or (old.account_id is not null and new.account_id is distinct from old.account_id)
        or (old.remote_template_id is not null and new.remote_template_id is distinct from old.remote_template_id)
        or (old.template_version is not null and new.template_version is distinct from old.template_version)
        or (old.sync_epoch is not null and new.sync_epoch is distinct from old.sync_epoch)
        or (old.initial_credential_revision is not null and new.initial_credential_revision is distinct from old.initial_credential_revision)
        or (old.initial_catalog_key is not null and new.initial_catalog_key is distinct from old.initial_catalog_key)
        or new.channel_id is null or new.provider is null or new.binding_id is null or new.binding_generation is null or new.transport is null or new.initial_catalog_key is null or new.initial_credential_revision is null
        or not app_private.consume_whatsapp_automation_pin_initialization(old.id,old_pins,new_pins)
      then raise exception 'automation_pin_initialization_refused' using errcode='23514'; end if;
      v_initialize:=true;
    elsif not v_revalidate and (new.pin_phase,new.channel_id,new.provider,new.binding_id,new.binding_generation,new.transport,new.account_id,new.remote_template_id,new.template_version,new.initial_credential_revision,new.initial_catalog_key)
      is distinct from (old.pin_phase,old.channel_id,old.provider,old.binding_id,old.binding_generation,old.transport,old.account_id,old.remote_template_id,old.template_version,old.initial_credential_revision,old.initial_catalog_key)
    then raise exception 'automation_intent_immutable' using errcode='23514'; end if;
    if (new.id,new.unit_id,new.organization_id,new.kind,new.reservation_id,new.waitlist_id,new.voucher_id,new.source_event_key,new.fact_at,new.expires_at,new.notification_id) is distinct from (old.id,old.unit_id,old.organization_id,old.kind,old.reservation_id,old.waitlist_id,old.voucher_id,old.source_event_key,old.fact_at,old.expires_at,old.notification_id) then raise exception 'automation_intent_immutable' using errcode='23514'; end if;
    if old.customer_id is not null and new.customer_id is null then
      select deleted_at into v_deleted from public.customers where id=old.customer_id;
      v_erasure:=not found or v_deleted is not null;
      if not v_erasure then raise exception 'customer_erasure_not_authorized' using errcode='23514'; end if;
      new.customer_erased_at:=clock_timestamp(); new.safe_log_body:=null;
      if old.state not in('posting','uncertain','accepted','reconciled') then new.state:='blocked'; new.error_code:='customer_not_alive'; end if;
    elsif new.customer_id is distinct from old.customer_id or new.customer_erased_at is distinct from old.customer_erased_at then raise exception 'customer_erasure_immutable' using errcode='23514'; end if;
    if old.customer_erased_at is not null and new.safe_log_body is not null then raise exception 'automation_erased_render_forbidden' using errcode='23514'; end if;
    if old.posting_started_at is not null and new.posting_started_at is distinct from old.posting_started_at then
      v_reset:=new.posting_started_at is null and old.state='posting' and old.provider_message_id is null and new.provider_message_id is null and (
        (new.state='retry_wait' and old.provider='datafy' and new.claim_token=old.claim_token and new.attempts=old.attempts) or
        (old.claimed_until>clock_timestamp() and ((new.state in('blocked','paused','needs_review') and new.error_code in('final_service_suspended','final_channel_changed','final_consent_changed','final_resource_changed','final_gate_paused')) or (old.customer_erased_at is not null and new.state='blocked' and new.error_code='customer_not_alive')) and new.claim_token is null and new.claimed_until is null and new.attempts=old.attempts-1)
      ) and app_private.consume_whatsapp_post_reset(tg_table_name,old.id,old.claim_token,old.attempts,old.posting_started_at);
      if not coalesce(v_reset,false) then raise exception 'automation_post_marker_immutable' using errcode='23514'; end if;
    end if;
    if not v_initialize and not v_revalidate and new.sync_epoch is distinct from old.sync_epoch then
      if old.posting_started_at is not null or new.sync_epoch<old.sync_epoch then raise exception 'automation_posted_epoch_immutable' using errcode='23514'; end if;
      perform 1 from public.whatsapp_remote_templates r join public.whatsapp_template_accounts a on a.id=r.account_id join public.whatsapp_template_bindings b on b.id=new.binding_id
        where r.id=new.remote_template_id and r.account_id=new.account_id and r.version=new.template_version and r.binding_generation=a.binding_generation
          and r.sync_epoch=new.sync_epoch and not r.sync_required and r.remote_status='APPROVED' and r.local_status='usable' and r.observed_hash=r.desired_hash
          and b.generation=new.binding_generation and (b.unit_id,b.channel_id,b.provider,b.account_id)=(new.unit_id,new.channel_id,new.provider,new.account_id);
      if not found then raise exception 'automation_epoch_snapshot_invalid' using errcode='23514'; end if;
    end if;
    if old.posting_started_at is not null and not v_reset and not v_erasure and new.safe_log_body is distinct from old.safe_log_body then raise exception 'automation_render_immutable' using errcode='23514'; end if;
    if old.posting_started_at is not null and not v_reset and (new.consent_revision,new.cost_authorization_id) is distinct from (old.consent_revision,old.cost_authorization_id) then raise exception 'automation_posted_authority_immutable' using errcode='23514'; end if;
    if old.provider_message_id is not null and new.provider_message_id is distinct from old.provider_message_id then raise exception 'automation_provider_identity_immutable' using errcode='23514'; end if;
    return new;
  end if;
  if tg_op='UPDATE' and tg_table_name='whatsapp_template_jobs' then
    if exists(select from app_private.whatsapp_catalog_pin_revalidation_permits where transaction_id=txid_current() and job_id=old.id) then
      if old.state not in('paused','needs_review') or new.state<>'queued' or old.attempts<>0 or old.provider_outcome is not null
        or num_nonnulls(old.posting_started_at,old.post_capture_id,old.claim_token,old.claimed_until,old.finished_at,new.error_code)>0
        or (to_jsonb(new)-array['binding_id','binding_generation','state','error_code']) is distinct from (to_jsonb(old)-array['binding_id','binding_generation','state','error_code'])
        or not app_private.consume_whatsapp_catalog_pin_revalidation(old.id,row(old.binding_id,old.binding_generation)::app_private.whatsapp_catalog_pin_tuple,row(new.binding_id,new.binding_generation)::app_private.whatsapp_catalog_pin_tuple)
        then raise exception 'template_pin_revalidation_refused' using errcode='23514'; end if;
      v_catalog_revalidate:=true;
    end if;
    if (new.id,new.organization_id,new.account_id,new.operation,new.target_key,new.revision) is distinct from (old.id,old.organization_id,old.account_id,old.operation,old.target_key,old.revision)
      or (not v_catalog_revalidate and (new.binding_id,new.binding_generation) is distinct from (old.binding_id,old.binding_generation)) then raise exception 'template_job_identity_immutable' using errcode='23514'; end if;
    if old.posting_started_at is not null and new.posting_started_at is distinct from old.posting_started_at then
      v_reset:=new.posting_started_at is null and old.state='posting' and old.provider_outcome is distinct from 'accepted' and (
        (new.state='queued' and new.provider_outcome='rejected' and new.claim_token=old.claim_token and new.attempts=old.attempts) or
        (old.claimed_until>clock_timestamp() and new.state in('paused','needs_review') and new.error_code in('final_service_suspended','final_channel_changed','final_gate_paused') and new.provider_outcome is null and new.claim_token is null and new.claimed_until is null and new.attempts=old.attempts-1)
      ) and app_private.consume_whatsapp_post_reset(tg_table_name,old.id,old.claim_token,old.attempts,old.posting_started_at);
      if not coalesce(v_reset,false) then raise exception 'template_post_marker_immutable' using errcode='23514'; end if;
    end if;
    if old.posting_started_at is not null then
      if (v_reset and new.post_capture_id is not null) or (not v_reset and new.post_capture_id is distinct from old.post_capture_id) then raise exception 'template_post_capture_immutable' using errcode='23514'; end if;
    elsif new.post_capture_id is distinct from old.post_capture_id then
      if old.state<>'claimed' or new.state<>'posting' or new.posting_started_at is null or new.post_capture_id is null or
        not exists(select from public.whatsapp_template_accounts where id=new.account_id and sync_capture_id=new.post_capture_id and last_sync_published_at is not null) then raise exception 'template_post_capture_invalid' using errcode='23514'; end if;
    end if;
    return new;
  end if;
  if tg_op='UPDATE' and tg_table_name='whatsapp_automation_receipt_events' then return new; end if;
  if tg_table_name='whatsapp_template_accounts' then
    if tg_op='UPDATE' and (new.id,new.organization_id,new.waba_id) is distinct from (old.id,old.organization_id,old.waba_id) then raise exception 'template_identity_immutable' using errcode='23514'; end if;
    if tg_op='UPDATE' and new.binding_generation<old.binding_generation then raise exception 'template_generation_regression' using errcode='23514'; end if;
    if tg_op='UPDATE' and new.reconciliation_revision<old.reconciliation_revision then raise exception 'template_reconciliation_revision_regression' using errcode='23514'; end if;
    return new;
  end if;
  if tg_table_name in('whatsapp_message_consent_events','whatsapp_message_preference_tokens','whatsapp_promotion_slots','whatsapp_automation_jobs') then
    if new.customer_id is not null then
      if tg_table_name='whatsapp_message_consent_events' then
        select organization_id,deleted_at into v_customer_org,v_deleted from public.customers where id=new.customer_id for update;
      else
        select organization_id,deleted_at into v_customer_org,v_deleted from public.customers where id=new.customer_id for share;
      end if;
      if not found or v_deleted is not null then raise exception 'customer_not_alive' using errcode='P0A15'; end if;
    end if;
    select organization_id into v_org from public.units where id=new.unit_id;
    if not found or (new.customer_id is not null and v_customer_org is distinct from v_org) then raise exception 'template_tenant_mismatch' using errcode='23514'; end if;
  end if;
  if tg_table_name='whatsapp_template_bindings' then
    if tg_op='UPDATE' and auth.role()='authenticated' and auth.uid() is not null and app_private.is_platform_admin(auth.uid()) then
      v_exclusive_stop:=(old.dispatch_enabled is true and new.dispatch_enabled is false
        and (to_jsonb(new)-'dispatch_enabled') is not distinct from (to_jsonb(old)-'dispatch_enabled'))
        or (old.submission_authorized_at is not null and old.submission_authorized_by is not null and new.submission_authorized_at is null and new.submission_authorized_by is null
        and (to_jsonb(new)-array['submission_authorized_at','submission_authorized_by']) is not distinct from (to_jsonb(old)-array['submission_authorized_at','submission_authorized_by']));
    end if;
    select organization_id into v_org from public.units where id=new.unit_id;
    if not found then raise exception 'template_tenant_mismatch' using errcode='23514'; end if;
    if new.account_id is not null then
      perform 1 from public.whatsapp_template_accounts where id=new.account_id and organization_id=v_org for share;
      if not found then raise exception 'template_tenant_mismatch' using errcode='23514'; end if;
    end if;
    select * into v_channel from public.whatsapp_channels where id=new.channel_id for share;
    if not found or v_channel.unit_id is distinct from new.unit_id or (not v_exclusive_stop and v_channel.provider is distinct from new.provider) then raise exception 'template_channel_mismatch' using errcode='23514'; end if;
    if tg_op='UPDATE' then
      if (new.id,new.unit_id,new.channel_id) is distinct from (old.id,old.unit_id,old.channel_id) then raise exception 'template_binding_identity_immutable' using errcode='23514'; end if;
      if new.generation<old.generation or ((new.provider,new.account_id) is distinct from (old.provider,old.account_id) and new.generation<=old.generation) then raise exception 'template_generation_regression' using errcode='23514'; end if;
      if old.adopted_at is not null and new.adopted_at is distinct from old.adopted_at then raise exception 'template_adoption_immutable' using errcode='23514'; end if;
    end if;
    if (tg_op='INSERT' and (new.adopted_at is not null or new.dispatch_enabled or new.submission_authorized_at is not null)) or
       (tg_op='UPDATE' and ((old.adopted_at is null and new.adopted_at is not null) or (not old.dispatch_enabled and new.dispatch_enabled) or (new.submission_authorized_at is not null and (new.submission_authorized_at,new.submission_authorized_by) is distinct from (old.submission_authorized_at,old.submission_authorized_by)))) then
      if auth.role() is distinct from 'authenticated' or auth.uid() is null or not app_private.is_platform_admin(auth.uid()) then raise exception 'template_admin_required' using errcode='42501'; end if;
      if new.submission_authorized_at is not null and (tg_op='INSERT' or (new.submission_authorized_at,new.submission_authorized_by) is distinct from (old.submission_authorized_at,old.submission_authorized_by)) then new.submission_authorized_by:=auth.uid(); new.submission_authorized_at:=clock_timestamp(); end if;
      if new.adopted_at is not null and (tg_op='INSERT' or old.adopted_at is null) then
        new.adopted_at:=now();
        insert into public.whatsapp_automation_adoptions(unit_id,adopted_at) values(new.unit_id,now()) on conflict(unit_id) do nothing;
      end if;
    end if;
  elsif tg_table_name='whatsapp_remote_templates' then
    if tg_op='UPDATE' and (new.id,new.account_id,new.logical_id,new.version,new.language,new.name,new.desired_hash,new.requested_category) is distinct from (old.id,old.account_id,old.logical_id,old.version,old.language,old.name,old.desired_hash,old.requested_category) then raise exception 'template_identity_immutable' using errcode='23514'; end if;
    if tg_op='UPDATE' and new.sync_epoch<old.sync_epoch then raise exception 'template_epoch_regression' using errcode='23514'; end if;
  elsif tg_table_name in('whatsapp_template_jobs','whatsapp_template_cost_authorizations') then
    select organization_id into v_org from public.whatsapp_template_accounts where id=new.account_id for share;
    if not found then raise exception 'template_tenant_mismatch' using errcode='23514'; end if;
    if tg_table_name='whatsapp_template_jobs' then
      if new.organization_id is not null and new.organization_id is distinct from v_org then raise exception 'template_tenant_mismatch' using errcode='23514'; end if;
      new.organization_id:=v_org;
    end if;
    select * into v_binding from public.whatsapp_template_bindings where id=new.binding_id for share;
    if not found or v_binding.account_id is distinct from new.account_id or (tg_op='INSERT' and v_binding.generation is distinct from new.binding_generation) then raise exception 'template_binding_mismatch' using errcode='23514'; end if;
    if tg_table_name='whatsapp_template_cost_authorizations' and tg_op='INSERT' then
      if auth.role() is distinct from 'authenticated' or auth.uid() is distinct from new.actor_id or not app_private.is_platform_admin(auth.uid()) then raise exception 'template_admin_required' using errcode='42501'; end if;
    end if;
  elsif tg_table_name='whatsapp_automation_jobs' then
    if new.organization_id is distinct from v_org then raise exception 'template_tenant_mismatch' using errcode='23514'; end if;
    if new.reservation_id is not null then select unit_id,customer_id into v_resource_unit,v_resource_customer from public.reservations where id=new.reservation_id;
    elsif new.waitlist_id is not null then
      select w.unit_id,c.id,(w.customer_id is not null and c.id is null) into v_resource_unit,v_resource_customer,v_resource_invalid from public.waitlist w
        join public.units u on u.id=w.unit_id left join public.customers c on c.organization_id=u.organization_id and c.phone=public.normalize_br_phone(w.customer_phone) and (w.customer_id is null or c.id=w.customer_id) where w.id=new.waitlist_id;
    elsif new.voucher_id is not null then select unit_id,customer_id into v_resource_unit,v_resource_customer from public.vouchers where id=new.voucher_id;
    end if;
    if v_resource_invalid or v_resource_unit is distinct from new.unit_id or v_resource_customer is distinct from new.customer_id then raise exception 'template_resource_mismatch' using errcode='23514'; end if;
    if tg_op='INSERT' and (new.customer_erased_at is not null or (new.customer_id is null and new.waitlist_id is null)) then raise exception 'template_resource_mismatch' using errcode='23514'; end if;
    v_logical:=case new.kind when 'confirmation' then case when (select applied_discount_percent>0 from public.reservations where id=new.reservation_id) then 'res_confirmacao_desconto_v1' else 'res_confirmacao_v1' end when 'reminder_d1' then 'res_lembrete_dia_v1' when 'survey_d1' then 'res_pesquisa_reserva_v1' when 'waitlist_entered' then 'fila_entrada_v1' when 'waitlist_feedback' then 'fila_feedback_v1' when 'voucher_issued' then 'mkt_voucher_programado_v1' when 'cancellation' then 'res_cancelada_v1' when 'waitlist_table_ready' then 'fila_mesa_pronta_v1' end;
    new.initial_catalog_key:=v_logical;
    if new.pin_phase='preconfiguration' then
      select id into v_selected from public.whatsapp_channels x where x.unit_id=new.unit_id and (x.is_active=true or (x.is_active is null and x.status='connected' and not exists(select from public.whatsapp_channels active where active.unit_id=new.unit_id and active.is_active=true))) order by x.is_active desc nulls last,x.created_at,x.id limit 1;
      if new.channel_id is distinct from v_selected then raise exception 'automation_configuration_changed' using errcode='PT503'; end if;
      if new.channel_id is null then return new; end if;
    end if;
    if new.account_id is not null then perform 1 from public.whatsapp_template_accounts where id=new.account_id and organization_id=v_org for share; if not found then raise exception 'template_tenant_mismatch' using errcode='23514'; end if; end if;
    select * into v_binding from public.whatsapp_template_bindings where id=new.binding_id for share;
    if new.binding_id is not null and (v_binding.id is null or (v_binding.unit_id,v_binding.channel_id,v_binding.provider,v_binding.account_id,v_binding.generation) is distinct from (new.unit_id,new.channel_id,new.provider,new.account_id,new.binding_generation)) then raise exception 'template_binding_mismatch' using errcode='23514'; end if;
    select * into v_channel from public.whatsapp_channels where id=new.channel_id for share;
    if v_channel.id is null or (v_channel.unit_id,v_channel.provider) is distinct from (new.unit_id,new.provider) then raise exception 'template_channel_mismatch' using errcode='23514'; end if;
    if new.initial_credential_revision is not null and new.initial_credential_revision is distinct from v_channel.template_credential_revision then raise exception 'automation_revision_mismatch' using errcode='23514'; end if;
    new.initial_credential_revision:=v_channel.template_credential_revision;
    if new.pin_phase='preconfiguration' then
      if new.binding_id is null then
        if exists(select from public.whatsapp_template_bindings where channel_id=new.channel_id) then raise exception 'automation_configuration_changed' using errcode='PT503'; end if;
      elsif exists(select from public.whatsapp_remote_templates where account_id=new.account_id and logical_id=v_logical and version=1 and language='pt_BR') then raise exception 'automation_configuration_changed' using errcode='PT503'; end if;
      return new;
    end if;
    if new.remote_template_id is not null then
      select * into v_remote from public.whatsapp_remote_templates where id=new.remote_template_id for share;
      if not found or (v_remote.account_id,v_remote.version) is distinct from (new.account_id,new.template_version) then raise exception 'template_remote_mismatch' using errcode='23514'; end if;
    end if;
    if new.cost_authorization_id is not null then
      perform 1 from public.whatsapp_template_cost_authorizations where id=new.cost_authorization_id and account_id=new.account_id and binding_id=new.binding_id and binding_generation=new.binding_generation and category='MARKETING';
      if not found then raise exception 'template_cost_mismatch' using errcode='23514'; end if;
    end if;
  elsif tg_table_name='whatsapp_message_consent_events' then
    if tg_op='INSERT' then
      select coalesce(max(revision),0)+1 into new.revision from public.whatsapp_message_consent_events where unit_id=new.unit_id and customer_id=new.customer_id and purpose=new.purpose;
      new.created_at:=now();
    end if;
  elsif tg_table_name='whatsapp_message_preference_tokens' then
    if tg_op='UPDATE' and (new.id,new.unit_id,new.customer_id,new.purpose,new.token_hash,new.expires_at,new.created_at) is distinct from (old.id,old.unit_id,old.customer_id,old.purpose,old.token_hash,old.expires_at,old.created_at) then raise exception 'preference_token_immutable' using errcode='23514'; end if;
    if tg_op='UPDATE' and old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then raise exception 'preference_token_revocation_immutable' using errcode='23514'; end if;
  elsif tg_table_name='whatsapp_promotion_slots' then
    select * into v_job from public.whatsapp_automation_jobs where id=new.job_id;
    if not found or (tg_op='INSERT' and v_job.pin_phase<>'bound') or v_job.kind not in('waitlist_feedback','voucher_issued') or (v_job.unit_id,v_job.customer_id) is distinct from (new.unit_id,new.customer_id) then raise exception 'promotion_slot_mismatch' using errcode='23514'; end if;
    if tg_op='UPDATE' and (new.id,new.unit_id,new.customer_id,new.job_id,new.created_at,new.window_days) is distinct from (old.id,old.unit_id,old.customer_id,old.job_id,old.created_at,old.window_days) then raise exception 'promotion_slot_identity_immutable' using errcode='23514'; end if;
    if tg_op='UPDATE' and (new.claim_token is distinct from old.claim_token or new.window_until<old.window_until or (old.state='accepted' and new.state<>'accepted') or (old.state='uncertain' and new.state='reserved') or (old.accepted_at is not null and new.accepted_at is distinct from old.accepted_at)) then raise exception 'promotion_slot_evidence_immutable' using errcode='23514'; end if;
  elsif tg_table_name='whatsapp_automation_receipt_events' then
    select * into v_channel from public.whatsapp_channels where id=new.channel_id for share;
    if not found or (v_channel.unit_id,v_channel.provider) is distinct from (new.unit_id,new.provider) then raise exception 'template_channel_mismatch' using errcode='23514'; end if;
  end if;
  return new;
end $$;
revoke all on function public.guard_whatsapp_template_scope() from public,anon,authenticated,service_role;

-- prepare_whatsapp_template_provision: latest definition 20261009153435:693.
create or replace function public.prepare_whatsapp_template_provision(p_job_id uuid,p_fence uuid,p_generation bigint)
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
  if v_authorization is not null then
    update app_private.whatsapp_template_revalidation_authorizations set consumed_at=v_now,consumed_claim_token=p_fence where id=v_authorization and consumed_at is null;
    if not found then raise exception 'template_management_authorization_consumed' using errcode='PT409'; end if;
  end if;
  update public.whatsapp_remote_templates set submission_attempted_at=coalesce(submission_attempted_at,v_now),local_status='submitting' where id=t.id;
  update public.whatsapp_template_jobs set state='posting',post_capture_id=a.sync_capture_id,posting_started_at=v_now,claimed_until=v_now+interval '90 seconds',attempts=attempts+1 where id=j.id and claim_token=p_fence;
  return true;
end $$;
revoke all on function public.prepare_whatsapp_template_provision(uuid,uuid,bigint) from public,anon,authenticated,service_role;
grant execute on function public.prepare_whatsapp_template_provision(uuid,uuid,bigint) to service_role;

notify pgrst,'reload schema';
commit;
