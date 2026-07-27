-- Liga os produtos de WhatsApp no catálogo. ÚLTIMA migration da Fase 5a.
--
-- Os dois nasceram active=false na 065 de propósito: plano ativo sem fluxo que o
-- processe vira botão quebrado. Agora os dois fluxos existem — o checkout
-- DETACHED da implantação e o RECURRENT da instância — e a visibilidade de cada
-- um continua governada por flag (whatsapp_implementation_flow e
-- whatsapp_subscription_checkout), não por esta coluna.
--
-- PricingTable filtra SYSTEM_SUBSCRIPTION (isSelectableSystemPlan), então
-- ativá-los NÃO os transforma em card contratável na tabela de planos: eles
-- aparecem só no bloco dedicado da tela de cobrança.
--
-- ⚠ ORDEM DE APLICAÇÃO — mesma regra da 066 (ativação torna o plano COMPRÁVEL):
--   Só aplicar (`supabase db push`) DEPOIS de as Edge Functions do caminho
--   WhatsApp/Asaas estarem deployadas — `create-billing-checkout`,
--   `manage-whatsapp-implementations`, `asaas-webhook`, `process-asaas-reconcile`
--   no mínimo. Ativar antes deixa a implantação "vendável" sem quem processe o
--   checkout. Ver runbook de ativação em docs/billing-asaas/FASE-5A-RESUMO.md.
--
-- Idempotente: o UPDATE só casa `active = false`, então uma 2ª execução não
-- casa nenhuma linha, sem erro.

begin;

update billing_plans
   set active = true,
       updated_at = now()
 where slug in ('implementacao-whatsapp', 'instancia-whatsapp')
   and active = false;

commit;

-- =====================================================================
-- Validação (rodar manualmente após `supabase db push`)
-- =====================================================================
-- Esperado: 2 linhas, active=t, e instancia-whatsapp apontando para
-- implementacao-whatsapp em requires_plan_id:
--
--   select slug, active, category, billing_type,
--          (select slug from billing_plans r where r.id = p.requires_plan_id) as requires
--     from billing_plans p
--    where slug in ('implementacao-whatsapp', 'instancia-whatsapp');
--
-- =====================================================================
-- Rollback
-- =====================================================================
--   update billing_plans set active = false
--    where slug in ('implementacao-whatsapp', 'instancia-whatsapp');
--
-- Seguro mesmo com assinatura viva: `active=false` só tira o produto da
-- vitrine (novas contratações), não cancela quem já pagou — `billing_plans`
-- não tem FK que dependa de `active`.
