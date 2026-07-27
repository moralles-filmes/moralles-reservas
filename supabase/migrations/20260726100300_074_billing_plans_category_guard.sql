-- Trava a categoria de um plano que já tem assinatura viva (Fase 5a).
--
-- A categoria decide QUEM a assinatura libera e SE ela pode escrever
-- organizations.billing_status. Trocar a categoria de um plano contratado
-- reclassifica retroativamente todas as assinaturas dele — uma assinatura de
-- instância viraria assinatura de sistema, e pagar R$149 passaria a desbloquear
-- a organização inteira. O painel valida antes; este trigger é a garantia.
--
-- A função é SECURITY DEFINER (com search_path travado), e isto NÃO é
-- opcional: a policy `platform_admin_all_billing_plans`
-- (20260528000000_billing_module.sql:116-119) já permite HOJE, em produção,
-- que um platform_admin autenticado faça UPDATE direto em billing_plans via
-- SDK/PostgREST, sem passar pela Edge Function manage-billing. Nenhum código
-- do app exerce esse caminho atualmente, mas a permissão não depende de
-- mudança nenhuma para ser usada — é uma concessão RLS já de pé, não uma
-- hipótese futura. billing_subscriptions usa FORCE RLS sem policies
-- (convenção do projeto para tabelas sensíveis — a UI só acessa via Edge
-- Function); rodando no contexto de um chamador authenticated SEM SECURITY
-- DEFINER, o `exists` abaixo não enxergaria nenhuma linha e o guard passaria
-- em silêncio — exatamente o cenário que esta migration existe para impedir.
-- SECURITY DEFINER faz o `exists` valer para QUALQUER escritor de
-- billing_plans, não só para o service_role da EF.
--
-- Condição residual: o dono da função (quem roda esta migration) precisa ter
-- BYPASSRLS — verdade hoje porque migrations rodam com um role privilegiado.
-- Se isso deixar de ser verdade, o `exists` volta a não enxergar nada e o
-- guard vira no-op silencioso; por isso a validação #3 no rodapé roda pelo
-- caminho authenticated, não pelo service_role (que sempre enxergaria
-- billing_subscriptions de qualquer jeito e daria falso positivo).
--
-- Alternativa descartada: restringir a policy de escrita de billing_plans
-- fecharia o buraco na origem, mas pode travar um caminho legítimo de
-- administração que não foi auditado — e travar serviço nesta fase é
-- proibido (Global Constraint 1 da Fase 5a).

begin;

create or replace function billing_plans_block_category_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.category is distinct from old.category then
    if exists (
      select 1 from billing_subscriptions s
       where s.billing_plan_id = old.id
         and s.status <> 'canceled'
    ) then
      raise exception 'plan_category_locked' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists billing_plans_category_guard on billing_plans;
create trigger billing_plans_category_guard
  before update on billing_plans
  for each row execute function billing_plans_block_category_change();

comment on function billing_plans_block_category_change() is
  'Recusa mudança de billing_plans.category quando existe assinatura não-cancelada do plano. Sem isto, reclassificar um plano contratado mudaria retroativamente o que as assinaturas dele liberam. SECURITY DEFINER: platform_admin_all_billing_plans já permite UPDATE authenticated direto em billing_plans, e billing_subscriptions é FORCE RLS sem policies.';

commit;

-- =====================================================================
-- Validação pós-migration
-- =====================================================================
-- 1. Plano SEM assinatura aceita a troca (esperado: UPDATE 1 nas duas linhas):
--   update billing_plans set category = 'CUSTOM' where slug = 'credito-ia-50';
--   update billing_plans set category = 'AI_CREDIT_PACKAGE' where slug = 'credito-ia-50';
--
-- 2. Plano COM assinatura recusa (esperado: erro plan_category_locked):
--   update billing_plans set category = 'CUSTOM'
--    where id in (select billing_plan_id from billing_subscriptions
--                  where status <> 'canceled' limit 1);
--
-- 3. O guard vale para o caminho AUTHENTICATED (o que a policy
--    platform_admin_all_billing_plans permite), não só para service_role.
--    Rodar autenticado como platform_admin, com a anon key — NÃO com a
--    service_role key, que enxergaria billing_subscriptions de qualquer jeito
--    e daria falso positivo:
--      supabase.from('billing_plans')
--        .update({ category: 'CUSTOM' })
--        .eq('id', '<plano com assinatura viva>')
--    Esperado: erro plan_category_locked.
--    Se PASSAR sem erro, o dono da função não tem BYPASSRLS e o guard está
--    inerte — tratar como bloqueante antes de vender qualquer plano.
--
-- Rollback:
--   drop trigger if exists billing_plans_category_guard on billing_plans;
--   drop function if exists billing_plans_block_category_change();
