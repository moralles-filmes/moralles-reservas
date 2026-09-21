-- 108 — guard de tenant em public.get_customer_stats(uuid, uuid)
--
-- Era a única entrada `authenticated` de scripts/function-acl-allowlist.json sem
-- guard interno: SECURITY DEFINER, exposta pelo PostgREST e sem `auth.uid()` em
-- lugar nenhum. Qualquer usuário logado — inclusive sem nenhuma membership —
-- lia estatística de cliente de qualquer organização, e com `p_unit_id => null`
-- o filtro de unidade era pulado e o agregado cobria toda unidade de toda org.
-- A 107 dropou o irmão de 1 argumento, que era pior; este ficou para cá.
--
-- O TENANT VEM DO PRÓPRIO RECURSO: a organização sai de `customers` pelo
-- `p_customer_id`, nunca do `p_unit_id`, que é parâmetro do chamador. Confiar no
-- parâmetro de escopo deixaria o guard decorativo — quem ataca escolhe o valor.
-- `customers` pertence à ORGANIZATION (o cliente reserva em qualquer unidade da
-- rede), então o guard é `is_org_member`, não `is_unit_member`, com o paralelo
-- obrigatório `is_platform_admin`, que opera com pseudo-membership fabricada
-- pelo `useCurrentUnit` e não tem linha em `unit_members`. Mesmo padrão da irmã
-- `get_customer_stats_bulk`.
--
-- Estreitar o grant não resolveria: `authenticated` é o único papel Postgres que
-- significa "logado", e todo chamador legítimo também é só `authenticated`.
--
-- `p_unit_id` SEGUE aceitando null, com o mesmo significado de antes (agregado
-- da org). O guard de org já fecha o buraco, e a irmã já expõe `total_org` a
-- qualquer membro da org — exigir unidade aqui inventaria uma segunda semântica
-- sem fechar nada a mais.
--
-- Recusa com 42501 em vez de devolver zeros: é o padrão de guard de RPC deste
-- repo (`enter_waitlist`, `get_undelivered_notifications`) e deixa rastro no
-- log. Cliente inexistente e cliente alheio caem no MESMO ramo — a recusa não é
-- oráculo de existência.
--
-- Nada sai de `public` e o grant a `authenticated` fica: o Advisor segue
-- 0028=9 | 0029=14 | total=23.
--
-- Verificado no pré-voo: supabase/tests/local-preflight/12-customer-stats-108.sql
-- (STATS-1..8), com controle positivo em 13-controles-108.sql (CONTROLE-25/26).

create or replace function public.get_customer_stats(
  p_customer_id uuid,
  p_unit_id uuid default null
)
returns table (total integer, confirmed integer, no_shows integer,
               cancelled integer, no_show_rate numeric, last_visit date)
language plpgsql
stable
security definer
set search_path = 'public', 'app_private', 'pg_temp'
as $$
declare
  v_caller uuid := auth.uid();
  v_org    uuid;
begin
  if v_caller is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  -- O tenant vem do PRÓPRIO recurso, nunca do p_unit_id que o chamador mandou.
  select c.organization_id into v_org
    from public.customers c
   where c.id = p_customer_id;

  -- Cliente inexistente e cliente alheio caem no MESMO ramo: sem oráculo.
  if v_org is null
     or not (app_private.is_platform_admin(v_caller)
             or app_private.is_org_member(v_caller, v_org)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Os aliases `a_*` não são estilo: `total`, `confirmed`, `cancelled` e
  -- `last_visit` são variáveis OUT do `returns table`, e referência nua a esses
  -- nomes dentro da query estoura ambígua em tempo de execução. Só aparecem
  -- porque a função virou plpgsql; o `language sql` de antes não tinha o
  -- problema. A aritmética é a mesma de antes, incluindo o `0::numeric` com
  -- denominador zero (a irmã devolve null ali; alinhar seria mudança de
  -- comportamento sem pedido, e a UI já trata os dois casos).
  return query
  with r as (
    select res.status, res.date
      from public.reservations res
     where res.customer_id = p_customer_id
       and (p_unit_id is null or res.unit_id = p_unit_id)
  ),
  agg as (
    select count(*)::int                                                 as a_total,
           count(*) filter (where r.status = 'confirmed')::int           as a_confirmed,
           count(*) filter (where r.status = 'no_show')::int             as a_no_shows,
           count(*) filter (where r.status = 'cancelled')::int           as a_cancelled,
           max(r.date) filter (where r.status in ('confirmed','no_show')) as a_last_visit
      from r
  )
  select agg.a_total, agg.a_confirmed, agg.a_no_shows, agg.a_cancelled,
         case when (agg.a_confirmed + agg.a_no_shows) > 0
              then round(agg.a_no_shows::numeric
                         / (agg.a_confirmed + agg.a_no_shows), 3)
              else 0::numeric end,
         agg.a_last_visit
    from agg;
end;
$$;

-- `create or replace` preserva `proacl`, mas reafirmar mantém a migration
-- correta se a função tiver sido dropada e recriada no caminho — recriar concede
-- EXECUTE a PUBLIC por default nesta plataforma (medido; ver docs/hotfix-acl/).
revoke all on function public.get_customer_stats(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.get_customer_stats(uuid, uuid) to authenticated;

comment on function public.get_customer_stats(uuid, uuid) is
  'Ficha do cliente no painel. Guard de tenant: a organização é resolvida a partir de customers pelo p_customer_id (nunca do p_unit_id, que é parâmetro do chamador) e exige app_private.is_org_member ou app_private.is_platform_admin; recusa com 42501, com cliente inexistente e cliente alheio no mesmo ramo para não virar oráculo de existência. Migration 108.';
