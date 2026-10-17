-- Templates "mesa pronta" e "reserva cancelada" (migration
-- 20261017120000_whatsapp_templates_table_ready_cancellation.sql): o que o `66`
-- precisa ANTES da migration. Somente banco descartável.
--
-- SEQUÊNCIA (contêiner próprio; ver a seção "Templates mesa pronta e
-- cancelamento (66)" no README):
--   25 -> sete migrations de template -> ponte41 -> 20261005170415 -> 44
--   -> 20261006003631 -> ponte48 -> 20261009003452 -> 20261009135808 -> setup38
--   -> quarentena de cron -> 52 -> 56 -> 20261009153435 -> 20261009180617
--   -> 20261009220823 -> 66a (este) -> 66 (esperado: ERROR, RED)
--   -> 20261017120000 -> 66 -> 20261017120000 x2 -> 66
--
-- O `66` não precisa de schema novo. Este arquivo existe por UMA medida que só
-- pode ser tomada ANTES da migration: identidade e privilégio das DEZ funções
-- que ela substitui por `create or replace` (oid, proacl, prosecdef,
-- proconfig, provolatile, dono). O cabeçalho da migration afirma que
-- `create or replace` preserva o objeto e a ACL; o T8 do `66` compara o depois
-- com o gravado aqui. Gravado depois, o snapshot compararia a função consigo
-- mesma e o T8 ficaria verde medindo nada — por isso o arquivo RECUSA rodar com
-- a migration já aplicada.
--
-- `t_snap066` é tabela de harness, fora de qualquer rollback.
\set ON_ERROR_STOP on

do $$
declare sig text;
begin
  if exists (select 1 from pg_catalog.pg_constraint
              where conrelid = to_regclass('public.whatsapp_remote_templates') and contype = 'c'
                and pg_catalog.pg_get_constraintdef(oid) like '%res_cancelada_v1%')
     or exists (select 1 from pg_catalog.pg_constraint
              where conrelid = to_regclass('public.whatsapp_automation_jobs') and contype = 'c'
                and pg_catalog.pg_get_constraintdef(oid) like '%waitlist_table_ready%')
     or pg_catalog.pg_get_functiondef(to_regprocedure('app_private.whatsapp_automation_post_core(uuid,uuid,bigint,bigint,bigint,boolean,jsonb)')) like '%waitlist_table_ready%' then
    raise exception '66a exige rodar ANTES da migration 20261017120000: o snapshot de antes seria o de depois e o T8 nao mediria nada. Recrie o banco.';
  end if;
  foreach sig in array array[
    'public.enqueue_whatsapp_automation(jsonb)',
    'public.block_whatsapp_automation_preflight(uuid,uuid,text)',
    'public.get_whatsapp_automation_delivery_state(uuid,integer,integer)',
    'app_private.whatsapp_automation_post_core(uuid,uuid,bigint,bigint,bigint,boolean,jsonb)',
    'public.reconcile_whatsapp_automation_acceptance(uuid)',
    'public.confirm_whatsapp_template_post(uuid,uuid,bigint)',
    'app_private.change_whatsapp_automation_pins(uuid,uuid,bigint,boolean)',
    'public.revalidate_whatsapp_template_job(uuid,uuid,bigint)',
    'public.guard_whatsapp_template_scope()',
    'public.prepare_whatsapp_template_provision(uuid,uuid,bigint)'] loop
    if to_regprocedure(sig) is null then raise exception '66a exige a cadeia ate 20261009220823 aplicada (% ausente).', sig; end if;
  end loop;
  -- Predecessor imediato: a retenção de recibos da 20261009220823 e a gestão da 20261009153435.
  if to_regprocedure('public.purge_whatsapp_automation_workers(integer,integer)') is null
     or pg_catalog.pg_get_functiondef('public.purge_whatsapp_automation_workers(integer,integer)'::regprocedure) not like '%v_pending boolean%'
     or to_regprocedure('public.release_whatsapp_template_channel(uuid,text,boolean,bigint,bigint)') is null
     or to_regprocedure('public.confirm_whatsapp_automation_resource_post(uuid,uuid,bigint,bigint,bigint,jsonb)') is null then
    raise exception '66a exige 20261009153435 e 20261009220823 aplicadas (gestao/retencao ausentes).';
  end if;
  if exists (select from cron.job where jobname in ('whatsapp-automation-worker','whatsapp-template-workers')) then
    raise exception '66a exige a quarentena dos dois crons de template (cron.unschedule antes do 52).';
  end if;
end $$;

create table if not exists t_snap066 (k text primary key, v text not null);

insert into t_snap066 (k, v)
select 'fn_antes:' || p.oid::regprocedure::text,
       format('oid=%s secdef=%s config=%s volatile=%s owner=%s acl=%s',
              p.oid, p.prosecdef, coalesce(p.proconfig::text, 'null'), p.provolatile,
              p.proowner::regrole, coalesce(p.proacl::text, 'null'))
  from pg_catalog.pg_proc p
 where p.oid in ('public.enqueue_whatsapp_automation(jsonb)'::regprocedure,
                 'public.block_whatsapp_automation_preflight(uuid,uuid,text)'::regprocedure,
                 'public.get_whatsapp_automation_delivery_state(uuid,integer,integer)'::regprocedure,
                 'app_private.whatsapp_automation_post_core(uuid,uuid,bigint,bigint,bigint,boolean,jsonb)'::regprocedure,
                 'public.reconcile_whatsapp_automation_acceptance(uuid)'::regprocedure,
                 'public.confirm_whatsapp_template_post(uuid,uuid,bigint)'::regprocedure,
                 'app_private.change_whatsapp_automation_pins(uuid,uuid,bigint,boolean)'::regprocedure,
                 'public.revalidate_whatsapp_template_job(uuid,uuid,bigint)'::regprocedure,
                 'public.guard_whatsapp_template_scope()'::regprocedure,
                 'public.prepare_whatsapp_template_provision(uuid,uuid,bigint)'::regprocedure)
on conflict (k) do update set v = excluded.v;

-- Overload count per name (post_core keeps historical shorter overloads): the
-- migration must not add one by mistyping a signature.
insert into t_snap066 (k, v)
select 'overloads:' || n.nspname || '.' || p.proname, count(*)::text
  from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
 where n.nspname in ('public','app_private')
   and p.proname in ('enqueue_whatsapp_automation','block_whatsapp_automation_preflight','get_whatsapp_automation_delivery_state',
                     'whatsapp_automation_post_core','reconcile_whatsapp_automation_acceptance','confirm_whatsapp_template_post',
                     'change_whatsapp_automation_pins','revalidate_whatsapp_template_job','guard_whatsapp_template_scope',
                     'prepare_whatsapp_template_provision')
 group by n.nspname, p.proname
on conflict (k) do update set v = excluded.v;

select k, v from t_snap066 order by k;
