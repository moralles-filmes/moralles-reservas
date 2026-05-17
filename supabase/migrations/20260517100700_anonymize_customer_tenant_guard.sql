-- 059_anonymize_customer_tenant_guard.sql
-- Fecha vulnerabilidade LGPD em anonymize_customer:
-- antes desta migration, o RPC SECURITY DEFINER apagava qualquer customer
-- a partir do UUID, sem verificar se o caller pertence à organização dele.
-- Qualquer authenticated que descobrisse o UUID (link compartilhado,
-- relatório vazado, etc.) podia anonimizar customer de outra org.
--
-- Esta migration adiciona guard: só is_org_member(auth.uid(), customer.org_id)
-- ou is_platform_admin(auth.uid()) podem chamar.

create or replace function public.anonymize_customer(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org_id   uuid;
  v_caller   uuid := auth.uid();
begin
  if v_caller is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  select organization_id
    into v_org_id
    from public.customers
   where id = p_id
     and deleted_at is null;

  -- Customer inexistente ou já anonimizado: trata como no-op silencioso
  -- (não vaza existência do UUID para tenants alheios).
  if v_org_id is null then
    return;
  end if;

  if not public.is_org_member(v_caller, v_org_id)
     and not public.is_platform_admin(v_caller) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update public.customers
     set name = 'Cliente removido',
         phone = 'anon-' || substring(id::text, 1, 8),
         email = null,
         emails = '[]'::jsonb,
         allergies = null,
         dietary_restrictions = null,
         vip_notes = null,
         preferred_table_location = null,
         do_not_contact = true,
         deleted_at = now()
   where id = p_id and deleted_at is null;
end;
$$;

comment on function public.anonymize_customer(uuid) is
  'Anonimiza customer (LGPD). Só is_org_member ou platform_admin podem chamar — guard em 059.';
