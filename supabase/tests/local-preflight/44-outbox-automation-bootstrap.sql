-- Limited local bridge: real028 DDL/trigger/helpers only; inherited41 source stays nullable.
-- ROOT must pipe only to its fixed owned local stack after inspecting the guard.
\set ON_ERROR_STOP on
begin;
do $$ begin
 if to_regclass('public.notification_outbox') is not null and (
   not exists(select from pg_class where oid=to_regclass('public.notification_outbox') and relrowsecurity and relforcerowsecurity)
   or exists(select from pg_policy where polrelid=to_regclass('public.notification_outbox')))
 then raise exception 'outbox44_existing_rls_drift'; end if;
 if exists(select from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
   where a.attrelid=to_regclass('public.notification_outbox') and a.attname in('automation_job_id','automation_initial_token')
    and (a.attisdropped or a.atttypid<>'uuid'::regtype or a.attnotnull or d.oid is not null))
 then raise exception 'outbox44_marker_drift'; end if;
 if current_database()<>'postgres' or to_regprocedure('auth.uid()') is null then raise exception 'outbox44_real_auth_required'; end if;
 if exists(select from pg_trigger where tgrelid='public.reservations'::regclass and tgname='send-confirmation-on-reservation') then raise exception 'outbox44_unexpected_http_trigger'; end if;
 if not exists(select from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
  where a.attrelid='public.reservations'::regclass and a.attname='source' and not a.attnotnull and not a.attisdropped
  and format_type(a.atttypid,a.atttypmod)='text' and pg_get_expr(d.adbin,d.adrelid)='''web''::text')
  or not exists(select from pg_constraint where conrelid='public.reservations'::regclass and conname='resource41_source'
   and pg_get_constraintdef(oid)='CHECK ((source = ANY (ARRAY[''web''::text, ''whatsapp''::text])))') then raise exception 'outbox44_source_drift'; end if;
end $$;
create table if not exists notification_outbox (
  id              uuid primary key default gen_random_uuid(),
  reservation_id  uuid not null references reservations(id) on delete cascade,
  unit_id         uuid not null references units(id) on delete cascade,
  kind            text not null check (kind in ('confirmation', 'cancellation')),
  attempts        integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  status          text not null default 'pending'
                  check (status in ('pending', 'processing', 'done', 'dead')),
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (reservation_id, kind)
);

create index if not exists idx_outbox_pending_due
  on notification_outbox (next_attempt_at)
  where status = 'pending';

create index if not exists idx_outbox_unit_status
  on notification_outbox (unit_id, status, created_at desc);

alter table notification_outbox enable row level security;
alter table notification_outbox force row level security;
-- Sem policies: só service_role acessa via Edge Function.


-- Compare catalog to a temporary copy of the literal028 definition, before replacing any helper.
create temporary table outbox44_expected (
  id              uuid primary key default gen_random_uuid(),
  reservation_id  uuid not null,
  unit_id         uuid not null,
  kind            text not null check (kind in ('confirmation', 'cancellation')),
  attempts        integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  status          text not null default 'pending'
                  check (status in ('pending', 'processing', 'done', 'dead')),
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (reservation_id, kind)
);


do $$ begin
 if exists(
  (select attname,format_type(atttypid,atttypmod),attnotnull,pg_get_expr(d.adbin,d.adrelid) from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
    where a.attrelid='public.notification_outbox'::regclass and a.attnum>0 and not a.attisdropped and a.attname not in ('automation_job_id','automation_initial_token')
   except select attname,format_type(atttypid,atttypmod),attnotnull,pg_get_expr(d.adbin,d.adrelid) from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid='outbox44_expected'::regclass and a.attnum>0 and not a.attisdropped)
  union all
  (select attname,format_type(atttypid,atttypmod),attnotnull,pg_get_expr(d.adbin,d.adrelid) from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid='outbox44_expected'::regclass and a.attnum>0 and not a.attisdropped
   except select attname,format_type(atttypid,atttypmod),attnotnull,pg_get_expr(d.adbin,d.adrelid) from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid='public.notification_outbox'::regclass and a.attnum>0 and not a.attisdropped and a.attname not in ('automation_job_id','automation_initial_token'))
 ) then raise exception 'outbox44_column_drift'; end if;
 if (select array_agg(pg_get_constraintdef(oid) order by pg_get_constraintdef(oid)) from pg_constraint where conrelid='public.notification_outbox'::regclass and contype<>'f')
   is distinct from (select array_agg(pg_get_constraintdef(oid) order by pg_get_constraintdef(oid)) from pg_constraint where conrelid='outbox44_expected'::regclass)
 then raise exception 'outbox44_constraint_drift'; end if;
 -- Temporary relations cannot reference permanent relations. Verify both real FKs directly.
 if (select count(*) from pg_constraint where conrelid='public.notification_outbox'::regclass and contype='f')<>2
  or (select count(*) from pg_constraint c where c.conrelid='public.notification_outbox'::regclass and c.contype='f'
   and c.conkey=array[(select attnum from pg_attribute where attrelid=c.conrelid and attname='reservation_id' and not attisdropped)]::smallint[]
   and c.confrelid='public.reservations'::regclass
   and c.confkey=array[(select attnum from pg_attribute where attrelid=c.confrelid and attname='id' and not attisdropped)]::smallint[]
   and c.confupdtype='a' and c.confdeltype='c' and c.confmatchtype='s'
   and not c.condeferrable and not c.condeferred and c.convalidated and c.conislocal and c.coninhcount=0)<>1
  or (select count(*) from pg_constraint c where c.conrelid='public.notification_outbox'::regclass and c.contype='f'
   and c.conkey=array[(select attnum from pg_attribute where attrelid=c.conrelid and attname='unit_id' and not attisdropped)]::smallint[]
   and c.confrelid='public.units'::regclass
   and c.confkey=array[(select attnum from pg_attribute where attrelid=c.confrelid and attname='id' and not attisdropped)]::smallint[]
   and c.confupdtype='a' and c.confdeltype='c' and c.confmatchtype='s'
   and not c.condeferrable and not c.condeferred and c.convalidated and c.conislocal and c.coninhcount=0)<>1
 then raise exception 'outbox44_foreign_key_drift'; end if;
 if not exists(select from pg_class where oid='public.notification_outbox'::regclass and relrowsecurity and relforcerowsecurity)
  or exists(select from pg_policy where polrelid='public.notification_outbox'::regclass) then raise exception 'outbox44_rls_drift'; end if;
 if not exists(select from pg_index where indexrelid='public.idx_outbox_pending_due'::regclass and indrelid='public.notification_outbox'::regclass and indisvalid
  and pg_get_indexdef(indexrelid,1,true)='next_attempt_at' and pg_get_expr(indpred,indrelid)='(status = ''pending''::text)')
  or not exists(select from pg_index where indexrelid='public.idx_outbox_unit_status'::regclass and indrelid='public.notification_outbox'::regclass and indisvalid
   and indnkeyatts=3 and pg_get_indexdef(indexrelid,1,true)='unit_id' and pg_get_indexdef(indexrelid,2,true)='status' and pg_get_indexdef(indexrelid,3,true)='created_at')
 then raise exception 'outbox44_index_drift'; end if;
end $$;
do $check$ declare f pg_proc%rowtype; begin
 select * into f from pg_proc where oid=to_regprocedure('public.enqueue_confirmation_notification()');
 if f.oid is not null and (f.prosrc not in ($original$
begin
  -- Reservas via WhatsApp não geram confirmação automática (o agente já
  -- confirma na conversa). Só web/painel/API.
  if new.source is distinct from 'whatsapp' then
    insert into notification_outbox (reservation_id, unit_id, kind)
    values (new.id, new.unit_id, 'confirmation')
    on conflict (reservation_id, kind) do nothing;
  end if;
  return new;
end;
$original$,$hardened$
begin
  -- Reservas via WhatsApp não geram confirmação automática (o agente já
  -- confirma na conversa). Só web/painel/API.
  if new.source is distinct from 'whatsapp' then
    insert into notification_outbox (reservation_id, unit_id, kind)
    values (new.id, new.unit_id, 'confirmation')
    on conflict (reservation_id, kind) do nothing;
  end if;
  return new;
end;
$hardened$)
   or not f.prosecdef or f.proconfig is distinct from array['search_path=public']
   or f.prorettype <> 'trigger'::regtype) then raise exception 'outbox44_function_drift_enqueue_confirmation_notification'; end if;
 if f.oid is null then execute $definition$create or replace function enqueue_confirmation_notification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Reservas via WhatsApp não geram confirmação automática (o agente já
  -- confirma na conversa). Só web/painel/API.
  if new.source is distinct from 'whatsapp' then
    insert into notification_outbox (reservation_id, unit_id, kind)
    values (new.id, new.unit_id, 'confirmation')
    on conflict (reservation_id, kind) do nothing;
  end if;
  return new;
end;
$$;$definition$; end if;
end $check$;
do $check$ declare f pg_proc%rowtype; begin
 select * into f from pg_proc where oid=to_regprocedure('public.mark_outbox_done(uuid)');
 if f.oid is not null and (f.prosrc not in ($original$
  update notification_outbox
  set status = 'done', updated_at = now(), last_error = null
  where id = p_id;
$original$,$hardened$
  update notification_outbox
  set status = 'done', updated_at = now(), last_error = null
  where id = p_id and automation_job_id is null and automation_initial_token is null;
$hardened$)
   or not f.prosecdef or f.proconfig is distinct from array['search_path=public']
   or f.prorettype <> 'void'::regtype) then raise exception 'outbox44_function_drift_mark_outbox_done'; end if;
 if f.oid is null then execute $definition$create or replace function mark_outbox_done(p_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update notification_outbox
  set status = 'done', updated_at = now(), last_error = null
  where id = p_id;
$$;$definition$; end if;
end $check$;
do $check$ declare f pg_proc%rowtype; begin
 select * into f from pg_proc where oid=to_regprocedure('public.mark_outbox_failed(uuid,text)');
 if f.oid is not null and (f.prosrc not in ($original$
declare
  new_attempts integer;
  delays interval[] := array['1 minute', '5 minutes', '15 minutes', '1 hour', '4 hours']::interval[];
  next_delay interval;
begin
  update notification_outbox
  set attempts = attempts + 1,
      last_error = p_error,
      updated_at = now(),
      status = case when attempts + 1 >= 5 then 'dead' else 'pending' end,
      next_attempt_at = case
        when attempts + 1 >= 5 then next_attempt_at
        else now() + delays[least(attempts + 1, array_length(delays, 1))]
      end
  where id = p_id
  returning attempts into new_attempts;
end;
$original$,$hardened$
declare
  new_attempts integer;
  delays interval[] := array['1 minute', '5 minutes', '15 minutes', '1 hour', '4 hours']::interval[];
  next_delay interval;
begin
  update notification_outbox
  set attempts = attempts + 1,
      last_error = p_error,
      updated_at = now(),
      status = case when attempts + 1 >= 5 then 'dead' else 'pending' end,
      next_attempt_at = case
        when attempts + 1 >= 5 then next_attempt_at
        else now() + delays[least(attempts + 1, array_length(delays, 1))]
      end
  where id = p_id and automation_job_id is null and automation_initial_token is null
  returning attempts into new_attempts;
end;
$hardened$)
   or not f.prosecdef or f.proconfig is distinct from array['search_path=public']
   or f.prorettype <> 'void'::regtype) then raise exception 'outbox44_function_drift_mark_outbox_failed'; end if;
 if f.oid is null then execute $definition$create or replace function mark_outbox_failed(p_id uuid, p_error text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  new_attempts integer;
  delays interval[] := array['1 minute', '5 minutes', '15 minutes', '1 hour', '4 hours']::interval[];
  next_delay interval;
begin
  update notification_outbox
  set attempts = attempts + 1,
      last_error = p_error,
      updated_at = now(),
      status = case when attempts + 1 >= 5 then 'dead' else 'pending' end,
      next_attempt_at = case
        when attempts + 1 >= 5 then next_attempt_at
        else now() + delays[least(attempts + 1, array_length(delays, 1))]
      end
  where id = p_id
  returning attempts into new_attempts;
end;
$$;$definition$; end if;
end $check$;
do $$ begin
 if exists(select from pg_trigger where tgrelid='public.reservations'::regclass and tgname='enqueue_confirmation_after_insert'
  and (tgfoid<>'public.enqueue_confirmation_notification()'::regprocedure or tgtype<>5 or tgenabled<>'O' or tgqual is not null)) then raise exception 'outbox44_trigger_drift'; end if;
 if not exists(select from pg_trigger where tgrelid='public.reservations'::regclass and tgname='enqueue_confirmation_after_insert') then
 create trigger enqueue_confirmation_after_insert after insert on public.reservations for each row execute function public.enqueue_confirmation_notification(); end if;
end $$;
revoke all    on function public.mark_outbox_done(uuid)         from public, anon, authenticated;
grant  execute on function public.mark_outbox_done(uuid)         to service_role;
revoke all    on function public.mark_outbox_failed(uuid, text) from public, anon, authenticated;
grant  execute on function public.mark_outbox_failed(uuid, text) to service_role;
revoke all on function public.enqueue_confirmation_notification() from public,anon,authenticated,service_role;
-- Measure inherited operational table ACL, without attributing grants to FORCE RLS.
select relacl,relrowsecurity,relforcerowsecurity from pg_class where oid='public.notification_outbox'::regclass;
drop table outbox44_expected;
commit;
