-- Grandfathering do WhatsApp para clientes anteriores à cobrança (Fase 5b).
--
-- POR QUE EXISTE: `entitlements.whatsapp.allowed` é `false` para TODA
-- organização sem assinatura de WhatsApp nem override. Ligar o gate de envio
-- por ausência de direito silenciaria, na hora, todo cliente que já usa
-- WhatsApp e nunca comprou a instância. Transformar WhatsApp em pago-por-padrão
-- é decisão comercial, não consequência de ligar uma flag de inadimplência.
--
-- MAS NÃO É "WHATSAPP GRÁTIS PARA SEMPRE": o estado LEGACY_GRANDFATHERED
-- permite o uso existente e bloqueia novo provisionamento; e a revogação é
-- TERMINAL — cancelar a assinatura ou revogar o override depois NÃO restaura o
-- grandfathering, senão "assino, cancelo, volto a ser legado" viraria isenção
-- permanente.

begin;

alter table organizations
  add column if not exists whatsapp_legacy_grandfathered boolean not null default false,
  add column if not exists whatsapp_grandfathered_at timestamptz,
  add column if not exists whatsapp_grandfathered_source text,
  add column if not exists whatsapp_grandfather_revoked_at timestamptz,
  add column if not exists whatsapp_grandfather_revoked_reason text,
  add column if not exists whatsapp_grandfather_revoked_by uuid references auth.users(id) on delete set null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'organizations_wa_grandfather_source_chk'
  ) then
    alter table organizations
      add constraint organizations_wa_grandfather_source_chk
      check (whatsapp_grandfathered_source is null
             or whatsapp_grandfathered_source in ('MIGRATION_5B', 'ADMIN'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'organizations_wa_grandfather_revoke_chk'
  ) then
    alter table organizations
      add constraint organizations_wa_grandfather_revoke_chk
      check (whatsapp_grandfather_revoked_reason is null
             or whatsapp_grandfather_revoked_reason in
                ('FIRST_PAID_SUBSCRIPTION', 'ADMIN_MIGRATION',
                 'REPLACED_BY_OVERRIDE', 'ADMIN_REVOCATION'));
  end if;

  -- Revogado obriga motivo e data: revogação sem rastro é indistinguível de
  -- nunca ter sido concedido.
  if not exists (
    select 1 from pg_constraint where conname = 'organizations_wa_grandfather_revoked_pair_chk'
  ) then
    alter table organizations
      add constraint organizations_wa_grandfather_revoked_pair_chk
      check ((whatsapp_grandfather_revoked_at is null
              and whatsapp_grandfather_revoked_reason is null)
             or (whatsapp_grandfather_revoked_at is not null
                 and whatsapp_grandfather_revoked_reason is not null));
  end if;
end $$;

comment on column organizations.whatsapp_legacy_grandfathered is
  'Organização que já usava WhatsApp antes da cobrança da instância. Concede o estado LEGACY_GRANDFATHERED: mantém o envio existente, bloqueia novo provisionamento. O estado efetivo é `whatsapp_legacy_grandfathered AND whatsapp_grandfather_revoked_at IS NULL` — revogação é terminal e não volta sozinha.';

-- Concessão por EVIDÊNCIA OBJETIVA: organização com pelo menos uma unidade com
-- canal de WhatsApp `connected` agora. Sem heurística de data, sem "provavelmente
-- usa". Idempotente: só marca quem ainda não foi marcado nem revogado.
update organizations o
   set whatsapp_legacy_grandfathered = true,
       whatsapp_grandfathered_at = now(),
       whatsapp_grandfathered_source = 'MIGRATION_5B'
 where o.whatsapp_legacy_grandfathered = false
   and o.whatsapp_grandfather_revoked_at is null
   and exists (
     select 1
       from whatsapp_channels c
       join units u on u.id = c.unit_id
      where u.organization_id = o.id
        and c.status = 'connected'
   );

commit;

-- Assinatura resolvida por CATEGORIA do plano (Fase 5a), com dois efeitos
-- novos da Fase 5b acrescentados ao corpo original (migration 073):
--   1. Restaura `billing_subscriptions.suspended_at/restored_at` quando a
--      assinatura reutilizada estava suspensa por inadimplência.
--   2. Revoga o grandfathering de WhatsApp, de forma TERMINAL, na primeira
--      assinatura paga da categoria WHATSAPP_SUBSCRIPTION.
--
-- BLOQUEANTE que a migration 073 resolveu (preservado aqui): applyAsaasEvent
-- resolve "a assinatura da organização" com maybeSingle() sobre qualquer
-- assinatura não-cancelada. Assim que uma org tem sistema (R$449) + instância
-- (R$149), maybeSingle() devolve PGRST116 e o pagamento falha — o cliente paga
-- e não recebe nada.
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
  v_prev_plan_id uuid;
  v_prev_provider text;
  v_new_plan_id uuid;
  v_new_provider text;
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
    select s.id, s.billing_plan_id, s.provider
      into v_sub_id, v_prev_plan_id, v_prev_provider
      from billing_subscriptions s
      join billing_plans p on p.id = s.billing_plan_id
     where s.organization_id = p_org
       and s.status <> 'canceled'
       and p.category = v_category
     limit 1;

    -- Condicional: numa assinatura ja ativa isto nao afeta linha nenhuma.
    update billing_subscriptions
       set status = 'active', updated_at = now()
     where id = v_sub_id and status <> 'active';

    -- Restauração: a assinatura que estava suspensa por inadimplência volta
    -- agora. Condicional pelo `suspended_at is not null` — reprocessar um
    -- pagamento antigo de uma assinatura que nunca foi suspensa não pode
    -- inventar um `restored_at`.
    update billing_subscriptions
       set restored_at = now(), suspended_at = null, updated_at = now()
     where id = v_sub_id and suspended_at is not null;

    -- A linha tem que apontar para o plano REALMENTE pago. Sem isto, uma troca
    -- de plano dentro da mesma categoria deixa a assinatura no plano antigo e
    -- todo preco derivado dela (billing_plans.amount_cents via billing_plan_id)
    -- fica errado.
    update billing_subscriptions
       set billing_plan_id = p_plan_id, updated_at = now()
     where id = v_sub_id and billing_plan_id is distinct from p_plan_id;

    -- Provedor e id de correlacao andam JUNTOS. Virar provider para 'asaas'
    -- deixando um id de outro provedor na linha produz uma linha incoerente,
    -- e gravar 'asaas' sem id real violaria a regra de nunca inventar id do
    -- Asaas. Por isso os dois so mudam quando ha id real em maos.
    if p_provider_subscription_id is not null then
      update billing_subscriptions
         set provider_subscription_id = p_provider_subscription_id,
             provider = 'asaas',
             updated_at = now()
       where id = v_sub_id
         and (provider_subscription_id is null or provider is distinct from 'asaas');
    end if;

    select billing_plan_id, provider into v_new_plan_id, v_new_provider
      from billing_subscriptions where id = v_sub_id;

    -- Primeira assinatura paga de WhatsApp encerra o grandfathering, de forma
    -- TERMINAL. Cancelar depois não restaura — quem quiser reconceder faz ação
    -- administrativa explícita.
    if v_category = 'WHATSAPP_SUBSCRIPTION' then
      update organizations
         set whatsapp_grandfather_revoked_at = now(),
             whatsapp_grandfather_revoked_reason = 'FIRST_PAID_SUBSCRIPTION'
       where id = p_org
         and whatsapp_legacy_grandfathered = true
         and whatsapp_grandfather_revoked_at is null;
    end if;

    return jsonb_build_object(
      'action', 'reused',
      'subscription_id', v_sub_id,
      'category', v_category,
      'plan_changed', case when v_prev_plan_id is distinct from v_new_plan_id
                           then jsonb_build_object('from', v_prev_plan_id, 'to', v_new_plan_id)
                           else null end,
      'provider_changed', case when v_prev_provider is distinct from v_new_provider
                               then jsonb_build_object('from', v_prev_provider, 'to', v_new_provider)
                               else null end
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

  -- Primeira assinatura paga de WhatsApp encerra o grandfathering, de forma
  -- TERMINAL. Cancelar depois não restaura — quem quiser reconceder faz ação
  -- administrativa explícita.
  if v_category = 'WHATSAPP_SUBSCRIPTION' then
    update organizations
       set whatsapp_grandfather_revoked_at = now(),
           whatsapp_grandfather_revoked_reason = 'FIRST_PAID_SUBSCRIPTION'
     where id = p_org
       and whatsapp_legacy_grandfathered = true
       and whatsapp_grandfather_revoked_at is null;
  end if;

  return jsonb_build_object(
    'action', 'created', 'subscription_id', v_sub_id, 'category', v_category,
    'plan_changed', null, 'provider_changed', null
  );
end;
$$;

comment on function resolve_or_activate_subscription(uuid, uuid, text, text) is
  'Ativa ou cria a assinatura da CATEGORIA do plano informado, sob advisory lock por (org, categoria). O reuso reconcilia billing_plan_id e (quando ha id real) provider/provider_subscription_id da linha existente para o plano/provedor REALMENTE pagos, sinalizando a troca em plan_changed/provider_changed no retorno, e restaura suspended_at/restored_at quando a assinatura reutilizada estava suspensa. A primeira assinatura paga da categoria WHATSAPP_SUBSCRIPTION revoga (terminal) o grandfathering de WhatsApp da organização. Mais de uma assinatura viva na categoria levanta ambiguous_subscription_category — o aplicador converte em failed e o reconcile retenta. So service_role.';

revoke all on function resolve_or_activate_subscription(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function resolve_or_activate_subscription(uuid, uuid, text, text) to service_role;

commit;

-- =====================================================================
-- Validação pós-migration
-- =====================================================================
-- 1. RELATÓRIO das organizações concedidas (guardar o resultado no resumo da
--    fase — é o ponto de partida da migração comercial futura):
--   select o.id, o.name, o.whatsapp_grandfathered_at,
--          count(distinct c.id) as canais_conectados
--     from organizations o
--     join units u on u.organization_id = o.id
--     join whatsapp_channels c on c.unit_id = u.id and c.status = 'connected'
--    where o.whatsapp_legacy_grandfathered
--    group by 1, 2, 3
--    order by 2;
--
-- 2. Nenhuma organização SEM canal conectado foi marcada (esperado: 0 linhas):
--   select o.id from organizations o
--    where o.whatsapp_legacy_grandfathered
--      and not exists (select 1 from whatsapp_channels c
--                      join units u on u.id = c.unit_id
--                     where u.organization_id = o.id and c.status = 'connected');
--
-- 3. A RPC continua com os grants corretos (esperado: só service_role):
--   select grantee, privilege_type from information_schema.routine_privileges
--    where routine_name = 'resolve_or_activate_subscription';
--
-- Rollback:
--   Reaplicar a RPC do arquivo 073 e:
--   alter table organizations
--     drop constraint if exists organizations_wa_grandfather_revoked_pair_chk,
--     drop constraint if exists organizations_wa_grandfather_revoke_chk,
--     drop constraint if exists organizations_wa_grandfather_source_chk,
--     drop column if exists whatsapp_grandfather_revoked_by,
--     drop column if exists whatsapp_grandfather_revoked_reason,
--     drop column if exists whatsapp_grandfather_revoked_at,
--     drop column if exists whatsapp_grandfathered_source,
--     drop column if exists whatsapp_grandfathered_at,
--     drop column if exists whatsapp_legacy_grandfathered;
