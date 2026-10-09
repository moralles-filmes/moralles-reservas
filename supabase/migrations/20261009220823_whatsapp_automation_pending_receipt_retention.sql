-- Task16: preserve pending exact-correlated delivery evidence until local repair.
begin;
create or replace function public.purge_whatsapp_automation_workers(p_receipt_limit integer,p_job_limit integer)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_now timestamptz; v_cutoff timestamptz; v_rl integer; v_jl integer; v_jobs integer; v_receipts integer; v_delta integer;
  v_candidates uuid[]; v_channels uuid[]; v_locked uuid[]; v_channel uuid; j public.whatsapp_automation_jobs%rowtype; v_pending boolean;
begin
  if pg_catalog.current_setting('transaction_isolation') is distinct from 'read committed' then
    raise exception 'automation_purge_isolation_unsupported' using errcode='0A000';
  end if;
  v_now:=clock_timestamp(); v_cutoff:=v_now-interval '90 days'; v_rl:=greatest(0,least(coalesce(p_receipt_limit,500),500)); v_jl:=greatest(0,least(coalesce(p_job_limit,20),20));
  v_jobs:=0; v_receipts:=0; v_locked:='{}';
  select coalesce(array_agg(x.id),'{}'),coalesce(array_agg(x.channel_id) filter(where x.provider_message_id is not null),'{}') into v_candidates,v_channels
  from (select * from public.whatsapp_automation_jobs q where isfinite(q.finished_at) and q.finished_at<v_cutoff and not q.reconcile_required
    and ((q.state='expired' and q.posting_started_at is null and q.provider_message_id is null)
      or (q.state='rejected' and q.provider_message_id is null)
      or (q.state='reconciled' and q.pin_phase='bound' and q.provider_message_id is not null and q.posting_started_at is not null and q.claim_token is not null))
    order by q.finished_at,q.id limit v_jl) x;
  -- ALL historical parents precede ANY job lock. Busy/missing parent retains its job.
  for v_channel in select id from public.whatsapp_channels where id=any(v_channels) order by id for update skip locked loop
    v_locked:=array_append(v_locked,v_channel);
  end loop;
  for j in select * from public.whatsapp_automation_jobs where id=any(v_candidates) order by id for update skip locked loop
    if not coalesce(isfinite(j.finished_at) and j.finished_at<v_cutoff and not j.reconcile_required and (
      (j.state='expired' and j.posting_started_at is null and j.provider_message_id is null) or (j.state='rejected' and j.provider_message_id is null)
      or (j.state='reconciled' and j.pin_phase='bound' and j.provider_message_id is not null and j.posting_started_at is not null and j.claim_token is not null and j.channel_id=any(v_locked))),false) then continue; end if;
    -- Separate READ COMMITTED command AFTER parent locks sees a recorder's committed child.
    select exists(select from public.whatsapp_automation_receipt_events e where e.processing_state='pending'
      and (e.unit_id,e.provider,e.channel_id,e.provider_message_id)=(j.unit_id,j.provider,j.channel_id,j.provider_message_id)) into v_pending;
    if v_pending then continue; end if;
    delete from public.whatsapp_automation_jobs q where q.id=j.id and isfinite(q.finished_at) and q.finished_at<v_cutoff and not q.reconcile_required
      and ((q.state='expired' and q.posting_started_at is null and q.provider_message_id is null) or (q.state='rejected' and q.provider_message_id is null)
        or (q.state='reconciled' and q.pin_phase='bound' and q.posting_started_at is not null and q.provider_message_id is not null and q.claim_token is not null and q.channel_id=any(v_locked)));
    get diagnostics v_delta=row_count; v_jobs:=v_jobs+v_delta;
  end loop;
  -- No parent/job acquisition after receipt locks; slots and legacy rows are untouched.
  -- Pending evidence remains repairable while its exact historical job exists.
  -- These are nonlocking reads: never acquire parents/jobs after receipt locks.
  with candidates as (select e.id from public.whatsapp_automation_receipt_events e where isfinite(e.received_at) and e.received_at<v_cutoff
      and (e.processing_state<>'pending' or not exists(select from public.whatsapp_automation_jobs q
        where (q.unit_id,q.provider,q.channel_id,q.provider_message_id)=(e.unit_id,e.provider,e.channel_id,e.provider_message_id)))
      order by e.received_at,e.id limit v_rl for update of e skip locked)
    delete from public.whatsapp_automation_receipt_events e using candidates c where e.id=c.id and isfinite(e.received_at) and e.received_at<v_cutoff
      and (e.processing_state<>'pending' or not exists(select from public.whatsapp_automation_jobs q
        where (q.unit_id,q.provider,q.channel_id,q.provider_message_id)=(e.unit_id,e.provider,e.channel_id,e.provider_message_id)));
  get diagnostics v_receipts=row_count;
  return jsonb_build_object('version',1,'observed_at',v_now,'cutoff',v_cutoff,'receipt_limit',v_rl,'job_limit',v_jl,'receipts_deleted',v_receipts,'jobs_deleted',v_jobs);
end $$;
revoke all on function public.purge_whatsapp_automation_workers(integer,integer) from public,anon,authenticated,service_role;
grant execute on function public.purge_whatsapp_automation_workers(integer,integer) to service_role;
commit;
