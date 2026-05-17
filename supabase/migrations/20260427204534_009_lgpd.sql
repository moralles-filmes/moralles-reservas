-- LGPD: audit log + soft-delete + anonimização de cliente.

-- ─── 1. customers.deleted_at (soft delete) ───────────────────────────────────

alter table customers add column if not exists deleted_at timestamptz;

create index if not exists customers_deleted_at_idx
  on customers(deleted_at) where deleted_at is null;

-- ─── 2. audit_log ────────────────────────────────────────────────────────────

create table if not exists audit_log (
  id           bigserial primary key,
  table_name   text not null,
  record_id    text not null,
  action       text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  old_values   jsonb,
  new_values   jsonb,
  actor_id     uuid,
  actor_email  text,
  created_at   timestamptz not null default now()
);

create index if not exists audit_log_table_record_idx on audit_log(table_name, record_id);
create index if not exists audit_log_created_at_idx on audit_log(created_at desc);
create index if not exists audit_log_actor_idx on audit_log(actor_id);

alter table audit_log enable row level security;

-- Apenas authenticated lê (admin). Inserts vêm via trigger SECURITY DEFINER.
create policy "auth_select_audit" on audit_log
  for select to authenticated using (true);

-- ─── 3. Trigger de auditoria ─────────────────────────────────────────────────

create or replace function public.audit_trigger_func()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id    uuid;
  v_actor_email text;
  v_old jsonb;
  v_new jsonb;
  v_record_id   text;
begin
  -- auth.uid() retorna null quando a chamada é via service_role (Edge Functions).
  v_actor_id := auth.uid();
  begin
    v_actor_email := auth.email();
  exception when others then
    v_actor_email := null;
  end;

  if (TG_OP = 'INSERT') then
    v_old := null;
    v_new := to_jsonb(NEW);
    v_record_id := (NEW).id::text;
  elsif (TG_OP = 'UPDATE') then
    v_old := to_jsonb(OLD);
    v_new := to_jsonb(NEW);
    v_record_id := (NEW).id::text;
  elsif (TG_OP = 'DELETE') then
    v_old := to_jsonb(OLD);
    v_new := null;
    v_record_id := (OLD).id::text;
  end if;

  insert into audit_log (table_name, record_id, action, old_values, new_values, actor_id, actor_email)
  values (TG_TABLE_NAME, v_record_id, TG_OP, v_old, v_new, v_actor_id, v_actor_email);

  return coalesce(NEW, OLD);
end;
$$;

drop trigger if exists customers_audit on customers;
create trigger customers_audit
  after insert or update or delete on customers
  for each row execute function public.audit_trigger_func();

drop trigger if exists reservations_audit on reservations;
create trigger reservations_audit
  after insert or update or delete on reservations
  for each row execute function public.audit_trigger_func();

-- ─── 4. Anonimização (LGPD right-to-be-forgotten) ────────────────────────────
-- Mantém histórico de reservas (necessário para fiscalização contábil),
-- mas remove qualquer PII identificável do cliente.

create or replace function public.anonymize_customer(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update customers set
    name = 'Cliente removido',
    phone = 'anon-' || substring(id::text, 1, 8),
    email = null,
    allergies = null,
    dietary_restrictions = null,
    vip_notes = null,
    preferred_table_location = null,
    do_not_contact = true,
    deleted_at = now()
  where id = p_id
    and deleted_at is null;
end;
$$;

revoke all on function public.anonymize_customer(uuid) from public;
revoke execute on function public.anonymize_customer(uuid) from anon;
grant execute on function public.anonymize_customer(uuid) to authenticated;
