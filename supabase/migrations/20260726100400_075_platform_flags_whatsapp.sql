-- Flags da Fase 5a. Todas OFF; ligar é decisão explícita de fase.
--
-- whatsapp_implementation_flow já foi seedada na 061 — não repetir aqui: o
-- `on conflict do nothing` a preservaria, mas a duplicação confunde quem lê.
--
-- SEPARADAS de propósito: a visibilidade dos preços (5a) pode ir ao ar antes do
-- checkout mensal, e o checkout mensal antes do enforcement. Uma flag só
-- obrigaria a ligar as três de uma vez — inclusive a suspensão, que nem existe
-- nesta fase.

begin;

insert into platform_flags (key, value, description) values
  ('whatsapp_subscription_checkout', 'false',
   'Libera o checkout da mensalidade da instancia (R$149). Fica OFF em producao ate a Fase 5b: sem enforcement, seria cobrar mensalidade sem poder suspender.'),
  ('whatsapp_service_enforcement', 'false',
   'Suspensao e gates do servico de WhatsApp por inadimplencia da instancia (Fase 5b).')
on conflict (key) do nothing;

commit;

-- Validação (esperado: 3 linhas, todas false):
--   select key, value from platform_flags
--    where key in ('whatsapp_implementation_flow',
--                  'whatsapp_subscription_checkout',
--                  'whatsapp_service_enforcement');
--
-- Rollback:
--   delete from platform_flags
--    where key in ('whatsapp_subscription_checkout', 'whatsapp_service_enforcement');
