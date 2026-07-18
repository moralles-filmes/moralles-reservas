-- Seeds do catálogo comercial (Fase 3 da migração billing Stripe → Asaas).
-- docs/billing-asaas/01-PLANO-IMPLEMENTACAO.md § FASE 3.
--
-- IDEMPOTENTE: todo INSERT usa `on conflict (slug) do nothing`. Rodar 2x não
-- duplica nem sobrescreve edição feita pelo painel — o painel é a fonte de
-- verdade depois que o plano existe.
--
-- ⚠️ TODOS os planos comerciais nascem `active=false`, DE PROPÓSITO.
-- Só o trial nasce ativo. Motivo: o catálogo é entregue aqui, mas o fluxo que
-- cobra cada produto só existe depois — checkout Asaas na Fase 4 (R$ 449),
-- implementação/instância na Fase 5, carteira de IA na Fase 7. Plano ativo sem
-- checkout que o processe vira botão quebrado na pricing table do cliente
-- (`create-billing-checkout` roteia pra Stripe e o plano Asaas não tem
-- `stripe_price_id_card`). Cada fase liga o seu com um UPDATE de uma linha:
--   update billing_plans set active = true where slug = 'sistema-reservas';
-- Isso desvia do texto "ativo" da Fase 3 no plano; desvio registrado em
-- docs/billing-asaas/FASE-3-RESUMO.md.
--
-- ⚠️ Preços em CENTAVOS aqui (`amount_cents`), como o resto do sistema. A
-- conversão pra reais decimais do Asaas acontece só na fronteira do
-- AsaasBillingProvider (docs/billing-asaas/03-ASAAS-API-VERIFICADO.md §9.1).
-- Errar isso é cobrar 100x.

begin;

-- =====================================================================
-- PART 1 — Trial: 14 dias → 5 dias
-- =====================================================================
-- `billing_plans_only_one_active_trial` é UNIQUE PARCIAL (is_trial AND active):
-- inserir `trial-padrao` ativo sem desativar o trial vigente viola a constraint
-- e aborta a migration inteira. O trial atual (14d) foi criado pelo painel, não
-- por migration, então não dá pra referenciar por slug conhecido.
--
-- EFEITO EM PRODUÇÃO: `manage-organizations` lê `trial_days` do único plano
-- trial ativo (index.ts:178-183). A partir daqui, org NOVA nasce com 5 dias.
-- Orgs já em trial não são tocadas — `trial_ends_at` já está gravado nelas.
--
-- O `slug <> 'trial-padrao'` mantém a idempotência: numa segunda execução isto
-- não desativa o plano que a própria migration acabou de criar.
update billing_plans
   set active = false,
       updated_at = now()
 where is_trial = true
   and active = true
   and slug <> 'trial-padrao';

-- =====================================================================
-- PART 1.5 — Backfill do destaque: popular → recommended
-- =====================================================================
-- A partir da Fase 3 quem pinta o badge de destaque é `recommended` (063); a
-- coluna `popular` vira legado read-only e sai do painel. Sem este backfill,
-- todo plano hoje marcado `popular=true` perderia a borda e o badge na pricing
-- table do cliente no instante do deploy — em silêncio, e sem o admin
-- conseguir nem ver o `popular=true` que continuou lá (o switch saiu da UI).
--
-- Só liga, nunca desliga: `recommended = false` explícito num plano com
-- `popular = true` seria uma decisão do admin, não um estado a "corrigir".
update billing_plans
   set recommended = true,
       updated_at = now()
 where popular = true
   and recommended = false;

-- =====================================================================
-- PART 2 — Catálogo
-- =====================================================================
-- "interval" é palavra reservada no Postgres — sempre entre aspas.
-- Planos `one_time` carregam "interval" = 'month' apenas porque a coluna é
-- NOT NULL com CHECK in ('month','year'); não existe valor neutro. A UI esconde
-- o intervalo quando billing_type = 'one_time' (planIntervalLabel em
-- src/lib/billing-plan-display.ts) — não interpretar como cobrança mensal.

-- 1. Assinatura do sistema — R$ 449,00/mês
insert into billing_plans (
  slug, name, description, amount_cents, "interval", category, provider,
  billing_type, active, sort_order, features
) values (
  'sistema-reservas',
  'Sistema de Reservas',
  'Plataforma completa de reservas, fila de espera e gestão de mesas.',
  44900, 'month', 'SYSTEM_SUBSCRIPTION', 'asaas',
  'recurring', false, 10,
  '["Reservas online ilimitadas", "Fila de espera e passantes", "Painel operacional e relatórios", "Portal público com cardápio", "Suporte por e-mail"]'::jsonb
) on conflict (slug) do nothing;

-- 2. Implementação do WhatsApp — R$ 750,00 cobrança única
insert into billing_plans (
  slug, name, description, amount_cents, "interval", category, provider,
  billing_type, active, sort_order, features
) values (
  'implementacao-whatsapp',
  'Implementação do WhatsApp',
  'Configuração assistida do agente de IA no WhatsApp. Cobrança única.',
  75000, 'month', 'WHATSAPP_IMPLEMENTATION', 'asaas',
  'one_time', false, 20,
  '["Configuração da instância", "Treinamento do agente de IA", "Testes assistidos", "Acompanhamento na virada"]'::jsonb
) on conflict (slug) do nothing;

-- 3. Mensalidade da instância — R$ 149,00/mês (exige a implementação)
insert into billing_plans (
  slug, name, description, amount_cents, "interval", category, provider,
  billing_type, active, sort_order, features
) values (
  'instancia-whatsapp',
  'Instância WhatsApp',
  'Manutenção mensal da instância de WhatsApp conectada ao agente de IA.',
  14900, 'month', 'WHATSAPP_SUBSCRIPTION', 'asaas',
  'recurring', false, 30,
  '["Instância dedicada", "Agente de IA 24/7", "Monitoramento de entrega", "Reconexão assistida"]'::jsonb
) on conflict (slug) do nothing;

-- 4-8. Pacotes de crédito de IA — cobrança única, creditam o próprio valor.
-- `amount_credited_cents = amount_cents`: pacote sem bônus. Um pacote com bônus
-- futuro grava amount_credited_cents > amount_cents.
insert into billing_plans (
  slug, name, description, amount_cents, amount_credited_cents, "interval",
  category, provider, billing_type, recommended, active, sort_order, features
) values
  ('credito-ia-50',  'Crédito de IA — R$ 50',  'Recarga de R$ 50,00 em créditos de IA.',   5000,  5000, 'month', 'AI_CREDIT_PACKAGE', 'asaas', 'one_time', false, false, 40, '["R$ 50,00 em créditos", "Sem validade"]'::jsonb),
  ('credito-ia-70',  'Crédito de IA — R$ 70',  'Recarga de R$ 70,00 em créditos de IA.',   7000,  7000, 'month', 'AI_CREDIT_PACKAGE', 'asaas', 'one_time', true,  false, 50, '["R$ 70,00 em créditos", "Sem validade"]'::jsonb),
  ('credito-ia-100', 'Crédito de IA — R$ 100', 'Recarga de R$ 100,00 em créditos de IA.', 10000, 10000, 'month', 'AI_CREDIT_PACKAGE', 'asaas', 'one_time', false, false, 60, '["R$ 100,00 em créditos", "Sem validade"]'::jsonb),
  ('credito-ia-150', 'Crédito de IA — R$ 150', 'Recarga de R$ 150,00 em créditos de IA.', 15000, 15000, 'month', 'AI_CREDIT_PACKAGE', 'asaas', 'one_time', false, false, 70, '["R$ 150,00 em créditos", "Sem validade"]'::jsonb),
  ('credito-ia-200', 'Crédito de IA — R$ 200', 'Recarga de R$ 200,00 em créditos de IA.', 20000, 20000, 'month', 'AI_CREDIT_PACKAGE', 'asaas', 'one_time', false, false, 80, '["R$ 200,00 em créditos", "Sem validade"]'::jsonb)
on conflict (slug) do nothing;

-- 9. Trial automático — 5 dias, R$ 0. Único plano que nasce ATIVO.
-- provider='manual': nenhum provedor cobra por ele.
-- Cliente nunca escolhe: PricingTable filtra is_trial (PricingTable.tsx:21).
insert into billing_plans (
  slug, name, description, amount_cents, "interval", category, provider,
  billing_type, trial_days, is_trial, active, sort_order, features
) values (
  'trial-padrao',
  'Teste grátis',
  'Período de avaliação de 5 dias aplicado automaticamente a toda nova empresa.',
  0, 'month', 'TRIAL', 'manual',
  'recurring', 5, true, true, 0,
  '["Acesso completo por 5 dias", "Sem cartão de crédito"]'::jsonb
) on conflict (slug) do nothing;

-- Fecha o caso em que o trial vigente JÁ se chama 'trial-padrao': o PART 1 o
-- preserva (guarda de idempotência) e o INSERT acima vira no-op pelo
-- `on conflict`, então sem isto a migration "passaria" deixando os 14 dias no
-- lugar — sem erro nenhum. Idempotente: no-op quando já está 5 e ativo.
update billing_plans
   set trial_days = 5,
       active = true,
       updated_at = now()
 where slug = 'trial-padrao'
   and is_trial = true
   and (trial_days <> 5 or active = false);

-- =====================================================================
-- PART 3 — Pré-requisito: instância exige a implementação paga
-- =====================================================================
-- Resolvido por subquery porque os ids são gerados (gen_random_uuid) e o INSERT
-- acima pode ter sido no-op numa re-execução. `requires_plan_id is null` evita
-- sobrescrever vínculo ajustado à mão no painel.
update billing_plans
   set requires_plan_id = (select id from billing_plans where slug = 'implementacao-whatsapp'),
       updated_at = now()
 where slug = 'instancia-whatsapp'
   and requires_plan_id is null
   and exists (select 1 from billing_plans where slug = 'implementacao-whatsapp');

commit;

-- =====================================================================
-- Validação pós-migration (rodar manualmente após `supabase db push`)
-- =====================================================================
-- Esperado: 9 linhas, 1 sola ativa (trial-padrao, trial_days=5), R$70 recomendado,
-- instancia-whatsapp apontando pra implementacao-whatsapp.
--
--   select slug, amount_cents, category, provider, billing_type, recommended,
--          is_trial, trial_days, active,
--          (select slug from billing_plans r where r.id = p.requires_plan_id) as requires
--     from billing_plans p
--    order by sort_order;
--
-- Exatamente 1 trial ativo (a UNIQUE PARCIAL garante, mas confirme o de 5 dias):
--   select slug, trial_days from billing_plans where is_trial and active;
--
-- Nenhum pacote de IA sem valor creditado:
--   select slug from billing_plans
--    where category = 'AI_CREDIT_PACKAGE' and amount_credited_cents is null;
--
-- ⚠️ ANTES DO `db push` EM PRODUÇÃO, confira qual é o trial vigente:
--   select id, slug, trial_days from billing_plans where is_trial and active;
-- Anote id e slug — o PART 1 vai desativá-lo e não há como saber depois qual
-- linha foi (billing_plans não tem trigger de audit_log).
--
-- =====================================================================
-- Rollback
-- =====================================================================
-- 1. Remover os planos seedados. Seguro enquanto nascem active=false: nenhuma
--    billing_subscriptions aponta pra eles (a FK billing_plan_id é NO ACTION e
--    recusaria o delete se apontasse). Se alguma fase já ligou um deles e há
--    assinatura, use `active=false` em vez de delete.
--
--   delete from billing_plans where slug in (
--     'sistema-reservas', 'implementacao-whatsapp', 'instancia-whatsapp',
--     'credito-ia-50', 'credito-ia-70', 'credito-ia-100', 'credito-ia-150',
--     'credito-ia-200', 'trial-padrao');
--
-- 2. Reativar o trial anterior — NÃO é automático, precisa do id anotado acima:
--   update billing_plans set active = true where id = '<id-anotado>';
--
--    Ordem importa: o delete do trial-padrao tem que vir ANTES, senão a UNIQUE
--    PARCIAL billing_plans_only_one_active_trial recusa a reativação.
--
-- 3. Orgs criadas entre o push e o rollback ficam com trial de 5 dias — o
--    trial_ends_at foi gravado na criação e não é recalculado. Ajuste caso a
--    caso com o override `extend_trial` se quiser devolver os 14 dias.
