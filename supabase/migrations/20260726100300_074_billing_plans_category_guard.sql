-- Trava a categoria de um plano que já tem assinatura viva (Fase 5a).
--
-- A categoria decide QUEM a assinatura libera e SE ela pode escrever
-- organizations.billing_status. Trocar a categoria de um plano contratado
-- reclassifica retroativamente todas as assinaturas dele — uma assinatura de
-- instância viraria assinatura de sistema, e pagar R$149 passaria a desbloquear
-- a organização inteira. O painel valida antes; este trigger é a garantia.
--
-- O trigger NÃO é security definer — roda no contexto de quem faz o UPDATE em
-- billing_plans, como o service_role da Edge Function que edita planos. Isso é
-- proposital, mas tem uma condição a manter em mente: billing_subscriptions usa
-- FORCE RLS sem policies (convenção do projeto para tabelas sensíveis — a UI só
-- acessa via Edge Function), então o `exists` abaixo só enxerga linhas se o
-- chamador tiver BYPASSRLS. Hoje isso é verdade porque billing_plans só é
-- editado por service_role (via manage-billing), que tem BYPASSRLS. Se algum
-- caminho futuro passar a editar billing_plans como authenticated — por
-- exemplo, um platform_admin escrevendo direto na tabela sem passar pela Edge
-- Function — o `exists` devolveria falso e este guard viraria no-op silencioso,
-- exatamente o modo de falha que ele existe para impedir. Registrado aqui para
-- quem introduzir esse caminho revisitar a decisão, não para mudar o design
-- agora.

begin;

create or replace function billing_plans_block_category_change()
returns trigger
language plpgsql
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
  'Recusa mudanca de billing_plans.category quando existe assinatura nao-cancelada do plano. Sem isto, reclassificar um plano contratado mudaria retroativamente o que as assinaturas dele liberam.';

commit;

-- =====================================================================
-- Validação pós-migration
-- =====================================================================
-- Plano SEM assinatura aceita a troca (esperado: UPDATE 1 nas duas linhas):
--   update billing_plans set category = 'CUSTOM' where slug = 'credito-ia-50';
--   update billing_plans set category = 'AI_CREDIT_PACKAGE' where slug = 'credito-ia-50';
--
-- Plano COM assinatura recusa (esperado: erro plan_category_locked):
--   update billing_plans set category = 'CUSTOM'
--    where id in (select billing_plan_id from billing_subscriptions
--                  where status <> 'canceled' limit 1);
--
-- Rollback: drop trigger if exists billing_plans_category_guard on billing_plans;
