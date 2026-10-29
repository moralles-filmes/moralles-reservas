-- Health counts only sync failures not yet superseded by a later successful sync
-- of the same account. Terminal `failed` rows live 90 days for evidence, so the
-- raw count kept the worker alerting (HTTP 503 every five minutes) long after a
-- transient GET failure had already been repaired by the next cycle. An account
-- that never syncs again keeps its failure counted. The worker still alerts in
-- the cycle where a failure happens through its own `failures` counter.
create or replace function public.whatsapp_template_pipeline_health()
returns jsonb language sql security definer set search_path='' as $$
  select jsonb_build_object('failed',(select count(*) from public.whatsapp_template_jobs f where f.state='failed'
      and not exists(select from public.whatsapp_template_jobs d where d.account_id=f.account_id
        and d.operation in('sync','reconcile') and d.state='done' and d.finished_at>f.finished_at)),
    'uncertain',(select count(*) from public.whatsapp_template_jobs where state='uncertain'),
    'oldest_id',(select id from public.whatsapp_template_jobs where state in('queued','claimed','posting','uncertain','paused','needs_review') order by created_at,id limit 1),
    'oldest_age_seconds',coalesce((select greatest(0,extract(epoch from clock_timestamp()-min(created_at))) from public.whatsapp_template_jobs where state in('queued','claimed','posting','uncertain','paused','needs_review')),0))
$$;
revoke all on function public.whatsapp_template_pipeline_health() from public,anon,authenticated,service_role;
grant execute on function public.whatsapp_template_pipeline_health() to service_role;
