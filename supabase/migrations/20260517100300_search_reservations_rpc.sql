-- 055_search_reservations_rpc.sql
-- Cria RPC pra busca de reservas com termo em código, nome ou telefone do customer.
--
-- Motivação: a query atual no `useReservas` hook usa `.or(reservation_code.ilike, customers.name.ilike, customers.phone.ilike)`
-- mas PostgREST não suporta `.or()` cross-table (vide docs oficiais). O hook
-- estava silenciosamente ignorando os filtros de customer ou retornando vazio
-- em casos de busca por nome/telefone.
--
-- SECURITY INVOKER (default) — RLS de reservations e customers continuam aplicadas.
-- O caller precisa ser unit_member do unit_id passado (RLS de reservations garante).

create or replace function public.search_reservations(
  p_unit_id uuid,
  p_term text default null,
  p_date date default null,
  p_status text default null
)
returns setof reservations
language sql
stable
security invoker
set search_path = public
as $$
  select r.*
  from reservations r
  left join customers c on c.id = r.customer_id
  where r.unit_id = p_unit_id
    and (p_date is null or r.date = p_date)
    and (p_status is null or r.status = p_status)
    and (
      p_term is null
      or btrim(p_term) = ''
      or r.reservation_code ilike '%' || p_term || '%'
      or c.name ilike '%' || p_term || '%'
      or c.phone ilike '%' || regexp_replace(p_term, '\D', '', 'g') || '%'
    )
  order by r.date asc, r.time asc;
$$;

comment on function public.search_reservations(uuid, text, date, text) is
  'Busca reservas por código, nome ou telefone do cliente. RLS aplica via SECURITY INVOKER.';

-- Permite chamada pelo role authenticated (member do painel).
grant execute on function public.search_reservations(uuid, text, date, text) to authenticated;
