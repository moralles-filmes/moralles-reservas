-- Assinatura resolvida por CATEGORIA do plano (Fase 5a).
--
-- BLOQUEANTE que esta migration resolve: applyAsaasEvent resolve "a assinatura
-- da organização" com maybeSingle() sobre qualquer assinatura não-cancelada.
-- Assim que uma org tem sistema (R$449) + instância (R$149), maybeSingle()
-- devolve PGRST116 e o pagamento falha — o cliente paga e não recebe nada.
--
-- DUAS defesas complementares, não redundantes:
--  1. UNIQUE (organization_id, billing_plan_id) parcial — mata a corrida de
--     dois cliques no MESMO plano.
--  2. Advisory lock por (org, categoria) dentro da RPC — cobre planos
--     DIFERENTES da mesma categoria (ex.: dois planos de sistema), que nenhuma
--     UNIQUE consegue expressar.
--
-- Ambiguidade (>1 assinatura viva na categoria) é FALHA ALTA: a RPC levanta
-- exceção, o evento continua na fila e o reconcile reprocessa. Escolher "a mais
-- recente" em silêncio ativaria a assinatura errada.

begin;

create unique index if not exists billing_subscriptions_org_plan_active_idx
  on billing_subscriptions (organization_id, billing_plan_id)
  where status <> 'canceled';

create or replace function resolve_or_activate_subscription(
  p_org uuid,
  p_plan_id uuid,
  p_provider_subscription_id text,
  p_payment_method text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_category text;
  v_count int;
  v_sub_id uuid;
  v_customer_id uuid;
begin
  select category into v_category from billing_plans where id = p_plan_id;
  if v_category is null then
    raise exception 'plan_not_found' using errcode = 'P0002';
  end if;

  -- Serializa por (org, categoria) até o fim da transação. hashtextextended dá
  -- o bigint que o advisory lock exige. Transaction-scoped de propósito: o
  -- PgBouncer em transaction mode não preserva lock de sessão.
  perform pg_advisory_xact_lock(hashtextextended(p_org::text || ':' || v_category, 0));

  select count(*) into v_count
    from billing_subscriptions s
    join billing_plans p on p.id = s.billing_plan_id
   where s.organization_id = p_org
     and s.status <> 'canceled'
     and p.category = v_category;

  if v_count > 1 then
    raise exception 'ambiguous_subscription_category' using errcode = 'P0001';
  end if;

  if v_count = 1 then
    select s.id into v_sub_id
      from billing_subscriptions s
      join billing_plans p on p.id = s.billing_plan_id
     where s.organization_id = p_org
       and s.status <> 'canceled'
       and p.category = v_category
     limit 1;

    -- Condicional: numa assinatura já ativa isto não afeta linha nenhuma.
    update billing_subscriptions
       set status = 'active', updated_at = now()
     where id = v_sub_id and status <> 'active';

    -- Backfill SEPARADO, pelo mesmo motivo: o update acima é condicional, e num
    -- caminho em que ele não afeta linha o id de correlação nunca chegaria.
    -- O `is null` impede sobrescrever id existente.
    if p_provider_subscription_id is not null then
      update billing_subscriptions
         set provider_subscription_id = p_provider_subscription_id, updated_at = now()
       where id = v_sub_id and provider_subscription_id is null;
    end if;

    return jsonb_build_object(
      'action', 'reused', 'subscription_id', v_sub_id, 'category', v_category
    );
  end if;

  select id into v_customer_id
    from billing_customers where organization_id = p_org limit 1;
  if v_customer_id is null then
    raise exception 'missing_billing_customer' using errcode = 'P0002';
  end if;

  insert into billing_subscriptions (
    organization_id, billing_customer_id, billing_plan_id, provider,
    provider_subscription_id, status, payment_method
  ) values (
    p_org, v_customer_id, p_plan_id, 'asaas',
    p_provider_subscription_id, 'active', coalesce(p_payment_method, 'card')
  ) returning id into v_sub_id;

  return jsonb_build_object(
    'action', 'created', 'subscription_id', v_sub_id, 'category', v_category
  );
end;
$$;

comment on function resolve_or_activate_subscription(uuid, uuid, text, text) is
  'Ativa ou cria a assinatura da CATEGORIA do plano informado, sob advisory lock por (org, categoria). Mais de uma assinatura viva na categoria levanta ambiguous_subscription_category — o aplicador converte em failed e o reconcile retenta. So service_role.';

revoke all on function resolve_or_activate_subscription(uuid, uuid, text, text) from public;
grant execute on function resolve_or_activate_subscription(uuid, uuid, text, text) to service_role;

commit;

-- =====================================================================
-- Validação pós-migration
-- =====================================================================
-- 1. Nenhuma org já tem duas assinaturas vivas da mesma categoria — se tiver, a
--    RPC vai falhar para ela e é preciso resolver à mão ANTES de vender
--    (esperado: 0 linhas):
--   select s.organization_id, p.category, count(*)
--     from billing_subscriptions s join billing_plans p on p.id = s.billing_plan_id
--    where s.status <> 'canceled'
--    group by 1, 2 having count(*) > 1;
--
-- 2. Grants (esperado: só service_role):
--   select grantee, privilege_type from information_schema.routine_privileges
--    where routine_name = 'resolve_or_activate_subscription';
--
-- 3. Reuso é idempotente numa org com assinatura de sistema ativa (esperado:
--    action='reused' nas duas chamadas, mesmo subscription_id):
--   select resolve_or_activate_subscription(
--     '<org>'::uuid,
--     (select id from billing_plans where slug = 'sistema-reservas'),
--     null, 'card');
--
-- =====================================================================
-- Rollback
-- =====================================================================
--   drop function if exists resolve_or_activate_subscription(uuid, uuid, text, text);
--   drop index if exists billing_subscriptions_org_plan_active_idx;
-- O aplicador precisa voltar junto (ele passa a chamar a RPC na Task 6).
