-- 060_get_customer_stats_bulk.sql
-- RPC bulk que substitui o padrão N+1 (1 chamada get_customer_stats por cliente)
-- usado em src/lib/exportXlsx.ts e no count de reservas do módulo Clientes.
--
-- Retorna duas contagens:
--   * total_unit : reservas do customer na unidade p_unit_id (NULL → 0)
--   * total_org  : reservas do customer em toda a organização
--
-- Confirmed/no_shows/cancelled/no_show_rate/last_visit seguem a mesma
-- semântica de get_customer_stats — quando p_unit_id é informado, escopa
-- por unidade; senão, agrega toda a org.
--
-- Segurança: SECURITY DEFINER + check explícito via is_org_member para
-- impedir leak entre tenants se o caller mandar UUIDs alheios.

create or replace function public.get_customer_stats_bulk(
  p_customer_ids uuid[],
  p_unit_id      uuid default null
)
returns table (
  customer_id   uuid,
  total_unit    integer,
  total_org     integer,
  confirmed     integer,
  no_shows      integer,
  cancelled     integer,
  no_show_rate  numeric,
  last_visit    date
)
language plpgsql
security definer
set search_path = public, pg_temp
stable
as $$
declare
  v_caller uuid := auth.uid();
begin
  if v_caller is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  if p_customer_ids is null or array_length(p_customer_ids, 1) is null then
    return;
  end if;

  return query
  with
    -- Customers pedidos que existem e pertencem a uma org da qual o caller é membro
    -- (ou caller é platform_admin)
    allowed as (
      select c.id, c.organization_id
        from public.customers c
       where c.id = any(p_customer_ids)
         and (
           public.is_platform_admin(v_caller)
           or public.is_org_member(v_caller, c.organization_id)
         )
    ),
    -- Agregação por customer escopada na unidade
    by_unit as (
      select r.customer_id,
             count(*)::int                                              as total_unit,
             count(*) filter (where r.status = 'confirmed')::int        as confirmed,
             count(*) filter (where r.status = 'no_show')::int          as no_shows,
             count(*) filter (where r.status = 'cancelled')::int        as cancelled,
             max(r.date) filter (where r.status in ('confirmed','no_show')) as last_visit
        from public.reservations r
        join allowed a on a.id = r.customer_id
       where (p_unit_id is null or r.unit_id = p_unit_id)
       group by r.customer_id
    ),
    -- Agregação por customer em toda a org (sem filtro de unit)
    by_org as (
      select r.customer_id,
             count(*)::int as total_org
        from public.reservations r
        join allowed a on a.id = r.customer_id
       group by r.customer_id
    )
  select
    a.id                                            as customer_id,
    coalesce(bu.total_unit, 0)                      as total_unit,
    coalesce(bo.total_org, 0)                       as total_org,
    coalesce(bu.confirmed, 0)                       as confirmed,
    coalesce(bu.no_shows, 0)                        as no_shows,
    coalesce(bu.cancelled, 0)                       as cancelled,
    case
      when coalesce(bu.confirmed, 0) + coalesce(bu.no_shows, 0) > 0
        then round(
               coalesce(bu.no_shows, 0)::numeric
               / (coalesce(bu.confirmed, 0) + coalesce(bu.no_shows, 0)),
               3
             )
      else null
    end                                             as no_show_rate,
    bu.last_visit                                   as last_visit
  from allowed a
  left join by_unit bu on bu.customer_id = a.id
  left join by_org  bo on bo.customer_id = a.id;
end;
$$;

revoke all on function public.get_customer_stats_bulk(uuid[], uuid) from public;
revoke execute on function public.get_customer_stats_bulk(uuid[], uuid) from anon;
grant  execute on function public.get_customer_stats_bulk(uuid[], uuid) to authenticated;

comment on function public.get_customer_stats_bulk(uuid[], uuid) is
  'Stats agregadas para múltiplos customers em uma chamada. Retorna total_unit + total_org. Escopado por is_org_member. Substitui N+1 de get_customer_stats no módulo Clientes.';
