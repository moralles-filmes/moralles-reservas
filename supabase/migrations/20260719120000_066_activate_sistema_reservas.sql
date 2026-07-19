-- 066: Ativa o plano de assinatura do sistema.
--
-- A Fase 3 seedou os 9 produtos com active=false de propósito: nenhum checkout
-- os processava. A Fase 4a construiu o caminho Asaas, então este plano passa a
-- ser ofertável. Os demais (implantação WhatsApp, instância, pacotes de IA)
-- continuam inativos — cada fase liga o seu.
--
-- ⚠ ORDEM DE APLICAÇÃO (a ativação torna o plano COMPRÁVEL):
--   Só aplicar (`supabase db push`) DEPOIS de as Edge Functions do caminho
--   Asaas estarem deployadas — `create-billing-checkout`, `asaas-webhook`,
--   `process-asaas-reconcile`. Ativar antes deixa uma org nova diante de um
--   botão de contratar que nenhum checkout atende. É o último passo do deploy
--   da Task 13, não um `db push` solto.
--   Quem hoje tem override LIFETIME (Ren Sushi) não vê a oferta (Task 10);
--   Moralles é a própria plataforma. Não há cliente pagante — a ativação é
--   pré-requisito de futuro, não cobrança imediata.
--
-- Idempotente: o UPDATE é naturalmente re-executável (o guard `active = false`
-- faz a 2ª execução não casar nenhuma linha, sem erro).
--
-- ROLLBACK:
--   update billing_plans set active = false where slug = 'sistema-reservas';

update billing_plans
set active = true,
    updated_at = now()
where slug = 'sistema-reservas'
  and active = false;

do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from billing_plans
  where slug = 'sistema-reservas' and active = true and provider = 'asaas';

  if v_count <> 1 then
    raise exception 'Esperava exatamente 1 plano sistema-reservas ativo com provider=asaas, encontrei %', v_count;
  end if;
end $$;
