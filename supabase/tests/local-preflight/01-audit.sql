-- audit_log: extraido VERBATIM de 009 (linhas 12-22) e 013 (92-93), mais a
-- funcao audit_trigger_func de 013 sem alteracao. Nao e transcricao livre.
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
;
alter table audit_log add column if not exists unit_id         uuid;
alter table audit_log add column if not exists organization_id uuid;
create or replace function auth.email() returns text language sql stable as $$ select null::text $$;
create or replace function public.audit_trigger_func()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id       uuid;
  v_actor_email    text;
  v_old            jsonb;
  v_new            jsonb;
  v_record_id      text;
  v_unit_id        uuid;
  v_org_id         uuid;
begin
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

  -- Capturar unit_id se a tabela tiver a coluna
  begin
    v_unit_id := coalesce(
      (v_new->>'unit_id')::uuid,
      (v_old->>'unit_id')::uuid
    );
  exception when others then
    v_unit_id := null;
  end;

  -- Capturar organization_id (customers)
  begin
    v_org_id := coalesce(
      (v_new->>'organization_id')::uuid,
      (v_old->>'organization_id')::uuid
    );
  exception when others then
    v_org_id := null;
  end;

  insert into audit_log (
    table_name, record_id, action,
    old_values, new_values,
    actor_id, actor_email,
    unit_id, organization_id
  )
  values (
    TG_TABLE_NAME, v_record_id, TG_OP,
    v_old, v_new,
    v_actor_id, v_actor_email,
    v_unit_id, v_org_id
  );

  return coalesce(NEW, OLD);
end;
$$;
create table if not exists billing_subscriptions (id uuid primary key default gen_random_uuid());
